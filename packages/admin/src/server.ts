import { createReadStream } from "node:fs";
import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ExtractorAdapterError,
  applyCatalogDiffToWorkspace,
  buildArcaeaSourceInventory,
  createVersionWorkspace,
  createWorkspaceFromExtractorResult,
  ResourceType,
  rosStorageStatus,
  type ExtractorApk,
  ExtractorResult,
} from "../../domain/src/index.js";
import { loadAdminConfig, normalizeAdminConfig, saveAdminConfig, type AdminConfig, DEFAULT_ADMIN_CONFIG_PATH } from "./config.js";
import { GAME_REGISTRY, gameConfig, publicGameConfigs, type GameConfig, type GameId } from "./registry.js";
import {
  AdminOperationError,
  applyCandidateOverride,
  confirmAllSafeCandidates,
  confirmCandidate,
  convertUpscale,
  finalizeCandidate,
  knownWorkspaceFolder,
  listWorkspaces,
  loadCatalog,
  removeCandidate,
  replaceCandidateImage,
  restoreCandidate,
  retryUpscale,
  skipUpscale,
  startUpscale,
  prepareUpscale,
  previewFilePath,
  publishPreview,
  publishExecute,
  legacyMigrationDryRun,
  rescanWorkspace,
  resolveCandidateIdentity,
  rescanUpscale,
  selectUpscale,
  workspaceRootFor,
  workspaceView,
} from "./workspace-view.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PUBLIC_ROOT = path.join(PROJECT_ROOT, "packages", "admin", "public");
const MAX_BODY_BYTES = 1024 * 1024;

type AdminRuntime = {
  config: AdminConfig;
  configPath: string;
  legacyPlan?: Awaited<ReturnType<typeof legacyMigrationDryRun>>;
};

type DiscoveredApk = {
  filename: string;
  version: string;
  sizeBytes: number;
  modifiedAt: string;
};

function isLocalHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost";
}

function localHostHeader(value: string): boolean {
  try {
    const parsed = new URL(`http://${value}`);
    return isLocalHostname(parsed.hostname) && !parsed.username && !parsed.password && parsed.pathname === "/";
  } catch {
    return false;
  }
}

function allowedOrigin(value: string, port: number): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" && isLocalHostname(parsed.hostname) && parsed.port === String(port) && parsed.pathname === "/";
  } catch {
    return false;
  }
}

function checkLocalRequest(req: IncomingMessage, port: number): void {
  const host = req.headers.host;
  if (host && !localHostHeader(host)) throw new AdminOperationError("LOCAL_ONLY", "Admin 只接受来自本机的请求。", 403);
  const origin = req.headers.origin;
  if (origin && !allowedOrigin(origin, port)) throw new AdminOperationError("LOCAL_ONLY", "Admin 只接受本机同源请求。", 403);
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function sendText(response: ServerResponse, statusCode: number, body: string, contentType: string): void {
  response.writeHead(statusCode, { "Content-Type": contentType, "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
  response.end(body);
}

function operationError(error: unknown): AdminOperationError {
  if (error instanceof AdminOperationError) return error;
  if (error instanceof ExtractorAdapterError) {
    return new AdminOperationError(
      "ADAPTER_FAILED",
      "提取结果无法转换为候选资源，请展开技术详情检查报告。",
      409,
      [...error.diagnostics.map((item) => `${item.code}: ${item.message}`), error.message].join("\n"),
    );
  }
  const detail = error instanceof Error ? error.message : String(error);
  const knownMessages: Array<[string, string, string]> = [
    ["final review must be explicitly approved", "FINAL_REVIEW_REQUIRED", "请先确认当前候选，再进行最终发布准备。"],
    ["metadata review is not resolved", "METADATA_REVIEW_REQUIRED", "请先补充曲名或曲师，再确认候选。"],
    ["external identity resolution is required", "IDENTITY_REVIEW_REQUIRED", "这个候选还无法确认资源对应关系，请在详细信息中处理。"],
    ["requires upscale but has no processed-upscaled", "UPSCALE_REQUIRED", "AI 超分结果还没有转换为 JPG。"],
    ["a selected upscale attempt is required", "UPSCALE_REQUIRED", "请先选择一个超分输出。"],
    ["selected upscale result must be converted", "UPSCALE_REQUIRED", "请先把选中的超分 PNG 转换为 JPG。"],
    ["BLOCKED Candidate must be resolved", "CANDIDATE_BLOCKED", "这个候选处于阻塞状态，请先处理当前问题。"],
  ];
  const known = knownMessages.find(([needle]) => detail.includes(needle));
  if (known) return new AdminOperationError(known[1], known[2], 409, detail);
  return new AdminOperationError("INTERNAL_ERROR", "操作失败，请展开技术详情或查看终端日志。", 500, detail);
}

function sendError(response: ServerResponse, error: unknown): void {
  const normalized = operationError(error);
  sendJson(response, normalized.statusCode, {
    error: {
      code: normalized.code,
      message: normalized.message,
      ...(normalized.detail ? { detail: normalized.detail } : {}),
    },
  });
}

function publicAdminState(config: AdminConfig): { config: AdminConfig; ros: ReturnType<typeof rosStorageStatus> } {
  return { config, ros: rosStorageStatus() };
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new AdminOperationError("BODY_TOO_LARGE", "请求内容过大。", 413);
    chunks.push(buffer);
  }
  if (total === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("body must be an object");
    return value as Record<string, unknown>;
  } catch (error) {
    throw new AdminOperationError("INVALID_JSON", "请求内容不是有效 JSON。", 400, error instanceof Error ? error.message : String(error));
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new AdminOperationError("INVALID_INPUT", `${field} 不能为空。`, 400);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function decodePathSegment(value: string, label: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new AdminOperationError("INVALID_PATH", `${label}路径无效。`, 400);
  }
}

function extractVersion(filename: string, game: GameId): string | undefined {
  if (game === "phigros") return filename.match(/^Phigros_(\d+(?:\.\d+)*)\.apk$/iu)?.[1];
  return filename.match(/(?:arcaea|arc)_?(\d+(?:\.\d+)+)[^/]*\.apk$/iu)?.[1]
    ?? filename.match(/(\d+(?:\.\d+)+)[^/]*\.apk$/iu)?.[1];
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const b = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.localeCompare(right, "en");
}

async function discoverApks(config: AdminConfig, game: GameId): Promise<DiscoveredApk[]> {
  const directory = game === "arcaea" ? config.arcaeaApkDir : config.phigrosApkDir;
  if (!directory) throw new AdminOperationError("APK_DIR_NOT_CONFIGURED", `还没有配置 ${gameConfig(game).name} APK 目录。请先到设置填写目录。`, 409);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new AdminOperationError("APK_DIR_UNREADABLE", "APK 目录不存在或无法读取。", 409, error instanceof Error ? error.message : String(error));
  }
  const result: DiscoveredApk[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".apk")) continue;
    const version = extractVersion(entry.name, game);
    if (!version) continue;
    const absolutePath = path.resolve(directory, entry.name);
    const fileStats = await stat(absolutePath);
    result.push({ filename: entry.name, version, sizeBytes: fileStats.size, modifiedAt: fileStats.mtime.toISOString() });
  }
  return result.sort((left, right) => compareVersions(left.version, right.version));
}

function filenameOnly(value: string): string {
  if (!value || path.basename(value) !== value || value === "." || value === ".." || /[\0\\/]/u.test(value)) {
    throw new AdminOperationError("INVALID_FILENAME", "APK 必须从已配置目录中选择，不能传入路径。", 400);
  }
  return value;
}

async function selectedApk(config: AdminConfig, game: GameId, filename: string, role: "base" | "target"): Promise<ExtractorApk> {
  const directory = game === "arcaea" ? config.arcaeaApkDir : config.phigrosApkDir;
  const safeFilename = filenameOnly(filename);
  const version = extractVersion(safeFilename, game);
  if (!version) throw new AdminOperationError("INVALID_APK_FILENAME", "这个 APK 文件名无法解析版本，请选择标准版本名。", 400);
  const absolutePath = path.resolve(directory, safeFilename);
  try {
    const realDirectory = await realpath(directory);
    const realFile = await realpath(absolutePath);
    if (!inside(realDirectory, realFile)) throw new Error("resolved APK path escapes configured directory");
    const fileStats = await stat(absolutePath);
    if (!fileStats.isFile()) throw new Error("not a file");
    return { role, version, filename: safeFilename, absolutePath, sizeBytes: fileStats.size, verification: "unverified" };
  } catch (error) {
    throw new AdminOperationError("APK_NOT_FOUND", "没有找到选择的 APK。请重新扫描目录。", 409, error instanceof Error ? error.message : String(error));
  }
}

function runProcess(command: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => resolve({ code: 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: `${Buffer.concat(stderr).toString("utf8")}\n${error.message}` }));
    child.once("close", (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
  });
}

function inside(rootPath: string, targetPath: string): boolean {
  const normalize = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  const root = normalize(path.resolve(rootPath));
  const target = normalize(path.resolve(targetPath));
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return target === root || target.startsWith(prefix);
}

async function runConfiguredExtractor(config: AdminConfig, game: GameConfig, baseApk: ExtractorApk, targetApk: ExtractorApk): Promise<ExtractorResult> {
  if (!config.legacyExtractorRoot && game.id !== "phigros") {
    throw new AdminOperationError("EXTRACTOR_NOT_CONFIGURED", "还没有配置旧项目提取器目录。请在设置中填写包含 scripts/extract-* 的旧项目目录。", 409);
  }
  let extractorRoot: string;
  try {
    extractorRoot = await realpath(game.id === "phigros" ? PROJECT_ROOT : config.legacyExtractorRoot);
  } catch (error) {
    throw new AdminOperationError("EXTRACTOR_NOT_FOUND", "旧项目提取器目录不存在或无法读取。", 409, error instanceof Error ? error.message : String(error));
  }
  const runtimeRoot = path.resolve(config.workspaceRuntimePath);
  const runsRoot = path.join(runtimeRoot, "_extractor-runs", game.id);
  await mkdir(runsRoot, { recursive: true });
  const runDirectory = path.join(runsRoot, `${targetApk.version}-${Date.now()}`);
  if (!inside(runtimeRoot, runDirectory)) throw new AdminOperationError("INVALID_RUNTIME_PATH", "提取运行目录不在 runtime 目录内。", 400);
  await mkdir(runDirectory, { recursive: true });
  if (game.id === "phigros") extractorRoot = PROJECT_ROOT;
  const configuredScriptPath = game.id === "phigros"
    ? path.resolve(PROJECT_ROOT, "tools", "phase6-phigros-diff.py")
    : path.resolve(extractorRoot, game.extractor.script);
  if (!inside(extractorRoot, configuredScriptPath)) throw new AdminOperationError("INVALID_EXTRACTOR_PATH", "提取器脚本路径无效。", 400);
  let scriptPath: string;
  try {
    scriptPath = await realpath(configuredScriptPath);
    if (!inside(extractorRoot, scriptPath) || !(await stat(scriptPath)).isFile()) throw new Error("script is not a file inside extractor root");
  } catch (error) {
    throw new AdminOperationError("EXTRACTOR_NOT_FOUND", "旧项目中没有找到对应的提取器脚本。", 409, error instanceof Error ? error.message : String(error));
  }
  const args = game.extractor.runner === "tsx"
    ? [path.resolve(PROJECT_ROOT, "node_modules", "tsx", "dist", "cli.mjs"), scriptPath, "--new", targetApk.absolutePath, "--old", baseApk.absolutePath, "--out", runDirectory]
    : [scriptPath, ...(game.extractor.includeApkDir ? ["--apk-dir", path.dirname(targetApk.absolutePath)] : []), "--new", targetApk.absolutePath, "--old", baseApk.absolutePath, "--out", runDirectory];
  const command = game.extractor.runner === "tsx" ? process.execPath : (process.env.PYTHON ?? "python");
  const execution = await runProcess(command, args, extractorRoot);
  if (execution.code !== 0) {
    const detail = `${execution.stdout}\n${execution.stderr}`.trim().slice(-20000);
    throw new AdminOperationError("EXTRACTOR_FAILED", "提取器运行失败，工作区尚未创建。", 409, detail || "提取器没有输出错误详情。");
  }
  const reportPath = path.join(runDirectory, game.extractor.reportFilename);
  const adapterOptions = { reportPath, baseVersion: baseApk.version, targetVersion: targetApk.version, baseApk, targetApk };
  try {
    const result = await game.adapterRunner(adapterOptions);
    if (game.id !== "arcaea") return result;
    try {
      const sourceInventory = await buildArcaeaSourceInventory({ sourcePath: targetApk.absolutePath, runtimeRoot: runDirectory });
      return ExtractorResult.parse({ ...result, sourceInventory });
    } catch (error) {
      throw new AdminOperationError("EXTRACTOR_FAILED", "Arcaea 新版本 source inventory 生成失败，本次更新未创建工作区。", 409, error instanceof Error ? error.message : String(error));
    }
  } catch (error) {
    if (error instanceof AdminOperationError) throw error;
    throw operationError(error);
  }
}

async function createNoopWorkspaceFromApk(runtime: AdminRuntime, body: Record<string, unknown>): Promise<unknown> {
  const gameValue = requiredString(body.game, "game");
  if (gameValue !== "arcaea" && gameValue !== "phigros") throw new AdminOperationError("INVALID_GAME", "unsupported game", 400);
  const filename = filenameOnly(requiredString(body.targetFilename ?? body.baseFilename, "APK"));
  const targetApk = await selectedApk(runtime.config, gameValue, filename, "target");
  const baseApk = { ...targetApk, role: "base" as const };
  const workspaceId = Buffer.from(`${gameValue}/${targetApk.version}`, "utf8").toString("base64url");
  const rootPath = workspaceRootFor(runtime.config, workspaceId);
  try {
    if ((await stat(path.join(rootPath, "metadata", "batch.json"))).isFile()) throw new AdminOperationError("WORKSPACE_EXISTS", "this version already has a workspace", 409);
  } catch (error) {
    if (error instanceof AdminOperationError) throw error;
  }
  await createVersionWorkspace({
    rootPath,
    game: gameValue,
    baseVersion: targetApk.version,
    targetVersion: targetApk.version,
    baseApk,
    targetApk,
    extractorVersion: "phase6-noop-same-source",
    sourceManifest: { game: gameValue, sourceType: gameValue === "arcaea" ? "arcaea_apk" : "phigros_apk", sourceSnapshot: `${targetApk.version}->${targetApk.version}:same-source`, extractorVersion: "phase6-noop-same-source", candidates: [], notes: ["No-op comparison used the same local APK source; no binary changes are asserted."] },
  });
  return { view: await workspaceView(runtime.config, workspaceId), extractor: { status: "ok", diagnostics: [], limitations: ["No-op comparison used the same local APK for base and target."] } };
}

async function createWorkspaceFromApks(runtime: AdminRuntime, body: Record<string, unknown>): Promise<unknown> {
  if (body.compareSameSource === true) return createNoopWorkspaceFromApk(runtime, body);
  const game = requiredString(body.game, "游戏");
  if (game !== "arcaea" && game !== "phigros") throw new AdminOperationError("INVALID_GAME", "不支持这个游戏。", 400);
  const gameDefinition = gameConfig(game);
  const baseFilename = filenameOnly(requiredString(body.baseFilename, "旧 APK"));
  const targetFilename = filenameOnly(requiredString(body.targetFilename, "新 APK"));
  if (baseFilename === targetFilename) throw new AdminOperationError("APK_PAIR_REQUIRED", "旧版和新版 APK 必须是两个不同文件。", 400);
  const discovered = await discoverApks(runtime.config, game);
  if (discovered.length < 2) throw new AdminOperationError("APK_PAIR_REQUIRED", "需要旧版和新版两个 APK 才能提取更新。", 409, `当前配置目录中只找到 ${discovered.length} 个可识别 APK。`);
  const [baseApk, targetApk] = await Promise.all([
    selectedApk(runtime.config, game, baseFilename, "base"),
    selectedApk(runtime.config, game, targetFilename, "target"),
  ]);
  if (baseApk.version === targetApk.version) throw new AdminOperationError("APK_VERSION_PAIR_REQUIRED", "旧版和新版 APK 的版本不能相同。", 400);
  const workspaceId = Buffer.from(`${game}/${targetApk.version}`, "utf8").toString("base64url");
  const rootPath = workspaceRootFor(runtime.config, workspaceId);
  try {
    if ((await stat(path.join(rootPath, "metadata", "batch.json"))).isFile()) throw new AdminOperationError("WORKSPACE_EXISTS", "这个版本已经有工作区，可以直接继续处理。", 409);
  } catch (error) {
    if (error instanceof AdminOperationError) throw error;
  }
  const result = await runConfiguredExtractor(runtime.config, gameDefinition, baseApk, targetApk);
  if (result.status === "failed") throw new AdminOperationError("EXTRACTOR_FAILED", "提取器报告失败，未创建工作区。", 409, result.diagnostics.map((item) => item.message).join("\n"));
  if (result.candidates.length === 0 && result.sourceInventory.length === 0) throw new AdminOperationError("NO_CANDIDATES", "提取完成，但没有发现可审核的更新资源。", 409, result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"));
  await createWorkspaceFromExtractorResult(result, { rootPath });
  try {
    await applyCatalogDiffToWorkspace(rootPath, await loadCatalog(runtime.config));
  } catch (error) {
    if (!(error instanceof AdminOperationError) || error.code !== "CATALOG_READ_FAILED") throw error;
  }
  return { view: await workspaceView(runtime.config, workspaceId), extractor: { status: result.status, diagnostics: result.diagnostics, limitations: result.limitations } };
}

async function openFolder(directory: string): Promise<void> {
  if (process.platform !== "win32") throw new AdminOperationError("OPEN_FOLDER_UNAVAILABLE", "打开本地文件夹仅支持 Windows。", 409);
  await new Promise<void>((resolve, reject) => {
    const child = spawn("explorer.exe", [directory], { windowsHide: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  }).catch((error) => {
    throw new AdminOperationError("OPEN_FOLDER_FAILED", "无法打开这个本地文件夹。", 409, error instanceof Error ? error.message : String(error));
  });
}

async function safeFolderForOpen(config: AdminConfig, workspaceId: string, folder: "workspace" | "upscale-input" | "upscale-output" | "processed"): Promise<string> {
  const rootPath = workspaceRootFor(config, workspaceId);
  const directory = knownWorkspaceFolder(config, workspaceId, folder);
  try {
    const [realRoot, realDirectory] = await Promise.all([realpath(rootPath), realpath(directory)]);
    if (!inside(realRoot, realDirectory) || !(await stat(realDirectory)).isDirectory()) throw new Error("folder is outside workspace or not a directory");
    return realDirectory;
  } catch (error) {
    throw new AdminOperationError("FOLDER_NOT_FOUND", "这个处理目录还不存在，请先完成前一步操作。", 409, error instanceof Error ? error.message : String(error));
  }
}

async function serveStatic(pathname: string, response: ServerResponse): Promise<void> {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  if (!["index.html", "admin.js", "admin.css"].includes(relative)) {
    sendText(response, 404, "Not found", "text/plain; charset=utf-8");
    return;
  }
  const filePath = path.resolve(PUBLIC_ROOT, relative);
  if (!inside(PUBLIC_ROOT, filePath)) {
    sendText(response, 404, "Not found", "text/plain; charset=utf-8");
    return;
  }
  const contentType = relative.endsWith(".html") ? "text/html; charset=utf-8" : relative.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8";
  try {
    const body = await import("node:fs/promises").then(({ readFile }) => readFile(filePath));
    sendText(response, 200, body.toString("utf8"), contentType);
  } catch {
    sendText(response, 404, "Not found", "text/plain; charset=utf-8");
  }
}

async function handleApi(runtime: AdminRuntime, request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true, localOnly: true });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/bootstrap") {
    sendJson(response, 200, { ...publicAdminState(runtime.config), games: publicGameConfigs(), workspaces: await listWorkspaces(runtime.config) });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/ros/status") {
    sendJson(response, 200, publicAdminState(runtime.config).ros);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/config") {
    sendJson(response, 200, publicAdminState(runtime.config));
    return;
  }
  if (request.method === "PUT" && url.pathname === "/api/config") {
    const body = await readJsonBody(request);
    runtime.config = await saveAdminConfig(normalizeAdminConfig({ ...runtime.config, ...body }), runtime.configPath);
    delete runtime.legacyPlan;
    sendJson(response, 200, publicAdminState(runtime.config));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/apks") {
    const game = requiredString(url.searchParams.get("game"), "游戏");
    if (game !== "arcaea" && game !== "phigros") throw new AdminOperationError("INVALID_GAME", "不支持这个游戏。", 400);
    try {
      sendJson(response, 200, { game, apks: await discoverApks(runtime.config, game) });
    } catch (error) {
      if (error instanceof AdminOperationError && error.code === "APK_DIR_NOT_CONFIGURED") {
        sendJson(response, 200, { game, apks: [], message: error.message });
        return;
      }
      throw error;
    }
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/workspaces") {
    sendJson(response, 200, { workspaces: await listWorkspaces(runtime.config) });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/workspaces/create") {
    sendJson(response, 201, await createWorkspaceFromApks(runtime, await readJsonBody(request)));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/legacy/migration") {
    sendJson(response, 200, { sourceRoot: runtime.config.legacyAssetRoot, plan: runtime.legacyPlan ?? null, ros: publicAdminState(runtime.config).ros });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/legacy/migration/rescan") {
    runtime.legacyPlan = await legacyMigrationDryRun(runtime.config);
    sendJson(response, 200, { sourceRoot: runtime.config.legacyAssetRoot, plan: runtime.legacyPlan, ros: publicAdminState(runtime.config).ros });
    return;
  }

  const match = url.pathname.match(/^\/api\/workspaces\/([^/]+)(?:\/(.*))?$/u);
  if (!match) {
    sendJson(response, 404, { error: { code: "NOT_FOUND", message: "找不到这个 API。" } });
    return;
  }
  const workspaceId = decodePathSegment(match[1]!, "工作区");
  const action = match[2] ?? "";
  if (request.method === "GET" && action === "") {
    sendJson(response, 200, await workspaceView(runtime.config, workspaceId));
    return;
  }
  if (request.method === "GET" && action.startsWith("preview/")) {
    const candidateId = decodePathSegment(action.slice("preview/".length), "候选资源");
    const role = url.searchParams.get("role");
    const preview = await previewFilePath(runtime.config, workspaceId, candidateId, role === "original" || role === "upscaled" ? role : undefined);
    response.writeHead(200, { "Content-Type": preview.mime, "Cache-Control": "no-store" });
    createReadStream(preview.filePath).pipe(response);
    return;
  }
  if (request.method !== "POST") {
    sendJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "不支持这个请求方法。" } });
    return;
  }
  const body = await readJsonBody(request);
  if (action === "rescan") {
    sendJson(response, 200, await rescanWorkspace(runtime.config, workspaceId));
    return;
  }
  if (action === "confirm") {
    sendJson(response, 200, await confirmCandidate(runtime.config, workspaceId, requiredString(body.candidateId, "候选资源")));
    return;
  }
  if (action === "confirm-all") {
    sendJson(response, 200, await confirmAllSafeCandidates(runtime.config, workspaceId));
    return;
  }
  if (action === "upscale/prepare") {
    const candidateIds = Array.isArray(body.candidateIds) ? body.candidateIds.filter((value): value is string => typeof value === "string") : undefined;
    sendJson(response, 200, await prepareUpscale(runtime.config, workspaceId, candidateIds));
    return;
  }
  if (action === "upscale/run") {
    const candidateIds = Array.isArray(body.candidateIds) ? body.candidateIds.filter((value): value is string => typeof value === "string") : undefined;
    sendJson(response, 200, await startUpscale(runtime.config, workspaceId, candidateIds));
    return;
  }
  if (action === "upscale/retry") {
    sendJson(response, 200, await retryUpscale(runtime.config, workspaceId, requiredString(body.candidateId, "candidate")));
    return;
  }
  if (action === "upscale/skip-original") {
    sendJson(response, 200, await skipUpscale(runtime.config, workspaceId, requiredString(body.candidateId, "candidate")));
    return;
  }
  if (action === "upscale/rescan") {
    sendJson(response, 200, await rescanUpscale(runtime.config, workspaceId));
    return;
  }
  if (action === "upscale/select") {
    sendJson(response, 200, await selectUpscale(runtime.config, workspaceId, requiredString(body.candidateId, "候选资源"), requiredString(body.outputFileId, "超分输出")));
    return;
  }
  if (action === "upscale/convert") {
    const alphaPolicy = optionalString(body.alphaPolicy);
    if (alphaPolicy !== undefined && alphaPolicy !== "block" && alphaPolicy !== "flatten-white") throw new AdminOperationError("INVALID_ALPHA_POLICY", "透明区域处理策略无效。", 400);
    sendJson(response, 200, await convertUpscale(runtime.config, workspaceId, requiredString(body.candidateId, "候选资源"), alphaPolicy));
    return;
  }
  if (action === "publish/dry-run") {
    sendJson(response, 200, await publishPreview(runtime.config, workspaceId));
    return;
  }
  if (action === "publish") {
    sendJson(response, 200, await publishExecute(runtime.config, workspaceId));
    return;
  }
  if (action === "open-folder") {
    const folder = requiredString(body.folder, "文件夹");
    if (folder !== "workspace" && folder !== "upscale-input" && folder !== "upscale-output" && folder !== "processed") throw new AdminOperationError("INVALID_FOLDER", "只能打开已登记的工作区文件夹。", 400);
    const directory = await safeFolderForOpen(runtime.config, workspaceId, folder);
    await openFolder(directory);
    sendJson(response, 200, { ok: true });
    return;
  }
  const candidateAction = action.match(/^candidates\/([^/]+)\/(override|identity|finalize|replace|remove|ignore|restore)$/u);
  if (candidateAction) {
    const candidateId = decodePathSegment(candidateAction[1]!, "候选资源");
    const operation = candidateAction[2]!;
    if (operation === "replace") {
      sendJson(response, 200, await replaceCandidateImage(runtime.config, workspaceId, candidateId, requiredString(body.sourcePath, "replacement image")));
      return;
    }
    if (operation === "remove" || operation === "ignore") {
      sendJson(response, 200, await removeCandidate(runtime.config, workspaceId, candidateId, operation === "ignore" ? "ignored" : "removed"));
      return;
    }
    if (operation === "restore") {
      sendJson(response, 200, await restoreCandidate(runtime.config, workspaceId, candidateId));
      return;
    }
    if (operation === "override") {
      const override: { title?: string; artist?: string; filename?: string; category?: "jacket" | "pack-cover" | "story-cg" | "story-texture" | "character-portrait" | "character-avatar" | "linkplay-preview" | "background" | "sticker" | "world-mode" | "startup" | "phigros-april-fools" | "other" } = {};
      const title = optionalString(body.title);
      const artist = optionalString(body.artist);
      const filename = optionalString(body.filename);
      const category = optionalString(body.category);
      const parsedCategory = category ? ResourceType.safeParse(category) : undefined;
      if (parsedCategory && !parsedCategory.success) throw new AdminOperationError("INVALID_CATEGORY", "category is not a supported resource type", 400);
      if (title) override.title = title;
      if (artist) override.artist = artist;
      if (filename) override.filename = filename;
      if (parsedCategory?.success) override.category = parsedCategory.data;
      sendJson(response, 200, await applyCandidateOverride(runtime.config, workspaceId, candidateId, override));
      return;
    }
    if (operation === "identity") {
      const identity: { resourceId: string; variantId?: string; renditionId?: string; relatedResourceId?: string } = { resourceId: requiredString(body.resourceId, "Resource ID") };
      const variantId = optionalString(body.variantId);
      const renditionId = optionalString(body.renditionId);
      const relatedResourceId = optionalString(body.relatedResourceId);
      if (variantId) identity.variantId = variantId;
      if (renditionId) identity.renditionId = renditionId;
      if (relatedResourceId) identity.relatedResourceId = relatedResourceId;
      sendJson(response, 200, await resolveCandidateIdentity(runtime.config, workspaceId, candidateId, identity));
      return;
    }
    if (operation === "finalize") {
      const target = body.target && typeof body.target === "object" && !Array.isArray(body.target) ? body.target as Record<string, unknown> : undefined;
      const finalizeInput: { createNewTarget?: boolean; target?: { resourceId: string; variantId: string; renditionId: string; sourceRenditionId?: string; downloadFilename?: string }; downloadFilename?: string } = { createNewTarget: body.createNewTarget === true };
      if (target) {
        const targetInput: { resourceId: string; variantId: string; renditionId: string; sourceRenditionId?: string; downloadFilename?: string } = {
          resourceId: requiredString(target.resourceId, "Resource ID"),
          variantId: requiredString(target.variantId, "Variant ID"),
          renditionId: requiredString(target.renditionId, "Rendition ID"),
        };
        const sourceRenditionId = optionalString(target.sourceRenditionId);
        if (sourceRenditionId) targetInput.sourceRenditionId = sourceRenditionId;
        const targetFilename = optionalString(target.downloadFilename);
        if (targetFilename) targetInput.downloadFilename = targetFilename;
        finalizeInput.target = targetInput;
      }
      const downloadFilename = optionalString(body.downloadFilename);
      if (downloadFilename) finalizeInput.downloadFilename = downloadFilename;
      sendJson(response, 200, await finalizeCandidate(runtime.config, workspaceId, candidateId, finalizeInput));
      return;
    }
  }
  sendJson(response, 404, { error: { code: "NOT_FOUND", message: "找不到这个工作区操作。" } });
}

export function createAdminServer(runtime: AdminRuntime): Server {
  const server = createServer((request, response) => {
    const address = server.address();
    const port = address && typeof address !== "string" ? address.port : 0;
    void (async () => {
      try {
        checkLocalRequest(request, port);
        const url = new URL(request.url ?? "/", `http://127.0.0.1:${port || 80}`);
        if (url.pathname.startsWith("/api/")) await handleApi(runtime, request, response, url);
        else if (request.method === "GET") await serveStatic(url.pathname, response);
        else sendJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "不支持这个请求方法。" } });
      } catch (error) {
        if (!response.headersSent) sendError(response, error);
        else response.end();
        if (!(error instanceof AdminOperationError)) console.error(error);
      }
    })();
  });
  return server;
}

export async function startAdminServer(options: { port?: number; configPath?: string } = {}): Promise<Server> {
  const configPath = options.configPath ?? DEFAULT_ADMIN_CONFIG_PATH;
  const runtime: AdminRuntime = { config: await loadAdminConfig(configPath), configPath };
  const port = options.port ?? Number.parseInt(process.env.ADMIN_PORT ?? "4173", 10);
  const server = createAdminServer(runtime);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const actualPort = address && typeof address !== "string" ? address.port : port;
  console.log(`Admin running at http://127.0.0.1:${actualPort}`);
  return server;
}

const isMain = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url : false;
if (isMain) {
  startAdminServer().catch((error) => {
    console.error(operationError(error).message);
    process.exitCode = 1;
  });
}

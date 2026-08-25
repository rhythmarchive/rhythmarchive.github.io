import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson, loadCatalogFile } from "../packages/domain/src/catalog.js";
import { Catalog, Game, type AssetObject } from "../packages/domain/src/schema.js";
import { validateCatalog } from "../packages/domain/src/validation.js";
import { ExtractorResult, adaptArcaeaLegacyReport, adaptPhigrosLegacyReport, createWorkspaceFromExtractorResult, type ExtractorApk } from "../packages/domain/src/extractors.js";
import { getGameAdapter, getGameProfile, listGameProfiles, type PlatformGameId } from "../packages/domain/src/platform.js";
import { buildReleaseDelta, manifestFromCatalog, manifestFromExtractorResult, readReleaseDelta, readUnifiedManifest, writeReleaseDelta, writeUnifiedManifest, UnifiedAssetManifest } from "../packages/domain/src/release.js";
import { manifestFromExternalManifest } from "../packages/domain/src/external-manifest.js";
import { approveReviewPackage, buildReviewPackage, checkReviewApproval, readReviewPackage, validateReviewPackageForDelta, writeReviewPackage } from "../packages/domain/src/review-package.js";
import { buildStorageDiff, writeStorageDiff } from "../packages/domain/src/storage-diff.js";
import { createWorkflowState, loadWorkflowState, saveWorkflowState, updateWorkflowState, workflowRoot, type WorkflowState } from "../packages/domain/src/workflow-state.js";
import { runExternalAdapter } from "./rhythmctl-external.js";

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
const tempRoot = path.resolve(repoRoot, "temp");

type ParsedArgs = { positionals: string[]; values: Record<string, string>; flags: Set<string> };

function parseArgs(tokens: string[]): ParsedArgs {
  const positionals: string[] = [];
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const raw = token.slice(2);
    const equals = raw.indexOf("=");
    if (equals >= 0) {
      values[raw.slice(0, equals)] = raw.slice(equals + 1);
      continue;
    }
    const next = tokens[index + 1];
    if (next && !next.startsWith("--")) {
      values[raw] = next;
      index += 1;
    } else {
      flags.add(raw);
    }
  }
  return { positionals, values, flags };
}

function required(args: ParsedArgs, key: string): string {
  const value = args.values[key];
  if (!value?.trim()) throw new Error(`missing required option --${key}`);
  return value;
}

function gameArg(args: ParsedArgs): PlatformGameId {
  return Game.parse(required(args, "game"));
}

function sourceArg(args: ParsedArgs): string {
  const value = required(args, "source");
  return /^https?:\/\//u.test(value) ? value : path.resolve(value);
}

function tempPath(filePath: string, label: string): string {
  const resolved = path.resolve(filePath);
  const relative = path.relative(tempRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label} must be inside repository temp/: ${resolved}`);
  return resolved;
}

function outputPath(args: ParsedArgs, fallback: string, label = "CLI output"): string {
  return tempPath(args.values.output ?? fallback, label);
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(path.resolve(filePath), "utf8")) as unknown;
}

async function fileApk(filePath: string, role: ExtractorApk["role"], version: string): Promise<ExtractorApk> {
  const absolutePath = path.resolve(filePath);
  const info = await stat(absolutePath);
  if (!info.isFile()) throw new Error(`${role} APK is not a file: ${absolutePath}`);
  return { role, version, filename: path.basename(absolutePath), absolutePath, sizeBytes: Number(info.size), verification: "unverified" };
}

async function writeOutput(filePath: string, payload: unknown): Promise<void> {
  await atomicWriteJson(path.resolve(filePath), payload);
}

function print(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

async function commandGames(): Promise<void> {
  print({ status: "OK", games: listGameProfiles() });
}

async function commandProbe(args: ParsedArgs): Promise<void> {
  const game = gameArg(args);
  const source = sourceArg(args);
  const adapter = getGameAdapter(game);
  const probe = await adapter.probe(source);
  const plan = adapter.planExtraction(probe);
  const target = outputPath(args, path.join("temp", "rhythmctl", "probe", game, `${Date.now()}.json`));
  await writeOutput(target, { profile: adapter.profile, probe, plan });
  print({ status: plan.supported ? "OK" : "BLOCKED", game, source, output: target, probe, plan });
  if (!plan.supported) process.exitCode = 2;
}

async function commandIngest(args: ParsedArgs): Promise<void> {
  const game = gameArg(args);
  const version = required(args, "version");
  const source = sourceArg(args);
  const configuredRoot = args.values.root ? tempPath(args.values.root, "workflow root") : path.resolve("temp", "rhythmctl");
  const root = workflowRoot(game, version, configuredRoot);
  await mkdir(root, { recursive: true });
  const statePath = path.join(root, "state.json");
  let state: WorkflowState | undefined;
  try {
    state = await loadWorkflowState(statePath);
    if (state.gameId !== game || state.version !== version || state.sourcePath !== source) throw new Error("existing workflow state belongs to another source/game/version");
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") state = createWorkflowState({ gameId: game, version, sourcePath: source });
    else if (error instanceof SyntaxError) state = createWorkflowState({ gameId: game, version, sourcePath: source });
    else if (error instanceof Error && error.message.includes("Unexpected end")) state = createWorkflowState({ gameId: game, version, sourcePath: source });
    else if (state === undefined) throw error;
  }
  const adapter = getGameAdapter(game);
  const probe = await adapter.probe(source);
  const plan = adapter.planExtraction(probe);
  const probePath = path.join(root, "probe.json");
  const planPath = path.join(root, "extraction-plan.json");
  await writeOutput(probePath, probe);
  await writeOutput(planPath, plan);
  const next = await updateWorkflowState(statePath, {
    ...(state ? {} : {}),
    sourceSnapshot: probe.snapshot,
    phase: plan.supported ? "ingest" : "blocked",
    completedSteps: ["probe", "ingest"],
    blockers: plan.supported ? [] : plan.diagnostics,
  }).catch(async () => {
    const initial = state ?? createWorkflowState({ gameId: game, version, sourcePath: source, sourceSnapshot: probe.snapshot });
    const prepared = { ...initial, sourceSnapshot: probe.snapshot, phase: plan.supported ? "ingest" as const : "blocked" as const, completedSteps: ["probe", "ingest"], blockers: plan.supported ? [] : plan.diagnostics, updatedAt: new Date().toISOString() };
    await saveWorkflowState(prepared, statePath);
    return prepared;
  });
  print({ status: plan.supported ? "OK" : "BLOCKED", game, version, root, state: next, probePath, planPath });
  if (!plan.supported) process.exitCode = 2;
}

async function commandExtract(args: ParsedArgs): Promise<void> {
  const game = gameArg(args);
  if (game === "rizline" || game === "infalsus") {
    const version = required(args, "version");
    if (game === "rizline" && !args.values.apk?.trim()) throw new Error("missing required option --apk for rizline extraction");
    if (game === "infalsus" && !args.values["game-root"]?.trim()) throw new Error("missing required option --game-root for infalsus extraction");
    const outputDir = outputPath(args, path.join("temp", game === "rizline" ? "rizline_publish_prep" : "infalsus", version), "adapter output");
    const result = await runExternalAdapter({
      game, version, repoRoot, outputDir,
      ...(args.values.apk ? { apk: args.values.apk } : {}), ...(args.values.cache ? { cacheRoot: args.values.cache } : {}),
      ...(args.values["game-root"] ? { gameRoot: args.values["game-root"] } : {}), ...(args.values.previous ? { previousManifest: args.values.previous } : {}),
    });
    print(result);
    if (result.status === "BLOCKED") process.exitCode = 2;
    return;
  }
  const reportPath = path.resolve(required(args, "report"));
  const baseVersion = required(args, "base-version");
  const targetVersion = required(args, "target-version");
  const baseApk = await fileApk(required(args, "base-apk"), "base", baseVersion);
  const targetApk = await fileApk(required(args, "target-apk"), "target", targetVersion);
  const sourceSnapshot = args.values.snapshot;
  const result = game === "arcaea"
    ? await adaptArcaeaLegacyReport({ reportPath, baseVersion, targetVersion, baseApk, targetApk, ...(sourceSnapshot ? { sourceSnapshot } : {}) })
    : game === "phigros"
      ? await adaptPhigrosLegacyReport({ reportPath, baseVersion, targetVersion, baseApk, targetApk, ...(sourceSnapshot ? { sourceSnapshot } : {}) })
      : (() => { throw new Error(`--report extraction is currently implemented through the existing APK adapters only: ${game}`); })();
  const configuredRoot = args.values.root ? tempPath(args.values.root, "workflow root") : path.resolve("temp", "rhythmctl");
  const root = workflowRoot(game, targetVersion, configuredRoot);
  await mkdir(root, { recursive: true });
  const resultPath = outputPath(args, path.join(root, "extractor-result.json"));
  await writeOutput(resultPath, result);
  const workspacePath = tempPath(args.values.workspace ?? path.join(root, "workspace"), "workspace output");
  const workspace = result.status === "failed" ? undefined : await createWorkspaceFromExtractorResult(result, { rootPath: workspacePath });
  const normalized = await manifestFromExtractorResult(result);
  const manifestPath = path.join(root, "candidate-manifest.json");
  await writeUnifiedManifest(normalized, manifestPath);
  print({ status: result.status === "ok" ? "OK" : "BLOCKED", game, resultPath, manifestPath, workspaceRoot: workspace?.rootPath, candidateCount: result.candidates.length, diagnostics: result.diagnostics });
  if (result.status !== "ok") process.exitCode = 2;
}

async function commandNormalize(args: ParsedArgs): Promise<void> {
  const inputPath = path.resolve(required(args, "input"));
  const value = await readJson(inputPath);
  const output = outputPath(args, path.join("temp", "rhythmctl", "normalized", `${Date.now()}.json`));
  const extractor = ExtractorResult.safeParse(value);
  let manifest;
  if (extractor.success) {
    manifest = await manifestFromExtractorResult(extractor.data, args.values.version ? { version: args.values.version } : {});
  } else if (UnifiedAssetManifest.safeParse(value).success) {
    manifest = UnifiedAssetManifest.parse(value);
  } else {
    const catalogResult = validateCatalog(value);
    if (catalogResult.success) {
      manifest = manifestFromCatalog(catalogResult.data, gameArg(args), required(args, "version"));
    } else {
      manifest = manifestFromExternalManifest(value, { gameId: gameArg(args), version: required(args, "version") });
    }
  }
  await writeUnifiedManifest(manifest, output);
  print({ status: "OK", input: inputPath, output, game: manifest.gameId, version: manifest.version, entries: manifest.entries.length });
}

async function commandDiff(args: ParsedArgs): Promise<void> {
  const currentPath = path.resolve(required(args, "current"));
  const current = await readUnifiedManifest(currentPath);
  const previous = args.values.previous ? await readUnifiedManifest(args.values.previous) : undefined;
  const delta = buildReleaseDelta(previous, current);
  const output = outputPath(args, path.join(path.dirname(currentPath), "release-delta.json"));
  await writeReleaseDelta(delta, output);
  print({ status: "OK", output, summary: delta.summary });
}

async function commandReview(args: ParsedArgs): Promise<void> {
  const deltaPath = path.resolve(required(args, "delta"));
  const delta = await readReleaseDelta(deltaPath);
  const review = buildReviewPackage(delta);
  const output = outputPath(args, path.join(path.dirname(deltaPath), "review-package.json"));
  await writeReviewPackage(review, output);
  print({ status: review.status === "pending" ? "PENDING_REVIEW" : "OK", output, summary: review.summary, anomalies: review.anomalies });
}

async function commandApprove(args: ParsedArgs): Promise<void> {
  const reviewPath = path.resolve(required(args, "review"));
  const review = await readReviewPackage(reviewPath);
  const approved = approveReviewPackage(review, required(args, "reviewer"));
  const output = outputPath(args, reviewPath);
  await writeReviewPackage(approved, output);
  print({ status: "OK", output, reviewer: approved.reviewer, approvedAt: approved.approvedAt, approvedChangeCount: approved.approvedChangeKeys.length });
}

async function commandCheckApproval(args: ParsedArgs): Promise<void> {
  const result = await checkReviewApproval(path.resolve(required(args, "review")));
  print({ status: result.approved ? "APPROVED" : "PENDING_REVIEW", review: result.review });
  if (!result.approved) process.exitCode = 2;
}

async function commandStorageDiff(args: ParsedArgs): Promise<void> {
  const localPath = path.resolve(required(args, "local"));
  const local = await readUnifiedManifest(localPath);
  const published = args.values.published ? await readUnifiedManifest(args.values.published) : undefined;
  const diff = buildStorageDiff(local, published);
  const output = outputPath(args, path.join(path.dirname(localPath), "storage-diff.json"));
  await writeStorageDiff(diff, output);
  print({ status: "OK", output, summary: diff.summary });
}

async function commandReleasePrepare(args: ParsedArgs): Promise<void> {
  const currentPath = path.resolve(required(args, "current"));
  const current = await readUnifiedManifest(currentPath);
  const previous = args.values.previous ? await readUnifiedManifest(args.values.previous) : undefined;
  const delta = buildReleaseDelta(previous, current);
  const root = outputPath(args, path.join(path.dirname(currentPath), "release-prepare"), "release output");
  await mkdir(root, { recursive: true });
  const deltaPath = path.join(root, "release-delta.json");
  const reviewPath = path.join(root, "review-package.json");
  await writeReleaseDelta(delta, deltaPath);
  let review = buildReviewPackage(delta);
  if (args.values.review) review = await readReviewPackage(args.values.review);
  else await writeReviewPackage(review, reviewPath);
  const reviewValidation = validateReviewPackageForDelta(review, delta);
  if (!reviewValidation.valid) throw new Error(`review package does not match release delta: ${reviewValidation.reasons.join("; ")}`);
  const approved = review.status === "approved" || review.status === "not-required";
  print({ status: approved ? "READY_LOCAL_ONLY" : "PENDING_REVIEW", deltaPath, reviewPath: args.values.review ?? reviewPath, summary: delta.summary, remoteWrite: "DISABLED" });
  if (!approved) process.exitCode = 2;
}

async function commandVerify(args: ParsedArgs): Promise<void> {
  const catalogPath = path.resolve(args.values.catalog ?? path.join(repoRoot, "catalog", "index.json"));
  const catalog = await loadCatalogFile(catalogPath);
  const checks: Record<string, string> = { catalog: "PASS" };
  if (args.values.manifest) { await readUnifiedManifest(args.values.manifest); checks.manifest = "PASS"; }
  const delta = args.values.delta ? await readReleaseDelta(args.values.delta) : undefined;
  if (delta) checks.delta = "PASS";
  const review = args.values.review ? await readReviewPackage(args.values.review) : undefined;
  if (review) {
    checks.review = review.status;
    if (delta) {
      const validation = validateReviewPackageForDelta(review, delta);
      if (!validation.valid) throw new Error(`review package does not match delta: ${validation.reasons.join("; ")}`);
      checks.reviewDelta = "PASS";
    }
  }
  print({ status: "PASS", catalogPath, resources: catalog.resources.length, checks });
}

async function commandBuild(args: ParsedArgs): Promise<void> {
  if (args.flags.has("catalog-only")) {
    const catalog = await loadCatalogFile(path.join(repoRoot, "catalog", "index.json"));
    print({ status: "PASS", mode: "catalog-only", resources: catalog.resources.length });
    return;
  }
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = await execFileAsync(npm, ["run", "site:build"], { cwd: repoRoot, maxBuffer: 20 * 1024 * 1024 });
  print({ status: "PASS", command: "npm run site:build", stdoutTail: result.stdout.slice(-2000), stderrTail: result.stderr.slice(-2000) });
}

async function main(): Promise<void> {
  const [command, ...tokens] = process.argv.slice(2);
  const args = parseArgs(tokens);
  if (!command || command === "help" || args.flags.has("help")) {
    print({ usage: "rhythmctl <games|probe|ingest|extract|normalize|diff|review|approve|check-approval|build|verify|release prepare|storage diff>", tempRoot: path.resolve("temp", "rhythmctl") });
    return;
  }
  if (command === "games") return commandGames();
  if (command === "probe") return commandProbe(args);
  if (command === "ingest") return commandIngest(args);
  if (command === "extract") return commandExtract(args);
  if (command === "normalize") return commandNormalize(args);
  if (command === "diff") return commandDiff(args);
  if (command === "review") return commandReview(args);
  if (command === "approve") return commandApprove(args);
  if (command === "check-approval") return commandCheckApproval(args);
  if (command === "build") return commandBuild(args);
  if (command === "verify") return commandVerify(args);
  if (command === "storage" && args.positionals[0] === "diff") return commandStorageDiff(args);
  if (command === "release" && args.positionals[0] === "prepare") return commandReleasePrepare(args);
  throw new Error(`unknown rhythmctl command: ${[command, ...args.positionals].join(" ")}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ status: "ERROR", message: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
});

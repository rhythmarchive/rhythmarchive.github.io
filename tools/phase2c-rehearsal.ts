import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  adaptArcaeaLegacyReport,
  adaptPhigrosLegacyReport,
  candidateCanBeConfirmed,
  confirmCandidateInWorkspace,
  createWorkspaceFromExtractorResult,
  loadWorkspaceState,
  type ExtractorApk,
  type ExtractorResult,
} from "../packages/domain/src/index.js";

const REPO_ROOT = process.cwd();
const DEFAULT_ARCAEA_APK_DIR = process.env.ARCAEA_APK_DIR ?? "";
const DEFAULT_PHIGROS_APK_DIR = process.env.PHIGROS_APK_DIR ?? "";
const DEFAULT_LEGACY_PROJECT = process.env.LEGACY_PROJECT_ROOT ?? "";
const DEFAULT_REHEARSAL_ROOT = path.resolve(REPO_ROOT, ".runtime", "rehearsal");
const DEFAULT_REPORT_ROOT = path.resolve(REPO_ROOT, "docs", "design", "phase2c", "data");

type DiscoveredApk = { filename: string; absolutePath: string; version: string; sizeBytes: number; modifiedAt: string };

function parseArgs(argv: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) parsed[key] = "true";
    else {
      parsed[key] = value;
      index += 1;
    }
  }
  return parsed;
}

function versionKey(version: string): number[] {
  return version.split(".").map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(left: string, right: string): number {
  const a = versionKey(left);
  const b = versionKey(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.localeCompare(right, "en");
}

function extractVersion(filename: string, game: "arcaea" | "phigros"): string | undefined {
  if (game === "phigros") return filename.match(/^Phigros_(\d+(?:\.\d+)*)\.apk$/i)?.[1];
  return filename.match(/(?:arcaea|arc)_?(\d+(?:\.\d+)+)[^/]*\.apk$/i)?.[1] ?? filename.match(/(\d+(?:\.\d+)+)[^/]*\.apk$/i)?.[1];
}

async function discoverApks(directory: string, game: "arcaea" | "phigros"): Promise<DiscoveredApk[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: DiscoveredApk[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".apk")) continue;
    const version = extractVersion(entry.name, game);
    if (!version) continue;
    const absolutePath = path.resolve(directory, entry.name);
    const fileStats = await stat(absolutePath);
    files.push({ filename: entry.name, absolutePath, version, sizeBytes: fileStats.size, modifiedAt: fileStats.mtime.toISOString() });
  }
  return files.sort((left, right) => compareVersions(left.version, right.version));
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });
  return hash.digest("hex");
}

async function apkRecord(role: "base" | "target", source: DiscoveredApk, hash = false): Promise<ExtractorApk> {
  return {
    role,
    version: source.version,
    filename: source.filename,
    absolutePath: source.absolutePath,
    ...(hash ? { sha256: await sha256File(source.absolutePath), sizeBytes: source.sizeBytes, verification: "verified" as const } : { sizeBytes: source.sizeBytes, verification: "unverified" as const }),
  };
}

function blockedReport(game: "arcaea" | "phigros", directory: string, found: DiscoveredApk[], requiredCommand: string) {
  return {
    generatedAt: new Date().toISOString(),
    game,
    status: "REAL_APK_REHEARSAL_BLOCKED_MISSING_LOCAL_INPUT",
    apkDirectory: directory,
    foundApks: found,
    requiredInput: "at least two distinct local APK versions: one base/old and one target/new",
    requiredCommand,
    note: game === "phigros"
      ? "Only one Phigros APK is currently present. This is recorded as a missing-base input, not as a zero-update result. No network download was attempted."
      : "Fewer than two Arcaea APKs are currently present. No network download was attempted and no real diff was asserted.",
  };
}

function run(command: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => resolve({ code: 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: `${Buffer.concat(stderr).toString("utf8")}\n${error.message}` }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
  });
}

function resultStatistics(result: ExtractorResult, workspaceCandidates?: Awaited<ReturnType<typeof loadWorkspaceState>>["candidates"]) {
  const candidates = workspaceCandidates ?? result.candidates;
  return {
    extractedCandidates: candidates.length,
    automaticTitleComplete: candidates.filter((candidate) => "suggestedMapping" in candidate ? Boolean(candidate.suggestedMapping.title) : Boolean(candidate.suggestedTitle)).length,
    automaticArtistComplete: candidates.filter((candidate) => "suggestedMapping" in candidate ? typeof candidate.suggestedMapping.metadata.artist === "string" : Boolean(candidate.suggestedArtist)).length,
    automaticFilenameComplete: candidates.filter((candidate) => "suggestedMapping" in candidate ? Boolean(candidate.naming.suggestedFilename) : Boolean(candidate.suggestedFilename)).length,
    identityMapped: candidates.filter((candidate) => "suggestedMapping" in candidate ? candidate.suggestedMapping.externalIdentities.length > 0 : candidate.suggestedExternalIdentity.length > 0).length,
    manualNamingRequired: candidates.filter((candidate) => candidate.reviewRequirements.manualNamingRequired).length,
    metadataReviewRequired: candidates.filter((candidate) => candidate.reviewRequirements.metadataReviewRequired).length,
    identityReviewRequired: candidates.filter((candidate) => candidate.reviewRequirements.identityReviewRequired).length,
    blocked: candidates.filter((candidate) => "suggestedMapping" in candidate ? candidate.status === "BLOCKED" : candidate.initialStatus === "BLOCKED").length,
  };
}

async function runArcaea(options: { oldProject: string; apkDir: string; rehearsalRoot: string; sources: DiscoveredApk[] }) {
  const [base, target] = options.sources;
  if (!base || !target) throw new Error("runArcaea requires an APK pair");
  const outputDir = path.join(options.rehearsalRoot, "arcaea", target.version, "legacy-output");
  const workspaceRoot = path.join(options.rehearsalRoot, "arcaea", target.version, "workspace");
  await mkdir(outputDir, { recursive: true });
  const tsx = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const script = path.join(options.oldProject, "scripts", "extract-arcaea-update.ts");
  const execution = await run(process.execPath, [tsx, script, "--new", target.absolutePath, "--old", base.absolutePath, "--out", outputDir], REPO_ROOT);
  if (execution.code !== 0) {
    return {
      generatedAt: new Date().toISOString(),
      game: "arcaea",
      status: "REAL_APK_REHEARSAL_BLOCKED_EXTRACTOR_FAILURE",
      baseApk: base,
      targetApk: target,
      outputDir,
      stdout: execution.stdout,
      stderr: execution.stderr,
      diagnostics: [{ code: "LEGACY_ARCAEA_EXTRACTOR_FAILED", message: execution.stderr || "legacy extractor exited non-zero" }],
    };
  }
  const result = await adaptArcaeaLegacyReport({ reportPath: path.join(outputDir, "arcaea-update-report.json"), baseVersion: base.version, targetVersion: target.version, baseApk: await apkRecord("base", base), targetApk: await apkRecord("target", target) });
  const workspace = await createWorkspaceFromExtractorResult(result, { rootPath: workspaceRoot });
  const confirmable = result.candidates.filter((candidate) => !candidate.reviewRequirements.metadataReviewRequired && !candidate.reviewRequirements.identityReviewRequired).slice(0, 3);
  for (const item of confirmable) await confirmCandidateInWorkspace(workspace.rootPath, item.id!, { note: "isolated rehearsal confirmation", now: new Date().toISOString() });
  const state = await loadWorkspaceState(workspace.rootPath);
  return {
    generatedAt: new Date().toISOString(),
    game: "arcaea",
    status: "REAL_APK_REHEARSAL_COMPLETE",
    baseApk: base,
    targetApk: target,
    legacyOutputDir: outputDir,
    workspaceRoot: workspace.rootPath,
    statistics: resultStatistics(result, state.candidates),
    confirmedInRehearsal: confirmable.length,
    limitations: result.limitations,
    diagnostics: result.diagnostics,
  };
}

async function runPhigros(options: { oldProject: string; apkDir: string; rehearsalRoot: string; sources: DiscoveredApk[] }) {
  const [base, target] = options.sources;
  if (!base || !target) throw new Error("runPhigros requires an APK pair");
  const outputDir = path.join(options.rehearsalRoot, "phigros", target.version, "legacy-output");
  const workspaceRoot = path.join(options.rehearsalRoot, "phigros", target.version, "workspace");
  await mkdir(outputDir, { recursive: true });
  const script = path.join(options.oldProject, "scripts", "extract-phigros-update.py");
  const execution = await run("python", [script, "--apk-dir", options.apkDir, "--new", target.absolutePath, "--old", base.absolutePath, "--out", outputDir], REPO_ROOT);
  if (execution.code !== 0) {
    return {
      generatedAt: new Date().toISOString(),
      game: "phigros",
      status: "REAL_APK_REHEARSAL_BLOCKED_EXTRACTOR_FAILURE",
      baseApk: base,
      targetApk: target,
      outputDir,
      stdout: execution.stdout,
      stderr: execution.stderr,
      diagnostics: [{ code: "LEGACY_PHIGROS_EXTRACTOR_FAILED", message: execution.stderr || "legacy extractor exited non-zero" }],
    };
  }
  const result = await adaptPhigrosLegacyReport({ reportPath: path.join(outputDir, "phigros-update-report.json"), baseVersion: base.version, targetVersion: target.version, baseApk: await apkRecord("base", base), targetApk: await apkRecord("target", target) });
  const workspace = result.candidates.length > 0 ? await createWorkspaceFromExtractorResult(result, { rootPath: workspaceRoot }) : undefined;
  const state = workspace ? await loadWorkspaceState(workspace.rootPath) : undefined;
  return {
    generatedAt: new Date().toISOString(),
    game: "phigros",
    status: "REAL_APK_REHEARSAL_COMPLETE",
    baseApk: base,
    targetApk: target,
    legacyOutputDir: outputDir,
    ...(workspace ? { workspaceRoot: workspace.rootPath } : {}),
    statistics: resultStatistics(result, state?.candidates),
    limitations: result.limitations,
    diagnostics: result.diagnostics,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const configuredArcaeaDir = args["arcaea-apk-dir"] ?? DEFAULT_ARCAEA_APK_DIR;
  const configuredPhigrosDir = args["phigros-apk-dir"] ?? DEFAULT_PHIGROS_APK_DIR;
  const configuredLegacyProject = args["legacy-project"] ?? DEFAULT_LEGACY_PROJECT;
  const arcaeaDir = configuredArcaeaDir ? path.resolve(configuredArcaeaDir) : "";
  const phigrosDir = configuredPhigrosDir ? path.resolve(configuredPhigrosDir) : "";
  const oldProject = configuredLegacyProject ? path.resolve(configuredLegacyProject) : "";
  const rehearsalRoot = path.resolve(args["rehearsal-root"] ?? DEFAULT_REHEARSAL_ROOT);
  const reportRoot = path.resolve(args["report-root"] ?? DEFAULT_REPORT_ROOT);
  await mkdir(rehearsalRoot, { recursive: true });
  await mkdir(reportRoot, { recursive: true });

  const arcaeaSources = await discoverApks(arcaeaDir, "arcaea");
  const phigrosSources = await discoverApks(phigrosDir, "phigros");
  const arcaeaReport = arcaeaSources.length < 2
    ? blockedReport("arcaea", arcaeaDir, arcaeaSources, "two Arcaea APKs with distinct versions")
    : await runArcaea({ oldProject, apkDir: arcaeaDir, rehearsalRoot, sources: arcaeaSources });
  const phigrosReport = phigrosSources.length < 2
    ? blockedReport("phigros", phigrosDir, phigrosSources, "Phigros_<old-version>.apk and Phigros_<new-version>.apk")
    : await runPhigros({ oldProject, apkDir: phigrosDir, rehearsalRoot, sources: phigrosSources });
  await writeFile(path.join(reportRoot, "arcaea-rehearsal.json"), `${JSON.stringify(arcaeaReport, null, 2)}\n`, "utf8");
  await writeFile(path.join(reportRoot, "phigros-rehearsal.json"), `${JSON.stringify(phigrosReport, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ arcaea: arcaeaReport, phigros: phigrosReport }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

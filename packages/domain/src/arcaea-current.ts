import { copyFile, mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  adaptArcaeaLegacyReport,
  ExtractorResult,
  type ExtractorApk,
  type ExtractorCandidate,
} from "./extractors.js";

export type ArcaeaApkDescriptor = {
  version: string;
  filename: string;
  absolutePath: string;
  sizeBytes: number;
  modifiedAt: string;
};

export type ArcaeaCurrentSnapshot = {
  apk: ArcaeaApkDescriptor;
  outputDir: string;
  result: ExtractorResult;
  jacketCount: number;
  nonJacketCount: number;
};

function versionParts(value: string): number[] {
  return value.split(".").map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.localeCompare(right, "en");
}

export function arcaeaVersionFromFilename(filename: string): string | undefined {
  return filename.match(/(?:arcaea|arc)_?(\d+(?:\.\d+)+)[^/]*\.apk$/iu)?.[1]
    ?? filename.match(/(\d+(?:[._]\d+)+)[^/]*\.apk$/u)?.[1]?.replaceAll("_", ".");
}

export async function findCurrentArcaeaApk(inputPath: string): Promise<ArcaeaApkDescriptor | undefined> {
  const normalized = path.resolve(inputPath);
  let inputStats;
  try {
    inputStats = await stat(normalized);
  } catch {
    return undefined;
  }
  if (inputStats.isFile()) {
    const version = arcaeaVersionFromFilename(path.basename(normalized));
    return version && normalized.toLowerCase().endsWith(".apk")
      ? { version, filename: path.basename(normalized), absolutePath: normalized, sizeBytes: inputStats.size, modifiedAt: inputStats.mtime.toISOString() }
      : undefined;
  }
  if (!inputStats.isDirectory()) return undefined;
  const entries = await readdir(normalized, { withFileTypes: true });
  const candidates: ArcaeaApkDescriptor[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".apk")) continue;
    const version = arcaeaVersionFromFilename(entry.name);
    if (!version) continue;
    const absolutePath = path.resolve(normalized, entry.name);
    const fileStats = await stat(absolutePath);
    candidates.push({ version, filename: entry.name, absolutePath, sizeBytes: fileStats.size, modifiedAt: fileStats.mtime.toISOString() });
  }
  return candidates.sort((left, right) => compareVersions(left.version, right.version)).at(-1);
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

type ArcaeaExtractorReport = {
  outputDir?: string;
  copied?: Array<{ category?: string; sourcePath?: string; outputPath?: string; sizeBytes?: number }>;
};

function safeCollisionPart(value: string): string {
  return value.replace(/[<>:"/\\|?*]/gu, "_").replace(/\s+/gu, " ").trim() || "asset";
}

async function normalizeExtractorCollisions(options: {
  reportPath: string;
  outputDir: string;
  apk: ArcaeaApkDescriptor;
  runtimeRoot: string;
}): Promise<string> {
  const report = JSON.parse(await readFile(options.reportPath, "utf8")) as ArcaeaExtractorReport;
  const copied = report.copied ?? [];
  const groups = new Map<string, Array<{ category: string; sourcePath: string; outputPath: string; sizeBytes?: number }>>();
  for (const item of copied) {
    if (!item.category || !item.sourcePath || !item.outputPath) continue;
    groups.set(item.outputPath, [...(groups.get(item.outputPath) ?? []), { category: item.category, sourcePath: item.sourcePath, outputPath: item.outputPath, ...(item.sizeBytes === undefined ? {} : { sizeBytes: item.sizeBytes }) }]);
  }
  const collisions = [...groups.values()].filter((group) => group.length > 1);
  if (collisions.length === 0) return options.reportPath;

  const collisionRoot = await mkdtemp(path.join(options.runtimeRoot, ".arcaea-current-collision-"));
  try {
    for (const group of collisions) {
      const used = new Set<string>();
      for (const [index, item] of group.entries()) {
        const sourcePath = item.sourcePath.replace(/\\/gu, "/");
        const parent = path.posix.basename(path.posix.dirname(sourcePath));
        const originalName = path.posix.basename(item.outputPath);
        const suffix = index === 0 ? "" : `_${index + 1}`;
        const outputPath = path.posix.join(item.category, `${safeCollisionPart(parent)}_${originalName.replace(/\.[^.]+$/u, "")}${suffix}${path.posix.extname(originalName)}`);
        if (used.has(outputPath)) throw new Error(`Arcaea current snapshot output collision remains ambiguous: ${item.outputPath}`);
        used.add(outputPath);
        const archiveEntry = path.posix.join("assets", sourcePath);
        const extraction = await runProcess("tar", ["-xf", options.apk.absolutePath, "-C", collisionRoot, archiveEntry], options.runtimeRoot);
        if (extraction.code !== 0) throw new Error(`Arcaea current snapshot collision extraction failed: ${sourcePath}`);
        const extractedPath = path.join(collisionRoot, ...archiveEntry.split("/"));
        const targetPath = path.resolve(options.outputDir, outputPath);
        await mkdir(path.dirname(targetPath), { recursive: true });
        await copyFile(extractedPath, targetPath);
        const reportItem = copied.find((candidate) => candidate.outputPath === item.outputPath && candidate.sourcePath === item.sourcePath);
        if (reportItem) reportItem.outputPath = outputPath;
      }
    }
    const normalizedReportPath = path.join(options.outputDir, "arcaea-current-update-report.json");
    await writeFile(normalizedReportPath, `${JSON.stringify({ ...report, outputDir: options.outputDir, copied }, null, 2)}\n`, "utf8");
    return normalizedReportPath;
  } finally {
    await rm(collisionRoot, { recursive: true, force: true });
  }
}

function apkRecord(role: "base" | "target", apk: ArcaeaApkDescriptor): ExtractorApk {
  return {
    role,
    version: apk.version,
    filename: apk.filename,
    absolutePath: apk.absolutePath,
    sizeBytes: apk.sizeBytes,
    verification: "unverified",
  };
}

function currentSnapshotOutput(runtimeRoot: string, apk: ArcaeaApkDescriptor): string {
  const version = apk.version.replace(/[^a-z0-9.-]+/giu, "_");
  return path.join(path.resolve(runtimeRoot), "_legacy-migration", "arcaea-current", version);
}

/**
 * Reuses the old project's tested Arcaea selector, metadata files and naming
 * rules by running it against an empty old source.  The returned result keeps
 * only current APK non-jacket candidates for first migration; jacket output
 * is counted for diagnostics but never becomes the Legacy jacket source.
 */
export async function extractArcaeaCurrentAssets(options: {
  apkDirectoryOrPath: string;
  extractorRoot: string;
  runtimeRoot?: string;
}): Promise<ArcaeaCurrentSnapshot | undefined> {
  const apk = await findCurrentArcaeaApk(options.apkDirectoryOrPath);
  if (!apk) return undefined;
  const extractorRoot = path.resolve(options.extractorRoot);
  const scriptPath = path.join(extractorRoot, "scripts", "extract-arcaea-update.ts");
  const runtimeRoot = path.resolve(options.runtimeRoot ?? ".runtime");
  const outputDir = currentSnapshotOutput(runtimeRoot, apk);
  await mkdir(runtimeRoot, { recursive: true });
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const emptyOldRoot = await mkdtemp(path.join(runtimeRoot, ".arcaea-current-empty-"));
  try {
    await mkdir(path.join(emptyOldRoot, "assets"), { recursive: true });
    const tsx = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "node_modules", "tsx", "dist", "cli.mjs");
    // The old script resolves its temporary extraction workspace from cwd.
    // Run it from V2 runtime so the legacy project remains untouched.
    const execution = await runProcess(process.execPath, [tsx, scriptPath, "--new", apk.absolutePath, "--old", emptyOldRoot, "--out", outputDir], runtimeRoot);
    if (execution.code !== 0) {
      const detail = `${execution.stdout}\n${execution.stderr}`.trim().slice(-4000);
      throw new Error(`Arcaea current snapshot extraction failed.${detail ? ` ${detail}` : ""}`);
    }
    const reportPath = await normalizeExtractorCollisions({
      reportPath: path.join(outputDir, "arcaea-update-report.json"),
      outputDir,
      apk,
      runtimeRoot,
    });
    const baseApk = apkRecord("base", apk);
    const targetApk = apkRecord("target", apk);
    const adapted = await adaptArcaeaLegacyReport({
      reportPath,
      baseVersion: apk.version,
      targetVersion: apk.version,
      baseApk,
      targetApk,
      sourceSnapshot: `arcaea-current:${apk.filename}:${apk.sizeBytes}:${apk.modifiedAt}`,
    });
    const jacketCount = adapted.candidates.filter((candidate) => candidate.suggestedCategory === "jacket").length;
    const candidates = adapted.candidates.filter((candidate) => candidate.suggestedCategory !== "jacket");
    const result = ExtractorResult.parse({ ...adapted, candidates });
    return { apk, outputDir, result, jacketCount, nonJacketCount: candidates.length };
  } finally {
    await rm(emptyOldRoot, { recursive: true, force: true });
  }
}

export function currentSnapshotFile(candidate: ExtractorCandidate, apk: ArcaeaApkDescriptor) {
  return {
    absolutePath: candidate.sourcePath,
    sourceRelativePath: `Arcaea/current-apk/${candidate.sourceRelativePath}`,
    sourceFilename: candidate.sourceFilename,
    sourceVersion: apk.version,
    source: "current-apk" as const,
    game: "arcaea" as const,
    resourceType: candidate.suggestedCategory,
    category: candidate.suggestedCategory,
    renditionType: "original" as const,
    evidence: [
      `current Arcaea APK: ${apk.filename}`,
      `APK relative path: ${candidate.sourceRelativePath}`,
      ...candidate.evidence.map((item) => `${item.kind}: ${item.detail}`),
    ],
  };
}

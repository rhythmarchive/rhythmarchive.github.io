import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson } from "../packages/domain/src/catalog.js";
import { getGameProfile, type PlatformGameId } from "../packages/domain/src/platform.js";
import { manifestFromExternalManifest } from "../packages/domain/src/external-manifest.js";
import { writeUnifiedManifest } from "../packages/domain/src/release.js";
function tempOnly(repoRoot: string, value: string, label: string): string {
  const resolved = path.resolve(value);
  const relative = path.relative(path.resolve(repoRoot, "temp"), resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(label + " must be inside repository temp/");
  return resolved;
}


const execFileAsync = promisify(execFile);

export type ExternalExtractionResult = {
  status: "OK" | "BLOCKED";
  game: PlatformGameId;
  outputDir: string;
  adapterReport: string;
  unifiedPath: string;
  message?: string;
  stdoutTail?: string;
  stderrTail?: string;
};

export async function runExternalAdapter(options: {
  game: "rizline" | "infalsus" | "rotaeno";
  version: string;
  repoRoot: string;
  outputDir: string;
  apk?: string;
  cacheRoot?: string;
  selection?: string;
  gameRoot?: string;
  previousManifest?: string;
  sourceSnapshot?: string;
  python?: string;
}): Promise<ExternalExtractionResult> {
  const outputDir = tempOnly(options.repoRoot, options.outputDir, "adapter output");
  const cacheRoot = tempOnly(options.repoRoot, options.cacheRoot ?? path.join(outputDir, "cache"), "cache output");
  await mkdir(outputDir, { recursive: true });
  const python = options.python?.trim() || "python";
  const commandArgs = options.game === "rizline"
    ? ["-m", "tools.rizline", "extract", "--apk", path.resolve(options.apk ?? ""), "--cache-root", cacheRoot, "--output", outputDir, "--dry-run"]
    : options.game === "rotaeno"
      ? ["-m", "tools.rotaeno", "extract-images", "--apk", path.resolve(options.apk ?? ""), "--selection", path.resolve(options.selection ?? ""), "--out", outputDir]
      : ["-m", "tools.infalsus", "prepare-publish", "--game-root", path.resolve(options.gameRoot ?? ""), "--output", outputDir, ...(options.previousManifest ? ["--previous-manifest", path.resolve(options.previousManifest)] : [])];
  const adapterReport = path.join(outputDir, options.game === "rizline" ? "manifest.json" : options.game === "rotaeno" ? "rotaeno-image-manifest.json" : "manifests/infalsus-semantic-manifest.json");
  const unifiedPath = path.join(outputDir, "unified-manifest.json");
  try {
    const result = await execFileAsync(python, commandArgs, { cwd: options.repoRoot, maxBuffer: 20 * 1024 * 1024 });
    try {
      const external = JSON.parse(await (await import("node:fs/promises")).readFile(adapterReport, "utf8")) as unknown;
      const unified = manifestFromExternalManifest(external, { gameId: options.game, version: options.version, ...(options.sourceSnapshot ? { sourceSnapshot: options.sourceSnapshot } : {}) });
      await writeUnifiedManifest(unified, unifiedPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await atomicWriteJson(path.join(outputDir, "normalization-error.json"), { message, adapterReport });
      return { status: "BLOCKED", game: options.game, outputDir, adapterReport, unifiedPath, message: `normalization failed: ${message}`, stdoutTail: result.stdout.slice(-2000), stderrTail: result.stderr.slice(-2000) };
    }
    return { status: "OK", game: options.game, outputDir, adapterReport, unifiedPath, stdoutTail: result.stdout.slice(-2000), stderrTail: result.stderr.slice(-2000) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await atomicWriteJson(path.join(outputDir, "adapter-error.json"), { game: options.game, command: [python, ...commandArgs], message, status: "blocked", entrypoints: getGameProfile(options.game).extractorEntrypoints });
    return { status: "BLOCKED", game: options.game, outputDir, adapterReport, unifiedPath, message };
  }
}

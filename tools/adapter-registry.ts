import { mkdir } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson } from "../packages/domain/src/catalog.js";
import {
  adaptArcaeaLegacyReport,
  adaptPhigrosLegacyReport,
  createWorkspaceFromExtractorResult,
  type ExtractorApk,
} from "../packages/domain/src/extractors.js";
import { GAME_PROFILES, getGameAdapter, type PlatformGameId } from "../packages/domain/src/platform.js";
import { manifestFromExtractorResult } from "../packages/domain/src/release.js";
import { writeUnifiedManifest } from "../packages/domain/src/release.js";
import { runExternalAdapter } from "./rhythmctl-external.js";

export type RegisteredExtractionOptions = {
  game: PlatformGameId;
  version: string;
  repoRoot: string;
  outputDir: string;
  reportPath?: string;
  baseVersion?: string;
  targetVersion?: string;
  baseApk?: ExtractorApk;
  targetApk?: ExtractorApk;
  sourceSnapshot?: string;
  workspacePath?: string;
  apk?: string;
  cacheRoot?: string;
  gameRoot?: string;
  previousManifest?: string;
};

export type RegisteredExtractionResult = {
  status: "OK" | "BLOCKED";
  game: PlatformGameId;
  adapterId: string;
  outputDir: string;
  resultPath?: string;
  manifestPath?: string;
  workspaceRoot?: string;
  adapterReport?: string;
  candidateCount?: number;
  diagnostics: string[];
  message?: string;
};

type AdapterHandler = (options: RegisteredExtractionOptions) => Promise<RegisteredExtractionResult>;

async function runLegacyReport(options: RegisteredExtractionOptions, adapterId: string): Promise<RegisteredExtractionResult> {
  if (!options.reportPath || !options.baseVersion || !options.targetVersion || !options.baseApk || !options.targetApk) {
    throw new Error(`adapter ${adapterId} requires --report, --base-version, --target-version, --base-apk, and --target-apk`);
  }
  const result = options.game === "arcaea"
    ? await adaptArcaeaLegacyReport({
        reportPath: path.resolve(options.reportPath),
        baseVersion: options.baseVersion,
        targetVersion: options.targetVersion,
        baseApk: options.baseApk,
        targetApk: options.targetApk,
        ...(options.sourceSnapshot ? { sourceSnapshot: options.sourceSnapshot } : {}),
      })
    : await adaptPhigrosLegacyReport({
        reportPath: path.resolve(options.reportPath),
        baseVersion: options.baseVersion,
        targetVersion: options.targetVersion,
        baseApk: options.baseApk,
        targetApk: options.targetApk,
        ...(options.sourceSnapshot ? { sourceSnapshot: options.sourceSnapshot } : {}),
      });
  const outputDir = path.resolve(options.outputDir);
  await mkdir(outputDir, { recursive: true });
  const resultPath = path.join(outputDir, "extractor-result.json");
  await atomicWriteJson(resultPath, result);
  const workspacePath = path.resolve(options.workspacePath ?? path.join(outputDir, "workspace"));
  const workspace = result.status === "failed" ? undefined : await createWorkspaceFromExtractorResult(result, { rootPath: workspacePath });
  const manifest = await manifestFromExtractorResult(result);
  const manifestPath = path.join(outputDir, "candidate-manifest.json");
  await writeUnifiedManifest(manifest, manifestPath);
  return {
    status: result.status === "ok" ? "OK" : "BLOCKED",
    game: options.game,
    adapterId,
    outputDir,
    resultPath,
    manifestPath,
    ...(workspace ? { workspaceRoot: workspace.rootPath } : {}),
    candidateCount: result.candidates.length,
    diagnostics: result.diagnostics.map((item) => `${item.code}: ${item.message}`),
  };
}

async function runRizline(options: RegisteredExtractionOptions): Promise<RegisteredExtractionResult> {
  if (!options.apk) throw new Error("adapter rizline-remote requires --apk");
  const result = await runExternalAdapter({
    game: "rizline",
    version: options.version,
    repoRoot: options.repoRoot,
    outputDir: options.outputDir,
    apk: options.apk,
    ...(options.cacheRoot ? { cacheRoot: options.cacheRoot } : {}),
    ...(options.previousManifest ? { previousManifest: options.previousManifest } : {}),
  });
  return {
    status: result.status,
    game: options.game,
    adapterId: "rizline-remote",
    outputDir: result.outputDir,
    adapterReport: result.adapterReport,
    manifestPath: result.unifiedPath,
    diagnostics: result.message ? [result.message] : [],
    ...(result.message ? { message: result.message } : {}),
  };
}

async function runInFalsus(options: RegisteredExtractionOptions): Promise<RegisteredExtractionResult> {
  if (!options.gameRoot) throw new Error("adapter infalsus-addressables requires --game-root");
  const result = await runExternalAdapter({
    game: "infalsus",
    version: options.version,
    repoRoot: options.repoRoot,
    outputDir: options.outputDir,
    gameRoot: options.gameRoot,
    ...(options.previousManifest ? { previousManifest: options.previousManifest } : {}),
  });
  return {
    status: result.status,
    game: options.game,
    adapterId: "infalsus-addressables",
    outputDir: result.outputDir,
    adapterReport: result.adapterReport,
    manifestPath: result.unifiedPath,
    diagnostics: result.message ? [result.message] : [],
    ...(result.message ? { message: result.message } : {}),
  };
}

const ADAPTER_HANDLERS: Readonly<Record<string, AdapterHandler>> = Object.freeze({
  "arcaea-apk": (options) => runLegacyReport(options, "arcaea-apk"),
  "phigros-apk": (options) => runLegacyReport(options, "phigros-apk"),
  "rizline-remote": runRizline,
  "infalsus-addressables": runInFalsus,
});

export function listRegisteredAdapters(): Array<{ adapterId: string; games: PlatformGameId[]; capabilities: string[] }> {
  const byAdapter = new Map<string, PlatformGameId[]>();
  for (const game of Object.keys(GAME_PROFILES) as PlatformGameId[]) {
    const adapter = getGameAdapter(game);
    byAdapter.set(adapter.profile.adapterId, [...(byAdapter.get(adapter.profile.adapterId) ?? []), game]);
  }
  return [...byAdapter.entries()].map(([adapterId, games]) => ({
    adapterId,
    games,
    capabilities: getGameAdapter(games[0]!).capabilities,
  }));
}

export async function runRegisteredExtraction(options: RegisteredExtractionOptions): Promise<RegisteredExtractionResult> {
  const adapter = getGameAdapter(options.game);
  const handler = ADAPTER_HANDLERS[adapter.profile.adapterId];
  if (!handler) throw new Error(`no registered extraction handler for adapter ${adapter.profile.adapterId}`);
  const result = await handler(options);
  if (result.adapterId !== adapter.profile.adapterId) throw new Error(`adapter registry returned ${result.adapterId} for ${adapter.profile.adapterId}`);
  return result;
}

export function adapterContractFor(game: PlatformGameId): { game: PlatformGameId; adapterId: string; version: string; capabilities: string[]; operations: Record<string, string>; entrypoints: string[] } {
  const adapter = getGameAdapter(game);
  return {
    game,
    adapterId: adapter.profile.adapterId,
    version: adapter.profile.adapterVersion,
    capabilities: adapter.capabilities,
    operations: adapter.operationEntrypoints,
    entrypoints: adapter.profile.extractorEntrypoints,
  };
}

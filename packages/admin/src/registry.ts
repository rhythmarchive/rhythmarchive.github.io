import {
  adaptArcaeaLegacyReport,
  adaptPhigrosLegacyReport,
  type ExtractorApk,
  type ExtractorResult,
} from "../../domain/src/index.js";

export type GameId = "arcaea" | "phigros";

export type AdapterOptions = {
  reportPath: string;
  baseVersion: string;
  targetVersion: string;
  baseApk: ExtractorApk;
  targetApk: ExtractorApk;
  sourceSnapshot?: string;
};

export type AdapterRunner = (options: AdapterOptions) => Promise<ExtractorResult>;

export type GameCapabilities = {
  quickConfirm: boolean;
  metadataOverride: boolean;
  filenameOverride: boolean;
  upscale: boolean;
  publishDryRun: boolean;
};

export type GameConfig = {
  id: GameId;
  name: string;
  adapter: "arcaea-legacy-report" | "phigros-legacy-report";
  adapterRunner: AdapterRunner;
  extractor: {
    runner: "tsx" | "python";
    script: string;
    reportFilename: string;
    includeApkDir: boolean;
  };
  capabilities: GameCapabilities;
};

export const GAME_REGISTRY: readonly GameConfig[] = [
  {
    id: "arcaea",
    name: "Arcaea",
    adapter: "arcaea-legacy-report",
    adapterRunner: adaptArcaeaLegacyReport,
    extractor: { runner: "tsx", script: "scripts/extract-arcaea-update.ts", reportFilename: "arcaea-update-report.json", includeApkDir: false },
    capabilities: { quickConfirm: true, metadataOverride: true, filenameOverride: true, upscale: true, publishDryRun: true },
  },
  {
    id: "phigros",
    name: "Phigros",
    adapter: "phigros-legacy-report",
    adapterRunner: adaptPhigrosLegacyReport,
    extractor: { runner: "python", script: "scripts/extract-phigros-update.py", reportFilename: "phigros-update-report.json", includeApkDir: true },
    capabilities: { quickConfirm: false, metadataOverride: true, filenameOverride: true, upscale: true, publishDryRun: true },
  },
];

export function publicGameConfigs(): Array<Omit<GameConfig, "adapterRunner">> {
  return GAME_REGISTRY.map(({ adapterRunner: _adapterRunner, ...config }) => config);
}

export function gameConfig(game: string): GameConfig {
  const config = GAME_REGISTRY.find((item) => item.id === game);
  if (!config) throw new Error(`unknown game: ${game}`);
  return config;
}

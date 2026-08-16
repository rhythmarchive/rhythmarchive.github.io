import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_CATALOG_PATH, DEFAULT_LEGACY_ASSET_ROOT } from "../../domain/src/index.js";

export type AdminConfig = {
  arcaeaApkDir: string;
  phigrosApkDir: string;
  workspaceRuntimePath: string;
  legacyAssetRoot: string;
  legacyExtractorRoot: string;
  catalogPath: string;
  realEsrganExecutable: string;
  realEsrganModelDir: string;
  realEsrganModelName: string;
};

export const DEFAULT_ADMIN_CONFIG_PATH = path.resolve(".runtime", "admin-config.json");

function optionalDirectory(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) return "";
  return path.resolve(value.trim());
}

function requiredDirectory(value: unknown): string {
  const normalized = optionalDirectory(value);
  return normalized || path.resolve(".runtime", "updates");
}

function optionalFile(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) return "";
  return path.resolve(value.trim());
}

export function defaultAdminConfig(): AdminConfig {
  const configured: Partial<AdminConfig> = {};
  if (process.env.ARCAEA_APK_DIR) configured.arcaeaApkDir = process.env.ARCAEA_APK_DIR;
  if (process.env.PHIGROS_APK_DIR) configured.phigrosApkDir = process.env.PHIGROS_APK_DIR;
  if (process.env.WORKSPACE_RUNTIME_PATH) configured.workspaceRuntimePath = process.env.WORKSPACE_RUNTIME_PATH;
  if (process.env.LEGACY_ASSET_ROOT) configured.legacyAssetRoot = process.env.LEGACY_ASSET_ROOT;
  if (process.env.LEGACY_PROJECT_ROOT) configured.legacyExtractorRoot = process.env.LEGACY_PROJECT_ROOT;
  if (process.env.CATALOG_PATH) configured.catalogPath = process.env.CATALOG_PATH;
  if (process.env.REAL_ESRGAN_EXECUTABLE) configured.realEsrganExecutable = process.env.REAL_ESRGAN_EXECUTABLE;
  if (process.env.REAL_ESRGAN_MODEL_DIR) configured.realEsrganModelDir = process.env.REAL_ESRGAN_MODEL_DIR;
  if (process.env.REAL_ESRGAN_MODEL) configured.realEsrganModelName = process.env.REAL_ESRGAN_MODEL;
  return normalizeAdminConfig(configured);
}

export function normalizeAdminConfig(value: Partial<AdminConfig>): AdminConfig {
  return {
    arcaeaApkDir: optionalDirectory(value.arcaeaApkDir),
    phigrosApkDir: optionalDirectory(value.phigrosApkDir),
    workspaceRuntimePath: requiredDirectory(value.workspaceRuntimePath),
    legacyAssetRoot: optionalDirectory(value.legacyAssetRoot) || DEFAULT_LEGACY_ASSET_ROOT,
    legacyExtractorRoot: optionalDirectory(value.legacyExtractorRoot),
    catalogPath: optionalFile(value.catalogPath) || DEFAULT_CATALOG_PATH,
    realEsrganExecutable: optionalFile(value.realEsrganExecutable),
    realEsrganModelDir: optionalDirectory(value.realEsrganModelDir),
    realEsrganModelName: typeof value.realEsrganModelName === "string" && value.realEsrganModelName.trim() ? value.realEsrganModelName.trim() : "realesrgan-x4plus-anime",
  };
}

export async function loadAdminConfig(configPath = DEFAULT_ADMIN_CONFIG_PATH): Promise<AdminConfig> {
  try {
    const parsed = JSON.parse(await readFile(configPath, "utf8")) as Partial<AdminConfig>;
    return normalizeAdminConfig(parsed);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return defaultAdminConfig();
    }
    throw error;
  }
}

export async function saveAdminConfig(config: AdminConfig, configPath = DEFAULT_ADMIN_CONFIG_PATH): Promise<AdminConfig> {
  const normalized = normalizeAdminConfig(config);
  await mkdir(path.dirname(configPath), { recursive: true });
  const temporaryPath = `${configPath}.partial-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  await rename(temporaryPath, configPath);
  return normalized;
}

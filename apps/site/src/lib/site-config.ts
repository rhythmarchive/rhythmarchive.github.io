const runtimeEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? (typeof process === "undefined" ? {} : process.env);

export const SITE_ORIGIN = stripTrailingSlash(runtimeEnv.PUBLIC_SITE_ORIGIN || "https://rhythmarchive.github.io");
export const BASE_PATH = normalizeBasePath(runtimeEnv.PUBLIC_BASE_PATH || "/");
export const ROS_BASE_URL = stripTrailingSlash(runtimeEnv.PUBLIC_ROS_BASE_URL || "https://rhythm-assets.cn-nb1.rains3.com");

export function normalizeBasePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") return "/";
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return `${withLeadingSlash.replace(/\/+$/u, "")}/`;
}

export function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

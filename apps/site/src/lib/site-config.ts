const runtimeEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? (typeof process === "undefined" ? {} : process.env);

export const SITE_ORIGIN = stripTrailingSlash(runtimeEnv.PUBLIC_SITE_ORIGIN || "https://rhythmarchive.github.io");
export const BASE_PATH = normalizeBasePath(runtimeEnv.PUBLIC_BASE_PATH || "/");
export const ROS_BASE_URL = stripTrailingSlash(runtimeEnv.PUBLIC_ROS_BASE_URL || "https://rhythm-assets.cn-nb1.rains3.com");
export const PUBLIC_STATS_API_URL = optionalUrl(runtimeEnv.PUBLIC_STATS_API_URL);

export const BILIBILI_URL = "https://space.bilibili.com/385607044";
export const GITHUB_DISCUSSIONS_URL = "https://github.com/rhythmarchive/rhythmarchive.github.io/discussions";
export const GITHUB_FEEDBACK_CATEGORY_URL = "https://github.com/rhythmarchive/rhythmarchive.github.io/discussions/categories/问题反馈-提出建议";

export const GISCUS_CONFIG = {
  repo: "rhythmarchive/rhythmarchive.github.io",
  repoId: "R_kgDOT4hyIQ",
  category: "问题反馈 & 提出建议",
  categoryId: "DIC_kwDOT4hyIc4DDbnK",
  mapping: "pathname",
  strict: "0",
  reactionsEnabled: "1",
  emitMetadata: "0",
  inputPosition: "top",
  lang: "zh-CN",
  theme: "preferred_color_scheme",
} as const;

export function normalizeBasePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") return "/";
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return `${withLeadingSlash.replace(/\/+$/u, "")}/`;
}

export function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function optionalUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? stripTrailingSlash(trimmed) : undefined;
}

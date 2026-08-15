import { defineConfig } from "astro/config";

const basePath = normalizeBasePath(process.env.PUBLIC_BASE_PATH ?? "/");

export default defineConfig({
  output: "static",
  site: process.env.PUBLIC_SITE_ORIGIN ?? "https://rhythmarchive.github.io",
  base: basePath,
  build: {
    format: "directory",
  },
  compressHTML: true,
});

function normalizeBasePath(value) {
  const trimmed = String(value).trim();
  if (!trimmed || trimmed === "/") return "/";
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return `${withLeadingSlash.replace(/\/+$/u, "")}/`;
}

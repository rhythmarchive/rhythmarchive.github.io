import fs from "node:fs";
import path from "node:path";
import { findWorkspaceRoot, loadFormalCatalog } from "../src/lib/site-data.js";
import { projectCatalog } from "../src/lib/catalog-projection.js";

const root = findWorkspaceRoot();
const dist = path.join(root, "apps", "site", "dist");
if (!fs.existsSync(dist)) throw new Error("apps/site/dist does not exist; run npm run site:build first.");

const catalog = loadFormalCatalog();
const projection = projectCatalog(catalog, process.env.PUBLIC_ROS_BASE_URL?.trim() || "https://rhythm-assets.cn-nb1.rains3.com");
const files = listFiles(dist);
const htmlFiles = files.filter((file) => file.toLowerCase().endsWith(".html"));
const required = [
  "index.html",
  "404.html",
  "arcaea/index.html",
  "phigros/index.html",
  "rizline/index.html",
  "infalsus/index.html",
  "search/index.html",
  "feedback/index.html",
  "arcaea/jacket/index.html",
  "phigros/jacket/index.html",
  "rizline/jacket/index.html",
  "infalsus/jacket/index.html",
  "robots.txt",
  "sitemap.xml",
  "data/search-index.json",
];
const missing = required.filter((file) => !files.includes(file));
if (missing.length > 0) throw new Error("Missing required dist files: " + missing.join(", "));

const detailFiles = htmlFiles.filter((file) => /^r\/[^/]+\/index\.html$/u.test(file));
if (detailFiles.length !== projection.resources.length) throw new Error("Expected " + projection.resources.length + " detail pages, found " + detailFiles.length + ".");
for (const resource of projection.resources) {
  const expected = "r/" + resource.resourceId + "/index.html";
  if (!files.includes(expected)) throw new Error("Missing detail route: " + expected);
}

const previewUrls = new Set<string>();
for (const resource of projection.resources) {
  for (const variant of resource.variants) {
    for (const preview of Object.values(variant.preview)) if (preview) previewUrls.add(preview.url);
  }
}
const forbidden = [/E:\\/iu, /D:\\/iu, /ROS_ACCESS_KEY/iu, /ROS_SECRET_KEY/iu, /\.runtime/iu, /ReviewLog/iu, /migration report/iu, /sourceRelativePath/iu, /sourceSha256/iu, /objectId/iu, /objectKey/iu, /catalogSchemaVersion/iu, /accessKey/iu, /secretKey/iu, /(?:^|[\\/])workspace(?:[\\/]|$)/iu];
const forbiddenHits: string[] = [];
for (const file of files) {
  const text = fs.readFileSync(path.join(dist, file), "utf8");
  for (const pattern of forbidden) if (pattern.test(text)) forbiddenHits.push(file + ": " + pattern);
}
if (forbiddenHits.length > 0) throw new Error("Forbidden internal data found in dist:\n" + forbiddenHits.slice(0, 12).join("\n"));

const ordinaryImageErrors: string[] = [];
for (const file of htmlFiles) {
  const html = fs.readFileSync(path.join(dist, file), "utf8");
  for (const tag of html.match(/<img\b[^>]*>/giu) ?? []) {
    for (const source of [...tag.matchAll(/(?:src|srcset)="([^"]+)"/giu)].map((match) => match[1] ?? "")) {
      const candidates = source.split(",").map((part) => part.trim().split(/\s+/u)[0]).filter((candidate): candidate is string => Boolean(candidate));
      for (const candidate of candidates) {
        if (/^https?:\/\//iu.test(candidate) && !previewUrls.has(candidate)) ordinaryImageErrors.push(file + ": " + candidate);
      }
    }
  }
}
if (ordinaryImageErrors.length > 0) throw new Error("An ordinary <img> points outside the public preview set:\n" + ordinaryImageErrors.slice(0, 12).join("\n"));

const homeHtml = fs.readFileSync(path.join(dist, "index.html"), "utf8");
if (/<(?:script|link)\b[^>]+(?:src|href)="[^"]*search-index\.json/iu.test(homeHtml)) throw new Error("Home HTML eagerly references search-index.json.");

const searchIndex = JSON.parse(fs.readFileSync(path.join(dist, "data", "search-index.json"), "utf8")) as unknown;
if (!Array.isArray(searchIndex) || searchIndex.length !== projection.searchIndex.length) throw new Error("Search index is missing or has the wrong entry count.");
const sizeBytes = files.reduce((sum, file) => sum + fs.statSync(path.join(dist, file)).size, 0);
const html = htmlFiles.map((file) => fs.readFileSync(path.join(dist, file), "utf8")).join("\n");
console.log(JSON.stringify({ status: "PASS", htmlPageCount: htmlFiles.length, resourceDetailCount: detailFiles.length, distFileCount: files.length, distSizeBytes: sizeBytes, searchEntries: searchIndex.length, ordinaryImageCount: html.match(/<img\b/giu)?.length ?? 0 }, null, 2));

function listFiles(directory: string, prefix = ""): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? prefix + "/" + entry.name : entry.name;
    return entry.isDirectory() ? listFiles(path.join(directory, entry.name), relative) : [relative];
  });
}

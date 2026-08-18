import assert from "node:assert/strict";
import test from "node:test";
import { projectCatalog, selectPreviewRendition } from "../src/lib/catalog-projection.js";
import { formatPublicApkBytes, parsePublicArcaeaApkManifest } from "../src/lib/apk.js";
import { uniqueZipFilename } from "../src/lib/batch.js";
import { displayVariantLabel } from "../src/lib/game-config.js";
import { GISCUS_CONFIG, GITHUB_DISCUSSIONS_URL } from "../src/lib/site-config.js";
import { rankSearchEntries } from "../src/lib/search.js";
import { createUrlHelpers } from "../src/lib/url.js";
import { loadFormalCatalog } from "../src/lib/site-data.js";
import type { PublicSearchEntry } from "../src/lib/types.js";

const catalog = loadFormalCatalog();
const rosBaseUrl = "https://rhythm-assets.cn-nb1.rains3.com";

test("public projection excludes local paths, credentials, and internal provenance", () => {
  const projection = projectCatalog(catalog, rosBaseUrl);
  const serialized = JSON.stringify(projection);
  assert.doesNotMatch(serialized, /[A-Z]:\\/iu);
  assert.doesNotMatch(serialized, /ROS_(?:ACCESS|SECRET)_KEY/iu);
  assert.doesNotMatch(serialized, /(?:provenance|sourceRelativePath|sourceSha256|objectId|objectKey|catalogSchemaVersion)/iu);
  assert.equal(projection.resources.length, catalog.resources.length);
});

test("all Resources have unique stable detail routes", () => {
  const projection = projectCatalog(catalog, rosBaseUrl);
  const routes = projection.resources.map((resource) => resource.route);
  assert.equal(new Set(routes).size, catalog.resources.length);
  assert.ok(routes.every((route) => /^\/r\/[0-9a-f-]+\/$/iu.test(route)));
});

test("preview selection never falls back to original or upscaled", () => {
  const original = { renditionType: "original" } as never;
  const upscaled = { renditionType: "upscaled" } as never;
  assert.equal(selectPreviewRendition([original, upscaled], "large"), undefined);
});

test("every catalog Resource shares one preview set across original and optional upscale", () => {
  const projection = projectCatalog(catalog, rosBaseUrl);
  const upscaled = projection.resources.filter((resource) => resource.upscaled);
  assert.equal(upscaled.length, 603);
  assert.ok(upscaled.every((resource) => resource.game === "arcaea" && resource.resourceType === "jacket"));
  assert.ok(upscaled.every((resource) => resource.variants.every((variant) => Boolean(variant.preview.small) && Boolean(variant.preview.medium) && Boolean(variant.preview.large))));
});

test("Arcaea public titles use the real title segment and keep extraction markers out of SEO/search text", () => {
  const projection = projectCatalog(catalog, rosBaseUrl);
  const arcaeaResources = projection.resources.filter((resource) => resource.game === "arcaea");
  assert.ok(arcaeaResources.every((resource) => !/(?:_IDX|_BPM|_SIDE|\.(?:jpe?g|png|webp)|_optimization)/iu.test(resource.displayTitle)));
  const sample = projection.resources.find((resource) => resource.resourceId === "01a00090-2a2d-70ad-8998-bf48655bc664");
  assert.equal(sample?.displayTitle, "［筏］は云う。幾ら漂流すれど不撓の心さえ有れば軈て行到ると。");
  assert.equal(sample?.artist, "庭師");
});

test("upscaled resources expose the optional upscale download and non-upscaled resources do not", () => {
  const projection = projectCatalog(catalog, rosBaseUrl);
  assert.ok(projection.resources.filter((resource) => !resource.upscaled).every((resource) => !resource.variants.some((variant) => variant.upscaled)));
  assert.ok(projection.resources.filter((resource) => resource.game === "phigros").every((resource) => !resource.upscaled));
});

test("formal Giscus config is centralized and has a public Discussions fallback URL", () => {
  assert.equal(GISCUS_CONFIG.repo, "rhythmarchive/rhythmarchive.github.io");
  assert.equal(GISCUS_CONFIG.repoId, "R_kgDOT4hyIQ");
  assert.equal(GISCUS_CONFIG.categoryId, "DIC_kwDOT4hyIc4DDbnK");
  assert.match(GITHUB_DISCUSSIONS_URL, /github\.com\/rhythmarchive\/rhythmarchive\.github\.io\/discussions/u);
});

test("unresolved variants never render as a difficulty", () => {
  assert.equal(displayVariantLabel({ variantKey: "default", semanticStatus: "unresolved" }), "其他版本");
  assert.equal(displayVariantLabel({ variantKey: "_256", semanticStatus: "resolved" }), "其他版本");
  assert.equal(displayVariantLabel({ variantKey: "default", semanticStatus: "resolved" }), "默认");
});

test("download filenames are preserved from Catalog Renditions", () => {
  const projection = projectCatalog(catalog, rosBaseUrl);
  const source = catalog.renditions.find((rendition) => rendition.renditionType === "original");
  const resource = projection.resources.find((item) => item.original?.downloadFilename === source?.downloadFilename);
  assert.ok(resource);
  assert.equal(resource.original?.downloadFilename, source?.downloadFilename);
});

test("search ranks exact title before prefix, substring, artist, and keywords", () => {
  const entries: PublicSearchEntry[] = [
    { resourceId: "1", route: "/r/1/", title: "Test", game: "arcaea", category: "jacket", categoryLabel: "曲绘", keywords: [] },
    { resourceId: "2", route: "/r/2/", title: "Test Song", game: "arcaea", category: "jacket", categoryLabel: "曲绘", keywords: [] },
    { resourceId: "3", route: "/r/3/", title: "A Song", game: "arcaea", category: "jacket", categoryLabel: "曲绘", artist: "Test", keywords: [] },
  ];
  assert.deepEqual(rankSearchEntries(entries, "Test").map((entry) => entry.resourceId), ["1", "2", "3"]);
  assert.deepEqual(rankSearchEntries(entries, "").length, 0);
});

test("base path and object URL helpers support Organization Pages and project paths", () => {
  const urls = createUrlHelpers({ basePath: "/", origin: "https://rhythmarchive.github.io", rosBaseUrl });
  assert.equal(urls.sitePath("/arcaea/"), "/arcaea/");
  assert.equal(urls.absoluteUrl("/"), "https://rhythmarchive.github.io/");
  assert.equal(urls.objectUrl("objects/abc/image.jpg"), `${rosBaseUrl}/objects/abc/image.jpg`);
  const projectUrls = createUrlHelpers({ basePath: "/archive/", origin: "https://example.test", rosBaseUrl });
  assert.equal(projectUrls.sitePath("/r/id/"), "/archive/r/id/");
});

test("ZIP duplicate naming uses human-safe numbered suffixes", () => {
  const used = new Set<string>();
  const names = ["name.jpg", "name.jpg", "name.jpg", "name (2).jpg", "bad/name.jpg"].map((name) => uniqueZipFilename(used, name));
  assert.deepEqual(names, ["name.jpg", "name (2).jpg", "name (3).jpg", "name (2) (2).jpg", "bad_name.jpg"]);
});

test("homepage APK parser accepts latest/previous and rejects source URLs or malformed entries", () => {
  const entry = (version: string) => ({
    version,
    versionCode: null,
    fileName: `Arcaea_${version}.apk`,
    fileSize: 1234,
    sha256: "a".repeat(64),
    url: `${rosBaseUrl}/apk/arcaea/releases/${version}/Arcaea_${version}.apk`,
    publishedAt: "2026-08-15T00:00:00Z",
  });
  assert.equal(parsePublicArcaeaApkManifest(undefined), null);
  const parsed = parsePublicArcaeaApkManifest({ schemaVersion: 1, game: "arcaea", generatedAt: "2026-08-15T00:00:00Z", latest: entry("6.17.1"), previous: entry("6.17.0") });
  assert.equal(parsed?.latest.version, "6.17.1");
  assert.equal(parsed?.previous?.version, "6.17.0");
  assert.equal(parsePublicArcaeaApkManifest({ schemaVersion: 1, game: "arcaea", generatedAt: "now", latest: { ...entry("6.17.1"), url: "https://arcaea-static.lowiro-cdn.net/arcaea.apk" }, previous: null }), null);
  assert.equal(parsePublicArcaeaApkManifest({ schemaVersion: 1, game: "arcaea", generatedAt: "now", latest: { ...entry("6.17.1"), url: "https://evil.example/apk/arcaea/releases/6.17.1/Arcaea_6.17.1.apk" }, previous: null }), null);
  assert.equal(formatPublicApkBytes(1234), "1.21 KB");
});

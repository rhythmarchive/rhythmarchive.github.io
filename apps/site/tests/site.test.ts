import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { projectCatalog, selectPreviewRendition } from "../src/lib/catalog-projection.js";
import { formatPublicApkBytes, parsePublicArcaeaApkManifest } from "../src/lib/apk.js";
import { uniqueZipFilename } from "../src/lib/batch.js";
import { displayVariantLabel } from "../src/lib/game-config.js";
import { rankRelatedResources } from "../src/lib/related.js";
import { buildSearchQuickLinks } from "../src/lib/search-quick-links.js";
import { getCategoryBrowseConfig } from "../src/lib/category-browse.js";
import { GISCUS_CONFIG, GITHUB_DISCUSSIONS_URL } from "../src/lib/site-config.js";
import { rankSearchEntries } from "../src/lib/search.js";
import { createUrlHelpers } from "../src/lib/url.js";
import { getSiteData, loadCategoryBrowseProjections, loadFormalCatalog } from "../src/lib/site-data.js";
import type { PublicResource, PublicSearchEntry } from "../src/lib/types.js";

const catalog = loadFormalCatalog();
const rosBaseUrl = "https://rhythm-assets.cn-nb1.rains3.com";
const siteRoot = path.resolve(process.cwd(), "apps", "site");

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
  assert.equal(upscaled.length, 616);
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

test("homepage APK parser accepts GitHub/official downloads and rejects unsafe URLs", () => {
  const entry = (version: string) => ({
    version,
    versionCode: null,
    fileName: `Arcaea_${version}.apk`,
    fileSize: 1234,
    sha256: "a".repeat(64),
    publishedAt: "2026-08-15T00:00:00Z",
    downloads: {
      github: `https://github.com/rhythmarchive/rhythmarchive.github.io/releases/download/arcaea-apk-${version}/Arcaea_${version}.apk`,
      official: `https://arcaea-static.lowiro-cdn.net/download?filename=arcaea_${version}.apk`,
    },
  });
  assert.equal(parsePublicArcaeaApkManifest(undefined), null);
  const parsed = parsePublicArcaeaApkManifest({ schemaVersion: 2, game: "arcaea", generatedAt: "2026-08-15T00:00:00Z", latest: entry("6.17.1"), previous: { ...entry("6.17.0"), downloads: { ...entry("6.17.0").downloads, official: null } } });
  assert.equal(parsed?.latest.version, "6.17.1");
  assert.equal(parsed?.previous?.version, "6.17.0");
  assert.equal(parsed?.previous?.downloads.official, null);
  const missingPreviousOfficial = { schemaVersion: 2, game: "arcaea", generatedAt: "now", latest: entry("6.17.1"), previous: { ...entry("6.17.0"), downloads: { github: entry("6.17.0").downloads.github } } };
  assert.equal(parsePublicArcaeaApkManifest(missingPreviousOfficial)?.previous?.downloads.official, null);
  assert.equal(parsePublicArcaeaApkManifest({ schemaVersion: 1, game: "arcaea", generatedAt: "now", latest: entry("6.17.1"), previous: null }), null);
  assert.equal(parsePublicArcaeaApkManifest({ schemaVersion: 2, game: "arcaea", generatedAt: "now", latest: { ...entry("6.17.1"), downloads: { ...entry("6.17.1").downloads, github: "https://evil.example/releases/download/arcaea-apk-6.17.1/Arcaea_6.17.1.apk" } }, previous: null }), null);
  assert.equal(parsePublicArcaeaApkManifest({ schemaVersion: 2, game: "arcaea", generatedAt: "now", latest: { ...entry("6.17.1"), downloads: { ...entry("6.17.1").downloads, official: "http://arcaea-static.lowiro-cdn.net/arcaea.apk" } }, previous: null }), null);
  assert.equal(formatPublicApkBytes(1234), "1.21 KB");
});

test("homepage uses an information-first intro and a stable social image", () => {
  const source = fs.readFileSync(path.join(siteRoot, "src", "pages", "index.astro"), "utf8");
  assert.doesNotMatch(source, /找到下一张|想保存的曲绘/u);
  assert.match(source, /Arcaea \/ Phigros/u);
  assert.match(source, /ogImage=\{homeOgImage\}/u);
  assert.match(source, /\/og\/home\.png/u);
  assert.equal(fs.existsSync(path.join(siteRoot, "public", "og", "home.png")), true);
  assert.doesNotMatch(source, /data\.resources\.find\(/u);
});

test("category semantic browse data keeps player-facing names and conservative unresolved labels", () => {
  const semantic = loadCategoryBrowseProjections();
  const siteData = getSiteData();
  const portraits = siteData.galleries["arcaea/character-portrait"] ?? [];
  const namedPortraits = portraits.filter((resource) => resource.displayTitle !== "未归类角色立绘");
  assert.equal(namedPortraits.length, 135);
  assert.equal(portraits.length, 139);
  assert.ok(namedPortraits.some((resource) => resource.displayTitle === "光"));
  assert.ok(portraits.every((resource) => !/^\d+_(?:angry|cut|twisted)/u.test(resource.displayTitle)));

  const story = siteData.galleries["arcaea/story-cg"] ?? [];
  const knownCg = story.find((resource) => resource.searchTerms?.includes("0-3"));
  assert.equal(knownCg?.displayTitle, "Arcaea");
  assert.match(knownCg?.subtitle ?? "", /Main Story/u);
  assert.ok((knownCg?.searchTerms ?? []).includes("Shades of Light in a Transcendent Realm"));
  assert.equal(semantic.arcaea.resources.filter((resource) => resource.resourceType === "story-cg").length, 57);
  assert.equal((siteData.galleries["arcaea/story-texture"] ?? []).length, 296);
  const phigrosKinds = getCategoryBrowseConfig("phigros", "pack-cover", siteData.galleries["phigros/pack-cover"] ?? []).facets[0]?.options.map((option) => option.label) ?? [];
  assert.ok(phigrosKinds.includes("主线") && phigrosKinds.includes("支线") && phigrosKinds.includes("单曲") && phigrosKinds.includes("其他曲包"));
});

test("site brand marks keep the accent rhythm line inside the mark", () => {
  const brandMark = fs.readFileSync(path.join(siteRoot, "public", "brand-mark.svg"), "utf8");
  const favicon = fs.readFileSync(path.join(siteRoot, "public", "favicon.svg"), "utf8");
  const styles = fs.readFileSync(path.join(siteRoot, "src", "styles", "global.css"), "utf8");
  assert.match(brandMark, /viewBox="0 0 40 32"/u);
  assert.match(favicon, /viewBox="0 0 32 32"/u);
  assert.match(brandMark, /<path d="M3 1h31l5 5v20l-5 5H3l-2-2V3Z"/u);
  assert.match(favicon, /<path d="M3 1h25l3 4v22l-3 4H3l-2-2V3Z"/u);
  assert.match(brandMark, /<path d="M7 25\.5h5/u);
  assert.match(favicon, /<path d="M7 25h4/u);
  assert.match(styles, /\.brand-mark img \{ width: 40px; height: 32px; \}/u);
});

test("game icons use real assets with a non-breaking fallback", () => {
  const source = fs.readFileSync(path.join(siteRoot, "src", "components", "GameIcon.astro"), "utf8");
  const styles = fs.readFileSync(path.join(siteRoot, "src", "styles", "global.css"), "utf8");
  assert.match(source, /game-icons\/\$\{name\}\.png/u);
  assert.match(source, /width="192" height="192"/u);
  assert.match(source, /game-icon-fallback/u);
  assert.match(source, /onerror=/u);
  assert.match(styles, /\.game-entry-image > \.game-icon \{ position: absolute; inset: 0;/u);
  assert.match(styles, /\.game-entry-image \.game-icon-image \{ inset: 0; width: 100%; height: 100%;[^}]*background: var\(--surface-muted\);/u);
  assert.equal(fs.existsSync(path.join(siteRoot, "public", "game-icons", "arcaea.png")), true);
  assert.equal(fs.existsSync(path.join(siteRoot, "public", "game-icons", "phigros.png")), true);
});

test("Arcaea icon does not retain the adaptive green edge", async () => {
  const icon = await sharp(path.join(siteRoot, "public", "game-icons", "arcaea.png")).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let greenEdgePixels = 0;
  for (let y = 0; y < icon.info.height; y += 1) {
    for (let x = 0; x < icon.info.width; x += 1) {
      const edge = Math.min(x, y, icon.info.width - 1 - x, icon.info.height - 1 - y);
      const offset = (y * icon.info.width + x) * icon.info.channels;
      const red = icon.data[offset] ?? 0;
      const green = icon.data[offset + 1] ?? 0;
      const blue = icon.data[offset + 2] ?? 0;
      const alpha = icon.data[offset + 3] ?? 0;
      if (edge <= 32 && alpha > 10 && green > red + 50 && blue > red + 30) greenEdgePixels += 1;
    }
  }
  assert.equal(greenEdgePixels, 0);
  const bottomCenterOffset = ((icon.info.height - 1) * icon.info.width + Math.floor(icon.info.width / 2)) * icon.info.channels;
  assert.ok((icon.data[bottomCenterOffset + 3] ?? 0) >= 200, "Arcaea icon should not retain a transparent drop-shadow strip at the bottom");
});

test("search quick links are explicit, count-gated, and game-scoped", () => {
  const data = projectCatalog(catalog, rosBaseUrl);
  const quickLinks = buildSearchQuickLinks(data);
  assert.ok(quickLinks.every((entry) => entry.count > 0));
  assert.ok(quickLinks.some((entry) => entry.label === "Arcaea 曲绘" && entry.href === "/arcaea/jacket/"));
  assert.ok(quickLinks.some((entry) => entry.label === "Phigros 曲绘" && entry.href === "/phigros/jacket/"));
  assert.ok(quickLinks.every((entry) => entry.label !== "曲绘"));
});

function testResource(overrides: Partial<PublicResource> = {}): PublicResource {
  return {
    resourceId: "resource-id",
    route: "/r/resource-id/",
    game: "arcaea",
    resourceType: "jacket",
    category: "jacket",
    categoryLabel: "曲绘",
    displayTitle: "Resource",
    metadata: {},
    variants: [],
    preview: { small: null, medium: null, large: null },
    ...overrides,
  };
}

test("related ranking is deterministic and prioritizes shared artist", () => {
  const current = testResource({ artist: "Same Artist", displayTitle: "Current" });
  const ordinary = testResource({ resourceId: "ordinary", route: "/r/ordinary/", displayTitle: "A ordinary" });
  const sameArtist = testResource({ resourceId: "same-artist", route: "/r/same-artist/", displayTitle: "Z same artist", artist: "Same Artist", resourceType: "pack-cover", category: "pack-cover", categoryLabel: "曲包封面" });
  const candidates = [ordinary, sameArtist];
  assert.deepEqual(rankRelatedResources(current, candidates).map((resource) => resource.resourceId), ["same-artist", "ordinary"]);
  assert.deepEqual(rankRelatedResources(current, [...candidates].reverse()).map((resource) => resource.resourceId), ["same-artist", "ordinary"]);
});

test("detail lightbox opens only an existing preview rendition", () => {
  const panel = fs.readFileSync(path.join(siteRoot, "src", "components", "VariantPanel.astro"), "utf8");
  const script = fs.readFileSync(path.join(siteRoot, "src", "scripts", "detail.ts"), "utf8");
  const styles = fs.readFileSync(path.join(siteRoot, "src", "styles", "global.css"), "utf8");
  assert.match(panel, /data-lightbox-preview-url=\{large\.url\}/u);
  assert.doesNotMatch(panel, /variant\.original/u);
  assert.match(script, /Escape/u);
  assert.match(script, /event\.key !== "Tab"/u);
  assert.match(script, /detail-lightbox-open/u);
  assert.match(styles, /\.detail-lightbox\[hidden\] \{ display: none; \}/u);
});

test("ROS preconnect is derived from the configured base URL", () => {
  const source = fs.readFileSync(path.join(siteRoot, "src", "layouts", "BaseLayout.astro"), "utf8");
  assert.match(source, /rel="preconnect"/u);
  assert.match(source, /rel="dns-prefetch"/u);
  assert.match(source, /new URL\(ROS_BASE_URL\)\.origin/u);
});

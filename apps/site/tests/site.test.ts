import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { projectCatalog, selectPreviewRendition } from "../src/lib/catalog-projection.js";
import { formatPublicApkBytes, parsePublicArcaeaApkManifest } from "../src/lib/apk.js";
import { uniqueZipFilename } from "../src/lib/batch.js";
import { displayDifficultyLabel, displayFilterDifficultyLabel, displayVariantLabel, GAME_CONFIG, primaryCategorySlug } from "../src/lib/game-config.js";
import { formatImageDimensions } from "../src/lib/format.js";
import { formatContentVersion, formatGameUpdatedAt, isRecentlyUpdated, sortPublicGames } from "../src/lib/game-index.js";
import { rankRelatedResources } from "../src/lib/related.js";
import { buildSearchQuickLinks } from "../src/lib/search-quick-links.js";
import { getCategoryBrowseConfig } from "../src/lib/category-browse.js";
import { GISCUS_CONFIG, GITHUB_DISCUSSIONS_URL, GITHUB_REPOSITORY_URL } from "../src/lib/site-config.js";
import { compareNaturalText, rankSearchEntries } from "../src/lib/search.js";
import { createUrlHelpers } from "../src/lib/url.js";
import { getPublicNavigationGames, getSiteData, loadCategoryBrowseProjections, loadFormalCatalog } from "../src/lib/site-data.js";
import { formatArcaeaAddedVersion } from "../src/lib/public-display.js";
import type { PublicResource, PublicSearchEntry } from "../src/lib/types.js";

const catalog = loadFormalCatalog();
const rosBaseUrl = "https://rhythm-assets.cn-nb1.rains3.com";
const siteRoot = path.resolve(process.cwd(), "apps", "site");

test("Arcaea added-version labels keep only major and minor components", () => {
  assert.equal(formatArcaeaAddedVersion("6.13.10"), "6.13");
  assert.equal(formatArcaeaAddedVersion("3.5.3"), "3.5");
  assert.equal(formatArcaeaAddedVersion("6.13"), "6.13");
});

test("jacket details expose the unified chart field and user-facing identity metadata", () => {
  assert.equal(GAME_CONFIG.rizline.metadataLabels.songId, undefined);
  assert.equal(GAME_CONFIG.rizline.metadataLabels.gameVersion, undefined);
  assert.equal(GAME_CONFIG.rizline.metadataLabels.specialArtId, "特殊插画 ID");
  assert.equal(GAME_CONFIG.rotaeno.metadataLabels.metadataStatus, undefined);
  assert.equal(GAME_CONFIG.rotaeno.metadataLabels.gameVersion, undefined);
  assert.equal(GAME_CONFIG["paradigm-reboot"].metadataLabels.songId, undefined);
  assert.equal(GAME_CONFIG["paradigm-reboot"].metadataLabels.gameVersion, undefined);
  const siteData = getSiteData();
  for (const game of ["arcaea", "phigros", "rizline", "infalsus", "rotaeno"] as const) {
    const jackets = siteData.resources.filter((resource) => resource.game === game && resource.resourceType === "jacket");
    assert.ok(jackets.length > 0);
    assert.ok(jackets.every((resource) => Array.isArray(resource.charts)));
  }
  const infalsusJacket = siteData.resources.find((resource) => resource.game === "infalsus" && resource.resourceType === "jacket");
  assert.deepEqual(infalsusJacket?.charts?.map((chart) => [chart.difficulty, chart.level]), [["MIN", "1"], ["EVO", "5"], ["ULT", "9"], ["FBD", "11"]]);
  const phigrosJacket = siteData.resources.find((resource) => resource.game === "phigros" && resource.resourceType === "jacket" && resource.metadata.songName === "000 -Ain Soph Aur-");
  assert.deepEqual(phigrosJacket?.charts?.map((chart) => [chart.difficulty, chart.level, chart.noter]), [["EZ", "2.5", "Magazet"], ["HD", "8.4", "Magazet"], ["IN", "14.4", "啊0哒0咔0哟 & Dilated"]]);
  const rotaenoJacket = siteData.resources.find((resource) => resource.game === "rotaeno" && resource.resourceType === "jacket" && resource.metadata.songId === "abstruse-dilemma");
  assert.deepEqual(rotaenoJacket?.charts?.map((chart) => [chart.difficulty, chart.level, chart.constant]), [["I", "3", "3.0"], ["II", "7", "7.0"], ["III", "12", "12.3"], ["IV", "14", "14.0"]]);
  assert.ok(rotaenoJacket?.charts?.every((chart) => chart.status === "available"));
  assert.equal(displayDifficultyLabel("INSCRIBED", "arcaea"), "Inscribed");
  assert.equal(displayFilterDifficultyLabel("INSCRIBED", "arcaea"), "INS");
  const inscribed = siteData.resources
    .filter((resource) => resource.game === "arcaea" && resource.resourceType === "jacket")
    .flatMap((resource) => (resource.charts ?? []).filter((chart) => chart.difficulty === "INSCRIBED").map(() => resource.metadata.songId));
  assert.deepEqual(new Set(inscribed), new Set(["dreadarea", "rivenpilgrim", "cataclysmcry", "deinosphainein"]));
  const rotaenoFacets = getCategoryBrowseConfig("rotaeno", "jacket", siteData.galleries["rotaeno/jacket"] ?? []).facets;
  assert.deepEqual(rotaenoFacets.slice(0, 2).map((facet) => facet.label), ["\u8c31\u9762\u96be\u5ea6", "\u96be\u5ea6\u7b49\u7ea7"]);
  assert.ok(rotaenoFacets.findIndex((facet) => facet.key === "pack") < rotaenoFacets.findIndex((facet) => facet.key === "constant"));
  assert.ok(rotaenoFacets.findIndex((facet) => facet.key === "version") < rotaenoFacets.findIndex((facet) => facet.key === "constant"));
  assert.ok(rotaenoFacets.some((facet) => facet.key === "pack"));
  assert.ok(rotaenoFacets.some((facet) => facet.key === "bpm" && facet.range));
  assert.ok(rotaenoFacets.some((facet) => facet.key === "version"));
  assert.equal(rotaenoFacets.find((facet) => facet.key === "chart")?.options.find((option) => option.value === "IV_Alpha")?.label, "Ⅳ-α");
  const rotaenoConstantFacet = rotaenoFacets.find((facet) => facet.key === "constant");
  assert.ok(rotaenoConstantFacet?.options.some((option) => option.value === "12.3"));
  assert.deepEqual(rotaenoConstantFacet?.range, { min: 1, max: 14.5, step: 0.1 });
  const rotaenoWithoutCharts = siteData.resources.find((resource) => resource.game === "rotaeno" && resource.resourceType === "jacket" && resource.chartDataStatus === "unavailable");
  assert.ok(rotaenoWithoutCharts);
  const rizlineJacket = siteData.resources.find((resource) => resource.game === "rizline" && resource.resourceType === "jacket");
  assert.equal(rizlineJacket?.chartDataStatus, "unavailable");
  assert.equal(typeof rizlineJacket?.metadata.songId, "string");
  assert.equal(typeof rizlineJacket?.metadata.gameVersion, "string");
});

test("Paradigm 4.10 publishes one song Resource with catalog-aligned charts and image-only public downloads", () => {
  const paradigmResources = catalog.resources.filter((resource) => resource.game === "paradigm-reboot" && resource.lifecycle.status === "published");
  assert.equal(paradigmResources.length, 419);
  assert.equal(new Set(paradigmResources.map((resource) => resource.metadata.songId)).size, 419);
  const resourceIds = new Set(paradigmResources.map((resource) => resource.id));
  const paradigmVariants = catalog.variants.filter((variant) => resourceIds.has(variant.resourceId));
  const paradigmRenditions = catalog.renditions.filter((rendition) => paradigmVariants.some((variant) => variant.id === rendition.variantId));
  assert.equal(paradigmVariants.length, 421);
  assert.equal(paradigmRenditions.filter((rendition) => rendition.renditionType === "original").length, 421);
  assert.equal(paradigmRenditions.filter((rendition) => rendition.renditionType === "music").length, 419);
  assert.equal(paradigmRenditions.filter((rendition) => rendition.renditionType === "preview-audio").length, 419);
  assert.equal(paradigmRenditions.filter((rendition) => rendition.renditionType === "chart").length, 1302);
  assert.equal(paradigmRenditions.filter((rendition) => rendition.renditionType === "thumbnail-320").length, 421);
  assert.equal(paradigmRenditions.filter((rendition) => rendition.renditionType === "thumbnail-640").length, 421);
  assert.equal(paradigmRenditions.filter((rendition) => rendition.renditionType === "thumbnail-1280").length, 421);
  const paradigmObjects = new Set(paradigmRenditions.map((rendition) => rendition.objectId));
  assert.equal([...paradigmObjects].filter((objectId) => catalog.objects.find((object) => object.id === objectId)?.mime === "audio/ogg").length, 838);
  assert.equal([...paradigmObjects].filter((objectId) => catalog.objects.find((object) => object.id === objectId)?.mime === "application/octet-stream").length, 1302);

  const siteData = getSiteData();
  const projected = siteData.resources.filter((resource) => resource.game === "paradigm-reboot");
  assert.equal(projected.length, 419);
  assert.ok(projected.every((resource) => resource.resourceType === "jacket" && resource.charts?.length === paradigmRenditions.filter((rendition) => rendition.variantId === resource.variants.find((variant) => variant.preferred)?.variantId && rendition.renditionType === "chart").length));
  const phasebreak = projected.find((resource) => resource.metadata.songId === "phasebreak");
  assert.equal(phasebreak?.displayTitle, "PHASEBREAK");
  assert.equal(phasebreak?.artist, "Zekk");
  assert.ok(projected.some((resource) => resource.charts?.some((chart) => chart.level === "17")));
  assert.ok(projected.every((resource) => !resource.charts?.some((chart) => chart.level === "17+")));
  assert.deepEqual(phasebreak?.charts?.map((chart) => [chart.difficulty, chart.level, chart.constant, chart.noter]), [
    ["DET", "5", "5.0", "SCREWCAT"],
    ["IVD", "10", "10.5", "SCREWCAT"],
    ["MSV", "15+", "15.8", "SCREWCAT"],
  ]);
  assert.ok(phasebreak?.searchTerms?.includes("SCREWCAT"));
  assert.equal(phasebreak?.charts?.length, 3);
  assert.ok(projected.every((resource) => resource.variants.every((variant) => !("attachments" in variant))));
  const innernorm = projected.find((resource) => resource.metadata.songId === "innernorm");
  const lynn = projected.find((resource) => resource.metadata.songId === "lynn");
  assert.ok(innernorm?.variants.some((variant) => variant.label === "CHAOTIC 封面"));
  assert.ok(lynn?.variants.some((variant) => variant.label === "Override 封面"));
  assert.equal(innernorm?.charts?.length, 4);
  const config = getCategoryBrowseConfig("paradigm-reboot", "jacket", siteData.galleries["paradigm-reboot/jacket"] ?? []);
  assert.deepEqual(config.facets.find((facet) => facet.key === "chart")?.options.map((option) => option.value), ["DET", "IVD", "MSV", "RBT", "CTC"]);
  assert.ok(config.facets.some((facet) => facet.key === "pack" && facet.options.length > 0));
  assert.ok(config.facets.some((facet) => facet.key === "bpm" && facet.range));
  assert.ok(config.facets.some((facet) => facet.key === "version" && facet.options.length > 0));
  assert.ok(config.facets.some((facet) => facet.key === "constant" && facet.range));
  assert.deepEqual(config.facets.filter((facet) => !facet.range).map((facet) => facet.key), ["chart", "level", "pack", "version"]);
  assert.deepEqual(config.facets.filter((facet) => facet.range).map((facet) => facet.key), ["constant", "bpm"]);
  const versionFacet = config.facets.find((facet) => facet.key === "version");
  assert.ok(versionFacet?.options.every((option) => /^\d+(?:\.\d+)?$/u.test(option.value)));
  assert.ok(versionFacet?.options.every((option) => !option.value.includes(",")));
  const multiVersion = projected.find((resource) => typeof resource.metadata.updateVersion === "string" && resource.metadata.updateVersion.includes(","));
  assert.ok(multiVersion);
  assert.ok((multiVersion?.facets?.version ?? []).length > 1);
  assert.ok((multiVersion?.facets?.version ?? []).every((value) => /^\d+(?:\.\d+)?$/u.test(value)));
  assert.ok(config.sortOptions.some((option) => option.value === "updated-desc"));
  assert.ok(config.sortOptions.some((option) => option.value === "bpm-desc"));
  assert.ok(config.sortOptions.some((option) => option.value === "artist-desc" && option.label === "曲师 Z-A"));
  assert.ok(siteData.searchIndex.some((entry) => entry.game === "paradigm-reboot" && entry.keywords.includes("SCREWCAT")));
});

test("public projection excludes local paths, credentials, and internal provenance", () => {
  const projection = projectCatalog(catalog, rosBaseUrl);
  const serialized = JSON.stringify(projection);
  assert.doesNotMatch(serialized, /[A-Z]:\\/iu);
  assert.doesNotMatch(serialized, /ROS_(?:ACCESS|SECRET)_KEY/iu);
  assert.doesNotMatch(serialized, /(?:provenance|sourceRelativePath|sourceSha256|objectId|objectKey|catalogSchemaVersion)/iu);
  assert.doesNotMatch(serialized, /attachments/iu);
  const hiddenCount = catalog.resources.filter((resource) => resource.lifecycle.status !== "published" || (resource.resourceType === "story-texture" && resource.metadata.storyVisualKind !== "vn-cg") || resource.resourceType === "rizcard" || (resource.resourceType === "startup" && resource.game !== "rotaeno")).length;
  assert.equal(projection.resources.length, catalog.resources.length - hiddenCount);
});

test("all Resources have unique stable detail routes", () => {
  const projection = projectCatalog(catalog, rosBaseUrl);
  const routes = projection.resources.map((resource) => resource.route);
  assert.equal(new Set(routes).size, projection.resources.length);
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
  assert.equal(upscaled.length, 1044);
  const arcaea70Upscaled = projection.resources.filter((resource) =>
    resource.game === "arcaea" &&
    resource.resourceType === "jacket" &&
    resource.metadata.gameVersion === "7.0.0c" &&
    Boolean(resource.upscaled),
  );
  assert.equal(arcaea70Upscaled.length, 8);
  assert.ok(arcaea70Upscaled.every((resource) => resource.upscaled?.width === 3072 && resource.upscaled?.height === 3072));
  const arcaea7255Upscaled = projection.resources.filter((resource) =>
    resource.game === "arcaea" &&
    resource.resourceType === "jacket" &&
    resource.metadata.gameVersion === "7.0.255c" &&
    Boolean(resource.upscaled),
  );
  assert.equal(arcaea7255Upscaled.length, 1);
  assert.equal(arcaea7255Upscaled[0]?.resourceId, "a0a4d486-1216-78d9-a3c6-ad6ff049b46a");
  assert.equal(arcaea7255Upscaled[0]?.upscaled?.width, 3072);
  assert.equal(arcaea7255Upscaled[0]?.upscaled?.height, 3072);
  assert.ok(upscaled.every((resource) => ["arcaea", "paradigm-reboot"].includes(resource.game) && resource.resourceType === "jacket"));
  assert.ok(upscaled.every((resource) => resource.variants.every((variant) => Boolean(variant.preview.small) && Boolean(variant.preview.medium) && Boolean(variant.preview.large))));
  const paradigmUpscaled = upscaled.filter((resource) => resource.game === "paradigm-reboot");
  assert.equal(paradigmUpscaled.length, 419);
  assert.ok(paradigmUpscaled.every((resource) => resource.upscaled?.width === (resource.original?.width ?? 0) * 4 && resource.upscaled?.height === (resource.original?.height ?? 0) * 4));
  assert.ok(paradigmUpscaled.every((resource) => resource.variants.every((variant) => Boolean(variant.upscaled))));
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
  assert.equal(GITHUB_REPOSITORY_URL, "https://github.com/rhythmarchive/rhythmarchive.github.io");
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
  assert.equal(parsePublicArcaeaApkManifest({ schemaVersion: 2, game: "arcaea", generatedAt: "now", latest: entry("9007199254740993.0.0"), previous: null }), null);
  assert.equal(formatPublicApkBytes(1234), "1.21 KB");
});

test("public game index projects activity only from final public resources", () => {
  const projection = projectCatalog(catalog, rosBaseUrl);
  const arcaea = projection.games.find((game) => game.slug === "arcaea");
  const phigros = projection.games.find((game) => game.slug === "phigros");
  const rizline = projection.games.find((game) => game.slug === "rizline");
  assert.equal(arcaea?.contentVersion, "7.0.255c");
  const arcaeaUpdatedAt = catalog.resources
    .filter((resource) => resource.game === "arcaea" && resource.lifecycle.status === "published")
    .map((resource) => resource.lifecycle.updatedAt)
    .sort()
    .at(-1);
  assert.equal(arcaea?.lastUpdatedAt, arcaeaUpdatedAt);
  assert.equal(rizline?.contentVersion, "2.7.1");
  const rizlineUpdatedAt = catalog.resources
    .filter((resource) => resource.game === "rizline" && resource.lifecycle.status === "published")
    .map((resource) => resource.lifecycle.updatedAt)
    .sort()
    .at(-1);
  assert.equal(rizline?.lastUpdatedAt, rizlineUpdatedAt);
  assert.equal(phigros?.contentVersion, "3.20.0");
  const phigrosUpdatedAt = catalog.resources
    .filter((resource) => resource.game === "phigros" && resource.lifecycle.status === "published")
    .map((resource) => resource.lifecycle.updatedAt)
    .sort()
    .at(-1);
  assert.equal(phigros?.lastUpdatedAt, phigrosUpdatedAt);
  assert.deepEqual(projection.games.map((game) => game.slug), sortPublicGames(projection.games).map((game) => game.slug));

  const mutated = structuredClone(catalog);
  const draft = structuredClone(mutated.resources[0]);
  const hidden = structuredClone(mutated.resources[0]);
  assert.ok(draft && hidden);
  draft.id = "019f0000-0000-7000-8000-000000000001";
  draft.lifecycle = { ...draft.lifecycle, status: "draft", updatedAt: "2099-01-01T00:00:00.000Z" };
  hidden.id = "019f0000-0000-7000-8000-000000000002";
  hidden.resourceType = "story-texture";
  hidden.lifecycle = { ...hidden.lifecycle, status: "published", updatedAt: "2099-01-02T00:00:00.000Z" };
  mutated.resources.push(draft, hidden);
  const mutatedArcaea = projectCatalog(mutated, rosBaseUrl).games.find((game) => game.slug === "arcaea");
  assert.deepEqual(mutatedArcaea && { contentVersion: mutatedArcaea.contentVersion, lastUpdatedAt: mutatedArcaea.lastUpdatedAt }, arcaea && { contentVersion: arcaea.contentVersion, lastUpdatedAt: arcaea.lastUpdatedAt });
});

test("game index formatting and recent labels degrade safely when version or date is missing", () => {
  assert.equal(formatContentVersion("6.16.0"), "v6.16.0");
  assert.equal(formatContentVersion("In Falsus Demo"), "In Falsus Demo");
  assert.equal(formatContentVersion(undefined), "");
  assert.equal(formatGameUpdatedAt("2026-08-26T00:00:00Z"), "08-26 更新");
  const now = Date.parse("2026-08-26T00:00:00Z");
  assert.equal(isRecentlyUpdated("2026-08-20T00:00:00Z", now), true);
  assert.equal(isRecentlyUpdated("2026-08-17T00:00:00Z", now), false);
  assert.equal(isRecentlyUpdated(undefined, now), false);
});

test("homepage uses the search-first entry architecture and a stable social image", () => {
  const source = fs.readFileSync(path.join(siteRoot, "src", "pages", "index.astro"), "utf8");
  assert.doesNotMatch(source, /找到下一张|想保存的曲绘/u);
  assert.match(source, /<h1 id="home-heading">音游图片下载站<\/h1>/u);
  assert.match(source, /收录音游曲绘、立绘、CG 等图片资源/u);
  assert.match(source, /formatCount\(games\.length\)/u);
  assert.match(source, /formatCount\(resourceCount\)/u);
  assert.match(source, /data-arcaea-apk-card/u);
  assert.match(source, /game-card-grid/u);
  assert.doesNotMatch(source, /home-categories|featuredCategories|games\.map\(\(game\) => game\.displayName\)\.join/u);
  assert.ok(source.indexOf("home-apk") < source.indexOf("home-games"));
  assert.match(source, /ogImage=\{homeOgImage\}/u);
  assert.match(source, /\/og\/home\.png/u);
  assert.equal(fs.existsSync(path.join(siteRoot, "public", "og", "home.png")), true);
});

test("games library covers every public game with shared cards and two sort modes", () => {
  const source = fs.readFileSync(path.join(siteRoot, "src", "pages", "games", "index.astro"), "utf8");
  const card = fs.readFileSync(path.join(siteRoot, "src", "components", "GameCard.astro"), "utf8");
  const games = getPublicNavigationGames();
  assert.ok(games.length > 0);
  assert.match(source, /getPublicNavigationGames\(\)/u);
  assert.match(source, /games\.map\(\(game\) => <GameCard game=\{game\} \/>\)/u);
  assert.match(source, /canonicalPath="\/games\/"/u);
  assert.match(source, /data-games-sort="updated"/u);
  assert.match(source, /data-games-sort="name"/u);
  assert.match(source, /data-games-grid/u);
  assert.match(card, /data-game-updated-at=\{game\.lastUpdatedAt \?\? ""\}/u);
  assert.match(card, /formatContentVersion/u);
  assert.match(card, /formatGameUpdatedAt/u);
});

test("header uses a centered three-column primary nav and retains the extensible game-library entry", () => {
  const header = fs.readFileSync(path.join(siteRoot, "src", "components", "SiteHeader.astro"), "utf8");
  const styles = fs.readFileSync(path.join(siteRoot, "src", "styles", "global.css"), "utf8");
  assert.match(header, /<div class="site-header-brand">[\s\S]*<BrandMark \/>/u);
  assert.match(header, /<nav class="site-nav"/u);
  assert.match(header, /<div class="site-header-actions">/u);
  assert.match(header, />首页<\/a>/u);
  assert.match(header, /nav-game-library/u);
  assert.match(header, /getPublicNavigationGames\(\)/u);
  assert.match(header, /查看全部游戏/u);
  assert.match(header, /urls\.sitePath\("\/games\/"\)/u);
  assert.match(header, />资源库<\/a>/u);
  assert.match(header, />反馈<\/a>/u);
  assert.match(header, /Astro\.url\.pathname/u);
  assert.match(header, /isGameLibrary/u);
  assert.match(header, /aria-current=/u);
  assert.doesNotMatch(header, /GAME_CONFIG|Object\.values\(GAME_CONFIG\)/u);
  assert.match(styles, /\.nav-library-popover/u);
  assert.match(styles, /\.nav-game-list/u);
  assert.match(styles, /\.site-header-inner \{ display: grid; grid-template-columns: minmax\(0, 1fr\) auto minmax\(0, 1fr\);/u);
  assert.match(styles, /\.site-header-actions/u);
  assert.match(styles, /\.site-nav > a\.is-active/u);
  assert.doesNotMatch(styles, /site-nav > a:not\(\.nav-search\)/u);
});

test("footer keeps first-level links and accessible external social/copyright regions", () => {
  const footer = fs.readFileSync(path.join(siteRoot, "src", "components", "Footer.astro"), "utf8");
  const styles = fs.readFileSync(path.join(siteRoot, "src", "styles", "global.css"), "utf8");
  assert.match(footer, /Rhythm Archive/u);
  assert.match(footer, /把节奏游戏里的图像，整理成容易找到的收藏。/u);
  assert.match(footer, />首页<\/a>/u);
  assert.match(footer, />游戏库<\/a>/u);
  assert.match(footer, />资源库<\/a>/u);
  assert.match(footer, />反馈<\/a>/u);
  assert.match(footer, /GITHUB_REPOSITORY_URL/u);
  assert.match(footer, /BILIBILI_URL/u);
  assert.match(footer, /social-icon-github/u);
  assert.match(footer, /social-icon-bilibili/u);
  assert.match(footer, /aria-label="GitHub 项目仓库"/u);
  assert.match(footer, /aria-label="Bilibili 主页"/u);
  assert.equal((footer.match(/target="_blank" rel="noopener noreferrer"/gu) ?? []).length, 2);
  assert.match(footer, /new Date\(\)\.getFullYear\(\)/u);
  assert.match(footer, /© \{currentYear\} Rhythm Archive/u);
  assert.match(footer, /Made with[\s\S]*for rhythm games\./u);
  assert.doesNotMatch(footer, /getPublicNavigationGames|primaryCategorySlug|B站主页/u);
  assert.match(styles, /\.site-footer-inner \{ display: grid; grid-template-columns:/u);
  assert.match(styles, /\.site-footer-meta/u);
});

test("shared visual tokens keep rounded cards, restrained shadows, and theme-safe background", () => {
  const styles = fs.readFileSync(path.join(siteRoot, "src", "styles", "global.css"), "utf8");
  assert.match(styles, /--radius-sm: 9px;/u);
  assert.match(styles, /--radius-md: 14px;/u);
  assert.match(styles, /--radius-lg: 20px;/u);
  assert.match(styles, /--shadow: 0 8px 24px rgba\(42, 93, 137, 0\.055\);/u);
  assert.match(styles, /--shadow-hover: 0 14px 34px rgba\(42, 93, 137, 0\.10\);/u);
  assert.match(styles, /background: radial-gradient\(ellipse 72% 32rem at 50% -10%/u);
  assert.doesNotMatch(styles, /body::before/u);
  assert.match(styles, /\.resource-card \{[\s\S]*border-radius: var\(--radius-md\);[\s\S]*box-shadow: var\(--shadow\)/u);
  assert.match(styles, /\.resource-card:hover[\s\S]*translateY\(-2px\)/u);
  assert.match(styles, /\.nav-library-popover \{[\s\S]*border-radius: var\(--radius-lg\);[\s\S]*box-shadow: var\(--shadow-hover\)/u);
  assert.match(styles, /\.site-header-brand \.brand-wordmark \{ display: none; \}/u);
});

test("Story Atlas UX contract keeps authored maps, direct dialog reading and player-facing copy", () => {
  const component = fs.readFileSync(path.join(siteRoot, "src", "components", "ArcaeaStoryAtlas.astro"), "utf8");
  const script = fs.readFileSync(path.join(siteRoot, "src", "scripts", "arcaea-story-atlas.ts"), "utf8");
  const styles = fs.readFileSync(path.join(siteRoot, "src", "styles", "global.css"), "utf8");
  assert.match(component, /data-story-link-path-ids/u);
  assert.match(component, /data-story-subworld-panel="final-verdict"/u);
  assert.match(component, /data-story-subworld-node/u);
  assert.match(component, /x1=\{line\.x1\}.*x2=\{line\.x2\}/u);
  assert.match(component, /data-story-node-variant/u);
  assert.match(component, /aria-label="Arcaea 剧情图谱"/u);
  assert.match(component, /transform\.labelMode === "overlay"/u);
  assert.doesNotMatch(component, /story-atlas-hero|Story Atlas|按游戏中的剧情路径浏览/u);
  assert.match(component, /model\.unassignedResources/u);
  assert.match(component, /story-detail-dialog/u);
  assert.doesNotMatch(component, /story-map-avatar-ring/u);
  assert.doesNotMatch(component, /story-atlas-overview|story-continuation-node|story-reader/u);
  assert.doesNotMatch(component, /story-map-node-face/u);
  assert.match(script, /const interactiveSelector = "button, a, input, select, textarea/u);
  assert.match(script, /DRAG_THRESHOLD = 5/u);
  assert.match(script, /function renderStoryFlow/u);
  assert.match(script, /包体未提供对白正文/u);
  assert.match(script, /function buildStorySegments/u);
  assert.match(script, /Object\.values\(payload\.resources\)\.find/u);
  assert.match(script, /flowResourceIds/u);
  assert.match(script, /button\[data-story-detail-close\]/u);
  assert.match(script, /story-dialog-inline-visual/u);
  assert.match(script, /zh-Hans.*zh-Hant.*en.*ja.*ko/u);
  assert.match(script, /activeSubworldId/u);
  assert.match(script, /story-subworld/u);
  assert.match(script, /lockBody/u);
  assert.match(script, /story-modal-open/u);
  assert.match(script, /"story-path": undefined, "story-entry": undefined/u);
  assert.doesNotMatch(script, /story-reader|story-open-reader|Read full story/u);
  assert.doesNotMatch(script, /renderMoreInfo/u);
  assert.match(styles, /\.story-map-path-cluster[^}]*pointer-events: none/u);
  assert.match(styles, /\.story-map-path-title[^}]*pointer-events: auto/u);
  assert.match(styles, /\.story-map-node-image/u);
  assert.match(styles, /--story-avatar-width/u);
  assert.match(styles, /--story-label-font-size/u);
  assert.doesNotMatch(styles, /story-atlas-hero/u);
  assert.match(styles, /\.story-detail-dialog/u);
  assert.match(styles, /\.story-dialog-story-flow/u);
  assert.match(styles, /overscroll-behavior: contain/u);
  assert.match(styles, /\.story-map-link\.is-external[^}]*opacity: \.2/u);
});

test("category semantic browse data keeps player-facing names and conservative unresolved labels", () => {
  const semantic = loadCategoryBrowseProjections();
  const siteData = getSiteData();
  const pragmatismOrdinary = siteData.resources.find((resource) => resource.metadata.songId === "pragmatism" && !resource.metadata.difficulty);
  const pragmatismByd = siteData.resources.find((resource) => resource.metadata.songId === "pragmatism" && resource.metadata.difficulty === "BYD");
  const singularityByd = siteData.resources.find((resource) => resource.metadata.songId === "singularity" && resource.metadata.difficulty === "BYD");
  const ignotusByd = siteData.resources.find((resource) => resource.metadata.songId === "ignotus" && resource.metadata.difficulty === "BYD");
  assert.equal(pragmatismOrdinary?.displayTitle, "PRAGMATISM");
  assert.equal(pragmatismByd?.displayTitle, "PRAGMATISM -RESURRECTION-");
  assert.equal(singularityByd?.displayTitle, "Singularity VVVIP");
  assert.equal(ignotusByd?.displayTitle, "Ignotus Afterburn");
  const portraits = siteData.galleries["arcaea/character-portrait"] ?? [];
  const namedPortraits = portraits.filter((resource) => resource.displayTitle !== "未归类角色立绘");
  assert.equal(namedPortraits.length, 137);
  assert.equal(portraits.length, 137);
  assert.ok(namedPortraits.some((resource) => resource.displayTitle === "光"));
  assert.ok(namedPortraits.some((resource) => resource.displayTitle === "識眼"));
  const insightPortrait = portraits.find((resource) => resource.metadata.characterEnglishName === "insight_konzetsu");
  assert.equal(insightPortrait?.displayTitle, "識眼");
  assert.equal((insightPortrait?.badges ?? []).includes("待确认"), false);
  assert.equal(portraits.some((resource) => ["01a00095-0eb3-7060-be48-589b7905401c", "01a00095-0ec9-7e52-b8dc-057960e46e7d", "01a00095-0ede-7ae8-b242-2fa2ad4fb746", "01a00095-0ef4-7f39-b876-efc6b75cf55a"].includes(resource.resourceId)), false);
  assert.ok(portraits.every((resource) => !/^\d+_(?:angry|cut|twisted)/u.test(resource.displayTitle)));
  for (const resourceType of ["character-portrait", "character-avatar", "linkplay-preview"] as const) {
    const saya = (siteData.galleries[`arcaea/${resourceType}`] ?? []).find((resource) => resource.metadata.characterEnglishName === "saya_konzetsu");
    assert.ok(saya, `7.0 Saya ${resourceType} resource should be mapped from characters.json`);
    assert.equal(saya?.displayTitle, "咲弥");
    assert.equal(saya?.metadata.characterVersionFrom, "7.0.0");
    assert.ok(!(saya?.badges ?? []).includes("待确认"));
    assert.ok((saya?.searchTerms ?? []).includes("さやあぶそりゅーしょん"));
  }

  const story = siteData.galleries["arcaea/story-cg"] ?? [];
  const knownCg = story.find((resource) => resource.searchTerms?.includes("0-3"));
  assert.equal(knownCg?.displayTitle, "Arcaea");
  assert.equal(knownCg?.subtitle, "Main Story · Act I · Part I · Entry 0-3");
  assert.ok((knownCg?.searchTerms ?? []).includes("Shades of Light in a Transcendent Realm"));
  const storyProjection = semantic.arcaea.resources.filter((resource) => resource.resourceType === "story-cg");
  assert.equal(storyProjection.length, 70);
  assert.equal(story.length, 241);
  assert.equal(semantic.arcaea.resources.filter((resource) => resource.metadata.storyVisualKind === "VN CG").length, 171);
  const divineCgs = story.filter((resource) => resource.resourceType === "story-cg" && resource.searchTerms?.some((term) => term.startsWith("C-")));
  assert.equal(divineCgs.length, 13);
  assert.ok(divineCgs.every((resource) => resource.displayTitle === "Divine Oblivion"));
  assert.ok(divineCgs.every((resource) => resource.metadata.storyPathId === 33));
  assert.ok(divineCgs.every((resource) => resource.metadata.storySection === "Act II · Part II"));
  assert.equal(divineCgs.filter((resource) => resource.metadata.storyNode === "C-10").length, 4);
  assert.ok(divineCgs.some((resource) => resource.subtitle?.includes("Entry C-2 · CG 1/2") && (resource.badges ?? []).includes("关联：Balor")));
  assert.ok(divineCgs.some((resource) => resource.subtitle?.includes("Entry C-7 · CG 3/3") && (resource.badges ?? []).includes("关联：DEINOS PHAINEIN")));
  const allVnCgs = story.filter((resource) => resource.metadata.storyVisualKind === "VN CG");
  assert.equal(allVnCgs.length, 171);
  const divineVnCgs = allVnCgs.filter((resource) => resource.metadata.storyPathId === 33);
  assert.equal(divineVnCgs.length, 82);
  assert.ok(divineVnCgs.every((resource) => resource.displayTitle === "Divine Oblivion" && resource.category === "story-cg" && resource.resourceType === "story-texture"));
  assert.ok(divineVnCgs.some((resource) => resource.searchTerms?.some((term) => term.endsWith("story/vn/res/catastrophe/cat_8_1.jpg")) && resource.metadata.storyNode === "C-8"));
  assert.ok(divineVnCgs.some((resource) => resource.searchTerms?.some((term) => term.endsWith("story/vn/res/catastrophe/D-O_CG_4.jpg")) && resource.metadata.storyPathId === 33));
  const firstDivineEndingCg = divineVnCgs.find((resource) => resource.searchTerms?.some((term) => term.endsWith("story/vn/res/catastrophe/D-O_CG_0.jpg")));
  assert.equal(firstDivineEndingCg?.subtitle, "Main Story · Act II · Part II · VN CG · D-O · VN CG 1/5");
  assert.equal(story.filter((resource) => resource.resourceType === "story-texture").length, 171);
  const liminalLast = story.findIndex((resource) => resource.searchTerms?.includes("23-8"));
  const divineFirst = story.findIndex((resource) => resource.searchTerms?.includes("C-2-1.jpg"));
  assert.ok(liminalLast >= 0 && divineFirst > liminalLast);
  const storyFacets = getCategoryBrowseConfig("arcaea", "story-cg", story).facets;
  assert.deepEqual(storyFacets.map((facet) => facet.key), ["type", "section", "path", "chapter"]);
  assert.deepEqual(storyFacets.find((facet) => facet.key === "type")?.options.map((option) => option.value).slice(0, 3), ["Main Story", "Side Story", "Archive Story"]);
  assert.ok(storyFacets.find((facet) => facet.key === "section")?.options.some((option) => option.value === "Act II · Part II"));
  const resolvedExtraCg = story.find((resource) => resource.metadata.storyNode === "11-8" && resource.searchTerms?.some((term) => term.endsWith("story/cg/11-8-2.jpg")));
  assert.equal(resolvedExtraCg?.displayTitle, "Colorful Dream");
  assert.equal(resolvedExtraCg?.metadata.storyRelationKind, "node");
  assert.equal((resolvedExtraCg?.badges ?? []).includes("待确认"), false);
  assert.equal((siteData.galleries["arcaea/story-texture"] ?? []).length, 0);
  assert.equal((siteData.galleries["arcaea/startup"] ?? []).length, 0);
  assert.equal((siteData.galleries["rotaeno/startup"] ?? []).length, 10);
  const phigrosKinds = getCategoryBrowseConfig("phigros", "pack-cover", siteData.galleries["phigros/pack-cover"] ?? []).facets[0]?.options.map((option) => option.label) ?? [];
  assert.ok(phigrosKinds.includes("主线") && phigrosKinds.includes("支线") && phigrosKinds.includes("单曲") && phigrosKinds.includes("其他曲包"));
});

test("category facet options use natural numeric and semantic ordering", () => {
  const siteData = getSiteData();
  const rotaeno = getCategoryBrowseConfig("rotaeno", "jacket", siteData.galleries["rotaeno/jacket"] ?? []);
  const facetValues = (config: ReturnType<typeof getCategoryBrowseConfig>, key: string): string[] => config.facets.find((facet) => facet.key === key)?.options.map((option) => option.value) ?? [];
  assert.deepEqual(facetValues(rotaeno, "chart"), ["I", "II", "III", "IV", "IV_Alpha", "特殊", "Meow"]);
  assert.deepEqual(facetValues(rotaeno, "level"), [
    "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "10+", "11", "11+", "12", "12+", "13", "13+", "14", "Aleph 0", "Lv.4",
  ]);
  const constants = facetValues(rotaeno, "constant");
  assert.equal(constants[0], "1.0");
  assert.equal(constants.at(-1), "14.5");
  assert.deepEqual(constants.map(Number), [...constants].map(Number).sort((left, right) => left - right));

  const arcaeaStory = getCategoryBrowseConfig("arcaea", "story-cg", siteData.galleries["arcaea/story-cg"] ?? []);
  assert.deepEqual(facetValues(arcaeaStory, "chapter"), [
    "Chapter 0", "Chapter 1", "Chapter 2", "Chapter 3", "Chapter 4", "Chapter 5", "Chapter 7", "Chapter 9", "Chapter 10", "Chapter 11", "Chapter 12", "Chapter 15", "Chapter 16", "Chapter 17", "Chapter 19", "Chapter 20", "Chapter 21", "Chapter 22", "Chapter 23", "Chapter 99", "Chapter 101", "Chapter 102",
  ]);

  const phigrosPack = getCategoryBrowseConfig("phigros", "pack-cover", siteData.galleries["phigros/pack-cover"] ?? []);
  assert.deepEqual(facetValues(phigrosPack, "kind"), ["主线", "支线", "单曲", "全部曲目", "其他曲包"]);
});

test("natural text comparison keeps numeric ordering without folding accents", () => {
  assert.ok(compareNaturalText("Chapter 2", "Chapter 10") < 0);
  assert.ok(compareNaturalText("T.S. #2", "T.S. #10", "en") < 0);
  assert.notEqual(compareNaturalText("café", "cafe"), 0);
});

test("homepage navigation uses the generated jacket browse counts", () => {
  const games = getPublicNavigationGames();
  assert.equal(games.find((game) => game.slug === "arcaea")?.categories.find((category) => category.slug === "jacket")?.count, 566);
  assert.equal(games.find((game) => game.slug === "phigros")?.categories.find((category) => category.slug === "jacket")?.count, 355);
  const rizline = games.find((game) => game.slug === "rizline");
  assert.equal(rizline?.categories.find((category) => category.slug === "jacket")?.count, 143);
  assert.equal(rizline?.categories.find((category) => category.slug === "rizcard")?.count, 44);
  assert.equal(rizline?.categories.some((category) => category.slug === "rizcard-layout"), false);
  assert.deepEqual(rizline?.featuredCategories.map((category) => category.slug), ["jacket", "special-art", "track-series", "rizcard", "character-avatar"]);
});

test("game routes reuse public navigation counts for shared category navigation", () => {
  const gamePage = fs.readFileSync(path.join(siteRoot, "src", "pages", "[game]", "index.astro"), "utf8");
  const categoryPage = fs.readFileSync(path.join(siteRoot, "src", "pages", "[game]", "[category]", "index.astro"), "utf8");
  assert.match(gamePage, /getPublicNavigationGames\(\)\.map/u);
  assert.match(categoryPage, /const navigationGames = getPublicNavigationGames\(\)/u);
  assert.match(categoryPage, /return navigationGames\.flatMap/u);
});

test("game roots redirect to primary category pages while category navigation keeps its type label", () => {
  const gamePage = fs.readFileSync(path.join(siteRoot, "src", "pages", "[game]", "index.astro"), "utf8");
  const categoryPage = fs.readFileSync(path.join(siteRoot, "src", "pages", "[game]", "[category]", "index.astro"), "utf8");
  assert.match(gamePage, /return Astro\.redirect/u);
  assert.match(gamePage, /primaryCategorySlug\(game\.slug\)/u);
  assert.match(categoryPage, /<span class="category-nav-label">资源类型<\/span>/u);
  assert.doesNotMatch(categoryPage, /category-nav-all|>全部 <span>/u);
});

test("internal game entries link directly to each game's primary category", () => {
  const sources = [
    fs.readFileSync(path.join(siteRoot, "src", "components", "GameCard.astro"), "utf8"),
    fs.readFileSync(path.join(siteRoot, "src", "pages", "[game]", "[category]", "index.astro"), "utf8"),
    fs.readFileSync(path.join(siteRoot, "src", "pages", "r", "[id]", "index.astro"), "utf8"),
  ];
  const footer = fs.readFileSync(path.join(siteRoot, "src", "components", "Footer.astro"), "utf8");
  assert.ok(sources.every((source) => source.includes("primaryCategorySlug")));
  assert.match(footer, /urls\.sitePath\("\/games\/"\)/u);
  assert.doesNotMatch(footer, /getPublicNavigationGames|primaryCategorySlug/u);
  assert.ok(sources.every((source) => !/sitePath\(`\/\$\{(?:game\.slug|resource\.game)\}\/`\)/u.test(source)));
  const quickLinks = buildSearchQuickLinks({ games: getPublicNavigationGames() });
  assert.ok(quickLinks.filter((entry) => ["Arcaea", "Phigros", "Rizline", "In Falsus", "Rotaeno"].includes(entry.label)).every((entry) => entry.href.endsWith("/jacket/")));
  assert.equal(primaryCategorySlug("arcaea"), "jacket");
  assert.equal(primaryCategorySlug("paradigm-reboot"), "jacket");
});

test("Rizline Catalog and public projections preserve approved boundaries", () => {
  const rizlineResources = catalog.resources.filter((resource) => resource.game === "rizline");
  const published = rizlineResources.filter((resource) => resource.lifecycle.status === "published");
  assert.equal(rizlineResources.length, 338);
  assert.equal(published.filter((resource) => resource.resourceType === "jacket").length, 143);
  assert.equal(published.filter((resource) => resource.resourceType === "special-art").length, 6);
  assert.equal(published.filter((resource) => resource.resourceType === "track-series").length, 19);
  assert.equal(published.filter((resource) => resource.resourceType === "rizcard-layout").length, 44);
  assert.equal(published.filter((resource) => resource.resourceType === "character-avatar").length, 8);
  assert.equal(published.filter((resource) => resource.resourceType === "rizcard").length, 29);
  assert.equal(rizlineResources.filter((resource) => resource.resourceType === "rizcard" && resource.lifecycle.status === "draft").length, 65);
  assert.equal(catalog.variants.filter((variant) => rizlineResources.some((resource) => resource.id === variant.resourceId)).length, 330);
  assert.equal(catalog.renditions.filter((rendition) => rizlineResources.some((resource) => catalog.variants.find((variant) => variant.id === rendition.variantId)?.resourceId === resource.id)).length, 1428);
  const siteData = getSiteData();
  const publicRizline = siteData.resources.filter((resource) => resource.game === "rizline");
  assert.equal(publicRizline.length, 220);
  assert.equal(publicRizline.filter((resource) => resource.resourceType === "rizcard").length, 0);
  assert.equal(publicRizline.filter((resource) => resource.resourceType === "rizcard-layout").length, 44);
  assert.ok(publicRizline.filter((resource) => resource.resourceType === "rizcard-layout").every((resource) => resource.category === "rizcard" && resource.categoryLabel === "Rizcard" && resource.metadata.layoutId));
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
  const card = fs.readFileSync(path.join(siteRoot, "src", "components", "GameCard.astro"), "utf8");
  const styles = fs.readFileSync(path.join(siteRoot, "src", "styles", "global.css"), "utf8");
  assert.match(source, /game-icons\/\$\{name\}\.png/u);
  assert.match(source, /width="192" height="192"/u);
  assert.match(source, /game-icon-fallback/u);
  assert.match(source, /onerror=/u);
  assert.match(card, /<GameIcon game=\{game\.slug\} \/>/u);
  assert.match(styles, /\.game-card-media > \.game-icon \{ position: absolute; inset: 0;/u);
  assert.match(styles, /\.game-card-media \.game-icon-image \{ inset: 0; width: 100%; height: 100%;[^}]*background: var\(--surface-muted\);/u);
  assert.equal(fs.existsSync(path.join(siteRoot, "public", "game-icons", "arcaea.png")), true);
  assert.equal(fs.existsSync(path.join(siteRoot, "public", "game-icons", "phigros.png")), true);
  assert.equal(fs.existsSync(path.join(siteRoot, "public", "game-icons", "rizline.png")), true);
  assert.equal(fs.existsSync(path.join(siteRoot, "public", "game-icons", "rotaeno.png")), true);
  assert.equal(fs.existsSync(path.join(siteRoot, "public", "game-icons", "paradigm-reboot.png")), true);
  assert.match(styles, /\.game-icon-paradigm-reboot \.game-icon-image,\s*\.game-icon-rizline \.game-icon-image \{[^}]*object-fit: cover[^}]*padding: 0[^}]*object-position: center/u);
  assert.match(styles, /\.game-card-media > \.game-icon\.game-icon-paradigm-reboot::before,\s*\.game-card-media > \.game-icon\.game-icon-rizline::before \{ display: none; \}/u);
  assert.match(styles, /\.game-icon-paradigm-reboot \.game-icon-image \{ background: #fff; \}/u);
  assert.match(styles, /\.game-icon-rizline \.game-icon-image \{ background: #d6ffff; \}/u);
  assert.match(source, /rizline/u);
  assert.match(source, /rotaeno/u);
});

test("Paradigm game icon keeps the APK app-icon square geometry", async () => {
  const icon = await sharp(path.join(siteRoot, "public", "game-icons", "paradigm-reboot.png")).metadata();
  assert.equal(icon.format, "png");
  assert.equal(icon.width, 192);
  assert.equal(icon.height, 192);
});

test("Arcaea icon does not retain an extracted blank black/white edge", async () => {
  const icon = await sharp(path.join(siteRoot, "public", "game-icons", "arcaea.png")).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(icon.info.width, 192);
  assert.equal(icon.info.height, 192);
  for (const [x, y] of [[0, 0], [icon.info.width - 1, 0], [0, icon.info.height - 1], [icon.info.width - 1, icon.info.height - 1]] as Array<[number, number]>) {
    const offset = (y * icon.info.width + x) * icon.info.channels;
    const red = icon.data[offset] ?? 0;
    const green = icon.data[offset + 1] ?? 0;
    const blue = icon.data[offset + 2] ?? 0;
    const alpha = icon.data[offset + 3] ?? 0;
    assert.ok(alpha >= 200, "Arcaea icon corners should remain opaque after transparent-boundary cropping");
    assert.ok(Math.max(red, green, blue) > 24 && Math.min(red, green, blue) < 240, "Arcaea icon corners should not be a blank black/white border");
  }
  const bottomCenterOffset = ((icon.info.height - 1) * icon.info.width + Math.floor(icon.info.width / 2)) * icon.info.channels;
  assert.ok((icon.data[bottomCenterOffset + 3] ?? 0) >= 200, "Arcaea icon should not retain a transparent drop-shadow strip at the bottom");
});

test("search quick links are explicit, count-gated, and game-scoped", () => {
  const data = projectCatalog(catalog, rosBaseUrl);
  const quickLinks = buildSearchQuickLinks(data);
  assert.ok(quickLinks.every((entry) => entry.count > 0));
  assert.ok(quickLinks.some((entry) => entry.label === "Arcaea 曲绘" && entry.href === "/arcaea/jacket/"));
  assert.ok(quickLinks.some((entry) => entry.label === "Phigros 曲绘" && entry.href === "/phigros/jacket/"));
  assert.ok(quickLinks.some((entry) => entry.label === "Rizline 曲绘" && entry.href === "/rizline/jacket/"));
  assert.ok(quickLinks.some((entry) => entry.label === "Rizline 精选集" && entry.href === "/rizline/track-series/"));
  assert.ok(quickLinks.some((entry) => entry.label === "Rizline Rizcard" && entry.href === "/rizline/rizcard/"));
  assert.ok(quickLinks.some((entry) => entry.label === "Rizline 角色头像" && entry.href === "/rizline/character-avatar/"));
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
  const page = fs.readFileSync(path.join(siteRoot, "src", "pages", "r", "[id]", "index.astro"), "utf8");
  const script = fs.readFileSync(path.join(siteRoot, "src", "scripts", "detail.ts"), "utf8");
  const styles = fs.readFileSync(path.join(siteRoot, "src", "styles", "global.css"), "utf8");
  assert.match(panel, /data-detail-source-select="original"/u);
  assert.match(panel, /data-detail-source-select="upscaled"/u);
  assert.match(panel, /data-lightbox-preview-url=\{variant\.original!\.url\}/u);
  assert.match(panel, /data-lightbox-preview-url=\{variant\.upscaled!\.url\}/u);
  assert.match(script, /Escape/u);
  assert.match(script, /event\.key !== "Tab"/u);
  assert.match(script, /data-detail-source-select/u);
  assert.match(script, /detail-lightbox-open/u);
  assert.match(styles, /\.detail-lightbox\[hidden\] \{ display: none; \}/u);
  assert.match(panel, /const useOriginalSource = sourceToggle && Boolean\(variant\.original\)/u);
  assert.match(page, /sourceToggle=\{resource\.resourceType === "jacket" &&/u);
});

test("client gallery rerenders preserve original jacket sources", () => {
  const gallery = fs.readFileSync(path.join(siteRoot, "src", "scripts", "gallery.ts"), "utf8");
  const browse = fs.readFileSync(path.join(siteRoot, "src", "scripts", "browse-gallery.ts"), "utf8");
  assert.match(gallery, /const useOriginalGallerySource = \["arcaea", "paradigm-reboot"\]\.includes\(resource\.game\) && resource\.resourceType === "jacket"/u);
  assert.match(gallery, /const image = useOriginalGallerySource \? resource\.original :/u);
  assert.match(gallery, /const srcset = useOriginalGallerySource \? "" :/u);
  assert.match(browse, /const useOriginalGallerySource = item\.game === "arcaea" && item\.resourceType === "jacket"/u);
  assert.match(browse, /const image = useOriginalGallerySource \? item\.original :/u);
  assert.match(browse, /const srcset = useOriginalGallerySource \? "" :/u);
});
test("detail downloads show image dimensions without the recommendation label", () => {
  const page = fs.readFileSync(path.join(siteRoot, "src", "pages", "r", "[id]", "index.astro"), "utf8");
  const component = fs.readFileSync(path.join(siteRoot, "src", "components", "DownloadActions.astro"), "utf8");
  const styles = fs.readFileSync(path.join(siteRoot, "src", "styles", "global.css"), "utf8");
  assert.equal(formatImageDimensions(500, 500), "500 × 500");
  assert.equal(formatImageDimensions(undefined, 500), undefined);
  assert.match(component, /formatImageDimensions\(original\.width, original\.height\)/u);
  assert.match(component, /formatImageDimensions\(upscaled\.width, upscaled\.height\)/u);
  assert.match(component, /download-dimensions/u);
  assert.doesNotMatch(component, /推荐|download-recommend/u);
  assert.doesNotMatch(component, /attachments|music|preview|chart/u);
  assert.doesNotMatch(page, /来源：|APK \+ Wiki|元数据状态|文件格式|歌曲 ID|游戏版本|Wiki BPM/u);
  assert.doesNotMatch(page, /chartSourceLabel|chart\.source/u);
  assert.match(styles, /\.download-dimensions/u);
  assert.doesNotMatch(styles, /\.download-recommend/u);
});

test("ROS preconnect is derived from the configured base URL", () => {
  const source = fs.readFileSync(path.join(siteRoot, "src", "layouts", "BaseLayout.astro"), "utf8");
  assert.match(source, /rel="preconnect"/u);
  assert.match(source, /rel="dns-prefetch"/u);
  assert.match(source, /new URL\(ROS_BASE_URL\)\.origin/u);
});

test("APK card omits digest and previous-version disclosures while preserving primary actions", () => {
  const source = fs.readFileSync(path.join(siteRoot, "src", "scripts", "apk-card.ts"), "utf8");
  const styles = fs.readFileSync(path.join(siteRoot, "src", "styles", "global.css"), "utf8");
  assert.match(source, /renderManifest\(cardElement, stateElement, manifest\.latest\)/u);
  assert.match(source, /"官方下载链接"/u);
  assert.match(source, /"下载APK"/u);
  assert.doesNotMatch(source, /校验信息|上一版本|createDigest|createPreviousVersion|manifest\.previous|apk-digest|apk-previous/u);
  assert.doesNotMatch(styles, /apk-digest|apk-previous|text-button/u);
  assert.doesNotMatch(source, /前往Releases|GitHub 下载/u);
  assert.doesNotMatch(source, /sha256\.slice\(/u);
  assert.doesNotMatch(source, /previousRow\.className/u);
});

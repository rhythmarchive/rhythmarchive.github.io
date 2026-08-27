import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { projectCatalog, selectPreviewRendition } from "../src/lib/catalog-projection.js";
import { formatPublicApkBytes, parsePublicArcaeaApkManifest } from "../src/lib/apk.js";
import { uniqueZipFilename } from "../src/lib/batch.js";
import { displayVariantLabel, GAME_CONFIG } from "../src/lib/game-config.js";
import { formatContentVersion, formatGameUpdatedAt, isRecentlyUpdated, sortPublicGames } from "../src/lib/game-index.js";
import { rankRelatedResources } from "../src/lib/related.js";
import { buildSearchQuickLinks } from "../src/lib/search-quick-links.js";
import { getCategoryBrowseConfig } from "../src/lib/category-browse.js";
import { GISCUS_CONFIG, GITHUB_DISCUSSIONS_URL } from "../src/lib/site-config.js";
import { rankSearchEntries } from "../src/lib/search.js";
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
  assert.equal(GAME_CONFIG.rizline.metadataLabels.songId, "歌曲 ID");
  assert.equal(GAME_CONFIG.rizline.metadataLabels.gameVersion, "资源版本");
  assert.equal(GAME_CONFIG.rizline.metadataLabels.specialArtId, "特殊插画 ID");
  const siteData = getSiteData();
  for (const game of ["arcaea", "phigros", "rizline", "infalsus", "rotaeno"] as const) {
    const jackets = siteData.resources.filter((resource) => resource.game === game && resource.resourceType === "jacket");
    assert.ok(jackets.length > 0);
    assert.ok(jackets.every((resource) => Array.isArray(resource.charts)));
  }
  const infalsusJacket = siteData.resources.find((resource) => resource.game === "infalsus" && resource.resourceType === "jacket");
  assert.deepEqual(infalsusJacket?.charts?.map((chart) => [chart.difficulty, chart.level]), [["MIN", "1"], ["EVO", "5"], ["ULT", "9"], ["FBD", "11"]]);
  const rotaenoJacket = siteData.resources.find((resource) => resource.game === "rotaeno" && resource.resourceType === "jacket" && resource.metadata.songId === "abstruse-dilemma");
  assert.deepEqual(rotaenoJacket?.charts?.map((chart) => [chart.difficulty, chart.level, chart.constant]), [["I", "3", "3.0"], ["II", "7", "7.0"], ["III", "12", "12.3"], ["IV", "14", "14.0"]]);
  assert.ok(rotaenoJacket?.charts?.every((chart) => chart.status === "available"));
  const rotaenoFacets = getCategoryBrowseConfig("rotaeno", "jacket", siteData.galleries["rotaeno/jacket"] ?? []).facets;
  assert.deepEqual(rotaenoFacets.map((facet) => facet.label), ["\u8c31\u9762\u96be\u5ea6", "\u96be\u5ea6\u7b49\u7ea7", "\u8c31\u9762\u5b9a\u6570"]);
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

test("public projection excludes local paths, credentials, and internal provenance", () => {
  const projection = projectCatalog(catalog, rosBaseUrl);
  const serialized = JSON.stringify(projection);
  assert.doesNotMatch(serialized, /[A-Z]:\\/iu);
  assert.doesNotMatch(serialized, /ROS_(?:ACCESS|SECRET)_KEY/iu);
  assert.doesNotMatch(serialized, /(?:provenance|sourceRelativePath|sourceSha256|objectId|objectKey|catalogSchemaVersion)/iu);
  const hiddenCount = catalog.resources.filter((resource) => resource.lifecycle.status !== "published" || resource.resourceType === "story-texture" || resource.resourceType === "rizcard" || (resource.resourceType === "startup" && resource.game !== "rotaeno")).length;
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

test("public game index projects activity only from final public resources", () => {
  const projection = projectCatalog(catalog, rosBaseUrl);
  const arcaea = projection.games.find((game) => game.slug === "arcaea");
  const phigros = projection.games.find((game) => game.slug === "phigros");
  const rizline = projection.games.find((game) => game.slug === "rizline");
  assert.equal(arcaea?.contentVersion, "7.0.0c");
  assert.equal(arcaea?.lastUpdatedAt, "2026-08-27T16:33:50.200Z");
  assert.equal(rizline?.contentVersion, "2.7.0");
  assert.equal(rizline?.lastUpdatedAt, "2026-08-24T12:42:04.372Z");
  assert.equal(phigros?.contentVersion, undefined);
  assert.equal(phigros?.lastUpdatedAt, "2026-08-14T13:57:23.100Z");
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

test("header keeps a single extensible game-library entry on mobile and desktop", () => {
  const header = fs.readFileSync(path.join(siteRoot, "src", "components", "SiteHeader.astro"), "utf8");
  const styles = fs.readFileSync(path.join(siteRoot, "src", "styles", "global.css"), "utf8");
  assert.match(header, /nav-game-library/u);
  assert.match(header, /getPublicNavigationGames\(\)/u);
  assert.match(header, /查看全部游戏/u);
  assert.doesNotMatch(header, /GAME_CONFIG|Object\.values\(GAME_CONFIG\)/u);
  assert.match(styles, /\.nav-library-popover/u);
  assert.match(styles, /\.nav-game-list/u);
  assert.doesNotMatch(styles, /site-nav > a:not\(\.nav-search\)/u);
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
  assert.equal(namedPortraits.length, 140);
  assert.equal(portraits.length, 140);
  assert.ok(namedPortraits.some((resource) => resource.displayTitle === "光"));
  assert.ok(portraits.every((resource) => !/^\d+_(?:angry|cut|twisted)/u.test(resource.displayTitle)));

  const story = siteData.galleries["arcaea/story-cg"] ?? [];
  const knownCg = story.find((resource) => resource.searchTerms?.includes("0-3"));
  assert.equal(knownCg?.displayTitle, "Arcaea");
  assert.match(knownCg?.subtitle ?? "", /Main Story/u);
  assert.ok((knownCg?.searchTerms ?? []).includes("Shades of Light in a Transcendent Realm"));
  assert.equal(semantic.arcaea.resources.filter((resource) => resource.resourceType === "story-cg").length, 66);
  assert.equal((siteData.galleries["arcaea/story-texture"] ?? []).length, 0);
  assert.equal((siteData.galleries["arcaea/startup"] ?? []).length, 0);
  assert.equal((siteData.galleries["rotaeno/startup"] ?? []).length, 10);
  const phigrosKinds = getCategoryBrowseConfig("phigros", "pack-cover", siteData.galleries["phigros/pack-cover"] ?? []).facets[0]?.options.map((option) => option.label) ?? [];
  assert.ok(phigrosKinds.includes("主线") && phigrosKinds.includes("支线") && phigrosKinds.includes("单曲") && phigrosKinds.includes("其他曲包"));
});

test("homepage navigation uses the generated jacket browse counts", () => {
  const games = getPublicNavigationGames();
  assert.equal(games.find((game) => game.slug === "arcaea")?.categories.find((category) => category.slug === "jacket")?.count, 565);
  assert.equal(games.find((game) => game.slug === "phigros")?.categories.find((category) => category.slug === "jacket")?.count, 353);
  const rizline = games.find((game) => game.slug === "rizline");
  assert.equal(rizline?.categories.find((category) => category.slug === "jacket")?.count, 141);
  assert.equal(rizline?.categories.find((category) => category.slug === "rizcard")?.count, 44);
  assert.equal(rizline?.categories.some((category) => category.slug === "rizcard-layout"), false);
  assert.deepEqual(rizline?.featuredCategories.map((category) => category.slug), ["jacket", "special-art", "track-series", "rizcard", "character-avatar"]);
});

test("Rizline Catalog and public projections preserve approved boundaries", () => {
  const rizlineResources = catalog.resources.filter((resource) => resource.game === "rizline");
  const published = rizlineResources.filter((resource) => resource.lifecycle.status === "published");
  assert.equal(rizlineResources.length, 336);
  assert.equal(published.filter((resource) => resource.resourceType === "jacket").length, 141);
  assert.equal(published.filter((resource) => resource.resourceType === "special-art").length, 6);
  assert.equal(published.filter((resource) => resource.resourceType === "track-series").length, 19);
  assert.equal(published.filter((resource) => resource.resourceType === "rizcard-layout").length, 44);
  assert.equal(published.filter((resource) => resource.resourceType === "character-avatar").length, 8);
  assert.equal(published.filter((resource) => resource.resourceType === "rizcard").length, 29);
  assert.equal(rizlineResources.filter((resource) => resource.resourceType === "rizcard" && resource.lifecycle.status === "draft").length, 65);
  assert.equal(catalog.variants.filter((variant) => rizlineResources.some((resource) => resource.id === variant.resourceId)).length, 328);
  assert.equal(catalog.renditions.filter((rendition) => rizlineResources.some((resource) => catalog.variants.find((variant) => variant.id === rendition.variantId)?.resourceId === resource.id)).length, 1420);
  const siteData = getSiteData();
  const publicRizline = siteData.resources.filter((resource) => resource.game === "rizline");
  assert.equal(publicRizline.length, 218);
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
  assert.match(source, /rizline/u);
  assert.match(source, /rotaeno/u);
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

test("APK card keeps digest and previous version behind secondary disclosure", () => {
  const source = fs.readFileSync(path.join(siteRoot, "src", "scripts", "apk-card.ts"), "utf8");
  assert.match(source, /summary\.textContent = "校验信息"/u);
  assert.match(source, /createPreviousVersion\(previous\)/u);
  assert.doesNotMatch(source, /sha256\.slice\(/u);
  assert.doesNotMatch(source, /previousRow\.className/u);
});

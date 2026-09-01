import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  BROWSE_PAGE_SIZE,
  compareDisplayLevels,
  compareVersionStrings,
  defaultBrowseUrlState,
  displayBrowseItem,
  filterBrowseItems,
  groupBrowseFacetOptions,
  getBrowseFacetOptions,
  parseBrowseUrlState,
  searchRank,
  serializeBrowseUrlState,
  type ArcaeaBrowseUrlState,
  type ArcaeaFacetOptions,
  type BrowseArtwork,
  type BrowseGalleryItem,
  type BrowseResolvedResource,
  type InfalsusBrowseUrlState,
  type PhigrosBrowseUrlState,
  type RizlineBrowseUrlState,
  type RizlineFacetOptions,
} from "../src/lib/browse-gallery";
import { getBrowseGalleryBuild } from "../src/lib/site-data";
import { formatArcaeaAddedVersion } from "../src/lib/public-display";

const formalBrowse = getBrowseGalleryBuild();

test("Arcaea regular Songs are one card each and the unresolved artwork stays diagnostic-only", () => {
  const songs = formalBrowse.arcaea.items.filter((item) => item.recordKind === "song");
  assert.equal(songs.length, 550);
  assert.equal(new Set(songs.map((item) => item.songId)).size, songs.length);
  assert.equal(songs.filter((item) => item.songId === "ignotus").length, 1);
  assert.equal(formalBrowse.diagnostics.arcaea.skipped.length, 1);
  assert.ok(formalBrowse.diagnostics.arcaea.skipped.every((item) => item.recordKind === "song" && item.reason === "no-resolved-artwork-resource"));
  assert.ok(!formalBrowse.arcaea.items.some((item) => item.songId === "undyingmacula"));
});

test("Arcaea BYD artwork overrides only after a matching chart filter", () => {
  const item = makeArcaeaItem({
    resourceId: "default-resource",
    charts: [
      { difficultyClass: "FTR", displayLevel: "9" },
      { difficultyClass: "BYD", displayLevel: "10+" },
    ],
    artworks: [
      makeArtwork("default-resource", "default"),
      makeArtwork("byd-resource", "difficulty", "BYD"),
    ],
  });
  const state = arcaeaState({ chart: ["BYD"] });
  assert.deepEqual(filterBrowseItems([item], state).map((entry) => entry.resourceId), ["default-resource"]);
  assert.equal(displayBrowseItem(item, state.chart).resourceId, "byd-resource");
  assert.equal(displayBrowseItem(item, state.chart).selectedArtworkDifficulty, "BYD");
});

test("Arcaea keeps default artwork when a BYD chart has no BYD artwork", () => {
  const item = makeArcaeaItem({
    charts: [{ difficultyClass: "BYD", displayLevel: "10" }],
    artworks: [makeArtwork("default-resource", "default")],
  });
  assert.equal(filterBrowseItems([item], arcaeaState({ chart: ["BYD"] })).length, 1);
  assert.equal(displayBrowseItem(item, ["BYD"]).resourceId, "default-resource");
});

test("Arcaea difficulty and level filters require the same Chart object", () => {
  const item = makeArcaeaItem({
    charts: [
      { difficultyClass: "FTR", displayLevel: "9" },
      { difficultyClass: "BYD", displayLevel: "10+" },
    ],
  });
  assert.equal(filterBrowseItems([item], arcaeaState({ chart: ["FTR"], level: ["10+"] })).length, 0);
  assert.equal(filterBrowseItems([item], arcaeaState({ chart: ["FTR"], level: ["9"] })).length, 1);
});

test("Arcaea rating-plus and component version comparisons are semantic", () => {
  assert.ok(compareDisplayLevels("9+", "9") > 0);
  assert.ok(compareDisplayLevels("10", "9+") > 0);
  assert.ok(compareVersionStrings("6.10", "6.9") > 0);
  assert.ok(compareVersionStrings("5.10", "5.9") > 0);
  assert.ok(compareVersionStrings("6.10", "6.1") > 0);
  assert.ok(compareVersionStrings("3.12.6", "3.5.3") > 0);
  assert.ok(compareVersionStrings("6.13.10", "6.3.3") > 0);
});

test("Arcaea specials, extras, aliases, and same-title families remain discoverable", () => {
  const arcaeaKinds = countKinds(formalBrowse.arcaea.items);
  assert.deepEqual(arcaeaKinds, { song: 550, special: 9, "archive-extra": 3, "unresolved-extra": 3 });
  const special = formalBrowse.arcaea.items.find((item) => item.displayTitle === "Ignotus Afterburn");
  assert.ok(special);
  assert.equal(special.version, "1.6.1");
  assert.equal(special.releaseDate, "2018-04-01");
  assert.equal(special.badge, "愚人节 2018");
  assert.equal(filterBrowseItems(formalBrowse.arcaea.items, arcaeaState({ q: "Ignotus Afterburn" })).some((item) => item.key === special.key), true);

  const specialTitles = [
    "Ignotus Afterburn",
    "Red and Blue and Green",
    "Singularity VVVIP",
    "overdead.",
    "Mistempered Malignance",
    "0xe0e1ccull",
    "HIVEMIND INTERLINKED",
    "Live Faster Die Younger",
    "UNUSED LEVELS",
  ];
  const specials = formalBrowse.arcaea.items.filter((item) => specialTitles.includes(item.displayTitle));
  assert.equal(specials.length, specialTitles.length);
  const descending = filterBrowseItems(formalBrowse.arcaea.items, arcaeaState({ sort: "version-desc" }));
  const ascending = filterBrowseItems(formalBrowse.arcaea.items, arcaeaState({ sort: "version-asc" }));
  const descendingPositions = specialTitles.map((title) => descending.findIndex((item) => item.displayTitle === title));
  const ascendingPositions = specialTitles.map((title) => ascending.findIndex((item) => item.displayTitle === title));
  assert.ok(descendingPositions.every((position, index) => index === 0 || position < descendingPositions[index - 1]!));
  assert.ok(ascendingPositions.every((position, index) => index === 0 || position > ascendingPositions[index - 1]!));
  assert.notEqual(descending[0]?.recordKind, "special");

  const family = [
    makeArcaeaItem({ key: "song:last", displayTitle: "Last", resourceId: "last" }),
    makeArcaeaItem({ key: "song:last-moment", displayTitle: "Last | Moment", resourceId: "last-moment" }),
    makeArcaeaItem({ key: "song:last-eternity", displayTitle: "Last | Eternity", resourceId: "last-eternity" }),
  ];
  const familyResults = filterBrowseItems(family, arcaeaState({ q: "Last" }));
  assert.deepEqual(familyResults.map((item) => item.displayTitle), ["Last", "Last | Eternity", "Last | Moment"]);
  assert.equal(new Set(familyResults.map((item) => item.key)).size, 3);
});

test("Arcaea archive and unresolved extras stay at the end under explicit sorting", () => {
  const sorted = filterBrowseItems(formalBrowse.arcaea.items, arcaeaState({ sort: "title-asc" }));
  const firstTail = sorted.findIndex((item) => item.recordKind === "archive-extra" || item.recordKind === "unresolved-extra");
  assert.ok(firstTail >= 0);
  assert.ok(sorted.slice(firstTail).every((item) => item.recordKind === "archive-extra" || item.recordKind === "unresolved-extra"));
});

test("Browse search ranking is deterministic and covers title, aliases, artist, and other terms", () => {
  const entries = [
    makeArcaeaItem({ resourceId: "other", displayTitle: "Other", searchTerms: ["target keyword"] }),
    makeArcaeaItem({ resourceId: "artist", displayTitle: "Artist Song", artist: "Target" }),
    makeArcaeaItem({ resourceId: "alias", displayTitle: "Alias Song", titleAliases: ["Target"] }),
    makeArcaeaItem({ resourceId: "contains", displayTitle: "A Target Song" }),
    makeArcaeaItem({ resourceId: "prefix", displayTitle: "Target Song" }),
    makeArcaeaItem({ resourceId: "exact", displayTitle: "Target" }),
  ];
  assert.deepEqual(filterBrowseItems(entries, arcaeaState({ q: "target" })).map((item) => item.resourceId), ["exact", "prefix", "contains", "alias", "artist", "other"]);
  assert.equal(searchRank(entries[0]!, "target"), 7);
});

test("Arcaea facets use projection metadata and level/version ordering", () => {
  const options = getBrowseFacetOptions(formalBrowse.arcaea) as ArcaeaFacetOptions;
  assert.deepEqual(options.charts, ["PST", "PRS", "FTR", "BYD", "ETR", "INSCRIBED"]);
  assert.ok(options.packs.includes("Absolute Reason"));
  assert.ok(!options.packs.includes("single"));
  assert.deepEqual(options.levels.slice(0, 6), ["1", "2", "3", "4", "5", "6"]);
  assert.ok(options.versions.indexOf("6.10") < options.versions.indexOf("6.9"));
  assert.deepEqual(groupBrowseFacetOptions(["6.13.10", "6.13", "3.12.6", "3.12"], formatArcaeaAddedVersion), [
    { label: "6.13", values: ["6.13.10", "6.13"] },
    { label: "3.12", values: ["3.12.6", "3.12"] },
  ]);
});

test("Arcaea 7.0 exposes exactly four Inscribed songs and keeps the filter shareable", () => {
  const expected = new Set(["dreadarea", "rivenpilgrim", "cataclysmcry", "deinosphainein"]);
  const inscribedSongs = formalBrowse.arcaea.items.filter((item) => item.recordKind === "song" && item.charts.some((chart) => "difficultyClass" in chart && chart.difficultyClass === "INSCRIBED"));
  assert.deepEqual(new Set(inscribedSongs.map((item) => item.songId)), expected);
  const filtered = filterBrowseItems(formalBrowse.arcaea.items, arcaeaState({ chart: ["INSCRIBED"] }));
  assert.deepEqual(new Set(filtered.map((item) => item.songId)), expected);
  const state = arcaeaState({ chart: ["INSCRIBED", "FTR"] });
  assert.equal(serializeBrowseUrlState(state).toString(), "chart=FTR%2CINSCRIBED");
  assert.deepEqual(parseBrowseUrlState("arcaea", "chart=INSCRIBED", formalBrowse.arcaea.items), arcaeaState({ chart: ["INSCRIBED"] }));
});

test("Browse URL state round-trips multi-select facets with stable encoding", () => {
  const state = arcaeaState({ pack: ["World Extend 4", "Absolute Reason"], chart: ["BYD", "FTR"], level: ["10+", "9"], version: ["6.9", "6.10"], ai: true });
  const serialized = serializeBrowseUrlState(state).toString();
  assert.match(serialized, /chart=FTR%2CBYD/u);
  assert.match(serialized, /ai=1/u);
  const parsed = parseBrowseUrlState("arcaea", serialized, formalBrowse.arcaea.items);
  assert.deepEqual(parsed, arcaeaState({ pack: ["Absolute Reason", "World Extend 4"], chart: ["FTR", "BYD"], level: ["9", "10+"], version: ["6.10", "6.9"], ai: true }));
  assert.equal(serializeBrowseUrlState(parsed).toString(), serialized);

  const phigrosState = phigrosStateFor({ q: " After ", chart: ["AT", "EZ"], sort: "title-desc" });
  assert.equal(serializeBrowseUrlState(phigrosState).toString(), "q=After&sort=title-desc&chart=EZ%2CAT");
  assert.deepEqual(parseBrowseUrlState("phigros", serializeBrowseUrlState(phigrosState), formalBrowse.phigros.items), phigrosStateFor({ q: "After", chart: ["EZ", "AT"], sort: "title-desc" }));
});

test("Browse pagination starts at 48 and reset state is empty without changing selection identity", () => {
  assert.equal(BROWSE_PAGE_SIZE, 48);
  assert.deepEqual(defaultBrowseUrlState("arcaea"), arcaeaState());
  const item = makeArcaeaItem({
    artworks: [makeArtwork("default-resource", "default"), makeArtwork("byd-resource", "difficulty", "BYD")],
    charts: [{ difficultyClass: "BYD", displayLevel: "10", title: "BYD Title", artist: "BYD Artist" }],
  });
  const displayed = displayBrowseItem(item, ["BYD"]);
  assert.equal(displayed.resourceId, "byd-resource");
  assert.equal(displayed.route, "/r/byd-resource/");
  assert.equal(displayed.displayTitle, "BYD Title");
  assert.equal(displayed.artist, "BYD Artist");
  assert.notEqual(displayed.resourceId, item.artworks.find((artwork) => artwork.role === "default")?.resourceId);
});

test("Phigros projection keeps current, special, archive, and source-only boundaries", () => {
  const kinds = countKinds(formalBrowse.phigros.items);
  assert.deepEqual(kinds, { track: 313, special: 33, "archive-extra": 7 });
  assert.equal(formalBrowse.diagnostics.phigros.skipped.length, 6);
  assert.ok(formalBrowse.diagnostics.phigros.skipped.every((item) => item.identity.includes("Random.SobremSilentroom")));
  assert.equal(formalBrowse.phigros.items.some((item) => item.sourceIdentityCandidate?.endsWith("Random.SobremSilentroom.1/")), false);
  assert.equal(formalBrowse.phigros.items.some((item) => item.sourceIdentityCandidate?.endsWith("Random.SobremSilentroom.6/")), false);
  assert.equal(formalBrowse.phigros.items.some((item) => item.displayTitle === "Random"), true);
  assert.equal(formalBrowse.phigros.items.some((item) => item.displayTitle === "INTRODUCTION"), true);
});

test("Phigros falls back to a reliable source artist while preserving source search terms", () => {
  const noDisplayArtist = formalBrowse.phigros.items.find((item) => item.sourceTitle === "000AinSophAur");
  assert.ok(noDisplayArtist);
  assert.equal(noDisplayArtist.artist, "Yumeji");
  assert.equal(noDisplayArtist.sourceArtist, "Yumeji");
  assert.equal(filterBrowseItems(formalBrowse.phigros.items, phigrosStateFor({ q: "000AinSophAur" })).some((item) => item.key === noDisplayArtist.key), true);
  assert.equal(filterBrowseItems(formalBrowse.phigros.items, phigrosStateFor({ q: "Yumeji" })).some((item) => item.key === noDisplayArtist.key), true);
});

test("Phigros primary difficulty facets use structural charts and exclude Legacy/Error", () => {
  const options = getBrowseFacetOptions(formalBrowse.phigros);
  assert.deepEqual(options.charts, ["EZ", "HD", "IN", "AT"]);
  assert.ok(!options.charts.includes("Legacy" as never));
  const legacy = formalBrowse.phigros.items.find((item) => item.charts.some((chart) => "structurallyPresent" in chart && chart.difficultyClass === "Legacy"));
  assert.ok(legacy);
  assert.equal(filterBrowseItems([legacy], phigrosStateFor({ chart: ["AT"] })).length, 0);
  const errorTrack = formalBrowse.phigros.items.find((item) => item.charts.some((chart) => "errorVariant" in chart && chart.errorVariant));
  assert.ok(errorTrack);
  assert.equal(options.charts.includes("Error" as never), false);
});

test("Phigros special and archive records stay separate even with repeated titles", () => {
  const matches = filterBrowseItems(formalBrowse.phigros.items, phigrosStateFor({ q: "After ZABANIYA" }));
  assert.equal(matches.length, 2);
  assert.deepEqual(new Set(matches.map((item) => item.recordKind)), new Set(["track", "special"]));
  assert.equal(new Set(matches.map((item) => item.resourceId)).size, 2);
  assert.equal(formalBrowse.phigros.items.filter((item) => item.recordKind === "archive-extra").length, 7);
});

test("In Falsus exposes chart difficulties and keeps the filter state shareable", () => {
  const options = getBrowseFacetOptions(formalBrowse.infalsus);
  assert.deepEqual(options.charts, ["MIN", "EVO", "ULT", "FBD"]);
  const ultState: InfalsusBrowseUrlState = { game: "infalsus", q: "", sort: "default", chart: ["ULT"] };
  const filtered = filterBrowseItems(formalBrowse.infalsus.items, ultState);
  assert.equal(filtered.length, formalBrowse.infalsus.items.length);
  assert.ok(filtered.every((item) => item.charts.some((chart) => "difficulty" in chart && chart.difficulty === "ULT")));
  const serialized = serializeBrowseUrlState(ultState).toString();
  assert.equal(serialized, "chart=ULT");
  assert.deepEqual(parseBrowseUrlState("infalsus", serialized, formalBrowse.infalsus.items), ultState);
});

test("Rizline Browse groups one card per Song and preserves all artwork variants", () => {
  const songs = formalBrowse.rizline.items.filter((item) => item.recordKind === "song");
  assert.equal(songs.length, 143);
  assert.equal(new Set(songs.map((item) => item.songId)).size, 143);
  assert.equal(songs.reduce((sum, item) => sum + item.artworks.length, 0), 146);
  assert.ok(songs.every((item) => item.game === "rizline"));
  assert.ok(songs.every((item) => item.game !== "phigros"));
  assert.ok(songs.some((item) => item.artworks.length > 1));
  assert.ok(songs.some((item) => item.artworks.some((artwork) => artwork.variantKey === "cn")));
  assert.equal(formalBrowse.diagnostics.rizline.skipped.length, 0);
  assert.deepEqual(defaultBrowseUrlState("rizline"), { game: "rizline", q: "", sort: "default", disc: [], series: [], chart: [] });
  const first = songs[0]!;
  const state = parseBrowseUrlState("rizline", "q=" + encodeURIComponent(first.displayTitle) + "&sort=title-desc", songs);
  assert.equal(state.game, "rizline");
  assert.equal(filterBrowseItems(songs, state).length, 1);
  const facetOptions = getBrowseFacetOptions(formalBrowse.rizline) as RizlineFacetOptions;
  assert.deepEqual(facetOptions.discs, ["Disc 1", "Disc 2", "Disc O", "EX - Single", "EX - T.S."]);
  assert.equal(facetOptions.trackSeries.length, 19);
  assert.deepEqual(facetOptions.trackSeries, [
    "Paradigm: Reboot collaboration",
    "T.S. #1 — Juggernaut.",
    "T.S. #2 — DIVERSE SYSTEM",
    "T.S. #3 — Sobrem",
    "T.S. #4 — Tone Sphere",
    "T.S. #5 — BlackY",
    "T.S. #6 — Cytus II × Muse Dash",
    "T.S. #7 — KALPA",
    "T.S. #8 — Rotaeno",
    "T.S. #9 — Cosmic Radio 2024",
    "T.S. #10 — HARDCORE TANO*C",
    "T.S. #11 — DEEMO II",
    "T.S. #12 — kuro",
    "T.S. #13 — 天地万象",
    "T.S. #14 — Tanchiky",
    "T.S. #15 — ルゼ & LisicA",
    "T.S. #16 — 古韻今声 / Diachronic Resonance",
    "T.S. SP — Phigros",
    "去远方 collaboration",
  ]);
  const discState: RizlineBrowseUrlState = { game: "rizline", q: "", sort: "default", disc: ["Disc 1"], series: [], chart: [] };
  assert.ok(filterBrowseItems(songs, discState).every((item) => item.disc === "Disc 1"));
  const targetSeries = facetOptions.trackSeries.find((value) => value.includes("T.S. #1"))!;
  const seriesState: RizlineBrowseUrlState = { game: "rizline", q: "", sort: "default", disc: [], series: [targetSeries], chart: [] };
  assert.ok(filterBrowseItems(songs, seriesState).length > 0);
  assert.ok(filterBrowseItems(songs, seriesState).every((item) => item.trackSeries?.includes(targetSeries)));
  const serialized = serializeBrowseUrlState(seriesState).toString();
  assert.match(serialized, /series=/u);
  assert.deepEqual(parseBrowseUrlState("rizline", serialized, songs), seriesState);
});

test("jacket Gallery has its own browse path and no longer filters by Resource Variant difficulty", () => {
  const page = fs.readFileSync(path.join(process.cwd(), "apps", "site", "src", "pages", "[game]", "[category]", "index.astro"), "utf8");
  const browseScript = fs.readFileSync(path.join(process.cwd(), "apps", "site", "src", "scripts", "browse-gallery.ts"), "utf8");
  assert.match(page, /BrowseGallery/u);
  assert.match(page, /data\/browse\/\$\{game\.slug\}\/jacket\.json/u);
  assert.match(page, /browseByGame\[game\.slug\]/u);
  assert.doesNotMatch(page, /game\.slug === "arcaea" \? browseBuild\.arcaea : browseBuild\.phigros/u);
  assert.doesNotMatch(browseScript, /variant\.difficulty/u);
});

test("Phigros chart selections are retained by the client state bridge", () => {
  const browseScript = fs.readFileSync(path.join(process.cwd(), "apps", "site", "src", "scripts", "browse-gallery.ts"), "utf8");
  assert.doesNotMatch(browseScript, /gameId === "phigros" \? \{\.\.\.parsed, chart: \[\] \}/u);
  assert.match(browseScript, /game === "phigros"\).*selectedValues\(root, "chart"\)/u);
  assert.match(browseScript, /data\.game === "phigros" \|\| data\.game === "infalsus" \|\| data\.game === "rizline"/u);
});

function makeResource(resourceId: string, hasUpscaled = false): BrowseResolvedResource {
  const preview = {
    small: { url: `https://cdn.test/${resourceId}-small.jpg`, width: 320, height: 320, mime: "image/jpeg" },
    medium: { url: `https://cdn.test/${resourceId}-medium.jpg`, width: 640, height: 640, mime: "image/jpeg" },
    large: { url: `https://cdn.test/${resourceId}-large.jpg`, width: 1280, height: 1280, mime: "image/jpeg" },
  };
  const original = { url: `https://cdn.test/${resourceId}.jpg`, downloadFilename: `${resourceId}.jpg`, mime: "image/jpeg", sizeBytes: 100 };
  return {
    resourceId,
    route: `/r/${resourceId}/`,
    resourceType: "jacket",
    preview,
    original,
    ...(hasUpscaled ? { upscaled: { ...original, url: `https://cdn.test/${resourceId}-upscaled.jpg` } } : {}),
    hasUpscaled,
  };
}

function makeArtwork(resourceId: string, role: string, difficultyClass?: "PST" | "PRS" | "FTR" | "BYD" | "ETR" | "INSCRIBED"): BrowseArtwork {
  return { ...makeResource(resourceId), role, ...(difficultyClass ? { difficultyClass } : {}) };
}

function makeArcaeaItem(overrides: Partial<BrowseGalleryItem> = {}): BrowseGalleryItem {
  const resource = makeResource("default-resource");
  return {
    ...resource,
    key: "song:test",
    game: "arcaea",
    recordKind: "song",
    displayTitle: "Song",
    artist: "Artist",
    searchTerms: ["Song", "Artist", "Pack"],
    titleAliases: [],
    artistAliases: [],
    charts: [{ difficultyClass: "FTR", displayLevel: "9" }],
    artworks: [makeArtwork("default-resource", "default")],
    artworkRole: "default",
    songId: "test",
    pack: "Pack",
    version: "6.10",
    date: null,
    orderHint: 0,
    sortIndex: 0,
    ...overrides,
  };
}

function arcaeaState(overrides: Partial<ArcaeaBrowseUrlState> = {}): ArcaeaBrowseUrlState {
  return { game: "arcaea", q: "", sort: "default", pack: [], chart: [], level: [], version: [], ai: false, ...overrides };
}

function phigrosStateFor(overrides: Partial<PhigrosBrowseUrlState> = {}): PhigrosBrowseUrlState {
  return { game: "phigros", q: "", sort: "default", chart: [], ...overrides };
}

function countKinds(items: BrowseGalleryItem[]): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    counts[item.recordKind] = (counts[item.recordKind] ?? 0) + 1;
    return counts;
  }, {});
}

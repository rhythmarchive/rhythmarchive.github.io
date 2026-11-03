import assert from "node:assert/strict";
import test from "node:test";
import { arcaeaPackLabel, arcaeaPackName, localizeArcaeaPackNames } from "../src/lib/arcaea-pack-names";
import { defaultBrowseUrlState, filterBrowseItems, formatBrowsePackLabel, getBrowseFacetOptions, parseBrowseUrlState, serializeBrowseUrlState, type ArcaeaFacetOptions, type ArcaeaBrowseUrlState } from "../src/lib/browse-gallery";
import { browseCardView } from "../src/lib/card-view-model";
import { getCategoryBrowseConfig } from "../src/lib/category-browse";
import { browserBrowseData } from "../src/lib/gallery-projection";
import { getBrowseGalleryBuild, getSiteData, loadFormalBrowseProjections } from "../src/lib/site-data";

const data = getSiteData();
const browse = getBrowseGalleryBuild().arcaea;
const state = (overrides: Partial<ArcaeaBrowseUrlState> = {}): ArcaeaBrowseUrlState => ({ ...defaultBrowseUrlState("arcaea") as ArcaeaBrowseUrlState, ...overrides });

test("official pack labels distinguish collaboration appends and preserve untranslated names", () => {
  assert.equal(arcaeaPackLabel("Divine Oblivion"), "Divine Oblivion（神圣毁灭）");
  assert.equal(arcaeaPackName("CHUNITHM · Collaboration Chapter 2"), "CHUNITHM · 第二章");
  assert.equal(arcaeaPackName("maimai · Collaboration Chapter 2"), "maimai · 第二章");
  assert.equal(arcaeaPackLabel("Memory Archive"), "Memory Archive");
  assert.equal(arcaeaPackName("Collaboration Chapter 2"), "Collaboration Chapter 2");
  assert.equal(arcaeaPackName("An unverified future pack"), "An unverified future pack");
});

test("Chinese pack search and labels keep the existing English filter URL and resource identity", () => {
  const expected = filterBrowseItems(browse.items, state({ pack: ["Eternal Core"] }));
  assert.ok(expected.length > 0);
  for (const query of ["永恒核心", "Eternal Core"]) {
    const results = filterBrowseItems(browse.items, state({ q: query }));
    assert.deepEqual(new Set(results.map(item => item.key)), new Set(expected.map(item => item.key)));
  }
  const restored = parseBrowseUrlState("arcaea", "pack=Eternal%20Core", browse.items);
  assert.ok(restored.game === "arcaea");
  assert.deepEqual(restored.pack, ["Eternal Core"]);
  assert.equal(serializeBrowseUrlState(restored).get("pack"), "Eternal Core");
  assert.deepEqual(filterBrowseItems(browse.items, restored).map(item => item.resourceId), expected.map(item => item.resourceId));
  const options = getBrowseFacetOptions(browse) as ArcaeaFacetOptions;
  assert.ok(options.packs.includes("Eternal Core"));
  assert.equal(formatBrowsePackLabel("Eternal Core", options.packLabels), "Eternal Core（永恒核心）");
  assert.ok(browseCardView(expected[0]!).labels.includes("Eternal Core（永恒核心）"));
  assert.ok(!browseCardView(expected[0]!).labels.includes("Eternal Core"));
  const client = browserBrowseData(browse).items.find(item => item.key === expected[0]!.key);
  assert.ok(client && "packLabel" in client && "pack" in client);
  assert.equal(client?.packLabel, "Eternal Core（永恒核心）");
  assert.equal(client?.pack, "Eternal Core");
  assert.equal(loadFormalBrowseProjections().arcaea.songs.find(song => song.pack.packId === "core")?.pack.displayName, "Eternal Core");
});

test("pack cover titles, detail metadata and global search keep both names without changing facets", () => {
  const core = data.resources.find(resource => resource.game === "arcaea" && resource.resourceType === "pack-cover" && resource.facets?.pack?.includes("Eternal Core"));
  assert.ok(core);
  assert.equal(core.displayTitle, "Eternal Core（永恒核心）");
  assert.equal(core.metadata.pack, "Eternal Core（永恒核心）");
  assert.deepEqual(core.facets?.pack, ["Eternal Core"]);
  const search = data.searchIndex.find(entry => entry.resourceId === core.resourceId);
  assert.ok(search?.keywords.includes("永恒核心"));
  assert.ok(search?.keywords.includes("Eternal Core"));
  const newCovers = data.resources.filter(resource => resource.game === "arcaea" && resource.resourceType === "pack-cover" && resource.metadata.pack === "Divine Oblivion（神圣毁灭）");
  assert.equal(newCovers.length, 2);
  assert.ok(newCovers.every(resource => resource.displayTitle === "Divine Oblivion（神圣毁灭）"));
  const jacket = data.resources.find(resource => resource.resourceId === filterBrowseItems(browse.items, state({ pack: ["Eternal Core"] }))[0]?.resourceId);
  assert.equal(jacket?.metadata.pack, "Eternal Core（永恒核心）");
  const unrelated = data.resources.find(resource => resource.game === "phigros")!;
  assert.equal(localizeArcaeaPackNames(unrelated), unrelated);
});

test("story chapter filters expose both names while retaining their stored English value", () => {
  const resources = data.galleries["arcaea/story-cg"] ?? [];
  const config = getCategoryBrowseConfig("arcaea", "story-cg", resources);
  const core = config.facets.find(facet => facet.key === "path")?.options.find(option => option.value === "Eternal Core");
  assert.deepEqual(core, { value: "Eternal Core", label: "Eternal Core（永恒核心）" });
  const cg = resources.find(resource => resource.metadata.storyPathTitle === "Eternal Core（永恒核心）");
  assert.ok(cg);
  assert.equal(cg.displayTitle, "Eternal Core（永恒核心）");
});

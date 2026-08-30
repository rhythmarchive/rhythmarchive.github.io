import assert from "node:assert/strict";
import test from "node:test";
import { displayNodeKey, parseStoryTextBlocks, parseVnsScript } from "../../../tools/arcaea-story-audit.js";
import { boundsContains, boundsIntersect, buildArcaeaStoryAtlasLayout } from "../src/lib/arcaea-story-layout.js";
import { buildArcaeaStoryExplorerModel, isArcaeaStoryCgResource, isArcaeaVnCgResource } from "../src/lib/arcaea-story-explorer.js";
import { getSiteData, loadCategoryBrowseProjections } from "../src/lib/site-data.js";
import type { PublicResource } from "../src/lib/types.js";

test("Arcaea Story Mode explorer keeps APK Act/Part, Path and Entry order", () => {
  const siteData = getSiteData();
  const structure = loadCategoryBrowseProjections().arcaea.storyStructure;
  const storyAtlas = loadCategoryBrowseProjections().arcaea.storyAtlas;
  assert.ok(structure);
  assert.ok(storyAtlas);
  const story = siteData.galleries["arcaea/story-cg"] ?? [];
  const model = buildArcaeaStoryExplorerModel(story, structure, storyAtlas);

  assert.equal(structure.source.packageVersion, "7.0.0c");
  assert.deepEqual(model.sections.map((section) => section.label), [
    "Act I · Part I",
    "Act I · Part II",
    "Act I · Part III",
    "Act II · Part I",
    "Act II · Part II",
  ]);
  assert.deepEqual(model.sections.at(-1)?.paths.map((path) => path.pathId), [29, 30, 31, 32, 33]);
  const divine = model.paths.find((path) => path.pathId === 33);
  assert.ok(divine);
  assert.deepEqual(divine.entries.map((entry) => entry.key), ["C-1", "C-2", "C-3", "C-4", "C-5", "C-6", "C-7", "C-8", "C-9"]);
  assert.deepEqual(divine.entries.map((entry) => entry.resources.length), [0, 2, 0, 0, 1, 0, 3, 0, 3]);
  assert.equal(divine.vnResources.length, 5);
  assert.equal(divine.entries.find((entry) => entry.key === "C-8")?.staffRoll, true);
  assert.equal(model.counts.total, 71);
  assert.equal(model.counts.storyCg, 66);
  assert.equal(model.counts.vnCg, 5);
  assert.equal(model.counts.unassigned, 0);
  assert.equal(model.counts.assigned + model.counts.unassigned, model.counts.total);
  assert.equal(model.counts.pathScenes, 2);
  assert.equal(model.counts.vnScenes, 16);
  assert.equal(model.counts.textEntries, 195);
  assert.equal(model.paths.flatMap((path) => path.entries).every((entry) => Boolean(entry.text?.texts["zh-Hans"])), true);
  assert.equal(model.paths.flatMap((path) => path.entries).find((entry) => entry.key === "C-7")?.resources.length, 3);
});

test("Arcaea Story Mode explorer excludes unreviewed story-texture images", () => {
  const siteData = getSiteData();
  const structure = loadCategoryBrowseProjections().arcaea.storyStructure;
  assert.ok(structure);
  const story = siteData.galleries["arcaea/story-cg"] ?? [];
  const vnCg = story.find(isArcaeaVnCgResource);
  assert.ok(vnCg);
  assert.equal(story.filter(isArcaeaVnCgResource).length, 5);

  const texture = {
    ...vnCg,
    resourceId: "01a00093-dc47-7763-9d18-4874af644b8a",
    resourceType: "story-texture",
    metadata: { ...vnCg.metadata, storyVisualKind: "background" },
  } satisfies PublicResource;
  assert.equal(isArcaeaStoryCgResource(texture), false);
  const model = buildArcaeaStoryExplorerModel([...story, texture], structure);
  assert.equal(model.counts.total, 71);
  assert.equal(model.unassignedResources.some((resource) => resource.resourceId === texture.resourceId), false);
});

test("Arcaea Story Mode maps APK Entry icons into an isolated UI projection", () => {
  const siteData = getSiteData();
  const structure = loadCategoryBrowseProjections().arcaea.storyStructure;
  assert.ok(structure);
  const storyUi = siteData.storyUi.arcaea;

  assert.ok(storyUi["act-bg.jpg"]);
  assert.ok(storyUi["act-title-backing.png"]);
  assert.ok(storyUi["story_pack_divider_horizontal.png"]);
  assert.ok(storyUi["button_back.png"]);
  assert.ok(storyUi["character_bg_panel_single_vert.png"]);
  assert.ok(storyUi["character_bg_panel_double_vert.png"]);
  assert.ok(storyUi["entry_konzetsu_2.png"]);
  assert.ok(storyUi["cell-vs7.png"]);
  assert.equal(siteData.galleries["arcaea/all"]?.filter((resource) => resource.resourceType === "story-texture").length, 5);

  assert.equal(structure.nodeIcons["C-2"], "entry_konzetsu_2");
  assert.equal(structure.nodeIcons["VS-7"], "cell-vs7");
  assert.equal(structure.nodeIcons["18-7"], "entry_nihil");
  assert.equal(structure.nodeIcons["19-8"], "entry_rotaeno_boss");
  const allStoryNodes = structure.paths.flatMap((path) => path.nodes);
  assert.equal(allStoryNodes.every((nodeKey) => Boolean(structure.nodeIcons[nodeKey])), true);
  const model = buildArcaeaStoryExplorerModel(siteData.galleries["arcaea/story-cg"] ?? [], structure);
  assert.equal(model.paths.find((path) => path.pathId === 33)?.entries.find((entry) => entry.key === "C-2")?.iconKey, "entry_konzetsu_2");
});

test("Arcaea Story Mode keeps APK source filenames separate from displayed Entry keys", () => {
  const siteData = getSiteData();
  const structure = loadCategoryBrowseProjections().arcaea.storyStructure;
  assert.ok(structure);
  const story = siteData.galleries["arcaea/story-cg"] ?? [];

  const rotaenoOne = story.find((resource) => resource.metadata.storyNode === "19-1");
  const rotaenoTwo = story.find((resource) => resource.metadata.storyNode === "19-2");
  assert.equal(rotaenoOne?.metadata.storyPathTitle, "Rotaeno");
  assert.equal(rotaenoTwo?.metadata.storyPathTitle, "Rotaeno");
  assert.ok(rotaenoOne?.searchTerms?.some((term) => term.endsWith("story/cg/18-1.jpg")));
  assert.ok(rotaenoTwo?.searchTerms?.some((term) => term.endsWith("story/cg/18-2.jpg")));
  assert.equal(story.some((resource) => resource.metadata.storyNode === "18-1" && resource.metadata.storyPathTitle === "Absolute Nihil"), false);

  assert.deepEqual(structure.paths.find((path) => path.pathId === 28)?.characters, [11, 12]);
  assert.deepEqual(structure.paths.find((path) => path.pathId === 1)?.characters, [0, 1]);
  assert.equal(structure.nodeLinks.some((link) => link.from === "1-9" && link.to === "V-0" && link.kind === "merge"), true);
  assert.equal(structure.nodeLinks.some((link) => link.from === "2-9" && link.to === "V-0" && link.kind === "merge"), true);

  const model = buildArcaeaStoryExplorerModel(story, structure);
  const eternalCore = model.paths.find((path) => path.pathId === 1);
  const viciousLabyrinth = model.paths.find((path) => path.pathId === 2);
  assert.deepEqual(eternalCore?.rootEntries, ["1-1", "2-1"]);
  assert.equal(viciousLabyrinth?.connections.some((link) => link.from === "2-5" && link.to === "2-D" && link.kind === "branch"), true);
  assert.equal(viciousLabyrinth?.connections.some((link) => link.from === "2-5" && link.to === "2-7" && link.kind === "branch"), true);
  assert.equal(viciousLabyrinth?.externalConnections.some((link) => link.from === "1-9" && link.to === "V-0" && link.kind === "merge"), true);
  assert.equal(viciousLabyrinth?.connections.filter((link) => link.kind === "branch").every((link) => link.provenance === "audited"), true);
  assert.equal(model.paths.some((path) => path.connections.some((link) => link.provenance === "sequential-fallback")), true);
});

test("Arcaea Story text parser preserves pages, CG events and VN controls separately", () => {
  const blocks = parseStoryTextBlocks("Opening|%%CG:app-data/story/cg/C-7-2.jpg%%|After");
  assert.deepEqual(blocks, [
    { kind: "paragraph", page: 0, text: "Opening" },
    { kind: "display-event", page: 1, event: "cg", assetPath: "assets/app-data/story/cg/C-7-2.jpg" },
    { kind: "paragraph", page: 2, text: "After" },
  ]);
  const script = parseVnsScript(
    'say "Read this line"\nshow "vn/res/cg/F-7.jpg"\nmove "vn/res/cg/F-7.jpg"\nplay "vn/res/bgm/wind.ogg"',
    "assets/app-data/story/vn/test_zh-Hans.vns",
    "test",
    "zh-Hans",
  );
  assert.deepEqual(script.sayBlocks, [{ page: 0, text: "Read this line" }]);
  assert.deepEqual(script.visualReferences, [{ assetPath: "assets/app-data/story/vn/res/cg/F-7.jpg", commands: ["move", "show"] }]);
  assert.deepEqual(script.audioReferences, [{ assetPath: "assets/app-data/story/vn/res/bgm/wind.ogg", commands: ["play"] }]);
  assert.equal(script.commandCounts.show, 1);
  assert.equal(script.commandCounts.play, 1);
});

test("Arcaea Story projection keeps locale/source/provenance and deterministic Atlas layout", () => {
  const siteData = getSiteData();
  const browse = loadCategoryBrowseProjections().arcaea;
  assert.ok(browse.storyStructure);
  assert.ok(browse.storyAtlas);
  const first = browse.storyAtlas.text.entries.find((entry) => entry.nodeKey === "1-ZR");
  assert.equal(first?.sourcePath, "assets/app-data/story/main/entries_1");
  assert.equal(first?.texts["zh-Hans"]?.sourcePath, "assets/app-data/story/main/vn");
  assert.equal(first?.texts["zh-Hans"]?.parserVersion, "arcaea-story-parser/1");
  assert.deepEqual(first?.texts["zh-Hans"]?.blocks.map((block) => block.kind), ["paragraph", "paragraph"]);
  const c7 = browse.storyAtlas.text.entries.find((entry) => entry.nodeKey === "C-7");
  assert.equal(c7?.storyCgPaths.length, 3);
  assert.equal(c7?.texts["zh-Hans"]?.blocks.filter((block) => block.event === "cg").length, 2);
  const evidence = browse.storyAtlas.relationEvidence;
  assert.equal(evidence.length, 19);
  assert.equal(evidence.filter((item) => item.finalRelation === "node").length, 17);
  assert.equal(evidence.filter((item) => item.finalRelation === "path-scene").length, 2);
  assert.equal(evidence.every((item) => item.evidence.length > 0), true);
  assert.equal(evidence.find((item) => item.assetPath.endsWith("/E-1_epilogue.jpg"))?.finalRelation, "path-scene");
  assert.equal(evidence.find((item) => item.assetPath.endsWith("/E-1_epilogue.jpg"))?.finalNodeKey, undefined);
  const derivatives = browse.storyAtlas.derivatives;
  assert.ok(derivatives);
  assert.equal(Object.keys(derivatives.ui).length, 97);
  assert.equal(Object.keys(derivatives.avatars).length, 21);
  assert.equal(Object.keys(derivatives.resources).length, 71);
  const derivativeAssets = Object.values(derivatives.resources).flatMap((group) => [group.thumb, group.preview]);
  assert.equal(derivativeAssets.every((asset) => asset.url.startsWith("/generated/arcaea/story/")), true);
  assert.equal(derivativeAssets.every((asset) => asset.mime === "image/webp" && asset.sizeBytes > 0), true);
  assert.equal(derivativeAssets.filter((asset) => asset.url.includes("/cg/thumb/")).every((asset) => asset.sizeBytes <= 150_000), true);
  assert.equal(derivativeAssets.filter((asset) => asset.url.includes("/cg/preview/")).every((asset) => asset.sizeBytes <= 300_000), true);
  const searchable = browse.storyAtlas.searchIndex.find((entry) => entry.nodeKey === "1-ZR");
  assert.ok(searchable);
  assert.equal(searchable.terms.includes("1-ZR"), true);
  assert.equal(searchable.terms.includes("hikari"), true);
  assert.equal(browse.storyAtlas.searchIndex.some((entry) => entry.terms.includes("Luminous Sky")), true);
  const section = buildArcaeaStoryExplorerModel(siteData.galleries["arcaea/story-cg"] ?? [], browse.storyStructure, browse.storyAtlas).sections[0];
  assert.ok(section);
  const firstLayout = buildArcaeaStoryAtlasLayout(section);
  const secondLayout = buildArcaeaStoryAtlasLayout(section);
  assert.deepEqual(firstLayout, secondLayout);
  assert.equal(firstLayout.lines.some((line) => line.provenance === "audited"), true);
  assert.equal(firstLayout.lines.every((line) => line.x1 !== line.x2 || line.y1 !== line.y2), true);
});

test("Arcaea Story Atlas content-aware layout contains interactive content and separates Path bounds", () => {
  const siteData = getSiteData();
  const browse = loadCategoryBrowseProjections().arcaea;
  assert.ok(browse.storyStructure);
  const model = buildArcaeaStoryExplorerModel(siteData.galleries["arcaea/story-cg"] ?? [], browse.storyStructure, browse.storyAtlas);

  for (const section of model.sections) {
    const layout = buildArcaeaStoryAtlasLayout(section);
    assert.deepEqual(layout, buildArcaeaStoryAtlasLayout(section));
    for (const pathLayout of layout.paths) {
      assert.equal(boundsContains(pathLayout.bounds, pathLayout.interactiveBounds), true);
      assert.equal(boundsContains(pathLayout.interactiveBounds, pathLayout.titleBounds), true);
      assert.ok(Object.values(pathLayout.nodeBounds).every((bounds) => boundsContains(pathLayout.interactiveBounds, bounds)));
      assert.ok(pathLayout.avatarBounds.every((bounds) => boundsContains(pathLayout.interactiveBounds, bounds)));
      assert.ok(Object.values(pathLayout.sceneBounds).every((bounds) => boundsContains(pathLayout.interactiveBounds, bounds)));
      assert.equal(boundsContains(layout.worldBounds, pathLayout.interactiveBounds), true);
    }
    for (let left = 0; left < layout.paths.length; left += 1) {
      for (let right = left + 1; right < layout.paths.length; right += 1) {
        assert.equal(boundsIntersect(layout.paths[left]!.interactiveBounds, layout.paths[right]!.interactiveBounds), false, `${section.label}: Path interactive bounds overlap`);
      }
    }
    const nodePoints = layout.paths.flatMap((pathLayout) => Object.values(pathLayout.nodes));
    assert.ok(layout.lines.every((line) => nodePoints.some((point) => point.x === line.x1 && point.y === line.y1) && nodePoints.some((point) => point.x === line.x2 && point.y === line.y2)));
  }
});

test("Arcaea Story display key mapping follows alternate prefix/suffix fields", () => {
  assert.equal(displayNodeKey("24", { minor: 7, alternatePrefix: "C" }, 7), "C-7");
  assert.equal(displayNodeKey("1", { minor: 6, alternateSuffix: "ZR" }, 6), "1-ZR");
});

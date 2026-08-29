import assert from "node:assert/strict";
import test from "node:test";
import { buildArcaeaStoryExplorerModel, isArcaeaStoryCgResource, isArcaeaVnCgResource } from "../src/lib/arcaea-story-explorer.js";
import { getSiteData, loadCategoryBrowseProjections } from "../src/lib/site-data.js";
import type { PublicResource } from "../src/lib/types.js";

test("Arcaea Story Mode explorer keeps APK Act/Part, Path and Entry order", () => {
  const siteData = getSiteData();
  const structure = loadCategoryBrowseProjections().arcaea.storyStructure;
  assert.ok(structure);
  const story = siteData.galleries["arcaea/story-cg"] ?? [];
  const model = buildArcaeaStoryExplorerModel(story, structure);

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
  assert.equal(model.counts.unassigned, 19);
  assert.equal(model.counts.assigned + model.counts.unassigned, model.counts.total);
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
});

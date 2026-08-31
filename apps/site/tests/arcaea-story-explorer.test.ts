import assert from "node:assert/strict";
import test from "node:test";
import { displayNodeKey, parseStoryTextBlocks, parseVnsScript } from "../../../tools/arcaea-story-audit.js";
import { buildArcaeaStoryAtlasLayout, buildArcaeaStorySubworldLayout } from "../src/lib/arcaea-story-layout.js";
import { buildArcaeaStoryExplorerModel, isArcaeaStoryCgResource, isArcaeaVnCgResource } from "../src/lib/arcaea-story-explorer.js";
import { getSiteData, loadCategoryBrowseProjections } from "../src/lib/site-data.js";
import type { PublicResource } from "../src/lib/types.js";

test("Arcaea Story Mode explorer keeps APK Act/Part, Path and Entry order", () => {
  const siteData = getSiteData();
  const structure = loadCategoryBrowseProjections().arcaea.storyStructure;
  const storyAtlas = loadCategoryBrowseProjections().arcaea.storyAtlas;
  assert.ok(structure);
  assert.ok(storyAtlas);
  assert.equal(storyAtlas.schemaVersion, 3);
  const story = siteData.galleries["arcaea/story-cg"] ?? [];
  const model = buildArcaeaStoryExplorerModel(story, structure, storyAtlas);
  const separator = String.fromCharCode(0x00b7);

  assert.equal(structure.source.packageVersion, "7.0.0c");
  assert.deepEqual(model.sections.map((section) => section.label), [
    "Act I " + separator + " Part I",
    "Act I " + separator + " Part II",
    "Act I " + separator + " Part III",
    "Act II " + separator + " Part I",
    "Act II " + separator + " Part II",
  ]);
  assert.deepEqual(model.sections.at(-1)?.paths.map((path) => path.pathId), [29, 30, 31, 32, 33]);
  const divine = model.paths.find((path) => path.pathId === 33);
  assert.ok(divine);
  assert.deepEqual(divine.entries.map((entry) => entry.key), ["C-1", "C-2", "C-3", "C-4", "C-5", "C-6", "C-7", "C-8", "C-9"]);
  assert.deepEqual(divine.entries.map((entry) => entry.resources.length), [10, 2, 20, 11, 1, 14, 3, 30, 3]);
  assert.equal(divine.vnResources.length, 7);
  assert.equal(divine.entries.find((entry) => entry.key === "C-8")?.resources.some((resource) => resource.downloadFilename === "cat_8_1.jpg"), true);
  assert.equal(divine.unassignedCg?.displayTitle, "未归类 CG");
  assert.equal(divine.unassignedCg?.resources.length, 7);
  assert.equal(divine.entries.find((entry) => entry.key === "C-8")?.staffRoll, true);
  assert.equal(model.counts.total, 237);
  assert.equal(model.counts.storyCg, 66);
  assert.equal(model.counts.vnCg, 171);
  assert.equal(model.counts.unassigned, 24);
  assert.equal(model.counts.assigned + model.counts.unassigned, model.counts.total);
  const nestedVnCgIds = story.filter(isArcaeaVnCgResource).map((resource) => resource.resourceId).sort();
  const explorerVnCgIds = model.paths
    .flatMap((path) => [
      ...path.entries.flatMap((entry) => entry.resources),
      ...path.pathScenes.flatMap((scene) => scene.resources),
      ...(path.unassignedCg?.resources ?? []),
    ])
    .filter(isArcaeaVnCgResource)
    .map((resource) => resource.resourceId)
    .filter((resourceId, index, resourceIds) => resourceIds.indexOf(resourceId) === index)
    .sort();
  assert.deepEqual(explorerVnCgIds, nestedVnCgIds);
  assert.equal(story.some((resource) => resource.searchTerms?.some((term) => term.includes("story/vn/res/") && !term.match(/story\/vn\/res\/[^/]+\//u))), false);
  assert.equal(model.counts.pathScenes, 5);
  assert.equal(model.counts.vnScenes, 16);
  assert.equal(model.counts.textEntries, 195);
  assert.equal(model.paths.flatMap((path) => path.entries).every((entry) => Boolean(entry.text?.texts["zh-Hans"])), true);
  assert.equal(model.paths.flatMap((path) => path.entries).find((entry) => entry.key === "C-7")?.resources.length, 3);
  const finalVerdict = model.paths.find((path) => path.pathId === 19);
  assert.deepEqual(finalVerdict?.entries.find((entry) => entry.key === "E-1")?.sceneIds, ["vn:epilogue_last"]);
  assert.equal(finalVerdict?.pathScenes.find((scene) => scene.sceneId === "vn:epilogue_last")?.resources.length, 26);
  assert.equal(finalVerdict?.unassignedCg?.resources.length, 16);
});

test("Arcaea Story Mode explorer excludes unreviewed story-texture images", () => {
  const siteData = getSiteData();
  const structure = loadCategoryBrowseProjections().arcaea.storyStructure;
  assert.ok(structure);
  const story = siteData.galleries["arcaea/story-cg"] ?? [];
  const vnCg = story.find(isArcaeaVnCgResource);
  assert.ok(vnCg);
  assert.equal(story.filter(isArcaeaVnCgResource).length, 171);
  const texture = {
    ...vnCg,
    resourceId: "01a00093-dc47-7763-9d18-4874af644b8a",
    resourceType: "story-texture",
    metadata: { ...vnCg.metadata, storyVisualKind: "background" },
  } satisfies PublicResource;
  assert.equal(isArcaeaStoryCgResource(texture), false);
  const model = buildArcaeaStoryExplorerModel([...story, texture], structure);
  assert.equal(model.counts.total, 237);
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
  assert.equal(siteData.galleries["arcaea/all"]?.filter((resource) => resource.resourceType === "story-texture").length, 171);
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
  const finalVerdict = model.paths.find((path) => path.pathId === 19);
  assert.equal(finalVerdict?.connections.some((link) => link.from === "F-7" && link.to === "E-1" && link.kind === "branch"), true);
  assert.equal(finalVerdict?.connections.some((link) => link.from === "F-7" && link.to === "E-2" && link.kind === "branch"), true);
  assert.equal(finalVerdict?.connections.some((link) => link.from === "E-1" && link.to === "E-2"), false);
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
  const nestedScript = parseVnsScript(
    'show "catastrophe/cat_8_1.jpg" 0.5:0.4 0.5:0.4 0.7:0.7 fade(1,linear) normal\nhide "catastrophe/cat_8_1.jpg"',
    "assets/app-data/story/vn/catastrophe8_zh-Hans.vns",
    "catastrophe8",
    "zh-Hans",
  );
  assert.deepEqual(nestedScript.visualReferences, [{ assetPath: "assets/app-data/story/vn/res/catastrophe/cat_8_1.jpg", commands: ["hide", "show"] }]);
});

test("Arcaea authored CSB layout covers overviews, worlds, portal and opaque node keys", () => {
  const siteData = getSiteData();
  const browse = loadCategoryBrowseProjections().arcaea;
  assert.ok(browse.storyStructure);
  assert.ok(browse.storyAtlas);
  assert.equal(browse.storyAtlas.schemaVersion, 3);
  assert.equal(browse.storyAtlas.layout?.schemaVersion, 3);
  const authored = browse.storyAtlas.layout;
  assert.ok(authored);
  assert.equal(authored.sections.length, 5);
  assert.equal(authored.extractionVersion, "arcaea-story-csb-v3");
  assert.equal(authored.sections.every((section) => section.overview.csbPath.includes("overview_")), true);
  assert.equal(authored.sections.every((section) => section.world.csbPath.includes("act")), true);
  assert.equal(authored.subworlds.some((subworld) => subworld.subworldId === "final-verdict" && subworld.csbPath.endsWith("/f.csb")), true);
  assert.equal(authored.subworlds.find((subworld) => subworld.subworldId === "final-verdict")?.continuation?.csbPath.endsWith("/epilogue.csb"), true);

  const model = buildArcaeaStoryExplorerModel(siteData.galleries["arcaea/story-cg"] ?? [], browse.storyStructure, browse.storyAtlas);
  const firstLayout = buildArcaeaStoryAtlasLayout(model.sections[0]!, browse.storyAtlas);
  const vicious = firstLayout.paths.find((path) => path.path.pathId === 2);
  const luminous = firstLayout.paths.find((path) => path.path.pathId === 3);
  assert.ok(vicious);
  assert.ok(luminous);
  assert.equal(vicious.nodes["2-D"] !== undefined, true);
  assert.equal(vicious.nodes["V-0"] !== undefined, true);
  assert.equal(luminous.nodes["1-ZR"] !== undefined, true);
  const prologue = firstLayout.paths.find((path) => path.path.pathId === 0);
  const entryOneFour = luminous.nodeTransforms["1-4"];
  const firstAvatar = prologue?.avatars[0];
  assert.ok(prologue);
  assert.ok(entryOneFour);
  assert.ok(firstAvatar);
  assert.equal(entryOneFour.labelMode, "overlay");
  assert.equal(entryOneFour.label?.text, "1-4");
  assert.equal(entryOneFour.label?.fontSize, 50);
  assert.equal(entryOneFour.label?.fontResourcePath, "assets/Fonts/GeosansLight.ttf");
  assert.equal(entryOneFour.label?.horizontalAlignment, "center");
  assert.equal(entryOneFour.label?.verticalAlignment, "center");
  assert.notEqual(entryOneFour.label?.x, luminous.nodes["1-4"]?.x);
  assert.equal(firstAvatar.width, 1);
  assert.equal(firstAvatar.height, 1);
  assert.equal(firstAvatar.anchorX, 0.5);
  assert.equal(firstAvatar.anchorY, 0.5);
  assert.equal(firstAvatar.scaleX, 160);
  assert.equal(firstAvatar.scaleY, 160);
  assert.ok((prologue.avatarBounds[0]?.width ?? 0) >= 160);
  assert.equal(luminous.titleLabel?.fontResourcePath, "assets/Fonts/GeosansLight.ttf");
  assert.equal(firstLayout.lines.some((line) => line.provenance === "authored-csb" && line.pathIds.includes(2)), true);
  assert.equal(firstLayout.lines.some((line) => line.provenance === "authored-csb" && line.pathIds.includes(3)), true);
  assert.equal(firstLayout.lines.every((line) => Number.isFinite(line.x1) && Number.isFinite(line.y1) && Number.isFinite(line.x2) && Number.isFinite(line.y2)), true);
  assert.equal(firstLayout.lines.every((line) => line.x1 >= 0 && line.x2 >= 0 && line.y1 >= 0 && line.y2 >= 0), true);
  assert.equal(firstLayout.lines.every((line) => line.x1 <= firstLayout.width && line.x2 <= firstLayout.width && line.y1 <= firstLayout.height && line.y2 <= firstLayout.height), true);
  assert.equal(new Set(firstLayout.lines.map((line) => line.provenance)).has("authored-csb"), true);
  const eternalCore = firstLayout.paths.find((path) => path.path.pathId === 1);
  const luminousBranch = firstLayout.lines.find((line) => line.lineId === "path-3-0-line");
  const viciousBranch = firstLayout.lines.find((line) => line.lineId === "path-2-3-line");
  assert.ok(eternalCore);
  assert.ok(luminousBranch);
  assert.ok(viciousBranch);
  const coreFirst = eternalCore.nodes["1-1"];
  const coreSecond = eternalCore.nodes["1-2"];
  const coreThird = eternalCore.nodes["1-3"];
  const coreLineOne = firstLayout.lines.find((line) => line.lineId === "path-1-3-line");
  const coreLineTwo = firstLayout.lines.find((line) => line.lineId === "path-1-4-line");
  assert.ok(coreFirst && coreSecond && coreThird && coreLineOne && coreLineTwo);
  assert.ok(Math.hypot(coreLineOne.x1 - coreFirst.x, coreLineOne.y1 - coreFirst.y) < 100);
  assert.ok(Math.hypot(coreLineOne.x2 - coreSecond.x, coreLineOne.y2 - coreSecond.y) < 100);
  assert.ok(Math.hypot(coreLineTwo.x1 - coreSecond.x, coreLineTwo.y1 - coreSecond.y) < 100);
  assert.ok(Math.hypot(coreLineTwo.x2 - coreThird.x, coreLineTwo.y2 - coreThird.y) < 100);
  const luminousFive = luminous.nodes["1-5"];
  const luminousZr = luminous.nodes["1-ZR"];
  const viciousFive = vicious.nodes["2-5"];
  const viciousD = vicious.nodes["2-D"];
  assert.ok(luminousFive && luminousZr && viciousFive && viciousD);
  assert.ok(Math.hypot(luminousBranch.x1 - luminousFive.x, luminousBranch.y1 - luminousFive.y) < 100);
  assert.ok(Math.hypot(luminousBranch.x2 - luminousZr.x, luminousBranch.y2 - luminousZr.y) < 100);
  assert.ok(Math.hypot(viciousBranch.x1 - viciousFive.x, viciousBranch.y1 - viciousFive.y) < 100);
  assert.ok(Math.hypot(viciousBranch.x2 - viciousD.x, viciousBranch.y2 - viciousD.y) < 100);
  assert.equal(firstLayout.paths.some((path) => path.path.pathId === 19), false);

  const finale = authored.subworlds.find((subworld) => subworld.subworldId === "final-verdict");
  assert.ok(finale);
  assert.deepEqual(finale.nodes.map((node) => node.nodeKey), ["F-1", "F-2", "F-3", "F-4", "F-5", "F-6", "F-7"]);
  assert.equal(finale.nodes.every((node) => node.width !== node.height), true);
  assert.equal(finale.nodes.every((node) => node.sourceName.startsWith("button_102-")), true);
  assert.ok(finale.continuation?.nodes.some((node) => node.nodeId === "epilogue_a"));
  assert.ok(finale.continuation?.nodes.some((node) => node.nodeId === "epilogue_b"));
  assert.ok(finale.composite);
  assert.equal(finale.nodes.every((node) => node.labelMode === "baked" && node.label === undefined), true);
  assert.equal(finale.composite?.epilogueTransform.scale, 0.72);
  assert.deepEqual(finale.composite?.forkLines.map((line) => [line.from, line.to, line.kind]), [
    ["F-7", "E-2", "branch"],
    ["F-7", "E-1", "branch"],
  ]);
  assert.equal(finale.composite?.forkLines.some((line) => line.from === "E-1" && line.to === "E-2"), false);
  assert.ok(finale.bounds.height > (finale.continuation?.bounds.height ?? 0));
  const finalVerdictPath = model.paths.find((path) => path.pathId === 19);
  assert.equal(finalVerdictPath?.unassignedCg?.sceneId, "unassigned-cg:19");
  assert.equal(finalVerdictPath?.unassignedCg?.resources.length, 16);
  const composite = buildArcaeaStorySubworldLayout(finale, finalVerdictPath?.unassignedCg);
  assert.equal(composite.unassignedCg?.sceneId, "unassigned-cg:19");
  assert.equal(composite.continuation?.nodes.epilogue_a !== undefined, true);
  assert.equal(composite.continuation?.nodes.epilogue_b !== undefined, true);
  assert.equal(composite.lines.some((line) => line.from === "F-7" && line.to === "E-1"), true);
  assert.equal(composite.lines.some((line) => line.from === "F-7" && line.to === "E-2"), true);
  assert.equal(composite.lines.some((line) => line.from === "E-1" && line.to === "E-2"), false);
  assert.ok((composite.continuation?.nodes.epilogue_b?.y ?? 0) < (composite.continuation?.nodes.epilogue_a?.y ?? 0));
  assert.ok((composite.continuation?.nodes.epilogue_a?.y ?? 0) < (composite.nodes["F-7"]?.y ?? Number.MAX_SAFE_INTEGER));
  assert.equal(composite.continuation?.nodeTransforms.epilogue_a?.labelMode, "overlay");
  assert.equal(composite.continuation?.nodeTransforms.epilogue_a?.label?.text, "One Last Dream");
  assert.equal(composite.continuation?.nodeTransforms.epilogue_a?.label?.fontResourcePath, "assets/Fonts/L2-Semibold.ttf");
});

test("Arcaea Story projection preserves raw text provenance and deterministic fallback", () => {
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
  assert.equal(browse.storyAtlas.relationEvidence.length, 190);
  assert.equal(browse.storyAtlas.relationEvidence.filter((item) => item.finalRelation === "node").length, 141);
  assert.equal(browse.storyAtlas.relationEvidence.filter((item) => item.finalRelation === "path-scene").length, 49);
  const finaleText = browse.storyAtlas.text.entries.find((entry) => entry.nodeKey === "E-2");
  assert.deepEqual(finaleText?.texts["zh-Hans"]?.blocks.filter((block) => block.kind === "display-event").map((block) => block.assetPath), [
    "assets/app-data/story/cg/E-1_epilogue.jpg",
    "assets/app-data/story/cg/E-2_epilogue.jpg",
    "assets/app-data/story/cg/F-7-1.jpg",
    "assets/app-data/story/cg/E-4_epilogue.jpg",
  ]);
  assert.equal(browse.storyAtlas.scenes.find((scene) => scene.sceneId === "vn:epilogue_last")?.resourceIds.length, 35);
  assert.equal(browse.storyAtlas.relationEvidence.every((item) => item.evidence.length > 0), true);
  const derivatives = browse.storyAtlas.derivatives;
  assert.ok(derivatives);
  assert.ok(Object.keys(derivatives.ui).length >= 114);
  assert.equal(Object.keys(derivatives.avatars).length, 21);
  assert.equal(Object.keys(derivatives.resources).length, 237);
  assert.ok(derivatives.ui["finale-7.png"]);
  const derivativeAssets = Object.values(derivatives.resources).flatMap((group) => [group.thumb, group.preview]);
  assert.equal(derivativeAssets.every((asset) => asset.url.startsWith("/generated/arcaea/story/")), true);
  assert.equal(derivativeAssets.every((asset) => asset.mime === "image/webp" && asset.sizeBytes > 0), true);
  assert.equal(derivativeAssets.filter((asset) => asset.url.includes("/cg/thumb/")).every((asset) => asset.sizeBytes <= 150000), true);
  assert.equal(derivativeAssets.filter((asset) => asset.url.includes("/cg/preview/")).every((asset) => asset.sizeBytes <= 300000), true);
  const searchable = browse.storyAtlas.searchIndex.find((entry) => entry.nodeKey === "1-ZR");
  assert.ok(searchable);
  assert.equal(searchable.terms.includes("1-ZR"), true);
  assert.equal(searchable.terms.includes("hikari"), true);
  assert.equal(browse.storyAtlas.searchIndex.some((entry) => entry.terms.includes("Luminous Sky")), true);
  const model = buildArcaeaStoryExplorerModel(siteData.galleries["arcaea/story-cg"] ?? [], browse.storyStructure, browse.storyAtlas);
  const fallback = buildArcaeaStoryAtlasLayout(model.sections[0]!);
  assert.equal(fallback.layoutSource, "fallback-generated");
  assert.equal(fallback.lines.some((line) => line.provenance === "sequential-fallback"), true);
});

test("Arcaea Story display key mapping follows alternate prefix/suffix fields", () => {
  assert.equal(displayNodeKey("24", { minor: 7, alternatePrefix: "C" }, 7), "C-7");
  assert.equal(displayNodeKey("1", { minor: 6, alternateSuffix: "ZR" }, 6), "1-ZR");
});

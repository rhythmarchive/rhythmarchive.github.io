import assert from "node:assert/strict";
import test from "node:test";
import { projectCatalog } from "../src/lib/catalog-projection.js";
import { loadFormalCatalog } from "../src/lib/site-data.js";

const catalog = loadFormalCatalog();
const projection = projectCatalog(catalog, "https://rhythm-assets.cn-nb1.rains3.com");

function sourceResource(prefix: string) {
  return catalog.resources.find((resource) => resource.game === "rotaeno" && resource.externalIdentities.some((identity) => identity.key === "source-identity" && identity.value.startsWith(prefix)));
}

function projectedFor(prefix: string) {
  const resource = sourceResource(prefix);
  return projection.resources.find((item) => item.resourceId === resource?.id);
}

test("Rotaeno resources use formal display metadata across image families", () => {
  const rotaeno = projection.resources.filter((resource) => resource.game === "rotaeno");
  assert.equal(rotaeno.length, 596);
  assert.equal(projectedFor("song-jacket:stray-soul-around")?.displayTitle, "ストレイソウル・アラウンド");
  assert.equal(projectedFor("song-jacket:burn-it-up")?.displayTitle, "恶修女 - 永火熔铸");
  assert.equal(projectedFor("song-jacket:burn-it-up")?.artist, "负离子SYNTHETIC feat. 黒澤ノアNOIR");
  assert.equal(projectedFor("song-jacket:burn-it-up")?.metadata.illustrator, "黑茶");
  assert.equal(projectedFor("song-jacket:hushwave-symptoms")?.displayTitle, "缄色症候");
  assert.equal(projectedFor("song-jacket:hushwave-symptoms")?.artist, "ariiol");
  assert.equal(projectedFor("song-jacket:hushwave-symptoms")?.metadata.illustrator, "九茶");
  assert.equal(projectedFor("song-jacket:deus-ex-machina")?.displayTitle, "Lunàtixxx Gear");
  assert.equal(projectedFor("song-jacket:deus-ex-machina")?.artist, "Laur vs HyuN");
  assert.equal(projectedFor("song-jacket:deus-ex-machina")?.metadata.illustrator, "みしゃも");
  assert.equal(projectedFor("song-jacket:hyun-jrpg")?.displayTitle, "Rotaeno 曲绘（曲目信息待核实）");
  assert.equal(projectedFor("song-jacket:stray-soul-around")?.artist, "みーに");
  assert.equal(projectedFor("pack-cover:main-ch3")?.displayTitle, "第三章：泾渭分明之地");
  assert.equal(projectedFor("character:_paid/cytus2_neko")?.displayTitle, "NEKO#ΦωΦ（Cytus II）");
  assert.equal(projectedFor("startup:animationprefabs/20250120-sc1")?.displayTitle, "第一章启动视觉");
  assert.equal(projectedFor("story-cg:017c56c96330a4e008b9f2a9a850c80d")?.displayTitle, "周年纪念 CG 3");
  assert.ok(rotaeno.every((resource) => !/(?:Assets\/|Scriptable Objects|source-identity|\.psd|\.asset)/iu.test(resource.displayTitle)));
});

test("Rotaeno search keeps formal names but excludes internal IDs and source filenames", () => {
  const song = projectedFor("song-jacket:stray-soul-around");
  const search = projection.searchIndex.find((entry) => entry.resourceId === song?.resourceId);
  assert.ok(search);
  assert.equal(search.title, song?.displayTitle);
  assert.ok(!search.keywords.some((keyword) => /(?:Assets\/|Scriptable Objects|\.psd|source-identity)/iu.test(keyword)));
});

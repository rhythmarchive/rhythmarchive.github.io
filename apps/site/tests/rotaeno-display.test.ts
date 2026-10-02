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
  assert.ok(rotaeno.length > 0);
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

test("Rotaeno chart metadata projects difficulty, v2 rating, and Alpha variants", () => {
  const song = projectedFor("song-jacket:abstruse-dilemma");
  assert.deepEqual(song?.charts?.map((chart) => [chart.difficulty, chart.level, chart.constant]), [["I", "3", "3.0"], ["II", "7", "7.0"], ["III", "12", "12.3"], ["IV", "14", "14.0"]]);
  assert.equal(song?.charts?.[0]?.artist, "AxEradaS");
  assert.equal(song?.charts?.[0]?.source, "merged");
  const alpha = projectedFor("song-jacket:alfheims-faith")?.charts?.find((chart) => chart.difficulty === "IV_Alpha");
  assert.deepEqual(alpha && [alpha.difficulty, alpha.level, alpha.constant, alpha.artist], ["IV_Alpha", "13", "13.3", "AXERA"]);
  assert.deepEqual(projectedFor("song-jacket:a-city-in-serenity")?.charts?.find((chart) => chart.difficulty === "IV") && [
    projectedFor("song-jacket:a-city-in-serenity")?.charts?.find((chart) => chart.difficulty === "IV")?.level,
    projectedFor("song-jacket:a-city-in-serenity")?.charts?.find((chart) => chart.difficulty === "IV")?.constant,
  ], ["12", "12.0"]);
});

test("Rotaeno preserves all requested song metadata and nonnumeric levels", () => {
  const stage = projectedFor("song-jacket:stage-5");
  assert.deepEqual(stage?.charts?.map((chart) => [chart.difficulty, chart.level, chart.notes, chart.constant]), [
    ["I", "2", 396, "2.0"],
    ["II", "5", 579, "5.0"],
    ["III", "8", 988, "8.6"],
    ["IV", "13", 1513, "13.1"],
    ["IV_Alpha", "Lv.4", 1920, "14.0"],
  ]);
  assert.deepEqual(
    [stage?.metadata.length, stage?.metadata.bpm, stage?.metadata.pack, stage?.metadata.updateVersion, stage?.metadata.updateDate, stage?.metadata.metadataStatus],
    ["2:20", "145", "Ψ：脳波オーバーロード", "ver.2.8.0", "2025/03/27", "complete"],
  );

  const aleph = projectedFor("song-jacket:aleph-0");
  const alephAlpha = aleph?.charts?.find((chart) => chart.difficulty === "IV_Alpha");
  assert.deepEqual(alephAlpha && [alephAlpha.level, alephAlpha.notes, alephAlpha.constant], ["Aleph 0", 1420, "13.9"]);

  const special = projectedFor("song-jacket:aoott");
  assert.deepEqual(special?.specialCharts?.map((chart) => [chart.difficulty, chart.level, chart.notes]), [["Meow", "Meow", 2397]]);
  assert.equal(special?.metadata.metadataStatus, "special");

  const partial = projectedFor("song-jacket:adam");
  assert.equal(partial?.charts?.some((chart) => chart.notes !== undefined), false);
  assert.deepEqual(
    [partial?.metadata.length, partial?.metadata.bpm, partial?.metadata.pack, partial?.metadata.updateVersion, partial?.metadata.updateDate, partial?.metadata.metadataStatus],
    ["1:55", "200", "WACCA コラボⅡ", "ver.2.24.0", "2026/06/25", "partial"],
  );
});

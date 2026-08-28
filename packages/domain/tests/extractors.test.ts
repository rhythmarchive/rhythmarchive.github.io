import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { adaptArcaeaLegacyReport } from "../src/extractors.js";
import { manifestFromExtractorResult } from "../src/release.js";

test("Arcaea pack covers use packId and preserve the alt variant", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rhythm-arcaea-extractor-"));
  const outputDir = path.join(root, "output");
  await mkdir(path.join(outputDir, "_metadata"), { recursive: true });
  await mkdir(path.join(outputDir, "曲包封面"), { recursive: true });
  await mkdir(path.join(outputDir, "剧情贴图"), { recursive: true });
  await writeFile(path.join(outputDir, "_metadata", "packlist.json"), JSON.stringify({ packs: [{ id: "konzetsu", name_localized: { en: "Divine Oblivion" } }] }));
  await writeFile(path.join(outputDir, "曲包封面", "Divine Oblivion_1080_select_konzetsu.png"), "default-pack-cover");
  await writeFile(path.join(outputDir, "曲包封面", "Divine Oblivion_1080_select_konzetsu_alt.png"), "alt-pack-cover");
  await writeFile(path.join(outputDir, "剧情贴图", "cat_6_0.jpg"), "story-texture");
  const reportPath = path.join(root, "arcaea-update-report.json");
  await writeFile(reportPath, JSON.stringify({
    outputDir,
    copied: [
      { category: "曲包封面", sourcePath: "songs/pack/1080_select_konzetsu.png", outputPath: "曲包封面/Divine Oblivion_1080_select_konzetsu.png" },
      { category: "曲包封面", sourcePath: "songs/pack/1080_select_konzetsu_alt.png", outputPath: "曲包封面/Divine Oblivion_1080_select_konzetsu_alt.png" },
      { category: "剧情贴图", sourcePath: "app-data/story/vn/res/catastrophe/cat_6_0.jpg", outputPath: "剧情贴图/cat_6_0.jpg" },
    ],
  }));
  const result = await adaptArcaeaLegacyReport({
    reportPath,
    baseVersion: "6.16.8c",
    targetVersion: "7.0.0c",
    baseApk: { role: "base", version: "6.16.8c", filename: "arcaea_6.16.8c.apk", absolutePath: path.join(root, "base.apk"), verification: "unverified" },
    targetApk: { role: "target", version: "7.0.0c", filename: "Arcaea_7.0.0c.apk", absolutePath: path.join(root, "target.apk"), verification: "unverified" },
  });

  const packCandidates = result.candidates.filter((candidate) => candidate.suggestedCategory === "pack-cover");
  assert.equal(packCandidates.length, 2);
  assert.deepEqual(packCandidates.map((candidate) => candidate.suggestedVariant?.key).sort(), ["alt", "default"]);
  for (const candidate of packCandidates) {
    assert.equal(candidate.suggestedExternalIdentity.find((identity) => identity.key === "packId")?.value, "konzetsu");
    assert.equal(candidate.suggestedTitle, "Divine Oblivion");
    assert.equal(candidate.confidence, "high");
    assert.ok(candidate.evidence.some((item) => item.kind === "metadata" && item.detail.includes("packlist")));
  }

  const storyCandidate = result.candidates.find((candidate) => candidate.suggestedCategory === "story-texture");
  assert.ok(storyCandidate);
  assert.equal(storyCandidate.suggestedExternalIdentity[0]?.key, "path");
  assert.equal(storyCandidate.suggestedExternalIdentity[0]?.value, "app-data/story/vn/res/catastrophe/cat_6_0.jpg");

  const manifest = await manifestFromExtractorResult(result);
  assert.equal(new Set(manifest.entries.map((entry) => entry.identityKey)).size, 3);
  assert.deepEqual(manifest.entries.map((entry) => entry.identityKey).sort(), [
    "arcaea|pack-cover|arcaea:packid=konzetsu|alt",
    "arcaea|pack-cover|arcaea:packid=konzetsu|default",
    "arcaea|story-texture|arcaea:path=app-data/story/vn/res/catastrophe/cat_6_0.jpg|default",
  ]);
});

test("Arcaea songlist aliases class 3 to Inscribed without reclassifying ordinary BYD", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rhythm-arcaea-inscribed-"));
  const outputDir = path.join(root, "output");
  await mkdir(path.join(outputDir, "_metadata"), { recursive: true });
  await mkdir(path.join(outputDir, "曲绘"), { recursive: true });
  await writeFile(path.join(outputDir, "_metadata", "songlist.json"), JSON.stringify({
    songs: [
      {
        id: "dreadarea",
        title_localized: { en: "DREAD AREA" },
        artist: "Ashrount vs. 打打だいず",
        difficulties: [{ ratingClass: 3, ratingClassAlias: 1, rating: 11 }],
      },
      {
        id: "old-byd",
        title_localized: { en: "Old BYD" },
        artist: "Artist",
        difficulties: [{ ratingClass: 3, rating: 10 }],
      },
    ],
  }));
  await writeFile(path.join(outputDir, "曲绘", "1080_base_3.jpg"), "inscribed");
  const reportPath = path.join(root, "arcaea-update-report.json");
  await writeFile(reportPath, JSON.stringify({
    outputDir,
    copied: [
      { category: "曲绘", sourcePath: "songs/dl_dreadarea/1080_base_3.jpg", outputPath: "曲绘/1080_base_3.jpg" },
      { category: "曲绘", sourcePath: "songs/dl_old-byd/1080_base_3.jpg", outputPath: "曲绘/1080_base_3.jpg" },
    ],
  }));

  const result = await adaptArcaeaLegacyReport({
    reportPath,
    baseVersion: "6.16.8c",
    targetVersion: "7.0.0c",
    baseApk: { role: "base", version: "6.16.8c", filename: "arcaea_6.16.8c.apk", absolutePath: path.join(root, "base.apk"), verification: "unverified" },
    targetApk: { role: "target", version: "7.0.0c", filename: "Arcaea_7.0.0c.apk", absolutePath: path.join(root, "target.apk"), verification: "unverified" },
  });

  const bySong = new Map(result.candidates.map((candidate) => [candidate.suggestedExternalIdentity.find((identity) => identity.key === "songId")?.value, candidate]));
  assert.equal(bySong.get("dreadarea")?.suggestedVariant?.difficulty, "INSCRIBED");
  assert.equal(bySong.get("old-byd")?.suggestedVariant?.difficulty, "BYD");
});

test("Arcaea character resources use the full characters.json record", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rhythm-arcaea-character-"));
  const outputDir = path.join(root, "output");
  await mkdir(path.join(outputDir, "_metadata"), { recursive: true });
  await mkdir(path.join(outputDir, "角色", "立绘"), { recursive: true });
  await mkdir(path.join(outputDir, "角色", "头像"), { recursive: true });
  await mkdir(path.join(outputDir, "角色", "LinkPlay预览"), { recursive: true });
  await writeFile(path.join(outputDir, "_metadata", "characters.json"), JSON.stringify([{
    character_id: 97,
    base_character_id: 23,
    base_character: false,
    name: "saya_konzetsu",
    is_available: false,
    is_previewable: false,
    base_frag: 54,
    base_prog: 71,
    base_over: 51.5,
    max_frag: 125,
    max_prog: 160,
    max_over: 120,
    char_type: 2,
    skill_unlock_level: 0,
    skill_id: "skill_saya_konzetsu",
    uncap_cores: [],
    version_from: "7.0.0",
    search_strings: ["サヤ", "咲弥", "咲彌", "사야", "さやあぶそりゅーしょん", "あぶそりゅーしょんさや"],
    pack_id: "konzetsu",
  }]));
  const copied = [
    { category: "角色/立绘", sourcePath: "char/1080/97.png", outputPath: "角色/立绘/咲弥.png" },
    { category: "角色/头像", sourcePath: "char/97_icon.png", outputPath: "角色/头像/咲弥_icon.png" },
    { category: "角色/LinkPlay预览", sourcePath: "char/97_mp.png", outputPath: "角色/LinkPlay预览/咲弥_mp.png" },
  ];
  for (const item of copied) await writeFile(path.join(outputDir, item.outputPath), item.sourcePath);
  const reportPath = path.join(root, "arcaea-update-report.json");
  await writeFile(reportPath, JSON.stringify({ outputDir, copied }));

  const result = await adaptArcaeaLegacyReport({
    reportPath,
    baseVersion: "6.16.8c",
    targetVersion: "7.0.0c",
    baseApk: { role: "base", version: "6.16.8c", filename: "arcaea_6.16.8c.apk", absolutePath: path.join(root, "base.apk"), verification: "unverified" },
    targetApk: { role: "target", version: "7.0.0c", filename: "Arcaea_7.0.0c.apk", absolutePath: path.join(root, "target.apk"), verification: "unverified" },
  });

  assert.equal(result.candidates.length, 3);
  for (const candidate of result.candidates) {
    assert.equal(candidate.confidence, "high");
    assert.equal(candidate.suggestedTitle, "咲弥");
    assert.equal(candidate.provenance.metadataSource, "_metadata/characters.json");
    assert.equal(candidate.metadata.characterId, 97);
    assert.equal(candidate.metadata.characterInternalName, "saya_konzetsu");
    assert.equal(candidate.metadata.characterMaxProg, 160);
    assert.deepEqual(candidate.metadata.characterSearchStrings, ["サヤ", "咲弥", "咲彌", "사야", "さやあぶそりゅーしょん", "あぶそりゅーしょんさや"]);
    assert.ok(candidate.evidence.some((item) => item.kind === "metadata" && item.detail.includes("character_id 97")));
    assert.ok(!candidate.evidence.some((item) => item.kind === "filename-parser"));
  }
});

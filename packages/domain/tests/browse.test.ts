import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ArcaeaBrowseProjection,
  ArcaeaCuration,
  ArcaeaSourceMetadata,
  PhigrosBrowseProjection,
  PhigrosSourceMetadata,
  ReleaseManifest,
  Resource,
  buildBrowseProjections,
  catalogSha256FromValue,
  createEmptyCatalog,
  createUuidV7,
  matchesArcaeaChart,
  selectArcaeaArtwork,
  validateBrowseProjectionSet,
  writeCatalogAndReleaseAndBrowseAtomic,
  type ArcaeaCurationType,
  type ArcaeaSourceMetadataType,
  type PhigrosSourceMetadataType,
} from "../src/index.js";

const NOW = "2026-08-19T00:00:00.000Z";
const SHA = "a".repeat(64);

function fixtureResource(game: "arcaea" | "phigros", resourceType: "jacket" | "phigros-april-fools", title: string, artist?: string) {
  const id = createUuidV7();
  return Resource.parse({
    id,
    game,
    resourceType,
    title,
    aliases: [],
    externalIdentities: [],
    metadata: artist ? { artist } : {},
    relations: [],
    provenance: [{
      sourceType: "manual",
      sourceRelativePath: `fixtures/${id}.png`,
      sourceFilename: `${id}.png`,
      sourceSha256: SHA,
      evidence: [{ kind: "manual-note", detail: "Browse Projection unit fixture", confidence: "high" }],
    }],
    lifecycle: { status: "published", createdAt: NOW, updatedAt: NOW, publishedAt: NOW },
  });
}

function fixtureData(): { catalog: ReturnType<typeof createEmptyCatalog>; arcaea: ArcaeaSourceMetadataType; phigros: PhigrosSourceMetadataType; curation: ArcaeaCurationType } {
  const arcaeaDefault = fixtureResource("arcaea", "jacket", "Last");
  const arcaeaByd = fixtureResource("arcaea", "jacket", "Last BYD");
  const arcaeaSecond = fixtureResource("arcaea", "jacket", "Last Eternity");
  const arcaeaSeasonal = fixtureResource("arcaea", "jacket", "Ignotus Afterburn");
  const arcaeaArchive = fixtureResource("arcaea", "jacket", "Legacy jacket");
  const arcaeaUnresolved = fixtureResource("arcaea", "jacket", "Unresolved jacket");
  const phigrosCurrent = fixtureResource("phigros", "jacket", "Curated After ZABANIYA", "Curated Artist");
  const phigrosRandom = fixtureResource("phigros", "jacket", "Random");
  const phigrosIntroduction = fixtureResource("phigros", "jacket", "INTRODUCTION");
  const phigrosArchive = fixtureResource("phigros", "jacket", "Historical jacket");
  const phigrosAprilFools = fixtureResource("phigros", "phigros-april-fools", "After ZABANIYA");
  const catalog = {
    ...createEmptyCatalog(NOW),
    resources: [arcaeaDefault, arcaeaByd, arcaeaSecond, arcaeaSeasonal, arcaeaArchive, arcaeaUnresolved, phigrosCurrent, phigrosRandom, phigrosIntroduction, phigrosArchive, phigrosAprilFools],
  };

  const arcaea = ArcaeaSourceMetadata.parse({
    schemaVersion: 1,
    game: "arcaea",
    sourceVersion: "6.16.8c",
    sourceSha256: "b".repeat(64),
    songs: [
      {
        songId: "last",
        displayTitle: "Last",
        titleAliases: ["Last JP"],
        artist: "xi",
        artistAliases: [],
        packId: "memory-archive",
        packDisplayName: "Memory Archive",
        version: "1.0",
        date: 20200101,
        sideRaw: 0,
        bpm: "190",
        orderHint: 1,
        charts: [{ difficultyClass: "FTR", displayLevel: "9" }, { difficultyClass: "BYD", displayLevel: "10+" }],
        artworks: [
          { role: "default", resourceId: arcaeaDefault.id, currentApkPresence: true, matchStatus: "confirmed", sourcePath: "assets/songs/last/1080_base.jpg" },
          { role: "difficulty", difficultyClass: "BYD", resourceId: arcaeaByd.id, currentApkPresence: true, matchStatus: "confirmed", sourcePath: "assets/songs/last/1080_base_byd.jpg" },
        ],
        relatedSongs: [{ songId: "lasteternity", relationType: "last-family" }],
        specialRelation: "last-family",
      },
      {
        songId: "lasteternity",
        displayTitle: "Last Eternity",
        titleAliases: [],
        artist: "xi",
        artistAliases: [],
        packId: "memory-archive",
        packDisplayName: "Memory Archive",
        version: "1.0",
        date: null,
        sideRaw: null,
        bpm: null,
        orderHint: 2,
        charts: [{ difficultyClass: "FTR", displayLevel: "10" }],
        artworks: [{ role: "default", resourceId: arcaeaSecond.id, currentApkPresence: true, matchStatus: "confirmed", sourcePath: "assets/songs/lasteternity/1080_base.jpg" }],
        relatedSongs: [{ songId: "last", relationType: "last-family" }],
      },
      {
        songId: "missing-song",
        displayTitle: "Missing Song",
        titleAliases: [],
        artist: "Unknown Artist",
        artistAliases: [],
        packId: "unknown",
        packDisplayName: null,
        version: null,
        date: null,
        sideRaw: null,
        bpm: null,
        orderHint: 3,
        charts: [{ difficultyClass: "PST", displayLevel: "1" }],
        artworks: [{ role: "default", resourceId: null, currentApkPresence: true, matchStatus: "missing", sourcePath: "assets/songs/missing-song/1080_base.jpg" }],
        relatedSongs: [],
      },
    ],
    resourceSemantics: [
      { resourceId: arcaeaDefault.id, bucket: "regular", reason: "current-default-artwork", relatedSongId: "last" },
      { resourceId: arcaeaByd.id, bucket: "regular", reason: "current-difficulty-artwork", relatedSongId: "last", difficultyClass: "BYD" },
      { resourceId: arcaeaSecond.id, bucket: "regular", reason: "current-default-artwork", relatedSongId: "lasteternity" },
      { resourceId: arcaeaSeasonal.id, bucket: "special", reason: "april-fools-special-song-artwork", specialType: "april-fools", displayTitle: "Ignotus Afterburn" },
      { resourceId: arcaeaArchive.id, bucket: "archiveExtra", reason: "legacy-duplicate-candidate", relatedSongId: "last" },
      { resourceId: arcaeaUnresolved.id, bucket: "unresolvedExtra", reason: "unresolved-catalog-resource" },
    ],
  });

  const family = { familyId: "Random.SobremSilentroom", memberIndex: 0, memberCount: 7, primaryMemberIndex: 0 };
  const randomTrack = (index: number, artworkResourceId: string | null) => ({
    sourceIdentityCandidate: `Assets/Tracks/Random.SobremSilentroom.${index}/`,
    sourceTrackPath: `Assets/Tracks/Random.SobremSilentroom.${index}/`,
    displayTitle: index === 0 ? "Random" : undefined,
    sourceTitle: "Random",
    displayArtist: null,
    sourceArtist: "SobremSilentroom",
    indexRaw: String(index),
    artworkResourceId,
    artworkConfidence: "confirmed" as const,
    charts: [{ difficultyClass: "EZ" as const, structurallyPresent: true, errorVariant: false }],
    specialKind: "random-family-member" as const,
    family: { ...family, memberIndex: index },
    searchAliases: [],
  });
  const phigros = PhigrosSourceMetadata.parse({
    schemaVersion: 1,
    game: "phigros",
    sourceVersion: "3.19.5",
    sourceSha256: "c".repeat(64),
    tracks: [
      {
        sourceIdentityCandidate: "Assets/Tracks/After ZABANIYA.Artist.0/",
        sourceTrackPath: "Assets/Tracks/After ZABANIYA.Artist.0/",
        displayTitle: "After ZABANIYA",
        sourceTitle: "After ZABANIYA",
        displayArtist: null,
        sourceArtist: "Artist",
        indexRaw: "0",
        artworkResourceId: phigrosCurrent.id,
        artworkConfidence: "confirmed",
        charts: [
          { difficultyClass: "EZ", structurallyPresent: true, errorVariant: false },
          { difficultyClass: "EZ", structurallyPresent: true, errorVariant: true },
          { difficultyClass: "IN", structurallyPresent: true, errorVariant: false },
        ],
        searchAliases: ["ZABANIYA"],
      },
      {
        sourceIdentityCandidate: "Assets/Introduction/",
        sourceTrackPath: "Assets/Introduction/",
        displayTitle: "INTRODUCTION",
        sourceTitle: "Introduction",
        displayArtist: null,
        sourceArtist: null,
        indexRaw: null,
        artworkResourceId: phigrosIntroduction.id,
        artworkConfidence: "high",
        charts: [{ difficultyClass: "EZ", structurallyPresent: true, errorVariant: false }],
        specialKind: "system-or-tutorial-candidate",
        searchAliases: [],
      },
      randomTrack(0, phigrosRandom.id),
      randomTrack(1, null),
    ],
    resourceSemantics: [
      { resourceId: phigrosCurrent.id, bucket: "current", reason: "current-track-artwork", displayTitle: "After ZABANIYA" },
      { resourceId: phigrosRandom.id, bucket: "current", reason: "current-track-artwork", displayTitle: "Random" },
      { resourceId: phigrosIntroduction.id, bucket: "current", reason: "current-track-artwork", displayTitle: "INTRODUCTION" },
      { resourceId: phigrosArchive.id, bucket: "archiveExtra", reason: "historical-artwork", displayTitle: "Historical jacket" },
      { resourceId: phigrosAprilFools.id, bucket: "special", reason: "april-fools-artwork", displayTitle: "After ZABANIYA" },
    ],
  });

  const curation = ArcaeaCuration.parse({
    schemaVersion: 1,
    game: "arcaea",
    entries: [{
      year: 2018,
      specialTitle: "Ignotus Afterburn",
      baseSongId: "last",
      relationType: "seasonal-error-track",
      specialType: "april-fools",
      currentRepresentation: "permanent-byd",
      standaloneSonglistRecord: false,
      seasonalResourceId: arcaeaSeasonal.id,
      seasonalCurrentApkPresence: false,
      permanentByd: { songId: "last", difficultyClass: "BYD", resourceId: arcaeaByd.id, currentApkPresence: true },
    }],
  });
  return { catalog, arcaea, phigros, curation };
}

function buildFixture() {
  const fixture = fixtureData();
  const result = buildBrowseProjections({ catalog: fixture.catalog, arcaea: fixture.arcaea, phigros: fixture.phigros, arcaeaCuration: fixture.curation, generatedAt: NOW, catalogSha256: catalogSha256FromValue(fixture.catalog) });
  return { ...fixture, result };
}

test("Browse Projection schemas preserve game semantics and Resource boundaries", () => {
  const { catalog, result } = buildFixture();
  assert.equal(ArcaeaBrowseProjection.safeParse(result.arcaea).success, true);
  assert.equal(PhigrosBrowseProjection.safeParse(result.phigros).success, true);

  const last = result.arcaea.songs.find((song) => song.songId === "last")!;
  assert.equal(matchesArcaeaChart(last, "BYD", "10+"), true);
  assert.equal(matchesArcaeaChart(last, "FTR", "10+"), false);
  assert.equal(selectArcaeaArtwork(last, "BYD")?.resourceId, last.artworks.find((artwork) => artwork.difficultyClass === "BYD")?.resourceId);
  assert.equal(last.relatedSongs[0]!.relationType, "last-family");
  assert.equal(result.arcaea.songs.find((song) => song.songId === "missing-song")!.artworks[0]!.resourceId, null);
  assert.equal(result.arcaea.recordCounts.missingCurrentArtwork, 1);

  const special = result.arcaea.specials[0]!;
  assert.equal(special.currentRepresentation, "permanent-byd");
  assert.equal(special.artworks.some((artwork) => artwork.role === "seasonal" && artwork.currentApkPresence === false), true);
  assert.equal(special.artworks.some((artwork) => artwork.role === "permanent-byd" && artwork.difficultyClass === "BYD"), true);
  assert.equal(result.arcaea.archiveExtras.some((extra) => extra.reason === "legacy-duplicate-candidate"), true);
  assert.equal(result.arcaea.unresolvedExtras.length, 1);

  const current = result.phigros.tracks.find((track) => track.sourceTitle === "After ZABANIYA")!;
  assert.equal(current.displayTitle, "Curated After ZABANIYA");
  assert.equal(current.sourceTitle, "After ZABANIYA");
  assert.equal(current.displayArtist, "Curated Artist");
  assert.equal(current.sourceArtist, "Artist");
  assert.equal(current.displayLevel, null);
  assert.equal(current.chapter, null);
  assert.equal(current.charts.some((chart) => chart.difficultyClass === "EZ" && chart.errorVariant), true);
  assert.equal(result.phigros.archiveExtras.length, 1);
  assert.equal(result.phigros.specials.length, 1);
  assert.equal(result.phigros.specials[0]!.isTrackMapped, false);
  assert.equal(result.phigros.specials[0]!.artworkResourceId, catalog.resources.find((resource) => resource.title === "After ZABANIYA" && resource.resourceType === "phigros-april-fools")!.id);
  const randomOnly = result.phigros.sourceOnlyTracks.find((track) => track.sourceTrackPath.endsWith("Random.SobremSilentroom.1/"))!;
  assert.equal(randomOnly.artwork, null);
  assert.equal(randomOnly.family?.familyId, "Random.SobremSilentroom");
  assert.equal(result.phigros.tracks.find((track) => track.specialKind === "system-or-tutorial-candidate")?.sourceTrackPath, "Assets/Introduction/");
  assert.equal(result.phigros.recordCounts.sourceTrackRecords, 4);
  assert.equal(result.phigros.recordCounts.sourceOnlyTracks, 1);
  assert.equal(result.diagnostics.arcaea.ok, true);
  assert.equal(result.diagnostics.phigros.ok, true);
});

test("Browse Projection validation rejects dangling Resource IDs and output is deterministic", () => {
  const first = buildFixture();
  const second = buildBrowseProjections({ catalog: first.catalog, arcaea: first.arcaea, phigros: first.phigros, arcaeaCuration: first.curation, generatedAt: NOW, catalogSha256: catalogSha256FromValue(first.catalog) });
  assert.deepEqual(first.result, second);

  const bad = structuredClone(first.result);
  bad.phigros.tracks[0]!.artwork!.resourceId = createUuidV7();
  const validation = validateBrowseProjectionSet(bad, first.catalog);
  assert.equal(validation.success, false);
  if (!validation.success) assert.match(validation.issues.join("; "), /dangling Resource reference/);

  const sensitive = structuredClone(first.result);
  sensitive.phigros.tracks[0]!.sourceIdentityCandidate = "C:\\Users\\fixture\\track";
  const sensitiveValidation = validateBrowseProjectionSet(sensitive, first.catalog);
  assert.equal(sensitiveValidation.success, false);
  if (!sensitiveValidation.success) assert.match(sensitiveValidation.issues.join("; "), /local absolute/);
});

test("Phigros April Fools Resources cannot become ordinary Track artwork", () => {
  const fixture = fixtureData();
  const specialResourceId = fixture.phigros.resourceSemantics.find((item) => item.bucket === "special")!.resourceId;
  const original = fixture.phigros.tracks[0]!;
  const source = PhigrosSourceMetadata.parse({
    ...fixture.phigros,
    tracks: [
      ...fixture.phigros.tracks,
      { ...original, sourceIdentityCandidate: "Assets/Tracks/CurrentCopy.Artist.0/", sourceTrackPath: "Assets/Tracks/CurrentCopy.Artist.0/" },
      { ...original, sourceIdentityCandidate: "Assets/Tracks/SpecialMapped.Artist.0/", sourceTrackPath: "Assets/Tracks/SpecialMapped.Artist.0/", artworkResourceId: specialResourceId },
    ],
  });
  const result = buildBrowseProjections({ catalog: fixture.catalog, arcaea: fixture.arcaea, phigros: source, arcaeaCuration: fixture.curation, generatedAt: NOW, catalogSha256: catalogSha256FromValue(fixture.catalog) });
  const remapped = result.phigros.sourceOnlyTracks.find((track) => track.sourceTrackPath === "Assets/Tracks/SpecialMapped.Artist.0/");
  assert.equal(remapped?.artwork, null);
  assert.equal(result.phigros.specials.some((special) => special.artworkResourceId === specialResourceId), true);
});

test("Catalog, ReleaseManifest, and Browse Projection commit together", async () => {
  const fixture = buildFixture();
  const root = await mkdtemp(path.join(tmpdir(), "rhythm-browse-transaction-"));
  try {
    const catalogPath = path.join(root, "catalog", "index.json");
    const releasesDirectory = path.join(root, "catalog", "releases");
    const browseDirectory = path.join(root, "catalog", "browse");
    const manifest = ReleaseManifest.parse({
      schemaVersion: "1.0",
      id: createUuidV7(),
      updateBatchId: createUuidV7(),
      game: "arcaea",
      baseVersion: "6.16.8c",
      targetVersion: "6.16.8c-browse",
      createdAt: NOW,
      status: "validated",
      changes: [],
      affectedResourceIds: [],
      publishedRenditions: [],
      removedFromCurrentSource: [],
      notes: ["Browse Projection fixture"],
    });
    const commit = await writeCatalogAndReleaseAndBrowseAtomic(fixture.catalog, manifest, fixture.result, { catalogPath, releasesDirectory, browseDirectory });
    assert.equal(commit.browsePaths.length, 4);
    assert.equal(JSON.parse(await readFile(catalogPath, "utf8")).catalogId, fixture.catalog.catalogId);
    assert.equal(await access(commit.releaseManifestPath).then(() => true), true);
    assert.equal(await access(path.join(browseDirectory, "manifest.json")).then(() => true), true);

    const invalid = structuredClone(fixture.result);
    invalid.manifest.catalog.catalogSha256 = "0".repeat(64);
    const untouchedRoot = path.join(root, "invalid");
    await assert.rejects(
      writeCatalogAndReleaseAndBrowseAtomic(fixture.catalog, manifest, invalid, {
        catalogPath: path.join(untouchedRoot, "catalog", "index.json"),
        releasesDirectory: path.join(untouchedRoot, "catalog", "releases"),
        browseDirectory: path.join(untouchedRoot, "catalog", "browse"),
      }),
      /Browse Projection cannot be written/,
    );
    await assert.rejects(access(path.join(untouchedRoot, "catalog", "index.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadCatalogFile, writeCatalogAtomic } from "../packages/domain/src/catalog.js";
import { Catalog, Resource, type Resource as ResourceType } from "../packages/domain/src/schema.js";

type Song = {
  resourceId: string;
  songsId: string;
  songKey: string;
  songName: string;
  composer: string;
  illustrator: string;
  charter: string[];
  levels: string[];
  charts: Array<{ difficulty: string; level: string; available: boolean; status: "available" | "unavailable" | "legacy" }>;
  chapter: { chapterCode: string; banner: string; order: number; songOrder: number; unlockType: number; secretType: number } | null;
  isCnLimited: boolean;
  hasDifferentMusic: boolean;
  hasDifferentCover: boolean;
};
type Curation = { schemaVersion: number; game: "phigros"; source: { version: string; sha256: string }; songs: Song[] };

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

function charterLabel(levels: string[], charters: string[]): string {
  return levels.map((level, index) => charters[index]?.trim() ? `${level}: ${charters[index]!.trim()}` : undefined).filter((value): value is string => Boolean(value)).join(" / ");
}

function songMetadata(song: Song, version: string): Record<string, unknown> {
  const pack = song.chapter?.banner?.trim() || "其他曲目";
  return {
    songId: song.songsId,
    songName: song.songName.trim(),
    songKey: song.songKey.trim(),
    composer: song.composer.trim(),
    illustrator: song.illustrator.trim(),
    charter: charterLabel(song.levels, song.charter),
    pack,
    gameVersion: version,
    metadataStatus: "confirmed",
    displayMetadataSource: "phigros-apk-game-information",
    charts: song.charts,
    isCnLimited: song.isCnLimited,
    hasDifferentMusic: song.hasDifferentMusic,
    hasDifferentCover: song.hasDifferentCover,
    ...(song.chapter ? { chapterCode: song.chapter.chapterCode, chapterOrder: song.chapter.order, chapterSongOrder: song.chapter.songOrder, unlockType: song.chapter.unlockType, secretType: song.chapter.secretType } : {}),
  };
}

const curationPath = path.resolve(arg("curation", "catalog/curation/phigros-gameinfo.json"));
const catalogPath = path.resolve(arg("catalog", "catalog/index.json"));
const apply = process.argv.includes("--apply");
const curation = JSON.parse(await readFile(curationPath, "utf8")) as Curation;
if (curation.schemaVersion !== 1 || curation.game !== "phigros") throw new Error("Invalid Phigros GameInformation curation.");
const catalog = await loadCatalogFile(catalogPath);
const resources = new Map(catalog.resources.map((resource) => [resource.id, resource]));
const now = new Date().toISOString();
const updated = new Map(resources);
for (const song of curation.songs) {
  const resource = resources.get(song.resourceId);
  if (!resource) throw new Error(`Missing Catalog resource for ${song.songsId}: ${song.resourceId}`);
  if (resource.game !== "phigros" || resource.resourceType !== "jacket") throw new Error(`Metadata target is not a Phigros jacket: ${song.resourceId}`);
  const next: ResourceType = Resource.parse({ ...resource, metadata: { ...resource.metadata, ...songMetadata(song, curation.source.version) }, lifecycle: { ...resource.lifecycle, updatedAt: now } });
  updated.set(resource.id, next);
}
const nextCatalog = Catalog.parse({ ...catalog, generatedAt: now, resources: [...updated.values()] });
const report = { status: apply ? "APPLIED_LOCAL_ONLY" : "READY_LOCAL_ONLY", remoteWrite: "DISABLED", sourceVersion: curation.source.version, sourceSha256: curation.source.sha256, metadataResourceCount: curation.songs.length, identityChanges: 0, fileChanges: 0, objectChanges: 0, catalogPath };
if (apply) await writeCatalogAtomic(nextCatalog, catalogPath);
console.log(JSON.stringify(report, null, 2));

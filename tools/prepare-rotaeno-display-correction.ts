import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ContentAdditionInput } from "../packages/domain/src/content.js";
import { UnifiedAssetManifest, type UnifiedAssetManifest as UnifiedAssetManifestType } from "../packages/domain/src/release.js";

type JsonObject = Record<string, unknown>;
type CurationItem = { title?: string; artist?: string; illustrator?: string; status?: string };

const UNKNOWN_TITLES: Record<string, string> = {
  jacket: "Rotaeno \u66f2\u7ed8\uff08\u66f2\u76ee\u4fe1\u606f\u5f85\u6838\u5b9e\uff09",
  "pack-cover": "Rotaeno \u66f2\u5305\u5c01\u9762\uff08\u540d\u79f0\u5f85\u6838\u5b9e\uff09",
  "character-portrait": "Rotaeno \u9a7e\u9a76\u5458\u7acb\u7ed8\uff08\u540d\u79f0\u5f85\u6838\u5b9e\uff09",
  startup: "Rotaeno \u542f\u52a8\u753b\u9762\uff08\u540d\u79f0\u5f85\u6838\u5b9e\uff09",
  "story-cg": "Rotaeno \u5267\u60c5 CG\uff08\u540d\u79f0\u5f85\u6838\u5b9e\uff09",
};

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function curationItem(curation: JsonObject, collection: string, key: string | undefined): CurationItem {
  if (!key) return {};
  const value = object(curation[collection])[key];
  if (typeof value === "string") return { title: value, status: "curated" };
  const item = object(value);
  const title = text(item.title);
  const artist = text(item.artist);
  const illustrator = text(item.illustrator);
  const status = text(item.status);
  return {
    ...(title ? { title } : {}),
    ...(artist ? { artist } : {}),
    ...(illustrator ? { illustrator } : {}),
    ...(status ? { status } : {}),
  };
}

function normalizedToken(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/gu, "");
}

function characterItem(curation: JsonObject, sourceIdentity: string): CurationItem {
  const normalized = normalizedToken(sourceIdentity);
  const values = object(curation.characters);
  const matches: Array<{ length: number; item: CurationItem }> = [];
  for (const [key, value] of Object.entries(values)) {
    const token = normalizedToken(key);
    if (!token || !normalized.includes(token)) continue;
    const item = typeof value === "string" ? { title: value, status: "curated" } : curationItem(curation, "characters", key);
    if (item.title) matches.push({ length: token.length, item });
  }
  return matches.sort((left, right) => right.length - left.length)[0]?.item ?? {};
}

function displayItem(entry: UnifiedAssetManifestType["entries"][number], curation: JsonObject): CurationItem {
  const metadata = object(entry.metadata);
  const nested = object(metadata.metadata);
  if (entry.assetType === "jacket") return curationItem(curation, "songs", text(nested.songId));
  if (entry.assetType === "pack-cover") return curationItem(curation, "packs", text(nested.packId));
  if (entry.assetType === "character-portrait") return characterItem(curation, entry.sourceIdentity);
  return curationItem(curation, entry.assetType === "startup" ? "startup" : "story", text(entry.title)?.toLocaleLowerCase());
}

function displayTitle(entry: UnifiedAssetManifestType["entries"][number], item: CurationItem): string {
  return item.title ?? UNKNOWN_TITLES[entry.assetType] ?? "Rotaeno image artwork (name pending verification)";
}

function buildInput(manifest: UnifiedAssetManifestType, curation: JsonObject): JsonObject {
  const entries = manifest.entries.map((entry) => {
    const item = displayItem(entry, curation);
    const title = displayTitle(entry, item);
    const currentMetadata = object(entry.metadata);
    const nestedMetadata = { ...object(currentMetadata.metadata) };
    if (item.artist) nestedMetadata.artist = item.artist;
    if (item.illustrator) nestedMetadata.illustrator = item.illustrator;
    if (entry.assetType === "pack-cover") nestedMetadata.packName = title;
    if (entry.assetType === "character-portrait") nestedMetadata.characterName = title;
    nestedMetadata.displayMetadataSource = "rotaeno-curation";
    nestedMetadata.displayMetadataStatus = item.status ?? "needs-human-review";
    return {
      sourceIdentity: entry.sourceIdentity,
      assetType: entry.assetType,
      variantKey: entry.variantKey,
      title,
      ...(item.artist ? { artist: item.artist } : {}),
      aliases: [],
      metadata: {
        ...currentMetadata,
        metadata: nestedMetadata,
      },
      origin: "metadata-only",
      needsReview: true,
      needsRename: false,
      anomalies: [],
    };
  });
  return ContentAdditionInput.parse({
    kind: "rhythm-content-addition",
    schemaVersion: "1",
    gameId: "rotaeno",
    version: "2.26.1-display-metadata-v1",
    sourceSnapshot: "rotaeno:display-metadata-curation:2026-08-26",
    entries,
    notes: [
      "Metadata-only correction for Rotaeno public display names.",
      "Titles, composers, illustrators, pack names, character names, startup labels, and story labels come from catalog/curation/rotaeno-display-metadata.json.",
      "Resource identity, source paths, published files, object keys, and download filenames are intentionally preserved.",
    ],
  });
}

async function main(): Promise<void> {
  const manifestPath = process.argv[2] ?? "temp/rhythmctl/rotaeno/2.26.1-full-images-v2/unified-manifest.json";
  const outputPath = process.argv[3] ?? "temp/rotaeno_display_correction/content-addition.json";
  const manifest = UnifiedAssetManifest.parse(JSON.parse(await readFile(path.resolve(manifestPath), "utf8")) as unknown);
  const curation = object(JSON.parse(await readFile(path.resolve("catalog/curation/rotaeno-display-metadata.json"), "utf8")));
  if (curation.game !== "rotaeno") throw new Error("Rotaeno curation file has the wrong game");
  const input = buildInput(manifest, curation);
  await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await writeFile(path.resolve(outputPath), JSON.stringify(input, null, 2) + String.fromCharCode(10), "utf8");
  const entries = object(input).entries as Array<JsonObject>;
  const fallbackCount = entries.filter((entry) => typeof entry.title === "string" && entry.title.includes("\u5f85\u6838\u5b9e")).length;
  console.log(JSON.stringify({ output: path.resolve(outputPath), game: "rotaeno", version: "2.26.1-display-metadata-v1", entries: entries.length, fallbackCount }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

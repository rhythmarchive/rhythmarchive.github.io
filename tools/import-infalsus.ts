import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  AssetObject,
  Catalog,
  ReleaseManifest,
  Resource,
  Rendition,
  Variant,
  type AssetObject as AssetObjectType,
  type Catalog as CatalogType,
  type Rendition as RenditionType,
  type Resource as ResourceType,
  type Variant as VariantType,
} from "../packages/domain/src/schema.js";
import { loadCatalogFile, writeCatalogAndReleaseAndBrowseAtomic } from "../packages/domain/src/catalog.js";
import {
  InfalsusCategoryBrowseProjection,
  browseProjectionSha256,
  catalogSha256FromValue,
  validateCategoryBrowseProjection,
} from "../packages/domain/src/browse.js";
import { createDeterministicUuidV7, immutableObjectKey, objectIdFromSha256 } from "../packages/domain/src/identity.js";
import { IMMUTABLE_OBJECT_CACHE_CONTROL, S3StorageClient, StorageError, type StorageClient } from "../packages/domain/src/storage.js";
import { generateThumbnailSet } from "../packages/domain/src/thumbnails.js";
import { validateCatalog, validateReleaseManifestConsistency } from "../packages/domain/src/validation.js";
import { sha256File } from "../packages/domain/src/workspace.js";

type JsonRecord = Record<string, unknown>;
type InfalsusSong = {
  identity: string;
  song_id: number;
  base_name: string;
  title: string;
  artist: string;
  available: boolean;
  jacket_illustrator?: string;
  charts: Array<JsonRecord>;
  artwork: {
    identity: string;
    canonical: {
      file: string;
      width: number;
      height: number;
      pixel_sha256: string;
      file_sha256: string;
      texture_format?: string;
    };
    small?: { width: number; height: number };
  };
  metadataPath: string;
};
type SemanticManifest = { schemaVersion: number; game: string; generatedAt: string; songs: Array<JsonRecord>; excludedSongs?: Array<JsonRecord>; source?: JsonRecord };
type Prepared = {
  song: InfalsusSong;
  metadataPath: string;
  metadataSha256: string;
  resource: ResourceType;
  variant: VariantType;
  renditions: RenditionType[];
  objects: Array<{ object: AssetObjectType; localPath: string }>;
  canonical: RenditionType;
};
type ImportPlan = {
  existing: CatalogType;
  catalog: CatalogType;
  release: ReturnType<typeof ReleaseManifest.parse>;
  browse: ReturnType<typeof InfalsusCategoryBrowseProjection.parse>;
  semantics: ReturnType<typeof InfalsusCategoryBrowseProjection.parse>;
  prepared: Prepared[];
  uploads: Array<{ object: AssetObjectType; localPath: string }>;
  sourceHash: string;
  sourceSnapshot: string;
  sourceVersion: string;
  reviewPlanPath: string;
  reviewPlanSha256: string;
};

const ROOT = path.resolve(".");
const PUBLISH_ROOT = path.resolve("temp/infalsus/publish");
const CANONICAL_ROOT = path.join(PUBLISH_ROOT, "canonical");
const METADATA_ROOT = path.join(PUBLISH_ROOT, "metadata");
const SEMANTIC_MANIFEST_PATH = path.join(PUBLISH_ROOT, "manifests", "infalsus-semantic-manifest.json");
const DERIVED_ROOT = path.join(PUBLISH_ROOT, "derived-thumbnails");
const REVIEW_ROOT = path.join(PUBLISH_ROOT, "review");

function ensure(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as JsonRecord).sort(([left], [right]) => left.localeCompare(right, "en")).map(([key, nested]) => [key, canonicalJson(nested)]));
  }
  return value;
}

function semanticManifestHash(manifest: SemanticManifest): string {
  const rows = (values: Array<JsonRecord> | undefined): JsonRecord[] => [...(values ?? [])].sort((left, right) => (text(left.identity) ?? "").localeCompare(text(right.identity) ?? "", "en"));
  const semantic = { schemaVersion: manifest.schemaVersion, game: manifest.game, songs: rows(manifest.songs), excludedSongs: rows(manifest.excludedSongs) };
  return createHash("sha256").update(JSON.stringify(canonicalJson(semantic))).digest("hex");
}
function uuid(prefix: string, identity: string): string {
  return createDeterministicUuidV7(`infalsus:${prefix}:${identity}`);
}

function safePath(root: string, relative: string): string {
  const base = path.resolve(root);
  const resolved = path.resolve(base, relative.replace(/\\/gu, path.sep));
  const back = path.relative(base, resolved);
  ensure(back === "" || (!back.startsWith("..") && !path.isAbsolute(back)), `path escapes root: ${relative}`);
  return resolved;
}

function portable(value: string): string {
  return value.replace(/\\/gu, "/");
}

function jsonString(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

async function jsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const partial = `${filePath}.partial-${process.pid}-${Date.now()}`;
  await writeFile(partial, jsonString(value), "utf8");
  await rename(partial, filePath);
}

function record(value: unknown, name: string): JsonRecord {
  ensure(value && typeof value === "object" && !Array.isArray(value), `${name} must be an object`);
  return value as JsonRecord;
}

function safeFileStem(song: InfalsusSong): string {
  return `infalsus-${song.song_id}-${song.base_name}`.replace(/[^A-Za-z0-9._-]/gu, "_");
}

function chartMetadata(song: InfalsusSong): JsonRecord[] {
  return song.charts.map((chart) => ({
    chartId: text(chart.chart_id) ?? "unknown",
    available: chart.available === true,
    ...(typeof chart.difficulty === "number" ? { difficulty: chart.difficulty } : {}),
    ...(typeof chart.rating === "number" ? { rating: chart.rating } : {}),
    ...(text(chart.chart_designer) ? { chartDesigner: text(chart.chart_designer) } : {}),
    ...(text(chart.jacket_designer) ? { jacketDesigner: text(chart.jacket_designer) } : {}),
  }));
}

function resourceMetadata(song: InfalsusSong, sourceVersion: string): JsonRecord {
  const canonical = song.artwork.canonical;
  return {
    songId: String(song.song_id),
    baseName: song.base_name,
    artist: song.artist,
    ...(song.jacket_illustrator ? { jacketIllustrator: song.jacket_illustrator } : {}),
    gameVersion: sourceVersion,
    charts: chartMetadata(song),
    artworkIdentity: song.artwork.identity,
    artworkPixelSha256: canonical.pixel_sha256,
    artworkFileSha256: canonical.file_sha256,
    artworkWidth: canonical.width,
    artworkHeight: canonical.height,
    textureFormat: canonical.texture_format ?? "unknown",
  };
}

function aliases(song: InfalsusSong): Array<{ value: string; kind: "title" | "filename" }> {
  return [
    { value: song.title, kind: "title" },
    { value: song.base_name, kind: "filename" },
  ];
}

function objectProvenance(sourceRelativePath: string, sourceFilename: string, sourceSha256: string, sourceVersion: string, detail: string) {
  return [{
    sourceType: "infalsus_demo" as const,
    sourceRelativePath: portable(sourceRelativePath),
    sourceFilename,
    sourceSha256,
    gameVersion: sourceVersion,
    evidence: [{ kind: "sha256" as const, detail, confidence: "high" as const }],
  }];
}

function assetObject(input: {
  sha256: string;
  mime: "image/png" | "image/webp";
  extension: "png" | "webp";
  sizeBytes: number;
  width: number;
  height: number;
  sourceRelativePath: string;
  sourceFilename: string;
  sourceSha256: string;
  sourceVersion: string;
  detail: string;
}): AssetObjectType {
  return AssetObject.parse({
    catalogSchemaVersion: "1.0",
    id: objectIdFromSha256(input.sha256),
    sha256: input.sha256,
    mime: input.mime,
    extension: input.extension,
    sizeBytes: input.sizeBytes,
    width: input.width,
    height: input.height,
    alpha: "unknown",
    objectKey: immutableObjectKey(input.sha256, input.extension),
    createdAt: new Date().toISOString(),
    provenance: objectProvenance(input.sourceRelativePath, input.sourceFilename, input.sourceSha256, input.sourceVersion, input.detail),
  });
}

async function loadSongs(): Promise<{ songs: InfalsusSong[]; sourceHash: string; sourceVersion: string; sourceSnapshot: string }> {
  const manifest = JSON.parse(await readFile(SEMANTIC_MANIFEST_PATH, "utf8")) as SemanticManifest;
  ensure(manifest.schemaVersion === 1 && manifest.game === "infalsus", "invalid In Falsus semantic manifest");
  const sourceHash = semanticManifestHash(manifest);
  const sourceInfo = manifest.source ? record(manifest.source, "semantic manifest source") : {};
  const sourceVersion = text(sourceInfo.product) ?? "In Falsus Demo";
  const metadataFiles = new Map<string, string>();
  for (const entry of await (await import("node:fs/promises")).readdir(METADATA_ROOT)) {
    if (!entry.endsWith(".json") || entry === "excluded.json") continue;
    const metadataPath = path.join(METADATA_ROOT, entry);
    const parsed = record(JSON.parse(await readFile(metadataPath, "utf8")), metadataPath);
    const identity = text(parsed.identity);
    if (identity) metadataFiles.set(identity, metadataPath);
  }
  const songs: InfalsusSong[] = [];
  for (const rawSong of manifest.songs) {
    const identity = text(rawSong.identity);
    ensure(identity, "semantic manifest song identity is missing");
    const metadataPath = metadataFiles.get(identity);
    ensure(metadataPath, `missing metadata for ${identity}`);
    const parsedSong = record(JSON.parse(await readFile(metadataPath, "utf8")), metadataPath) as unknown as InfalsusSong;
    const song = { ...parsedSong, metadataPath };
    ensure(song.available === true, `${identity} is not available`);
    ensure(song.artwork?.canonical?.width === 2048 && song.artwork.canonical.height === 2048, `${identity} canonical artwork is not 2048x2048`);
    ensure(song.artwork.small?.width === 512 && song.artwork.small.height === 512, `${identity} small artwork is not 512x512`);
    const semanticArtwork = record(rawSong.artwork, `${identity}.artwork`);
    ensure(text(semanticArtwork.pixel_sha256) === song.artwork.canonical.pixel_sha256, `${identity} semantic/canonical pixel hash mismatch`);
    songs.push(song);
  }
  ensure(songs.length > 0, "no available In Falsus songs found");
  return { songs, sourceHash, sourceVersion, sourceSnapshot: `infalsus-demo:${sourceHash}` };
}

async function prepareSong(song: InfalsusSong, sourceHash: string, sourceSnapshot: string, sourceVersion: string): Promise<Prepared> {
  const metadataPath = safePath(PUBLISH_ROOT, path.relative(PUBLISH_ROOT, song.metadataPath));
  const canonicalPath = safePath(CANONICAL_ROOT, song.artwork.canonical.file);
  const metadataSha256 = await sha256File(metadataPath);
  const canonicalInfo = await sharp(canonicalPath).metadata();
  ensure(canonicalInfo.format === "png" && canonicalInfo.width === 2048 && canonicalInfo.height === 2048, `${song.identity} canonical PNG contract failed`);
  const canonicalSha256 = await sha256File(canonicalPath);
  ensure(canonicalSha256 === song.artwork.canonical.file_sha256, `${song.identity} canonical file hash mismatch`);
  const decoded = await sharp(canonicalPath).ensureAlpha().raw().toBuffer();
  const pixelSha256 = createHash("sha256").update(decoded).digest("hex");
  ensure(pixelSha256 === song.artwork.canonical.pixel_sha256, `${song.identity} canonical pixel hash mismatch`);

  const resourceId = uuid("resource", song.identity);
  const variantId = uuid("variant", `${song.identity}:canonical`);
  const canonicalRenditionId = uuid("rendition", `${song.identity}:canonical`);
  const resource = Resource.parse({
    catalogSchemaVersion: "1.0",
    id: resourceId,
    game: "infalsus",
    resourceType: "jacket",
    title: song.title,
    aliases: aliases(song),
    externalIdentities: [{ namespace: "infalsus", key: "song-identity", value: song.identity, source: "unknown", confidence: "high" }],
    metadata: resourceMetadata(song, sourceVersion),
    relations: [],
    provenance: [{
      sourceType: "infalsus_demo",
      sourceSnapshot,
      gameVersion: sourceVersion,
      sourceRelativePath: portable(path.relative(ROOT, metadataPath)),
      sourceFilename: path.basename(metadataPath),
      sourceSha256: metadataSha256,
      evidence: [
        { kind: "metadata", detail: "SongData availability and title/artist mapping were resolved by the reusable extractor.", confidence: "high" },
        { kind: "sha256", detail: "Canonical artwork file and decoded pixel hashes were verified before import.", confidence: "high" },
      ],
    }],
    lifecycle: { status: "published", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), publishedAt: new Date().toISOString() },
  });
  const variant = Variant.parse({ catalogSchemaVersion: "1.0", id: variantId, resourceId, variantKey: "default", kind: "default", semanticStatus: "confirmed", preferred: true });
  const canonicalObject = assetObject({
    sha256: canonicalSha256,
    mime: "image/png",
    extension: "png",
    sizeBytes: (await stat(canonicalPath)).size,
    width: 2048,
    height: 2048,
    sourceRelativePath: path.relative(ROOT, canonicalPath),
    sourceFilename: path.basename(canonicalPath),
    sourceSha256: canonicalSha256,
    sourceVersion,
    detail: `Canonical 2048x2048 artwork resolved from ${song.artwork.identity}; Texture2D pixel hash ${pixelSha256}.`,
  });
  const canonical = Rendition.parse({ catalogSchemaVersion: "1.0", id: canonicalRenditionId, variantId, renditionType: "original", origin: "source", publishable: true, objectId: canonicalObject.id, downloadFilename: `${safeFileStem(song)}.png`, generatedBy: "extractor", createdAt: new Date().toISOString() });
  const thumbnailResults = await generateThumbnailSet(canonicalPath, DERIVED_ROOT, safeFileStem(song));
  const thumbnails = thumbnailResults.map((thumbnail) => {
    const object = assetObject({
      sha256: thumbnail.sha256,
      mime: "image/webp",
      extension: "webp",
      sizeBytes: thumbnail.sizeBytes,
      width: thumbnail.pixelWidth,
      height: thumbnail.height,
      sourceRelativePath: path.relative(ROOT, thumbnail.absolutePath),
      sourceFilename: thumbnail.relativePath,
      sourceSha256: thumbnail.sha256,
      sourceVersion,
      detail: `Generated ${thumbnail.width}px preview from the canonical 2048x2048 artwork.`,
    });
    return Rendition.parse({ catalogSchemaVersion: "1.0", id: uuid("rendition", `${song.identity}:thumbnail-${thumbnail.width}`), variantId, renditionType: `thumbnail-${thumbnail.width}`, origin: "derived", publishable: false, objectId: object.id, downloadFilename: thumbnail.relativePath, sourceRenditionId: canonical.id, generatedBy: "thumbnailer", createdAt: new Date().toISOString() });
  });
  return {
    song,
    metadataPath,
    metadataSha256,
    resource,
    variant,
    renditions: [canonical, ...thumbnails],
    objects: [{ object: canonicalObject, localPath: canonicalPath }, ...thumbnailResults.map((thumbnail) => ({ object: assetObject({ sha256: thumbnail.sha256, mime: "image/webp", extension: "webp", sizeBytes: thumbnail.sizeBytes, width: thumbnail.pixelWidth, height: thumbnail.height, sourceRelativePath: path.relative(ROOT, thumbnail.absolutePath), sourceFilename: thumbnail.relativePath, sourceSha256: thumbnail.sha256, sourceVersion, detail: `Generated ${thumbnail.width}px preview from the canonical 2048x2048 artwork.` }), localPath: thumbnail.absolutePath }))],
    canonical,
  };
}

function previousIdentity(resource: ResourceType): string | undefined {
  return resource.externalIdentities.find((identity) => identity.namespace === "infalsus" && identity.key === "song-identity")?.value;
}

function previousRendition(catalog: CatalogType, renditionId: string): RenditionType | undefined {
  return catalog.renditions.find((rendition) => rendition.id === renditionId);
}

async function buildPlan(): Promise<ImportPlan> {
  const { songs, sourceHash, sourceSnapshot, sourceVersion } = await loadSongs();
  const existing = await loadCatalogFile();
  const previousInfalsus = existing.resources.filter((resource) => resource.game === "infalsus");
  const currentIdentities = new Set(songs.map((song) => song.identity));
  const removed = previousInfalsus.map(previousIdentity).filter((identity): identity is string => identity !== undefined && !currentIdentities.has(identity));
  ensure(removed.length === 0, `In Falsus source removed existing songs; review required before import: ${removed.join(", ")}`);
  const prepared = await Promise.all(songs.map((song) => prepareSong(song, sourceHash, sourceSnapshot, sourceVersion)));
  const objectMap = new Map(existing.objects.map((object) => [object.id, object]));
  const newObjects: AssetObjectType[] = [];
  const uploads = new Map<string, { object: AssetObjectType; localPath: string }>();
  for (const item of prepared) {
    for (const entry of item.objects) {
      if (!objectMap.has(entry.object.id)) {
        objectMap.set(entry.object.id, entry.object);
        newObjects.push(entry.object);
      }
      uploads.set(entry.object.id, entry);
    }
  }
  const oldResourceIds = new Set(previousInfalsus.map((resource) => resource.id));
  const oldVariantIds = new Set(existing.variants.filter((variant) => oldResourceIds.has(variant.resourceId)).map((variant) => variant.id));
  const currentResources = prepared.map((item) => item.resource);
  const currentVariants = prepared.map((item) => item.variant);
  const currentRenditions = prepared.flatMap((item) => item.renditions);
  const catalog = Catalog.parse({
    catalogSchemaVersion: "1.0",
    catalogId: existing.catalogId,
    generatedAt: new Date().toISOString(),
    resources: existing.resources.filter((resource) => resource.game !== "infalsus").concat(currentResources),
    variants: existing.variants.filter((variant) => !oldVariantIds.has(variant.id)).concat(currentVariants),
    renditions: existing.renditions.filter((rendition) => !oldVariantIds.has(rendition.variantId)).concat(currentRenditions),
    objects: [...existing.objects, ...newObjects.filter((object) => !existing.objects.some((prior) => prior.id === object.id))],
    releaseManifestIds: existing.releaseManifestIds,
  });
  const catalogValidation = validateCatalog(catalog);
  if (!catalogValidation.success) {
    throw new Error(`Catalog validation failed: ${catalogValidation.issues.slice(0, 5).map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
  }
  const previousByIdentity = new Map(previousInfalsus.map((resource) => [previousIdentity(resource), resource]));
  const changes: Array<Record<string, string>> = [];
  const publishedRenditions: Array<{ resourceId: string; variantId: string; renditionId: string; objectId: string; downloadFilename: string }> = [];
  for (const item of prepared) {
    const oldResource = previousByIdentity.get(item.song.identity);
    if (!oldResource) {
      changes.push({ changeType: "added-resource", resourceId: item.resource.id, detail: "In Falsus Demo published jacket" });
      changes.push({ changeType: "added-variant", resourceId: item.resource.id, variantId: item.variant.id, detail: "Stable default canonical artwork variant" });
    } else if (JSON.stringify(oldResource.metadata) !== JSON.stringify(item.resource.metadata) || oldResource.title !== item.resource.title) {
      changes.push({ changeType: "metadata-changed", resourceId: item.resource.id, detail: "In Falsus SongData metadata changed" });
    }
    for (const rendition of item.renditions) {
      const old = oldResource ? previousRendition(existing, rendition.id) : undefined;
      const variant = item.variant;
      if (!old) {
        changes.push({ changeType: "added-rendition", resourceId: item.resource.id, variantId: variant.id, renditionId: rendition.id, objectId: rendition.objectId, detail: `${rendition.renditionType} imported from In Falsus Demo` });
      } else if (old.objectId !== rendition.objectId) {
        changes.push({ changeType: "replaced-rendition", resourceId: item.resource.id, variantId: variant.id, renditionId: rendition.id, objectId: rendition.objectId, previousObjectId: old.objectId, detail: `${rendition.renditionType} content changed in In Falsus Demo` });
      }
    }
    publishedRenditions.push({ resourceId: item.resource.id, variantId: item.variant.id, renditionId: item.canonical.id, objectId: item.canonical.objectId, downloadFilename: item.canonical.downloadFilename });
  }
  const releaseId = uuid("release", sourceSnapshot);
  const release = ReleaseManifest.parse({
    releaseSchemaVersion: "1.0",
    id: releaseId,
    updateBatchId: uuid("batch", sourceSnapshot),
    game: "infalsus",
    baseVersion: previousInfalsus.length > 0 ? "previous-catalog" : "none",
    targetVersion: sourceVersion,
    createdAt: new Date().toISOString(),
    status: "published",
    changes,
    affectedResourceIds: prepared.map((item) => item.resource.id),
    publishedRenditions,
    removedFromCurrentSource: [],
    notes: ["Canonical artwork is the extracted 2048x2048 Texture2D PNG; 512x512 source variants remain extractor provenance only.", "New or changed songs require semantic-manifest review before a future import is accepted."],
  });
  const browseResources = prepared.map((item, index) => ({
    resourceId: item.resource.id,
    resourceType: "jacket",
    displayTitle: item.song.title,
    metadata: {
      songId: String(item.song.song_id),
      artist: item.song.artist,
      ...(item.song.jacket_illustrator ? { jacketIllustrator: item.song.jacket_illustrator } : {}),
      gameVersion: sourceVersion,
    },
    badges: [],
    searchTerms: [item.song.title, item.song.artist, String(item.song.song_id), item.song.base_name],
    sortOrder: index,
    facets: {},
  }));
  const browse = InfalsusCategoryBrowseProjection.parse({ schemaVersion: 1, game: "infalsus", generatedAt: catalog.generatedAt, source: { snapshot: sourceSnapshot, sha256: sourceHash }, resources: browseResources });
  const browseValidation = validateCategoryBrowseProjection(browse, catalog);
  if (!browseValidation.success) {
    throw new Error(`In Falsus Browse validation failed: ${browseValidation.issues.slice(0, 5).join("; ")}`);
  }
  const semantics = browse;
  const releaseWithCatalog = ReleaseManifest.parse({ ...release, id: releaseId, updateBatchId: uuid("batch", sourceSnapshot) });
  const releaseValidation = validateReleaseManifestConsistency(releaseWithCatalog, catalog);
  if (!releaseValidation.success) {
    throw new Error(`Release validation failed: ${releaseValidation.issues.slice(0, 5).map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
  }
  const reviewPlanPath = path.join(REVIEW_ROOT, "infalsus-import-plan.json");
  await jsonAtomic(reviewPlanPath, {
    schemaVersion: 1,
    game: "infalsus",
    sourceSnapshot,
    sourceSha256: sourceHash,
    songs: prepared.map((item) => ({ identity: item.song.identity, songId: item.song.song_id, title: item.song.title, artist: item.song.artist, resourceId: item.resource.id, canonicalObjectId: item.canonical.objectId })),
    changes,
    removed,
  });
  const reviewPlanSha256 = await sha256File(reviewPlanPath);
  return { existing, catalog: Catalog.parse({ ...catalog, releaseManifestIds: [...new Set([...catalog.releaseManifestIds, releaseId])] }), release: releaseWithCatalog, browse, semantics, prepared, uploads: [...uploads.values()], sourceHash, sourceSnapshot, sourceVersion, reviewPlanPath, reviewPlanSha256 };
}

async function upload(plan: ImportPlan): Promise<{ existing: number; uploaded: number; verified: number; bytes: number }> {
  const storage: StorageClient = new S3StorageClient();
  ensure(storage.status === "READY", "ROS_NOT_CONFIGURED");
  let existing = 0;
  let uploaded = 0;
  let verified = 0;
  let bytes = 0;
  for (const entry of plan.uploads) {
    let present = false;
    try {
      const head = await storage.headObject(entry.object.objectKey);
      ensure(head.sizeBytes === entry.object.sizeBytes, `ROS_OBJECT_COLLISION size mismatch: ${entry.object.objectKey}`);
      present = true;
    } catch (error) {
      if (!(error instanceof StorageError) || !error.notFound) throw error;
    }
    if (present) existing += 1;
    else {
      await storage.putObject({ objectKey: entry.object.objectKey, body: createReadStream(entry.localPath), sizeBytes: entry.object.sizeBytes, contentType: entry.object.mime, cacheControl: IMMUTABLE_OBJECT_CACHE_CONTROL });
      uploaded += 1;
      bytes += entry.object.sizeBytes;
    }
    const check = await storage.verifyObject(entry.object.objectKey, { sizeBytes: entry.object.sizeBytes, sha256: entry.object.sha256 });
    ensure(check.verified, `ROS_OBJECT_COLLISION hash mismatch: ${entry.object.objectKey}`);
    verified += 1;
  }
  return { existing, uploaded, verified, bytes };
}

function cliOption(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : undefined;
}

async function requireReviewApproval(plan: ImportPlan): Promise<void> {
  const approvalPath = path.resolve(cliOption("--approval") ?? path.join(REVIEW_ROOT, "infalsus-approval.json"));
  let approval: JsonRecord;
  try {
    approval = record(JSON.parse(await readFile(approvalPath, "utf8")), approvalPath);
  } catch {
    throw new Error(`REVIEW_REQUIRED: inspect ${plan.reviewPlanPath}, then provide --approval ${approvalPath} with matching sourceSha256 and planSha256`);
  }
  ensure(approval.schemaVersion === 1 && text(approval.game) === "infalsus", "REVIEW_REQUIRED: approval file schema/game is invalid");
  ensure(text(approval.sourceSha256) === plan.sourceHash, "REVIEW_REQUIRED: approval sourceSha256 does not match the current semantic manifest");
  ensure(text(approval.planSha256) === plan.reviewPlanSha256, "REVIEW_REQUIRED: approval planSha256 does not match the current import plan");
  ensure(text(approval.approvedBy), "REVIEW_REQUIRED: approval approvedBy is missing");
  ensure(text(approval.approvedAt), "REVIEW_REQUIRED: approval approvedAt is missing");
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const plan = await buildPlan();
  let ros = { existing: 0, uploaded: 0, verified: 0, bytes: 0 };
  if (apply) {
    await requireReviewApproval(plan);
    ros = await upload(plan);
    const manifestPath = path.resolve("catalog/browse/manifest.json");
    const currentManifest = JSON.parse(await readFile(manifestPath, "utf8")) as JsonRecord;
    const currentGames = record(currentManifest.games, "catalog browse games");
    const currentFiles = record(currentManifest.files, "catalog browse files");
    const nextManifest = {
      ...currentManifest,
      generatedAt: typeof currentManifest.generatedAt === "string" ? currentManifest.generatedAt : plan.catalog.generatedAt,
      games: {
        ...currentGames,
        infalsus: {
          sourceVersion: plan.sourceVersion,
          sourceSha256: plan.sourceHash,
          fileSha256: browseProjectionSha256(plan.browse),
          recordCounts: { songs: plan.browse.resources.length, artworks: plan.browse.resources.length },
        },
      },
      files: { ...currentFiles, infalsus: "infalsus.json", infalsusSemantics: "infalsus-semantics.json" },
      catalog: { catalogId: plan.catalog.catalogId, catalogSha256: catalogSha256FromValue(plan.catalog), catalogGeneratedAt: plan.catalog.generatedAt },
    };
    const parsedManifest = (await import("../packages/domain/src/browse.js")).BrowseManifest.parse(nextManifest);
    await writeCatalogAndReleaseAndBrowseAtomic(plan.catalog, plan.release, null, {
      additionalFiles: [
        { targetPath: path.resolve("catalog/browse/infalsus.json"), value: plan.browse },
        { targetPath: path.resolve("catalog/browse/infalsus-semantics.json"), value: plan.semantics },
        { targetPath: manifestPath, value: parsedManifest },
      ],
    });
  }
  const report = {
    schemaVersion: 1,
    status: apply ? "ROS_OBJECTS_VERIFIED_CATALOG_COMMITTED" : "DRY_RUN_PLAN_VALIDATED",
    dryRun: !apply,
    sourceSnapshot: plan.sourceSnapshot,
    sourceSha256: plan.sourceHash,
    songs: plan.prepared.length,
    canonicalArtworks: plan.prepared.length,
    plannedObjects: plan.uploads.length,
    ros,
    catalog: { resources: plan.catalog.resources.filter((resource) => resource.game === "infalsus").length, releaseManifestId: plan.release.id },
    website: { browseProjection: "catalog/browse/infalsus.json", semantics: "catalog/browse/infalsus-semantics.json", canonicalRendition: "original" },
    review: { planPath: portable(path.relative(ROOT, plan.reviewPlanPath)), planSha256: plan.reviewPlanSha256, applyRequiresApproval: true },
  };
  await jsonAtomic(path.join(REVIEW_ROOT, "infalsus-import-report.json"), report);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "unknown In Falsus import error");
  process.exitCode = 1;
});

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
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
  type ReleaseManifest as ReleaseManifestType,
  type Rendition as RenditionType,
  type Resource as ResourceType,
  type Variant as VariantType,
} from "../packages/domain/src/schema.js";
import {
  atomicWriteJson,
  loadCatalogFile,
  writeCatalogAndReleaseAtomic,
} from "../packages/domain/src/catalog.js";
import {
  createDeterministicUuidV7,
  immutableObjectKey,
  objectIdFromSha256,
} from "../packages/domain/src/identity.js";
import {
  UnifiedAssetManifest,
  releaseIdentityKey,
} from "../packages/domain/src/release.js";
import { generateThumbnailSet } from "../packages/domain/src/thumbnails.js";
import { validateCatalog, validateReleaseManifestConsistency } from "../packages/domain/src/validation.js";
import { sha256File } from "../packages/domain/src/workspace.js";
import { createWorkflowState, saveWorkflowState } from "../packages/domain/src/workflow-state.js";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonRecord = Record<string, JsonValue>;
type SupportedMime = "image/png" | "image/webp" | "audio/ogg" | "application/octet-stream";
type SupportedExtension = "png" | "webp" | "ogg" | "bin";
type InputFile = {
  path: string;
  sha256: string;
  sizeBytes: number;
  mime: SupportedMime;
  extension: SupportedExtension;
  width?: number;
  height?: number;
};
type InputSong = {
  songId: string;
  catalogTitle: string;
  wikiTitle: string;
  wikiRow: number;
  matchStrategy: string;
  metadata: JsonRecord;
  catalogDifficulties: string[];
  assets: {
    cover: InputFile;
    music: InputFile;
    preview: InputFile;
    charts: Record<string, InputFile>;
  };
  alternateCovers: Array<{
    variantKey: string;
    label: string;
    sourcePath: string;
    assets: InputFile;
  }>;
};
type ParadigmInput = {
  schemaVersion: number;
  game: "paradigm-reboot";
  version: string;
  catalogRevision: string;
  sourceSnapshot: string;
  sourceType: "paradigm_apk";
  sourceCatalogSha256?: string;
  wiki: {
    url: string;
    lastModified: string;
    fetchedAt: string;
    tableRows: number;
  };
  songs: InputSong[];
};
type PreparedFile = {
  object: AssetObjectType;
  localPath: string;
};
type PreparedVariant = {
  variant: VariantType;
  renditions: RenditionType[];
  files: PreparedFile[];
  originalRendition: RenditionType;
};
type PreparedPlan = {
  catalog: CatalogType;
  release: ReleaseManifestType;
  unifiedManifest: ReturnType<typeof UnifiedAssetManifest.parse>;
  curation: JsonRecord;
  uploads: PreparedFile[];
  summary: {
    resources: number;
    variants: number;
    renditions: number;
    publishedRenditions: number;
    objects: number;
    publishedObjects: number;
    songs: number;
    alternateCovers: number;
    charts: number;
  };
};

type CoverOrientationFixPlan = {
  catalog: CatalogType;
  release: ReleaseManifestType;
  report: JsonRecord;
  summary: {
    songs: number;
    covers: number;
    changedCovers: number;
    changedThumbnails: number;
    changedRenditions: number;
    newObjects: number;
  };
};

const ROOT = path.resolve(".");
const DEFAULT_INPUT = path.resolve("temp/rhythmctl/paradigm-reboot/4.10/metadata/paradigm-public-input.json");
const CANDIDATE_CATALOG = path.resolve("temp/rhythmctl/paradigm-reboot/4.10/release/candidate-catalog.json");
const CANDIDATE_RELEASE = path.resolve("temp/rhythmctl/paradigm-reboot/4.10/release/release-manifest.json");
const CANDIDATE_MANIFEST = path.resolve("temp/rhythmctl/paradigm-reboot/4.10/release/candidate-manifest.json");
const WORKFLOW_STATE = path.resolve("temp/rhythmctl/paradigm-reboot/4.10/formal/state.json");
const THUMBNAIL_ROOT = path.resolve("temp/rhythmctl/paradigm-reboot/4.10/release/thumbnails");
const ORIENTATION_FIX_ROOT = path.resolve("temp/rhythmctl/paradigm-reboot/4.10/orientation-fix");
const ORIENTATION_FIX_CATALOG = path.join(ORIENTATION_FIX_ROOT, "candidate-catalog.json");
const ORIENTATION_FIX_RELEASE = path.join(ORIENTATION_FIX_ROOT, "release-manifest.json");
const ORIENTATION_FIX_REPORT = path.join(ORIENTATION_FIX_ROOT, "orientation-fix.json");
const ORIENTATION_FIX_THUMBNAILS = path.join(ORIENTATION_FIX_ROOT, "thumbnails");
const CURATION_PATH = path.resolve("catalog/curation/paradigm-reboot-song-metadata.json");
const NOW = "2026-09-05T00:00:00.000Z";
const CHART_LABELS: Record<string, string> = {
  detected: "DET",
  invaded: "IVD",
  massive: "MSV",
  reboot: "RBT",
  chaotic: "CTC",
};

function fail(message: string): never {
  throw new Error(message);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(label + " must be an object");
  return value as Record<string, unknown>;
}

function jsonRecord(value: unknown, label: string): JsonRecord {
  return record(value, label) as JsonRecord;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim())))];
}

function uuid(seed: string): string {
  return createDeterministicUuidV7("paradigm-reboot:" + seed);
}

function logicalPath(songId: string, role: string): string {
  return "paradigm/4.10/D146/" + songId + "/" + role;
}

function sourceCatalogSha256(input: ParadigmInput): string {
  if (input.sourceCatalogSha256 && /^[0-9a-f]{64}$/iu.test(input.sourceCatalogSha256)) return input.sourceCatalogSha256.toLowerCase();
  return createHash("sha256").update(input.sourceSnapshot, "utf8").digest("hex");
}

function localInputPath(inputFile: InputFile): string {
  const resolved = path.resolve(inputFile.path);
  const relative = path.relative(ROOT, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) fail("input file escapes workspace: " + inputFile.path);
  return resolved;
}

async function verifyInputFile(inputFile: InputFile, label: string): Promise<string> {
  const localPath = localInputPath(inputFile);
  const info = await stat(localPath).catch(() => undefined);
  if (!info?.isFile()) fail("missing input file for " + label + ": " + localPath);
  if (info.size !== inputFile.sizeBytes) fail("size mismatch for " + label);
  const actualSha256 = await sha256File(localPath);
  if (actualSha256.toLowerCase() !== inputFile.sha256.toLowerCase()) fail("sha256 mismatch for " + label);
  const bytes = await readFile(localPath);
  if (inputFile.mime === "image/png" || inputFile.mime === "image/webp") {
    const image = await sharp(localPath).metadata();
    if (!image.width || !image.height) fail("image dimensions missing for " + label);
    if (inputFile.width !== undefined && inputFile.width !== image.width) fail("image width mismatch for " + label);
    if (inputFile.height !== undefined && inputFile.height !== image.height) fail("image height mismatch for " + label);
  } else if (inputFile.mime === "audio/ogg") {
    if (!bytes.subarray(0, 4).equals(Buffer.from("OggS"))) fail("OGG magic missing for " + label);
  } else {
    if (inputFile.extension !== "bin") fail("chart attachment must use bin object extension for " + label);
    const chartText = bytes.toString("utf8").replace(/^\uFEFF/u, "");
    if (!chartText.startsWith("Offset,") || !chartText.includes("\nInitBeat,")) fail("ParsaPara header missing for " + label);
  }
  return localPath;
}

function objectProvenance(input: {
  songId: string;
  role: string;
  filename: string;
  sha256: string;
  sourceSnapshot: string;
  version: string;
  detail: string;
  processingNote?: string;
}): AssetObjectType["provenance"] {
  return [{
    sourceType: "paradigm_apk",
    sourceRelativePath: logicalPath(input.songId, input.role),
    sourceFilename: input.filename,
    sourceSha256: input.sha256,
    gameVersion: input.version,
    evidence: [
      { kind: "apk-relative-path", detail: "Catalog D146 selected this public resource family.", confidence: "high" },
      { kind: "sha256", detail: input.detail, confidence: "high" },
      ...(input.processingNote ? [{ kind: "manual-note" as const, detail: input.processingNote, confidence: "high" as const }] : []),
    ],
  }];
}

function makeObject(input: {
  file: InputFile;
  songId: string;
  role: string;
  filename: string;
  sourceSnapshot: string;
  version: string;
  processingNote?: string;
}): AssetObjectType {
  const dimensions = input.file.width !== undefined && input.file.height !== undefined
    ? { width: input.file.width, height: input.file.height }
    : {};
  return AssetObject.parse({
    catalogSchemaVersion: "1.0",
    id: objectIdFromSha256(input.file.sha256),
    sha256: input.file.sha256,
    mime: input.file.mime,
    extension: input.file.extension,
    sizeBytes: input.file.sizeBytes,
    ...dimensions,
    alpha: "unknown",
    objectKey: immutableObjectKey(input.file.sha256, input.file.extension),
    createdAt: NOW,
    provenance: objectProvenance({
      songId: input.songId,
      role: input.role,
      filename: input.filename,
      sha256: input.file.sha256,
      sourceSnapshot: input.sourceSnapshot,
      version: input.version,
      detail: "Final website bytes were verified before Catalog import.",
      ...(input.processingNote ? { processingNote: input.processingNote } : {}),
    }),
  });
}

function makeRendition(input: {
  seed: string;
  variantId: string;
  objectId: string;
  type: RenditionType["renditionType"];
  origin: "source" | "derived";
  publishable: boolean;
  filename: string;
  generatedBy: RenditionType["generatedBy"];
  sourceRenditionId?: string;
  metadata?: JsonRecord;
}): RenditionType {
  return Rendition.parse({
    catalogSchemaVersion: "1.0",
    id: uuid(input.seed),
    variantId: input.variantId,
    renditionType: input.type,
    origin: input.origin,
    publishable: input.publishable,
    objectId: input.objectId,
    downloadFilename: input.filename,
    ...(input.sourceRenditionId ? { sourceRenditionId: input.sourceRenditionId } : {}),
    generatedBy: input.generatedBy,
    createdAt: NOW,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
}

function cleanPublicJson(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(cleanPublicJson).filter((item): item is JsonValue => item !== undefined);
  if (!value || typeof value !== "object") return undefined;
  const output: JsonRecord = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (/^(?:path|localPath|absolutePath)$/iu.test(key)) continue;
    const cleaned = cleanPublicJson(nested);
    if (cleaned !== undefined) output[key] = cleaned;
  }
  return output;
}

function resourceMetadata(song: InputSong): JsonRecord {
  const source = record(song.metadata, "song metadata");
  const output: JsonRecord = {};
  for (const key of ["songId", "artist", "genre", "illustrator", "length", "wikiBpm", "pack", "updateVersion", "original", "other", "gameVersion", "bpm", "bpmSource", "metadataStatus"]) {
    const value = source[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") output[key] = value;
  }
  const charts = cleanPublicJson(source.charts);
  if (charts !== undefined) output.charts = charts;
  const chartFacts = cleanPublicJson(source.chartFacts);
  if (chartFacts !== undefined) output.chartFacts = chartFacts;
  const provenance = cleanPublicJson(source.metadataProvenance);
  if (provenance !== undefined) output.metadataProvenance = provenance;
  return output;
}

function registerObject(
  object: AssetObjectType,
  localPath: string,
  objectMap: Map<string, AssetObjectType>,
  uploads: Map<string, PreparedFile>,
): AssetObjectType {
  const existing = objectMap.get(object.id);
  if (existing) {
    if (existing.sha256 !== object.sha256 || existing.mime !== object.mime || existing.extension !== object.extension) {
      fail("Object identity collision for " + object.id);
    }
    return existing;
  }
  objectMap.set(object.id, object);
  uploads.set(object.id, { object, localPath });
  return object;
}

async function prepareVariant(
  song: InputSong,
  variantKey: string,
  variantKind: VariantType["kind"],
  imageFile: InputFile,
  objectMap: Map<string, AssetObjectType>,
  uploads: Map<string, PreparedFile>,
  input: ParadigmInput,
): Promise<PreparedVariant> {
  const localPath = await verifyInputFile(imageFile, song.songId + "/" + variantKey + "/cover");
  const resourceId = uuid("resource:" + song.songId);
  const variantId = uuid("variant:" + song.songId + ":" + variantKey);
  const imageObject = registerObject(
    makeObject({
      file: imageFile,
      songId: song.songId,
      role: variantKey + "/cover",
      filename: "paradigm-" + song.songId + "-" + variantKey + ".png",
      sourceSnapshot: input.sourceSnapshot,
      version: input.version,
    }),
    localPath,
    objectMap,
    uploads,
  );
  const original = makeRendition({
    seed: "rendition:" + song.songId + ":" + variantKey + ":cover",
    variantId,
    objectId: imageObject.id,
    type: "original",
    origin: "source",
    publishable: true,
    filename: "paradigm-" + song.songId + "-" + variantKey + ".png",
    generatedBy: "extractor",
    metadata: { attachmentKind: "cover", variantKey },
  });
  const renditions: RenditionType[] = [original];
  const thumbnailResults = await generateThumbnailSet(localPath, THUMBNAIL_ROOT, "paradigm-" + song.songId + "-" + variantKey);
  for (const thumbnail of thumbnailResults) {
    const thumbnailFile: InputFile = {
      path: thumbnail.absolutePath,
      sha256: thumbnail.sha256,
      sizeBytes: thumbnail.sizeBytes,
      mime: "image/webp",
      extension: "webp",
      width: thumbnail.pixelWidth,
      height: thumbnail.height,
    };
    const thumbnailPath = await verifyInputFile(thumbnailFile, song.songId + "/" + variantKey + "/thumbnail-" + thumbnail.width);
    const thumbnailObject = registerObject(
      makeObject({
        file: thumbnailFile,
        songId: song.songId,
        role: variantKey + "/thumbnail-" + thumbnail.width,
        filename: thumbnail.relativePath,
        sourceSnapshot: input.sourceSnapshot,
        version: input.version,
      }),
      thumbnailPath,
      objectMap,
      uploads,
    );
    renditions.push(makeRendition({
      seed: "rendition:" + song.songId + ":" + variantKey + ":thumbnail:" + thumbnail.width,
      variantId,
      objectId: thumbnailObject.id,
      type: ("thumbnail-" + thumbnail.width) as RenditionType["renditionType"],
      origin: "derived",
      publishable: false,
      filename: thumbnail.relativePath,
      generatedBy: "thumbnailer",
      sourceRenditionId: original.id,
    }));
  }
  const variant = Variant.parse({
    catalogSchemaVersion: "1.0",
    id: variantId,
    resourceId,
    variantKey,
    kind: variantKind,
    semanticStatus: "confirmed",
    ...(variantKey === "default" ? { preferred: true } : {}),
    note: variantKey === "default" ? "Client catalog primary cover." : "Client catalog band-variant cover; retained on the owning song.",
  });
  return { variant, renditions, files: [], originalRendition: original };
}

async function prepareAttachment(
  song: InputSong,
  variantId: string,
  attachmentKind: "music" | "preview-audio" | "chart",
  chartKind: string | undefined,
  inputFile: InputFile,
  objectMap: Map<string, AssetObjectType>,
  uploads: Map<string, PreparedFile>,
  input: ParadigmInput,
): Promise<RenditionType> {
  const kindLabel = chartKind ? CHART_LABELS[chartKind] ?? chartKind.toUpperCase() : attachmentKind;
  const localPath = await verifyInputFile(inputFile, song.songId + "/" + kindLabel);
  const filename = attachmentKind === "music"
    ? "paradigm-" + song.songId + "-music.ogg"
    : attachmentKind === "preview-audio"
      ? "paradigm-" + song.songId + "-preview.ogg"
      : "paradigm-" + song.songId + "-" + kindLabel.toLowerCase() + ".txt";
  const object = registerObject(
    makeObject({
      file: inputFile,
      songId: song.songId,
      role: chartKind ? "chart/" + chartKind : attachmentKind,
      filename,
      sourceSnapshot: input.sourceSnapshot,
      version: input.version,
    }),
    localPath,
    objectMap,
    uploads,
  );
  return makeRendition({
    seed: "rendition:" + song.songId + ":default:attachment:" + (chartKind ?? attachmentKind),
    variantId,
    objectId: object.id,
    type: attachmentKind,
    origin: "source",
    publishable: true,
    filename,
    generatedBy: "extractor",
    metadata: {
      attachmentKind: attachmentKind === "preview-audio" ? "preview" : attachmentKind,
      ...(chartKind ? { difficulty: kindLabel, chartKind } : {}),
    },
  });
}

function curationFromInput(input: ParadigmInput): JsonRecord {
  const songs = input.songs.map((song) => ({
    songId: song.songId,
    catalogTitle: song.catalogTitle,
    wikiTitle: song.wikiTitle,
    wikiRow: song.wikiRow,
    matchStrategy: song.matchStrategy,
    metadata: resourceMetadata(song),
  }));
  return {
    schemaVersion: 1,
    game: input.game,
    version: input.version,
    catalogRevision: input.catalogRevision,
    sourceSnapshot: input.sourceSnapshot,
    sourceType: input.sourceType,
    wiki: input.wiki,
    mappingPolicy: "Catalog song_id is primary identity; exact normalized title is preferred, and explicit public title aliases resolve the remaining renamed, translated, remixed, or duplicate Wiki entries.",
    songs,
  };
}

async function buildPlan(input: ParadigmInput, existing: CatalogType): Promise<PreparedPlan> {
  if (input.schemaVersion !== 1 || input.game !== "paradigm-reboot") fail("invalid Paradigm public input");
  if (input.version !== "4.10" || input.catalogRevision !== "D146") fail("input is not the approved 4.10/D146 baseline");
  if (input.songs.length !== 419) fail("Paradigm input must contain exactly 419 songs");
  const existingParadigm = existing.resources.filter((resource) => resource.game === "paradigm-reboot");
  if (existingParadigm.length > 0) fail("Paradigm resources already exist; use the update workflow instead of onboarding import");

  const objectMap = new Map(existing.objects.map((object) => [object.id, object]));
  const uploads = new Map<string, PreparedFile>();
  const resources: ResourceType[] = [];
  const variants: VariantType[] = [];
  const renditions: Array<{ resourceId: string; variantId: string; rendition: RenditionType }> = [];
  const publishedRenditions: ReleaseManifestType["publishedRenditions"] = [];
  const sourceSha256 = sourceCatalogSha256(input);

  for (const song of input.songs) {
    const resourceId = uuid("resource:" + song.songId);
    const metadata = resourceMetadata(song);
    const title = text(metadata.title) ?? song.wikiTitle;
    const aliases = uniqueStrings([song.wikiTitle, song.catalogTitle, song.songId]).map((value) => ({
      value,
      kind: value === song.songId ? "external-id" as const : value === song.wikiTitle ? "title" as const : "filename" as const,
    }));
    const resource = Resource.parse({
      catalogSchemaVersion: "1.0",
      id: resourceId,
      game: "paradigm-reboot",
      resourceType: "jacket",
      title,
      aliases,
      externalIdentities: [{
        namespace: "paradigm",
        key: "song-id",
        value: song.songId,
        source: "apk-metadata",
        confidence: "high",
      }],
      metadata,
      relations: [],
      provenance: [{
        sourceType: "paradigm_apk",
        sourceSnapshot: input.sourceSnapshot,
        gameVersion: input.version,
        sourceRelativePath: "paradigm/" + input.version + "/" + input.catalogRevision + "/" + song.songId,
        sourceFilename: "catalog_" + input.catalogRevision + ".json",
        sourceSha256,
        evidence: [
          { kind: "apk-relative-path", detail: "Catalog D146 lists this song_id and its selected resource families.", confidence: "high" },
          { kind: "metadata", detail: "Public title and display metadata are mapped to the cited Wiki* table row.", confidence: "high" },
          { kind: "sha256", detail: "Selected client resources were hash-verified before import.", confidence: "high" },
        ],
      }],
      lifecycle: { status: "published", createdAt: NOW, updatedAt: NOW, publishedAt: NOW },
    });
    resources.push(resource);

    const defaultVariant = await prepareVariant(song, "default", "default", song.assets.cover, objectMap, uploads, input);
    variants.push(defaultVariant.variant);
    for (const rendition of defaultVariant.renditions) renditions.push({ resourceId, variantId: defaultVariant.variant.id, rendition });
    const music = await prepareAttachment(song, defaultVariant.variant.id, "music", undefined, song.assets.music, objectMap, uploads, input);
    const preview = await prepareAttachment(song, defaultVariant.variant.id, "preview-audio", undefined, song.assets.preview, objectMap, uploads, input);
    for (const rendition of [music, preview]) renditions.push({ resourceId, variantId: defaultVariant.variant.id, rendition });
    for (const [chartKind, chartFile] of Object.entries(song.assets.charts)) {
      const chart = await prepareAttachment(song, defaultVariant.variant.id, "chart", chartKind, chartFile, objectMap, uploads, input);
      renditions.push({ resourceId, variantId: defaultVariant.variant.id, rendition: chart });
    }

    for (const alternate of song.alternateCovers) {
      const alternateVariant = await prepareVariant(song, alternate.variantKey, "event", alternate.assets, objectMap, uploads, input);
      variants.push(alternateVariant.variant);
      for (const rendition of alternateVariant.renditions) renditions.push({ resourceId, variantId: alternateVariant.variant.id, rendition });
    }
  }

  const catalog = Catalog.parse({
    catalogSchemaVersion: "1.0",
    catalogId: existing.catalogId,
    generatedAt: NOW,
    resources: [...existing.resources, ...resources],
    variants: [...existing.variants, ...variants],
    renditions: [...existing.renditions, ...renditions.map((item) => item.rendition)],
    objects: [...objectMap.values()],
    releaseManifestIds: [...new Set([...existing.releaseManifestIds, uuid("release:" + input.version + ":" + input.catalogRevision)])],
  });
  const catalogCheck = validateCatalog(catalog);
  if (!catalogCheck.success) fail("Paradigm Catalog validation failed: " + catalogCheck.issues.slice(0, 8).map((issue) => issue.path + " " + issue.message).join("; "));

  const changes = [
    ...resources.map((resource) => ({ changeType: "added-resource" as const, resourceId: resource.id, detail: "Paradigm 4.10 catalog song jacket Resource." })),
    ...variants.map((variant) => ({ changeType: "added-variant" as const, resourceId: variant.resourceId, variantId: variant.id, detail: "Paradigm 4.10 catalog jacket Variant." })),
    ...renditions.map((item) => ({ changeType: "added-rendition" as const, resourceId: item.resourceId, variantId: item.variantId, renditionId: item.rendition.id, objectId: item.rendition.objectId, detail: "Paradigm 4.10 verified " + item.rendition.renditionType + " asset." })),
  ];
  const release = ReleaseManifest.parse({
    schemaVersion: "1.0",
    releaseSchemaVersion: "1.0",
    id: uuid("release:" + input.version + ":" + input.catalogRevision),
    updateBatchId: uuid("batch:" + input.version + ":" + input.catalogRevision),
    game: "paradigm-reboot",
    baseVersion: "onboarding",
    targetVersion: input.version,
    createdAt: NOW,
    status: "published",
    changes,
    affectedResourceIds: resources.map((resource) => resource.id),
    publishedRenditions: renditions
      .filter((item) => item.rendition.publishable)
      .map((item) => ({
        resourceId: item.resourceId,
        variantId: item.variantId,
        renditionId: item.rendition.id,
        objectId: item.rendition.objectId,
        downloadFilename: item.rendition.downloadFilename,
      })),
    removedFromCurrentSource: [],
    notes: [
      "Initial Paradigm: Reboot 4.10/D146 onboarding.",
      "One jacket Resource represents each catalog song_id; the two band-variant covers remain on innernorm and lynn as non-default Variants.",
      "Music, preview audio, and ParsaPara chart files are source attachments on the default jacket Variant.",
      "Remote object upload is intentionally outside this local Catalog import.",
    ],
  });
  const releaseCheck = validateReleaseManifestConsistency(release, catalog);
  if (!releaseCheck.success) fail("Paradigm ReleaseManifest validation failed: " + releaseCheck.issues.slice(0, 8).map((issue) => issue.path + " " + issue.message).join("; "));

  const publishedObjectIds = new Set(release.publishedRenditions.map((item) => item.objectId));
  const unifiedEntries = catalog.resources
    .filter((resource) => resource.game === "paradigm-reboot")
    .flatMap((resource) => {
      const songId = text(resource.metadata.songId) ?? resource.id;
      const variantsForResource = catalog.variants.filter((variant) => variant.resourceId === resource.id);
      return variantsForResource.flatMap((variant) => catalog.renditions
        .filter((rendition) => rendition.variantId === variant.id && rendition.publishable)
        .flatMap((rendition) => {
          const object = catalog.objects.find((candidate) => candidate.id === rendition.objectId);
          if (!object) return [];
          const attachmentKind = rendition.renditionType === "music"
            ? "music"
            : rendition.renditionType === "preview-audio"
              ? "preview"
              : rendition.renditionType === "chart"
                ? String(rendition.metadata.chartKind ?? rendition.metadata.difficulty ?? "chart")
                : "cover";
          const assetType = rendition.renditionType === "original" ? "jacket" as const : "other" as const;
          const sourceIdentity = "paradigm:song:" + songId + ":" + attachmentKind + ":" + variant.variantKey;
          const identityKey = releaseIdentityKey({ gameId: "paradigm-reboot", assetType, sourceIdentity, variantKey: variant.variantKey });
          return [{
            assetId: uuid("manifest-asset:" + identityKey),
            identityKey,
            gameId: "paradigm-reboot" as const,
            assetType,
            variantKey: variant.variantKey,
            ...(resource.title ? { title: resource.title } : {}),
            ...(text(resource.metadata.artist) ? { artist: text(resource.metadata.artist) } : {}),
            aliases: [rendition.downloadFilename],
            sourceIdentity,
            sourcePath: logicalPath(songId, attachmentKind),
            file: {
              objectId: object.id,
              objectKey: object.objectKey,
              sha256: object.sha256,
              sizeBytes: object.sizeBytes,
              ...(object.width !== undefined ? { width: object.width } : {}),
              ...(object.height !== undefined ? { height: object.height } : {}),
              mime: object.mime,
            },
            versionAdded: input.version,
            metadata: cleanPublicJson({
              songId,
              assetRole: attachmentKind,
              variantKey: variant.variantKey,
              ...(rendition.metadata as Record<string, unknown>),
            }) as JsonRecord,
            needsReview: true,
            anomalies: [],
          }];
        }));
    });
  const unifiedManifest = UnifiedAssetManifest.parse({
    kind: "rhythm-unified-asset-manifest",
    schemaVersion: "1.0",
    gameId: "paradigm-reboot",
    version: input.version,
    generatedAt: NOW,
    sourceSnapshot: input.sourceSnapshot,
    entries: unifiedEntries.sort((left, right) => left.identityKey.localeCompare(right.identityKey)),
    notes: [
      "Initial Paradigm 4.10/D146 onboarding manifest.",
      "Jacket images and source music/preview/chart attachments share the owning song identity.",
      "All NEW entries require the standard human-review approval gate.",
    ],
  });
  return {
    catalog,
    release,
    unifiedManifest,
    curation: curationFromInput(input),
    uploads: [...uploads.values()],
    summary: {
      resources: resources.length,
      variants: variants.length,
      renditions: renditions.length,
      publishedRenditions: release.publishedRenditions.length,
      objects: objectMap.size,
      publishedObjects: publishedObjectIds.size,
      songs: input.songs.length,
      alternateCovers: input.songs.reduce((sum, song) => sum + song.alternateCovers.length, 0),
      charts: input.songs.reduce((sum, song) => sum + Object.keys(song.assets.charts).length, 0),
    },
  };
}

async function buildCoverOrientationFixPlan(input: ParadigmInput, existing: CatalogType): Promise<CoverOrientationFixPlan> {
  if (input.schemaVersion !== 1 || input.game !== "paradigm-reboot") fail("invalid Paradigm public input");
  if (input.version !== "4.10" || input.catalogRevision !== "D146") fail("input is not the approved 4.10/D146 baseline");
  if (input.songs.length !== 419) fail("Paradigm input must contain exactly 419 songs");

  const resourcesBySong = new Map(
    existing.resources
      .filter((resource) => resource.game === "paradigm-reboot")
      .map((resource) => [text(resource.metadata.songId), resource] as const),
  );
  if (resourcesBySong.size !== 419 || [...resourcesBySong.keys()].some((songId) => !songId)) fail("existing Paradigm Catalog does not contain the expected 419 song Resources");

  const objectMap = new Map(existing.objects.map((object) => [object.id, object]));
  const uploads = new Map<string, PreparedFile>();
  const renditionsById = new Map(existing.renditions.map((rendition) => [rendition.id, rendition]));
  const changes: ReleaseManifestType["changes"] = [];
  const publishedRenditions: ReleaseManifestType["publishedRenditions"] = [];
  const affectedResourceIds = new Set<string>();
  const processingNote = "Vertical top-to-bottom flip applied after Texture2D extraction for website orientation.";
  let covers = 0;
  let changedCovers = 0;
  let changedThumbnails = 0;

  const replaceRendition = (resource: ResourceType, variant: VariantType, rendition: RenditionType, object: AssetObjectType): void => {
    if (rendition.objectId === object.id) return;
    renditionsById.set(rendition.id, Rendition.parse({ ...rendition, objectId: object.id }));
    changes.push({
      changeType: "replaced-rendition",
      resourceId: resource.id,
      variantId: variant.id,
      renditionId: rendition.id,
      objectId: object.id,
      previousObjectId: rendition.objectId,
      detail: processingNote,
    });
    affectedResourceIds.add(resource.id);
    if (rendition.publishable) {
      publishedRenditions.push({
        resourceId: resource.id,
        variantId: variant.id,
        renditionId: rendition.id,
        objectId: object.id,
        downloadFilename: rendition.downloadFilename,
      });
    }
  };

  for (const song of input.songs) {
    const resource = resourcesBySong.get(song.songId);
    if (!resource) fail("missing Paradigm Resource for " + song.songId);
    const coverInputs: Array<{ variantKey: string; imageFile: InputFile }> = [
      { variantKey: "default", imageFile: song.assets.cover },
      ...song.alternateCovers.map((alternate) => ({ variantKey: alternate.variantKey, imageFile: alternate.assets })),
    ];
    for (const { variantKey, imageFile } of coverInputs) {
      const variant = existing.variants.find((candidate) => candidate.resourceId === resource.id && candidate.variantKey === variantKey);
      if (!variant) fail("missing Paradigm Variant for " + song.songId + "/" + variantKey);
      const variantRenditions = existing.renditions.filter((rendition) => rendition.variantId === variant.id);
      const original = variantRenditions.find((rendition) => rendition.renditionType === "original");
      if (!original) fail("missing original cover rendition for " + song.songId + "/" + variantKey);
      const imagePath = await verifyInputFile(imageFile, song.songId + "/" + variantKey + "/cover");
      const imageObject = registerObject(
        makeObject({
          file: imageFile,
          songId: song.songId,
          role: variantKey + "/cover",
          filename: original.downloadFilename,
          sourceSnapshot: input.sourceSnapshot,
          version: input.version,
          processingNote,
        }),
        imagePath,
        objectMap,
        uploads,
      );
      covers += 1;
      const beforeObjectId = original.objectId;
      replaceRendition(resource, variant, original, imageObject);
      if (beforeObjectId !== imageObject.id) changedCovers += 1;

      const thumbnails = await generateThumbnailSet(imagePath, ORIENTATION_FIX_THUMBNAILS, "paradigm-" + song.songId + "-" + variantKey);
      for (const thumbnail of thumbnails) {
        const renditionType = ("thumbnail-" + thumbnail.width) as RenditionType["renditionType"];
        const oldThumbnail = variantRenditions.find((rendition) => rendition.renditionType === renditionType);
        if (!oldThumbnail) fail("missing " + renditionType + " rendition for " + song.songId + "/" + variantKey);
        const thumbnailFile: InputFile = {
          path: thumbnail.absolutePath,
          sha256: thumbnail.sha256,
          sizeBytes: thumbnail.sizeBytes,
          mime: "image/webp",
          extension: "webp",
          width: thumbnail.pixelWidth,
          height: thumbnail.height,
        };
        const thumbnailPath = await verifyInputFile(thumbnailFile, song.songId + "/" + variantKey + "/" + renditionType);
        const thumbnailObject = registerObject(
          makeObject({
            file: thumbnailFile,
            songId: song.songId,
            role: variantKey + "/" + renditionType,
            filename: oldThumbnail.downloadFilename,
            sourceSnapshot: input.sourceSnapshot,
            version: input.version,
            processingNote,
          }),
          thumbnailPath,
          objectMap,
          uploads,
        );
        const beforeThumbnailObjectId = oldThumbnail.objectId;
        replaceRendition(resource, variant, oldThumbnail, thumbnailObject);
        if (beforeThumbnailObjectId !== thumbnailObject.id) changedThumbnails += 1;
      }
    }
  }

  const releaseId = uuid("release:4.10:orientation:flip-top-bottom");
  const release = ReleaseManifest.parse({
    schemaVersion: "1.0",
    releaseSchemaVersion: "1.0",
    id: releaseId,
    updateBatchId: uuid("batch:4.10:orientation:flip-top-bottom"),
    game: "paradigm-reboot",
    baseVersion: "4.10",
    targetVersion: "4.10",
    createdAt: NOW,
    status: changes.length > 0 ? "published" : "validated",
    changes,
    affectedResourceIds: [...affectedResourceIds].sort(),
    publishedRenditions,
    removedFromCurrentSource: [],
    notes: [
      "Corrected the top-to-bottom orientation of all 421 Paradigm 4.10/D146 cover outputs.",
      "Resource, Variant, and Rendition identities are preserved; only content-hash Objects and derived thumbnails are replaced.",
      "Music, preview audio, and ParsaPara chart attachments are unchanged.",
      "Remote object upload remains disabled for this local correction.",
    ],
  });

  const catalog = changes.length > 0
    ? Catalog.parse({
      ...existing,
      generatedAt: NOW,
      renditions: existing.renditions.map((rendition) => renditionsById.get(rendition.id) ?? rendition),
      objects: [...objectMap.values()],
      releaseManifestIds: [...new Set([...existing.releaseManifestIds, release.id])],
    })
    : existing;
  const catalogCheck = validateCatalog(catalog);
  if (!catalogCheck.success) fail("orientation-fix Catalog validation failed: " + catalogCheck.issues.slice(0, 8).map((issue) => issue.path + " " + issue.message).join("; "));
  const releaseCheck = validateReleaseManifestConsistency(release, catalog);
  if (!releaseCheck.success) fail("orientation-fix ReleaseManifest validation failed: " + releaseCheck.issues.slice(0, 8).map((issue) => issue.path + " " + issue.message).join("; "));

  return {
    catalog,
    release,
    report: {
      kind: "paradigm-cover-orientation-fix",
      schemaVersion: 1,
      game: input.game,
      version: input.version,
      catalogRevision: input.catalogRevision,
      sourceSnapshot: input.sourceSnapshot,
      transform: "flip_top_bottom",
      songs: input.songs.length,
      covers,
      changedCovers,
      changedThumbnails,
      changedRenditions: changes.length,
      newObjects: uploads.size,
      audioChanged: 0,
      chartChanged: 0,
    },
    summary: {
      songs: input.songs.length,
      covers,
      changedCovers,
      changedThumbnails,
      changedRenditions: changes.length,
      newObjects: uploads.size,
    },
  };
}

async function main(): Promise<void> {
  const inputArgument = process.argv.find((value) => value.startsWith("--input="));
  const inputPath = path.resolve(inputArgument?.slice("--input=".length) ?? DEFAULT_INPUT);
  const inputRelative = path.relative(ROOT, inputPath);
  if (inputRelative.startsWith("..") || path.isAbsolute(inputRelative) || !inputRelative.toLocaleLowerCase("en-US").startsWith("temp" + path.sep)) {
    fail("Paradigm input must stay inside repository temp/");
  }
  const input = JSON.parse(await readFile(inputPath, "utf8")) as ParadigmInput;
  const existing = await loadCatalogFile();
  if (process.argv.includes("--refresh-covers")) {
    const plan = await buildCoverOrientationFixPlan(input, existing);
    await atomicWriteJson(ORIENTATION_FIX_CATALOG, plan.catalog);
    await atomicWriteJson(ORIENTATION_FIX_RELEASE, plan.release);
    await atomicWriteJson(ORIENTATION_FIX_REPORT, plan.report);
    if (process.argv.includes("--apply") && plan.summary.changedRenditions > 0) {
      await writeCatalogAndReleaseAtomic(plan.catalog, plan.release);
    }
    console.log(JSON.stringify({
      status: process.argv.includes("--apply") && plan.summary.changedRenditions > 0 ? "APPLIED_LOCAL_ONLY" : plan.summary.changedRenditions > 0 ? "CANDIDATE_VALIDATED" : "NO_CHANGES",
      catalog: process.argv.includes("--apply") && plan.summary.changedRenditions > 0 ? path.resolve("catalog/index.json") : ORIENTATION_FIX_CATALOG,
      release: process.argv.includes("--apply") && plan.summary.changedRenditions > 0 ? path.resolve("catalog/releases", plan.release.id + ".json") : ORIENTATION_FIX_RELEASE,
      report: ORIENTATION_FIX_REPORT,
      uploadStatus: "DISABLED",
      ...plan.summary,
    }, null, 2));
    return;
  }
  const plan = await buildPlan(input, existing);
  await atomicWriteJson(CANDIDATE_CATALOG, plan.catalog);
  await atomicWriteJson(CANDIDATE_RELEASE, plan.release);
  await atomicWriteJson(CANDIDATE_MANIFEST, plan.unifiedManifest);
  if (!(await stat(WORKFLOW_STATE).catch(() => undefined))) {
    await saveWorkflowState(createWorkflowState({
      gameId: input.game,
      version: input.version,
      sourcePath: inputPath,
      sourceSnapshot: input.sourceSnapshot,
      workflowKind: "game-onboarding",
      phase: "normalize",
      now: NOW,
    }), WORKFLOW_STATE);
  }
  if (process.argv.includes("--apply")) {
    await writeCatalogAndReleaseAtomic(plan.catalog, plan.release);
    await atomicWriteJson(CURATION_PATH, plan.curation);
  }
  console.log(JSON.stringify({
    status: process.argv.includes("--apply") ? "APPLIED_LOCAL_ONLY" : "CANDIDATE_VALIDATED",
    input: inputPath,
    catalog: process.argv.includes("--apply") ? path.resolve("catalog/index.json") : CANDIDATE_CATALOG,
    release: process.argv.includes("--apply") ? path.resolve("catalog/releases", plan.release.id + ".json") : CANDIDATE_RELEASE,
    manifest: CANDIDATE_MANIFEST,
    state: WORKFLOW_STATE,
    curation: process.argv.includes("--apply") ? CURATION_PATH : "candidate-only",
    ...plan.summary,
    uploadStatus: "DISABLED",
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

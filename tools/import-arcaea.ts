import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import sharp from "sharp";
import {
  AssetObject,
  Catalog,
  ReleaseManifest,
  Rendition,
  Resource,
  Variant,
  type AssetObject as AssetObjectType,
  type Catalog as CatalogType,
  type ReleaseManifest as ReleaseManifestType,
  type Rendition as RenditionType,
  type Resource as ResourceType,
  type Variant as VariantType,
} from "../packages/domain/src/schema.js";
import { atomicWriteJson, loadCatalogFile, writeCatalogAndReleaseAtomic } from "../packages/domain/src/catalog.js";
import { createDeterministicUuidV7, immutableObjectKey, objectIdFromSha256 } from "../packages/domain/src/identity.js";
import { generateThumbnailSet } from "../packages/domain/src/thumbnails.js";
import { validateReleaseManifestConsistency } from "../packages/domain/src/validation.js";
import { manifestFromExtractorResult, UnifiedAssetManifest, type UnifiedAssetManifest as UnifiedAssetManifestType, readReleaseDelta } from "../packages/domain/src/release.js";
import { ExtractorResult, type ExtractorCandidate, type ExtractorResult as ExtractorResultType } from "../packages/domain/src/extractors.js";
import { isReviewApproved, readReviewPackage, validateReviewPackageForDelta } from "../packages/domain/src/review-package.js";

const ROOT = path.resolve(".");
const TEMP_ROOT = path.resolve("temp") + path.sep;
const SOURCE_TYPE = "arcaea_apk" as const;
const DIFFICULTIES = new Set(["PST", "PRS", "FTR", "BYD", "ETR", "INSCRIBED"]);
const PUBLIC_METADATA_KEYS = new Set([
  "artist", "songId", "packId", "difficulty", "sourceRelativePath", "legacyCategory",
  "confidence", "detection", "sourceType", "contentOrigin", "gameVersion",
  "characterName", "characterChineseName", "characterJapaneseName", "characterEnglishName", "characterKoreanName", "characterVersionFrom",
]);

const MetadataChange = z.object({
  resourceId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu),
  detail: z.string().min(1),
});

type Args = {
  manifest: string;
  review: string;
  delta: string;
  extractorResult: string;
  apk: string;
  metadataChanges?: string;
  outputRoot?: string;
  apply: boolean;
};

type Prepared = {
  resource: ResourceType;
  variant: VariantType;
  renditions: RenditionType[];
  canonical: RenditionType;
};

function required(args: Partial<Args>, key: keyof Args): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error("--" + key + " is required");
  return value;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) throw new Error("unexpected end of arguments");
    if (token === "--apply") {
      args.apply = true;
      continue;
    }
    if (!token.startsWith("--")) throw new Error("unexpected argument: " + token);
    const rawKey = token.slice(2);
    const key = ({
      "extractor-result": "extractorResult",
      "metadata-changes": "metadataChanges",
      "output-root": "outputRoot",
    } as Record<string, keyof Args>)[rawKey] ?? rawKey as keyof Args;
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(token + " requires a value");
    if (!["manifest", "review", "delta", "extractorResult", "apk", "metadataChanges", "outputRoot"].includes(key)) {
      throw new Error("unknown option: " + token);
    }
    if (key === "manifest") args.manifest = value;
    else if (key === "review") args.review = value;
    else if (key === "delta") args.delta = value;
    else if (key === "extractorResult") args.extractorResult = value;
    else if (key === "apk") args.apk = value;
    else if (key === "metadataChanges") args.metadataChanges = value;
    else if (key === "outputRoot") args.outputRoot = value;
  }
  return {
    manifest: required(args, "manifest"),
    review: required(args, "review"),
    delta: required(args, "delta"),
    extractorResult: required(args, "extractorResult"),
    apk: required(args, "apk"),
    ...(args.metadataChanges ? { metadataChanges: args.metadataChanges } : {}),
    ...(args.outputRoot ? { outputRoot: args.outputRoot } : {}),
    apply: args.apply === true,
  };
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^assets\//iu, "");
}

function pathKey(value: string): string {
  return normalizePath(value).toLocaleLowerCase("en-US");
}

function packagePath(value: string): string {
  return "Arcaea/current-apk/" + normalizePath(value);
}

function sourceLookupKey(sourcePath: string, assetType: string, variantKey: string): string {
  return assetType + "|" + pathKey(sourcePath) + "|" + variantKey;
}

function safeFilename(value: string): string {
  const basename = path.posix.basename(value.replaceAll("\\", "/"));
  const clean = basename
    .replace(/[\/\0]/gu, "-")
    .replace(/[^\p{L}\p{N} .()_\-]+/gu, "-")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^[-. ]+|[-. ]+$/gu, "");
  return clean || "arcaea-asset";
}

function sourceStem(value: string): string {
  const stem = path.posix.basename(value.replaceAll("\\", "/")).replace(/\.[^.]+$/u, "").trim();
  return stem || "Arcaea asset";
}

function resourceTitle(entry: UnifiedAssetManifestType["entries"][number], candidate: ExtractorCandidate): string {
  const stem = sourceStem(candidate.sourceFilename);
  const sourcePath = normalizePath(candidate.sourceRelativePath);
  if (entry.assetType === "story-cg") return "Divine Oblivion · " + stem;
  if (entry.assetType === "story-texture" && (sourcePath.includes("/catastrophe/") || sourcePath.includes("entry_konzetsu"))) {
    return "Divine Oblivion · " + stem;
  }
  return entry.title ?? candidate.suggestedTitle ?? stem;
}

function extensionFor(value: string): "jpg" | "jpeg" | "png" | "webp" | "avif" | "gif" | "bin" {
  const extension = path.extname(value).slice(1).toLowerCase();
  if (extension === "jpg" || extension === "jpeg" || extension === "png" || extension === "webp" || extension === "avif" || extension === "gif") {
    return extension;
  }
  throw new Error("unsupported image extension: " + value);
}

function mimeFor(extension: string): "image/jpeg" | "image/png" | "image/webp" | "image/avif" | "image/gif" | "application/octet-stream" {
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  if (extension === "avif") return "image/avif";
  if (extension === "gif") return "image/gif";
  return "application/octet-stream";
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function publicMetadata(entry: UnifiedAssetManifestType["entries"][number], version: string): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const key of PUBLIC_METADATA_KEYS) {
    const value = entry.metadata[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") output[key] = value;
  }
  output.gameVersion = version;
  return output;
}

function catalogCharacterMetadata(entry: UnifiedAssetManifestType["entries"][number]): Record<string, unknown> {
  if (!["character-portrait", "character-avatar", "linkplay-preview"].includes(entry.assetType)) return {};
  return Object.fromEntries(Object.entries(entry.metadata).filter(([key, value]) => key.startsWith("character") && value !== undefined));
}

function uuid(kind: string, identity: string): string {
  return createDeterministicUuidV7("arcaea:" + kind + ":" + identity);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function repoRelative(filePath: string): string {
  const absolute = path.resolve(filePath);
  const relative = path.relative(ROOT, absolute).replaceAll("\\", "/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) throw new Error("path must stay inside repository: " + filePath);
  return relative;
}

function tempPath(filePath: string): string {
  const absolute = path.resolve(filePath);
  if (!absolute.startsWith(TEMP_ROOT)) throw new Error("extracted source must stay inside repository temp/: " + filePath);
  return absolute;
}

function outputPath(value: string): string {
  const absolute = path.resolve(value);
  if (!absolute.startsWith(TEMP_ROOT)) throw new Error("outputRoot must stay inside repository temp/: " + value);
  return absolute;
}

function sourceIdentities(candidate: ExtractorCandidate): ExtractorCandidate["suggestedExternalIdentity"] {
  if (candidate.suggestedExternalIdentity.length > 0) return candidate.suggestedExternalIdentity;
  return [{
    namespace: "arcaea",
    key: "path",
    value: normalizePath(candidate.sourceRelativePath),
    source: "filename",
    confidence: "high",
  }];
}

function objectProvenance(candidate: ExtractorCandidate, sha256: string, version: string) {
  return [{
    sourceType: SOURCE_TYPE,
    sourceRelativePath: packagePath(candidate.sourceRelativePath),
    sourceFilename: candidate.sourceFilename,
    sourceSha256: sha256,
    gameVersion: version,
    evidence: [
      ...candidate.evidence,
      { kind: "sha256" as const, detail: "Extracted bytes match the approved candidate SHA-256.", confidence: "high" as const },
    ],
  }];
}

function makeObject(input: {
  candidate: ExtractorCandidate;
  filePath: string;
  sha256: string;
  sizeBytes: number;
  width: number;
  height: number;
  version: string;
  mime: ReturnType<typeof mimeFor>;
  extension: ReturnType<typeof extensionFor>;
  alpha: "none" | "opaque" | "translucent" | "unknown";
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
    alpha: input.alpha,
    objectKey: immutableObjectKey(input.sha256, input.extension),
    createdAt: now,
    provenance: objectProvenance(input.candidate, input.sha256, input.version),
  });
}

function variantKind(entry: UnifiedAssetManifestType["entries"][number]): "default" | "difficulty" | "source-path" {
  if (DIFFICULTIES.has(entry.variantKey)) return "difficulty";
  if (entry.assetType === "pack-cover" && entry.variantKey !== "default") return "source-path";
  return "default";
}

let now = new Date().toISOString();
let sourceApkPath = "";

async function prepareEntry(
  entry: UnifiedAssetManifestType["entries"][number],
  candidate: ExtractorCandidate,
  apkSha256: string,
  manifestVersion: string,
  sourceSnapshot: string,
  outputRoot: string,
  objectMap: Map<string, AssetObjectType>,
): Promise<Prepared> {
  const canonicalPath = tempPath(candidate.sourcePath);
  const fileInfo = await stat(canonicalPath);
  const actualSha256 = await sha256File(canonicalPath);
  if (actualSha256 !== entry.file?.sha256 || actualSha256 !== candidate.sourceSha256) throw new Error("canonical hash mismatch: " + entry.identityKey);
  const imageInfo = await sharp(canonicalPath).metadata();
  if (!imageInfo.width || !imageInfo.height) throw new Error("canonical image dimensions are missing: " + entry.identityKey);
  const extension = extensionFor(candidate.sourceFilename);
  const mime = mimeFor(extension);
  const resourceId = uuid("resource", entry.identityKey);
  const variantId = uuid("variant", entry.identityKey + ":" + entry.variantKey);
  const canonicalRenditionId = uuid("rendition", entry.identityKey + ":original");
  const metadata = { ...publicMetadata(entry, manifestVersion), ...catalogCharacterMetadata(entry) };
  const resource = Resource.parse({
    catalogSchemaVersion: "1.0",
    id: resourceId,
    game: "arcaea",
    resourceType: entry.assetType,
    title: resourceTitle(entry, candidate),
    aliases: [...new Set([candidate.sourceFilename, candidate.suggestedFilename, ...entry.aliases])].map((value) => ({ value: safeFilename(value), kind: "filename" as const })),
    externalIdentities: sourceIdentities(candidate),
    metadata,
    relations: [],
    provenance: [{
      sourceType: SOURCE_TYPE,
      sourceSnapshot,
      gameVersion: manifestVersion,
      sourceRelativePath: packagePath(candidate.sourceRelativePath),
      sourceFilename: path.basename(sourceApkPath),
      sourceSha256: apkSha256,
      evidence: [
        { kind: "apk-relative-path" as const, detail: "Selected from the Arcaea 7.0 APK at assets/" + normalizePath(candidate.sourceRelativePath) + ".", confidence: "high" as const },
        ...candidate.evidence,
        { kind: "sha256" as const, detail: "Extracted bytes were verified against the approved candidate manifest.", confidence: "high" as const },
      ],
      reviewerNote: "Accepted in the local Arcaea 7.0 evidence review.",
    }],
    lifecycle: { status: "published", createdAt: now, updatedAt: now, publishedAt: now },
  });
  const suggestedVariant = candidate.suggestedVariant;
  const variant = Variant.parse({
    catalogSchemaVersion: "1.0",
    id: variantId,
    resourceId,
    variantKey: entry.variantKey,
    kind: variantKind(entry),
    semanticStatus: "confirmed",
    ...(entry.variantKey === "default" ? { preferred: true } : {}),
    ...(DIFFICULTIES.has(entry.variantKey) ? { difficulty: entry.variantKey } : {}),
    markers: { unresolved: suggestedVariant?.unresolved ?? [] },
    note: "Accepted from the approved Arcaea 7.0 local update review.",
  });
  const canonicalObject = makeObject({
    candidate,
    filePath: canonicalPath,
    sha256: actualSha256,
    sizeBytes: fileInfo.size,
    width: imageInfo.width,
    height: imageInfo.height,
    version: manifestVersion,
    mime,
    extension,
    alpha: imageInfo.hasAlpha === false ? "opaque" : imageInfo.hasAlpha === true ? "translucent" : "unknown",
  });
  objectMap.set(canonicalObject.id, objectMap.get(canonicalObject.id) ?? canonicalObject);
  const canonical = Rendition.parse({
    catalogSchemaVersion: "1.0",
    id: canonicalRenditionId,
    variantId,
    renditionType: "original",
    origin: "source",
    publishable: true,
    objectId: canonicalObject.id,
    downloadFilename: safeFilename(candidate.sourceFilename),
    generatedBy: "extractor",
    createdAt: now,
  });
  const thumbnailRoot = path.join(outputRoot, "derived-thumbnails");
  const thumbnailResults = await generateThumbnailSet(canonicalPath, thumbnailRoot, "arcaea-" + actualSha256.slice(0, 16));
  const thumbnails: RenditionType[] = [];
  for (const thumbnail of thumbnailResults) {
    const object = AssetObject.parse({
      catalogSchemaVersion: "1.0",
      id: objectIdFromSha256(thumbnail.sha256),
      sha256: thumbnail.sha256,
      mime: "image/webp",
      extension: "webp",
      sizeBytes: thumbnail.sizeBytes,
      width: thumbnail.pixelWidth,
      height: thumbnail.height,
      alpha: "unknown",
      objectKey: immutableObjectKey(thumbnail.sha256, "webp"),
      createdAt: now,
      provenance: [{
        sourceType: SOURCE_TYPE,
        sourceRelativePath: packagePath(candidate.sourceRelativePath),
        sourceFilename: candidate.sourceFilename,
        sourceSha256: thumbnail.sha256,
        gameVersion: manifestVersion,
        evidence: [{ kind: "sha256" as const, detail: "Generated WebP thumbnail from the approved canonical source.", confidence: "high" as const }],
      }],
    });
    objectMap.set(object.id, objectMap.get(object.id) ?? object);
    thumbnails.push(Rendition.parse({
      catalogSchemaVersion: "1.0",
      id: uuid("rendition", entry.identityKey + ":thumbnail-" + thumbnail.width),
      variantId,
      renditionType: ("thumbnail-" + thumbnail.width) as RenditionType["renditionType"],
      origin: "derived",
      publishable: false,
      objectId: object.id,
      downloadFilename: thumbnail.relativePath,
      sourceRenditionId: canonical.id,
      generatedBy: "thumbnailer",
      createdAt: now,
    }));
  }
  return { resource, variant, renditions: [canonical, ...thumbnails], canonical };
}

async function buildPlan(
  args: Args,
  manifest: UnifiedAssetManifestType,
  delta: Awaited<ReturnType<typeof readReleaseDelta>>,
  review: Awaited<ReturnType<typeof readReviewPackage>>,
  extractor: ExtractorResultType,
): Promise<{ catalog: CatalogType; release: ReleaseManifestType; resourceCount: number; renditionCount: number; objectCount: number; metadataChangeCount: number; sourceSnapshot: string; outputRoot: string }> {
  sourceApkPath = path.resolve(args.apk);
  const apkSha256 = await sha256File(sourceApkPath);
  if (extractor.targetApk.sha256 && extractor.targetApk.sha256.toLowerCase() !== apkSha256.toLowerCase()) throw new Error("target APK SHA-256 does not match extractor result");
  const sourceSnapshot = manifest.sourceSnapshot;
  const outputRoot = outputPath(args.outputRoot ?? path.join("temp", "rhythmctl", "arcaea", manifest.version, "local-import"));
  await mkdir(outputRoot, { recursive: true });
  const existing = await loadCatalogFile();
  const objectMap = new Map(existing.objects.map((object) => [object.id, object]));
  const generatedManifest = await manifestFromExtractorResult(extractor, { version: manifest.version, generatedAt: manifest.generatedAt });
  const candidateByIdentity = new Map<string, ExtractorCandidate>();
  const candidatesByLookup = new Map<string, ExtractorCandidate>();
  for (const candidate of extractor.candidates) {
    candidatesByLookup.set(sourceLookupKey(candidate.sourceRelativePath, candidate.suggestedCategory, candidate.suggestedVariant?.key ?? "default"), candidate);
  }
  for (const generated of generatedManifest.entries) {
    const candidate = generated.sourcePath ? candidatesByLookup.get(sourceLookupKey(generated.sourcePath, generated.assetType, generated.variantKey)) : undefined;
    if (candidate) candidateByIdentity.set(generated.identityKey, candidate);
  }
  const newEntries = delta.entries.filter((entry) => entry.status === "NEW").map((entry) => entry.current).filter((entry): entry is UnifiedAssetManifestType["entries"][number] => Boolean(entry));
  if (newEntries.length !== delta.summary.new) throw new Error("release delta NEW count does not match current entries");
  if (newEntries.some((entry) => entry.assetType === "sticker")) throw new Error("unchanged Arcaea stickers must not enter the 7.0 addition import");
  const prepared: Prepared[] = [];
  for (const entry of newEntries) {
    const candidate = candidateByIdentity.get(entry.identityKey);
    if (!candidate) throw new Error("no extractor candidate for new entry: " + entry.identityKey);
    prepared.push(await prepareEntry(entry, candidate, apkSha256, manifest.version, sourceSnapshot, outputRoot, objectMap));
  }
  const metadataChanges = args.metadataChanges
    ? z.array(MetadataChange).parse(JSON.parse(await readFile(path.resolve(args.metadataChanges), "utf8")) as unknown)
    : [];
  const existingIds = new Set(existing.resources.filter((resource) => resource.game === "arcaea").map((resource) => resource.id));
  for (const change of metadataChanges) if (!existingIds.has(change.resourceId)) throw new Error("metadata change references a missing existing Arcaea Resource: " + change.resourceId);
  const resources = [...existing.resources, ...prepared.map((item) => item.resource)];
  const variants = [...existing.variants, ...prepared.map((item) => item.variant)];
  const renditions = [...existing.renditions, ...prepared.flatMap((item) => item.renditions)];
  const releaseId = uuid("release", sourceSnapshot);
  const changes: ReleaseManifestType["changes"] = [];
  for (const item of prepared) {
    changes.push({ changeType: "added-resource", resourceId: item.resource.id, detail: "Approved Arcaea 7.0 source resource." });
    changes.push({ changeType: "added-variant", resourceId: item.resource.id, variantId: item.variant.id, detail: "Approved Arcaea 7.0 semantic variant." });
    for (const rendition of item.renditions) {
      changes.push({
        changeType: "added-rendition",
        resourceId: item.resource.id,
        variantId: item.variant.id,
        renditionId: rendition.id,
        objectId: rendition.objectId,
        detail: "Canonical or derived Arcaea 7.0 image rendition.",
      });
    }
  }
  for (const change of metadataChanges) changes.push({ changeType: "metadata-changed", resourceId: change.resourceId, detail: change.detail });
  const catalog = Catalog.parse({
    ...existing,
    generatedAt: now,
    resources,
    variants,
    renditions,
    objects: [...objectMap.values()],
    releaseManifestIds: [...new Set([...existing.releaseManifestIds, releaseId])],
  });
  const affectedResourceIds = [...new Set([...prepared.map((item) => item.resource.id), ...metadataChanges.map((change) => change.resourceId)])];
  const release = ReleaseManifest.parse({
    releaseSchemaVersion: "1.0",
    id: releaseId,
    updateBatchId: uuid("batch", sourceSnapshot),
    game: "arcaea",
    baseVersion: extractor.baseVersion,
    targetVersion: manifest.version,
    createdAt: now,
    status: "published",
    changes,
    affectedResourceIds,
    publishedRenditions: prepared.map((item) => ({
      resourceId: item.resource.id,
      variantId: item.variant.id,
      renditionId: item.canonical.id,
      objectId: item.canonical.objectId,
      downloadFilename: item.canonical.downloadFilename,
    })),
    removedFromCurrentSource: [],
    notes: [
      "Arcaea 7.0 Cocos2d-x APK update integrated from the approved local review package.",
      "Scope includes 143 new non-sticker image resources; the 99 unchanged LinkPlay stickers remain represented by the previous Catalog snapshot.",
      "Browse metadata separately records 8 new songs, Divine Oblivion pack/story content, and 3 existing chart-level corrections.",
      "REMOVED is empty; no Catalog or object deletion was performed.",
      "Local Catalog and ReleaseManifest only; ROS/object-storage upload and production publication are disabled for this repository workflow.",
    ],
  });
  const consistency = validateReleaseManifestConsistency(release, catalog);
  if (!consistency.success) throw new Error("Arcaea ReleaseManifest consistency failed: " + consistency.issues.slice(0, 8).map((issue) => issue.path + " " + issue.message).join("; "));
  await atomicWriteJson(path.join(outputRoot, "arcaea-import-plan.json"), {
    status: "READY_LOCAL_ONLY",
    remoteWrite: "DISABLED",
    sourceSnapshot,
    sourceSha256: apkSha256,
    baseVersion: extractor.baseVersion,
    targetVersion: manifest.version,
    resourceCount: prepared.length,
    renditionCount: prepared.reduce((sum, item) => sum + item.renditions.length, 0),
    objectCount: objectMap.size - existing.objects.length,
    metadataChangeCount: metadataChanges.length,
    releaseId,
    review: { status: review.status, reviewer: review.reviewer, approvedAt: review.approvedAt },
  });
  return {
    catalog,
    release,
    resourceCount: prepared.length,
    renditionCount: prepared.reduce((sum, item) => sum + item.renditions.length, 0),
    objectCount: objectMap.size - existing.objects.length,
    metadataChangeCount: metadataChanges.length,
    sourceSnapshot,
    outputRoot,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const manifest = UnifiedAssetManifest.parse(JSON.parse(await readFile(path.resolve(args.manifest), "utf8")) as unknown);
  const review = await readReviewPackage(path.resolve(args.review));
  const delta = await readReleaseDelta(path.resolve(args.delta));
  const extractor = ExtractorResult.parse(JSON.parse(await readFile(path.resolve(args.extractorResult), "utf8")) as unknown);
  const reviewValidation = validateReviewPackageForDelta(review, delta);
  if (!reviewValidation.valid) throw new Error("approved review does not match release delta: " + reviewValidation.reasons.join("; "));
  if (!isReviewApproved(review)) throw new Error("Arcaea import requires an approved review package.");
  if (manifest.gameId !== "arcaea" || review.gameId !== "arcaea" || delta.gameId !== "arcaea" || extractor.game !== "arcaea") throw new Error("Arcaea manifest, delta, review, and extractor must all target Arcaea.");
  if (manifest.version !== delta.currentVersion || manifest.version !== review.version || manifest.version !== extractor.targetVersion) throw new Error("Arcaea manifest, delta, review, and extractor versions do not match.");
  if (manifest.sourceSnapshot !== delta.currentManifestSnapshot || manifest.sourceSnapshot !== extractor.sourceSnapshot) throw new Error("Arcaea source snapshots do not match.");
  if (delta.summary.changed !== 0 || delta.summary.removed !== 0) throw new Error("This local content importer only accepts NEW additions; changed or removed entries require a separate review path.");
  now = new Date().toISOString();
  const plan = await buildPlan(args, manifest, delta, review, extractor);
  if (args.apply) {
    const commit = await writeCatalogAndReleaseAtomic(plan.catalog, plan.release);
    console.log(JSON.stringify({
      status: "APPLIED_LOCAL_ONLY",
      remoteWrite: "DISABLED",
      resourceCount: plan.resourceCount,
      renditionCount: plan.renditionCount,
      objectCount: plan.objectCount,
      metadataChangeCount: plan.metadataChangeCount,
      releaseId: plan.release.id,
      commit,
    }, null, 2));
  } else {
    console.log(JSON.stringify({
      status: "READY_LOCAL_ONLY",
      remoteWrite: "DISABLED",
      resourceCount: plan.resourceCount,
      renditionCount: plan.renditionCount,
      objectCount: plan.objectCount,
      metadataChangeCount: plan.metadataChangeCount,
      releaseId: plan.release.id,
      outputRoot: plan.outputRoot,
    }, null, 2));
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ status: "ERROR", message: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});

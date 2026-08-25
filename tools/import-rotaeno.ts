import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
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
import { loadCatalogFile, writeCatalogAndReleaseAtomic } from "../packages/domain/src/catalog.js";
import { createDeterministicUuidV7, immutableObjectKey, objectIdFromSha256 } from "../packages/domain/src/identity.js";
import { generateThumbnailSet } from "../packages/domain/src/thumbnails.js";
import { validateReleaseManifestConsistency } from "../packages/domain/src/validation.js";
import { UnifiedAssetManifest, type UnifiedAssetManifest as UnifiedAssetManifestType, readReleaseDelta } from "../packages/domain/src/release.js";
import { isReviewApproved, readReviewPackage, validateReviewPackageForDelta } from "../packages/domain/src/review-package.js";

const ROOT = path.resolve(".");
const SOURCE_TYPE = "rotaeno_apk" as const;
const PUBLIC_METADATA_KEYS = new Set([
  "artist", "illustrator", "pack", "packName", "characterName", "characterVariant",
  "gameVersion", "songId", "event", "collaboration", "collaborationPartner",
]);

type Args = {
  manifest: string;
  review: string;
  delta: string;
  apk: string;
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
    const key = token.slice(2) as keyof Args;
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(token + " requires a value");
    if (key !== "manifest" && key !== "review" && key !== "delta" && key !== "apk" && key !== "outputRoot") throw new Error("unknown option: " + token);
    args[key] = value;
  }
  return {
    manifest: required(args, "manifest"),
    review: required(args, "review"),
    delta: required(args, "delta"),
    apk: required(args, "apk"),
    ...(args.outputRoot ? { outputRoot: args.outputRoot } : {}),
    apply: args.apply === true,
  };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function safeFilename(value: string): string {
  const normalized = value.replace(/[\\/\0]/gu, "-").replace(/[^\p{L}\p{N} .()_\-]+/gu, "-").replace(/\s+/gu, " ").trim().replace(/^[-. ]+|[-. ]+$/gu, "");
  return (normalized || "rotaeno-asset") + (normalized.toLowerCase().endsWith(".png") ? "" : ".png");
}

function tempOutputPath(value: string): string {
  const absolute = path.resolve(value);
  const tempRoot = path.resolve("temp") + path.sep;
  if (!absolute.startsWith(tempRoot)) throw new Error("outputRoot must be inside repository temp/");
  return absolute;
}

function relativePortable(filePath: string): string {
  const absolute = path.resolve(filePath);
  const relative = path.relative(ROOT, absolute).replaceAll("\\", "/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) throw new Error("path must stay inside repository: " + filePath);
  return relative;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function uuid(kind: string, identity: string): string {
  return createDeterministicUuidV7("rotaeno:" + kind + ":" + identity);
}

function publicMetadata(entry: UnifiedAssetManifestType["entries"][number]): Record<string, string | number | boolean> {
  const nested = jsonObject(entry.metadata.metadata);
  const output: Record<string, string | number | boolean> = {};
  for (const key of PUBLIC_METADATA_KEYS) {
    const value = nested[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") output[key] = value;
  }
  if (entry.artist) output.artist = entry.artist;
  if (!output.gameVersion && entry.versionAdded) output.gameVersion = entry.versionAdded;
  return output;
}

function publicAliases(entry: UnifiedAssetManifestType["entries"][number]): Array<{ value: string; kind: "title" }> {
  return entry.aliases
    .filter((value) => !value.includes("/") && !value.includes("\\") && !value.startsWith("Assets"))
    .map((value) => ({ value, kind: "title" as const }));
}

function sourceMetadata(entry: UnifiedAssetManifestType["entries"][number]): Record<string, unknown> {
  return jsonObject(entry.metadata);
}

function objectProvenance(filePath: string, sha256: string, version: string, detail: string) {
  return [{
    sourceType: SOURCE_TYPE,
    sourceRelativePath: relativePortable(filePath),
    sourceFilename: path.basename(filePath),
    sourceSha256: sha256,
    gameVersion: version,
    evidence: [{ kind: "sha256" as const, detail, confidence: "high" as const }],
  }];
}

function makeObject(input: {
  filePath: string;
  sha256: string;
  sizeBytes: number;
  width: number;
  height: number;
  version: string;
  detail: string;
  alpha: "none" | "opaque" | "translucent" | "unknown";
}): AssetObjectType {
  const webp = input.filePath.toLowerCase().endsWith(".webp");
  return AssetObject.parse({
    catalogSchemaVersion: "1.0",
    id: objectIdFromSha256(input.sha256),
    sha256: input.sha256,
    mime: webp ? "image/webp" : "image/png",
    extension: webp ? "webp" : "png",
    sizeBytes: input.sizeBytes,
    width: input.width,
    height: input.height,
    alpha: input.alpha,
    objectKey: immutableObjectKey(input.sha256, webp ? "webp" : "png"),
    createdAt: now,
    provenance: objectProvenance(input.filePath, input.sha256, input.version, input.detail),
  });
}

function variantKind(entry: UnifiedAssetManifestType["entries"][number]): "default" | "event" | "source-path" {
  if (entry.variantKey === "default") return "default";
  if (entry.assetType === "background" || entry.assetType === "special-art" || Boolean(text(jsonObject(entry.metadata.metadata).event))) return "event";
  return "source-path";
}

let now = new Date().toISOString();
let argsSourceApk = "";

async function prepareEntry(
  entry: UnifiedAssetManifestType["entries"][number],
  apkSha256: string,
  sourceSnapshot: string,
  outputRoot: string,
  objectMap: Map<string, AssetObjectType>,
): Promise<Prepared> {
  if (!entry.sourcePath || !entry.file?.sha256 || !entry.file.width || !entry.file.height) throw new Error("Rotaeno entry is missing an extracted file: " + entry.identityKey);
  const canonicalPath = path.resolve(ROOT, entry.sourcePath);
  const info = await stat(canonicalPath);
  const actualSha256 = await sha256File(canonicalPath);
  if (actualSha256 !== entry.file.sha256) throw new Error("canonical hash mismatch: " + entry.identityKey);
  const imageInfo = await sharp(canonicalPath).metadata();
  if (imageInfo.format !== "png" || imageInfo.width !== entry.file.width || imageInfo.height !== entry.file.height) throw new Error("canonical PNG metadata mismatch: " + entry.identityKey);

  const resourceId = uuid("resource", entry.identityKey);
  const variantId = uuid("variant", entry.identityKey + ":" + entry.variantKey);
  const canonicalRenditionId = uuid("rendition", entry.identityKey + ":original");
  const metadata = publicMetadata(entry);
  const source = sourceMetadata(entry);
  const assetGuid = text(source.asset_guid);
  const resource = Resource.parse({
    catalogSchemaVersion: "1.0",
    id: resourceId,
    game: "rotaeno",
    resourceType: entry.assetType,
    ...(entry.title ? { title: entry.title } : {}),
    aliases: publicAliases(entry),
    externalIdentities: [
      { namespace: "rotaeno", key: "source-identity", value: entry.sourceIdentity, source: "apk-metadata", confidence: "high" },
      ...(assetGuid ? [{ namespace: "rotaeno", key: "asset-guid", value: assetGuid, source: "apk-metadata", confidence: "high" as const }] : []),
    ],
    metadata,
    relations: [],
    provenance: [{
      sourceType: SOURCE_TYPE,
      sourceSnapshot,
      gameVersion: entry.versionAdded ?? "2.26.1",
      sourceRelativePath: relativePortable(argsSourceApk),
      sourceFilename: path.basename(argsSourceApk),
      sourceSha256: apkSha256,
      evidence: [
        { kind: "apk-relative-path", detail: "Selected from the APK Addressables catalog via logical key " + (text(source.logical_key) ?? "unknown"), confidence: "high" },
        { kind: "metadata", detail: "Stable source identity and selected image scope were approved in the local review package.", confidence: "high" },
        { kind: "sha256", detail: "Extracted PNG bytes were verified against the candidate manifest.", confidence: "high" },
      ],
    }],
    lifecycle: { status: "published", createdAt: now, updatedAt: now, publishedAt: now },
  });
  const eventKey = text(jsonObject(entry.metadata.metadata).event);
  const variant = Variant.parse({
    catalogSchemaVersion: "1.0",
    id: variantId,
    resourceId,
    variantKey: entry.variantKey,
    kind: variantKind(entry),
    semanticStatus: "confirmed",
    ...(entry.variantKey === "default" || entry.assetType !== "character-portrait" ? { preferred: true } : {}),
    ...(eventKey ? { eventKey } : {}),
    note: "Curated Rotaeno image selection from the approved local review package.",
  });
  const downloadFilename = safeFilename(text(source.download_filename) ?? ("Rotaeno - " + (entry.title ?? entry.sourceIdentity)));
  const canonicalObject = makeObject({
    filePath: canonicalPath,
    sha256: actualSha256,
    sizeBytes: info.size,
    width: imageInfo.width!,
    height: imageInfo.height!,
    version: entry.versionAdded ?? "2.26.1",
    alpha: imageInfo.hasAlpha === false ? "opaque" : imageInfo.hasAlpha === true ? "translucent" : "unknown",
    detail: "Canonical PNG extracted from the selected Rotaeno Unity bundle; APK SHA-256 " + apkSha256 + ".",
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
    downloadFilename,
    generatedBy: "extractor",
    createdAt: now,
  });
  const thumbnailRoot = path.join(outputRoot, "derived-thumbnails");
  const thumbnailResults = await generateThumbnailSet(canonicalPath, thumbnailRoot, "rotaeno-" + actualSha256.slice(0, 16));
  const thumbnails: RenditionType[] = [];
  for (const thumbnail of thumbnailResults) {
    const object = makeObject({
      filePath: thumbnail.absolutePath,
      sha256: thumbnail.sha256,
      sizeBytes: thumbnail.sizeBytes,
      width: thumbnail.pixelWidth,
      height: thumbnail.height,
      version: entry.versionAdded ?? "2.26.1",
      alpha: "unknown",
      detail: "Generated thumbnail-" + thumbnail.width + " from the approved Rotaeno canonical PNG.",
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

async function buildPlan(args: Args, manifest: UnifiedAssetManifestType): Promise<{ catalog: CatalogType; release: ReleaseManifestType; resourceCount: number; renditionCount: number; objectCount: number; sourceSnapshot: string; outputRoot: string }> {
  argsSourceApk = path.resolve(args.apk);
  const apkSha256 = await sha256File(argsSourceApk);
  const sourceSnapshot = "rotaeno:mainland_cn:" + manifest.version + ":" + apkSha256;
  const outputRoot = tempOutputPath(args.outputRoot ?? path.join("temp", "rotaeno_publish", manifest.version));
  await mkdir(outputRoot, { recursive: true });
  const existing = await loadCatalogFile();
  if (existing.resources.some((resource) => resource.game === "rotaeno")) throw new Error("Catalog already contains Rotaeno resources; refusing an implicit replacement.");
  const objectMap = new Map(existing.objects.map((object) => [object.id, object]));
  const prepared: Prepared[] = [];
  for (const entry of manifest.entries) prepared.push(await prepareEntry(entry, apkSha256, sourceSnapshot, outputRoot, objectMap));
  const resources = [...existing.resources, ...prepared.map((item) => item.resource)];
  const variants = [...existing.variants, ...prepared.map((item) => item.variant)];
  const renditions = [...existing.renditions, ...prepared.flatMap((item) => item.renditions)];
  const releaseId = uuid("release", sourceSnapshot);
  const catalog = Catalog.parse({
    ...existing,
    generatedAt: now,
    resources,
    variants,
    renditions,
    objects: [...objectMap.values()],
    releaseManifestIds: [...new Set([...existing.releaseManifestIds, releaseId])],
  });
  const changes: ReleaseManifestType["changes"] = [];
  for (const item of prepared) {
    changes.push({ changeType: "added-resource", resourceId: item.resource.id, detail: "Rotaeno curated image Resource" });
    changes.push({ changeType: "added-variant", resourceId: item.resource.id, variantId: item.variant.id, detail: "Approved Rotaeno semantic image Variant" });
    for (const rendition of item.renditions) changes.push({ changeType: "added-rendition", resourceId: item.resource.id, variantId: item.variant.id, renditionId: rendition.id, objectId: rendition.objectId, detail: "Canonical or derived Rotaeno image Rendition" });
  }
  const release = ReleaseManifest.parse({
    releaseSchemaVersion: "1.0",
    id: releaseId,
    updateBatchId: uuid("batch", sourceSnapshot),
    game: "rotaeno",
    baseVersion: "none",
    targetVersion: manifest.version,
    createdAt: now,
    status: "published",
    changes,
    affectedResourceIds: prepared.map((item) => item.resource.id),
    publishedRenditions: prepared.map((item) => ({ resourceId: item.resource.id, variantId: item.variant.id, renditionId: item.canonical.id, objectId: item.canonical.objectId, downloadFilename: item.canonical.downloadFilename })),
    removedFromCurrentSource: [],
    notes: [
      "Initial Rotaeno mainland CN 2.26.1 curated image integration.",
      "Scope includes 428 jackets, 97 pack covers, 51 extracted character/driver artworks, 10 story CGs, and 10 startup/main visuals.",
      "Event artwork, journey map art, badges, audio, charts, and non-image ScriptableObject shells remain outside the public Catalog.",
      "Local Catalog and ReleaseManifest only; ROS/object-storage upload and production publication were intentionally not performed.",
    ],
  });
  const validation = validateReleaseManifestConsistency(release, catalog);
  if (!validation.success) throw new Error("Rotaeno ReleaseManifest consistency failed: " + validation.issues.slice(0, 8).map((issue) => String(issue.path) + " " + issue.message).join("; "));
  await writeFile(path.join(outputRoot, "rotaeno-import-plan.json"), JSON.stringify({
    status: "READY_LOCAL_ONLY",
    remoteWrite: "DISABLED",
    sourceSnapshot,
    sourceSha256: apkSha256,
    resourceCount: prepared.length,
    renditionCount: prepared.reduce((sum, item) => sum + item.renditions.length, 0),
    objectCount: objectMap.size - existing.objects.length,
    releaseId,
  }, null, 2) + "\n", "utf8");
  return { catalog, release, resourceCount: prepared.length, renditionCount: prepared.reduce((sum, item) => sum + item.renditions.length, 0), objectCount: objectMap.size - existing.objects.length, sourceSnapshot, outputRoot };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const manifest = UnifiedAssetManifest.parse(JSON.parse(await readFile(path.resolve(args.manifest), "utf8")) as unknown);
  const review = await readReviewPackage(path.resolve(args.review));
  const delta = await readReleaseDelta(path.resolve(args.delta));
  const reviewValidation = validateReviewPackageForDelta(review, delta);
  if (!reviewValidation.valid) throw new Error("approved-review does not match release delta: " + reviewValidation.reasons.join("; "));
  if (!isReviewApproved(review)) throw new Error("Rotaeno import requires an approved review package.");
  if (review.gameId !== "rotaeno" || review.version !== manifest.version || delta.gameId !== "rotaeno" || delta.currentVersion !== manifest.version) throw new Error("Rotaeno manifest, delta, and review versions do not match.");
  const plan = await buildPlan(args, manifest);
  if (args.apply) {
    const commit = await writeCatalogAndReleaseAtomic(plan.catalog, plan.release);
    console.log(JSON.stringify({ status: "APPLIED_LOCAL_ONLY", remoteWrite: "DISABLED", resourceCount: plan.resourceCount, renditionCount: plan.renditionCount, objectCount: plan.objectCount, releaseId: plan.release.id, commit }, null, 2));
  } else {
    console.log(JSON.stringify({ status: "READY_LOCAL_ONLY", remoteWrite: "DISABLED", resourceCount: plan.resourceCount, renditionCount: plan.renditionCount, objectCount: plan.objectCount, releaseId: plan.release.id, outputRoot: plan.outputRoot }, null, 2));
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ status: "ERROR", message: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});

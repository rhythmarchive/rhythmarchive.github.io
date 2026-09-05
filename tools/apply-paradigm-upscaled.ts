import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import sharp from "sharp";
import {
  AssetObject,
  Catalog,
  ReleaseManifest,
  Rendition,
  Resource,
  type AssetObject as AssetObjectType,
  type Catalog as CatalogType,
  type ReleaseManifest as ReleaseManifestType,
  type Rendition as RenditionType,
  type Resource as ResourceType,
} from "../packages/domain/src/schema.js";
import { loadCatalogFile, writeCatalogAndReleaseAtomic } from "../packages/domain/src/catalog.js";
import { createDeterministicUuidV7, immutableObjectKey, objectIdFromSha256 } from "../packages/domain/src/identity.js";
import { validateCatalog, validateReleaseManifestConsistency } from "../packages/domain/src/validation.js";

const REPOSITORY_ROOT = path.resolve(".");
const TEMP_ROOT = path.resolve("temp") + path.sep;
const DEFAULT_INPUT = path.resolve("temp/rhythmctl/paradigm-reboot/4.10/upscaled-manifest.json");
const DEFAULT_CATALOG = path.resolve("catalog/index.json");
const DEFAULT_RELEASES = path.resolve("catalog/releases");
const DEFAULT_PLAN = path.resolve("temp/rhythmctl/paradigm-reboot/4.10/upscaled-release-plan.json");
const GAME = "paradigm-reboot" as const;
const VERSION = "4.10";
const EXPECTED_ENTRIES = 421;

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/iu);
const UpscaledEntry = z.object({
  resourceId: z.string().min(1),
  variantId: z.string().min(1),
  originalRenditionId: z.string().min(1),
  originalObjectId: z.string().regex(/^sha256:[0-9a-f]{64}$/iu),
  originalFilename: z.string().min(1),
  sourceRelativePath: z.string().min(1),
  jpegPath: z.string().min(1),
  sha256: Sha256,
  sizeBytes: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  mime: z.literal("image/jpeg"),
});
const UpscaledManifest = z.object({
  schemaVersion: z.literal(1),
  game: z.literal(GAME),
  version: z.literal(VERSION),
  generatedAt: z.string().min(1),
  source: z.object({
    model: z.string().min(1),
    jpegQuality: z.number().int().min(1).max(100),
    chromaSubsampling: z.string().min(1),
    progressive: z.boolean(),
  }),
  uniqueOriginalObjects: z.number().int().positive(),
  entries: z.array(UpscaledEntry).length(EXPECTED_ENTRIES),
});
type UpscaledEntryType = z.infer<typeof UpscaledEntry>;

type Args = {
  input: string;
  catalog: string;
  releases: string;
  plan: string;
  apply: boolean;
};

type PlannedObject = {
  objectId: string;
  objectKey: string;
  sha256: string;
  sizeBytes: number;
  mime: "image/jpeg";
  extension: "jpg";
  width: number;
  height: number;
  localPath: string;
  resourceId: string;
  variantId: string;
  renditionId: string;
  sourceRenditionId: string;
  sourcePath: string;
  downloadFilename: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { input: DEFAULT_INPUT, catalog: DEFAULT_CATALOG, releases: DEFAULT_RELEASES, plan: DEFAULT_PLAN, apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) throw new Error("unexpected end of arguments");
    if (token === "--apply") {
      args.apply = true;
      continue;
    }
    if (!token.startsWith("--")) throw new Error("unexpected argument: " + token);
    const key = token.slice(2) as "input" | "catalog" | "releases" | "plan";
    if (!["input", "catalog", "releases", "plan"].includes(key)) throw new Error("unknown option: " + token);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(token + " requires a value");
    args[key] = value;
  }
  return args;
}

function isInside(root: string, candidate: string): boolean {
  const normalizedRoot = path.resolve(root).toLowerCase();
  const normalizedCandidate = path.resolve(candidate).toLowerCase();
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(normalizedRoot + path.sep);
}

function requireTempPath(candidate: string, label: string): string {
  const resolved = path.resolve(candidate);
  if (!isInside(TEMP_ROOT, resolved)) throw new Error(label + " must stay under repository temp/: " + candidate);
  return resolved;
}

function requireRepositoryPath(candidate: string, label: string): string {
  const resolved = path.resolve(candidate);
  if (!isInside(REPOSITORY_ROOT, resolved)) throw new Error(label + " must stay inside the repository: " + candidate);
  return resolved;
}

function relativePath(value: string): string {
  return path.relative(REPOSITORY_ROOT, value).replaceAll("\\", "/");
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function readManifest(inputPath: string): Promise<UpscaledEntryType[]> {
  const manifest = UpscaledManifest.parse(JSON.parse(await readFile(inputPath, "utf8")) as unknown);
  if (manifest.uniqueOriginalObjects !== EXPECTED_ENTRIES) throw new Error("upscaled manifest unique object count must be " + EXPECTED_ENTRIES);
  return manifest.entries;
}

async function findPublishedBaseRelease(releasesDirectory: string): Promise<ReleaseManifestType> {
  const files = (await readdir(releasesDirectory, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"));
  const candidates: ReleaseManifestType[] = [];
  for (const file of files) {
    try {
      const parsed = ReleaseManifest.safeParse(JSON.parse(await readFile(path.join(releasesDirectory, file.name), "utf8")) as unknown);
      if (parsed.success && parsed.data.game === GAME && parsed.data.targetVersion === VERSION && parsed.data.status === "published") candidates.push(parsed.data);
    } catch {
      // Ignore unrelated or incomplete release artifacts.
    }
  }
  const [latest] = candidates.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  if (!latest) throw new Error("no published " + GAME + " " + VERSION + " base release found");
  return latest;
}

function sourceObject(catalog: CatalogType, original: RenditionType): AssetObjectType {
  const object = catalog.objects.find((candidate) => candidate.id === original.objectId);
  if (!object) throw new Error("original Object is missing for " + original.id);
  return object;
}

function jpegFilename(originalFilename: string): string {
  return originalFilename.replace(/\.[^.\\/]+$/u, ".jpg");
}

async function buildObject(entry: UpscaledEntryType, filePath: string, originalObject: AssetObjectType, now: string): Promise<AssetObjectType> {
  const metadata = await sharp(filePath, { animated: false }).metadata();
  if (metadata.format !== "jpeg" || metadata.width !== entry.width || metadata.height !== entry.height) throw new Error("processed JPEG metadata does not match manifest for " + entry.resourceId);
  return AssetObject.parse({
    catalogSchemaVersion: "1.0",
    id: objectIdFromSha256(entry.sha256),
    sha256: entry.sha256,
    mime: "image/jpeg",
    extension: "jpg",
    sizeBytes: entry.sizeBytes,
    width: entry.width,
    height: entry.height,
    alpha: "opaque",
    objectKey: immutableObjectKey(entry.sha256, "jpg"),
    createdAt: now,
    provenance: [{
      sourceType: "paradigm_apk",
      sourceRelativePath: originalObject.provenance[0]?.sourceRelativePath ?? "paradigm/4.10/D146",
      sourceFilename: originalObject.provenance[0]?.sourceFilename ?? entry.originalFilename,
      sourceSha256: entry.sha256,
      gameVersion: VERSION,
      evidence: [
        { kind: "metadata", detail: "Real-ESRGAN x4 derived from the reviewed Paradigm 4.10 jacket PNG.", confidence: "high" },
        { kind: "visual-review", detail: "The derived JPEG was generated from the orientation-corrected jacket and dimension-checked before Catalog application.", confidence: "high" },
        { kind: "sha256", detail: "SHA-256 was verified against the staged processed JPEG.", confidence: "high" },
      ],
    }],
  });
}

async function buildPlan(entries: UpscaledEntryType[], existing: CatalogType, baseRelease: ReleaseManifestType, inputRoot: string): Promise<{ catalog: CatalogType; release: ReleaseManifestType; objects: PlannedObject[]; newObjectCount: number; newObjectBytes: number; changedResourceIds: string[]; generatedAt: string }> {
  const now = new Date().toISOString();
  const resources = [...existing.resources];
  const variants = [...existing.variants];
  const renditions = [...existing.renditions];
  const objects = [...existing.objects];
  const resourceIndex = new Map(resources.map((resource) => [resource.id, resource]));
  const variantIndex = new Map(variants.map((variant) => [variant.id, variant]));
  const renditionIndex = new Map(renditions.map((rendition) => [rendition.id, rendition]));
  const objectIndex = new Map(objects.map((object) => [object.id, object]));
  const changes: ReleaseManifestType["changes"] = [];
  const affectedResourceIds: string[] = [];
  const plannedObjects: PlannedObject[] = [];
  for (const entry of entries) {
    const resource = resourceIndex.get(entry.resourceId);
    const variant = variantIndex.get(entry.variantId);
    if (!resource || resource.game !== GAME || resource.resourceType !== "jacket" || resource.lifecycle.status !== "published") throw new Error("published Paradigm jacket Resource is missing for " + entry.resourceId);
    if (!variant || variant.resourceId !== resource.id) throw new Error("Paradigm Variant relation is invalid for " + entry.variantId);
    const original = renditionIndex.get(entry.originalRenditionId);
    if (!original || original.variantId !== variant.id || original.renditionType !== "original" || !original.publishable) throw new Error("original Rendition relation is invalid for " + entry.originalRenditionId);
    if (original.objectId !== entry.originalObjectId) throw new Error("original Object identity changed for " + entry.resourceId);
    const originalObject = sourceObject(existing, original);
    const filePath = path.resolve(inputRoot, entry.jpegPath);
    if (!isInside(inputRoot, filePath)) throw new Error("processed JPEG escapes the manifest directory for " + entry.resourceId);
    const fileStats = await stat(filePath).catch(() => undefined);
    if (!fileStats?.isFile() || fileStats.size !== entry.sizeBytes) throw new Error("processed JPEG size mismatch for " + entry.resourceId);
    const actualSha256 = await sha256File(filePath);
    if (actualSha256.toLowerCase() !== entry.sha256.toLowerCase()) throw new Error("processed JPEG SHA-256 mismatch for " + entry.resourceId);
    const metadata = await sharp(filePath, { animated: false }).metadata();
    if (metadata.format !== "jpeg" || metadata.width !== entry.width || metadata.height !== entry.height) throw new Error("processed JPEG dimensions/format mismatch for " + entry.resourceId);

    const objectId = objectIdFromSha256(actualSha256);
    const renditionId = createDeterministicUuidV7("paradigm:upscaled:" + VERSION + ":" + resource.id + ":" + variant.id);
    const existingUpscaled = existing.renditions.find((rendition) => rendition.variantId === variant.id && rendition.renditionType === "upscaled");
    if (existingUpscaled && (existingUpscaled.objectId !== objectId || existingUpscaled.sourceRenditionId !== original.id || !existingUpscaled.publishable)) throw new Error("an existing Paradigm upscaled Rendition does not match the current original for " + entry.resourceId);
    const upscaled = existingUpscaled ?? Rendition.parse({
      catalogSchemaVersion: "1.0",
      id: renditionId,
      variantId: variant.id,
      renditionType: "upscaled",
      origin: "derived",
      publishable: true,
      objectId,
      downloadFilename: jpegFilename(entry.originalFilename),
      sourceRenditionId: original.id,
      generatedBy: "converter",
      createdAt: now,
    });
    if (!objectIndex.has(objectId)) {
      const object = await buildObject(entry, filePath, originalObject, now);
      objects.push(object);
      objectIndex.set(object.id, object);
    }
    if (!renditionIndex.has(upscaled.id)) {
      renditions.push(upscaled);
      renditionIndex.set(upscaled.id, upscaled);
      changes.push({ changeType: "added-rendition", resourceId: resource.id, variantId: variant.id, renditionId: upscaled.id, objectId, detail: "add Paradigm 4.10 x4 upscaled JPEG jacket rendition" });
    }
    if (!affectedResourceIds.includes(resource.id)) affectedResourceIds.push(resource.id);
    resourceIndex.set(resource.id, Resource.parse({ ...resource, lifecycle: { ...resource.lifecycle, updatedAt: now } }));
    resources[resources.indexOf(resource)] = resourceIndex.get(resource.id)!;
    plannedObjects.push({
      objectId,
      objectKey: immutableObjectKey(actualSha256, "jpg"),
      sha256: actualSha256,
      sizeBytes: fileStats.size,
      mime: "image/jpeg",
      extension: "jpg",
      width: entry.width,
      height: entry.height,
      localPath: relativePath(filePath),
      resourceId: resource.id,
      variantId: variant.id,
      renditionId: upscaled.id,
      sourceRenditionId: original.id,
      sourcePath: entry.sourceRelativePath,
      downloadFilename: jpegFilename(entry.originalFilename),
    });
  }

  if (changes.length > EXPECTED_ENTRIES) throw new Error("more Paradigm upscaled renditions were added than the manifest contains");
  const release = ReleaseManifest.parse({
    releaseSchemaVersion: "1.0",
    id: createDeterministicUuidV7("paradigm:release:" + VERSION + ":upscaled-jackets"),
    updateBatchId: baseRelease.updateBatchId,
    game: GAME,
    baseVersion: baseRelease.baseVersion,
    targetVersion: VERSION,
    createdAt: now,
    status: "published",
    changes,
    affectedResourceIds,
    publishedRenditions: plannedObjects.map((item) => ({ resourceId: item.resourceId, variantId: item.variantId, renditionId: item.renditionId, objectId: item.objectId, downloadFilename: item.downloadFilename })),
    removedFromCurrentSource: [],
    notes: [
      "Paradigm 4.10 add-on: 421 orientation-corrected jacket variants receive Real-ESRGAN x4 JPEG renditions.",
      "Original PNG Renditions, existing thumbnail Renditions, and Resource/Variant identities are preserved.",
      "Remote object upload is intentionally outside this local Catalog application; the plan retains local staged paths for review/upload.",
    ],
  });
  const nextCatalog = Catalog.parse({
    ...existing,
    generatedAt: now,
    resources,
    renditions,
    objects,
    releaseManifestIds: [...new Set([...existing.releaseManifestIds, release.id])],
  });
  const catalogValidation = validateCatalog(nextCatalog);
  if (!catalogValidation.success) throw new Error("Paradigm upscaled Catalog validation failed: " + catalogValidation.issues.map((issue) => issue.path + " " + issue.message).join("; "));
  const releaseValidation = validateReleaseManifestConsistency(release, nextCatalog);
  if (!releaseValidation.success) throw new Error("Paradigm upscaled ReleaseManifest validation failed: " + releaseValidation.issues.map((issue) => issue.path + " " + issue.message).join("; "));
  const newObjects = plannedObjects.filter((item) => !existing.objects.some((object) => object.id === item.objectId));
  return { catalog: nextCatalog, release, objects: plannedObjects, newObjectCount: newObjects.length, newObjectBytes: newObjects.reduce((sum, item) => sum + item.sizeBytes, 0), changedResourceIds: affectedResourceIds, generatedAt: now };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = requireTempPath(args.input, "input");
  const planPath = requireTempPath(args.plan, "plan");
  const catalogPath = requireRepositoryPath(args.catalog, "Catalog");
  const releasesDirectory = requireRepositoryPath(args.releases, "release directory");
  const entries = await readManifest(inputPath);
  const existing = await loadCatalogFile(catalogPath);
  const baseRelease = await findPublishedBaseRelease(releasesDirectory);
  const result = await buildPlan(entries, existing, baseRelease, path.dirname(inputPath));
  const plan = {
    status: args.apply ? "READY_TO_APPLY" : "READY_LOCAL_ONLY",
    remoteWrite: "DISABLED",
    catalogWrite: args.apply,
    game: GAME,
    version: VERSION,
    baseReleaseId: baseRelease.id,
    releaseId: result.release.id,
    generatedAt: result.generatedAt,
    changedResourceCount: result.changedResourceIds.length,
    changedRenditionCount: result.release.changes.length,
    objectCount: result.objects.length,
    newObjectCount: result.newObjectCount,
    newObjectBytes: result.newObjectBytes,
    objects: result.objects,
  };
  await mkdir(path.dirname(planPath), { recursive: true });
  await writeFile(planPath, JSON.stringify(plan, null, 2) + "\n", "utf8");
  if (args.apply && result.release.changes.length > 0) await writeCatalogAndReleaseAtomic(result.catalog, result.release, { catalogPath, releasesDirectory });
  console.log(JSON.stringify({ status: args.apply ? (result.release.changes.length > 0 ? "APPLIED" : "NO_CHANGES") : "READY_LOCAL_ONLY", game: GAME, version: VERSION, releaseId: result.release.id, objectCount: result.objects.length, newObjectCount: result.newObjectCount, newObjectBytes: result.newObjectBytes, changedResourceCount: result.changedResourceIds.length, changedRenditionCount: result.release.changes.length, catalogWrite: args.apply && result.release.changes.length > 0, releasePath: path.join(releasesDirectory, result.release.id + ".json"), planPath }, null, 2));
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ status: "ERROR", message: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});

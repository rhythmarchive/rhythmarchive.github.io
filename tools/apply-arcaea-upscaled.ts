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

const REPO_ROOT = path.resolve(".");
const TEMP_ROOT = path.resolve("temp") + path.sep;
const DEFAULT_INPUT = path.resolve("temp/rhythmctl/arcaea/7.0.0c/article-assets/manifest.json");
const DEFAULT_CATALOG = path.resolve("catalog/index.json");
const DEFAULT_RELEASES = path.resolve("catalog/releases");
const DEFAULT_PLAN = path.resolve("temp/rhythmctl/arcaea/7.0.0c/upscaled-release-plan.json");
const GAME = "arcaea" as const;
const VERSION = "7.0.0c";
const EXPECTED_COUNT = 8;

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/iu);
const ArticleEntry = z.object({
  title: z.string().min(1),
  artist: z.string().min(1),
  sourcePath: z.string().min(1),
  originalSha256: Sha256,
  articleJpeg: z.object({
    stagedPath: z.string().min(1),
    sha256: Sha256,
    sizeBytes: z.number().int().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    mime: z.literal("image/jpeg"),
  }),
  status: z.literal("local-review-only"),
});
const ArticleManifest = z.object({
  jacketUpscaled: z.array(ArticleEntry).length(EXPECTED_COUNT),
});
type ArticleEntryType = z.infer<typeof ArticleEntry>;

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
  title: string;
  resourceId: string;
  variantId: string;
  renditionId: string;
  sourceRenditionId: string;
  sourcePath: string;
};

type BuildResult = {
  catalog: CatalogType;
  release: ReleaseManifestType;
  objects: PlannedObject[];
  newObjectCount: number;
  newObjectBytes: number;
  changedResourceIds: string[];
  generatedAt: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    input: DEFAULT_INPUT,
    catalog: DEFAULT_CATALOG,
    releases: DEFAULT_RELEASES,
    plan: DEFAULT_PLAN,
    apply: false,
  };
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
  if (!isInside(REPO_ROOT, resolved)) throw new Error(label + " must stay inside the repository: " + candidate);
  return resolved;
}

function normalize(value: string): string {
  return value.replaceAll("\\", "/").replace(/^assets\//iu, "");
}

function relativePath(value: string): string {
  return path.relative(REPO_ROOT, value).replaceAll("\\", "/");
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function readArticleManifest(inputPath: string): Promise<ArticleEntryType[]> {
  const parsed = ArticleManifest.parse(JSON.parse(await readFile(inputPath, "utf8")) as unknown);
  return parsed.jacketUpscaled;
}

async function findPublishedBaseRelease(releasesDirectory: string): Promise<ReleaseManifestType> {
  const files = (await readdir(releasesDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"));
  const candidates: ReleaseManifestType[] = [];
  for (const file of files) {
    try {
      const parsed = ReleaseManifest.safeParse(JSON.parse(await readFile(path.join(releasesDirectory, file.name), "utf8")) as unknown);
      if (parsed.success && parsed.data.game === GAME && parsed.data.targetVersion === VERSION && parsed.data.status === "published") {
        candidates.push(parsed.data);
      }
    } catch {
      // Ignore unrelated or incomplete release artifacts in the directory.
    }
  }
  const [latest] = candidates.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  if (!latest) throw new Error("no published " + GAME + " " + VERSION + " base release found");
  return latest;
}

function sourceMatches(resource: ResourceType, sourcePath: string): boolean {
  const target = normalize(sourcePath).toLowerCase();
  return resource.provenance.some((provenance) => {
    const candidate = normalize(provenance.sourceRelativePath).toLowerCase();
    return candidate === target || candidate.endsWith("/" + target);
  });
}

function sourceObject(resource: ResourceType, original: RenditionType, catalog: CatalogType): AssetObjectType {
  const object = catalog.objects.find((candidate) => candidate.id === original.objectId);
  if (!object) throw new Error(resource.title + ": original Object is missing");
  return object;
}

async function buildObject(entry: ArticleEntryType, filePath: string, originalObject: AssetObjectType, now: string): Promise<AssetObjectType> {
  const metadata = await sharp(filePath, { animated: false }).metadata();
  if (metadata.format !== "jpeg" || metadata.width !== entry.articleJpeg.width || metadata.height !== entry.articleJpeg.height) {
    throw new Error(entry.title + ": processed JPEG metadata does not match the article manifest");
  }
  return AssetObject.parse({
    catalogSchemaVersion: "1.0",
    id: objectIdFromSha256(entry.articleJpeg.sha256),
    sha256: entry.articleJpeg.sha256,
    mime: "image/jpeg",
    extension: "jpg",
    sizeBytes: entry.articleJpeg.sizeBytes,
    width: metadata.width,
    height: metadata.height,
    alpha: "opaque",
    objectKey: immutableObjectKey(entry.articleJpeg.sha256, "jpg"),
    createdAt: now,
    provenance: [{
      sourceType: "arcaea_apk",
      sourceRelativePath: originalObject.provenance[0]!.sourceRelativePath,
      sourceFilename: originalObject.provenance[0]!.sourceFilename,
      sourceSha256: entry.articleJpeg.sha256,
      gameVersion: VERSION,
      evidence: [
        { kind: "metadata", detail: "Real-ESRGAN x4 upscale derived from the approved " + VERSION + " jacket source.", confidence: "high" },
        { kind: "visual-review", detail: "Processed JPEG was visually checked in the 7.0 upscale contact sheet.", confidence: "high" },
        { kind: "sha256", detail: "SHA-256 was verified against the staged processed JPEG.", confidence: "high" },
      ],
    }],
  });
}

async function buildPlan(args: Args, inputEntries: ArticleEntryType[], existing: CatalogType, baseRelease: ReleaseManifestType): Promise<BuildResult> {
  const inputRoot = path.dirname(args.input);
  const now = new Date().toISOString();
  const resources = [...existing.resources];
  const renditions = [...existing.renditions];
  const objects = [...existing.objects];
  const objectIndex = new Map(objects.map((object) => [object.id, object]));
  const renditionIndex = new Map(renditions.map((rendition) => [rendition.id, rendition]));
  const planned: PlannedObject[] = [];
  const changes: ReleaseManifestType["changes"] = [];
  const affectedResourceIds: string[] = [];

  for (const entry of inputEntries) {
    const resourceMatches = resources.filter((resource) =>
      resource.game === GAME &&
      resource.resourceType === "jacket" &&
      resource.provenance.some((provenance) => provenance.gameVersion === VERSION) &&
      sourceMatches(resource, entry.sourcePath),
    );
    if (resourceMatches.length !== 1) throw new Error(entry.title + ": expected one published " + VERSION + " jacket Resource, found " + resourceMatches.length);
    const resource = resourceMatches[0]!;
    const variants = existing.variants.filter((variant) => variant.resourceId === resource.id && variant.variantKey === "default");
    if (variants.length !== 1) throw new Error(entry.title + ": expected one default Variant, found " + variants.length);
    const variant = variants[0]!;
    const originalRenditions = existing.renditions.filter((rendition) =>
      rendition.variantId === variant.id &&
      rendition.renditionType === "original" &&
      rendition.publishable,
    );
    if (originalRenditions.length !== 1) throw new Error(entry.title + ": expected one publishable original Rendition, found " + originalRenditions.length);
    const original = originalRenditions[0]!;
    const originalObject = sourceObject(resource, original, existing);
    if (originalObject.sha256.toLowerCase() !== entry.originalSha256.toLowerCase()) {
      throw new Error(entry.title + ": article manifest original SHA-256 does not match the Catalog original");
    }

    const filePath = path.resolve(inputRoot, entry.articleJpeg.stagedPath);
    if (!isInside(inputRoot, filePath)) throw new Error(entry.title + ": staged JPEG escapes the article asset directory");
    const fileStats = await stat(filePath).catch(() => undefined);
    if (!fileStats?.isFile() || fileStats.size !== entry.articleJpeg.sizeBytes) throw new Error(entry.title + ": staged JPEG size mismatch");
    const actualSha256 = await sha256File(filePath);
    if (actualSha256.toLowerCase() !== entry.articleJpeg.sha256.toLowerCase()) throw new Error(entry.title + ": staged JPEG SHA-256 mismatch");
    const metadata = await sharp(filePath, { animated: false }).metadata();
    if (metadata.format !== "jpeg" || metadata.width !== entry.articleJpeg.width || metadata.height !== entry.articleJpeg.height) {
      throw new Error(entry.title + ": staged JPEG dimensions/format mismatch");
    }

    const objectId = objectIdFromSha256(actualSha256);
    const renditionId = createDeterministicUuidV7("arcaea:upscaled:" + resource.id + ":" + variant.id);
    const existingUpscaled = existing.renditions.find((rendition) => rendition.variantId === variant.id && rendition.renditionType === "upscaled");
    if (existingUpscaled && existingUpscaled.objectId !== objectId) {
      throw new Error(entry.title + ": an existing upscaled Rendition points to a different Object; refusing replacement");
    }
    const upscaled = existingUpscaled ?? Rendition.parse({
      catalogSchemaVersion: "1.0",
      id: renditionId,
      variantId: variant.id,
      renditionType: "upscaled",
      origin: "derived",
      publishable: true,
      objectId,
      downloadFilename: original.downloadFilename,
      sourceRenditionId: original.id,
      generatedBy: "converter",
      createdAt: now,
    });
    if (upscaled.sourceRenditionId !== original.id || upscaled.objectId !== objectId || !upscaled.publishable) {
      throw new Error(entry.title + ": upscaled Rendition does not point to the current original");
    }

    if (!objectIndex.has(objectId)) {
      const object = await buildObject(entry, filePath, originalObject, now);
      objects.push(object);
      objectIndex.set(object.id, object);
    }
    if (!renditionIndex.has(upscaled.id)) {
      renditions.push(upscaled);
      renditionIndex.set(upscaled.id, upscaled);
      changes.push({
        changeType: "added-rendition",
        resourceId: resource.id,
        variantId: variant.id,
        renditionId: upscaled.id,
        objectId,
        detail: "add 7.0.0c upscaled jacket rendition for " + entry.title,
      });
    }
    if (!affectedResourceIds.includes(resource.id)) affectedResourceIds.push(resource.id);
    resources[resources.indexOf(resource)] = Resource.parse({
      ...resource,
      lifecycle: { ...resource.lifecycle, updatedAt: now },
    });
    planned.push({
      objectId,
      objectKey: immutableObjectKey(actualSha256, "jpg"),
      sha256: actualSha256,
      sizeBytes: fileStats.size,
      mime: "image/jpeg",
      extension: "jpg",
      width: metadata.width!,
      height: metadata.height!,
      localPath: relativePath(filePath),
      title: entry.title,
      resourceId: resource.id,
      variantId: variant.id,
      renditionId: upscaled.id,
      sourceRenditionId: original.id,
      sourcePath: normalize(entry.sourcePath),
    });
  }

  const release = ReleaseManifest.parse({
    releaseSchemaVersion: "1.0",
    id: createDeterministicUuidV7("arcaea:release:7.0.0c:upscaled-jackets"),
    updateBatchId: baseRelease.updateBatchId,
    game: GAME,
    baseVersion: baseRelease.baseVersion,
    targetVersion: VERSION,
    createdAt: now,
    status: "published",
    changes,
    affectedResourceIds,
    publishedRenditions: planned.map((item) => ({
      resourceId: item.resourceId,
      variantId: item.variantId,
      renditionId: item.renditionId,
      objectId: item.objectId,
      downloadFilename: existing.renditions.find((rendition) => rendition.id === item.sourceRenditionId)?.downloadFilename ?? "upscaled.jpg",
    })),
    removedFromCurrentSource: [],
    notes: [
      "Arcaea 7.0.0c add-on: 8 visually reviewed Real-ESRGAN x4 jacket upscaled renditions.",
      "Original Renditions, existing thumbnail Renditions, and all prior Objects are preserved.",
      "No Catalog or ROS deletion was performed; the release adds only the approved upscaled JPEG Objects.",
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
  if (!catalogValidation.success) throw new Error("upscaled Catalog validation failed: " + catalogValidation.issues.map((issue) => issue.path + " " + issue.message).join("; "));
  const releaseValidation = validateReleaseManifestConsistency(release, nextCatalog);
  if (!releaseValidation.success) throw new Error("upscaled ReleaseManifest validation failed: " + releaseValidation.issues.map((issue) => issue.path + " " + issue.message).join("; "));

  const newObjects = planned.filter((item) => !existing.objects.some((object) => object.id === item.objectId));
  return {
    catalog: nextCatalog,
    release,
    objects: planned,
    newObjectCount: newObjects.length,
    newObjectBytes: newObjects.reduce((sum, item) => sum + item.sizeBytes, 0),
    changedResourceIds: affectedResourceIds,
    generatedAt: now,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = requireTempPath(args.input, "input");
  const planPath = requireTempPath(args.plan, "plan");
  const catalogPath = requireRepositoryPath(args.catalog, "Catalog");
  const releasesDirectory = requireRepositoryPath(args.releases, "release directory");
  const entries = await readArticleManifest(inputPath);
  const existing = await loadCatalogFile(catalogPath);
  const baseRelease = await findPublishedBaseRelease(releasesDirectory);
  const result = await buildPlan({ ...args, input: inputPath, plan: planPath, catalog: catalogPath, releases: releasesDirectory }, entries, existing, baseRelease);
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
  if (args.apply) {
    await writeCatalogAndReleaseAtomic(result.catalog, result.release, { catalogPath, releasesDirectory });
  }
  console.log(JSON.stringify({
    status: args.apply ? "APPLIED" : "READY_LOCAL_ONLY",
    game: GAME,
    version: VERSION,
    releaseId: result.release.id,
    objectCount: result.objects.length,
    newObjectCount: result.newObjectCount,
    newObjectBytes: result.newObjectBytes,
    changedResourceCount: result.changedResourceIds.length,
    changedRenditionCount: result.release.changes.length,
    catalogWrite: args.apply,
    releasePath: path.join(releasesDirectory, result.release.id + ".json"),
    planPath,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ status: "ERROR", message: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});

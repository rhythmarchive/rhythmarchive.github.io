import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import {
  AssetObject,
  Catalog,
  ReleaseManifest,
  Rendition,
  Resource,
  Variant,
  type Candidate,
  type Catalog as CatalogType,
  type PublishPlan,
  type ReleaseManifest as ReleaseManifestType,
  type UpdateBatch,
} from "./schema.js";
import { objectIdFromSha256 } from "./identity.js";
import { effectiveCandidateMetadata, effectiveCandidateResourceType, effectiveCandidateTitle, effectiveCandidateVariantKey } from "./review.js";
import { checkWorkspaceRawIntegrity, sha256File } from "./workspace.js";
import { validateCandidate, validateCatalog, validatePublishPlan, validatePublishPlanConsistency, validateReleaseManifestConsistency } from "./validation.js";
import { DEFAULT_CATALOG_PATH, DEFAULT_CATALOG_RELEASES_PATH, writeCatalogAndReleaseAtomic } from "./catalog.js";
import { StorageError, type StorageClient, IMMUTABLE_OBJECT_CACHE_CONTROL } from "./storage.js";

export type PublishProgressStage = "validate" | "check" | "upload" | "verify" | "catalog" | "release" | "complete";

export type PublishProgress = {
  stage: PublishProgressStage;
  completed: number;
  total: number;
  message: string;
};

export type PublishExecutorOptions = {
  plan: PublishPlan;
  manifest: ReleaseManifestType;
  batch: UpdateBatch;
  candidates: Candidate[];
  catalog: CatalogType;
  workspaceRoot: string;
  storage: StorageClient;
  catalogPath?: string;
  releasesDirectory?: string;
  now?: Date | string;
  onProgress?: (progress: PublishProgress) => void;
  writeCatalog?: (catalog: CatalogType) => Promise<void>;
  writeReleaseManifest?: (manifest: ReleaseManifestType) => Promise<void>;
};

export type PublishExecutionResult = {
  status: "published";
  catalog: CatalogType;
  releaseManifest: ReleaseManifestType;
  uploadedObjectKeys: string[];
  skippedObjectKeys: string[];
  catalogPath?: string;
  releaseManifestPath?: string;
};

export class PublishExecutionError extends Error {
  readonly code: "NOT_CONFIGURED" | "VALIDATION_FAILED" | "OBJECT_NOT_FOUND" | "OBJECT_VERIFY_FAILED" | "UPLOAD_FAILED" | "CATALOG_WRITE_FAILED" | "RELEASE_WRITE_FAILED";
  readonly objectKey?: string;

  constructor(code: PublishExecutionError["code"], message: string, objectKey?: string) {
    super(message);
    this.name = "PublishExecutionError";
    this.code = code;
    if (objectKey) this.objectKey = objectKey;
  }
}

function timestamp(value?: Date | string): string {
  const result = value instanceof Date ? value.toISOString() : value ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(result))) throw new Error("invalid publish timestamp");
  return result;
}

function inside(rootPath: string, targetPath: string): boolean {
  const root = path.resolve(rootPath);
  const target = path.resolve(targetPath);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return target === root || target.startsWith(prefix);
}

function finalFile(candidate: Candidate): Candidate["files"][number] {
  if (candidate.processing.processedFileId) {
    const processed = candidate.files.find((file) => file.id === candidate.processing.processedFileId);
    if (!processed || processed.role !== "processed-upscaled") throw new PublishExecutionError("VALIDATION_FAILED", `Candidate ${candidate.id} has an invalid processed file reference.`);
    return processed;
  }
  if (candidate.processing.requiresUpscale) throw new PublishExecutionError("VALIDATION_FAILED", `Candidate ${candidate.id} is missing its converted upscale result.`);
  const original = candidate.files.find((file) => file.role === "work-original");
  if (!original) throw new PublishExecutionError("VALIDATION_FAILED", `Candidate ${candidate.id} has no publishable work file.`);
  return original;
}

function activeCandidates(candidates: Candidate[], batch: UpdateBatch): Candidate[] {
  if (batch.candidateIds.length !== candidates.length || !batch.candidateIds.every((id) => candidates.some((candidate) => candidate.id === id))) {
    throw new PublishExecutionError("VALIDATION_FAILED", "UpdateBatch and Candidate state do not match.");
  }
  const active = candidates.filter((candidate) => candidate.status !== "REJECTED");
  for (const candidate of active) {
    if (candidate.status !== "READY" || candidate.batchId !== batch.id) throw new PublishExecutionError("VALIDATION_FAILED", "All active Candidates must be READY before publishing.");
    const validation = validateCandidate(candidate);
    if (!validation.success) throw new PublishExecutionError("VALIDATION_FAILED", "A Candidate failed publish validation.");
  }
  return active;
}

function candidateForObject(candidates: Candidate[], objectId: string): { candidate: Candidate; file: Candidate["files"][number] } | undefined {
  for (const candidate of candidates) {
    const file = finalFile(candidate);
    if (file.sha256 && objectIdFromSha256(file.sha256) === objectId) return { candidate, file };
  }
  return undefined;
}

function sourceRelativePath(candidate: Candidate, file: Candidate["files"][number]): string {
  return candidate.sourceEvidence.sourceRelativePath ?? file.relativePath;
}

function objectFromPlan(object: PublishPlan["objectsToCreate"][number], candidate: Candidate, file: Candidate["files"][number], now: string) {
  if (!file.width || !file.height || !file.sha256) throw new PublishExecutionError("VALIDATION_FAILED", `Object ${object.objectKey} is missing image metadata.`);
  return AssetObject.parse({
    catalogSchemaVersion: "1.0",
    id: object.objectId,
    sha256: object.sha256,
    mime: object.mime,
    extension: file.extension,
    sizeBytes: object.sizeBytes,
    width: file.width,
    height: file.height,
    alpha: file.alpha ?? "unknown",
    objectKey: object.objectKey,
    createdAt: now,
    provenance: [{
      sourceType: candidate.sourceEvidence.sourceType,
      sourceRelativePath: sourceRelativePath(candidate, file),
      sourceFilename: candidate.sourceEvidence.sourceFilename,
      sourceSha256: object.sha256,
      ...(candidate.sourceEvidence.sourceGameVersion ? { gameVersion: candidate.sourceEvidence.sourceGameVersion } : {}),
      evidence: candidate.suggestedMapping.evidence,
    }],
  });
}

function buildCatalog(options: { catalog: CatalogType; manifest: ReleaseManifestType; batch: UpdateBatch; candidates: Candidate[]; plan: PublishPlan; now: string }): CatalogType {
  const active = activeCandidates(options.candidates, options.batch);
  const resources = [...options.catalog.resources];
  const variants = [...options.catalog.variants];
  const renditions = [...options.catalog.renditions];
  const objects = [...options.catalog.objects];
  const objectIds = new Set(objects.map((object) => object.id));

  for (const objectToCreate of options.plan.objectsToCreate) {
    if (objectIds.has(objectToCreate.objectId)) continue;
    const match = candidateForObject(active, objectToCreate.objectId);
    if (!match) throw new PublishExecutionError("OBJECT_NOT_FOUND", `PublishPlan object ${objectToCreate.objectKey} has no workspace file.`, objectToCreate.objectKey);
    objects.push(objectFromPlan(objectToCreate, match.candidate, match.file, options.now));
    objectIds.add(objectToCreate.objectId);
  }

  for (const candidate of active) {
    const target = candidate.target;
    if (!target?.resourceId || !target.variantId || !target.renditionId) throw new PublishExecutionError("VALIDATION_FAILED", `Candidate ${candidate.id} has an incomplete publication target.`);
    const file = finalFile(candidate);
    if (!file.sha256) throw new PublishExecutionError("VALIDATION_FAILED", `Candidate ${candidate.id} has no verified SHA-256.`);
    const objectId = objectIdFromSha256(file.sha256);
    const downloadFilename = target.downloadFilename ?? candidate.naming.finalFilename;
    if (!downloadFilename) throw new PublishExecutionError("VALIDATION_FAILED", `Candidate ${candidate.id} has no download filename.`);

    const existingResource = resources.find((resource) => resource.id === target.resourceId);
    const title = effectiveCandidateTitle(candidate);
    const metadata = effectiveCandidateMetadata(candidate);
    if (existingResource) {
      const aliases = existingResource.aliases.some((alias) => alias.value === downloadFilename)
        ? existingResource.aliases
        : [...existingResource.aliases, { value: downloadFilename, kind: "filename" as const }];
      const nextResource = Resource.parse({
        ...existingResource,
        ...(title ? { title } : {}),
        aliases,
        metadata: Object.keys(metadata).length > 0 ? { ...existingResource.metadata, ...metadata } : existingResource.metadata,
        lifecycle: { ...existingResource.lifecycle, status: "published", updatedAt: options.now, publishedAt: existingResource.lifecycle.publishedAt ?? options.now },
      });
      resources[resources.indexOf(existingResource)] = nextResource;
    } else {
      resources.push(Resource.parse({
        catalogSchemaVersion: "1.0",
        id: target.resourceId,
        game: options.batch.game,
        resourceType: effectiveCandidateResourceType(candidate),
        ...(title ? { title } : {}),
        aliases: [{ value: downloadFilename, kind: "filename" }],
        externalIdentities: candidate.suggestedMapping.externalIdentities,
        metadata,
        relations: [],
        provenance: [{
          sourceType: candidate.sourceEvidence.sourceType,
          sourceRelativePath: sourceRelativePath(candidate, file),
          sourceFilename: candidate.sourceEvidence.sourceFilename,
          sourceSha256: file.sha256,
          ...(candidate.sourceEvidence.sourceGameVersion ? { gameVersion: candidate.sourceEvidence.sourceGameVersion } : {}),
          evidence: candidate.suggestedMapping.evidence,
          reviewedAt: options.now,
        }],
        lifecycle: { status: "published", createdAt: options.now, updatedAt: options.now, publishedAt: options.now },
      }));
    }

    const variantKey = effectiveCandidateVariantKey(candidate) ?? "default";
    const difficulty = ["PST", "PRS", "FTR", "BYD", "ETR"].includes(variantKey) ? variantKey as "PST" | "PRS" | "FTR" | "BYD" | "ETR" : undefined;
    const unresolved256 = variantKey.toLowerCase().includes("_256");
    const existingVariant = variants.find((variant) => variant.id === target.variantId);
    if (!existingVariant) {
      variants.push(Variant.parse({
        catalogSchemaVersion: "1.0",
        id: target.variantId,
        resourceId: target.resourceId,
        variantKey,
        kind: difficulty ? "difficulty" : candidate.suggestedMapping.variantKind ?? "default",
        semanticStatus: unresolved256 ? "unresolved" : "confirmed",
        ...(difficulty ? { difficulty } : {}),
        markers: { ...(unresolved256 ? { unresolved: ["_256_semantics"] } : { unresolved: [] }) },
      }));
    }

    const existingRendition = renditions.find((rendition) => rendition.id === target.renditionId);
    const renditionType = candidate.processing.requiresUpscale ? "upscaled" : "original";
    if (existingRendition) {
      renditions[renditions.indexOf(existingRendition)] = Rendition.parse({
        ...existingRendition,
        objectId,
        downloadFilename,
        displayFilename: undefined,
        publishable: true,
      });
    } else {
      let sourceRenditionId: string | undefined;
      if (renditionType === "upscaled") {
        sourceRenditionId = renditions.find((rendition) => rendition.variantId === target.variantId && rendition.renditionType === "original")?.id;
        if (!sourceRenditionId) throw new PublishExecutionError("VALIDATION_FAILED", `Upscaled Candidate ${candidate.id} has no original Rendition in the Catalog.`);
      }
      renditions.push(Rendition.parse({
        catalogSchemaVersion: "1.0",
        id: target.renditionId,
        variantId: target.variantId,
        renditionType,
        origin: renditionType === "original" ? "source" : "derived",
        publishable: true,
        objectId,
        downloadFilename,
        ...(sourceRenditionId ? { sourceRenditionId } : {}),
        generatedBy: renditionType === "upscaled" ? "converter" : "extractor",
        createdAt: options.now,
      }));
    }
  }

  const publishedManifest = ReleaseManifest.parse({ ...options.manifest, status: "published", notes: [...options.manifest.notes, "Published after ROS object upload and HEAD verification."] });
  const nextCatalog = Catalog.parse({
    ...options.catalog,
    generatedAt: options.now,
    resources,
    variants,
    renditions,
    objects,
    releaseManifestIds: [...new Set([...options.catalog.releaseManifestIds, publishedManifest.id])],
  });
  const validation = validateCatalog(nextCatalog);
  if (!validation.success) throw new PublishExecutionError("VALIDATION_FAILED", "The resulting Catalog failed consistency validation.");
  const manifestValidation = validateReleaseManifestConsistency(publishedManifest, nextCatalog);
  if (!manifestValidation.success) throw new PublishExecutionError("VALIDATION_FAILED", "The resulting ReleaseManifest does not match the Catalog.");
  return validation.data;
}

export async function executePublishPlan(options: PublishExecutorOptions): Promise<PublishExecutionResult> {
  const report = (progress: PublishProgress) => options.onProgress?.(progress);
  report({ stage: "validate", completed: 0, total: 1, message: "检查文件" });
  const planValidation = validatePublishPlan(options.plan);
  const catalogValidation = validateCatalog(options.catalog);
  const planConsistency = validatePublishPlanConsistency(options.plan, options.catalog);
  if (!planValidation.success || !catalogValidation.success || !planConsistency.success) {
    throw new PublishExecutionError("VALIDATION_FAILED", "PublishPlan or Catalog validation failed.");
  }
  if (options.plan.updateBatchId !== options.batch.id || options.manifest.updateBatchId !== options.batch.id) {
    throw new PublishExecutionError("VALIDATION_FAILED", "PublishPlan, ReleaseManifest and UpdateBatch do not match.");
  }
  const manifestConsistency = validateReleaseManifestConsistency(options.manifest, options.catalog);
  if (!manifestConsistency.success) throw new PublishExecutionError("VALIDATION_FAILED", "ReleaseManifest validation failed.");
  if (options.storage.status !== "READY") throw new PublishExecutionError("NOT_CONFIGURED", "ROS credentials are not configured.");
  const rawIssues = await checkWorkspaceRawIntegrity(options.workspaceRoot);
  if (rawIssues.length > 0) throw new PublishExecutionError("VALIDATION_FAILED", "Workspace raw integrity check failed.");
  const active = activeCandidates(options.candidates, options.batch);

  const fileByObjectId = new Map<string, { file: Candidate["files"][number]; candidate: Candidate }>();
  for (const candidate of active) {
    const file = finalFile(candidate);
    if (!file.sha256) throw new PublishExecutionError("VALIDATION_FAILED", "A final file has no SHA-256.");
    const absolutePath = path.resolve(options.workspaceRoot, file.relativePath);
    if (!inside(options.workspaceRoot, absolutePath)) throw new PublishExecutionError("VALIDATION_FAILED", "A final file path escapes the workspace.");
    const fileStats = await stat(absolutePath).catch(() => undefined);
    if (!fileStats || !fileStats.isFile() || fileStats.size !== file.sizeBytes || (await sha256File(absolutePath)).toLowerCase() !== file.sha256.toLowerCase()) {
      throw new PublishExecutionError("VALIDATION_FAILED", "A final file changed after the PublishPlan was generated.");
    }
    fileByObjectId.set(objectIdFromSha256(file.sha256), { file, candidate });
  }

  const uploadedObjectKeys: string[] = [];
  const skippedObjectKeys: string[] = [];
  report({ stage: "check", completed: 0, total: options.plan.objectsToCreate.length, message: "检查文件" });
  for (let index = 0; index < options.plan.objectsToCreate.length; index += 1) {
    const object = options.plan.objectsToCreate[index]!;
    const match = fileByObjectId.get(object.objectId);
    if (!match) throw new PublishExecutionError("OBJECT_NOT_FOUND", `PublishPlan object ${object.objectKey} has no final file.`, object.objectKey);
    const existing = await options.storage.verifyObject(object.objectKey, { sizeBytes: object.sizeBytes }).catch(() => undefined);
    if (!existing) throw new PublishExecutionError("UPLOAD_FAILED", "ROS object check failed.", object.objectKey);
    if (existing.exists) {
      if (!existing.verified) throw new PublishExecutionError("OBJECT_VERIFY_FAILED", "Existing ROS object failed size verification.", object.objectKey);
      skippedObjectKeys.push(object.objectKey);
      report({ stage: "check", completed: index + 1, total: options.plan.objectsToCreate.length, message: `跳过已存在对象 ${index + 1} / ${options.plan.objectsToCreate.length}` });
      continue;
    }
    report({ stage: "upload", completed: index, total: options.plan.objectsToCreate.length, message: `上传 ${index + 1} / ${options.plan.objectsToCreate.length}` });
    try {
      await options.storage.putObject({
        objectKey: object.objectKey,
        body: createReadStream(path.resolve(options.workspaceRoot, match.file.relativePath)),
        sizeBytes: object.sizeBytes,
        contentType: object.mime,
        cacheControl: IMMUTABLE_OBJECT_CACHE_CONTROL,
      });
      uploadedObjectKeys.push(object.objectKey);
    } catch (error) {
      if (error instanceof StorageError && error.code === "NOT_CONFIGURED") throw new PublishExecutionError("NOT_CONFIGURED", "ROS credentials are not configured.", object.objectKey);
      throw new PublishExecutionError("UPLOAD_FAILED", "ROS object upload failed.", object.objectKey);
    }
    report({ stage: "verify", completed: index + 1, total: options.plan.objectsToCreate.length, message: "验证" });
    const verification = await options.storage.verifyObject(object.objectKey, { sizeBytes: object.sizeBytes }).catch(() => undefined);
    if (!verification?.verified) throw new PublishExecutionError("OBJECT_VERIFY_FAILED", "Uploaded ROS object failed size verification.", object.objectKey);
  }

  const now = timestamp(options.now);
  const nextCatalog = buildCatalog({ catalog: options.catalog, manifest: options.manifest, batch: options.batch, candidates: active, plan: options.plan, now });
  const publishedManifest = ReleaseManifest.parse({ ...options.manifest, status: "published", notes: [...options.manifest.notes, "Published after ROS object upload and HEAD verification."] });
  const catalogPath = options.catalogPath ?? DEFAULT_CATALOG_PATH;
  const releaseDirectory = options.releasesDirectory ?? DEFAULT_CATALOG_RELEASES_PATH;
  const releaseManifestPath = path.join(releaseDirectory, `${publishedManifest.id}.json`);
  const hasCustomWriter = Boolean(options.writeCatalog || options.writeReleaseManifest);
  if (hasCustomWriter && (!options.writeCatalog || !options.writeReleaseManifest)) {
    throw new PublishExecutionError("VALIDATION_FAILED", "Catalog and ReleaseManifest writers must be provided together.");
  }
  report({ stage: "catalog", completed: 0, total: 1, message: "提交 Catalog 和 ReleaseManifest" });
  try {
    if (hasCustomWriter) {
      await options.writeCatalog!(nextCatalog);
      await options.writeReleaseManifest!(publishedManifest);
    } else {
      await writeCatalogAndReleaseAtomic(nextCatalog, publishedManifest, { catalogPath, releasesDirectory: releaseDirectory });
    }
  } catch { throw new PublishExecutionError("CATALOG_WRITE_FAILED", "Catalog and ReleaseManifest could not be committed."); }
  report({ stage: "catalog", completed: 1, total: 1, message: "更新 Catalog" });
  report({ stage: "complete", completed: 1, total: 1, message: "完成" });
  return {
    status: "published",
    catalog: nextCatalog,
    releaseManifest: publishedManifest,
    uploadedObjectKeys,
    skippedObjectKeys,
    catalogPath,
    releaseManifestPath,
  };
}

import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
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
import { effectiveCandidateMetadata, effectiveCandidateResourceType, effectiveCandidateTitle, effectiveCandidateVariantKey, isUpscaleEligible } from "./review.js";
import { checkWorkspaceRawIntegrity, sha256File } from "./workspace.js";
import { validateCandidate, validateCatalog, validatePublishPlan, validatePublishPlanConsistency, validateReleaseManifestConsistency } from "./validation.js";
import { DEFAULT_CATALOG_PATH, DEFAULT_CATALOG_RELEASES_PATH, writeCatalogAndReleaseAtomic } from "./catalog.js";
import { StorageError, type StorageClient, IMMUTABLE_OBJECT_CACHE_CONTROL } from "./storage.js";
import { readPreviewPlan, readPublishFileMap, type PreviewArtifact } from "./publish.js";

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
  const normalize = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  const root = normalize(path.resolve(rootPath));
  const target = normalize(path.resolve(targetPath));
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return target === root || target.startsWith(prefix);
}

async function realWorkspaceFile(workspaceRoot: string, absolutePath: string): Promise<string | undefined> {
  if (!inside(workspaceRoot, absolutePath)) return undefined;
  try {
    const [realRoot, realFile] = await Promise.all([realpath(workspaceRoot), realpath(absolutePath)]);
    return inside(realRoot, realFile) ? realFile : undefined;
  } catch {
    return undefined;
  }
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
  const active = candidates.filter((candidate) => candidate.status !== "REJECTED" && candidate.review.disposition === "active");
  for (const candidate of active) {
    if (candidate.status !== "READY" || candidate.batchId !== batch.id) throw new PublishExecutionError("VALIDATION_FAILED", "All active Candidates must be READY before publishing.");
    if (candidate.processing.requiresUpscale && !candidate.target?.sourceRenditionId) throw new PublishExecutionError("VALIDATION_FAILED", `Candidate ${candidate.id} has no stable original sourceRenditionId.`);
    if (candidate.processing.requiresUpscale && !isUpscaleEligible(batch.game, effectiveCandidateResourceType(candidate))) throw new PublishExecutionError("VALIDATION_FAILED", `Candidate ${candidate.id} is not eligible for upscale.`);
    const validation = validateCandidate(candidate);
    if (!validation.success) throw new PublishExecutionError("VALIDATION_FAILED", "A Candidate failed publish validation.");
  }
  return active;
}

function candidateForObject(candidates: Candidate[], objectId: string): { candidate: Candidate; file: Candidate["files"][number] } | undefined {
  for (const candidate of candidates) {
    const files = [
      ...candidate.files.filter((file) => file.role === "work-original" && file.availability === "present"),
      finalFile(candidate),
    ];
    for (const file of files) {
      if (file.sha256 && objectIdFromSha256(file.sha256) === objectId) return { candidate, file };
    }
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

function objectFromPreviewPlan(object: PublishPlan["objectsToCreate"][number], artifact: PreviewArtifact, candidate: Candidate, now: string) {
  return AssetObject.parse({
    catalogSchemaVersion: "1.0",
    id: object.objectId,
    sha256: object.sha256,
    mime: object.mime,
    extension: "webp",
    sizeBytes: object.sizeBytes,
    width: artifact.pixelWidth ?? artifact.width,
    height: artifact.height,
    alpha: "none",
    objectKey: object.objectKey,
    createdAt: now,
    provenance: [{
      sourceType: candidate.sourceEvidence.sourceType,
      sourceRelativePath: artifact.relativePath,
      sourceFilename: artifact.downloadFilename,
      sourceSha256: object.sha256,
      ...(candidate.sourceEvidence.sourceGameVersion ? { gameVersion: candidate.sourceEvidence.sourceGameVersion } : {}),
      evidence: [{ kind: "metadata", detail: `preview generated from ${artifact.sourceObjectId}`, confidence: "high" }],
    }],
  });
}

function buildCatalog(options: { catalog: CatalogType; manifest: ReleaseManifestType; batch: UpdateBatch; candidates: Candidate[]; plan: PublishPlan; previewArtifacts: PreviewArtifact[]; now: string }): CatalogType {
  const active = activeCandidates(options.candidates, options.batch);
  const resources = [...options.catalog.resources];
  const variants = [...options.catalog.variants];
  const renditions = [...options.catalog.renditions];
  const objects = [...options.catalog.objects];
  const objectIds = new Set(objects.map((object) => object.id));

  for (const objectToCreate of options.plan.objectsToCreate) {
    if (objectIds.has(objectToCreate.objectId)) continue;
    const match = candidateForObject(active, objectToCreate.objectId);
    if (match) {
      objects.push(objectFromPlan(objectToCreate, match.candidate, match.file, options.now));
      objectIds.add(objectToCreate.objectId);
      continue;
    }
    const preview = options.previewArtifacts.find((artifact) => artifact.objectId === objectToCreate.objectId);
    const previewCandidate = preview ? active.find((candidate) => candidate.id === preview.candidateId) : undefined;
    if (!preview || !previewCandidate) throw new PublishExecutionError("OBJECT_NOT_FOUND", `PublishPlan object ${objectToCreate.objectKey} has no workspace file.`, objectToCreate.objectKey);
    objects.push(objectFromPreviewPlan(objectToCreate, preview, previewCandidate, options.now));
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
    const sourceRenditionId = renditionType === "upscaled" ? target.sourceRenditionId ?? existingRendition?.sourceRenditionId : undefined;
    if (renditionType === "upscaled" && !sourceRenditionId) throw new PublishExecutionError("VALIDATION_FAILED", `Candidate ${candidate.id} has no stable original sourceRenditionId.`);
    if (existingRendition) {
      renditions[renditions.indexOf(existingRendition)] = Rendition.parse({
        ...existingRendition,
        renditionType,
        origin: renditionType === "original" ? "source" : "derived",
        sourceRenditionId,
        generatedBy: renditionType === "upscaled" ? "converter" : "extractor",
        objectId,
        downloadFilename,
        displayFilename: undefined,
        publishable: true,
      });
    } else {
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

    if (candidate.processing.requiresUpscale && target.sourceRenditionId) {
      const original = candidate.files.find((candidateFile) => candidateFile.role === "work-original" && candidateFile.availability === "present");
      if (!original?.sha256) throw new PublishExecutionError("VALIDATION_FAILED", `Candidate ${candidate.id} has no verified original companion.`);
      const originalObjectId = objectIdFromSha256(original.sha256);
      const existingOriginal = renditions.find((rendition) => rendition.id === target.sourceRenditionId);
      if (existingOriginal) {
        renditions[renditions.indexOf(existingOriginal)] = Rendition.parse({
          ...existingOriginal,
          renditionType: "original",
          origin: "source",
          publishable: true,
          objectId: originalObjectId,
          downloadFilename,
          displayFilename: undefined,
          sourceRenditionId: undefined,
          generatedBy: "extractor",
        });
      } else {
        renditions.push(Rendition.parse({
          catalogSchemaVersion: "1.0",
          id: target.sourceRenditionId,
          variantId: target.variantId,
          renditionType: "original",
          origin: "source",
          publishable: true,
          objectId: originalObjectId,
          downloadFilename,
          generatedBy: "extractor",
          createdAt: options.now,
        }));
      }
    }
  }

  for (const preview of options.previewArtifacts) {
    const existing = renditions.find((rendition) => rendition.id === preview.renditionId);
    if (existing) {
      renditions[renditions.indexOf(existing)] = Rendition.parse({
        ...existing,
        renditionType: preview.renditionType,
        origin: "derived",
        publishable: false,
        objectId: preview.objectId,
        downloadFilename: preview.downloadFilename,
        displayFilename: undefined,
        ...(preview.sourceRenditionId ? { sourceRenditionId: preview.sourceRenditionId } : {}),
        generatedBy: "thumbnailer",
      });
    } else {
      renditions.push(Rendition.parse({
        catalogSchemaVersion: "1.0",
        id: preview.renditionId,
        variantId: preview.variantId,
        renditionType: preview.renditionType,
        origin: "derived",
        publishable: false,
        objectId: preview.objectId,
        downloadFilename: preview.downloadFilename,
        ...(preview.sourceRenditionId ? { sourceRenditionId: preview.sourceRenditionId } : {}),
        generatedBy: "thumbnailer",
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
  if (!manifestValidation.success) throw new PublishExecutionError("VALIDATION_FAILED", `The resulting ReleaseManifest does not match the Catalog: ${manifestValidation.issues.map((item) => `${item.path} ${item.message}`).join("; ")}`);
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
  const previewArtifacts = (await readPreviewPlan(options.workspaceRoot)).filter((preview) => options.manifest.changes.some((change) => change.renditionId === preview.renditionId && change.objectId === preview.objectId));
  const publishFileEntries = await readPublishFileMap(options.workspaceRoot);
  const candidatesById = new Map(active.map((candidate) => [candidate.id, candidate]));
  const previewsByObjectId = new Map(previewArtifacts.map((preview) => [preview.objectId, preview]));

  type PublishFileLocation = {
    absolutePath: string;
    sizeBytes: number;
    mime: string;
    candidate?: Candidate;
    file?: Candidate["files"][number];
  };
  const fileByObjectId = new Map<string, PublishFileLocation>();
  const registerCandidateFile = async (candidate: Candidate, file: Candidate["files"][number]): Promise<void> => {
    if (!file.sha256) return;
    const lexicalPath = path.resolve(options.workspaceRoot, file.relativePath);
    const absolutePath = await realWorkspaceFile(options.workspaceRoot, lexicalPath);
    if (!absolutePath) throw new PublishExecutionError("VALIDATION_FAILED", "A publish file path escapes the workspace or resolves through a link.");
    const fileStats = await stat(absolutePath).catch(() => undefined);
    if (!fileStats || !fileStats.isFile() || fileStats.size !== file.sizeBytes || (await sha256File(absolutePath)).toLowerCase() !== file.sha256.toLowerCase()) {
      throw new PublishExecutionError("VALIDATION_FAILED", "A publish file changed after the PublishPlan was generated.");
    }
    fileByObjectId.set(objectIdFromSha256(file.sha256), { absolutePath, sizeBytes: file.sizeBytes, mime: file.mime, candidate, file });
  };
  for (const candidate of active) {
    await registerCandidateFile(candidate, finalFile(candidate));
    const original = candidate.files.find((file) => file.role === "work-original" && file.availability === "present");
    if (original) await registerCandidateFile(candidate, original);
  }
  for (const entry of publishFileEntries) {
    const candidate = candidatesById.get(entry.candidateId);
    if (!candidate) throw new PublishExecutionError("VALIDATION_FAILED", `Publish file entry references unknown Candidate ${entry.candidateId}.`);
    const preview = entry.kind === "preview" ? previewsByObjectId.get(entry.objectId) : undefined;
    const file = entry.kind === "candidate" ? candidate.files.find((candidateFile) => candidateFile.relativePath === entry.relativePath && candidateFile.availability === "present") : undefined;
    const expectedSize = preview?.sizeBytes ?? file?.sizeBytes;
    const expectedSha = preview?.sha256 ?? file?.sha256;
    const expectedMime = preview?.mime ?? file?.mime;
    if (!expectedSize || !expectedSha || !expectedMime) throw new PublishExecutionError("VALIDATION_FAILED", `Publish file entry ${entry.relativePath} is incomplete.`);
    if (entry.objectId.toLowerCase() !== objectIdFromSha256(expectedSha).toLowerCase()) throw new PublishExecutionError("VALIDATION_FAILED", `Publish file entry ${entry.relativePath} does not match its Object identity.`);
    const lexicalPath = path.resolve(options.workspaceRoot, entry.relativePath);
    const absolutePath = await realWorkspaceFile(options.workspaceRoot, lexicalPath);
    if (!absolutePath) throw new PublishExecutionError("VALIDATION_FAILED", "A publish file path escapes the workspace or resolves through a link.");
    const fileStats = await stat(absolutePath).catch(() => undefined);
    if (!fileStats || !fileStats.isFile() || fileStats.size !== expectedSize || (await sha256File(absolutePath)).toLowerCase() !== expectedSha.toLowerCase()) {
      throw new PublishExecutionError("VALIDATION_FAILED", "A publish file changed after the PublishPlan was generated.");
    }
    fileByObjectId.set(entry.objectId, { absolutePath, sizeBytes: expectedSize, mime: expectedMime, candidate, ...(file ? { file } : {}) });
  }

  const uploadedObjectKeys: string[] = [];
  const skippedObjectKeys: string[] = [];
  report({ stage: "check", completed: 0, total: options.plan.objectsToCreate.length, message: "检查文件" });
  for (let index = 0; index < options.plan.objectsToCreate.length; index += 1) {
    const object = options.plan.objectsToCreate[index]!;
    const match = fileByObjectId.get(object.objectId);
    if (!match) throw new PublishExecutionError("OBJECT_NOT_FOUND", `PublishPlan object ${object.objectKey} has no final file.`, object.objectKey);
    if (match.sizeBytes !== object.sizeBytes || match.mime !== object.mime) throw new PublishExecutionError("VALIDATION_FAILED", "Publish file metadata does not match the PublishPlan.", object.objectKey);
    const existing = await options.storage.verifyObject(object.objectKey, { sizeBytes: object.sizeBytes, sha256: object.sha256 }).catch(() => undefined);
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
        body: createReadStream(match.absolutePath),
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
    const verification = await options.storage.verifyObject(object.objectKey, { sizeBytes: object.sizeBytes, sha256: object.sha256 }).catch(() => undefined);
    if (!verification?.verified) throw new PublishExecutionError("OBJECT_VERIFY_FAILED", "Uploaded ROS object failed size verification.", object.objectKey);
  }

  const now = timestamp(options.now);
  const nextCatalog = buildCatalog({ catalog: options.catalog, manifest: options.manifest, batch: options.batch, candidates: active, plan: options.plan, previewArtifacts, now });
  const publishedManifest = ReleaseManifest.parse({ ...options.manifest, status: "published", notes: [...options.manifest.notes, "Published after ROS object upload and HEAD verification."] });
  const catalogPath = options.catalogPath ?? DEFAULT_CATALOG_PATH;
  const releaseDirectory = options.releasesDirectory ?? DEFAULT_CATALOG_RELEASES_PATH;
  const releaseManifestPath = path.join(releaseDirectory, `${publishedManifest.id}.json`);
  report({ stage: "catalog", completed: 0, total: 1, message: "提交 Catalog 和 ReleaseManifest" });
  try {
    await writeCatalogAndReleaseAtomic(nextCatalog, publishedManifest, { catalogPath, releasesDirectory: releaseDirectory });
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

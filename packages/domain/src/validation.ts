import { z } from "zod";
import {
  AssetObject,
  Candidate,
  CandidateManifest,
  Catalog,
  PublishPlan,
  ReleaseManifest,
  Rendition,
  Resource,
  CATALOG_SCHEMA_VERSION,
  PUBLISH_PLAN_SCHEMA_VERSION,
  RELEASE_SCHEMA_VERSION,
  WORKSPACE_SCHEMA_VERSION,
  RawManifest,
  ReviewLog,
  WorkspaceScanSnapshot,
  UpdateBatch,
  Variant,
  type Candidate as CandidateType,
  type Catalog as CatalogType,
  type PublishPlan as PublishPlanType,
  type ReleaseManifest as ReleaseManifestType,
} from "./schema.js";

export type ValidationIssue = { path: string; message: string };
export type ValidationResult<T> = { success: true; data: T } | { success: false; issues: ValidationIssue[] };

function issuesFrom(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({ path: issue.path.join(".") || "$", message: issue.message }));
}

function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): ValidationResult<z.output<S>> {
  const result = schema.safeParse(value);
  return result.success ? result : { success: false, issues: issuesFrom(result.error) };
}

export const validateResource = (value: unknown) => parse(Resource, value);
export function validateVariant(value: unknown) {
  const parsed = parse(Variant, value);
  if (!parsed.success) return parsed;
  const issues: ValidationIssue[] = [];
  if (parsed.data.kind === "difficulty" && !parsed.data.difficulty) issues.push(issue("difficulty", "difficulty Variant requires a difficulty code"));
  if (parsed.data.markers.unresolved.includes("_256_semantics") && parsed.data.semanticStatus !== "unresolved") issues.push(issue("semanticStatus", "_256 semantics must remain unresolved until human review"));
  return appendCrossIssues(parsed, issues);
}

export function validateRendition(value: unknown) {
  const parsed = parse(Rendition, value);
  if (!parsed.success) return parsed;
  const issues: ValidationIssue[] = [];
  if (parsed.data.renditionType === "original" && (parsed.data.origin !== "source" || parsed.data.sourceRenditionId)) {
    issues.push(issue("origin", "original rendition must be a source rendition without a sourceRenditionId"));
  }
  if (parsed.data.renditionType === "upscaled" && (parsed.data.origin !== "derived" || !parsed.data.sourceRenditionId)) issues.push(issue("sourceRenditionId", "upscaled rendition must be derived from an original rendition"));
  if (parsed.data.renditionType.startsWith("thumbnail") && (parsed.data.origin !== "derived" || parsed.data.publishable)) issues.push(issue("publishable", "thumbnail renditions are derived-only"));
  if ((parsed.data.renditionType === "original" || parsed.data.renditionType === "upscaled") && !parsed.data.publishable) issues.push(issue("publishable", `${parsed.data.renditionType} rendition must be publishable`));
  if (parsed.data.renditionType === "other-derived" && parsed.data.publishable) issues.push(issue("publishable", "other-derived renditions are staging-only"));
  if (parsed.data.renditionType !== "original" && parsed.data.origin !== "derived") issues.push(issue("origin", "non-original renditions must be derived"));
  return appendCrossIssues(parsed, issues);
}

export function validateObject(value: unknown) {
  const parsed = parse(AssetObject, value);
  if (!parsed.success) return parsed;
  const issues: ValidationIssue[] = [];
  if (parsed.data.id.toLowerCase() !== `sha256:${parsed.data.sha256.toLowerCase()}`) issues.push(issue("id", "Object id must equal sha256"));
  if (parsed.data.objectKey.split("/")[1]?.toLowerCase() !== parsed.data.sha256.toLowerCase()) issues.push(issue("objectKey", "objectKey must contain the Object sha256"));
  return appendCrossIssues(parsed, issues);
}

export function validateUpdateBatch(value: unknown) {
  const parsed = parse(UpdateBatch, value);
  if (!parsed.success) return parsed;
  const issues: ValidationIssue[] = [];
  if (parsed.data.baseApk.role !== "base") issues.push(issue("baseApk.role", "baseApk role must be base"));
  if (parsed.data.targetApk.role !== "target") issues.push(issue("targetApk.role", "targetApk role must be target"));
  if (parsed.data.candidateCount !== parsed.data.candidateIds.length) issues.push(issue("candidateCount", "candidateCount must equal candidateIds length in the JSON batch manifest"));
  for (const [name, progress] of Object.entries({
    filenameReviewProgress: parsed.data.filenameReviewProgress,
    namingEditProgress: parsed.data.namingEditProgress,
    metadataReviewProgress: parsed.data.metadataReviewProgress,
    confirmationProgress: parsed.data.confirmationProgress,
    upscaleProgress: parsed.data.upscaleProgress,
    finalReviewProgress: parsed.data.finalReviewProgress,
  })) {
    if (progress.completed + progress.blocked > progress.total) issues.push(issue(name, "completed + blocked cannot exceed total"));
  }
  return appendCrossIssues(parsed, issues);
}

export function validateCandidate(value: unknown) {
  const parsed = parse(Candidate, value);
  if (!parsed.success) return parsed;
  const candidate = parsed.data;
  const issues: ValidationIssue[] = [];
  const fileIds = new Set<string>();
  for (const [index, file] of candidate.files.entries()) {
    if (fileIds.has(file.id)) issues.push(issue(`files.${index}.id`, `duplicate CandidateFile id ${file.id}`));
    fileIds.add(file.id);
    if (file.candidateId !== candidate.id) issues.push(issue(`files.${index}.candidateId`, "CandidateFile must belong to its Candidate"));
  }
  const filesById = new Map(candidate.files.map((file) => [file.id, file]));
  const processing = candidate.processing;
  if (processing.inputFileId && !fileIds.has(processing.inputFileId)) issues.push(issue("processing.inputFileId", "must reference a CandidateFile"));
  for (const outputId of processing.optimizationMatches.map((match) => match.outputFileId)) if (!fileIds.has(outputId)) issues.push(issue("processing.optimizationMatches", `unknown output CandidateFile ${outputId}`));
  if (processing.selectedOutputFileId && !fileIds.has(processing.selectedOutputFileId)) issues.push(issue("processing.selectedOutputFileId", "must reference a CandidateFile"));
  if (processing.processedFileId && !fileIds.has(processing.processedFileId)) issues.push(issue("processing.processedFileId", "must reference a CandidateFile"));
  if (processing.inputFileId && !["work-original", "upscale-input"].includes(filesById.get(processing.inputFileId)?.role ?? "")) issues.push(issue("processing.inputFileId", "upscale input must reference a work-original or upscale-input file"));
  if (processing.selectedOutputFileId && filesById.get(processing.selectedOutputFileId)?.role !== "upscale-output") issues.push(issue("processing.selectedOutputFileId", "selected optimization output must reference an upscale-output file"));
  if (processing.processedFileId && filesById.get(processing.processedFileId)?.role !== "processed-upscaled") issues.push(issue("processing.processedFileId", "processed file must reference a processed-upscaled file"));
  if (!processing.requiresUpscale && !["not-required", "ready", "blocked"].includes(processing.state)) issues.push(issue("processing.state", "a Candidate that does not require upscale cannot be in an upscale processing state"));
  if (processing.requiresUpscale && processing.state === "not-required") issues.push(issue("processing.state", "a Candidate that requires upscale cannot be marked not-required"));
  if (processing.state === "upscale-converted" && !processing.processedFileId) issues.push(issue("processing.processedFileId", "upscale-converted Candidate requires a processed file"));
  if (processing.state === "upscale-converted" && !processing.conversion) issues.push(issue("processing.conversion", "upscale-converted Candidate requires a conversion record"));
  if (candidate.status === "READY" && (candidate.review.state !== "approved" || !candidate.target?.resourceId || !candidate.target.variantId || !candidate.target.renditionId)) issues.push(issue("status", "READY Candidate requires approved review and target Resource/Variant/Rendition"));
  if (candidate.status === "READY" && candidate.processing.state !== "ready") issues.push(issue("processing.state", "READY Candidate requires processing.state=ready"));
  if (candidate.status === "READY" && candidate.processing.optimizationMatches.some((match) => match.state !== "matched")) issues.push(issue("processing.optimizationMatches", "READY Candidate cannot retain unresolved upscale ambiguity"));
  if (candidate.status === "READY" && candidate.processing.requiresUpscale && !candidate.processing.processedFileId) issues.push(issue("status", "READY upscaled Candidate requires a processed file"));
  if (candidate.status === "READY" && candidate.reviewRequirements.identityReviewRequired && !candidate.target?.resourceId && !candidate.review.overrides.resourceId) {
    issues.push(issue("reviewRequirements.identityReviewRequired", "READY Candidate still requires identity resolution"));
  }
  if (candidate.status === "READY" && candidate.reviewRequirements.metadataReviewRequired && !candidate.review.overrides.title && !candidate.review.overrides.artist && !candidate.review.overrides.metadata) {
    issues.push(issue("reviewRequirements.metadataReviewRequired", "READY Candidate still requires metadata review"));
  }
  if (candidate.status === "READY" && candidate.processing.requiresUpscale && (!candidate.processing.selectedOutputFileId || !candidate.processing.optimizationMatches.some((match) => match.outputFileId === candidate.processing.selectedOutputFileId && match.state === "matched"))) {
    issues.push(issue("processing.selectedOutputFileId", "READY upscaled Candidate requires a selected attempt represented by a matched optimization entry"));
  }
  if (candidate.status === "REJECTED" && candidate.review.decision !== "reject") issues.push(issue("review.decision", "REJECTED Candidate requires reject decision"));
  return appendCrossIssues(parsed, issues);
}
export function validateCandidateManifest(value: unknown) {
  const parsed = parse(CandidateManifest, value);
  if (!parsed.success) return parsed;
  const issues: ValidationIssue[] = [];
  if (parsed.data.candidateCount !== parsed.data.candidateIds.length) issues.push(issue("candidateCount", "candidateCount must equal candidateIds length"));
  if (new Set(parsed.data.candidateIds).size !== parsed.data.candidateIds.length) issues.push(issue("candidateIds", "candidateIds must be unique"));
  return appendCrossIssues(parsed, issues);
}
export function validateRawManifest(value: unknown) {
  return parse(RawManifest, value);
}

export function validateReviewLog(value: unknown) {
  return parse(ReviewLog, value);
}

export function validateWorkspaceScanSnapshot(value: unknown) {
  return parse(WorkspaceScanSnapshot, value);
}

export function validateReleaseManifest(value: unknown) {
  const parsed = parse(ReleaseManifest, value);
  if (!parsed.success) return parsed;
  const issues = scanForPublishedPathIssues(parsed.data);
  // Phase 2A allowed an empty compatibility field. Non-empty ignored data is
  // now a local ReviewLog concern and must not cross the release boundary.
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const ignored = (value as Record<string, unknown>).ignoredCandidates;
    if (Array.isArray(ignored) && ignored.length > 0) issues.push(issue("ignoredCandidates", "ignored Candidates belong in ReviewLog, not ReleaseManifest"));
  }
  return appendCrossIssues(parsed, issues);
}

export function validatePublishPlan(value: unknown) {
  const parsed = parse(PublishPlan, value);
  if (!parsed.success) return parsed;
  const issues = scanForPublishedPathIssues(parsed.data);
  if (!parsed.data.dryRun) issues.push(issue("dryRun", "Phase 2A PublishPlan validation only accepts dry-run plans"));
  return appendCrossIssues(parsed, issues);
}

function issue(path: string, message: string): ValidationIssue {
  return { path, message };
}

function appendCrossIssues<T>(parsed: ValidationResult<T>, issues: ValidationIssue[]): ValidationResult<T> {
  if (!parsed.success) return { success: false, issues: [...parsed.issues, ...issues] };
  return issues.length > 0 ? { success: false, issues } : parsed;
}

function isLocalPath(value: unknown): boolean {
  return typeof value === "string" && (/^[a-zA-Z]:[\\/]/.test(value) || /^[a-zA-Z]:[^\\/]/.test(value) || /^\\\\/.test(value) || value.startsWith("/"));
}

function isForbiddenPublishedPath(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return isLocalPath(value) || value.split(/[\\/]+/).some((segment) => segment.toLowerCase() === ".runtime");
}

function scanForPublishedPathIssues(value: unknown, path = "$"): ValidationIssue[] {
  if (typeof value === "string") return isForbiddenPublishedPath(value) ? [issue(path, "published data must not contain a local absolute/drive-relative path or .runtime path")] : [];
  if (Array.isArray(value)) return value.flatMap((child, index) => scanForPublishedPathIssues(child, `${path}.${index}`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, child]) => scanForPublishedPathIssues(child, `${path}.${key}`));
  return [];
}

export function validateCatalog(value: unknown): ValidationResult<CatalogType> {
  const parsed = parse(Catalog, value);
  if (!parsed.success) return parsed;
  const catalog = parsed.data;
  const issues: ValidationIssue[] = [];
  const resourceIds = new Set<string>();
  const variantIds = new Set<string>();
  const renditionIds = new Set<string>();
  const objectIds = new Set<string>();

  for (const resource of catalog.resources) {
    if (resourceIds.has(resource.id)) issues.push(issue("resources", `duplicate Resource id ${resource.id}`));
    resourceIds.add(resource.id);
    for (const relation of resource.relations) {
      if (!catalog.resources.some((candidate) => candidate.id === relation.targetResourceId)) {
        issues.push(issue(`resources.${resource.id}.relations`, `unknown relation target ${relation.targetResourceId}`));
      }
    }
  }
  for (const variant of catalog.variants) {
    if (variantIds.has(variant.id)) issues.push(issue("variants", `duplicate Variant id ${variant.id}`));
    variantIds.add(variant.id);
    if (!resourceIds.has(variant.resourceId)) issues.push(issue(`variants.${variant.id}.resourceId`, "must reference an existing Resource"));
    if (variant.kind === "difficulty" && !variant.difficulty) issues.push(issue(`variants.${variant.id}.difficulty`, "difficulty Variant requires difficulty or an explicit unknown/manual kind"));
    if (variant.markers.unresolved.includes("_256_semantics") && variant.semanticStatus !== "unresolved") {
      issues.push(issue(`variants.${variant.id}.semanticStatus`, "_256 fixture must remain unresolved until reviewed"));
    }
  }
  for (const rendition of catalog.renditions) {
    if (renditionIds.has(rendition.id)) issues.push(issue("renditions", `duplicate Rendition id ${rendition.id}`));
    renditionIds.add(rendition.id);
    if (!variantIds.has(rendition.variantId)) issues.push(issue(`renditions.${rendition.id}.variantId`, "must reference an existing Variant"));
    if (!objectIds.has(rendition.objectId) && !catalog.objects.some((object) => object.id === rendition.objectId)) {
      issues.push(issue(`renditions.${rendition.id}.objectId`, "must reference an existing Object"));
    }
    const expectedDerived = rendition.renditionType.startsWith("thumbnail") || rendition.renditionType === "other-derived" || rendition.renditionType === "upscaled";
    if (expectedDerived && rendition.origin !== "derived") issues.push(issue(`renditions.${rendition.id}.origin`, `${rendition.renditionType} must be a derived rendition`));
    if (rendition.renditionType === "original" && (rendition.origin !== "source" || rendition.sourceRenditionId)) {
      issues.push(issue(`renditions.${rendition.id}.origin`, "original rendition must be a source rendition without a sourceRenditionId"));
    }
    if ((rendition.renditionType === "original" || rendition.renditionType === "upscaled") && !rendition.publishable) issues.push(issue(`renditions.${rendition.id}.publishable`, `${rendition.renditionType} rendition must be publishable`));
    if (rendition.renditionType === "other-derived" && rendition.publishable) issues.push(issue(`renditions.${rendition.id}.publishable`, "other-derived renditions are staging-only"));
    if (rendition.renditionType.startsWith("thumbnail") && rendition.publishable) issues.push(issue(`renditions.${rendition.id}.publishable`, "thumbnail renditions are derived-only"));
    if (rendition.renditionType === "upscaled" && !rendition.sourceRenditionId) issues.push(issue(`renditions.${rendition.id}.sourceRenditionId`, "upscaled rendition must point to its original rendition"));
  }
  for (const object of catalog.objects) {
    if (objectIds.has(object.id)) issues.push(issue("objects", `duplicate Object id ${object.id}`));
    objectIds.add(object.id);
    if (object.id.toLowerCase() !== `sha256:${object.sha256.toLowerCase()}`) issues.push(issue(`objects.${object.id}.id`, "Object id must equal sha256"));
    const objectKeyDigest = object.objectKey.split("/")[1]?.toLowerCase();
    if (objectKeyDigest !== object.sha256.toLowerCase()) issues.push(issue(`objects.${object.id}.objectKey`, "objectKey must contain the Object sha256"));
  }
  for (const rendition of catalog.renditions) {
    if (!objectIds.has(rendition.objectId)) issues.push(issue(`renditions.${rendition.id}.objectId`, "must reference an Object declared in the catalog"));
    if (rendition.sourceRenditionId && !renditionIds.has(rendition.sourceRenditionId)) issues.push(issue(`renditions.${rendition.id}.sourceRenditionId`, "must reference an existing Rendition"));
    if (rendition.sourceRenditionId) {
      const source = catalog.renditions.find((candidate) => candidate.id === rendition.sourceRenditionId);
      if (source && source.variantId !== rendition.variantId) issues.push(issue(`renditions.${rendition.id}.sourceRenditionId`, "derived rendition source must be in the same Variant"));
      if (source && rendition.renditionType === "upscaled" && source.renditionType !== "original") {
        issues.push(issue(`renditions.${rendition.id}.sourceRenditionId`, "upscaled rendition source must be an original rendition"));
      }
    }
  }
  issues.push(...scanForPublishedPathIssues(catalog));
  return appendCrossIssues(parsed, issues);
}

export function validateReleaseManifestConsistency(manifestValue: unknown, catalogValue: unknown): ValidationResult<ReleaseManifestType> {
  const manifest = validateReleaseManifest(manifestValue);
  const catalog = validateCatalog(catalogValue);
  if (!manifest.success || !catalog.success) {
    return { success: false, issues: [...(!manifest.success ? manifest.issues : []), ...(!catalog.success ? catalog.issues : [])] };
  }
  const issues: ValidationIssue[] = [];
  const resourceIds = new Set(catalog.data.resources.map((item) => item.id));
  const variantIds = new Set(catalog.data.variants.map((item) => item.id));
  const renditionIds = new Set(catalog.data.renditions.map((item) => item.id));
  const objectIds = new Set(catalog.data.objects.map((item) => item.id));
  const variantsById = new Map(catalog.data.variants.map((item) => [item.id, item]));
  const renditionsById = new Map(catalog.data.renditions.map((item) => [item.id, item]));
  const affected = new Set(manifest.data.affectedResourceIds);
  const plannedResourceIds = new Set(manifest.data.changes.filter((change) => change.changeType === "added-resource" && change.resourceId).map((change) => change.resourceId!));
  const plannedVariantIds = new Set(manifest.data.changes.filter((change) => change.changeType === "added-variant" && change.variantId).map((change) => change.variantId!));
  const plannedRenditionIds = new Set(manifest.data.changes.filter((change) => change.changeType === "added-rendition" && change.renditionId).map((change) => change.renditionId!));
  const plannedObjectIds = new Set(manifest.data.changes.filter((change) => (change.changeType === "added-rendition" || change.changeType === "replaced-rendition") && change.objectId).map((change) => change.objectId!));
  for (const resourceId of affected) if (!resourceIds.has(resourceId) && !plannedResourceIds.has(resourceId)) issues.push(issue("affectedResourceIds", `unknown Resource ${resourceId}`));
  for (const change of manifest.data.changes) {
    if (change.resourceId && !resourceIds.has(change.resourceId) && !plannedResourceIds.has(change.resourceId)) issues.push(issue("changes", `unknown Resource ${change.resourceId}`));
    if (change.variantId && !variantIds.has(change.variantId) && !plannedVariantIds.has(change.variantId)) issues.push(issue("changes", `unknown Variant ${change.variantId}`));
    const renditionCanBePlanned = change.changeType === "added-rendition";
    if (change.renditionId && !renditionIds.has(change.renditionId) && !(renditionCanBePlanned && plannedRenditionIds.has(change.renditionId))) issues.push(issue("changes", `unknown Rendition ${change.renditionId}`));
    if (change.objectId && !objectIds.has(change.objectId) && !plannedObjectIds.has(change.objectId)) issues.push(issue("changes", `unknown Object ${change.objectId}`));
    if (change.previousObjectId && !objectIds.has(change.previousObjectId)) issues.push(issue("changes", `unknown previous Object ${change.previousObjectId}`));
    const changedVariant = change.variantId ? variantsById.get(change.variantId) : undefined;
    const changedRendition = change.renditionId ? renditionsById.get(change.renditionId) : undefined;
    if (change.resourceId && changedVariant && changedVariant.resourceId !== change.resourceId) issues.push(issue("changes", "Resource and Variant references must agree"));
    if (change.variantId && changedRendition && changedRendition.variantId !== change.variantId) issues.push(issue("changes", "Variant and Rendition references must agree"));
    if (change.renditionId && changedRendition && change.objectId && changedRendition.objectId !== change.objectId && change.changeType !== "replaced-rendition") issues.push(issue("changes", "Rendition and Object references must agree"));
    if (change.changeType === "added-resource" && (!change.resourceId || !affected.has(change.resourceId))) issues.push(issue("changes", "added-resource must identify an affected Resource"));
    if (change.changeType === "added-variant" && (!change.resourceId || !change.variantId || !affected.has(change.resourceId))) issues.push(issue("changes", "added-variant must identify an affected Resource and Variant"));
    if (change.changeType === "added-rendition" && (!change.resourceId || !change.variantId || !change.renditionId || !change.objectId || !affected.has(change.resourceId))) issues.push(issue("changes", "added-rendition must identify affected Resource, Variant, Rendition and Object"));
    if (change.changeType === "replaced-rendition" && (!change.resourceId || !change.variantId || !change.renditionId || !change.objectId || !change.previousObjectId || change.objectId === change.previousObjectId)) issues.push(issue("changes", "replaced-rendition must identify different previous and new Objects"));
    if (change.changeType === "metadata-changed" && !change.resourceId) issues.push(issue("changes", "metadata-changed must identify a Resource"));
    if (change.changeType === "alias-added" && !change.resourceId) issues.push(issue("changes", "alias-added must identify a Resource"));
  }
  for (const entry of manifest.data.publishedRenditions) {
    const addedRendition = manifest.data.changes.find((change) => change.changeType === "added-rendition" && change.resourceId === entry.resourceId && change.variantId === entry.variantId && change.renditionId === entry.renditionId);
    const resourceKnown = resourceIds.has(entry.resourceId) || plannedResourceIds.has(entry.resourceId);
    const variantKnown = variantIds.has(entry.variantId) || plannedVariantIds.has(entry.variantId);
    const renditionKnown = renditionIds.has(entry.renditionId) || plannedRenditionIds.has(entry.renditionId);
    const objectKnown = objectIds.has(entry.objectId) || plannedObjectIds.has(entry.objectId);
    if (!resourceKnown || !variantKnown || !renditionKnown || !objectKnown) {
      issues.push(issue("publishedRenditions", `published rendition entry ${entry.renditionId} has an unresolved reference`));
    }
    if (!renditionIds.has(entry.renditionId) && (!addedRendition || addedRendition.objectId !== entry.objectId)) {
      issues.push(issue("publishedRenditions", `new Rendition ${entry.renditionId} must have a matching added-rendition change`));
    }
    if (!variantIds.has(entry.variantId) && !manifest.data.changes.some((change) => change.changeType === "added-variant" && change.variantId === entry.variantId && change.resourceId === entry.resourceId)) {
      issues.push(issue("publishedRenditions", `new Variant ${entry.variantId} must have a matching added-variant change`));
    }
    if (!resourceIds.has(entry.resourceId) && !plannedResourceIds.has(entry.resourceId)) {
      issues.push(issue("publishedRenditions", `new Resource ${entry.resourceId} must have a matching added-resource change`));
    }
    const variant = variantsById.get(entry.variantId);
    const rendition = renditionsById.get(entry.renditionId);
    const replacement = manifest.data.changes.find((change) => change.changeType === "replaced-rendition" && change.renditionId === entry.renditionId && change.objectId === entry.objectId);
    if (variant && variant.resourceId !== entry.resourceId) issues.push(issue("publishedRenditions", `Variant ${entry.variantId} does not belong to Resource ${entry.resourceId}`));
    if (rendition && rendition.variantId !== entry.variantId) issues.push(issue("publishedRenditions", `Rendition ${entry.renditionId} does not belong to Variant ${entry.variantId}`));
    if (rendition && rendition.objectId !== entry.objectId && !replacement) issues.push(issue("publishedRenditions", `Rendition ${entry.renditionId} does not reference Object ${entry.objectId}`));
    if (rendition && !rendition.publishable) issues.push(issue("publishedRenditions", `Rendition ${entry.renditionId} is not publishable`));
  }
  return appendCrossIssues(manifest, issues);
}

export function validatePublishPlanConsistency(planValue: unknown, catalogValue: unknown): ValidationResult<PublishPlanType> {
  const plan = validatePublishPlan(planValue);
  const catalog = validateCatalog(catalogValue);
  if (!plan.success || !catalog.success) {
    return { success: false, issues: [...(!plan.success ? plan.issues : []), ...(!catalog.success ? catalog.issues : [])] };
  }
  const issues: ValidationIssue[] = [];
  const existingObjects = new Set(catalog.data.objects.map((object) => object.id));
  const objectsToCreate = new Set(plan.data.objectsToCreate.map((object) => object.objectId));
  const gcIds = new Set(plan.data.objectsEligibleForGC.map((object) => object.objectId));
  const existingResources = new Set(catalog.data.resources.map((resource) => resource.id));
  const existingVariants = new Set(catalog.data.variants.map((variant) => variant.id));
  const existingRenditions = new Set(catalog.data.renditions.map((rendition) => rendition.id));
  const replacedRenditions = new Map(plan.data.catalogMutations.filter((mutation) => mutation.operation === "replace-rendition" && mutation.renditionId && mutation.previousObjectId).map((mutation) => [mutation.renditionId!, mutation.previousObjectId!]));
  const mutationIds = new Set<string>();
  const plannedResources = new Set(plan.data.catalogMutations.filter((mutation) => mutation.operation === "create-resource" && mutation.resourceId).map((mutation) => mutation.resourceId!));
  const plannedVariants = new Set(plan.data.catalogMutations.filter((mutation) => mutation.operation === "create-variant" && mutation.variantId).map((mutation) => mutation.variantId!));
  const plannedRenditions = new Set(plan.data.catalogMutations.filter((mutation) => mutation.operation === "create-rendition" && mutation.renditionId).map((mutation) => mutation.renditionId!));
  for (const object of plan.data.objectsToCreate) {
    if (object.objectId.toLowerCase() !== `sha256:${object.sha256.toLowerCase()}`) issues.push(issue("objectsToCreate", `Object ${object.objectId} does not match sha256`));
    if (object.objectKey.split("/")[1]?.toLowerCase() !== object.sha256.toLowerCase()) issues.push(issue("objectsToCreate", `Object ${object.objectId} objectKey does not contain its sha256`));
    if (objectsToCreate.has(object.objectId) && plan.data.objectsToCreate.filter((item) => item.objectId === object.objectId).length > 1) issues.push(issue("objectsToCreate", `Object ${object.objectId} is listed more than once`));
    if (gcIds.has(object.objectId)) issues.push(issue("objectsEligibleForGC", `Object ${object.objectId} cannot be created and GC-eligible in one plan`));
  }
  for (const mutation of plan.data.catalogMutations) {
    for (const [field, id] of [["resourceId", mutation.resourceId], ["variantId", mutation.variantId], ["renditionId", mutation.renditionId]] as const) {
      if (!id) continue;
      const key = `${field}:${mutation.operation}:${id}`;
      if (mutationIds.has(key)) issues.push(issue("catalogMutations", `mutation ${key} is repeated in one plan`));
      mutationIds.add(key);
    }
    if (mutation.operation.endsWith("resource") && !mutation.resourceId) issues.push(issue("catalogMutations", `${mutation.operation} requires resourceId`));
    if (mutation.operation.endsWith("variant") && !mutation.variantId) issues.push(issue("catalogMutations", `${mutation.operation} requires variantId`));
    if (mutation.operation.endsWith("variant") && !mutation.resourceId) issues.push(issue("catalogMutations", `${mutation.operation} requires resourceId`));
    if (mutation.operation.endsWith("rendition") && !mutation.renditionId) issues.push(issue("catalogMutations", `${mutation.operation} requires renditionId`));
    if (mutation.operation.endsWith("rendition") && !mutation.resourceId) issues.push(issue("catalogMutations", `${mutation.operation} requires resourceId`));
    if (mutation.operation.endsWith("rendition") && !mutation.variantId) issues.push(issue("catalogMutations", `${mutation.operation} requires variantId`));
    if ((mutation.operation === "create-rendition" || mutation.operation === "replace-rendition") && !mutation.objectId) issues.push(issue("catalogMutations", `${mutation.operation} requires objectId`));
    if (mutation.operation === "replace-rendition" && !mutation.previousObjectId) issues.push(issue("catalogMutations", "replace-rendition requires previousObjectId"));
    if (mutation.resourceId && !existingResources.has(mutation.resourceId) && !plannedResources.has(mutation.resourceId)) issues.push(issue("catalogMutations", `mutation references unknown Resource ${mutation.resourceId}`));
    if (mutation.variantId && !existingVariants.has(mutation.variantId) && !plannedVariants.has(mutation.variantId)) issues.push(issue("catalogMutations", `mutation references unknown Variant ${mutation.variantId}`));
    if (mutation.renditionId && !existingRenditions.has(mutation.renditionId) && !plannedRenditions.has(mutation.renditionId) && mutation.operation !== "create-rendition") issues.push(issue("catalogMutations", `mutation references unknown Rendition ${mutation.renditionId}`));
    if (mutation.objectId && !existingObjects.has(mutation.objectId) && !objectsToCreate.has(mutation.objectId)) {
      issues.push(issue("catalogMutations", `mutation references Object ${mutation.objectId} that is neither existing nor planned`));
    }
    if (mutation.previousObjectId && !existingObjects.has(mutation.previousObjectId)) issues.push(issue("catalogMutations", `previous Object ${mutation.previousObjectId} must already exist in the Catalog`));
  }
  for (const gc of plan.data.objectsEligibleForGC) {
    if (!existingObjects.has(gc.objectId)) issues.push(issue("objectsEligibleForGC", `GC candidate ${gc.objectId} is not an existing Catalog Object`));
    const currentReferences = catalog.data.renditions.filter((rendition) => rendition.objectId === gc.objectId).map((rendition) => rendition.id);
    for (const renditionId of currentReferences) if (replacedRenditions.get(renditionId) !== gc.objectId) issues.push(issue("objectsEligibleForGC", `Object ${gc.objectId} is still referenced by Rendition ${renditionId}`));
  }
  if (!plan.data.validation.humanApprovalRequired) issues.push(issue("validation.humanApprovalRequired", "publish plans always require human approval"));
  return appendCrossIssues(plan, issues);
}

/**
 * Compatibility helper for callers that still carry the old generic field.
 * New code should use assertSchemaVersions() with the document family.
 */
export function assertSchemaVersion(value: { schemaVersion?: string }, expectedVersion = "1.0"): void {
  if (value.schemaVersion !== undefined && value.schemaVersion !== expectedVersion) {
    throw new Error(`Unsupported legacy schemaVersion ${String(value.schemaVersion)}; expected ${expectedVersion}`);
  }
}

export function assertSchemaVersions(value: {
  catalogSchemaVersion?: string;
  workspaceSchemaVersion?: string;
  releaseSchemaVersion?: string;
  publishPlanSchemaVersion?: string;
}): void {
  const expected: Array<[string, string | undefined, string]> = [
    ["catalogSchemaVersion", value.catalogSchemaVersion, CATALOG_SCHEMA_VERSION],
    ["workspaceSchemaVersion", value.workspaceSchemaVersion, WORKSPACE_SCHEMA_VERSION],
    ["releaseSchemaVersion", value.releaseSchemaVersion, RELEASE_SCHEMA_VERSION],
    ["publishPlanSchemaVersion", value.publishPlanSchemaVersion, PUBLISH_PLAN_SCHEMA_VERSION],
  ];
  for (const [name, actual, wanted] of expected) {
    if (actual !== undefined && actual !== wanted) throw new Error(`Unsupported ${name} ${String(actual)}; expected ${wanted}`);
  }
}

export { Candidate, Resource, Variant, Rendition, AssetObject, UpdateBatch, ReleaseManifest, PublishPlan };
export type { CandidateType };

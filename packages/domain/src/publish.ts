import { createUuidV7, immutableObjectKey } from "./identity.js";
import {
  PublishPlan,
  ReleaseManifest,
  type Candidate,
  type Catalog as CatalogType,
  type PublishPlan as PublishPlanType,
  type ReleaseManifest as ReleaseManifestType,
  type UpdateBatch,
} from "./schema.js";
import { validateCandidate, validatePublishPlan, validatePublishPlanConsistency, validateReleaseManifest, validateReleaseManifestConsistency } from "./validation.js";
import { checkWorkspaceRawIntegrity, sha256File } from "./workspace.js";
import { effectiveCandidateMetadata } from "./review.js";
import path from "node:path";
import { stat } from "node:fs/promises";

function iso(value?: Date | string): string {
  const result = value instanceof Date ? value.toISOString() : value ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(result))) throw new Error(`invalid timestamp: ${result}`);
  return result;
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function finalFile(candidate: Candidate): Candidate["files"][number] {
  const fileId = candidate.processing.processedFileId;
  if (fileId) {
    const processed = candidate.files.find((file) => file.id === fileId);
    if (!processed) throw new Error(`Candidate ${candidate.id} references missing processed file ${fileId}`);
    if (processed.role !== "processed-upscaled") throw new Error(`Candidate ${candidate.id} processedFileId must reference processed-upscaled`);
    return processed;
  }
  if (candidate.processing.requiresUpscale) throw new Error(`Candidate ${candidate.id} requires upscale but has no processed-upscaled file`);
  const work = candidate.files.find((file) => file.role === "work-original");
  if (!work) throw new Error(`Candidate ${candidate.id} has no work-original file`);
  return work;
}

async function readyCandidates(batch: UpdateBatch, candidates: Candidate[], workspaceRoot: string): Promise<Candidate[]> {
  if (batch.status !== "READY_TO_PUBLISH") throw new Error(`UpdateBatch must be READY_TO_PUBLISH, got ${batch.status}`);
  if (batch.candidateIds.length !== candidates.length || !batch.candidateIds.every((id) => candidates.some((candidate) => candidate.id === id))) {
    throw new Error("UpdateBatch candidate IDs do not match the supplied Candidate state");
  }
  const blocked = candidates.filter((candidate) => candidate.status === "BLOCKED");
  if (blocked.length > 0) throw new Error(`cannot publish while ${blocked.length} Candidate(s) are BLOCKED`);
  const active = candidates.filter((candidate) => candidate.status !== "REJECTED");
  if (active.some((candidate) => candidate.batchId !== batch.id)) throw new Error("all active Candidates must belong to the supplied UpdateBatch");
  if (active.some((candidate) => candidate.status !== "READY")) throw new Error("all non-rejected Candidates must be READY before creating a ReleaseManifest draft");
  return Promise.all(active.map(async (candidate) => {
    const validation = validateCandidate(candidate);
    if (!validation.success) throw new Error(`Candidate ${candidate.id} is not publishable: ${validation.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
    if (!candidate.naming.finalFilename) throw new Error(`Candidate ${candidate.id} has no finalized filename`);
    if (candidate.review.state !== "approved") throw new Error(`Candidate ${candidate.id} has no approved final review`);
    if (candidate.processing.requiresUpscale && (!candidate.processing.selectedOutputFileId || !candidate.processing.processedFileId || !candidate.processing.conversion)) {
      throw new Error(`Candidate ${candidate.id} requires a selected and converted upscale result`);
    }
    const file = finalFile(candidate);
    if (!(await verifyCandidateFile(candidate, file, workspaceRoot))) throw new Error(`Candidate ${candidate.id} final file bytes no longer match its recorded size/SHA-256`);
    return validation.data;
  }));
}

function assertReleaseManifestMatchesCandidates(manifest: ReleaseManifestType, candidates: Candidate[]): void {
  if (manifest.publishedRenditions.length !== candidates.length) throw new Error("ReleaseManifest published rendition count does not match active READY Candidates");
  for (const candidate of candidates) {
    const target = candidate.target;
    if (!target?.resourceId || !target.variantId || !target.renditionId) throw new Error(`READY Candidate ${candidate.id} has incomplete publication target`);
    const entries = manifest.publishedRenditions.filter((entry) => entry.resourceId === target.resourceId && entry.variantId === target.variantId && entry.renditionId === target.renditionId);
    if (entries.length !== 1) throw new Error(`ReleaseManifest must contain exactly one published rendition for Candidate ${candidate.id}`);
    const file = finalFile(candidate);
    if (!file.sha256 || entries[0]!.objectId !== `sha256:${file.sha256}`) throw new Error(`ReleaseManifest object does not match Candidate ${candidate.id} final file`);
    const expectedFilename = target.downloadFilename ?? candidate.naming.finalFilename;
    if (!expectedFilename || entries[0]!.downloadFilename !== expectedFilename) throw new Error(`ReleaseManifest downloadFilename does not match Candidate ${candidate.id}`);
  }
}

export type ReleaseManifestDraftOptions = {
  batch: UpdateBatch;
  candidates: Candidate[];
  catalog: CatalogType;
  workspaceRoot: string;
  now?: Date | string;
};

async function assertWorkspaceRawIntegrity(workspaceRoot: string): Promise<void> {
  const issues = await checkWorkspaceRawIntegrity(workspaceRoot);
  if (issues.length > 0) throw new Error(`raw integrity blocks publication: ${issues.map((issue) => `${issue.code}:${issue.relativePath}`).join(", ")}`);
}

export async function createReleaseManifestDraft(options: ReleaseManifestDraftOptions): Promise<ReleaseManifestType> {
  await assertWorkspaceRawIntegrity(options.workspaceRoot);
  const candidates = await readyCandidates(options.batch, options.candidates, options.workspaceRoot);
  const changes: ReleaseManifestType["changes"] = [];
  const publishedRenditions: ReleaseManifestType["publishedRenditions"] = [];
  const affectedResourceIds = new Set<string>();
  const resourceById = new Map(options.catalog.resources.map((resource) => [resource.id, resource]));
  const variantById = new Map(options.catalog.variants.map((variant) => [variant.id, variant]));
  const renditionById = new Map(options.catalog.renditions.map((rendition) => [rendition.id, rendition]));
  for (const candidate of candidates) {
    const target = candidate.target;
    if (!target?.resourceId || !target.variantId || !target.renditionId) throw new Error(`READY Candidate ${candidate.id} has incomplete publication target`);
    const file = finalFile(candidate);
    if (!file.sha256) throw new Error(`final file for Candidate ${candidate.id} has no verified SHA-256`);
    const downloadFilename = target.downloadFilename ?? candidate.naming.finalFilename;
    if (!downloadFilename) throw new Error(`Candidate ${candidate.id} has no downloadFilename`);
    affectedResourceIds.add(target.resourceId);
    const resource = resourceById.get(target.resourceId);
    const variant = variantById.get(target.variantId);
    const rendition = renditionById.get(target.renditionId);
    if (!resource) changes.push({ changeType: "added-resource", resourceId: target.resourceId, detail: `add Resource for Candidate ${candidate.id}` });
    if (!variant) changes.push({ changeType: "added-variant", resourceId: target.resourceId, variantId: target.variantId, detail: `add Variant for Candidate ${candidate.id}` });
    if (!rendition) {
      changes.push({ changeType: "added-rendition", resourceId: target.resourceId, variantId: target.variantId, renditionId: target.renditionId, objectId: `sha256:${file.sha256}`, detail: `add ${candidate.processing.requiresUpscale ? "upscaled" : "original"} Rendition for Candidate ${candidate.id}` });
    } else if (rendition.objectId !== `sha256:${file.sha256}`) {
      changes.push({ changeType: "replaced-rendition", resourceId: target.resourceId, variantId: target.variantId, renditionId: target.renditionId, objectId: `sha256:${file.sha256}`, previousObjectId: rendition.objectId, detail: `replace Object for stable Rendition ${rendition.id}` });
    }
    const candidateMetadata = effectiveCandidateMetadata(candidate);
    if (resource && Object.keys(candidateMetadata).length > 0 && !deepEqual(resource.metadata, candidateMetadata)) {
      changes.push({ changeType: "metadata-changed", resourceId: resource.id, detail: `metadata changed by Candidate ${candidate.id}` });
    }
    if (resource && !resource.aliases.some((alias) => alias.value === downloadFilename)) {
      changes.push({ changeType: "alias-added", resourceId: resource.id, detail: `download filename alias added: ${downloadFilename}` });
    }
    publishedRenditions.push({ resourceId: target.resourceId, variantId: target.variantId, renditionId: target.renditionId, objectId: `sha256:${file.sha256}`, downloadFilename });
  }
  const manifest = ReleaseManifest.parse({
    releaseSchemaVersion: "1.0",
    id: createUuidV7(),
    updateBatchId: options.batch.id,
    game: options.batch.game,
    baseVersion: options.batch.baseVersion,
    targetVersion: options.batch.targetVersion,
    createdAt: iso(options.now),
    status: "draft",
    changes,
    affectedResourceIds: [...affectedResourceIds],
    publishedRenditions,
    notes: ["Draft generated from READY Candidates only; rejected and ignored review history remains local to ReviewLog."],
  });
  const validation = validateReleaseManifest(manifest);
  if (!validation.success) throw new Error(`generated ReleaseManifest is invalid: ${validation.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
  const consistency = validateReleaseManifestConsistency(validation.data, options.catalog);
  if (!consistency.success) throw new Error(`generated ReleaseManifest references are invalid: ${consistency.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
  return validation.data;
}

export const draftReleaseManifest = createReleaseManifestDraft;

function mutationKey(operation: string, resourceId?: string, variantId?: string, renditionId?: string): string {
  return [operation, resourceId ?? "", variantId ?? "", renditionId ?? ""].join(":");
}

function mutationFromChange(change: ReleaseManifestType["changes"][number]): {
  operation: "create-resource" | "update-resource" | "create-variant" | "update-variant" | "create-rendition" | "replace-rendition";
  resourceId?: string | undefined;
  variantId?: string | undefined;
  renditionId?: string | undefined;
  objectId?: string | undefined;
  previousObjectId?: string | undefined;
  summary: string;
} | undefined {
  switch (change.changeType) {
    case "added-resource": return { operation: "create-resource", resourceId: change.resourceId, summary: change.detail };
    case "added-variant": return { operation: "create-variant", resourceId: change.resourceId, variantId: change.variantId, summary: change.detail };
    case "added-rendition": return { operation: "create-rendition", resourceId: change.resourceId, variantId: change.variantId, renditionId: change.renditionId, objectId: change.objectId, summary: change.detail };
    case "replaced-rendition": return { operation: "replace-rendition", resourceId: change.resourceId, variantId: change.variantId, renditionId: change.renditionId, objectId: change.objectId, previousObjectId: change.previousObjectId, summary: change.detail };
    case "metadata-changed": return { operation: "update-resource", resourceId: change.resourceId, summary: change.detail };
    case "alias-added": return { operation: "update-resource", resourceId: change.resourceId, summary: change.detail };
    default: return undefined;
  }
}

function finalFileAbsolutePath(workspaceRoot: string | undefined, candidate: Candidate, file: Candidate["files"][number]): string | undefined {
  return workspaceRoot ? path.resolve(workspaceRoot, file.relativePath) : undefined;
}

async function verifyCandidateFile(candidate: Candidate, file: Candidate["files"][number], workspaceRoot?: string): Promise<boolean> {
  if (!file.sha256 || file.sizeBytes < 0) return false;
  const absolutePath = finalFileAbsolutePath(workspaceRoot, candidate, file);
  if (!absolutePath) return true;
  try {
    const fileStats = await stat(absolutePath);
    if (fileStats.size !== file.sizeBytes) return false;
    return (await sha256File(absolutePath)).toLowerCase() === file.sha256.toLowerCase();
  } catch {
    return false;
  }
}

export type PublishPlanDryRunOptions = {
  batch: UpdateBatch;
  candidates: Candidate[];
  catalog: CatalogType;
  releaseManifest: ReleaseManifestType;
  workspaceRoot: string;
  now?: Date | string;
  retentionDays?: number;
};

export async function createPublishPlanDryRun(options: PublishPlanDryRunOptions): Promise<PublishPlanType> {
  await assertWorkspaceRawIntegrity(options.workspaceRoot);
  const candidates = await readyCandidates(options.batch, options.candidates, options.workspaceRoot);
  if (options.releaseManifest.updateBatchId !== options.batch.id) throw new Error("ReleaseManifest does not belong to UpdateBatch");
  if (options.releaseManifest.status !== "draft") throw new Error(`PublishPlan dry-run requires a draft ReleaseManifest, got ${options.releaseManifest.status}`);
  const manifestValidation = validateReleaseManifest(options.releaseManifest);
  if (!manifestValidation.success) throw new Error(`ReleaseManifest is invalid: ${manifestValidation.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
  const manifestConsistency = validateReleaseManifestConsistency(manifestValidation.data, options.catalog);
  if (!manifestConsistency.success) throw new Error(`ReleaseManifest references are invalid: ${manifestConsistency.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
  assertReleaseManifestMatchesCandidates(manifestValidation.data, candidates);
  const existingObjectIds = new Set(options.catalog.objects.map((object) => object.id));
  const filesByObjectId = new Map<string, { sizeBytes: number; mime: Candidate["files"][number]["mime"]; extension: Candidate["files"][number]["extension"] }>();
  let objectBytesVerified = true;
  for (const candidate of candidates) {
    const file = finalFile(candidate);
    objectBytesVerified = objectBytesVerified && await verifyCandidateFile(candidate, file, options.workspaceRoot);
    if (!file.sha256) continue;
    filesByObjectId.set(`sha256:${file.sha256}`, { sizeBytes: file.sizeBytes, mime: file.mime, extension: file.extension });
  }
  if (!objectBytesVerified) throw new Error("final file bytes could not be verified; PublishPlan generation is blocked");
  const objectsToCreate = [...filesByObjectId.entries()]
    .filter(([objectId]) => !existingObjectIds.has(objectId))
    .map(([objectId, file]) => ({ objectId, objectKey: immutableObjectKey(objectId.slice("sha256:".length), file.extension), sha256: objectId.slice("sha256:".length), sizeBytes: file.sizeBytes, mime: file.mime }));
  const mutationsByKey = new Map<string, ReturnType<typeof mutationFromChange>>();
  for (const change of options.releaseManifest.changes) {
    const mutation = mutationFromChange(change);
    if (!mutation) continue;
    const key = mutationKey(mutation.operation, mutation.resourceId, mutation.variantId, mutation.renditionId);
    const previous = mutationsByKey.get(key);
    mutationsByKey.set(key, previous ? { ...previous, summary: `${previous.summary}; ${mutation.summary}` } : mutation);
  }
  const catalogMutations = [...mutationsByKey.values()].filter((mutation): mutation is NonNullable<typeof mutation> => Boolean(mutation));
  const currentReferenceCounts = new Map<string, number>();
  for (const rendition of options.catalog.renditions) currentReferenceCounts.set(rendition.objectId, (currentReferenceCounts.get(rendition.objectId) ?? 0) + 1);
  const replacementChanges = options.releaseManifest.changes.filter((change) => change.changeType === "replaced-rendition" && change.previousObjectId);
  for (const change of replacementChanges) currentReferenceCounts.set(change.previousObjectId!, Math.max(0, (currentReferenceCounts.get(change.previousObjectId!) ?? 0) - 1));
  const retentionDays = options.retentionDays ?? 30;
  const eligibleAfter = new Date(Date.parse(iso(options.now)) + retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const objectsEligibleForGC = [...new Set(replacementChanges.map((change) => change.previousObjectId!))]
    .filter((objectId) => (currentReferenceCounts.get(objectId) ?? 0) === 0)
    .map((objectId) => ({ objectId, reason: "Rendition replacement leaves the previous Object unreferenced after the retention window", eligibleAfter, catalogReferencesAfter: 0 as const }));
  const draft: PublishPlanType = PublishPlan.parse({
    publishPlanSchemaVersion: "1.0",
    id: createUuidV7(),
    updateBatchId: options.batch.id,
    generatedAt: iso(options.now),
    dryRun: true,
    objectsToCreate,
    catalogMutations,
    releaseManifestMutation: { operation: "create", manifestId: options.releaseManifest.id, targetVersion: options.releaseManifest.targetVersion },
    objectsEligibleForGC,
    validation: { schemaValid: true, referencesValid: true, objectBytesVerified, humanApprovalRequired: true },
    notes: [
      `Dry-run only: ${objectsToCreate.length} object(s), ${objectsToCreate.reduce((sum, object) => sum + object.sizeBytes, 0)} bytes, ${options.releaseManifest.changes.filter((change) => change.changeType === "added-resource").length} new resource(s), ${options.releaseManifest.changes.filter((change) => change.changeType === "replaced-rendition").length} replaced rendition(s).`,
      "No ROS connection, object deletion, Catalog write, Git operation, or public release was performed.",
    ],
  });
  const validation = validatePublishPlan(draft);
  if (!validation.success) throw new Error(`generated PublishPlan is invalid: ${validation.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
  const consistency = validatePublishPlanConsistency(draft, options.catalog);
  if (!consistency.success) throw new Error(`generated PublishPlan references are invalid: ${consistency.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
  return { ...validation.data, validation: { ...validation.data.validation, schemaValid: true, referencesValid: true } };
}

export const createPublishPlan = createPublishPlanDryRun;

export type PublishPlanSummary = {
  totalUploadObjects: number;
  totalUploadBytes: number;
  addedResources: number;
  modifiedResources: number;
  replacedRenditions: number;
};

export function summarizePublishPlan(plan: PublishPlanType, manifest: ReleaseManifestType): PublishPlanSummary {
  const modifiedResourceIds = new Set(manifest.changes.filter((change) => change.changeType === "metadata-changed" || change.changeType === "alias-added").map((change) => change.resourceId).filter((id): id is string => Boolean(id)));
  return {
    totalUploadObjects: plan.objectsToCreate.length,
    totalUploadBytes: plan.objectsToCreate.reduce((sum, object) => sum + object.sizeBytes, 0),
    addedResources: new Set(manifest.changes.filter((change) => change.changeType === "added-resource").map((change) => change.resourceId).filter((id): id is string => Boolean(id))).size,
    modifiedResources: modifiedResourceIds.size,
    replacedRenditions: manifest.changes.filter((change) => change.changeType === "replaced-rendition").length,
  };

}

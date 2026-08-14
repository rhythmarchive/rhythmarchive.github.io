import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CandidateStatus, UpdateBatchStatus, WorkspaceLayout, type Candidate, type CandidateStatus as CandidateStatusType, type UpdateBatchStatus as UpdateBatchStatusType } from "./schema.js";
import { validateUpdateBatch } from "./validation.js";

export const DEFAULT_WORKSPACE_LAYOUT = {
  raw: "raw",
  work: "work",
  upscaleInput: "upscale-input",
  upscaleOutput: "upscale-output",
  processed: "processed",
  metadata: "metadata",
  batchManifest: "metadata/batch.json",
} as const;

const CANDIDATE_TRANSITIONS: Record<CandidateStatusType, readonly CandidateStatusType[]> = {
  EXTRACTED: ["NAMING_REVIEW", "REJECTED", "BLOCKED"],
  NAMING_REVIEW: ["NEEDS_UPSCALE", "FINAL_REVIEW", "REJECTED", "BLOCKED"],
  NEEDS_UPSCALE: ["UPSCALE_PENDING", "BLOCKED"],
  UPSCALE_PENDING: ["UPSCALE_DETECTED", "BLOCKED"],
  UPSCALE_DETECTED: ["UPSCALE_CONVERTED", "BLOCKED"],
  UPSCALE_CONVERTED: ["FINAL_REVIEW", "BLOCKED"],
  FINAL_REVIEW: ["READY", "REJECTED", "BLOCKED"],
  READY: [],
  REJECTED: [],
  BLOCKED: ["NAMING_REVIEW", "UPSCALE_PENDING", "FINAL_REVIEW", "REJECTED"],
};

const BATCH_TRANSITIONS: Record<UpdateBatchStatusType, readonly UpdateBatchStatusType[]> = {
  CREATED: ["EXTRACTED", "BLOCKED"],
  EXTRACTED: ["IN_REVIEW", "BLOCKED"],
  IN_REVIEW: ["PROCESSING", "READY_TO_PUBLISH", "BLOCKED"],
  PROCESSING: ["READY_TO_PUBLISH", "BLOCKED"],
  READY_TO_PUBLISH: ["PUBLISHED", "BLOCKED"],
  PUBLISHED: ["CLEANED"],
  CLEANED: [],
  BLOCKED: ["IN_REVIEW", "PROCESSING", "READY_TO_PUBLISH"],
};

export function canTransitionCandidate(from: CandidateStatusType, to: CandidateStatusType): boolean {
  return from === to || CANDIDATE_TRANSITIONS[from].includes(to);
}

export function transitionCandidate(candidate: Candidate, to: CandidateStatusType): Candidate {
  if (!canTransitionCandidate(candidate.status, to)) throw new Error(`invalid Candidate transition ${candidate.status} -> ${to}`);
  if (to === "FINAL_REVIEW" && candidate.processing.requiresUpscale && candidate.processing.state !== "upscale-converted") {
    throw new Error("Candidate requiring upscale must complete conversion before FINAL_REVIEW");
  }
  if (to === "READY" && (candidate.review.state !== "approved" || !candidate.target?.resourceId || !candidate.target.variantId || !candidate.target.renditionId)) {
    throw new Error("READY Candidate requires approved review and Resource/Variant/Rendition targets");
  }
  return { ...candidate, status: CandidateStatus.parse(to) };
}

export function canTransitionBatch(from: UpdateBatchStatusType, to: UpdateBatchStatusType): boolean {
  return from === to || BATCH_TRANSITIONS[from].includes(to);
}

export function ensureWorkspaceLayout(rootPath: string): Promise<typeof DEFAULT_WORKSPACE_LAYOUT> {
  const root = path.resolve(rootPath);
  return Promise.all(Object.values(DEFAULT_WORKSPACE_LAYOUT).filter((entry) => !entry.includes("/")).map((directory) => mkdir(path.join(root, directory), { recursive: true })))
    .then(() => mkdir(path.join(root, "metadata"), { recursive: true }))
    .then(() => DEFAULT_WORKSPACE_LAYOUT);
}

export async function writeBatchManifest(rootPath: string, batch: unknown): Promise<string> {
  const validation = validateUpdateBatch(batch);
  if (!validation.success) throw new Error(`invalid UpdateBatch: ${validation.issues.map((item) => `${item.path} ${item.message}`).join("; ")}`);
  const root = path.resolve(rootPath);
  await ensureWorkspaceLayout(root);
  const manifestPath = path.join(root, DEFAULT_WORKSPACE_LAYOUT.batchManifest);
  const tempPath = `${manifestPath}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tempPath, `${JSON.stringify(batch, null, 2)}\n`, "utf8");
  const { rename } = await import("node:fs/promises");
  await rename(tempPath, manifestPath);
  return manifestPath;
}

export function validateWorkspaceRelativePath(relativePath: string): boolean {
  if (!relativePath || relativePath.startsWith("/") || relativePath.startsWith("\\")) return false;
  if (/^[a-zA-Z]:[\\/]/.test(relativePath)) return false;
  return !relativePath.split(/[\\/]+/).includes("..");
}

export { WorkspaceLayout };

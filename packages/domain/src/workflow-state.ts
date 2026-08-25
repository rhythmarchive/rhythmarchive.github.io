import path from "node:path";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { atomicWriteJson } from "./catalog.js";
import { createUuidV7 } from "./identity.js";

const AbsolutePath = z.string().min(1).refine((value) => /^[a-zA-Z]:[\\/]/u.test(value) || /^\\\\/u.test(value) || value.startsWith("/"), "must be an absolute path");
const RemoteUrl = z.string().url().refine((value) => /^https?:\/\//iu.test(value), "must be an HTTP(S) URL");
const SourceLocation = z.union([AbsolutePath, RemoteUrl]);
const IsoTimestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "must be an ISO-like timestamp");

export const WorkflowKind = z.enum(["game-reconnaissance", "game-onboarding", "game-update", "content-addition"]);
export type WorkflowKind = z.infer<typeof WorkflowKind>;

export const WorkflowSelectionPolicy = z.object({
  selectedAssetTypes: z.array(z.string().min(1)).default([]),
  excludedAssetTypes: z.array(z.string().min(1)).default([]),
  rationale: z.string().min(1),
});
export type WorkflowSelectionPolicy = z.infer<typeof WorkflowSelectionPolicy>;

export const WorkflowStep = z.enum(["probe", "reconnaissance", "ingest", "extract", "normalize", "diff", "review", "approve", "release-prepare", "verify", "complete"]);
export type WorkflowStep = z.infer<typeof WorkflowStep>;

export const WorkflowPhase = z.enum(["probe", "ingest", "extract", "normalize", "diff", "review", "approved", "release-prepared", "verified", "reconnaissance-complete", "blocked", "complete"]);
export type WorkflowPhase = z.infer<typeof WorkflowPhase>;

export const WorkflowArtifact = z.object({
  name: z.string().min(1),
  path: AbsolutePath,
  kind: z.enum(["probe", "analysis-report", "profile", "plan", "extractor-result", "workspace", "manifest", "delta", "review", "storage-diff", "release-plan", "verification"]),
  createdAt: IsoTimestamp,
});
export type WorkflowArtifact = z.infer<typeof WorkflowArtifact>;

export const WorkflowState = z.object({
  kind: z.literal("rhythm-workflow-state"),
  schemaVersion: z.enum(["1", "2"]).default("2"),
  runId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu),
  gameId: z.string().min(1),
  candidateSlug: z.string().min(1).optional(),
  workflowKind: WorkflowKind.default("game-update"),
  version: z.string().min(1),
  sourcePath: SourceLocation,
  sourceSnapshot: z.string().min(1).optional(),
  phase: WorkflowPhase,
  completedSteps: z.array(WorkflowStep).default([]),
  artifacts: z.array(WorkflowArtifact).default([]),
  manifestPath: AbsolutePath.optional(),
  deltaPath: AbsolutePath.optional(),
  reviewPath: AbsolutePath.optional(),
  releasePlanPath: AbsolutePath.optional(),
  reviewStatus: z.enum(["pending", "approved", "not-required"]).default("pending"),
  selectionPolicy: WorkflowSelectionPolicy.optional(),
  publishStatus: z.enum(["not-prepared", "prepared", "blocked", "complete"]).default("not-prepared"),
  blockers: z.array(z.string().min(1)).default([]),
  errors: z.array(z.string().min(1)).default([]),
  resumePhase: WorkflowPhase.optional(),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
});
export type WorkflowState = z.infer<typeof WorkflowState>;

const TRANSITIONS: Record<WorkflowPhase, readonly WorkflowPhase[]> = {
  probe: ["ingest", "reconnaissance-complete", "blocked"],
  ingest: ["extract", "blocked"],
  extract: ["normalize", "blocked"],
  normalize: ["diff", "blocked"],
  diff: ["review", "blocked"],
  review: ["approved", "blocked"],
  approved: ["release-prepared", "blocked"],
  "release-prepared": ["verified", "blocked"],
  verified: ["complete", "blocked"],
  "reconnaissance-complete": ["complete", "ingest", "blocked"],
  blocked: ["probe", "ingest", "extract", "normalize", "diff", "review", "approved", "release-prepared", "verified"],
  complete: [],
};

function safeSegment(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "." || trimmed === ".." || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) throw new Error("unsafe " + label + " path segment");
  return trimmed.replace(/[^a-zA-Z0-9._-]+/gu, "_");
}

export function workflowRoot(gameId: string, version: string, rootPath = path.resolve("temp", "rhythmctl")): string {
  return path.resolve(rootPath, safeSegment(gameId, "game or candidate"), safeSegment(version, "version"));
}

export function createWorkflowState(input: {
  gameId: string;
  version: string;
  sourcePath: string;
  sourceSnapshot?: string;
  candidateSlug?: string;
  workflowKind?: WorkflowKind;
  selectionPolicy?: WorkflowSelectionPolicy;
  phase?: WorkflowPhase;
  completedSteps?: WorkflowStep[];
  now?: string;
}): WorkflowState {
  const now = input.now ?? new Date().toISOString();
  const phase = input.phase ?? "probe";
  return WorkflowState.parse({
    kind: "rhythm-workflow-state",
    schemaVersion: "2",
    runId: createUuidV7(Date.parse(now)),
    gameId: input.gameId,
    ...(input.candidateSlug ? { candidateSlug: input.candidateSlug } : {}),
    workflowKind: input.workflowKind ?? "game-update",
    version: input.version,
    sourcePath: /^https?:\/\//u.test(input.sourcePath) ? input.sourcePath : path.resolve(input.sourcePath),
    ...(input.sourceSnapshot ? { sourceSnapshot: input.sourceSnapshot } : {}),
    phase,
    completedSteps: input.completedSteps ?? (phaseCompletionStep(phase) ? [phaseCompletionStep(phase)!] : []),
    artifacts: [],
    reviewStatus: "pending",
    ...(input.selectionPolicy ? { selectionPolicy: input.selectionPolicy } : {}),
    publishStatus: "not-prepared",
    blockers: [],
    errors: [],
    createdAt: now,
    updatedAt: now,
  });
}

export async function loadWorkflowState(filePath: string): Promise<WorkflowState> {
  return WorkflowState.parse(JSON.parse(await readFile(filePath, "utf8")) as unknown);
}

export async function saveWorkflowState(state: WorkflowState, filePath: string): Promise<void> {
  await atomicWriteJson(filePath, WorkflowState.parse(state));
}

function phaseSteps(phase: WorkflowPhase): WorkflowStep[] {
  const step = phaseCompletionStep(phase);
  return step ? [step] : [];
}

function phaseCompletionStep(phase: WorkflowPhase): WorkflowStep | undefined {
  if (phase === "probe") return "probe";
  if (phase === "reconnaissance-complete") return "reconnaissance";
  if (phase === "approved") return "approve";
  if (phase === "release-prepared") return "release-prepare";
  if (phase === "verified") return "verify";
  if (phase === "complete") return "complete";
  if (phase === "blocked") return undefined;
  return phase;
}

export function canTransitionWorkflow(from: WorkflowPhase, to: WorkflowPhase, workflowKind?: WorkflowKind): boolean {
  if (workflowKind === "content-addition" && from === "probe" && to === "normalize") return true;
  return TRANSITIONS[from].includes(to);
}

export function transitionWorkflowState(stateInput: WorkflowState, to: WorkflowPhase, options: { blockers?: string[]; errors?: string[]; now?: string } = {}): WorkflowState {
  const state = WorkflowState.parse(stateInput);
  if (!canTransitionWorkflow(state.phase, to, state.workflowKind)) throw new Error(`invalid workflow transition ${state.phase} -> ${to}`);
  if (to === "blocked" && (!options.blockers || options.blockers.length === 0) && state.blockers.length === 0) throw new Error("blocked workflow transition requires at least one blocker");
  if (state.phase === "blocked" && (!state.resumePhase || to !== state.resumePhase)) throw new Error(`blocked workflow must resume at ${state.resumePhase ?? "its saved phase"}`);
  const now = options.now ?? new Date().toISOString();
  const nextSteps = to === "blocked" ? state.completedSteps : [...new Set([...state.completedSteps, ...phaseSteps(to)])];
  const nextResumePhase = to === "blocked" ? state.phase : undefined;
  return WorkflowState.parse({
    ...state,
    phase: to,
    completedSteps: nextSteps,
    blockers: to === "blocked" ? [...new Set(options.blockers ?? state.blockers)] : [],
    errors: options.errors ? [...new Set(options.errors)] : state.errors,
    ...(nextResumePhase ? { resumePhase: nextResumePhase } : { resumePhase: undefined }),
    updatedAt: now,
  });
}

export async function updateWorkflowState(filePath: string, patch: Partial<Omit<WorkflowState, "kind" | "schemaVersion" | "runId" | "createdAt" | "updatedAt">> & { updatedAt?: string }): Promise<WorkflowState> {
  const current = await loadWorkflowState(filePath);
  const desiredPhase = patch.phase;
  let next = current;
  if (desiredPhase && desiredPhase !== current.phase) {
    next = transitionWorkflowState(current, desiredPhase, {
      ...(patch.blockers ? { blockers: patch.blockers } : {}),
      ...(patch.errors ? { errors: patch.errors } : {}),
      ...(patch.updatedAt ? { now: patch.updatedAt } : {}),
    });
  }
  const { phase: _phase, blockers: _blockers, errors: _errors, updatedAt: _updatedAt, completedSteps, ...rest } = patch;
  next = WorkflowState.parse({
    ...next,
    ...rest,
    ...(completedSteps ? { completedSteps: [...new Set([...next.completedSteps, ...completedSteps])] } : {}),
    ...(patch.blockers ? { blockers: patch.blockers } : {}),
    ...(patch.errors ? { errors: patch.errors } : {}),
    updatedAt: patch.updatedAt ?? new Date().toISOString(),
  });
  await saveWorkflowState(next, filePath);
  return next;
}

export async function recordWorkflowArtifact(filePath: string, artifactInput: WorkflowArtifact): Promise<WorkflowState> {
  const artifact = WorkflowArtifact.parse(artifactInput);
  const current = await loadWorkflowState(filePath);
  const artifacts = [...current.artifacts.filter((item) => item.name !== artifact.name), artifact];
  return updateWorkflowState(filePath, { artifacts });
}

export function nextWorkflowStep(stateInput: WorkflowState): string {
  const state = WorkflowState.parse(stateInput);
  if (state.phase === "blocked") return state.resumePhase ? `resume:${state.resumePhase}` : "blocked";
  if (state.phase === "reconnaissance-complete") return state.workflowKind === "game-reconnaissance" ? "onboarding decision" : "onboard/extract";
  if (state.phase === "complete") return "none";
  const mapping: Record<WorkflowPhase, string> = {
    probe: "ingest",
    ingest: "extract",
    extract: "normalize",
    normalize: "diff",
    diff: "review",
    review: "approve",
    approved: "release prepare",
    "release-prepared": "verify",
    verified: "complete",
    "reconnaissance-complete": "onboard/extract",
    blocked: "blocked",
    complete: "none",
  };
  return mapping[state.phase];
}

export function workflowResumeInfo(stateInput: WorkflowState): { phase: WorkflowPhase; nextStep: string; resumable: boolean; blockers: string[] } {
  const state = WorkflowState.parse(stateInput);
  return { phase: state.phase, nextStep: nextWorkflowStep(state), resumable: state.phase !== "complete" && state.blockers.length === 0, blockers: state.blockers };
}

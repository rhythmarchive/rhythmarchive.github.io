import path from "node:path";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { atomicWriteJson } from "./catalog.js";
import { createUuidV7 } from "./identity.js";
import { Game } from "./schema.js";

const AbsolutePath = z.string().min(1).refine((value) => /^[a-zA-Z]:[\\/]/u.test(value) || /^\\\\/u.test(value) || value.startsWith("/"), "must be an absolute path");
const RemoteUrl = z.string().url().refine((value) => /^https?:\/\//iu.test(value), "must be an HTTP(S) URL");
const SourceLocation = z.union([AbsolutePath, RemoteUrl]);
const IsoTimestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "must be an ISO-like timestamp");

export const WorkflowPhase = z.enum(["probe", "ingest", "extract", "normalize", "diff", "review", "approved", "release-prepared", "verified", "blocked", "complete"]);
export type WorkflowPhase = z.infer<typeof WorkflowPhase>;

export const WorkflowState = z.object({
  kind: z.literal("rhythm-workflow-state"),
  schemaVersion: z.literal("1"),
  runId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu),
  gameId: Game,
  version: z.string().min(1),
  sourcePath: SourceLocation,
  sourceSnapshot: z.string().min(1).optional(),
  phase: WorkflowPhase,
  completedSteps: z.array(z.string().min(1)).default([]),
  manifestPath: AbsolutePath.optional(),
  deltaPath: AbsolutePath.optional(),
  reviewPath: AbsolutePath.optional(),
  reviewStatus: z.enum(["pending", "approved", "not-required"]).default("pending"),
  publishStatus: z.enum(["not-prepared", "prepared", "blocked", "complete"]).default("not-prepared"),
  blockers: z.array(z.string().min(1)).default([]),
  errors: z.array(z.string().min(1)).default([]),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
});
export type WorkflowState = z.infer<typeof WorkflowState>;

function safeSegment(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "." || trimmed === ".." || /[\\/\0]/u.test(trimmed)) throw new Error(`${label} must be a safe path segment`);
  return trimmed.replace(/[^a-zA-Z0-9._-]+/gu, "_");
}

export function workflowRoot(gameId: z.infer<typeof Game>, version: string, rootPath = path.resolve("temp", "rhythmctl")): string {
  return path.resolve(rootPath, safeSegment(gameId, "game"), safeSegment(version, "version"));
}

export function createWorkflowState(input: { gameId: z.infer<typeof Game>; version: string; sourcePath: string; sourceSnapshot?: string; now?: string }): WorkflowState {
  const now = input.now ?? new Date().toISOString();
  return WorkflowState.parse({
    kind: "rhythm-workflow-state",
    schemaVersion: "1",
    runId: createUuidV7(Date.parse(now)),
    gameId: input.gameId,
    version: input.version,
    sourcePath: /^https?:\/\//u.test(input.sourcePath) ? input.sourcePath : path.resolve(input.sourcePath),
    ...(input.sourceSnapshot ? { sourceSnapshot: input.sourceSnapshot } : {}),
    phase: "probe",
    completedSteps: [],
    reviewStatus: "pending",
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

export async function updateWorkflowState(filePath: string, patch: Partial<Omit<WorkflowState, "kind" | "schemaVersion" | "runId" | "createdAt" | "updatedAt">> & { updatedAt?: string }): Promise<WorkflowState> {
  const current = await loadWorkflowState(filePath);
  const next = WorkflowState.parse({ ...current, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() });
  await saveWorkflowState(next, filePath);
  return next;
}

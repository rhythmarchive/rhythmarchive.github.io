import { readFile } from "node:fs/promises";
import { z } from "zod";
import { atomicWriteJson } from "./catalog.js";
import { ReleaseDelta, type ReleaseDelta as ReleaseDeltaType } from "./release.js";

const IsoTimestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "must be an ISO-like timestamp");

export const ReviewPackage = z.object({
  kind: z.literal("rhythm-review-package"),
  schemaVersion: z.literal("1"),
  gameId: z.string().min(1),
  version: z.string().min(1),
  generatedAt: IsoTimestamp,
  deltaSnapshot: z.string().min(1),
  status: z.enum(["pending", "approved", "rejected", "not-required"]),
  humanApprovalRequired: z.literal(true),
  summary: z.object({
    new: z.number().int().nonnegative(),
    changed: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
    reviewRequired: z.number().int().nonnegative(),
  }),
  changedItems: z.array(z.object({
    identityKey: z.string().min(1),
    status: z.enum(["NEW", "CHANGED", "REMOVED"]),
    reasons: z.array(z.string().min(1)),
    needsReview: z.boolean(),
    needsRename: z.boolean(),
    anomalies: z.array(z.string().min(1)),
    title: z.string().min(1).optional(),
    sourcePath: z.string().min(1).optional(),
  })),
  renameCandidates: z.array(z.string().min(1)),
  anomalies: z.array(z.string().min(1)),
  reviewer: z.string().min(1).optional(),
  approvedAt: IsoTimestamp.optional(),
  approvedChangeKeys: z.array(z.string().min(1)).default([]),
  notes: z.array(z.string().min(1)).default([]),
});
export type ReviewPackage = z.infer<typeof ReviewPackage>;

export function buildReviewPackage(delta: ReleaseDeltaType, options: { generatedAt?: string } = {}): ReviewPackage {
  const actionable = delta.entries.filter((entry) => entry.status !== "UNCHANGED");
  const changedItems = actionable.map((entry) => ({
    identityKey: entry.identityKey,
    status: entry.status as "NEW" | "CHANGED" | "REMOVED",
    reasons: entry.reasons,
    needsReview: entry.needsReview || entry.status === "REMOVED",
    needsRename: entry.needsRename,
    anomalies: entry.anomalies,
    ...(entry.current?.title ?? entry.previous?.title ? { title: entry.current?.title ?? entry.previous?.title } : {}),
    ...(entry.current?.sourcePath ?? entry.previous?.sourcePath ? { sourcePath: entry.current?.sourcePath ?? entry.previous?.sourcePath } : {}),
  }));
  const renameCandidates = changedItems.filter((item) => item.needsRename).map((item) => item.identityKey);
  const anomalies = [...new Set(delta.entries.flatMap((entry) => entry.anomalies))];
  return ReviewPackage.parse({
    kind: "rhythm-review-package",
    schemaVersion: "1",
    gameId: delta.gameId,
    version: delta.currentVersion,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    deltaSnapshot: delta.currentManifestSnapshot,
    status: actionable.length === 0 ? "not-required" : "pending",
    humanApprovalRequired: true,
    summary: delta.summary,
    changedItems,
    renameCandidates,
    anomalies,
    notes: ["Review is a gate: approval acknowledges the listed changes but never authorizes remote deletion."],
  });
}

export async function readReviewPackage(filePath: string): Promise<ReviewPackage> {
  return ReviewPackage.parse(JSON.parse(await readFile(filePath, "utf8")) as unknown);
}

export async function writeReviewPackage(review: ReviewPackage, filePath: string): Promise<void> {
  await atomicWriteJson(filePath, ReviewPackage.parse(review));
}

export function approveReviewPackage(review: ReviewPackage, reviewer: string, options: { approvedChangeKeys?: string[]; approvedAt?: string } = {}): ReviewPackage {
  const parsed = ReviewPackage.parse(review);
  const allowed = new Set(parsed.changedItems.map((item) => item.identityKey));
  const approvedChangeKeys = options.approvedChangeKeys ?? [...allowed];
  const unknown = approvedChangeKeys.filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`approval contains unknown change keys: ${unknown.join(", ")}`);
  const approvedSet = new Set(approvedChangeKeys);
  if (approvedSet.size !== allowed.size || [...allowed].some((key) => !approvedSet.has(key))) throw new Error("approval must cover every actionable change");
  if (!reviewer.trim()) throw new Error("reviewer must not be empty");
  return ReviewPackage.parse({
    ...parsed,
    status: parsed.status === "not-required" ? "not-required" : "approved",
    reviewer: reviewer.trim(),
    approvedAt: options.approvedAt ?? new Date().toISOString(),
    approvedChangeKeys,
  });
}


export function validateReviewPackageForDelta(review: ReviewPackage, delta: ReleaseDeltaType): { valid: boolean; reasons: string[] } {
  const parsed = ReviewPackage.parse(review);
  const reasons: string[] = [];
  if (parsed.gameId !== delta.gameId) reasons.push("review game does not match delta");
  if (parsed.version !== delta.currentVersion) reasons.push("review version does not match delta");
  if (parsed.deltaSnapshot !== delta.currentManifestSnapshot) reasons.push("review snapshot does not match delta");
  if (JSON.stringify(parsed.summary) !== JSON.stringify(delta.summary)) reasons.push("review summary does not match delta");
  const expectedItems = delta.entries.filter((entry) => entry.status !== "UNCHANGED").map((entry) => `${entry.identityKey}\u0000${entry.status}`).sort();
  const actualItems = parsed.changedItems.map((item) => `${item.identityKey}\u0000${item.status}`).sort();
  if (expectedItems.length !== actualItems.length || expectedItems.some((item, index) => item !== actualItems[index])) reasons.push("review items do not match delta");
  const expectedKeys = delta.entries.filter((entry) => entry.status !== "UNCHANGED").map((entry) => entry.identityKey);
  if (parsed.status === "approved") {
    const approvedKeys = new Set(parsed.approvedChangeKeys);
    if (approvedKeys.size !== expectedKeys.length || expectedKeys.some((key) => !approvedKeys.has(key))) reasons.push("approved change keys do not cover delta");
  }
  return { valid: reasons.length === 0, reasons };
}
export function isReviewApproved(review: ReviewPackage): boolean {
  const parsed = ReviewPackage.parse(review);
  return parsed.status === "approved" || parsed.status === "not-required";
}

export async function checkReviewApproval(filePath: string): Promise<{ approved: boolean; review: ReviewPackage }> {
  const review = await readReviewPackage(filePath);
  return { approved: isReviewApproved(review), review };
}

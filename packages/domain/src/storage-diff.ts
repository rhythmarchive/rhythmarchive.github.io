import { readFile } from "node:fs/promises";
import { z } from "zod";
import { atomicWriteJson } from "./catalog.js";
import { UnifiedAssetManifest, UnifiedAssetManifestEntry, type UnifiedAssetManifest as UnifiedAssetManifestType, type UnifiedAssetManifestEntry as UnifiedAssetManifestEntryType } from "./release.js";

export const StorageDiffStatus = z.enum(["SAME", "NEW", "CHANGED", "REMOVED"]);
export type StorageDiffStatus = z.infer<typeof StorageDiffStatus>;

export const StorageDiffEntry = z.object({
  identityKey: z.string().min(1),
  status: StorageDiffStatus,
  operation: z.enum(["none", "upload", "review"]),
  current: UnifiedAssetManifestEntry.optional(),
  published: UnifiedAssetManifestEntry.optional(),
  reasons: z.array(z.string().min(1)).default([]),
});
export type StorageDiffEntry = z.infer<typeof StorageDiffEntry>;

export const StorageDiff = z.object({
  kind: z.literal("rhythm-storage-diff"),
  schemaVersion: z.literal("1"),
  gameId: z.string().min(1),
  generatedAt: z.string().refine((value) => !Number.isNaN(Date.parse(value)), "must be an ISO-like timestamp"),
  localManifestSnapshot: z.string().min(1),
  publishedManifestSnapshot: z.string().min(1).optional(),
  entries: z.array(StorageDiffEntry),
  summary: z.object({
    same: z.number().int().nonnegative(),
    new: z.number().int().nonnegative(),
    changed: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    uploads: z.number().int().nonnegative(),
    reviewOnly: z.number().int().nonnegative(),
  }),
  notes: z.array(z.string().min(1)).default([]),
});
export type StorageDiff = z.infer<typeof StorageDiff>;

function compareFiles(current: UnifiedAssetManifestEntryType, published: UnifiedAssetManifestEntryType): string[] {
  const currentFile = current.file;
  const publishedFile = published.file;
  const reasons: string[] = [];
  if (currentFile?.sha256 !== publishedFile?.sha256) reasons.push("local and published hashes differ");
  if (currentFile?.sizeBytes !== publishedFile?.sizeBytes) reasons.push("local and published sizes differ");
  if (currentFile?.objectKey !== publishedFile?.objectKey) reasons.push("local and published object keys differ");
  return reasons;
}

export function buildStorageDiff(local: UnifiedAssetManifest, published: UnifiedAssetManifest | undefined): StorageDiff {
  if (published && published.gameId !== local.gameId) throw new Error(`manifest game mismatch: ${published.gameId} vs ${local.gameId}`);
  const publishedByKey = new Map((published?.entries ?? []).map((entry) => [entry.identityKey, entry]));
  const localByKey = new Map(local.entries.map((entry) => [entry.identityKey, entry]));
  const entries: StorageDiffEntry[] = [];
  for (const current of local.entries) {
    const old = publishedByKey.get(current.identityKey);
    if (!old) {
      entries.push(StorageDiffEntry.parse({ identityKey: current.identityKey, status: "NEW", operation: "upload", current, reasons: ["local identity is absent from published manifest"] }));
      continue;
    }
    const reasons = compareFiles(current, old);
    entries.push(StorageDiffEntry.parse({ identityKey: current.identityKey, status: reasons.length > 0 ? "CHANGED" : "SAME", operation: reasons.length > 0 ? "upload" : "none", current, published: old, reasons }));
  }
  for (const old of published?.entries ?? []) {
    if (localByKey.has(old.identityKey)) continue;
    entries.push(StorageDiffEntry.parse({ identityKey: old.identityKey, status: "REMOVED", operation: "review", published: old, reasons: ["published identity is absent from local manifest; deletion is not automatic"] }));
  }
  entries.sort((left, right) => left.identityKey.localeCompare(right.identityKey));
  return StorageDiff.parse({
    kind: "rhythm-storage-diff",
    schemaVersion: "1",
    gameId: local.gameId,
    generatedAt: new Date().toISOString(),
    localManifestSnapshot: local.sourceSnapshot,
    ...(published?.sourceSnapshot ? { publishedManifestSnapshot: published.sourceSnapshot } : {}),
    entries,
    summary: {
      same: entries.filter((entry) => entry.status === "SAME").length,
      new: entries.filter((entry) => entry.status === "NEW").length,
      changed: entries.filter((entry) => entry.status === "CHANGED").length,
      removed: entries.filter((entry) => entry.status === "REMOVED").length,
      uploads: entries.filter((entry) => entry.operation === "upload").length,
      reviewOnly: entries.filter((entry) => entry.operation === "review").length,
    },
    notes: ["SAME entries perform no operation; REMOVED entries are review-only and never trigger remote deletion."],
  });
}

export async function readStorageDiff(filePath: string): Promise<StorageDiff> {
  return StorageDiff.parse(JSON.parse(await readFile(filePath, "utf8")) as unknown);
}

export async function writeStorageDiff(diff: StorageDiff, filePath: string): Promise<void> {
  await atomicWriteJson(filePath, StorageDiff.parse(diff));
}

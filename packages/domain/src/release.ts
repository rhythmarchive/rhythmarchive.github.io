import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { atomicWriteJson } from "./catalog.js";
import { semanticIdentity } from "./diff.js";
import { createDeterministicUuidV7 } from "./identity.js";
import { Game, ResourceType, type Catalog } from "./schema.js";
import type { ExtractorResult } from "./extractors.js";
import { assetRecordsFromCatalog, type AssetRecord } from "./platform.js";

const JsonPrimitive = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const JsonValue: z.ZodType<unknown> = z.lazy(() => z.union([JsonPrimitive, z.array(JsonValue), z.record(z.string(), JsonValue)]));
const IsoTimestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "must be an ISO-like timestamp");
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/iu, "must be a SHA-256 hex digest");
const PortablePath = z.string().min(1).refine((value) => {
  if (value.includes("\0")) return false;
  if (/^[a-zA-Z]:[\\/]/u.test(value) || /^\\\\/u.test(value) || value.startsWith("/") || value.startsWith("\\")) return false;
  return !value.split(/[\\/]+/u).includes("..");
}, "must be a portable relative path");

export const UnifiedManifestFile = z.object({
  objectId: z.string().regex(/^sha256:[0-9a-f]{64}$/iu).optional(),
  objectKey: z.string().min(1).optional(),
  sha256: Sha256.optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  mime: z.string().min(1).optional(),
});
export type UnifiedManifestFile = z.infer<typeof UnifiedManifestFile>;

export const UnifiedAssetManifestEntry = z.object({
  assetId: z.string().min(1),
  identityKey: z.string().min(1),
  gameId: Game,
  assetType: ResourceType,
  variantKey: z.string().min(1).default("default"),
  title: z.string().min(1).optional(),
  artist: z.string().min(1).optional(),
  aliases: z.array(z.string().min(1)).default([]),
  sourceIdentity: z.string().min(1),
  sourcePath: PortablePath.optional(),
  file: UnifiedManifestFile.optional(),
  versionAdded: z.string().min(1).optional(),
  versionChanged: z.string().min(1).optional(),
  metadata: z.record(z.string(), JsonValue).default({}),
  needsReview: z.boolean().default(false),
  needsRename: z.boolean().default(false),
  anomalies: z.array(z.string().min(1)).default([]),
});
export type UnifiedAssetManifestEntry = z.infer<typeof UnifiedAssetManifestEntry>;

export const UnifiedAssetManifest = z.object({
  kind: z.literal("rhythm-unified-asset-manifest"),
  schemaVersion: z.literal("1"),
  gameId: Game,
  version: z.string().min(1),
  generatedAt: IsoTimestamp,
  sourceSnapshot: z.string().min(1),
  entries: z.array(UnifiedAssetManifestEntry),
  notes: z.array(z.string().min(1)).default([]),
});
export type UnifiedAssetManifest = z.infer<typeof UnifiedAssetManifest>;

export const ReleaseDeltaStatus = z.enum(["NEW", "CHANGED", "REMOVED", "UNCHANGED"]);
export type ReleaseDeltaStatus = z.infer<typeof ReleaseDeltaStatus>;

export const ReleaseDeltaEntry = z.object({
  identityKey: z.string().min(1),
  status: ReleaseDeltaStatus,
  current: UnifiedAssetManifestEntry.optional(),
  previous: UnifiedAssetManifestEntry.optional(),
  reasons: z.array(z.string().min(1)).default([]),
  needsReview: z.boolean().default(false),
  needsRename: z.boolean().default(false),
  anomalies: z.array(z.string().min(1)).default([]),
});
export type ReleaseDeltaEntry = z.infer<typeof ReleaseDeltaEntry>;

export const ReleaseDelta = z.object({
  kind: z.literal("rhythm-release-delta"),
  schemaVersion: z.literal("1"),
  gameId: Game,
  previousVersion: z.string().min(1).optional(),
  currentVersion: z.string().min(1),
  generatedAt: IsoTimestamp,
  previousManifestSnapshot: z.string().min(1).optional(),
  currentManifestSnapshot: z.string().min(1),
  entries: z.array(ReleaseDeltaEntry),
  summary: z.object({
    new: z.number().int().nonnegative(),
    changed: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
    reviewRequired: z.number().int().nonnegative(),
  }),
  notes: z.array(z.string().min(1)).default([]),
});
export type ReleaseDelta = z.infer<typeof ReleaseDelta>;

function stableJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

function cleanJson(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(cleanJson).filter((item) => item !== undefined);
  if (typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, cleanJson(item)]).filter(([, item]) => item !== undefined));
  return String(value);
}

export function releaseIdentityKey(input: Pick<UnifiedAssetManifestEntry, "gameId" | "assetType" | "sourceIdentity"> & Partial<Pick<UnifiedAssetManifestEntry, "variantKey">>): string {
  return [input.gameId, input.assetType, input.sourceIdentity.normalize("NFC"), input.variantKey ?? "default"].join("|");
}

function extensionFor(filename: string): string | undefined {
  const match = filename.match(/\.([a-z0-9]+)$/iu)?.[1]?.toLowerCase();
  return match && ["jpg", "jpeg", "png", "webp", "avif", "gif", "bin"].includes(match) ? match : undefined;
}

function mimeFor(extension: string | undefined): string | undefined {
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  if (extension === "avif") return "image/avif";
  if (extension === "gif") return "image/gif";
  return extension === "bin" ? "application/octet-stream" : undefined;
}

function entryFromAssetRecord(record: AssetRecord): UnifiedAssetManifestEntry {
  const variantKey = typeof record.metadata.variantKey === "string" && record.metadata.variantKey.trim() ? record.metadata.variantKey : "default";
  const identityKey = releaseIdentityKey({ gameId: record.gameId, assetType: record.assetType, sourceIdentity: record.sourceIdentity, variantKey });
  return UnifiedAssetManifestEntry.parse({
    assetId: createDeterministicUuidV7(`asset:${identityKey}`),
    identityKey,
    gameId: record.gameId,
    assetType: record.assetType,
    variantKey,
    ...(record.title ? { title: record.title } : {}),
    ...(record.artist ? { artist: record.artist } : {}),
    aliases: record.aliases,
    sourceIdentity: record.sourceIdentity,
    ...(record.sourcePath ? { sourcePath: record.sourcePath } : {}),
    ...(record.publishedFile ? { file: record.publishedFile } : {}),
    ...(record.versionAdded ? { versionAdded: record.versionAdded } : {}),
    ...(record.versionChanged ? { versionChanged: record.versionChanged } : {}),
    metadata: cleanJson(record.metadata) as Record<string, unknown>,
  });
}

export function manifestFromCatalog(catalog: Catalog, gameId: z.infer<typeof Game>, version: string, options: { sourceSnapshot?: string; generatedAt?: string } = {}): UnifiedAssetManifest {
  const publishedResources = new Set(catalog.resources.filter((resource) => resource.game === gameId && resource.lifecycle.status === "published").map((resource) => resource.id));
  const entries = assetRecordsFromCatalog(catalog)
    .filter((record) => record.gameId === gameId && publishedResources.has(record.assetId.split(":", 1)[0] ?? ""))
    .map(entryFromAssetRecord)
    .sort((left, right) => left.identityKey.localeCompare(right.identityKey));
  return UnifiedAssetManifest.parse({
    kind: "rhythm-unified-asset-manifest",
    schemaVersion: "1",
    gameId,
    version,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    sourceSnapshot: options.sourceSnapshot ?? `catalog:${catalog.catalogId}:${catalog.generatedAt}`,
    entries,
    notes: ["Generated from the validated formal Catalog; draft and tombstoned resources are excluded."],
  });
}

export async function manifestFromExtractorResult(result: ExtractorResult, options: { version?: string; generatedAt?: string } = {}): Promise<UnifiedAssetManifest> {
  const entries: UnifiedAssetManifestEntry[] = [];
  for (const candidate of result.candidates) {
    const provenance = candidate.provenance;
    const sourceIdentity = semanticIdentity({
      externalIdentities: candidate.suggestedExternalIdentity,
      addressablesKey: provenance?.addressablesKey,
      bundleName: provenance?.bundleName,
      objectPathId: provenance?.objectPathId,
      objectName: provenance?.objectName,
      sourceRelativePath: candidate.sourceRelativePath,
    }) ?? `candidate:${candidate.id ?? candidate.sourceRelativePath}`;
    const variantKey = candidate.suggestedVariant?.key ?? "default";
    const identityKey = releaseIdentityKey({ gameId: result.game, assetType: candidate.suggestedCategory, sourceIdentity, variantKey });
    const sha256 = provenance?.imageContentHash ?? candidate.sourceSha256 ?? provenance?.sourceHash;
    const extension = extensionFor(candidate.suggestedFilename);
    let sizeBytes: number | undefined;
    try { sizeBytes = (await stat(candidate.sourcePath)).size; } catch { /* a review package will retain the source path even when bytes are unavailable */ }
    const dimensions = provenance?.dimensions;
    const file = sha256 ? {
      sha256,
      objectId: `sha256:${sha256}`,
      ...(extension ? { objectKey: `objects/${sha256}/${extension}` } : {}),
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      ...(dimensions ? { width: dimensions.width, height: dimensions.height } : {}),
      ...(mimeFor(extension) ? { mime: mimeFor(extension) } : {}),
    } : undefined;
    const fallbackIdentity = sourceIdentity.startsWith("candidate:") || sourceIdentity.startsWith("path=");
    const metadata = cleanJson({
      ...candidate.metadata,
      confidence: candidate.confidence,
      detection: candidate.detection,
      sourceType: result.sourceType,
      ...(candidate.blockedReason ? { blockedReason: candidate.blockedReason } : {}),
    }) as Record<string, unknown>;
    entries.push(UnifiedAssetManifestEntry.parse({
      assetId: createDeterministicUuidV7(`asset:${identityKey}`),
      identityKey,
      gameId: result.game,
      assetType: candidate.suggestedCategory,
      variantKey,
      ...(candidate.suggestedTitle ? { title: candidate.suggestedTitle } : {}),
      ...(candidate.suggestedArtist ? { artist: candidate.suggestedArtist } : {}),
      aliases: [candidate.sourceFilename, candidate.suggestedFilename].filter((value, index, values) => values.indexOf(value) === index),
      sourceIdentity,
      sourcePath: candidate.sourceRelativePath,
      ...(file ? { file } : {}),
      ...(provenance?.baseVersion ? { versionAdded: provenance.baseVersion } : {}),
      versionChanged: result.targetVersion,
      metadata,
      needsReview: candidate.reviewRequirements.reviewRequired || fallbackIdentity || result.status !== "ok",
      needsRename: candidate.detection === "renamed" || candidate.reviewRequirements.manualNamingRequired,
      anomalies: [
        ...(fallbackIdentity ? ["stable source identity is weak or path-based"] : []),
        ...(candidate.blockedReason ? [candidate.blockedReason] : []),
      ],
    }));
  }
  return UnifiedAssetManifest.parse({
    kind: "rhythm-unified-asset-manifest",
    schemaVersion: "1",
    gameId: result.game,
    version: options.version ?? result.targetVersion,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    sourceSnapshot: result.sourceSnapshot,
    entries: entries.sort((left, right) => left.identityKey.localeCompare(right.identityKey)),
    notes: [...result.limitations, ...result.diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)],
  });
}

function fileDifference(current: UnifiedAssetManifestEntry, previous: UnifiedAssetManifestEntry): string[] {
  const reasons: string[] = [];
  const currentFile = current.file;
  const previousFile = previous.file;
  if (currentFile?.sha256 !== previousFile?.sha256) reasons.push("published file hash changed");
  else if (currentFile?.sizeBytes !== previousFile?.sizeBytes) reasons.push("published file size changed");
  if (currentFile?.objectKey !== previousFile?.objectKey) reasons.push("remote object key changed");
  return reasons;
}

function metadataDifference(current: UnifiedAssetManifestEntry, previous: UnifiedAssetManifestEntry): string[] {
  const reasons: string[] = [];
  if (current.title !== previous.title) reasons.push("title changed");
  if (current.artist !== previous.artist) reasons.push("artist changed");
  if (stableJson(current.aliases) !== stableJson(previous.aliases)) reasons.push("aliases changed");
  if (stableJson(current.metadata) !== stableJson(previous.metadata)) reasons.push("metadata changed");
  return reasons;
}

export function buildReleaseDelta(previous: UnifiedAssetManifest | undefined, current: UnifiedAssetManifest, options: { generatedAt?: string } = {}): ReleaseDelta {
  if (previous && previous.gameId !== current.gameId) throw new Error(`manifest game mismatch: ${previous.gameId} vs ${current.gameId}`);
  const previousByKey = new Map((previous?.entries ?? []).map((entry) => [entry.identityKey, entry]));
  const currentByKey = new Map<string, UnifiedAssetManifestEntry>();
  const duplicateKeys = new Set<string>();
  for (const entry of current.entries) {
    if (currentByKey.has(entry.identityKey)) duplicateKeys.add(entry.identityKey);
    currentByKey.set(entry.identityKey, entry);
  }
  const entries: ReleaseDeltaEntry[] = [];
  for (const currentEntry of current.entries) {
    const previousEntry = previousByKey.get(currentEntry.identityKey);
    const duplicate = duplicateKeys.has(currentEntry.identityKey);
    const anomalies = [...currentEntry.anomalies, ...(duplicate ? ["duplicate identity key in current manifest"] : [])];
    if (!previousEntry) {
      entries.push(ReleaseDeltaEntry.parse({ identityKey: currentEntry.identityKey, status: "NEW", current: currentEntry, reasons: ["identity is absent from previous manifest"], needsReview: currentEntry.needsReview || duplicate, needsRename: currentEntry.needsRename, anomalies }));
      continue;
    }
    const reasons = [...fileDifference(currentEntry, previousEntry), ...metadataDifference(currentEntry, previousEntry)];
    const status: ReleaseDeltaStatus = reasons.length > 0 ? "CHANGED" : "UNCHANGED";
    entries.push(ReleaseDeltaEntry.parse({ identityKey: currentEntry.identityKey, status, current: currentEntry, previous: previousEntry, reasons, needsReview: currentEntry.needsReview || duplicate || (status === "CHANGED" && currentEntry.needsRename), needsRename: currentEntry.needsRename, anomalies }));
  }
  for (const previousEntry of previous?.entries ?? []) {
    if (currentByKey.has(previousEntry.identityKey)) continue;
    entries.push(ReleaseDeltaEntry.parse({ identityKey: previousEntry.identityKey, status: "REMOVED", previous: previousEntry, reasons: ["identity is absent from current manifest"], needsReview: true, anomalies: ["removal is review-only; no storage deletion is implied"] }));
  }
  entries.sort((left, right) => left.identityKey.localeCompare(right.identityKey));
  const summary = {
    new: entries.filter((entry) => entry.status === "NEW").length,
    changed: entries.filter((entry) => entry.status === "CHANGED").length,
    removed: entries.filter((entry) => entry.status === "REMOVED").length,
    unchanged: entries.filter((entry) => entry.status === "UNCHANGED").length,
    reviewRequired: entries.filter((entry) => entry.needsReview || entry.status === "REMOVED").length,
  };
  return ReleaseDelta.parse({
    kind: "rhythm-release-delta",
    schemaVersion: "1",
    gameId: current.gameId,
    ...(previous?.version ? { previousVersion: previous.version } : {}),
    currentVersion: current.version,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    ...(previous?.sourceSnapshot ? { previousManifestSnapshot: previous.sourceSnapshot } : {}),
    currentManifestSnapshot: current.sourceSnapshot,
    entries,
    summary,
    notes: ["REMOVED entries are review-only and never authorize remote deletion by themselves."],
  });
}

export async function readUnifiedManifest(filePath: string): Promise<UnifiedAssetManifest> {
  return UnifiedAssetManifest.parse(JSON.parse(await readFile(filePath, "utf8")) as unknown);
}

export async function writeUnifiedManifest(manifest: UnifiedAssetManifest, filePath: string): Promise<void> {
  await atomicWriteJson(filePath, UnifiedAssetManifest.parse(manifest));
}

export async function readReleaseDelta(filePath: string): Promise<ReleaseDelta> {
  return ReleaseDelta.parse(JSON.parse(await readFile(filePath, "utf8")) as unknown);
}

export async function writeReleaseDelta(delta: ReleaseDelta, filePath: string): Promise<void> {
  await atomicWriteJson(filePath, ReleaseDelta.parse(delta));
}

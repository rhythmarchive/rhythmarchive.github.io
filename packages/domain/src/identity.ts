import { createHash, randomBytes } from "node:crypto";
import { Rendition, type Candidate, type Rendition as RenditionType } from "./schema.js";

export function createUuidV7(now = Date.now()): string {
  const bytes = randomBytes(16);
  let timestamp = Math.max(0, Math.floor(now));
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp & 0xff;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Map a business identity to a stable UUIDv7-shaped Resource/Variant/Rendition ID.
 * The digest is deterministic; the UUID version/variant bits remain standards-compliant.
 */
export function createDeterministicUuidV7(seed: string): string {
  if (!seed.trim()) throw new Error("deterministic UUID seed must not be empty");
  const bytes = createHash("sha256").update("rhythm-archive:" + seed, "utf8").digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
}

export function normalizeFilenameStem(filename: string): string {
  let stem = filename.normalize("NFC").trim();
  stem = stem.replace(/\.[^.\\/]+$/u, "");
  stem = stem.replace(/\.(?:jpe?g|png|webp)_(?:optimization|opt)$/iu, "");
  stem = stem.replace(/\.jpg_opt$/iu, "");
  stem = stem.replace(/(?:_optimization|_opt)$/iu, "");
  return stem.normalize("NFC").toLocaleLowerCase("en-US");
}

export function candidateFilenameAliases(candidate: Pick<Candidate, "naming" | "files">): string[] {
  const values = [
    candidate.naming.sourceFilename,
    candidate.naming.suggestedFilename,
    candidate.naming.reviewedFilename,
    candidate.naming.finalFilename,
    ...candidate.naming.knownBasenames,
    ...candidate.files.filter((file) => file.role === "raw-original" || file.role === "work-original" || file.role === "upscale-input").map((file) => file.filename),
  ];
  return [...new Set(values.filter((value): value is string => Boolean(value)).map(normalizeFilenameStem))];
}

export type CandidateFilenameAliasGroups = {
  current: string[];
  known: string[];
  suggested: string[];
  source: string[];
};

/**
 * Preserve evidence strength for external tools. A current reviewed/final
 * basename outranks a historical alias, which outranks the extractor
 * suggestion and finally the original source basename.
 */
export function candidateFilenameAliasGroups(candidate: Pick<Candidate, "naming" | "files">): CandidateFilenameAliasGroups {
  const current = [candidate.naming.finalFilename, candidate.naming.reviewedFilename].filter((value): value is string => Boolean(value));
  const source = [candidate.naming.sourceFilename];
  const suggested = [candidate.naming.suggestedFilename];
  const known = [
    ...candidate.naming.knownBasenames,
    ...candidate.files.filter((file) => file.role === "raw-original" || file.role === "work-original" || file.role === "upscale-input").map((file) => file.filename),
  ];
  const normalized = (values: string[]) => [...new Set(values.map(normalizeFilenameStem))];
  return { current: normalized(current), known: normalized(known), suggested: normalized(suggested), source: normalized(source) };
}

export function renameCandidate(candidate: Candidate, reviewedFilename: string, options: { finalize?: boolean } = {}): Candidate {
  if (!reviewedFilename || /[\\/\0]/.test(reviewedFilename)) throw new Error("reviewed filename must be a file name");
  const oldAliases = candidateFilenameAliases(candidate);
  const next = {
    ...candidate,
    naming: {
      ...candidate.naming,
      reviewedFilename,
      finalFilename: options.finalize ? reviewedFilename : candidate.naming.finalFilename,
      knownBasenames: [...new Set([
        ...candidate.naming.knownBasenames,
        candidate.naming.sourceFilename,
        candidate.naming.suggestedFilename,
        candidate.naming.reviewedFilename,
        candidate.naming.finalFilename,
      ].filter((value): value is string => Boolean(value)))],
    },
  };
  const nextAliases = candidateFilenameAliases(next);
  if (!nextAliases.some((alias) => oldAliases.includes(alias))) {
    throw new Error("renaming a Candidate must retain an existing filename alias");
  }
  return next;
}

export function objectIdFromSha256(sha256: string): string {
  if (!/^[0-9a-f]{64}$/i.test(sha256)) throw new Error("invalid sha256");
  return `sha256:${sha256.toLowerCase()}`;
}

export function immutableObjectKey(sha256: string, extension: string): string {
  const objectId = objectIdFromSha256(sha256);
  const normalizedExtension = extension.toLowerCase().replace(/^\./, "");
  if (!/^(?:jpg|jpeg|png|webp|avif|gif|ogg|bin)$/u.test(normalizedExtension)) throw new Error("invalid object extension");
  return `objects/${objectId.slice("sha256:".length)}/${normalizedExtension}`;
}

/**
 * Replace the bytes behind a long-lived semantic rendition. The rendition ID
 * is intentionally not regenerated: a Rendition is the role/slot, while the
 * content identity belongs to Object.
 */
export function replaceRenditionObject(rendition: RenditionType, nextObjectId: string): RenditionType {
  if (!/^sha256:[0-9a-f]{64}$/iu.test(nextObjectId)) throw new Error("invalid rendition Object id");
  return Rendition.parse({ ...rendition, objectId: nextObjectId });
}

export function renameRenditionDownloadFilename(rendition: RenditionType, downloadFilename: string): RenditionType {
  if (!downloadFilename || /[\\/\0]/.test(downloadFilename)) throw new Error("downloadFilename must be a file name");
  return Rendition.parse({ ...rendition, downloadFilename, displayFilename: undefined });
}

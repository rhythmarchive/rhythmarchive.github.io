import { Candidate, type Candidate as CandidateType, type ReviewRequirements as ReviewRequirementsType } from "./schema.js";
import { renameCandidate as renameCandidateIdentity } from "./identity.js";

export type ReviewPolicyInput = {
  game: "arcaea" | "phigros";
  resourceType: CandidateType["suggestedMapping"]["resourceType"];
  confidence: CandidateType["suggestedMapping"]["confidence"];
  suggestedTitle?: string | undefined;
  suggestedArtist?: string | undefined;
  suggestedFilename?: string | undefined;
  identityExact?: boolean | undefined;
  identityAmbiguous?: boolean | undefined;
  metadataComplete?: boolean | undefined;
  variantUnresolved?: boolean | undefined;
  evidenceKinds?: readonly string[] | undefined;
};

export type GameReviewPolicyInput = ReviewPolicyInput;

export const DEFAULT_REVIEW_REQUIREMENTS: ReviewRequirementsType = {
  reviewRequired: true,
  manualNamingRequired: false,
  metadataReviewRequired: false,
  identityReviewRequired: false,
  upscaleRecommended: false,
  upscaleRequired: false,
  reasons: [],
};

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isUpscaleEligible(game: "arcaea" | "phigros", resourceType: CandidateType["suggestedMapping"]["resourceType"]): boolean {
  return game === "arcaea" && resourceType === "jacket";
}

/**
 * Game-specific review policy.  A review is a human confirmation step; a
 * naming edit is an exceptional correction and is tracked separately.
 */
export function applyReviewPolicy(input: GameReviewPolicyInput): ReviewRequirementsType {
  const reasons: string[] = [];
  const isJacket = input.resourceType === "jacket";
  const upscaleEligible = isUpscaleEligible(input.game, input.resourceType);
  const manualNamingRequired = !hasText(input.suggestedFilename) || input.confidence === "low" || input.confidence === "unknown";
  if (!hasText(input.suggestedFilename)) reasons.push("filename proposal missing");
  if (manualNamingRequired && hasText(input.suggestedFilename)) reasons.push("filename proposal has low confidence");

  const identityAmbiguous = input.identityAmbiguous === true || (isJacket && input.identityExact === false);
  if (identityAmbiguous) reasons.push("external identity is ambiguous");

  if (input.game === "arcaea") {
    const metadataReviewRequired = !hasText(input.suggestedTitle) && isJacket;
    if (metadataReviewRequired) reasons.push("Arcaea title metadata is missing");
    if (input.variantUnresolved) reasons.push("variant semantics are unresolved");
    return {
      reviewRequired: true,
      manualNamingRequired,
      metadataReviewRequired,
      identityReviewRequired: identityAmbiguous,
      upscaleRecommended: upscaleEligible,
      upscaleRequired: false,
      reasons,
    };
  }

  const metadataComplete = input.metadataComplete ?? (hasText(input.suggestedTitle) && hasText(input.suggestedArtist));
  const metadataReviewRequired = !metadataComplete;
  if (!hasText(input.suggestedTitle)) reasons.push("title is missing or incomplete");
  if (!hasText(input.suggestedArtist)) reasons.push("artist is missing or incomplete");
  if (metadataReviewRequired && metadataComplete === false && reasons.length === 0) reasons.push("Phigros metadata requires human verification");
  if (input.variantUnresolved) reasons.push("variant semantics are unresolved");
  return {
    reviewRequired: true,
    // Phigros does not require a rename merely because metadata needs review.
    manualNamingRequired,
    metadataReviewRequired,
    identityReviewRequired: identityAmbiguous,
    upscaleRecommended: false,
    upscaleRequired: false,
    reasons,
  };
}

export type ReviewOverrides = CandidateType["review"]["overrides"];

function hasMetadataOverride(overrides: ReviewOverrides): boolean {
  return Boolean(overrides.title || overrides.artist || overrides.metadata && Object.keys(overrides.metadata).length > 0);
}

export function effectiveCandidateTitle(candidate: CandidateType): string | undefined {
  return candidate.review.overrides.title ?? candidate.suggestedMapping.title;
}

export function effectiveCandidateArtist(candidate: CandidateType): string | undefined {
  const override = candidate.review.overrides.artist;
  const metadataArtist = candidate.suggestedMapping.metadata.artist;
  return override ?? (typeof metadataArtist === "string" ? metadataArtist : undefined);
}

export function effectiveCandidateMetadata(candidate: CandidateType): Record<string, unknown> {
  const metadata = { ...candidate.suggestedMapping.metadata, ...(candidate.review.overrides.metadata ?? {}) };
  if (candidate.review.overrides.artist) metadata.artist = candidate.review.overrides.artist;
  return metadata;
}

export function effectiveCandidateResourceType(candidate: CandidateType): CandidateType["suggestedMapping"]["resourceType"] {
  return candidate.review.overrides.resourceType ?? candidate.suggestedMapping.resourceType;
}

export function effectiveCandidateVariantKey(candidate: CandidateType): string | undefined {
  return candidate.review.overrides.variantKey ?? candidate.suggestedMapping.variantKey;
}

export function effectiveCandidateFilename(candidate: CandidateType): string {
  return candidate.naming.finalFilename ?? candidate.naming.reviewedFilename ?? candidate.naming.suggestedFilename;
}

export function metadataReviewSatisfied(candidate: CandidateType): boolean {
  if (!candidate.reviewRequirements.metadataReviewRequired) return true;
  const reasons = new Set(candidate.reviewRequirements.reasons);
  const titleSatisfied = ![...reasons].some((reason) => reason.includes("title")) || Boolean(effectiveCandidateTitle(candidate));
  const artistSatisfied = ![...reasons].some((reason) => reason.includes("artist")) || Boolean(effectiveCandidateArtist(candidate));
  return titleSatisfied && artistSatisfied && (hasMetadataOverride(candidate.review.overrides) || Boolean(candidate.suggestedMapping.title && candidate.suggestedMapping.metadata.artist));
}

export function identityReviewSatisfied(candidate: CandidateType): boolean {
  return !candidate.reviewRequirements.identityReviewRequired || Boolean(candidate.target?.resourceId || candidate.review.overrides.resourceId);
}

export function candidateCanBeConfirmed(candidate: CandidateType): { ok: true } | { ok: false; reason: string } {
  if (candidate.status === "REJECTED") return { ok: false, reason: "REJECTED Candidate cannot be confirmed" };
  if (candidate.status === "BLOCKED") return { ok: false, reason: "BLOCKED Candidate must be resolved before confirmation" };
  if (!identityReviewSatisfied(candidate)) return { ok: false, reason: "external identity resolution is required before confirmation" };
  if (!metadataReviewSatisfied(candidate)) return { ok: false, reason: "metadata override or explicit complete metadata is required before confirmation" };
  return { ok: true };
}

function timestamp(value?: Date | string): string {
  const result = value instanceof Date ? value.toISOString() : value ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(result))) throw new Error(`invalid timestamp: ${result}`);
  return result;
}

export function confirmCandidate(candidate: CandidateType, options: {
  decision?: NonNullable<CandidateType["review"]["decision"]> | undefined;
  note?: string | undefined;
  now?: Date | string | undefined;
} = {}): CandidateType {
  const allowed = candidateCanBeConfirmed(candidate);
  if (!allowed.ok) throw new Error(allowed.reason);
  const at = timestamp(options.now);
  return Candidate.parse({
    ...candidate,
    status: candidate.status === "EXTRACTED" ? "NAMING_REVIEW" : candidate.status,
    review: {
      ...candidate.review,
      state: "approved",
      decision: options.decision ?? candidate.review.decision ?? "accept-new-rendition",
      reviewedAt: at,
      confirmed: true,
      confirmedAt: at,
      note: options.note ?? candidate.review.note ?? "human review confirmed; automatic proposals retained",
    },
  });
}

export type CandidateMetadataOverride = {
  title?: string;
  artist?: string;
  filename?: string;
  resourceType?: CandidateType["suggestedMapping"]["resourceType"];
  variantKey?: string;
  metadata?: Record<string, unknown>;
  resourceId?: string;
  variantId?: string;
  renditionId?: string;
  relatedResourceId?: string;
};

export function overrideCandidateMetadata(candidate: CandidateType, override: CandidateMetadataOverride, options: { now?: Date | string | undefined; note?: string | undefined } = {}): CandidateType {
  if (!Object.values(override).some((value) => value !== undefined)) throw new Error("metadata override must change at least one field");
  const at = timestamp(options.now);
  const next: CandidateType = {
    ...candidate,
    status: candidate.status === "BLOCKED" && !candidate.reviewRequirements.identityReviewRequired ? "NAMING_REVIEW" : candidate.status,
    review: {
      ...candidate.review,
      state: candidate.status === "BLOCKED" && candidate.reviewRequirements.identityReviewRequired ? "blocked" : "naming-review",
      confirmed: false,
      confirmedAt: undefined,
      reviewedAt: undefined,
      note: options.note ?? "metadata override recorded; human confirmation is still required",
      overrides: {
        ...candidate.review.overrides,
        ...(override.title !== undefined ? { title: override.title } : {}),
        ...(override.artist !== undefined ? { artist: override.artist } : {}),
        ...(override.filename !== undefined ? { filename: override.filename } : {}),
        ...(override.resourceType !== undefined ? { resourceType: override.resourceType } : {}),
        ...(override.variantKey !== undefined ? { variantKey: override.variantKey } : {}),
        ...(override.metadata !== undefined ? { metadata: { ...(candidate.review.overrides.metadata ?? {}), ...override.metadata } } : {}),
        ...(override.resourceId !== undefined ? { resourceId: override.resourceId } : {}),
        ...(override.variantId !== undefined ? { variantId: override.variantId } : {}),
        ...(override.renditionId !== undefined ? { renditionId: override.renditionId } : {}),
        ...(override.relatedResourceId !== undefined ? { relatedResourceId: override.relatedResourceId } : {}),
      },
    },
  };
  // Keep the automatic mapping intact.  The override is deliberately stored
  // under review so provenance and extractor evidence remain auditable.
  void at;
  return Candidate.parse(next);
}

export function overrideCandidateFilename(candidate: CandidateType, filename: string, options: { now?: Date | string | undefined; finalize?: boolean | undefined; note?: string | undefined } = {}): CandidateType {
  const renamed = renameCandidateIdentity(candidate, filename, { finalize: options.finalize ?? true });
  return Candidate.parse({
    ...renamed,
    review: {
      ...renamed.review,
      state: "naming-review",
      confirmed: false,
      confirmedAt: undefined,
      reviewedAt: undefined,
      note: options.note ?? "filename override recorded; human confirmation is still required",
      overrides: { ...renamed.review.overrides, filename },
    },
  });
}

export function resolveCandidateIdentity(candidate: CandidateType, identity: {
  resourceId: string;
  variantId?: string;
  renditionId?: string;
  relatedResourceId?: string;
}, options: { now?: Date | string | undefined; note?: string | undefined } = {}): CandidateType {
  const at = timestamp(options.now);
  const target = {
    ...(candidate.target ?? {}),
    resourceId: identity.resourceId,
    ...(identity.variantId ? { variantId: identity.variantId } : {}),
    ...(identity.renditionId ? { renditionId: identity.renditionId } : {}),
  };
  const nextOverrides = {
    ...candidate.review.overrides,
    resourceId: identity.resourceId,
    ...(identity.variantId ? { variantId: identity.variantId } : {}),
    ...(identity.renditionId ? { renditionId: identity.renditionId } : {}),
    ...(identity.relatedResourceId ? { relatedResourceId: identity.relatedResourceId } : {}),
  };
  const metadataResolved = metadataReviewSatisfied({ ...candidate, target, review: { ...candidate.review, overrides: nextOverrides } });
  const nextStatus = candidate.status === "BLOCKED" && metadataResolved ? "NAMING_REVIEW" : candidate.status;
  const nextProcessing = candidate.processing.state === "blocked" && nextStatus !== "BLOCKED"
    ? { ...candidate.processing, state: candidate.processing.requiresUpscale ? "needs-upscale" as const : "not-required" as const, note: undefined }
    : candidate.processing;
  return Candidate.parse({
    ...candidate,
    status: nextStatus,
    target,
    processing: nextProcessing,
    review: {
      ...candidate.review,
      state: nextStatus === "BLOCKED" ? "blocked" : "naming-review",
      confirmed: false,
      confirmedAt: undefined,
      reviewedAt: undefined,
      note: options.note ?? "external identity resolved; human confirmation is still required",
      overrides: nextOverrides,
    },
  });
}

import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Candidate, type Candidate as CandidateType, type Catalog as CatalogType, type Resource, type Variant, type Rendition } from "./schema.js";
import { createUuidV7 } from "./identity.js";
import { effectiveCandidateMetadata, effectiveCandidateResourceType, effectiveCandidateTitle, effectiveCandidateVariantKey } from "./review.js";

export type SemanticSourceRecord = {
  identity?: string | undefined;
  sourceRelativePath?: string | undefined;
  contentHash?: string | undefined;
  metadataFingerprint?: string | undefined;
  game: "arcaea" | "phigros";
  resourceType: CandidateType["suggestedMapping"]["resourceType"];
  variantKey?: string | undefined;
  candidateId?: string | undefined;
  resourceId?: string | undefined;
  variantId?: string | undefined;
  renditionId?: string | undefined;
  detail?: string | undefined;
};

export type UpdateDiffKind = "added" | "content-changed" | "metadata-only" | "unchanged" | "unmatched" | "removed";

export type UpdateDiffEntry = SemanticSourceRecord & {
  kind: UpdateDiffKind;
  matchedRecord?: SemanticSourceRecord;
};

export type UpdateDiffSummary = {
  added: number;
  contentChanged: number;
  metadataOnly: number;
  unchanged: number;
  unmatched: number;
  removed: number;
};

export type UpdateDiffResult = {
  entries: UpdateDiffEntry[];
  removed: UpdateDiffEntry[];
  summary: UpdateDiffSummary;
};

export type CandidateCatalogMatch = {
  candidate: CandidateType;
  kind: UpdateDiffKind;
  matches: SemanticSourceRecord[];
  target?: NonNullable<CandidateType["target"]>;
};

export type PhigrosImageRecord = {
  bundlePath: string;
  objectName: string;
  objectPathId?: string | undefined;
  imageContentHash: string;
  resourceType?: CandidateType["suggestedMapping"]["resourceType"] | undefined;
  sourceKey?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export type SourceInventoryRecord = {
  game: "arcaea" | "phigros";
  resourceType: CandidateType["suggestedMapping"]["resourceType"];
  sourceKey?: string | undefined;
  sourceKeyType?: string | undefined;
  variantKey?: string | undefined;
  sourceRelativePath?: string | undefined;
  bundle?: string | undefined;
  objectName?: string | undefined;
  objectPathId?: string | undefined;
  imageContentHash?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
};

function normalize(value: string): string {
  return value.trim().normalize("NFC").toLocaleLowerCase("en-US");
}

function confidenceRank(value: string): number {
  return value === "high" ? 3 : value === "medium" ? 2 : value === "low" ? 1 : 0;
}

function identityPriority(key: string): number {
  return ["songId", "addressablesKey", "assetKey", "sourceKey", "bundleObject", "bundlePath", "objectName", "path"].indexOf(key) + 1;
}

/**
 * Stable identity deliberately does not use a bare filename. Strong source
 * identities win; bundle/path identity is only a fallback and remains
 * reviewable when it is ambiguous.
 */
export function semanticIdentity(input: {
  externalIdentities?: ReadonlyArray<{ namespace: string; key: string; value: string; confidence: string }> | undefined;
  addressablesKey?: string | undefined;
  bundleName?: string | undefined;
  objectPathId?: string | undefined;
  objectName?: string | undefined;
  sourceRelativePath?: string | undefined;
}): string | undefined {
  const candidates = (input.externalIdentities ?? [])
    .filter((item) => item.value.trim())
    .map((item) => ({
      value: `${normalize(item.namespace)}:${normalize(item.key)}=${normalize(item.value)}`,
      confidence: confidenceRank(item.confidence),
      priority: identityPriority(item.key),
    }))
    .sort((left, right) => right.confidence - left.confidence || right.priority - left.priority || left.value.localeCompare(right.value));
  if (candidates[0]) return candidates[0].value;
  if (input.addressablesKey) return `phigros:addressableskey=${normalize(input.addressablesKey)}`;
  const objectIdentity = input.objectPathId ?? input.objectName;
  if (input.bundleName && objectIdentity) return `bundle=${normalize(input.bundleName)}::object=${normalize(objectIdentity)}`;
  if (input.sourceRelativePath) return `path=${normalize(input.sourceRelativePath).replace(/\\/g, "/")}`;
  return undefined;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

function metadataFingerprint(value: unknown): string {
  return stableJson(value);
}

function emptySummary(): UpdateDiffSummary {
  return { added: 0, contentChanged: 0, metadataOnly: 0, unchanged: 0, unmatched: 0, removed: 0 };
}

function increment(summary: UpdateDiffSummary, kind: UpdateDiffKind): void {
  if (kind === "content-changed") summary.contentChanged += 1;
  else if (kind === "metadata-only") summary.metadataOnly += 1;
  else if (kind === "added") summary.added += 1;
  else if (kind === "unchanged") summary.unchanged += 1;
  else if (kind === "unmatched") summary.unmatched += 1;
  else summary.removed += 1;
}

export function classifySemanticDiff(oldRecords: ReadonlyArray<SemanticSourceRecord>, newRecords: ReadonlyArray<SemanticSourceRecord>): UpdateDiffResult {
  const oldByIdentity = new Map<string, SemanticSourceRecord[]>();
  for (const record of oldRecords) {
    if (!record.identity) continue;
    const entries = oldByIdentity.get(record.identity) ?? [];
    entries.push(record);
    oldByIdentity.set(record.identity, entries);
  }
  const seenOld = new Set<SemanticSourceRecord>();
  const summary = emptySummary();
  const entries: UpdateDiffEntry[] = [];
  const newIdentityCounts = new Map<string, number>();
  for (const record of newRecords) {
    if (!record.identity) continue;
    const key = `${record.identity}::variant=${record.variantKey ?? ""}`;
    newIdentityCounts.set(key, (newIdentityCounts.get(key) ?? 0) + 1);
  }
  for (const record of newRecords) {
    if (!record.identity) {
      const entry = { ...record, kind: "unmatched" as const };
      entries.push(entry);
      increment(summary, entry.kind);
      continue;
    }
    const identityMatches = oldByIdentity.get(record.identity) ?? [];
    // A Resource identity can legitimately have multiple semantic Variants
    // (for example Arcaea difficulty jackets). Prefer the same variant before
    // declaring an identity ambiguous; when one side has no variant, retain
    // the existing identity-only fallback.
    const matches = record.variantKey
      ? identityMatches.filter((oldRecord) => !oldRecord.variantKey || oldRecord.variantKey === record.variantKey)
      : identityMatches;
    const duplicateNewIdentity = (newIdentityCounts.get(`${record.identity}::variant=${record.variantKey ?? ""}`) ?? 0) > 1;
    let kind: UpdateDiffKind;
    const matchedRecord = matches.length === 1 ? matches[0] : undefined;
    if (duplicateNewIdentity) kind = "unmatched";
    else if (matches.length !== 1) kind = matches.length === 0 ? "added" : "unmatched";
    else if (record.contentHash && matchedRecord?.contentHash && normalize(record.contentHash) !== normalize(matchedRecord.contentHash)) kind = "content-changed";
    else if (record.metadataFingerprint && matchedRecord?.metadataFingerprint && record.metadataFingerprint !== matchedRecord.metadataFingerprint) kind = "metadata-only";
    else kind = "unchanged";
    const entry = { ...record, kind, ...(matchedRecord ? { matchedRecord } : {}) };
    entries.push(entry);
    increment(summary, kind);
    if (matchedRecord) seenOld.add(matchedRecord);
  }
  const removed = oldRecords.filter((record) => record.identity && !seenOld.has(record)).map((record) => ({ ...record, kind: "removed" as const }));
  for (const entry of removed) increment(summary, entry.kind);
  return { entries, removed, summary };
}

/**
 * Phigros bundle names are only a fast filter. The final decision is made on
 * extracted image bytes for the same bundle/object identity, so a changed
 * image inside an unchanged bundle path becomes `content-changed`.
 */
export function classifyPhigrosContentDiff(oldRecords: ReadonlyArray<PhigrosImageRecord>, newRecords: ReadonlyArray<PhigrosImageRecord>): UpdateDiffResult {
  const toSourceRecord = (record: PhigrosImageRecord): SemanticSourceRecord => ({
    identity: record.sourceKey ? `phigros:addressableskey=${normalize(record.sourceKey)}` : `bundle=${normalize(record.bundlePath)}::object=${normalize(record.objectPathId || record.objectName)}`,
    sourceRelativePath: record.bundlePath,
    contentHash: record.imageContentHash,
    metadataFingerprint: metadataFingerprint(record.metadata ?? { objectName: record.objectName, resourceType: record.resourceType ?? "jacket" }),
    game: "phigros",
    resourceType: record.resourceType ?? "jacket",
    detail: `${record.bundlePath}::${record.objectPathId || record.objectName}`,
  });
  return classifySemanticDiff(oldRecords.map(toSourceRecord), newRecords.map(toSourceRecord));
}

function catalogRecord(resource: Resource, variant: Variant, rendition: Rendition, catalog: CatalogType): SemanticSourceRecord {
  const provenance = resource.provenance[0];
  const object = catalog.objects.find((item) => item.id === rendition.objectId);
  const imageContentHash = object?.provenance
    .flatMap((item) => item.evidence)
    .map((item) => item.detail.match(/^image-content-sha256:([0-9a-f]{64})$/iu)?.[1])
    .find((value): value is string => Boolean(value));
  return {
    // Historical migration rows do not contain a stable source identity. Do
    // not turn their display filename into an automatic added/removed claim.
    identity: resource.externalIdentities.length > 0
      ? semanticIdentity({ externalIdentities: resource.externalIdentities, sourceRelativePath: provenance?.sourceRelativePath })
      : undefined,
    sourceRelativePath: provenance?.sourceRelativePath,
    contentHash: imageContentHash ?? object?.sha256,
    metadataFingerprint: metadataFingerprint({ title: resource.title, metadata: resource.metadata, resourceType: resource.resourceType, variantKey: variant.variantKey }),
    game: resource.game === "arcaea" || resource.game === "phigros" ? resource.game : (() => { throw new Error("Rizline is not an APK diff source"); })(),
    resourceType: resource.resourceType,
    variantKey: variant.variantKey,
    resourceId: resource.id,
    variantId: variant.id,
    renditionId: rendition.id,
    detail: `${resource.id}/${variant.variantKey}/${rendition.renditionType}`,
  };
}

export function catalogSourceRecords(catalog: CatalogType, game?: "arcaea" | "phigros"): SemanticSourceRecord[] {
  const resources = catalog.resources.filter((resource) => !game || resource.game === game);
  const variantsByResource = new Map<string, Variant[]>();
  for (const variant of catalog.variants) {
    const list = variantsByResource.get(variant.resourceId) ?? [];
    list.push(variant);
    variantsByResource.set(variant.resourceId, list);
  }
  const records: SemanticSourceRecord[] = [];
  for (const resource of resources) {
    for (const variant of variantsByResource.get(resource.id) ?? []) {
      const original = catalog.renditions.find((rendition) => rendition.variantId === variant.id && rendition.renditionType === "original")
        ?? catalog.renditions.find((rendition) => rendition.variantId === variant.id);
      if (original) records.push(catalogRecord(resource, variant, original, catalog));
    }
  }
  return records;
}

export function candidateSourceRecord(candidate: CandidateType): SemanticSourceRecord {
  const provenance = candidate.provenance;
  const currentWorkFile = candidate.files.find((file) => file.role === "work-original" && file.availability === "present");
  return {
    identity: semanticIdentity({ externalIdentities: candidate.suggestedMapping.externalIdentities, addressablesKey: provenance?.addressablesKey, bundleName: provenance?.bundleName, objectPathId: provenance?.objectPathId, objectName: provenance?.objectName, sourceRelativePath: candidate.sourceEvidence.sourceRelativePath }),
    sourceRelativePath: candidate.sourceEvidence.sourceRelativePath,
    contentHash: currentWorkFile?.sha256 ?? provenance?.imageContentHash ?? candidate.sourceEvidence.sourceSha256 ?? provenance?.sourceHash,
    metadataFingerprint: metadataFingerprint({ title: effectiveCandidateTitle(candidate), metadata: effectiveCandidateMetadata(candidate), resourceType: effectiveCandidateResourceType(candidate), variantKey: effectiveCandidateVariantKey(candidate) }),
    game: candidate.sourceEvidence.sourceType === "phigros_apk" ? "phigros" : "arcaea",
    resourceType: effectiveCandidateResourceType(candidate),
    variantKey: effectiveCandidateVariantKey(candidate),
    candidateId: candidate.id,
    detail: candidate.sourceEvidence.sourceFilename,
  };
}

export function sourceInventoryRecord(record: SourceInventoryRecord): SemanticSourceRecord {
  const externalIdentities = record.sourceKey
    ? [{ namespace: record.game, key: record.sourceKeyType ?? (record.game === "phigros" ? "addressablesKey" : "sourceKey"), value: record.sourceKey, confidence: "high" }]
    : record.bundle && (record.objectPathId || record.objectName)
      ? [{ namespace: "phigros", key: "bundleObject", value: `${record.bundle}::${record.objectPathId || record.objectName}`, confidence: "high" }]
      : undefined;
  return {
    identity: semanticIdentity({ externalIdentities, addressablesKey: record.sourceKey, bundleName: record.bundle, objectPathId: record.objectPathId, objectName: record.objectName, sourceRelativePath: record.sourceRelativePath }),
    sourceRelativePath: record.sourceRelativePath ?? record.sourceKey ?? record.bundle,
    contentHash: record.imageContentHash,
    metadataFingerprint: record.metadata && Object.keys(record.metadata).length > 0 ? metadataFingerprint(record.metadata) : undefined,
    game: record.game,
    resourceType: record.resourceType,
    ...(record.variantKey ? { variantKey: record.variantKey } : {}),
    detail: `${record.bundle ?? record.sourceKey ?? record.sourceRelativePath ?? "inventory"}::${record.objectPathId ?? record.objectName ?? "source"}`,
  };
}

export function classifyCandidatesAgainstCatalog(candidates: ReadonlyArray<CandidateType>, catalog: CatalogType): CandidateCatalogMatch[] {
  const records = catalogSourceRecords(catalog);
  return candidates.map((candidate) => {
    const source = candidateSourceRecord(candidate);
    const matches = source.identity ? records.filter((record) => record.identity === source.identity && record.game === source.game && record.resourceType === source.resourceType && (!source.variantKey || !record.variantKey || source.variantKey === record.variantKey)) : [];
    const diff = classifySemanticDiff(matches, [source]).entries[0];
    const kind = matches.length === 1 && diff ? diff.kind : matches.length > 1 || !source.identity ? "unmatched" : "added";
    if (matches.length !== 1) return { candidate, kind, matches };
    const match = matches[0]!;
    const variants = catalog.variants.filter((variant) => variant.id === match.variantId);
    const variant = variants[0];
    if (!variant || !match.resourceId || !match.variantId) return { candidate, kind: "unmatched" as const, matches };
    const renditionCandidates = catalog.renditions.filter((rendition) => rendition.variantId === variant.id);
    const originalRendition = renditionCandidates.find((rendition) => rendition.renditionType === "original");
    const preferred = candidate.processing.requiresUpscale
      ? renditionCandidates.find((rendition) => rendition.renditionType === "upscaled") ?? (originalRendition ? { ...originalRendition, id: createUuidV7() } : undefined)
      : renditionCandidates.find((rendition) => rendition.renditionType === "original") ?? renditionCandidates[0];
    const target = preferred ? { resourceId: match.resourceId, variantId: match.variantId, renditionId: preferred.id, ...(candidate.processing.requiresUpscale && originalRendition && preferred.id !== originalRendition.id ? { sourceRenditionId: originalRendition.id } : {}), ...(candidate.target?.downloadFilename ? { downloadFilename: candidate.target.downloadFilename } : {}) } : undefined;
    return { candidate, kind, matches, ...(target ? { target } : {}) };
  });
}

export function applyCatalogTargets(candidates: ReadonlyArray<CandidateType>, catalog: CatalogType): { candidates: CandidateType[]; diff: UpdateDiffResult } {
  const matches = classifyCandidatesAgainstCatalog(candidates, catalog);
  const diffEntries: UpdateDiffEntry[] = matches.map((match) => {
    const source = candidateSourceRecord(match.candidate);
    const matchedRecord = match.matches.length === 1 ? match.matches[0] : undefined;
    return { ...source, kind: match.kind, ...(matchedRecord ? { matchedRecord } : {}) };
  });
  const diffSummary = emptySummary();
  for (const entry of diffEntries) increment(diffSummary, entry.kind);
  const diff: UpdateDiffResult = { entries: diffEntries, removed: [], summary: diffSummary };
  const next = matches.map(({ candidate, kind, matches: candidatesMatches, target }) => {
    if (candidate.target || !target) {
      if (kind === "unmatched" && candidatesMatches.length > 1 && !candidate.reviewRequirements.identityReviewRequired) {
        return Candidate.parse({ ...candidate, status: "BLOCKED", review: { ...candidate.review, state: "blocked", confirmed: false, confirmedAt: undefined, note: "stable source identity matched more than one Catalog Resource" }, reviewRequirements: { ...candidate.reviewRequirements, identityReviewRequired: true, reasons: [...new Set([...candidate.reviewRequirements.reasons, "stable source identity is ambiguous"]) ] } });
      }
      return Candidate.parse({ ...candidate, sourceEvidence: { ...candidate.sourceEvidence, changeKind: kind } });
    }
    return Candidate.parse({ ...candidate, sourceEvidence: { ...candidate.sourceEvidence, changeKind: kind }, target });
  });
  return { candidates: next, diff };
}

export async function writeUpdateDiff(rootPath: string, diff: UpdateDiffResult): Promise<void> {
  const filePath = path.join(path.resolve(rootPath), "metadata", "update-diff.json");
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.partial-${process.pid}-${createUuidV7()}`;
  await writeFile(temporaryPath, `${JSON.stringify({ schemaVersion: "1.0", generatedAt: new Date().toISOString(), ...diff }, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

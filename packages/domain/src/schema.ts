import { z } from "zod";

/**
 * These versions deliberately live next to each other instead of being one
 * shared contract.  They currently happen to have the same value, but each
 * document family can evolve independently in a later phase.
 */
export const CATALOG_SCHEMA_VERSION = "1.0" as const;
export const WORKSPACE_SCHEMA_VERSION = "1.0" as const;
export const RELEASE_SCHEMA_VERSION = "1.0" as const;
export const PUBLISH_PLAN_SCHEMA_VERSION = "1.0" as const;

/** Phase 2A compatibility name for callers that still inspect schemaVersion. */
export const SCHEMA_VERSION = WORKSPACE_SCHEMA_VERSION;

const UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "must be a UUID");
const UUIDV7 = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, "must be an RFC 9562 UUIDv7");
const SHA256 = z.string().regex(/^[0-9a-f]{64}$/i, "must be a SHA-256 hex digest");
const ISO_DATE = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "must be an ISO-like timestamp");
const MIME = z.enum(["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif", "application/octet-stream"]);
const EXTENSION = z.enum(["jpg", "jpeg", "png", "webp", "avif", "gif", "bin"]);
const FILE_NAME = z.string().min(1).refine((value) => !/[\\/\0]/.test(value), "must be a file name, not a path");
const PORTABLE_RELATIVE_PATH = z.string().min(1).refine((value) => {
  if (value.includes("\0")) return false;
  if (/^[a-zA-Z]:/.test(value)) return false;
  if (/^[a-zA-Z]:[\\/]/.test(value) || /^\\\\/.test(value) || value.startsWith("/") || value.startsWith("\\")) return false;
  return !value.split(/[\\/]+/).includes("..");
}, "must be a portable relative path");
const ABSOLUTE_LOCAL_PATH = z.string().min(1).refine((value) => /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\/.test(value) || value.startsWith("/"), "must be a local absolute path");
const LEGACY_CATALOG_SCHEMA_VERSION = z.literal(CATALOG_SCHEMA_VERSION).optional();
const LEGACY_WORKSPACE_SCHEMA_VERSION = z.literal(WORKSPACE_SCHEMA_VERSION).optional();
const LEGACY_RELEASE_SCHEMA_VERSION = z.literal(RELEASE_SCHEMA_VERSION).optional();
const LEGACY_PUBLISH_PLAN_SCHEMA_VERSION = z.literal(PUBLISH_PLAN_SCHEMA_VERSION).optional();

const JsonPrimitive = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const JsonValue: z.ZodType<unknown> = z.lazy(() => z.union([JsonPrimitive, z.array(JsonValue), z.record(z.string(), JsonValue)]));

export const Game = z.enum(["arcaea", "phigros", "rizline", "infalsus", "rotaeno", "paradigm-reboot"]);
export const LegacyGame = z.enum(["arcaea", "phigros"]);
export const ResourceType = z.enum([
  "jacket",
  "special-art",
  "rizcard-layout",
  "track-series",
  "rizcard",
  "pack-cover",
  "background",
  "character-portrait",
  "character-avatar",
  "linkplay-preview",
  "sticker",
  "story-cg",
  "story-texture",
  "startup",
  "world-mode",
  "phigros-april-fools",
  "other",
]);
export const SourceType = z.enum(["legacy", "arcaea_apk", "phigros_apk", "rizline_remote", "infalsus_demo", "rotaeno_apk", "paradigm_apk", "manual"]);
export const Confidence = z.enum(["high", "medium", "low", "unknown"]);
export const Difficulty = z.enum(["PST", "PRS", "FTR", "BYD", "ETR", "INSCRIBED"]);
export const VariantKind = z.enum(["default", "difficulty", "event", "source-path", "manual", "unknown"]);
export const VariantSemanticStatus = z.enum(["confirmed", "manual", "unresolved"]);
export const RenditionType = z.enum(["original", "upscaled", "thumbnail-320", "thumbnail-640", "thumbnail-1280", "other-derived"]);
export const RenditionOrigin = z.enum(["source", "derived"]);
export const CandidateStatus = z.enum([
  "EXTRACTED",
  "NAMING_REVIEW",
  "NEEDS_UPSCALE",
  "UPSCALE_PENDING",
  "UPSCALE_DETECTED",
  "UPSCALE_CONVERTED",
  "FINAL_REVIEW",
  "READY",
  "REJECTED",
  "BLOCKED",
]);
export const ReviewState = z.enum(["not-started", "naming-review", "final-review", "approved", "rejected", "blocked"]);
export const ReviewDecision = z.enum([
  "accept-existing-resource",
  "accept-new-resource",
  "accept-new-variant",
  "accept-new-rendition",
  "alias-candidate",
  "reject",
  "needs-metadata",
  "block",
]);
export const ProcessingState = z.enum([
  "not-required",
  "needs-upscale",
  "upscale-pending",
  "upscale-detected",
  "upscale-converted",
  "ready",
  "blocked",
]);
export const UpdateBatchStatus = z.enum(["CREATED", "EXTRACTED", "IN_REVIEW", "PROCESSING", "READY_TO_PUBLISH", "PUBLISHED", "CLEANED", "BLOCKED"]);
export const UpdateChangeKind = z.enum(["added", "content-changed", "metadata-only", "unchanged", "unmatched", "removed"]);
export const ChangeType = z.enum(["added-resource", "added-variant", "added-rendition", "replaced-rendition", "metadata-changed", "alias-added", "removed-from-current-source"]);

export const ExternalIdentity = z.object({
  namespace: z.string().min(1),
  key: z.string().min(1),
  value: z.string().min(1),
  source: z.enum(["apk-metadata", "filename", "legacy-index", "phigros-key", "story-metadata", "manual", "remote-canonical", "unknown"]),
  confidence: Confidence,
});

export const Alias = z.object({
  value: z.string().min(1),
  kind: z.enum(["filename", "title", "legacy-path", "same-hash", "external-id"]),
  note: z.string().min(1).optional(),
});

export const Evidence = z.object({
  kind: z.enum(["source-path", "apk-relative-path", "filename-parser", "metadata", "sha256", "normalized-pair", "visual-review", "history-report", "manual-note"]),
  detail: z.string().min(1),
  confidence: Confidence,
});

export const CatalogProvenance = z.object({
  sourceType: SourceType,
  sourceSnapshot: z.string().min(1).optional(),
  gameVersion: z.string().min(1).optional(),
  sourceRelativePath: PORTABLE_RELATIVE_PATH,
  sourceFilename: FILE_NAME,
  sourceSha256: SHA256,
  evidence: z.array(Evidence).min(1),
  reviewedAt: ISO_DATE.optional(),
  reviewerNote: z.string().min(1).optional(),
});

export const ResourceRelation = z.object({
  type: z.enum(["same-content-alias-candidate", "related-resource", "background-for", "story-related", "character-role", "pack-member"]),
  targetResourceId: UUIDV7,
  note: z.string().min(1).optional(),
});

export const Lifecycle = z.object({
  status: z.enum(["draft", "published", "tombstoned"]),
  createdAt: ISO_DATE,
  updatedAt: ISO_DATE,
  publishedAt: ISO_DATE.optional(),
});

export const Resource = z.object({
  schemaVersion: LEGACY_CATALOG_SCHEMA_VERSION,
  catalogSchemaVersion: z.literal(CATALOG_SCHEMA_VERSION).default(CATALOG_SCHEMA_VERSION),
  id: UUIDV7,
  game: Game,
  resourceType: ResourceType,
  title: z.string().min(1).optional(),
  aliases: z.array(Alias).default([]),
  externalIdentities: z.array(ExternalIdentity).default([]),
  metadata: z.record(z.string(), JsonValue).default({}),
  relations: z.array(ResourceRelation).default([]),
  provenance: z.array(CatalogProvenance).min(1),
  lifecycle: Lifecycle,
});

export const Variant = z.object({
  schemaVersion: LEGACY_CATALOG_SCHEMA_VERSION,
  catalogSchemaVersion: z.literal(CATALOG_SCHEMA_VERSION).default(CATALOG_SCHEMA_VERSION),
  id: UUIDV7,
  resourceId: UUIDV7,
  variantKey: z.string().min(1).refine((value) => !/[\\/]/.test(value), "must not be a path"),
  kind: VariantKind,
  semanticStatus: VariantSemanticStatus,
  /** Explicit default selection for galleries whose labels are not enough. */
  preferred: z.boolean().optional(),
  difficulty: Difficulty.optional(),
  eventKey: z.string().min(1).optional(),
  markers: z.object({
    filenameSuffix: z.enum(["_0", "_1", "_2", "_3", "_4"]).optional(),
    unresolved: z.array(z.enum(["_256_semantics", "etr_relation", "source_version", "visual_identity"])).default([]),
  }).default({ unresolved: [] }),
  note: z.string().min(1).optional(),
});

export const ObjectProvenance = z.object({
  sourceType: SourceType,
  sourceRelativePath: PORTABLE_RELATIVE_PATH,
  sourceFilename: FILE_NAME,
  sourceSha256: SHA256,
  gameVersion: z.string().min(1).optional(),
  evidence: z.array(Evidence).min(1),
});

export const AssetObject = z.object({
  schemaVersion: LEGACY_CATALOG_SCHEMA_VERSION,
  catalogSchemaVersion: z.literal(CATALOG_SCHEMA_VERSION).default(CATALOG_SCHEMA_VERSION),
  id: z.string().regex(/^sha256:[0-9a-f]{64}$/i, "object id must be sha256:<digest>"),
  sha256: SHA256,
  mime: MIME,
  extension: EXTENSION,
  sizeBytes: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  alpha: z.enum(["none", "opaque", "translucent", "unknown"]),
  objectKey: z.string().regex(/^(objects|assets)\/[0-9a-f]{64}\/[a-z0-9]+$/i, "objectKey must be immutable and portable"),
  createdAt: ISO_DATE,
  provenance: z.array(ObjectProvenance).min(1),
});

const RenditionShape = z.object({
  schemaVersion: LEGACY_CATALOG_SCHEMA_VERSION,
  catalogSchemaVersion: z.literal(CATALOG_SCHEMA_VERSION).default(CATALOG_SCHEMA_VERSION),
  id: UUIDV7,
  variantId: UUIDV7,
  renditionType: RenditionType,
  origin: RenditionOrigin,
  publishable: z.boolean(),
  objectId: z.string().regex(/^sha256:[0-9a-f]{64}$/i),
  /** Stable user-facing download name; never used as Object identity. */
  downloadFilename: FILE_NAME,
  /** Phase 2A compatibility alias. New data writes downloadFilename only. */
  displayFilename: FILE_NAME.optional(),
  sourceRenditionId: UUIDV7.optional(),
  generatedBy: z.enum(["extractor", "external-ai", "converter", "thumbnailer", "manual"]),
  createdAt: ISO_DATE,
});

export const Rendition = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (record.downloadFilename === undefined && typeof record.displayFilename === "string") {
    return { ...record, downloadFilename: record.displayFilename };
  }
  return value;
}, RenditionShape.superRefine((value, context) => {
  if (value.displayFilename && value.displayFilename !== value.downloadFilename) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["displayFilename"], message: "displayFilename compatibility alias must equal downloadFilename" });
  }
}));

export const WorkspaceLayout = z.object({
  raw: z.literal("raw"),
  work: z.literal("work"),
  upscaleInput: z.literal("upscale-input"),
  upscaleOutput: z.literal("upscale-output"),
  processed: z.literal("processed"),
  metadata: z.literal("metadata"),
  batchManifest: z.literal("metadata/batch.json"),
});

export const LocalApkProvenance = z.object({
  role: z.enum(["base", "target"]),
  version: z.string().min(1),
  filename: FILE_NAME,
  absolutePath: ABSOLUTE_LOCAL_PATH,
  sha256: SHA256.optional(),
  sizeBytes: z.number().int().positive().optional(),
  verification: z.enum(["unverified", "verified"]).default("unverified"),
});

export const Progress = z.object({
  total: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
});

export const ReviewRequirements = z.object({
  reviewRequired: z.boolean().default(true),
  manualNamingRequired: z.boolean().default(false),
  metadataReviewRequired: z.boolean().default(false),
  identityReviewRequired: z.boolean().default(false),
  upscaleRecommended: z.boolean().default(false),
  upscaleRequired: z.boolean().default(false),
  reasons: z.array(z.string().min(1)).default([]),
});

export const UpdateBatch = z.object({
  schemaVersion: LEGACY_WORKSPACE_SCHEMA_VERSION,
  workspaceSchemaVersion: z.literal(WORKSPACE_SCHEMA_VERSION).default(WORKSPACE_SCHEMA_VERSION),
  id: UUIDV7,
  game: LegacyGame,
  targetVersion: z.string().min(1),
  baseVersion: z.string().min(1),
  baseApk: LocalApkProvenance,
  targetApk: LocalApkProvenance,
  createdAt: ISO_DATE,
  extractorVersion: z.string().min(1),
  workspace: z.object({
    rootPath: ABSOLUTE_LOCAL_PATH,
    layout: WorkspaceLayout,
  }),
  candidateIds: z.array(UUIDV7),
  candidateCount: z.number().int().nonnegative(),
  filenameReviewProgress: Progress,
  /** Number of candidates that actually need a filename edit, not a review. */
  namingEditProgress: Progress.default({ total: 0, completed: 0, blocked: 0 }),
  /** Candidates with an outstanding metadata review requirement. */
  metadataReviewProgress: Progress.default({ total: 0, completed: 0, blocked: 0 }),
  /** Candidates awaiting human confirmation, independent of field overrides. */
  confirmationProgress: Progress.default({ total: 0, completed: 0, blocked: 0 }),
  upscaleProgress: Progress,
  finalReviewProgress: Progress,
  status: UpdateBatchStatus,
  statusNote: z.string().min(1).optional(),
  diffSummary: z.object({
    added: z.number().int().nonnegative().default(0),
    contentChanged: z.number().int().nonnegative().default(0),
    metadataOnly: z.number().int().nonnegative().default(0),
    unchanged: z.number().int().nonnegative().default(0),
    unmatched: z.number().int().nonnegative().default(0),
    removed: z.number().int().nonnegative().default(0),
  }).optional(),
});

export const CandidateFileRevision = z.object({
  revision: z.number().int().positive(),
  relativePath: PORTABLE_RELATIVE_PATH,
  filename: FILE_NAME,
  sizeBytes: z.number().int().nonnegative(),
  sha256: SHA256.optional(),
  mtimeMs: z.number().finite().nonnegative().optional(),
  observedAt: ISO_DATE,
  reason: z.enum(["initial", "rename", "move", "content-replacement", "manual-addition", "upscale-output", "conversion"]),
});

export const CandidateFile = z.object({
  schemaVersion: LEGACY_WORKSPACE_SCHEMA_VERSION,
  workspaceSchemaVersion: z.literal(WORKSPACE_SCHEMA_VERSION).default(WORKSPACE_SCHEMA_VERSION),
  id: UUIDV7,
  candidateId: UUIDV7,
  role: z.enum(["raw-original", "work-original", "upscale-input", "upscale-output", "processed-upscaled", "supplemental"]),
  relativePath: PORTABLE_RELATIVE_PATH,
  filename: FILE_NAME,
  mime: MIME,
  extension: EXTENSION,
  sizeBytes: z.number().int().nonnegative(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  alpha: z.enum(["none", "opaque", "translucent", "unknown"]).optional(),
  sha256: SHA256.optional(),
  mtimeMs: z.number().finite().nonnegative().optional(),
  availability: z.enum(["present", "missing"]).default("present"),
  revisions: z.array(CandidateFileRevision).default([]),
  createdAt: ISO_DATE,
  generatedBy: z.enum(["extractor", "human", "external-ai", "converter", "manual"]),
});

export const CandidateSourceEvidence = z.object({
  sourceType: SourceType,
  sourceRelativePath: PORTABLE_RELATIVE_PATH.optional(),
  sourceFilename: FILE_NAME,
  sourceGameVersion: z.string().min(1).optional(),
  sourceSha256: SHA256.optional(),
  detection: z.enum(["added", "changed", "renamed", "legacy-seed", "manual", "unknown"]),
  changeKind: UpdateChangeKind.default("added"),
  oldRelativePath: PORTABLE_RELATIVE_PATH.optional(),
  evidence: z.array(Evidence).min(1),
});

export const CandidateProvenance = z.object({
  baseVersion: z.string().min(1).optional(),
  targetVersion: z.string().min(1).optional(),
  sourceApkVersion: z.string().min(1).optional(),
  sourceApkFilename: FILE_NAME.optional(),
  apkInternalRelativePath: PORTABLE_RELATIVE_PATH.optional(),
  sourceHash: SHA256.optional(),
  metadataSource: z.string().min(1).optional(),
  addressablesKey: z.string().min(1).optional(),
  bundleName: z.string().min(1).optional(),
  objectPathId: z.string().min(1).optional(),
  bundleHash: z.string().min(1).optional(),
  imageContentHash: SHA256.optional(),
  objectName: z.string().min(1).optional(),
  dimensions: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
  originalFilename: FILE_NAME.optional(),
  mappingEvidence: z.array(Evidence).default([]),
});

export const CandidateNaming = z.object({
  sourceFilename: FILE_NAME,
  suggestedFilename: FILE_NAME,
  reviewedFilename: FILE_NAME.optional(),
  finalFilename: FILE_NAME.optional(),
  knownBasenames: z.array(FILE_NAME).default([]),
});

export const CandidateReview = z.object({
  state: ReviewState,
  decision: ReviewDecision.optional(),
  reviewedAt: ISO_DATE.optional(),
  note: z.string().min(1).optional(),
  confirmed: z.boolean().default(false),
  confirmedAt: ISO_DATE.optional(),
  disposition: z.enum(["active", "removed", "ignored"]).default("active"),
  overrides: z.object({
    title: z.string().min(1).optional(),
    artist: z.string().min(1).optional(),
    filename: FILE_NAME.optional(),
    resourceType: ResourceType.optional(),
    variantKey: z.string().min(1).optional(),
    metadata: z.record(JsonValue).optional(),
    resourceId: UUIDV7.optional(),
    variantId: UUIDV7.optional(),
    renditionId: UUIDV7.optional(),
    relatedResourceId: UUIDV7.optional(),
  }).default({}),
});

export const OptimizationMatch = z.object({
  outputFileId: UUIDV7,
  normalizedStem: z.string().min(1),
  state: z.enum(["matched", "ambiguous", "unmatched"]),
  matchedBy: z.enum(["filename-alias", "manifest", "manual"]),
  competingCandidateIds: z.array(UUIDV7).default([]),
});

export const CandidateProcessing = z.object({
  state: ProcessingState,
  requiresUpscale: z.boolean(),
  inputFileId: UUIDV7.optional(),
  optimizationMatches: z.array(OptimizationMatch).default([]),
  selectedOutputFileId: UUIDV7.optional(),
  processedFileId: UUIDV7.optional(),
  conversion: z.object({
    outputFormat: z.enum(["jpeg", "png"]).optional(),
    quality: z.number().int().min(1).max(100),
    chromaSubsampling: z.enum(["4:2:0", "4:4:4"]),
    progressive: z.boolean(),
    mozjpeg: z.boolean().optional(),
    alphaPolicy: z.enum(["block", "flatten-white", "flatten-explicit", "preserve-png"]),
    flattenBackground: z.string().min(1).optional(),
    inputPngSha256: SHA256,
    outputJpgSha256: SHA256.optional(),
    outputPngSha256: SHA256.optional(),
    inputPngSizeBytes: z.number().int().nonnegative().optional(),
    outputJpgSizeBytes: z.number().int().nonnegative().optional(),
    outputPngSizeBytes: z.number().int().nonnegative().optional(),
    sizeReductionBytes: z.number().int().optional(),
    sizeReductionRatio: z.number().finite().optional(),
    sourcePngRetained: z.literal(true),
  }).optional(),
  note: z.string().min(1).optional(),
});

export const Candidate = z.object({
  schemaVersion: LEGACY_WORKSPACE_SCHEMA_VERSION,
  workspaceSchemaVersion: z.literal(WORKSPACE_SCHEMA_VERSION).default(WORKSPACE_SCHEMA_VERSION),
  id: UUIDV7,
  batchId: UUIDV7,
  sourceEvidence: CandidateSourceEvidence,
  naming: CandidateNaming,
  suggestedMapping: z.object({
    resourceType: ResourceType,
    title: z.string().min(1).optional(),
    variantKey: z.string().min(1).optional(),
    variantKind: VariantKind.optional(),
    externalIdentities: z.array(ExternalIdentity).default([]),
    metadata: z.record(z.string(), JsonValue).default({}),
    confidence: Confidence,
    evidence: z.array(Evidence).min(1),
  }),
  provenance: CandidateProvenance.optional(),
  reviewRequirements: ReviewRequirements.default({
    reviewRequired: true,
    manualNamingRequired: false,
    metadataReviewRequired: false,
    identityReviewRequired: false,
    upscaleRecommended: false,
    upscaleRequired: false,
    reasons: [],
  }),
  files: z.array(CandidateFile).min(1),
  review: CandidateReview,
  processing: CandidateProcessing,
  status: CandidateStatus,
  target: z.object({
    resourceId: UUIDV7.optional(),
    variantId: UUIDV7.optional(),
    renditionId: UUIDV7.optional(),
    sourceRenditionId: UUIDV7.optional(),
    downloadFilename: FILE_NAME.optional(),
  }).optional(),
});

export const CandidateManifest = z.object({
  schemaVersion: LEGACY_WORKSPACE_SCHEMA_VERSION,
  workspaceSchemaVersion: z.literal(WORKSPACE_SCHEMA_VERSION).default(WORKSPACE_SCHEMA_VERSION),
  id: UUIDV7,
  sourceType: SourceType,
  game: LegacyGame,
  sourceSnapshot: z.string().min(1),
  createdAt: ISO_DATE,
  extractorVersion: z.string().min(1).optional(),
  candidateIds: z.array(UUIDV7),
  candidateCount: z.number().int().nonnegative(),
  notes: z.array(z.string().min(1)).default([]),
});

export const RawManifestEntry = z.object({
  candidateId: UUIDV7.optional(),
  relativePath: PORTABLE_RELATIVE_PATH,
  filename: FILE_NAME,
  sizeBytes: z.number().int().nonnegative(),
  sha256: SHA256,
});

export const RawManifest = z.object({
  workspaceSchemaVersion: z.literal(WORKSPACE_SCHEMA_VERSION).default(WORKSPACE_SCHEMA_VERSION),
  batchId: UUIDV7,
  createdAt: ISO_DATE,
  entries: z.array(RawManifestEntry),
});

export const ReviewEvent = z.object({
  id: UUIDV7,
  candidateId: UUIDV7.optional(),
  at: ISO_DATE,
  type: z.enum([
    "manual-rename",
    "manual-addition",
    "content-replaced",
    "missing-from-workspace",
    "ambiguous-rename",
    "duplicated-work-file",
    "raw-integrity",
    "rejected",
    "ignored",
    "candidate-confirmed",
    "metadata-override",
    "identity-resolved",
    "extractor-blocked",
    "upscale-input-prepared",
    "upscale-output-detected",
    "upscale-attempt-failure",
    "upscale-selected",
    "conversion",
    "final-review",
    "candidate-removed",
    "candidate-restored",
    "candidate-replaced-image",
    "upscale-started",
    "upscale-completed",
    "upscale-skipped",
    "source-changed-again",
    "publish-reused",
  ]),
  detail: z.string().min(1),
  data: z.record(z.string(), JsonValue).default({}),
});

export const ReviewLog = z.object({
  workspaceSchemaVersion: z.literal(WORKSPACE_SCHEMA_VERSION).default(WORKSPACE_SCHEMA_VERSION),
  batchId: UUIDV7,
  events: z.array(ReviewEvent),
});

export const WorkspaceScanSnapshot = z.object({
  workspaceSchemaVersion: z.literal(WORKSPACE_SCHEMA_VERSION).default(WORKSPACE_SCHEMA_VERSION),
  scannedAt: ISO_DATE,
  workFiles: z.array(z.object({
    relativePath: PORTABLE_RELATIVE_PATH,
    filename: FILE_NAME,
    sizeBytes: z.number().int().nonnegative(),
    sha256: SHA256,
    mtimeMs: z.number().finite().nonnegative(),
  })),
  upscaleOutputFiles: z.array(z.object({
    relativePath: PORTABLE_RELATIVE_PATH,
    filename: FILE_NAME,
    sizeBytes: z.number().int().nonnegative(),
    sha256: SHA256,
    mtimeMs: z.number().finite().nonnegative(),
  })),
});

export const ReleaseChange = z.object({
  changeType: ChangeType,
  resourceId: UUIDV7.optional(),
  variantId: UUIDV7.optional(),
  renditionId: UUIDV7.optional(),
  objectId: z.string().regex(/^sha256:[0-9a-f]{64}$/i).optional(),
  previousObjectId: z.string().regex(/^sha256:[0-9a-f]{64}$/i).optional(),
  detail: z.string().min(1),
});

export const RemovedSourceEntry = z.object({
  identity: z.string().min(1),
  sourceRelativePath: PORTABLE_RELATIVE_PATH.optional(),
  resourceId: UUIDV7.optional(),
  detail: z.string().min(1),
});

export const ReleaseManifest = z.object({
  schemaVersion: LEGACY_RELEASE_SCHEMA_VERSION,
  releaseSchemaVersion: z.literal(RELEASE_SCHEMA_VERSION).default(RELEASE_SCHEMA_VERSION),
  id: UUIDV7,
  updateBatchId: UUIDV7,
  game: Game,
  baseVersion: z.string().min(1),
  targetVersion: z.string().min(1),
  createdAt: ISO_DATE,
  status: z.enum(["draft", "validated", "published"]),
  changes: z.array(ReleaseChange),
  affectedResourceIds: z.array(UUIDV7),
  publishedRenditions: z.array(z.preprocess((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    if (record.downloadFilename === undefined && typeof record.displayFilename === "string") {
      return { ...record, downloadFilename: record.displayFilename };
    }
    return value;
  }, z.object({
    resourceId: UUIDV7,
    variantId: UUIDV7,
    renditionId: UUIDV7,
    objectId: z.string().regex(/^sha256:[0-9a-f]{64}$/i),
    downloadFilename: FILE_NAME,
    displayFilename: FILE_NAME.optional(),
  }).superRefine((value, context) => {
    if (value.displayFilename && value.displayFilename !== value.downloadFilename) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["displayFilename"], message: "displayFilename compatibility alias must equal downloadFilename" });
    }
  }))),
  removedFromCurrentSource: z.array(RemovedSourceEntry).default([]),
  notes: z.array(z.string().min(1)).default([]),
});

export const ObjectToCreate = z.object({
  objectId: z.string().regex(/^sha256:[0-9a-f]{64}$/i),
  objectKey: z.string().regex(/^(objects|assets)\/[0-9a-f]{64}\/[a-z0-9]+$/i),
  sha256: SHA256,
  sizeBytes: z.number().int().nonnegative(),
  mime: MIME,
});

export const CatalogMutation = z.object({
  operation: z.enum(["create-resource", "update-resource", "create-variant", "update-variant", "create-rendition", "replace-rendition", "tombstone-resource", "tombstone-variant"]),
  resourceId: UUIDV7.optional(),
  variantId: UUIDV7.optional(),
  renditionId: UUIDV7.optional(),
  objectId: z.string().regex(/^sha256:[0-9a-f]{64}$/i).optional(),
  previousObjectId: z.string().regex(/^sha256:[0-9a-f]{64}$/i).optional(),
  summary: z.string().min(1),
});

export const ReleaseManifestMutation = z.object({
  operation: z.enum(["create", "update"]),
  manifestId: UUIDV7,
  targetVersion: z.string().min(1),
});

export const ObjectEligibleForGc = z.object({
  objectId: z.string().regex(/^sha256:[0-9a-f]{64}$/i),
  reason: z.string().min(1),
  eligibleAfter: ISO_DATE,
  catalogReferencesAfter: z.literal(0),
});

export const PublishPlan = z.object({
  schemaVersion: LEGACY_PUBLISH_PLAN_SCHEMA_VERSION,
  publishPlanSchemaVersion: z.literal(PUBLISH_PLAN_SCHEMA_VERSION).default(PUBLISH_PLAN_SCHEMA_VERSION),
  id: UUIDV7,
  updateBatchId: UUIDV7,
  generatedAt: ISO_DATE,
  dryRun: z.boolean(),
  objectsToCreate: z.array(ObjectToCreate),
  catalogMutations: z.array(CatalogMutation),
  releaseManifestMutation: ReleaseManifestMutation,
  objectsEligibleForGC: z.array(ObjectEligibleForGc),
  validation: z.object({
    schemaValid: z.boolean(),
    referencesValid: z.boolean(),
    objectBytesVerified: z.boolean(),
    humanApprovalRequired: z.literal(true),
  }),
  notes: z.array(z.string().min(1)).default([]),
});

export const Catalog = z.object({
  schemaVersion: LEGACY_CATALOG_SCHEMA_VERSION,
  catalogSchemaVersion: z.literal(CATALOG_SCHEMA_VERSION).default(CATALOG_SCHEMA_VERSION),
  catalogId: UUIDV7,
  generatedAt: ISO_DATE,
  resources: z.array(Resource),
  variants: z.array(Variant),
  renditions: z.array(Rendition),
  objects: z.array(AssetObject),
  releaseManifestIds: z.array(UUIDV7).default([]),
});

export type Resource = z.infer<typeof Resource>;
export type Variant = z.infer<typeof Variant>;
export type Rendition = z.infer<typeof Rendition>;
export type AssetObject = z.infer<typeof AssetObject>;
export type Catalog = z.infer<typeof Catalog>;
export type UpdateBatch = z.infer<typeof UpdateBatch>;
export type CandidateFile = z.infer<typeof CandidateFile>;
export type CandidateFileRevision = z.infer<typeof CandidateFileRevision>;
export type Candidate = z.infer<typeof Candidate>;
export type CandidateProvenance = z.infer<typeof CandidateProvenance>;
export type ReviewRequirements = z.infer<typeof ReviewRequirements>;
export type CandidateManifest = z.infer<typeof CandidateManifest>;
export type RawManifest = z.infer<typeof RawManifest>;
export type ReviewEvent = z.infer<typeof ReviewEvent>;
export type ReviewLog = z.infer<typeof ReviewLog>;
export type WorkspaceScanSnapshot = z.infer<typeof WorkspaceScanSnapshot>;
export type ReleaseManifest = z.infer<typeof ReleaseManifest>;
export type ReleaseChange = z.infer<typeof ReleaseChange>;
export type RemovedSourceEntry = z.infer<typeof RemovedSourceEntry>;
export type ObjectToCreate = z.infer<typeof ObjectToCreate>;
export type CatalogMutation = z.infer<typeof CatalogMutation>;
export type ReleaseManifestMutation = z.infer<typeof ReleaseManifestMutation>;
export type ObjectEligibleForGc = z.infer<typeof ObjectEligibleForGc>;
export type PublishPlan = z.infer<typeof PublishPlan>;
export type CandidateStatus = z.infer<typeof CandidateStatus>;
export type UpdateBatchStatus = z.infer<typeof UpdateBatchStatus>;
export type RenditionType = z.infer<typeof RenditionType>;
export type ProcessingState = z.infer<typeof ProcessingState>;
export type UpdateChangeKind = z.infer<typeof UpdateChangeKind>;

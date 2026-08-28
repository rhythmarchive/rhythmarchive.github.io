import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Catalog } from "./schema.js";

/**
 * Browse Projection is a domain index, not another Catalog document family.
 * Resource, Variant, Rendition and Object identity remains owned by schema.ts.
 */
export const BROWSE_SCHEMA_VERSION = 1 as const;
export const BROWSE_SCHEMA_NAME = "rhythm-browse-projection" as const;

const UUIDV7 = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, "must be an RFC 9562 UUIDv7");
const SHA256 = z.string().regex(/^[0-9a-f]{64}$/i, "must be a SHA-256 hex digest");
const ISO_DATE = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "must be an ISO-like timestamp");
const ISO_DAY = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, "must be an ISO calendar date")
  .refine((value) => !Number.isNaN(Date.parse(value + "T00:00:00Z")), "must be a valid ISO calendar date");
const PORTABLE_RELATIVE_PATH = z.string().min(1).refine((value) => {
  if (value.includes("\0")) return false;
  if (/^[a-zA-Z]:[\\/]/.test(value) || /^\\\\/.test(value) || value.startsWith("/") || value.startsWith("\\")) return false;
  return !value.split(/[\\/]+/).includes("..");
}, "must be an APK-relative portable path");

export const ArcaeaDifficultyClass = z.enum(["PST", "PRS", "FTR", "BYD", "ETR", "INSCRIBED"]);
export const PhigrosDifficultyClass = z.enum(["EZ", "HD", "IN", "AT", "Legacy"]);

const SearchTerms = z.array(z.string().min(1));
const ArcaeaChart = z.object({
  difficultyClass: ArcaeaDifficultyClass,
  displayLevel: z.string().min(1),
  title: z.string().min(1).optional(),
  artist: z.string().min(1).optional(),
});

const ArcaeaArtwork = z.object({
  role: z.enum(["default", "difficulty", "night/special"]),
  difficultyClass: ArcaeaDifficultyClass.optional(),
  resourceId: UUIDV7.nullable(),
  currentApkPresence: z.boolean(),
  matchStatus: z.enum(["confirmed", "high", "medium", "multiple", "missing", "unmatched"]),
  sourcePath: PORTABLE_RELATIVE_PATH.optional(),
});

const RelatedSong = z.object({
  songId: z.string().min(1),
  relationType: z.string().min(1),
  note: z.string().min(1).optional(),
});

export const ArcaeaSongRecord = z.object({
  songId: z.string().min(1),
  displayTitle: z.string().min(1),
  titleAliases: SearchTerms,
  artist: z.string().min(1),
  artistAliases: SearchTerms,
  pack: z.object({
    packId: z.string().min(1),
    displayName: z.string().min(1).nullable(),
  }),
  version: z.string().min(1).nullable(),
  date: z.number().int().nullable(),
  sideRaw: z.number().int().nullable(),
  bpm: z.string().min(1).nullable(),
  orderHint: z.number().int().nonnegative(),
  charts: z.array(ArcaeaChart),
  artworks: z.array(ArcaeaArtwork),
  relatedSongs: z.array(RelatedSong),
  specialRelation: z.string().min(1).optional(),
  searchTerms: SearchTerms,
});

const ArcaeaSpecialArtwork = z.object({
  role: z.enum(["seasonal", "permanent-byd"]),
  difficultyClass: ArcaeaDifficultyClass.optional(),
  resourceId: UUIDV7.nullable(),
  currentApkPresence: z.boolean(),
});

export const ArcaeaSpecialRecord = z.object({
  specialId: z.string().min(1),
  specialType: z.literal("april-fools"),
  year: z.number().int().min(2018),
  version: z.string().min(1),
  releaseDate: ISO_DAY,
  specialTitle: z.string().min(1),
  baseSongId: z.string().min(1),
  relationType: z.string().min(1),
  currentRepresentation: z.enum(["permanent-byd", "seasonal-only"]),
  standaloneSonglistRecord: z.boolean(),
  artworks: z.array(ArcaeaSpecialArtwork),
  searchTerms: SearchTerms,
});

const ArcaeaExtra = z.object({
  resourceId: UUIDV7,
  reason: z.string().min(1),
  currentApkPresence: z.literal(false),
  relatedSongId: z.string().min(1).optional(),
  difficultyClass: ArcaeaDifficultyClass.optional(),
  specialRelation: z.string().min(1).optional(),
  searchTerms: SearchTerms,
});

export const ArcaeaBrowseProjection = z.object({
  schemaVersion: z.literal(BROWSE_SCHEMA_VERSION),
  game: z.literal("arcaea"),
  generatedAt: ISO_DATE,
  source: z.object({
    version: z.string().min(1),
    sha256: SHA256,
  }),
  songs: z.array(ArcaeaSongRecord),
  specials: z.array(ArcaeaSpecialRecord),
  archiveExtras: z.array(ArcaeaExtra),
  unresolvedExtras: z.array(ArcaeaExtra),
  recordCounts: z.object({
    regularSongs: z.number().int().nonnegative(),
    currentArtworkSlots: z.number().int().nonnegative(),
    currentArtworkResourceReferences: z.number().int().nonnegative(),
    missingCurrentArtwork: z.number().int().nonnegative(),
    specialRecords: z.number().int().nonnegative(),
    archiveExtras: z.number().int().nonnegative(),
    unresolvedExtras: z.number().int().nonnegative(),
  }),
});

const PhigrosChart = z.object({
  difficultyClass: PhigrosDifficultyClass,
  structurallyPresent: z.boolean(),
  errorVariant: z.boolean(),
});

const PhigrosArtwork = z.object({
  resourceId: UUIDV7,
  confidence: z.enum(["confirmed", "high", "medium", "low", "unknown"]),
  role: z.literal("current-track-artwork"),
});

const PhigrosFamily = z.object({
  familyId: z.string().min(1),
  memberIndex: z.number().int().nonnegative(),
  memberCount: z.number().int().positive(),
  primaryMemberIndex: z.number().int().nonnegative(),
});

export const PhigrosTrackRecord = z.object({
  sourceIdentityCandidate: z.string().min(1),
  sourceTrackPath: PORTABLE_RELATIVE_PATH,
  displayTitle: z.string().min(1),
  sourceTitle: z.string().min(1),
  displayArtist: z.string().min(1).nullable(),
  sourceArtist: z.string().min(1).nullable(),
  indexRaw: z.string().min(1).nullable(),
  artwork: PhigrosArtwork.nullable(),
  charts: z.array(PhigrosChart),
  displayLevel: z.null(),
  chapter: z.null(),
  specialKind: z.enum(["system-or-tutorial-candidate", "random-family-member"]).optional(),
  family: PhigrosFamily.optional(),
  searchAliases: SearchTerms,
  searchTerms: SearchTerms,
});

export const PhigrosSpecialRecord = z.object({
  specialId: z.string().min(1),
  specialType: z.literal("april-fools"),
  displayTitle: z.string().min(1),
  artworkResourceId: UUIDV7,
  sourceFilename: z.string().min(1).optional(),
  isTrackMapped: z.literal(false),
  searchTerms: SearchTerms,
});

const PhigrosExtra = z.object({
  resourceId: UUIDV7,
  reason: z.string().min(1),
  current: z.literal(false),
  sourceFilename: z.string().min(1).optional(),
  searchTerms: SearchTerms,
});

export const PhigrosBrowseProjection = z.object({
  schemaVersion: z.literal(BROWSE_SCHEMA_VERSION),
  game: z.literal("phigros"),
  generatedAt: ISO_DATE,
  source: z.object({
    version: z.string().min(1),
    sha256: SHA256,
  }),
  tracks: z.array(PhigrosTrackRecord),
  specials: z.array(PhigrosSpecialRecord),
  archiveExtras: z.array(PhigrosExtra),
  sourceOnlyTracks: z.array(PhigrosTrackRecord),
  recordCounts: z.object({
    sourceTrackRecords: z.number().int().nonnegative(),
    currentTrackArtworkEntries: z.number().int().nonnegative(),
    specialRecords: z.number().int().nonnegative(),
    archiveExtras: z.number().int().nonnegative(),
    sourceOnlyTracks: z.number().int().nonnegative(),
  }),
});

const RizlineArtwork = z.object({
  artworkId: z.string().min(1),
  resourceId: UUIDV7,
  variantId: UUIDV7,
  variantKey: z.string().min(1),
  preferred: z.boolean(),
});

export const RizlineSongRecord = z.object({
  songId: z.string().min(1),
  displayTitle: z.string().min(1),
  musicArtist: z.string().min(1).nullable(),
  illustrator: z.string().min(1).nullable(),
  disc: z.string().min(1).nullable(),
  trackSeries: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
  })),
  artworks: z.array(RizlineArtwork).min(1),
  searchTerms: SearchTerms,
});

export const RizlineBrowseProjection = z.object({
  schemaVersion: z.literal(BROWSE_SCHEMA_VERSION),
  game: z.literal("rizline"),
  generatedAt: ISO_DATE,
  source: z.object({
    version: z.string().min(1),
    sha256: SHA256,
  }),
  songs: z.array(RizlineSongRecord),
  recordCounts: z.object({
    songs: z.number().int().nonnegative(),
    artworks: z.number().int().nonnegative(),
  }),
});

const ResourceSemanticBase = z.object({
  resourceId: UUIDV7,
  reason: z.string().min(1),
  relatedSongId: z.string().min(1).optional(),
  difficultyClass: ArcaeaDifficultyClass.optional(),
  specialType: z.string().min(1).optional(),
  displayTitle: z.string().min(1).optional(),
  sourceFilename: z.string().min(1).optional(),
});

export const ArcaeaResourceSemantic = ResourceSemanticBase.extend({
  bucket: z.enum(["regular", "special", "archiveExtra", "unresolvedExtra"]),
});

export const PhigrosResourceSemantic = ResourceSemanticBase.omit({ difficultyClass: true, relatedSongId: true }).extend({
  bucket: z.enum(["current", "archiveExtra", "special"]),
});

/**
 * Small, public browse annotations for non-jacket galleries.
 * These annotations decorate Catalog Resources; they never replace Resource identity.
 */
export const CategoryBrowseResource = z.object({
  resourceId: UUIDV7,
  resourceType: z.string().min(1),
  displayTitle: z.string().min(1).optional(),
  subtitle: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  badges: z.array(z.string().min(1)).default([]),
  searchTerms: SearchTerms.default([]),
  sortOrder: z.number().int().nonnegative().optional(),
  facets: z.record(z.string(), z.array(z.string().min(1))).default({}),
});

/**
 * Public, package-pinned story navigation metadata for Arcaea's Story Mode.
 * The site uses this to reproduce the game's Act/Part -> Path -> Entry order;
 * visual assets themselves still come from Catalog/PublicSiteData resources.
 */
export const ArcaeaStoryStructure = z.object({
  source: z.object({
    packageVersion: z.string().min(1),
    packageSha256: SHA256,
    orderingPath: z.string().min(1),
    verifiedAt: z.string().min(1),
    wikiSources: z.array(z.object({ url: z.string().url(), usedFor: z.string().min(1) })),
  }),
  sections: z.array(z.object({
    act: z.number().int().nonnegative(),
    label: z.string().min(1),
    pathIds: z.array(z.number().int().nonnegative()),
  })),
  paths: z.array(z.object({
    pathId: z.number().int().nonnegative(),
    act: z.number().int().nonnegative(),
    title: z.string().min(1),
    type: z.string().min(1),
    nodes: z.array(z.string().min(1)),
  })),
  nodeAnnotations: z.array(z.object({
    nodeKey: z.string().min(1),
    visual: z.enum(["animation", "illustration"]),
    unlockKind: z.enum(["pack", "song"]),
    relatedPackId: z.string().min(1).optional(),
    relatedPackTitle: z.string().min(1).optional(),
    relatedSongId: z.string().min(1).optional(),
    staffRoll: z.boolean().optional(),
  })),
});

export const CategoryBrowseProjection = z.object({
  schemaVersion: z.literal(BROWSE_SCHEMA_VERSION),
  game: z.enum(["arcaea", "phigros", "rizline", "infalsus"]),
  generatedAt: ISO_DATE,
  source: z.object({
    snapshot: z.string().min(1),
    sha256: SHA256,
  }),
  resources: z.array(CategoryBrowseResource),
});

export const ArcaeaCategoryBrowseProjection = CategoryBrowseProjection.extend({
  game: z.literal("arcaea"),
  storyStructure: ArcaeaStoryStructure.optional(),
});
export const PhigrosCategoryBrowseProjection = CategoryBrowseProjection.extend({ game: z.literal("phigros") });
export const RizlineCategoryBrowseProjection = CategoryBrowseProjection.extend({ game: z.literal("rizline") });
export const InfalsusCategoryBrowseProjection = CategoryBrowseProjection.extend({ game: z.literal("infalsus") });

const ArcaeaSourceArtwork = z.object({
  role: z.enum(["default", "difficulty", "night/special"]),
  difficultyClass: ArcaeaDifficultyClass.optional(),
  /** Omitted means the extractor has not resolved the Catalog relation yet. Null is an explicit source-present gap. */
  resourceId: UUIDV7.nullable().optional(),
  currentApkPresence: z.boolean().default(true),
  matchStatus: z.enum(["confirmed", "high", "medium", "multiple", "missing", "unmatched"]).optional(),
  sourcePath: PORTABLE_RELATIVE_PATH.optional(),
});

const ArcaeaSourceSong = z.object({
  songId: z.string().min(1),
  displayTitle: z.string().min(1),
  titleAliases: SearchTerms.default([]),
  artist: z.string().min(1),
  artistAliases: SearchTerms.default([]),
  packId: z.string().min(1),
  packDisplayName: z.string().min(1).nullable().optional(),
  version: z.string().min(1).nullable().optional(),
  date: z.number().int().nullable().optional(),
  sideRaw: z.number().int().nullable().optional(),
  bpm: z.string().min(1).nullable().optional(),
  orderHint: z.number().int().nonnegative(),
  charts: z.array(ArcaeaChart),
  artworks: z.array(ArcaeaSourceArtwork),
  relatedSongs: z.array(RelatedSong).default([]),
  specialRelation: z.string().min(1).optional(),
});

export const ArcaeaSourceMetadata = z.object({
  schemaVersion: z.literal(BROWSE_SCHEMA_VERSION),
  game: z.literal("arcaea"),
  sourceVersion: z.string().min(1),
  sourceSha256: SHA256,
  songs: z.array(ArcaeaSourceSong),
  resourceSemantics: z.array(ArcaeaResourceSemantic).default([]),
});

const PhigrosSourceTrack = z.object({
  sourceIdentityCandidate: z.string().min(1),
  sourceTrackPath: PORTABLE_RELATIVE_PATH,
  displayTitle: z.string().min(1).optional(),
  sourceTitle: z.string().min(1),
  displayArtist: z.string().min(1).nullable().optional(),
  sourceArtist: z.string().min(1).nullable(),
  indexRaw: z.string().min(1).nullable(),
  /** See ArcaeaSourceArtwork.resourceId for the omitted/null distinction. */
  artworkResourceId: UUIDV7.nullable().optional(),
  artworkConfidence: z.enum(["confirmed", "high", "medium", "low", "unknown"]).optional(),
  charts: z.array(PhigrosChart),
  specialKind: z.enum(["system-or-tutorial-candidate", "random-family-member"]).optional(),
  family: PhigrosFamily.optional(),
  searchAliases: SearchTerms.default([]),
});

export const PhigrosSourceMetadata = z.object({
  schemaVersion: z.literal(BROWSE_SCHEMA_VERSION),
  game: z.literal("phigros"),
  sourceVersion: z.string().min(1),
  sourceSha256: SHA256,
  tracks: z.array(PhigrosSourceTrack),
  resourceSemantics: z.array(PhigrosResourceSemantic).default([]),
});

const ArcaeaCurationEntry = z.object({
  year: z.number().int().min(2018),
  version: z.string().min(1),
  releaseDate: ISO_DAY,
  specialTitle: z.string().min(1),
  baseSongId: z.string().min(1),
  relationType: z.string().min(1),
  specialType: z.literal("april-fools"),
  currentRepresentation: z.enum(["permanent-byd", "seasonal-only"]),
  standaloneSonglistRecord: z.boolean(),
  seasonalResourceId: UUIDV7.nullable(),
  seasonalCurrentApkPresence: z.boolean(),
  permanentByd: z.object({
    songId: z.string().min(1),
    difficultyClass: z.literal("BYD"),
    resourceId: UUIDV7,
    currentApkPresence: z.boolean(),
  }).nullable(),
});

export const ArcaeaCuration = z.object({
  schemaVersion: z.literal(BROWSE_SCHEMA_VERSION),
  game: z.literal("arcaea"),
  entries: z.array(ArcaeaCurationEntry),
});

const ManifestGame = z.object({
  sourceVersion: z.string().min(1),
  sourceSha256: SHA256,
  fileSha256: SHA256,
  recordCounts: z.record(z.string(), z.number().int().nonnegative()),
});

export const BrowseManifest = z.object({
  schemaVersion: z.literal(BROWSE_SCHEMA_VERSION),
  generatedAt: ISO_DATE,
  games: z.object({
    arcaea: ManifestGame,
    phigros: ManifestGame,
    rizline: ManifestGame.optional(),
    infalsus: ManifestGame.optional(),
  }),
  catalog: z.object({
    catalogId: UUIDV7,
    catalogSha256: SHA256,
    catalogGeneratedAt: ISO_DATE,
  }),
  files: z.object({
    arcaea: z.literal("arcaea.json"),
    phigros: z.literal("phigros.json"),
    rizline: z.literal("rizline.json").optional(),
    rizlineSemantics: z.literal("rizline-semantics.json").optional(),
    infalsus: z.literal("infalsus.json").optional(),
    infalsusSemantics: z.literal("infalsus-semantics.json").optional(),
    manifest: z.literal("manifest.json"),
    diagnostics: z.literal("diagnostics.json"),
  }),
});

const GameDiagnostics = z.object({
  ok: z.boolean(),
  catalogResourceCount: z.number().int().nonnegative(),
  referencedResourceCount: z.number().int().nonnegative(),
  unreferencedResourceIds: z.array(UUIDV7),
  danglingResourceIds: z.array(z.string().min(1)),
  warnings: z.array(z.string().min(1)),
  counts: z.record(z.string(), z.number().int().nonnegative()),
  missingCurrentArtwork: z.array(z.object({
    songId: z.string().min(1),
    sourcePath: PORTABLE_RELATIVE_PATH,
  })),
});

export const BrowseDiagnostics = z.object({
  schemaVersion: z.literal(BROWSE_SCHEMA_VERSION),
  generatedAt: ISO_DATE,
  arcaea: GameDiagnostics,
  phigros: GameDiagnostics,
});

export type ArcaeaSongRecordType = z.infer<typeof ArcaeaSongRecord>;
export type ArcaeaSpecialRecordType = z.infer<typeof ArcaeaSpecialRecord>;
export type ArcaeaBrowseProjectionType = z.infer<typeof ArcaeaBrowseProjection>;
export type PhigrosTrackRecordType = z.infer<typeof PhigrosTrackRecord>;
export type PhigrosSpecialRecordType = z.infer<typeof PhigrosSpecialRecord>;
export type PhigrosBrowseProjectionType = z.infer<typeof PhigrosBrowseProjection>;
export type RizlineSongRecordType = z.infer<typeof RizlineSongRecord>;
export type RizlineBrowseProjectionType = z.infer<typeof RizlineBrowseProjection>;
export type CategoryBrowseResourceType = z.infer<typeof CategoryBrowseResource>;
export type CategoryBrowseProjectionType = z.infer<typeof CategoryBrowseProjection>;
export type ArcaeaStoryStructureType = z.infer<typeof ArcaeaStoryStructure>;
export type ArcaeaCategoryBrowseProjectionType = z.infer<typeof ArcaeaCategoryBrowseProjection>;
export type PhigrosCategoryBrowseProjectionType = z.infer<typeof PhigrosCategoryBrowseProjection>;
export type RizlineCategoryBrowseProjectionType = z.infer<typeof RizlineCategoryBrowseProjection>;
export type InfalsusCategoryBrowseProjectionType = z.infer<typeof InfalsusCategoryBrowseProjection>;
export type ArcaeaSourceMetadataType = z.infer<typeof ArcaeaSourceMetadata>;
export type PhigrosSourceMetadataType = z.infer<typeof PhigrosSourceMetadata>;
export type ArcaeaCurationType = z.infer<typeof ArcaeaCuration>;
export type BrowseManifestType = z.infer<typeof BrowseManifest>;
export type BrowseDiagnosticsType = z.infer<typeof BrowseDiagnostics>;

export type BrowseProjectionBuildResult = {
  arcaea: ArcaeaBrowseProjectionType;
  phigros: PhigrosBrowseProjectionType;
  manifest: BrowseManifestType;
  diagnostics: BrowseDiagnosticsType;
};

export type BrowseProjectionBuildInput = {
  catalog: Catalog;
  arcaea: ArcaeaSourceMetadataType;
  phigros: PhigrosSourceMetadataType;
  arcaeaCuration: ArcaeaCurationType;
  previous?: Partial<Pick<BrowseProjectionBuildResult, "arcaea" | "phigros">>;
  generatedAt: string;
  catalogSha256?: string;
};

export type BrowseValidationResult =
  | { success: true; data: BrowseProjectionBuildResult }
  | { success: false; issues: string[] };

export type CategoryBrowseValidationResult =
  | { success: true; data: CategoryBrowseProjectionType }
  | { success: false; issues: string[] };

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "en"));
}

/** Search data is derived; the display/source values remain in their own fields. */
export function normalizeBrowseSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en").replace(/\s+/gu, " ").trim();
}

function searchTerms(values: Array<string | null | undefined>): string[] {
  return uniqueSorted(values.map((value) => value ? normalizeBrowseSearchText(value) : ""));
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function localSensitiveBrowseValue(value: string): boolean {
  return /^[a-zA-Z]:/u.test(value) || value.startsWith("/") || value.startsWith("\\") || value.split(/[\\/]+/u).some((segment) => segment === ".runtime");
}

function browsePublicDataIssues(value: unknown, currentPath = "$"): string[] {
  if (typeof value === "string") return localSensitiveBrowseValue(value) ? [`${currentPath}: local absolute/drive-relative path or .runtime value is forbidden`] : [];
  if (Array.isArray(value)) return value.flatMap((child, index) => browsePublicDataIssues(child, `${currentPath}.${index}`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => {
      const keyIssue = /(?:absolutePath|apkPath|credential|secret|password|accessKey|token)/iu.test(key) ? [`${currentPath}.${key}: sensitive local/runtime field is forbidden`] : [];
      return [...keyIssue, ...browsePublicDataIssues(child, `${currentPath}.${key}`)];
    });
  }
  return [];
}

export function validateBrowsePublicData(value: unknown): string[] {
  return browsePublicDataIssues(value);
}

export type RizlineBrowseValidationResult =
  | { success: true; data: RizlineBrowseProjectionType }
  | { success: false; issues: string[] };

export function validateRizlineBrowseProjection(value: unknown, catalog: Catalog): RizlineBrowseValidationResult {
  const parsed = RizlineBrowseProjection.safeParse(value);
  if (!parsed.success) {
    return { success: false, issues: parsed.error.issues.map((issue) => issue.path.join(".") + ": " + issue.message) };
  }
  const issues: string[] = [];
  const resources = new Map(catalog.resources.map((resource) => [resource.id, resource]));
  const variants = new Map(catalog.variants.map((variant) => [variant.id, variant]));
  const artworkIds = new Set<string>();
  let artworkCount = 0;
  for (const song of parsed.data.songs) {
    for (const artwork of song.artworks) {
      artworkCount += 1;
      if (artworkIds.has(artwork.artworkId)) issues.push("rizline: duplicate artwork " + artwork.artworkId);
      artworkIds.add(artwork.artworkId);
      const resource = resources.get(artwork.resourceId);
      const variant = variants.get(artwork.variantId);
      if (!resource) {
        issues.push("rizline: dangling Resource " + artwork.resourceId);
        continue;
      }
      if (resource.game !== "rizline" || resource.resourceType !== "jacket" || resource.lifecycle.status !== "published") {
        issues.push("rizline: artwork Resource " + artwork.resourceId + " is not a published jacket");
      }
      if (!variant || variant.resourceId !== resource.id || variant.variantKey !== artwork.variantKey) {
        issues.push("rizline: artwork " + artwork.artworkId + " has an invalid Variant reference");
      }
    }
  }
  if (parsed.data.recordCounts.songs !== parsed.data.songs.length) issues.push("rizline: song count does not match recordCounts");
  if (parsed.data.recordCounts.artworks !== artworkCount) issues.push("rizline: artwork count does not match recordCounts");
  issues.push(...validateBrowsePublicData(parsed.data));
  return issues.length > 0 ? { success: false, issues } : { success: true, data: parsed.data };
}

export function validateCategoryBrowseProjection(value: unknown, catalog: Catalog): CategoryBrowseValidationResult {
  const parsed = CategoryBrowseProjection.safeParse(value);
  if (!parsed.success) {
    return { success: false, issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) };
  }
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const annotation of parsed.data.resources) {
    if (seen.has(annotation.resourceId)) issues.push(`${parsed.data.game}: duplicate semantic Resource ${annotation.resourceId}`);
    seen.add(annotation.resourceId);
    const resource = catalog.resources.find((candidate) => candidate.id === annotation.resourceId);
    if (!resource) {
      issues.push(`${parsed.data.game}: dangling semantic Resource ${annotation.resourceId}`);
      continue;
    }
    if (resource.game !== parsed.data.game) issues.push(`${parsed.data.game}: semantic Resource ${annotation.resourceId} belongs to ${resource.game}`);
    if (resource.resourceType !== annotation.resourceType) issues.push(`${parsed.data.game}: semantic Resource ${annotation.resourceId} says ${annotation.resourceType}, Catalog says ${resource.resourceType}`);
    if (resource.lifecycle.status !== "published") issues.push(`${parsed.data.game}: semantic Resource ${annotation.resourceId} is not published`);
  }
  issues.push(...validateBrowsePublicData(parsed.data));
  return issues.length > 0 ? { success: false, issues } : { success: true, data: parsed.data };
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function catalogSha256FromValue(catalog: Catalog): string {
  return sha256Text(stableJson(catalog));
}

function sha256Json(value: unknown): string {
  return sha256Text(stableJson(value));
}

export function browseProjectionSha256(value: unknown): string {
  return sha256Json(value);
}

function resourceMap(catalog: Catalog, game: "arcaea" | "phigros", resourceTypes: string[]): Map<string, (typeof catalog.resources)[number]> {
  return new Map(catalog.resources.filter((resource) => resource.game === game && resourceTypes.includes(resource.resourceType)).map((resource) => [resource.id, resource]));
}

function resourceIdSet(values: Array<string | null | undefined>): Set<string> {
  return new Set(values.filter((value): value is string => Boolean(value)));
}

function arcaeaArtworkKey(role: "default" | "difficulty" | "night/special", difficultyClass?: string): string {
  return `${role}:${difficultyClass ?? ""}`;
}

function sourceResourceId<T extends { resourceId?: string | null | undefined }>(value: T, previous: string | null | undefined): string | null {
  if (value.resourceId !== undefined) return value.resourceId;
  return previous ?? null;
}

function previousArcaeaArtwork(song: ArcaeaSongRecordType | undefined, role: "default" | "difficulty" | "night/special", difficultyClass?: string) {
  return song?.artworks.find((artwork) => arcaeaArtworkKey(artwork.role, artwork.difficultyClass) === arcaeaArtworkKey(role, difficultyClass));
}

function previousPhigrosTrack(previous: PhigrosBrowseProjectionType | undefined, sourceIdentityCandidate: string, sourceTrackPath: string): PhigrosTrackRecordType | undefined {
  return [...(previous?.tracks ?? []), ...(previous?.sourceOnlyTracks ?? [])].find((track) => track.sourceIdentityCandidate === sourceIdentityCandidate || track.sourceTrackPath === sourceTrackPath);
}

function phigrosIdentityCandidate(value: string): string {
  return value.replace(/^phigros:trackpath=/u, "");
}

function curatedResourceArtist(resource: Catalog["resources"][number] | undefined): string | null {
  const artist = resource?.metadata.artist;
  return typeof artist === "string" && artist.trim() ? artist.trim() : null;
}

function arcaeaSpecialArtworks(entry: ArcaeaCurationType["entries"][number]): ArcaeaSpecialRecordType["artworks"] {
  const artworks: ArcaeaSpecialRecordType["artworks"] = [];
  if (entry.seasonalResourceId) {
    artworks.push({ role: "seasonal", resourceId: entry.seasonalResourceId, currentApkPresence: entry.seasonalCurrentApkPresence });
  }
  if (entry.permanentByd) {
    artworks.push({ role: "permanent-byd", difficultyClass: "BYD", resourceId: entry.permanentByd.resourceId, currentApkPresence: entry.permanentByd.currentApkPresence });
  }
  return artworks;
}

function buildArcaeaSpecials(curation: ArcaeaCurationType): ArcaeaSpecialRecordType[] {
  return [...curation.entries]
    .sort((a, b) => a.year - b.year || a.baseSongId.localeCompare(b.baseSongId, "en"))
    .map((entry) => ArcaeaSpecialRecord.parse({
      specialId: `arcaea:april-fools:${entry.year}`,
      specialType: entry.specialType,
      year: entry.year,
      version: entry.version,
      releaseDate: entry.releaseDate,
      specialTitle: entry.specialTitle,
      baseSongId: entry.baseSongId,
      relationType: entry.relationType,
      currentRepresentation: entry.currentRepresentation,
      standaloneSonglistRecord: entry.standaloneSonglistRecord,
      artworks: arcaeaSpecialArtworks(entry),
      searchTerms: searchTerms([entry.specialTitle, entry.baseSongId, String(entry.year), entry.version, entry.releaseDate]),
    }));
}

function buildArcaeaExtras(options: {
  catalog: Catalog;
  source: ArcaeaSourceMetadataType;
  songs: ArcaeaSongRecordType[];
  specials: ArcaeaSpecialRecordType[];
  previous?: ArcaeaBrowseProjectionType | undefined;
}): { archiveExtras: ArcaeaBrowseProjectionType["archiveExtras"]; unresolvedExtras: ArcaeaBrowseProjectionType["unresolvedExtras"] } {
  const resources = resourceMap(options.catalog, "arcaea", ["jacket"]);
  const semanticById = new Map(options.source.resourceSemantics.map((item) => [item.resourceId, item]));
  const currentSongIds = new Set(options.songs.map((song) => song.songId));
  const regularReferences = resourceIdSet(options.songs.flatMap((song) => song.artworks.map((artwork) => artwork.resourceId)));
  const specialReferences = resourceIdSet(options.specials.flatMap((special) => special.artworks.map((artwork) => artwork.resourceId)));
  const archive = new Map<string, ArcaeaBrowseProjectionType["archiveExtras"][number]>();
  const unresolved = new Map<string, ArcaeaBrowseProjectionType["unresolvedExtras"][number]>();

  const addSemantic = (resourceId: string, item: ReturnType<typeof ArcaeaResourceSemantic.parse>): void => {
    if (!resources.has(resourceId) || regularReferences.has(resourceId)) return;
    // A curated seasonal/legacy resource can be referenced by a special record
    // without also becoming an archive card. The special relation owns its
    // browse category; legacy duplicates not consumed by a special relation
    // remain archive extras.
    if (specialReferences.has(resourceId)) return;
    const target = item.bucket === "unresolvedExtra" ? unresolved : item.bucket === "archiveExtra" ? archive : unresolved;
    const extra = {
      resourceId,
      reason: item.reason,
      currentApkPresence: false as const,
      ...(item.relatedSongId ? { relatedSongId: item.relatedSongId } : {}),
      ...(item.difficultyClass ? { difficultyClass: item.difficultyClass } : {}),
      ...(item.specialType ? { specialRelation: item.specialType } : {}),
      searchTerms: searchTerms([resourceId, item.relatedSongId, item.reason]),
    };
    target.set(resourceId, extra);
  };

  for (const item of options.source.resourceSemantics) addSemantic(item.resourceId, item);

  // When a future source no longer contains an old Song, retain its Resource as
  // an archive extra. This is intentionally not a "removed" lifecycle claim.
  for (const previousSong of options.previous?.songs ?? []) {
    if (currentSongIds.has(previousSong.songId)) continue;
    for (const artwork of previousSong.artworks) {
      if (!artwork.resourceId || !resources.has(artwork.resourceId) || specialReferences.has(artwork.resourceId)) continue;
      if (!archive.has(artwork.resourceId) && !unresolved.has(artwork.resourceId)) {
        archive.set(artwork.resourceId, {
          resourceId: artwork.resourceId,
          reason: "song-not-present-in-current-source",
          currentApkPresence: false,
          relatedSongId: previousSong.songId,
          ...(artwork.difficultyClass ? { difficultyClass: artwork.difficultyClass } : {}),
          searchTerms: searchTerms([previousSong.displayTitle, previousSong.songId]),
        });
      }
    }
  }

  // A new Catalog jacket must never silently disappear from Browse. If no
  // reviewer semantic bucket exists yet, keep it visible in unresolvedExtras.
  for (const resourceId of resources.keys()) {
    if (regularReferences.has(resourceId) || archive.has(resourceId) || unresolved.has(resourceId) || specialReferences.has(resourceId)) continue;
    const semantic = semanticById.get(resourceId);
    unresolved.set(resourceId, {
      resourceId,
      reason: semantic?.reason ?? "unmapped-catalog-jacket-resource",
      currentApkPresence: false,
      searchTerms: searchTerms([resourceId, semantic?.displayTitle, semantic?.sourceFilename]),
    });
  }

  return {
    archiveExtras: [...archive.values()].sort((a, b) => a.resourceId.localeCompare(b.resourceId, "en")),
    unresolvedExtras: [...unresolved.values()].sort((a, b) => a.resourceId.localeCompare(b.resourceId, "en")),
  };
}

function buildArcaeaProjection(input: {
  catalog: Catalog;
  source: ArcaeaSourceMetadataType;
  curation: ArcaeaCurationType;
  previous?: ArcaeaBrowseProjectionType | undefined;
  generatedAt: string;
}): ArcaeaBrowseProjectionType {
  const previousBySongId = new Map((input.previous?.songs ?? []).map((song) => [song.songId, song]));
  const songs = [...input.source.songs]
    .sort((a, b) => a.orderHint - b.orderHint || a.songId.localeCompare(b.songId, "en"))
    .map((sourceSong) => {
      const previousSong = previousBySongId.get(sourceSong.songId);
      const artworks = [...sourceSong.artworks]
        .map((sourceArtwork) => {
          const previousArtwork = previousArcaeaArtwork(previousSong, sourceArtwork.role, sourceArtwork.difficultyClass);
          const resourceId = sourceResourceId(sourceArtwork, previousArtwork?.resourceId);
          const currentApkPresence = sourceArtwork.currentApkPresence;
          return {
            role: sourceArtwork.role,
            ...(sourceArtwork.difficultyClass ? { difficultyClass: sourceArtwork.difficultyClass } : {}),
            resourceId,
            currentApkPresence,
            matchStatus: sourceArtwork.matchStatus ?? (resourceId ? "confirmed" : currentApkPresence ? "missing" : "unmatched"),
            ...(sourceArtwork.sourcePath ? { sourcePath: sourceArtwork.sourcePath } : {}),
          } satisfies ArcaeaSongRecordType["artworks"][number];
        })
        .sort((a, b) => a.role.localeCompare(b.role, "en") || (a.difficultyClass ?? "").localeCompare(b.difficultyClass ?? "", "en") || (a.resourceId ?? "").localeCompare(b.resourceId ?? "", "en"));
      const titleAliases = uniqueSorted(sourceSong.titleAliases);
      const artistAliases = uniqueSorted(sourceSong.artistAliases);
      return ArcaeaSongRecord.parse({
        songId: sourceSong.songId,
        displayTitle: sourceSong.displayTitle,
        titleAliases,
        artist: sourceSong.artist,
        artistAliases,
        pack: { packId: sourceSong.packId, displayName: sourceSong.packDisplayName ?? null },
        version: sourceSong.version ?? null,
        date: sourceSong.date ?? null,
        sideRaw: sourceSong.sideRaw ?? null,
        bpm: sourceSong.bpm ?? null,
        orderHint: sourceSong.orderHint,
        charts: [...sourceSong.charts].sort((a, b) => a.difficultyClass.localeCompare(b.difficultyClass, "en")),
        artworks,
        relatedSongs: [...sourceSong.relatedSongs].sort((a, b) => a.songId.localeCompare(b.songId, "en") || a.relationType.localeCompare(b.relationType, "en")),
        ...(sourceSong.specialRelation ? { specialRelation: sourceSong.specialRelation } : {}),
        searchTerms: searchTerms([
          sourceSong.displayTitle,
          ...titleAliases,
          sourceSong.artist,
          ...artistAliases,
          ...sourceSong.charts.flatMap((chart) => [chart.title, chart.artist]),
          sourceSong.songId,
          sourceSong.packId,
          sourceSong.packDisplayName,
        ]),
      });
    });
  const specials = buildArcaeaSpecials(input.curation);
  const extras = buildArcaeaExtras({ catalog: input.catalog, source: input.source, songs, specials, previous: input.previous });
  const currentArtwork = songs.flatMap((song) => song.artworks);
  return ArcaeaBrowseProjection.parse({
    schemaVersion: BROWSE_SCHEMA_VERSION,
    game: "arcaea",
    generatedAt: input.generatedAt,
    source: { version: input.source.sourceVersion, sha256: input.source.sourceSha256 },
    songs,
    specials,
    ...extras,
    recordCounts: {
      regularSongs: songs.length,
      currentArtworkSlots: currentArtwork.filter((artwork) => artwork.currentApkPresence).length,
      currentArtworkResourceReferences: currentArtwork.filter((artwork) => artwork.currentApkPresence && artwork.resourceId !== null).length,
      missingCurrentArtwork: currentArtwork.filter((artwork) => artwork.currentApkPresence && artwork.resourceId === null).length,
      specialRecords: specials.length,
      archiveExtras: extras.archiveExtras.length,
      unresolvedExtras: extras.unresolvedExtras.length,
    },
  });
}

function buildPhigrosSpecials(options: { catalog: Catalog; source: PhigrosSourceMetadataType; previous?: PhigrosBrowseProjectionType | undefined }): PhigrosSpecialRecordType[] {
  const resources = resourceMap(options.catalog, "phigros", ["phigros-april-fools"]);
  const previous = new Map((options.previous?.specials ?? []).map((special) => [special.artworkResourceId, special]));
  const semantics = options.source.resourceSemantics.filter((item) => item.bucket === "special" && resources.has(item.resourceId));
  const byResource = new Map<string, PhigrosSpecialRecordType>();
  for (const item of semantics) {
    const resource = resources.get(item.resourceId);
    const displayTitle = item.displayTitle ?? resource?.title ?? item.sourceFilename ?? item.resourceId;
    byResource.set(item.resourceId, PhigrosSpecialRecord.parse({
      specialId: `phigros:april-fools:${item.resourceId}`,
      specialType: "april-fools",
      displayTitle,
      artworkResourceId: item.resourceId,
      ...(item.sourceFilename ? { sourceFilename: item.sourceFilename } : {}),
      isTrackMapped: false,
      searchTerms: searchTerms([displayTitle, item.sourceFilename, item.resourceId]),
    }));
  }
  for (const [resourceId, special] of previous) if (resources.has(resourceId) && !byResource.has(resourceId)) byResource.set(resourceId, special);
  return [...byResource.values()].sort((a, b) => a.displayTitle.localeCompare(b.displayTitle, "zh-CN") || a.artworkResourceId.localeCompare(b.artworkResourceId, "en"));
}

function buildPhigrosExtras(options: { catalog: Catalog; source: PhigrosSourceMetadataType; tracks: PhigrosTrackRecordType[]; specials: PhigrosSpecialRecordType[]; previous?: PhigrosBrowseProjectionType | undefined }): PhigrosBrowseProjectionType["archiveExtras"] {
  const resources = resourceMap(options.catalog, "phigros", ["jacket"]);
  const currentReferences = resourceIdSet(options.tracks.map((track) => track.artwork?.resourceId));
  const specialReferences = resourceIdSet(options.specials.map((special) => special.artworkResourceId));
  const semanticById = new Map(options.source.resourceSemantics.map((item) => [item.resourceId, item]));
  const extras = new Map<string, PhigrosBrowseProjectionType["archiveExtras"][number]>();
  for (const item of options.source.resourceSemantics) {
    if (item.bucket !== "archiveExtra" || !resources.has(item.resourceId) || currentReferences.has(item.resourceId)) continue;
    extras.set(item.resourceId, {
      resourceId: item.resourceId,
      reason: item.reason,
      current: false,
      ...(item.sourceFilename ? { sourceFilename: item.sourceFilename } : {}),
      searchTerms: searchTerms([item.displayTitle, item.sourceFilename, item.resourceId]),
    });
  }
  for (const extra of options.previous?.archiveExtras ?? []) if (resources.has(extra.resourceId) && !currentReferences.has(extra.resourceId) && !specialReferences.has(extra.resourceId)) extras.set(extra.resourceId, extra);
  for (const resourceId of resources.keys()) {
    if (currentReferences.has(resourceId) || extras.has(resourceId)) continue;
    const semantic = semanticById.get(resourceId);
    extras.set(resourceId, {
      resourceId,
      reason: semantic?.reason ?? "unmapped-catalog-jacket-resource",
      current: false,
      ...(semantic?.sourceFilename ? { sourceFilename: semantic.sourceFilename } : {}),
      searchTerms: searchTerms([semantic?.displayTitle, semantic?.sourceFilename, resourceId]),
    });
  }
  return [...extras.values()].sort((a, b) => a.resourceId.localeCompare(b.resourceId, "en"));
}

function buildPhigrosProjection(input: { catalog: Catalog; source: PhigrosSourceMetadataType; previous?: PhigrosBrowseProjectionType | undefined; generatedAt: string }): PhigrosBrowseProjectionType {
  const previous = input.previous;
  const tracks = [...input.source.tracks].sort((a, b) => a.sourceTrackPath.localeCompare(b.sourceTrackPath, "en")).map((sourceTrack) => {
    const sourceIdentityCandidate = phigrosIdentityCandidate(sourceTrack.sourceIdentityCandidate);
    const prior = previousPhigrosTrack(previous, sourceIdentityCandidate, sourceTrack.sourceTrackPath);
    const candidateResourceId = sourceTrack.artworkResourceId !== undefined ? sourceTrack.artworkResourceId : prior?.artwork?.resourceId ?? null;
    const candidateResource = candidateResourceId ? input.catalog.resources.find((candidate) => candidate.id === candidateResourceId) : undefined;
    // April Fools Resources are an independent semantic collection. Even if a
    // source adapter accidentally associates one with a Track, it must not
    // become a normal Track image card; the special record owns that relation.
    const resourceId = candidateResource?.resourceType === "phigros-april-fools" ? null : candidateResourceId;
    const resource = resourceId ? input.catalog.resources.find((candidate) => candidate.id === resourceId) : undefined;
    const curatedResource = resource?.resourceType === "jacket" ? resource : undefined;
    const displayTitle = curatedResource?.title ?? prior?.displayTitle ?? sourceTrack.displayTitle ?? sourceTrack.sourceTitle;
    const displayArtist = curatedResourceArtist(curatedResource) ?? firstNonEmpty(prior?.displayArtist, sourceTrack.displayArtist, sourceTrack.sourceArtist);
    const artwork = resourceId ? {
      resourceId,
      confidence: sourceTrack.artworkConfidence ?? prior?.artwork?.confidence ?? "unknown",
      role: "current-track-artwork" as const,
    } : null;
    const searchAliases = uniqueSorted(sourceTrack.searchAliases);
    return PhigrosTrackRecord.parse({
      sourceIdentityCandidate,
      sourceTrackPath: sourceTrack.sourceTrackPath,
      displayTitle,
      sourceTitle: sourceTrack.sourceTitle,
      displayArtist,
      sourceArtist: sourceTrack.sourceArtist,
      indexRaw: sourceTrack.indexRaw,
      artwork,
      charts: [...sourceTrack.charts].sort((a, b) => a.difficultyClass.localeCompare(b.difficultyClass, "en") || Number(a.errorVariant) - Number(b.errorVariant)),
      displayLevel: null,
      chapter: null,
      ...(sourceTrack.specialKind ? { specialKind: sourceTrack.specialKind } : {}),
      ...(sourceTrack.family ? { family: sourceTrack.family } : {}),
      searchAliases,
      searchTerms: searchTerms([displayTitle, sourceTrack.sourceTitle, displayArtist, sourceTrack.sourceArtist, ...searchAliases, sourceTrack.sourceTrackPath]),
    });
  });
  const currentTracks = tracks.filter((track) => track.artwork !== null);
  const sourceOnlyTracks = tracks.filter((track) => track.artwork === null);
  const specials = buildPhigrosSpecials({ catalog: input.catalog, source: input.source, previous });
  const archiveExtras = buildPhigrosExtras({ catalog: input.catalog, source: input.source, tracks: currentTracks, specials, previous });
  return PhigrosBrowseProjection.parse({
    schemaVersion: BROWSE_SCHEMA_VERSION,
    game: "phigros",
    generatedAt: input.generatedAt,
    source: { version: input.source.sourceVersion, sha256: input.source.sourceSha256 },
    tracks: currentTracks,
    specials,
    archiveExtras,
    sourceOnlyTracks,
    recordCounts: {
      sourceTrackRecords: tracks.length,
      currentTrackArtworkEntries: currentTracks.length,
      specialRecords: specials.length,
      archiveExtras: archiveExtras.length,
      sourceOnlyTracks: sourceOnlyTracks.length,
    },
  });
}

function diagnosticsForArcaea(projection: ArcaeaBrowseProjectionType, catalog: Catalog): BrowseDiagnosticsType["arcaea"] {
  const resources = resourceMap(catalog, "arcaea", ["jacket"]);
  const references = resourceIdSet([
    ...projection.songs.flatMap((song) => song.artworks.map((artwork) => artwork.resourceId)),
    ...projection.specials.flatMap((special) => special.artworks.map((artwork) => artwork.resourceId)),
    ...projection.archiveExtras.map((extra) => extra.resourceId),
    ...projection.unresolvedExtras.map((extra) => extra.resourceId),
  ]);
  const dangling = [...references].filter((resourceId) => !resources.has(resourceId));
  const unreferenced = [...resources.keys()].filter((resourceId) => !references.has(resourceId)).sort((a, b) => a.localeCompare(b, "en"));
  return {
    ok: dangling.length === 0 && unreferenced.length === 0,
    catalogResourceCount: resources.size,
    referencedResourceCount: references.size,
    unreferencedResourceIds: unreferenced,
    danglingResourceIds: dangling.sort((a, b) => a.localeCompare(b, "en")),
    warnings: [],
    counts: {
      regularSongs: projection.songs.length,
      currentArtworkSlots: projection.recordCounts.currentArtworkSlots,
      currentArtworkResourceReferences: projection.recordCounts.currentArtworkResourceReferences,
      missingCurrentArtwork: projection.recordCounts.missingCurrentArtwork,
      specialRecords: projection.specials.length,
      archiveExtras: projection.archiveExtras.length,
      unresolvedExtras: projection.unresolvedExtras.length,
    },
    missingCurrentArtwork: projection.songs.flatMap((song) => song.artworks.filter((artwork) => artwork.currentApkPresence && artwork.resourceId === null && artwork.sourcePath).map((artwork) => ({ songId: song.songId, sourcePath: artwork.sourcePath! }))).sort((a, b) => a.songId.localeCompare(b.songId, "en") || a.sourcePath.localeCompare(b.sourcePath, "en")),
  };
}

function diagnosticsForPhigros(projection: PhigrosBrowseProjectionType, catalog: Catalog): BrowseDiagnosticsType["phigros"] {
  const resources = resourceMap(catalog, "phigros", ["jacket", "phigros-april-fools"]);
  const references = resourceIdSet([
    ...projection.tracks.map((track) => track.artwork?.resourceId),
    ...projection.specials.map((special) => special.artworkResourceId),
    ...projection.archiveExtras.map((extra) => extra.resourceId),
  ]);
  const dangling = [...references].filter((resourceId) => !resources.has(resourceId));
  const unreferenced = [...resources.keys()].filter((resourceId) => !references.has(resourceId)).sort((a, b) => a.localeCompare(b, "en"));
  return {
    ok: dangling.length === 0 && unreferenced.length === 0,
    catalogResourceCount: resources.size,
    referencedResourceCount: references.size,
    unreferencedResourceIds: unreferenced,
    danglingResourceIds: dangling.sort((a, b) => a.localeCompare(b, "en")),
    warnings: [],
    counts: {
      sourceTrackRecords: projection.recordCounts.sourceTrackRecords,
      currentTrackArtworkEntries: projection.recordCounts.currentTrackArtworkEntries,
      specialRecords: projection.specials.length,
      archiveExtras: projection.archiveExtras.length,
      sourceOnlyTracks: projection.sourceOnlyTracks.length,
    },
    missingCurrentArtwork: [],
  };
}

function browseManifest(input: { catalog: Catalog; catalogSha256: string; arcaea: ArcaeaBrowseProjectionType; phigros: PhigrosBrowseProjectionType; generatedAt: string }): BrowseManifestType {
  return BrowseManifest.parse({
    schemaVersion: BROWSE_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    games: {
      arcaea: { sourceVersion: input.arcaea.source.version, sourceSha256: input.arcaea.source.sha256, fileSha256: sha256Json(input.arcaea), recordCounts: input.arcaea.recordCounts },
      phigros: { sourceVersion: input.phigros.source.version, sourceSha256: input.phigros.source.sha256, fileSha256: sha256Json(input.phigros), recordCounts: input.phigros.recordCounts },
    },
    catalog: { catalogId: input.catalog.catalogId, catalogSha256: input.catalogSha256, catalogGeneratedAt: input.catalog.generatedAt },
    files: { arcaea: "arcaea.json", phigros: "phigros.json", manifest: "manifest.json", diagnostics: "diagnostics.json" },
  });
}

export function buildBrowseProjections(input: BrowseProjectionBuildInput): BrowseProjectionBuildResult {
  const generatedAt = ISO_DATE.parse(input.generatedAt);
  const arcaeaSource = ArcaeaSourceMetadata.parse(input.arcaea);
  const phigrosSource = PhigrosSourceMetadata.parse(input.phigros);
  const curation = ArcaeaCuration.parse(input.arcaeaCuration);
  const arcaea = buildArcaeaProjection({ catalog: input.catalog, source: arcaeaSource, curation, previous: input.previous?.arcaea, generatedAt });
  const phigros = buildPhigrosProjection({ catalog: input.catalog, source: phigrosSource, previous: input.previous?.phigros, generatedAt });
  const diagnostics = BrowseDiagnostics.parse({ schemaVersion: BROWSE_SCHEMA_VERSION, generatedAt, arcaea: diagnosticsForArcaea(arcaea, input.catalog), phigros: diagnosticsForPhigros(phigros, input.catalog) });
  const result = { arcaea, phigros, diagnostics, manifest: browseManifest({ catalog: input.catalog, catalogSha256: input.catalogSha256 ?? catalogSha256FromValue(input.catalog), arcaea, phigros, generatedAt }) } satisfies BrowseProjectionBuildResult;
  const validation = validateBrowseProjectionSet(result, input.catalog);
  if (!validation.success) throw new Error(`Browse Projection validation failed: ${validation.issues.join("; ")}`);
  return validation.data;
}

function referenceEntries(result: BrowseProjectionBuildResult): Array<{ game: "arcaea" | "phigros"; resourceId: string; kind: "song" | "special" | "track" | "extra" }> {
  const entries: Array<{ game: "arcaea" | "phigros"; resourceId: string; kind: "song" | "special" | "track" | "extra" }> = [];
  for (const song of result.arcaea.songs) for (const artwork of song.artworks) if (artwork.resourceId) entries.push({ game: "arcaea", resourceId: artwork.resourceId, kind: "song" });
  for (const special of result.arcaea.specials) for (const artwork of special.artworks) if (artwork.resourceId) entries.push({ game: "arcaea", resourceId: artwork.resourceId, kind: "special" });
  for (const extra of [...result.arcaea.archiveExtras, ...result.arcaea.unresolvedExtras]) entries.push({ game: "arcaea", resourceId: extra.resourceId, kind: "extra" });
  for (const track of result.phigros.tracks) if (track.artwork) entries.push({ game: "phigros", resourceId: track.artwork.resourceId, kind: "track" });
  for (const special of result.phigros.specials) entries.push({ game: "phigros", resourceId: special.artworkResourceId, kind: "special" });
  for (const extra of result.phigros.archiveExtras) entries.push({ game: "phigros", resourceId: extra.resourceId, kind: "extra" });
  return entries;
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateProjectionCounts(result: BrowseProjectionBuildResult, issues: string[]): void {
  const arcaeaCounts: Array<[string, number, number]> = [
    ["regularSongs", result.arcaea.songs.length, result.arcaea.recordCounts.regularSongs],
    ["currentArtworkSlots", result.arcaea.songs.flatMap((song) => song.artworks).filter((artwork) => artwork.currentApkPresence).length, result.arcaea.recordCounts.currentArtworkSlots],
    ["currentArtworkResourceReferences", result.arcaea.songs.flatMap((song) => song.artworks).filter((artwork) => artwork.currentApkPresence && artwork.resourceId !== null).length, result.arcaea.recordCounts.currentArtworkResourceReferences],
    ["missingCurrentArtwork", result.arcaea.songs.flatMap((song) => song.artworks).filter((artwork) => artwork.currentApkPresence && artwork.resourceId === null).length, result.arcaea.recordCounts.missingCurrentArtwork],
    ["specialRecords", result.arcaea.specials.length, result.arcaea.recordCounts.specialRecords],
    ["archiveExtras", result.arcaea.archiveExtras.length, result.arcaea.recordCounts.archiveExtras],
    ["unresolvedExtras", result.arcaea.unresolvedExtras.length, result.arcaea.recordCounts.unresolvedExtras],
  ];
  const phigrosCounts: Array<[string, number, number]> = [
    ["sourceTrackRecords", [...result.phigros.tracks, ...result.phigros.sourceOnlyTracks].length, result.phigros.recordCounts.sourceTrackRecords],
    ["currentTrackArtworkEntries", result.phigros.tracks.length, result.phigros.recordCounts.currentTrackArtworkEntries],
    ["specialRecords", result.phigros.specials.length, result.phigros.recordCounts.specialRecords],
    ["archiveExtras", result.phigros.archiveExtras.length, result.phigros.recordCounts.archiveExtras],
    ["sourceOnlyTracks", result.phigros.sourceOnlyTracks.length, result.phigros.recordCounts.sourceOnlyTracks],
  ];
  for (const [name, actual, declared] of [...arcaeaCounts, ...phigrosCounts]) if (actual !== declared) issues.push(`recordCounts.${name} does not match projection contents`);
  for (const [name, actual] of arcaeaCounts) if (result.diagnostics.arcaea.counts[name] !== actual) issues.push(`diagnostics.arcaea.counts.${name} does not match projection contents`);
  for (const [name, actual] of phigrosCounts) if (result.diagnostics.phigros.counts[name] !== actual) issues.push(`diagnostics.phigros.counts.${name} does not match projection contents`);
}

function validateArcaeaPrimaryCategories(result: BrowseProjectionBuildResult, catalog: Catalog, issues: string[]): void {
  const categories = new Map<string, Set<string>>();
  const add = (resourceId: string, category: string) => categories.set(resourceId, new Set([...(categories.get(resourceId) ?? []), category]));
  const regularReferences = new Set(result.arcaea.songs.flatMap((song) => song.artworks.map((artwork) => artwork.resourceId).filter((resourceId): resourceId is string => Boolean(resourceId))));
  for (const resourceId of regularReferences) add(resourceId, "regular-song");
  for (const special of result.arcaea.specials) for (const artwork of special.artworks) if (artwork.resourceId && (artwork.role === "seasonal" || !regularReferences.has(artwork.resourceId))) add(artwork.resourceId, "special");
  for (const extra of result.arcaea.archiveExtras) add(extra.resourceId, "archive-extra");
  for (const extra of result.arcaea.unresolvedExtras) add(extra.resourceId, "unresolved-extra");
  for (const [resourceId, resourceCategories] of categories) if (resourceCategories.size > 1) issues.push(`arcaea Resource ${resourceId} has multiple primary browse categories: ${[...resourceCategories].sort().join(", ")}`);
  for (const resource of resourceMap(catalog, "arcaea", ["jacket"]).values()) if (!categories.has(resource.id)) issues.push(`arcaea Resource ${resource.id} has no primary browse category`);
}

export function validateBrowseProjectionSet(result: BrowseProjectionBuildResult, catalog: Catalog): BrowseValidationResult {
  const issues: string[] = [];
  const arcaeaParsed = ArcaeaBrowseProjection.safeParse(result.arcaea);
  const phigrosParsed = PhigrosBrowseProjection.safeParse(result.phigros);
  const manifestParsed = BrowseManifest.safeParse(result.manifest);
  const diagnosticsParsed = BrowseDiagnostics.safeParse(result.diagnostics);
  if (!arcaeaParsed.success) issues.push(...arcaeaParsed.error.issues.map((issue) => `arcaea.${issue.path.join(".")}: ${issue.message}`));
  if (!phigrosParsed.success) issues.push(...phigrosParsed.error.issues.map((issue) => `phigros.${issue.path.join(".")}: ${issue.message}`));
  if (!manifestParsed.success) issues.push(...manifestParsed.error.issues.map((issue) => `manifest.${issue.path.join(".")}: ${issue.message}`));
  if (!diagnosticsParsed.success) issues.push(...diagnosticsParsed.error.issues.map((issue) => `diagnostics.${issue.path.join(".")}: ${issue.message}`));
  if (issues.length > 0) return { success: false, issues };

  const references = referenceEntries(result);
  for (const reference of references) {
    const resource = catalog.resources.find((candidate) => candidate.id === reference.resourceId);
    if (!resource) issues.push(`${reference.game}: dangling Resource reference ${reference.resourceId}`);
    else if (resource.game !== reference.game) issues.push(`${reference.game}: Resource ${reference.resourceId} belongs to ${resource.game}`);
    else if (reference.game === "arcaea" && resource.resourceType !== "jacket") issues.push(`arcaea: Resource ${reference.resourceId} is not a jacket`);
    else if (reference.game === "phigros" && reference.kind === "track" && resource.resourceType !== "jacket") issues.push(`phigros: Track artwork Resource ${reference.resourceId} is not a jacket`);
    else if (reference.game === "phigros" && reference.kind !== "track" && !["jacket", "phigros-april-fools"].includes(resource.resourceType)) issues.push(`phigros: Resource ${reference.resourceId} is not an artwork resource`);
  }
  if (!result.diagnostics.arcaea.ok) issues.push(`arcaea diagnostics not clean: ${result.diagnostics.arcaea.unreferencedResourceIds.length} unreferenced, ${result.diagnostics.arcaea.danglingResourceIds.length} dangling`);
  if (!result.diagnostics.phigros.ok) issues.push(`phigros diagnostics not clean: ${result.diagnostics.phigros.unreferencedResourceIds.length} unreferenced, ${result.diagnostics.phigros.danglingResourceIds.length} dangling`);
  issues.push(...validateBrowsePublicData(result));
  validateProjectionCounts(result, issues);
  validateArcaeaPrimaryCategories(result, catalog, issues);
  const expectedArcaeaReferences = new Set(references.filter((reference) => reference.game === "arcaea").map((reference) => reference.resourceId));
  const expectedPhigrosReferences = new Set(references.filter((reference) => reference.game === "phigros").map((reference) => reference.resourceId));
  const expectedArcaeaDangling = [...expectedArcaeaReferences].filter((resourceId) => !resourceMap(catalog, "arcaea", ["jacket"]).has(resourceId)).sort((a, b) => a.localeCompare(b, "en"));
  const expectedPhigrosDangling = [...expectedPhigrosReferences].filter((resourceId) => !resourceMap(catalog, "phigros", ["jacket", "phigros-april-fools"]).has(resourceId)).sort((a, b) => a.localeCompare(b, "en"));
  const expectedArcaeaUnreferenced = [...resourceMap(catalog, "arcaea", ["jacket"]).keys()].filter((resourceId) => !expectedArcaeaReferences.has(resourceId)).sort((a, b) => a.localeCompare(b, "en"));
  const expectedPhigrosUnreferenced = [...resourceMap(catalog, "phigros", ["jacket", "phigros-april-fools"]).keys()].filter((resourceId) => !expectedPhigrosReferences.has(resourceId)).sort((a, b) => a.localeCompare(b, "en"));
  if (result.diagnostics.arcaea.catalogResourceCount !== resourceMap(catalog, "arcaea", ["jacket"]).size) issues.push("diagnostics.arcaea.catalogResourceCount does not match Catalog");
  if (result.diagnostics.phigros.catalogResourceCount !== resourceMap(catalog, "phigros", ["jacket", "phigros-april-fools"]).size) issues.push("diagnostics.phigros.catalogResourceCount does not match Catalog");
  if (result.diagnostics.arcaea.referencedResourceCount !== expectedArcaeaReferences.size) issues.push("diagnostics.arcaea.referencedResourceCount does not match references");
  if (result.diagnostics.phigros.referencedResourceCount !== expectedPhigrosReferences.size) issues.push("diagnostics.phigros.referencedResourceCount does not match references");
  if (!sameStrings(result.diagnostics.arcaea.unreferencedResourceIds, expectedArcaeaUnreferenced)) issues.push("diagnostics.arcaea.unreferencedResourceIds does not match references");
  if (!sameStrings(result.diagnostics.phigros.unreferencedResourceIds, expectedPhigrosUnreferenced)) issues.push("diagnostics.phigros.unreferencedResourceIds does not match references");
  if (!sameStrings(result.diagnostics.arcaea.danglingResourceIds, expectedArcaeaDangling)) issues.push("diagnostics.arcaea.danglingResourceIds does not match references");
  if (!sameStrings(result.diagnostics.phigros.danglingResourceIds, expectedPhigrosDangling)) issues.push("diagnostics.phigros.danglingResourceIds does not match references");
  const expectedArcaeaFileHash = sha256Json(result.arcaea);
  const expectedPhigrosFileHash = sha256Json(result.phigros);
  if (result.manifest.games.arcaea.fileSha256 !== expectedArcaeaFileHash) issues.push("manifest.games.arcaea.fileSha256 does not match arcaea.json");
  if (result.manifest.games.phigros.fileSha256 !== expectedPhigrosFileHash) issues.push("manifest.games.phigros.fileSha256 does not match phigros.json");
  if (result.manifest.generatedAt !== result.arcaea.generatedAt || result.manifest.generatedAt !== result.phigros.generatedAt || result.manifest.generatedAt !== result.diagnostics.generatedAt) issues.push("manifest and projection generatedAt values do not match");
  if (result.manifest.games.arcaea.sourceVersion !== result.arcaea.source.version || result.manifest.games.arcaea.sourceSha256 !== result.arcaea.source.sha256) issues.push("manifest.games.arcaea source metadata does not match arcaea.json");
  if (result.manifest.games.phigros.sourceVersion !== result.phigros.source.version || result.manifest.games.phigros.sourceSha256 !== result.phigros.source.sha256) issues.push("manifest.games.phigros source metadata does not match phigros.json");
  if (result.manifest.catalog.catalogId !== catalog.catalogId) issues.push("manifest.catalog.catalogId does not match Catalog");
  if (result.manifest.catalog.catalogSha256 !== catalogSha256FromValue(catalog)) issues.push("manifest.catalog.catalogSha256 does not match Catalog");
  if (result.manifest.catalog.catalogGeneratedAt !== catalog.generatedAt) issues.push("manifest.catalog.catalogGeneratedAt does not match Catalog");
  if (issues.length > 0) return { success: false, issues };
  return { success: true, data: result };
}

export function matchesArcaeaChart(song: ArcaeaSongRecordType, difficultyClass: z.infer<typeof ArcaeaDifficultyClass>, displayLevel: string): boolean {
  return song.charts.some((chart) => chart.difficultyClass === difficultyClass && chart.displayLevel === displayLevel);
}

/** BYD or another selected difficulty overrides default only when it exists. */
export function selectArcaeaArtwork(song: ArcaeaSongRecordType, difficultyClass: z.infer<typeof ArcaeaDifficultyClass>): ArcaeaSongRecordType["artworks"][number] | undefined {
  return song.artworks.find((artwork) => artwork.role === "difficulty" && artwork.difficultyClass === difficultyClass)
    ?? song.artworks.find((artwork) => artwork.role === "default");
}

export function browseProjectionJsonFiles(result: BrowseProjectionBuildResult): Array<{ filename: "arcaea.json" | "phigros.json" | "manifest.json" | "diagnostics.json"; value: unknown }> {
  return [
    { filename: "arcaea.json", value: result.arcaea },
    { filename: "phigros.json", value: result.phigros },
    { filename: "manifest.json", value: result.manifest },
    { filename: "diagnostics.json", value: result.diagnostics },
  ];
}

async function moveIfPresent(sourcePath: string, targetPath: string): Promise<boolean> {
  try {
    await rename(sourcePath, targetPath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function writeBrowseProjectionAtomic(result: BrowseProjectionBuildResult, outputDirectory = path.resolve("catalog", "browse"), catalog?: Catalog): Promise<string[]> {
  if (catalog) {
    const validation = validateBrowseProjectionSet(result, catalog);
    if (!validation.success) throw new Error(`Browse Projection cannot be written: ${validation.issues.join("; ")}`);
  } else {
    const arcaeaValidation = ArcaeaBrowseProjection.safeParse(result.arcaea);
    const phigrosValidation = PhigrosBrowseProjection.safeParse(result.phigros);
    const manifestValidation = BrowseManifest.safeParse(result.manifest);
    const diagnosticsValidation = BrowseDiagnostics.safeParse(result.diagnostics);
    if (!arcaeaValidation.success || !phigrosValidation.success || !manifestValidation.success || !diagnosticsValidation.success) {
      throw new Error("Browse Projection cannot be written because its schema is invalid.");
    }
    const publicDataIssues = validateBrowsePublicData(result);
    if (publicDataIssues.length > 0) throw new Error(`Browse Projection cannot be written: ${publicDataIssues.join("; ")}`);
  }
  await mkdir(outputDirectory, { recursive: true });
  const files = browseProjectionJsonFiles(result);
  const token = `${process.pid}-${randomUUID()}`;
  const temporary = files.map(({ filename, value }) => ({
    filename,
    value,
    target: path.join(outputDirectory, filename),
    temp: path.join(outputDirectory, `.${filename}.partial-${token}`),
    backup: path.join(outputDirectory, `.${filename}.backup-${token}`),
    backedUp: false,
    committed: false,
  }));
  try {
    for (const file of temporary) await writeFile(file.temp, stableJson(file.value), "utf8");
    for (const file of temporary) file.backedUp = await moveIfPresent(file.target, file.backup);
    for (const file of temporary) {
      await rename(file.temp, file.target);
      file.committed = true;
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const file of [...temporary].reverse()) {
      if (file.committed) {
        try { await rm(file.target, { force: true }); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      if (file.backedUp) {
        try { await rename(file.backup, file.target); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
    }
    for (const file of temporary) {
      try { await rm(file.temp, { force: true }); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      try { await rm(file.backup, { force: true }); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (rollbackErrors.length > 0) throw new AggregateError([error, ...rollbackErrors], "Browse Projection commit failed and rollback was incomplete.");
    throw error;
  }
  for (const file of temporary) await rm(file.backup, { force: true }).catch(() => undefined);
  return temporary.map((file) => file.target);
}
function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim() ?? null;
}

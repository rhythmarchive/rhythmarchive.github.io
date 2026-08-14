import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  CandidateProvenance as CandidateProvenanceSchema,
  Confidence,
  Evidence,
  ExternalIdentity,
  ReviewRequirements as ReviewRequirementsSchema,
  ResourceType,
  VariantKind,
  type CandidateProvenance,
  type ReviewRequirements,
} from "./schema.js";
import { applyReviewPolicy, type GameReviewPolicyInput } from "./review.js";
import { createUuidV7 } from "./identity.js";
import { createVersionWorkspace, type CandidateManifestAdapterInput, type CreateWorkspaceOptions, type WorkspaceHandle } from "./workspace.js";

const UUIDV7 = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const ABSOLUTE_PATH = z.string().min(1);
const PORTABLE_PATH = z.string().min(1).refine((value) => !value.includes("\0") && !value.startsWith("/") && !/^\\\\/.test(value) && !/^[a-zA-Z]:[\\/]/.test(value) && !value.split(/[\\/]+/).includes(".."), "must be a portable relative path");

export const ExtractorDiagnostic = z.object({
  code: z.string().min(1),
  severity: z.enum(["warning", "error", "blocked"]),
  message: z.string().min(1),
  detail: z.string().min(1).optional(),
  evidence: z.array(Evidence).default([]),
});

export const ExtractorApk = z.object({
  role: z.enum(["base", "target"]),
  version: z.string().min(1),
  filename: z.string().min(1),
  absolutePath: ABSOLUTE_PATH,
  sha256: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
  sizeBytes: z.number().int().positive().optional(),
  verification: z.enum(["unverified", "verified"]).default("unverified"),
});

export const ExtractorCandidate = z.object({
  id: UUIDV7.optional(),
  sourcePath: ABSOLUTE_PATH,
  sourceRelativePath: PORTABLE_PATH,
  sourceFilename: z.string().min(1),
  sourceApkVersion: z.string().min(1),
  sourceApkFilename: z.string().min(1).optional(),
  sourceSha256: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
  detection: z.enum(["added", "changed", "renamed", "legacy-seed", "manual", "unknown"]).default("added"),
  suggestedFilename: z.string().min(1),
  suggestedTitle: z.string().min(1).optional(),
  suggestedArtist: z.string().min(1).optional(),
  suggestedCategory: ResourceType,
  suggestedVariant: z.object({
    key: z.string().min(1),
    kind: VariantKind,
    difficulty: z.enum(["PST", "PRS", "FTR", "BYD", "ETR"]).optional(),
    unresolved: z.array(z.string().min(1)).default([]),
  }).optional(),
  suggestedExternalIdentity: z.array(ExternalIdentity).default([]),
  metadata: z.record(z.unknown()).default({}),
  confidence: Confidence,
  evidence: z.array(Evidence).min(1),
  reviewRequirements: ReviewRequirementsSchema,
  requiresUpscale: z.boolean().default(false),
  initialStatus: z.enum(["EXTRACTED", "NAMING_REVIEW", "BLOCKED"]).optional(),
  blockedReason: z.string().min(1).optional(),
  provenance: CandidateProvenanceSchema,
});

export const ExtractorResult = z.object({
  status: z.enum(["ok", "blocked", "failed"]),
  game: z.enum(["arcaea", "phigros"]),
  sourceType: z.enum(["arcaea_apk", "phigros_apk"]),
  baseVersion: z.string().min(1),
  targetVersion: z.string().min(1),
  baseApk: ExtractorApk,
  targetApk: ExtractorApk,
  sourceSnapshot: z.string().min(1),
  extractorVersion: z.string().min(1),
  candidates: z.array(ExtractorCandidate),
  diagnostics: z.array(ExtractorDiagnostic).default([]),
  limitations: z.array(z.string().min(1)).default([]),
});

export type ExtractorDiagnostic = z.infer<typeof ExtractorDiagnostic>;
export type ExtractorApk = z.infer<typeof ExtractorApk>;
export type ExtractorCandidate = z.infer<typeof ExtractorCandidate>;
export type ExtractorResult = z.infer<typeof ExtractorResult>;

export class ExtractorAdapterError extends Error {
  readonly diagnostics: ExtractorDiagnostic[];

  constructor(message: string, diagnostics: ExtractorDiagnostic[] = []) {
    super(message);
    this.name = "ExtractorAdapterError";
    this.diagnostics = diagnostics;
  }
}

function portable(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^assets\//i, "");
  if (!PORTABLE_PATH.safeParse(normalized).success) throw new ExtractorAdapterError(`invalid extractor relative path: ${value}`);
  return normalized;
}

function basename(value: string): string {
  const result = path.posix.basename(value.replace(/\\/g, "/"));
  if (!result || result === "." || result === "..") throw new ExtractorAdapterError(`invalid extractor filename: ${value}`);
  return result;
}

function localized(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["zh-Hans", "zh-Hant", "ja", "en"]) {
    if (typeof record[key] === "string" && record[key].trim()) return record[key].trim();
  }
  return undefined;
}

function cleanTitle(value: string | undefined): string | undefined {
  const result = value?.replace(/\s+/g, " ").trim();
  return result || undefined;
}

function safeMetadata(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(filePath));
  return hash.digest("hex");
}

async function requireSourceFile(filePath: string): Promise<{ sha256: string; sizeBytes: number }> {
  try {
    const fileStats = await stat(filePath);
    if (!fileStats.isFile()) throw new Error("not a regular file");
    return { sha256: await sha256File(filePath), sizeBytes: fileStats.size };
  } catch (error) {
    throw new ExtractorAdapterError(`extractor output file is missing or unreadable: ${filePath}`, [{
      code: "EXTRACTED_FILE_MISSING",
      severity: "blocked",
      message: "legacy extractor report referenced a file that cannot be read",
      detail: error instanceof Error ? error.message : String(error),
      evidence: [{ kind: "manual-note", detail: filePath, confidence: "high" }],
    }]);
  }
}

function policy(input: GameReviewPolicyInput): ReviewRequirements {
  return applyReviewPolicy(input);
}

function arcaeaCategory(category: string): "jacket" | "pack-cover" | "story-cg" | "story-texture" | "character-portrait" | "character-avatar" | "linkplay-preview" | "background" | "sticker" | "world-mode" | "startup" | "other" {
  const values: Record<string, ReturnType<typeof arcaeaCategory>> = {
    "曲绘": "jacket",
    "曲包封面": "pack-cover",
    "剧情/cg": "story-cg",
    "剧情贴图": "story-texture",
    "角色/立绘": "character-portrait",
    "角色/头像": "character-avatar",
    "角色/LinkPlay预览": "linkplay-preview",
    "游玩背景": "background",
    "LinkPlay贴纸": "sticker",
    "世界模式": "world-mode",
    "启动页面": "startup",
  };
  return values[category] ?? "other";
}

function assertKnownArcaeaCategory(category: string): void {
  if (arcaeaCategory(category) === "other") {
    throw new ExtractorAdapterError(`unknown Arcaea extractor category: ${category}`, [{
      code: "UNKNOWN_CATEGORY",
      severity: "error",
      message: "the adapter refuses to emit a normal Candidate for an unknown legacy category",
      evidence: [{ kind: "manual-note", detail: category, confidence: "high" }],
    }]);
  }
}

function phigrosCategory(category: string): "jacket" | "character-avatar" | "phigros-april-fools" | "other" {
  if (category === "曲绘") return "jacket";
  if (category === "头像") return "character-avatar";
  if (category === "April Fools") return "phigros-april-fools";
  return "other";
}

function assertKnownPhigrosCategory(category: string): void {
  if (phigrosCategory(category) === "other") {
    throw new ExtractorAdapterError(`unknown Phigros extractor category: ${category}`, [{
      code: "UNKNOWN_CATEGORY",
      severity: "error",
      message: "the adapter refuses to emit a normal Candidate for an unknown legacy category",
      evidence: [{ kind: "manual-note", detail: category, confidence: "high" }],
    }]);
  }
}

function evidence(kind: "apk-relative-path" | "metadata" | "filename-parser" | "manual-note", detail: string, confidence: "high" | "medium" | "low" | "unknown") {
  return { kind, detail, confidence } as const;
}

type ArcaeaReport = {
  newInput?: string;
  oldInput?: string;
  outputDir?: string;
  copied?: Array<{ category?: string; sourcePath?: string; outputPath?: string; sizeBytes?: number }>;
  totals?: Record<string, number>;
};

type ArcaeaSong = {
  id?: string;
  title_localized?: Record<string, string | undefined>;
  artist?: string;
  set?: string;
  idx?: number;
  side?: number | string;
  bpm?: string;
  bg?: string;
  version?: string;
  bydversion?: string;
  etrversion?: string;
  difficulties?: Array<{ ratingClass?: number; title_localized?: Record<string, string | undefined>; artist?: string; version?: string; bpm?: string; bg?: string; chartDesigner?: string; jacketDesigner?: string; rating?: number; ratingPlus?: boolean }>;
};

function difficultyInfo(song: ArcaeaSong | undefined, filename: string) {
  const match = filename.match(/^1080_base_([0-4])\./i);
  if (!match || !song) return undefined;
  const ratingClass = Number.parseInt(match[1]!, 10);
  return song.difficulties?.find((item) => item.ratingClass === ratingClass);
}

function difficultyLabel(value: number | undefined): "PST" | "PRS" | "FTR" | "BYD" | "ETR" | undefined {
  return ["PST", "PRS", "FTR", "BYD", "ETR"][value ?? -1] as "PST" | "PRS" | "FTR" | "BYD" | "ETR" | undefined;
}

function arcaeaSongContext(sourceRelativePath: string, outputFilename: string, songs: Map<string, ArcaeaSong>) {
  const match = sourceRelativePath.match(/^songs\/([^/]+)\//i);
  const songId = match?.[1]?.replace(/^dl_/i, "");
  const song = songId ? songs.get(songId) : undefined;
  const sourceName = basename(sourceRelativePath);
  const difficulty = difficultyInfo(song, sourceName);
  const title = cleanTitle(localized(difficulty?.title_localized) ?? localized(song?.title_localized));
  const artist = cleanTitle(difficulty?.artist ?? song?.artist);
  const difficultyCode = difficultyLabel(difficulty?.ratingClass);
  const unresolved = /_256\./i.test(sourceName) ? ["_256_semantics"] : [];
  return { songId, song, difficulty, title, artist, difficultyCode, unresolved, outputFilename };
}

export type ArcaeaLegacyAdapterOptions = {
  reportPath: string;
  baseVersion: string;
  targetVersion: string;
  baseApk: ExtractorApk;
  targetApk: ExtractorApk;
  sourceSnapshot?: string;
};

export async function adaptArcaeaLegacyReport(options: ArcaeaLegacyAdapterOptions): Promise<ExtractorResult> {
  const report = JSON.parse(await readFile(options.reportPath, "utf8")) as ArcaeaReport;
  const reportDir = path.dirname(options.reportPath);
  const outputDir = path.resolve(reportDir, report.outputDir ?? ".");
  const copied = report.copied ?? [];
  const metadataDir = path.join(outputDir, "_metadata");
  const songList = await readOptionalJson<{ songs?: ArcaeaSong[] }>(path.join(metadataDir, "songlist.json"));
  const packList = await readOptionalJson<{ packs?: Array<{ id?: string; name_localized?: Record<string, string | undefined> }> }>(path.join(metadataDir, "packlist.json"));
  const characters = await readOptionalJson<Array<{ character_id?: number; name?: string; search_strings?: string[] }>>(path.join(metadataDir, "characters.json"));
  const songs = new Map((songList?.songs ?? []).filter((item): item is ArcaeaSong & { id: string } => Boolean(item.id)).map((item) => [item.id, item]));
  const packs = new Map((packList?.packs ?? []).filter((item): item is { id: string; name_localized?: Record<string, string | undefined> } => Boolean(item.id)).map((item) => [item.id, item]));
  const characterMap = new Map((characters ?? []).filter((item): item is { character_id: number; name?: string; search_strings?: string[] } => typeof item.character_id === "number").map((item) => [item.character_id, item]));
  const candidates: ExtractorCandidate[] = [];
  for (const item of copied) {
    if (!item.outputPath || !item.sourcePath || !item.category) throw new ExtractorAdapterError("Arcaea legacy report contains an incomplete copied entry", [{ code: "MALFORMED_EXTRACTOR_REPORT", severity: "error", message: "copied entry lacks category, sourcePath, or outputPath", evidence: [] }]);
    assertKnownArcaeaCategory(item.category);
    const sourcePath = path.resolve(outputDir, item.outputPath);
    const sourceStats = await requireSourceFile(sourcePath);
    const resourceType = arcaeaCategory(item.category);
    const outputFilename = basename(item.outputPath);
    const context = arcaeaSongContext(portable(item.sourcePath), outputFilename, songs);
    const characterMatch = basename(item.sourcePath).match(/(?:^|_)(-?\d+)(?:_icon|_mp)?\.[^.]+$/i);
    const characterId = characterMatch ? Number.parseInt(characterMatch[1]!, 10) : undefined;
    const character = characterId === undefined ? undefined : characterMap.get(characterId);
    const packMatch = portable(item.sourcePath).match(/^songs\/pack\/([^/]+)/i);
    const exactIdentity = resourceType === "jacket" ? Boolean(context.songId && context.song) : Boolean(context.songId || characterId !== undefined || packMatch);
    const identityList: Array<z.infer<typeof ExternalIdentity>> = [];
    if (context.songId && context.song) identityList.push({ namespace: "arcaea", key: "songId", value: context.songId, source: "apk-metadata", confidence: "high" });
    if (packMatch) identityList.push({ namespace: "arcaea", key: "packId", value: packMatch[1]!, source: "apk-metadata", confidence: packs.has(packMatch[1]!) ? "high" : "medium" });
    if (characterId !== undefined) identityList.push({ namespace: "arcaea", key: "characterId", value: String(characterId), source: "apk-metadata", confidence: character ? "high" : "medium" });
    const variantKey = context.difficultyCode ?? "default";
    const mappingEvidence = [
      evidence("apk-relative-path", `legacy Arcaea source path: ${portable(item.sourcePath)}`, "high"),
      ...(context.song ? [evidence("metadata", `songlist metadata matched ${context.songId}`, "high")] : [evidence("filename-parser", "song identity was not matched in songlist metadata", "low")]),
      ...(context.difficultyCode ? [evidence("metadata", `difficulty marker ${context.difficultyCode} derived from APK filename`, "high")] : []),
      ...(context.unresolved.length > 0 ? [evidence("manual-note", "_256 semantics remain unresolved", "high")] : []),
    ];
    const reviewRequirements = policy({
      game: "arcaea",
      resourceType,
      confidence: context.song ? "high" : exactIdentity ? "medium" : "low",
      suggestedTitle: context.title ?? (character?.name ? cleanTitle(character.name) : localized(packs.get(packMatch?.[1] ?? "")?.name_localized)),
      suggestedArtist: context.artist,
      suggestedFilename: outputFilename,
      identityExact: exactIdentity,
      identityAmbiguous: resourceType === "jacket" && !exactIdentity,
      metadataComplete: Boolean(context.title || character || packMatch),
      variantUnresolved: context.unresolved.length > 0,
    });
    const suggestedTitle = context.title ?? (character?.search_strings?.find((value) => /[\u3400-\u9fff]/u.test(value)) ?? character?.name) ?? localized(packs.get(packMatch?.[1] ?? "")?.name_localized);
    const suggestedArtist = context.artist;
    const suggestedVariant = { key: variantKey, kind: context.difficultyCode ? "difficulty" as const : context.unresolved.length > 0 ? "unknown" as const : "default" as const, ...(context.difficultyCode ? { difficulty: context.difficultyCode } : {}), unresolved: context.unresolved };
    const metadata = safeMetadata({
      artist: suggestedArtist,
      songId: context.songId,
      packId: packMatch?.[1],
      difficulty: context.difficultyCode,
      sourceRelativePath: portable(item.sourcePath),
      legacyCategory: item.category,
    });
    const provenance: CandidateProvenance = {
      baseVersion: options.baseVersion,
      targetVersion: options.targetVersion,
      sourceApkVersion: options.targetVersion,
      sourceApkFilename: options.targetApk.filename,
      apkInternalRelativePath: portable(item.sourcePath),
      sourceHash: sourceStats.sha256,
      metadataSource: context.song ? "_metadata/songlist.json" : packMatch ? "_metadata/packlist.json" : character ? "_metadata/characters.json" : "legacy filename/path evidence",
      originalFilename: basename(item.sourcePath),
      mappingEvidence,
    };
    candidates.push(ExtractorCandidate.parse({
      id: createUuidV7(),
      sourcePath,
      sourceRelativePath: portable(item.sourcePath),
      sourceFilename: outputFilename,
      sourceApkVersion: options.targetVersion,
      sourceApkFilename: options.targetApk.filename,
      sourceSha256: sourceStats.sha256,
      detection: "added",
      suggestedFilename: outputFilename,
      ...(suggestedTitle ? { suggestedTitle } : {}),
      ...(suggestedArtist ? { suggestedArtist } : {}),
      suggestedCategory: resourceType,
      suggestedVariant,
      suggestedExternalIdentity: identityList,
      metadata,
      confidence: context.song ? "high" : exactIdentity ? "medium" : "low",
      evidence: mappingEvidence,
      reviewRequirements,
      requiresUpscale: false,
      ...(reviewRequirements.identityReviewRequired ? { initialStatus: "BLOCKED", blockedReason: "Arcaea song identity could not be resolved from APK metadata" } : {}),
      provenance,
    }));
  }
  const diagnostics: ExtractorDiagnostic[] = copied.length === 0 ? [{ code: "NO_CANDIDATES_EXTRACTED", severity: "blocked", message: "legacy Arcaea extractor produced no copied candidates", evidence: [] }] : [];
  return ExtractorResult.parse({
    status: diagnostics.length > 0 ? "blocked" : "ok",
    game: "arcaea",
    sourceType: "arcaea_apk",
    baseVersion: options.baseVersion,
    targetVersion: options.targetVersion,
    baseApk: options.baseApk,
    targetApk: options.targetApk,
    sourceSnapshot: options.sourceSnapshot ?? `${options.baseVersion}->${options.targetVersion}`,
    extractorVersion: "legacy-extract-arcaea-update@v2-adapter",
    candidates,
    diagnostics,
    limitations: ["Legacy Arcaea output does not prove exact source APK version for every historical archive file."],
  });
}

async function readOptionalJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ExtractorAdapterError(`metadata parse failed: ${filePath}`, [{
      code: "METADATA_PARSE_FAILURE",
      severity: "error",
      message: "metadata existed but could not be parsed",
      detail: error instanceof Error ? error.message : String(error),
      evidence: [{ kind: "metadata", detail: filePath, confidence: "high" }],
    }]);
  }
}

type PhigrosReport = {
  outputDir?: string;
  exported?: Array<{ category?: string; outputPath?: string; bundle?: string; objectName?: string; width?: number; height?: number; nameSource?: string; sourceKey?: string | null }>;
};

function phigrosTrackContext(sourceKey: string | undefined) {
  const match = sourceKey?.match(/^Assets\/Tracks\/(.+)\/Illustration\.jpg$/i);
  if (!match) return { title: undefined, artist: undefined };
  const split = match[1]!.split(".");
  if (split.length >= 3 && /^\d+$/.test(split.at(-1)!)) {
    return { title: cleanTitle(split.slice(0, -2).join(".")), artist: cleanTitle(split.at(-2)) };
  }
  return { title: cleanTitle(match[1]), artist: undefined };
}

export type PhigrosLegacyAdapterOptions = {
  reportPath: string;
  baseVersion: string;
  targetVersion: string;
  baseApk: ExtractorApk;
  targetApk: ExtractorApk;
  sourceSnapshot?: string;
};

export async function adaptPhigrosLegacyReport(options: PhigrosLegacyAdapterOptions): Promise<ExtractorResult> {
  const report = JSON.parse(await readFile(options.reportPath, "utf8")) as PhigrosReport;
  const reportDir = path.dirname(options.reportPath);
  const outputDir = path.resolve(reportDir, report.outputDir ?? ".");
  const exported = report.exported ?? [];
  const candidates: ExtractorCandidate[] = [];
  for (const item of exported) {
    if (!item.outputPath || !item.category || !item.bundle) throw new ExtractorAdapterError("Phigros legacy report contains an incomplete exported entry", [{ code: "MALFORMED_EXTRACTOR_REPORT", severity: "error", message: "exported entry lacks category, outputPath, or bundle", evidence: [] }]);
    assertKnownPhigrosCategory(item.category);
    const sourcePath = path.resolve(outputDir, item.outputPath);
    const sourceStats = await requireSourceFile(sourcePath);
    const resourceType = phigrosCategory(item.category);
    const sourceKey = item.sourceKey ?? undefined;
    const context = phigrosTrackContext(sourceKey);
    const exactKey = Boolean(sourceKey && context.title && context.artist);
    const identityAmbiguous = resourceType === "jacket" && !sourceKey;
    const suggestedFilename = basename(item.outputPath);
    const mappingEvidence = [
      evidence("apk-relative-path", `Addressables bundle: ${portable(item.bundle)}`, "medium"),
      ...(sourceKey ? [evidence("metadata", `Addressables key: ${sourceKey}`, exactKey ? "high" : "medium")] : [evidence("manual-note", "legacy extractor exported without a catalog key", "low")]),
      ...(item.objectName ? [evidence("filename-parser", `Texture2D object: ${item.objectName}`, "medium")] : []),
    ];
    const reviewRequirements = policy({
      game: "phigros",
      resourceType,
      confidence: exactKey ? "high" : sourceKey ? "medium" : "low",
      suggestedTitle: context.title,
      suggestedArtist: context.artist,
      suggestedFilename,
      identityExact: exactKey,
      identityAmbiguous,
      metadataComplete: Boolean(context.title && context.artist),
    });
    const metadata = safeMetadata({ artist: context.artist, addressablesKey: sourceKey, bundle: portable(item.bundle), objectName: item.objectName, legacyCategory: item.category });
    const identity = sourceKey ? [{ namespace: "phigros", key: "addressablesKey", value: sourceKey, source: "phigros-key" as const, confidence: exactKey ? "high" as const : "medium" as const }] : [];
    const provenance: CandidateProvenance = {
      baseVersion: options.baseVersion,
      targetVersion: options.targetVersion,
      sourceApkVersion: options.targetVersion,
      sourceApkFilename: options.targetApk.filename,
      apkInternalRelativePath: portable(item.bundle),
      sourceHash: sourceStats.sha256,
      addressablesKey: sourceKey,
      bundleName: portable(item.bundle),
      objectName: item.objectName,
      dimensions: item.width && item.height ? { width: item.width, height: item.height } : undefined,
      originalFilename: suggestedFilename,
      mappingEvidence,
    };
    candidates.push(ExtractorCandidate.parse({
      id: createUuidV7(),
      sourcePath,
      sourceRelativePath: sourceKey ? portable(sourceKey) : portable(item.bundle),
      sourceFilename: suggestedFilename,
      sourceApkVersion: options.targetVersion,
      sourceApkFilename: options.targetApk.filename,
      sourceSha256: sourceStats.sha256,
      detection: "added",
      suggestedFilename,
      ...(context.title ? { suggestedTitle: context.title } : {}),
      ...(context.artist ? { suggestedArtist: context.artist } : {}),
      suggestedCategory: resourceType,
      suggestedVariant: { key: "default", kind: "default", unresolved: [] },
      suggestedExternalIdentity: identity,
      metadata,
      confidence: exactKey ? "high" : sourceKey ? "medium" : "low",
      evidence: mappingEvidence,
      reviewRequirements,
      requiresUpscale: false,
      ...(reviewRequirements.identityReviewRequired ? { initialStatus: "BLOCKED", blockedReason: "Phigros resource-to-track identity is not reliable from the legacy extractor evidence" } : {}),
      provenance,
    }));
  }
  const diagnostics: ExtractorDiagnostic[] = exported.length === 0 ? [{ code: "NO_CANDIDATES_EXTRACTED", severity: "blocked", message: "legacy Phigros extractor produced no exported images; no update is asserted", evidence: [] }] : [];
  return ExtractorResult.parse({
    status: diagnostics.length > 0 ? "blocked" : "ok",
    game: "phigros",
    sourceType: "phigros_apk",
    baseVersion: options.baseVersion,
    targetVersion: options.targetVersion,
    baseApk: options.baseApk,
    targetApk: options.targetApk,
    sourceSnapshot: options.sourceSnapshot ?? `${options.baseVersion}->${options.targetVersion}`,
    extractorVersion: "legacy-extract-phigros-update@v2-adapter",
    candidates,
    diagnostics,
    limitations: ["Legacy Phigros extractor compares only new catalog keys and new bundle files; changed contents inside an existing bundle remain unresolved."],
  });
}

export function extractorResultToAdapterInput(result: ExtractorResult): CandidateManifestAdapterInput {
  const parsed = ExtractorResult.parse(result);
  if (parsed.status === "failed") {
    throw new ExtractorAdapterError("extractor failed; no normal-looking Candidates may be emitted", parsed.diagnostics);
  }
  if (parsed.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    throw new ExtractorAdapterError("extractor diagnostics contain an error; batch adaptation is blocked", parsed.diagnostics);
  }
  const notes = [
    ...parsed.limitations,
    ...parsed.diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`),
  ];
  return {
    game: parsed.game,
    sourceType: parsed.sourceType,
    sourceSnapshot: parsed.sourceSnapshot,
    extractorVersion: parsed.extractorVersion,
    notes,
    candidates: parsed.candidates.map((candidate) => ({
      ...(candidate.id ? { id: candidate.id } : {}),
      sourcePath: candidate.sourcePath,
      sourceRelativePath: candidate.sourceRelativePath,
      sourceFilename: candidate.sourceFilename,
      sourceGameVersion: candidate.sourceApkVersion,
      ...(candidate.sourceSha256 ? { sourceSha256: candidate.sourceSha256 } : {}),
      detection: candidate.detection,
      evidence: candidate.evidence,
      suggestedFilename: candidate.suggestedFilename,
      resourceType: candidate.suggestedCategory,
      ...(candidate.suggestedTitle ? { title: candidate.suggestedTitle } : {}),
      ...(candidate.suggestedVariant?.key ? { variantKey: candidate.suggestedVariant.key } : {}),
      ...(candidate.suggestedVariant?.kind ? { variantKind: candidate.suggestedVariant.kind } : {}),
      metadata: safeMetadata({ ...candidate.metadata, ...(candidate.suggestedArtist ? { artist: candidate.suggestedArtist } : {}) }),
      externalIdentities: candidate.suggestedExternalIdentity,
      confidence: candidate.confidence,
      mappingEvidence: candidate.evidence,
      reviewRequirements: candidate.reviewRequirements,
      ...(candidate.initialStatus ? { initialStatus: candidate.initialStatus } : {}),
      ...(candidate.blockedReason ? { blockedReason: candidate.blockedReason } : {}),
      requiresUpscale: candidate.requiresUpscale,
      provenance: candidate.provenance,
    })),
  };
}

export type CreateWorkspaceFromExtractorOptions = Omit<CreateWorkspaceOptions, "game" | "baseVersion" | "targetVersion" | "sourceManifest" | "baseApk" | "targetApk" | "extractorVersion"> & {
  rootPath: string;
};

export async function createWorkspaceFromExtractorResult(result: ExtractorResult, options: CreateWorkspaceFromExtractorOptions): Promise<WorkspaceHandle> {
  const parsed = ExtractorResult.parse(result);
  if (parsed.status === "failed") throw new ExtractorAdapterError("cannot create a workspace from a failed extractor result", parsed.diagnostics);
  const sourceManifest = extractorResultToAdapterInput(parsed);
  return createVersionWorkspace({
    ...options,
    rootPath: options.rootPath,
    game: parsed.game,
    baseVersion: parsed.baseVersion,
    targetVersion: parsed.targetVersion,
    sourceManifest,
    baseApk: parsed.baseApk,
    targetApk: parsed.targetApk,
    extractorVersion: parsed.extractorVersion,
  });
}

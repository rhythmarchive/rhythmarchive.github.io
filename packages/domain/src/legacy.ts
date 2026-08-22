import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import { createUuidV7, normalizeFilenameStem } from "./identity.js";
import { selectPreviewSource, THUMBNAIL_WIDTHS } from "./thumbnails.js";
import { currentSnapshotFile, extractArcaeaCurrentAssets } from "./arcaea-current.js";

export const DEFAULT_LEGACY_ASSET_ROOT = "E:\\曲绘";
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif"]);

export function fullLegacyMigrationAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ALLOW_FULL_LEGACY_MIGRATION === "1";
}

export function assertFullLegacyMigrationAllowed(env: NodeJS.ProcessEnv = process.env): void {
  if (!fullLegacyMigrationAllowed(env)) throw new Error("Full Legacy Migration is disabled; set ALLOW_FULL_LEGACY_MIGRATION=1 to continue.");
}

export type LegacyMigrationIssue = {
  sourceRelativePath?: string;
  proposalKey?: string;
  code: string;
  message: string;
};

export type LegacyFileRecord = {
  candidateId: string;
  sourceRelativePath: string;
  sourceFilename: string;
  source?: "legacy" | "legacy-curated" | "current-apk";
  sourceVersion?: string;
  game: "arcaea" | "phigros" | "unknown";
  resourceType: string;
  category: string;
  renditionType: "original" | "upscaled" | "unresolved";
  extension: string;
  mime: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  sha256?: string;
  normalizedPairKey: string;
  difficulty?: "PST" | "PRS" | "FTR" | "BYD" | "ETR";
  reviewStatus: "auto" | "needs-review" | "unresolved";
  reviewReasons: string[];
  evidence: string[];
  provisionalOptimizationPng: boolean;
};

export type LegacyMigrationProposal = {
  candidateId: string;
  proposalKey: string;
  source?: "legacy" | "legacy-curated" | "current-apk";
  game: "arcaea" | "phigros" | "unknown";
  resourceType: string;
  title?: string;
  artist?: string;
  variantKey?: string;
  variantStatus: "confirmed" | "unresolved";
  original?: string;
  upscaled?: string;
  downloadFilename?: string;
  sourceFiles: string[];
  objectIds: string[];
  reviewStatus: "auto" | "needs-review" | "unresolved";
  reviewReasons: string[];
  notes: string[];
};

export type LegacyDryRunStats = {
  resourceCount: number;
  fileCount: number;
  sourceFileCount: number;
  upscaledCount: number;
  variantCount: number;
  duplicateObjectCount: number;
  duplicateHashGroupCount: number;
  estimatedRosObjectCount: number;
  estimatedUploadBytes: number;
  estimatedThumbnailBytes: number;
  unrecognizedCount: number;
  blockingIssueCount: number;
  warningCount: number;
  thumbnailCount: number;
};

export type LegacyMigrationPlan = {
  schemaVersion: "1.0";
  sourceRoot: string;
  scannedAt: string;
  sourceSnapshot: string;
  readOnly: true;
  stats: LegacyDryRunStats;
  files: LegacyFileRecord[];
  proposals: LegacyMigrationProposal[];
  duplicateHashGroups: Array<{ sha256: string; files: string[]; sizeBytes: number }>;
  blockingIssues: LegacyMigrationIssue[];
  warnings: LegacyMigrationIssue[];
  notes: string[];
  sourceSummary?: {
    arcaeaJacketCount: number;
    arcaeaJacketFileCount?: number;
    arcaeaCurrentNonJacketCount: number;
    currentArcaeaApk?: { version: string; filename: string; absolutePath: string };
  };
};

type ScannedFile = { absolutePath: string; relativePath: string; filename: string; sizeBytes: number; mtimeMs: number };
type ScanInput = ScannedFile & {
  source?: LegacyFileRecord["source"];
  sourceVersion?: string;
  classification?: ReturnType<typeof classify>;
  evidence?: string[];
};

const sourcePathByPlan = new WeakMap<LegacyMigrationPlan, Map<string, string>>();

/** Resolve the local source bytes without exposing local paths in the plan JSON. */
export function resolveLegacyMigrationSourcePath(plan: LegacyMigrationPlan, file: LegacyFileRecord): string {
  return sourcePathByPlan.get(plan)?.get(file.sourceRelativePath) ?? path.resolve(plan.sourceRoot, file.sourceRelativePath);
}

function posix(value: string): string {
  return value.split(path.sep).join("/");
}

function mimeForExtension(extension: string): string {
  switch (extension) {
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".png": return "image/png";
    case ".webp": return "image/webp";
    case ".avif": return "image/avif";
    case ".gif": return "image/gif";
    default: return "application/octet-stream";
  }
}

function classify(relativePath: string, filename: string): { game: LegacyFileRecord["game"]; resourceType: string; category: string; renditionType: LegacyFileRecord["renditionType"]; version?: string; reasons: string[]; difficulty?: LegacyFileRecord["difficulty"] } {
  const parts = relativePath.split("/");
  const lower = relativePath.toLocaleLowerCase("zh-CN");
  const game = lower.includes("arcaea") ? "arcaea" : lower.includes("phigros") ? "phigros" : "unknown";
  const topLevel = parts[0] ?? "";
  const versionMatch = topLevel.match(/(?:至|to)[ _-]?(\d+(?:\.\d+)+)/iu) ?? topLevel.match(/(\d+(?:[._]\d+)+)/u);
  const version = versionMatch?.[1]?.replaceAll("_", ".");
  const reasons: string[] = [];
  let resourceType = "other";
  let category = "unknown";
  if (parts.includes("曲绘（AI超分后）")) { resourceType = "jacket"; category = "upscaled-jacket"; }
  else if (parts.includes("曲绘")) { resourceType = "jacket"; category = "jacket"; }
  else if (parts.includes("曲包封面")) { resourceType = "pack-cover"; category = "pack-cover"; }
  else if (parts.includes("游玩背景")) { resourceType = "background"; category = "background"; }
  else if (parts.includes("立绘")) { resourceType = "character-portrait"; category = "character-portrait"; }
  else if (parts.includes("头像")) { resourceType = "character-avatar"; category = "character-avatar"; }
  else if (parts.includes("LinkPlay预览")) { resourceType = "linkplay-preview"; category = "linkplay-preview"; }
  else if (parts.includes("LinkPlay贴纸")) { resourceType = "sticker"; category = "sticker"; }
  else if (parts.includes("剧情") || parts.includes("剧情贴图")) { resourceType = "story-cg"; category = "story-cg"; }
  else if (parts.includes("启动页面")) { resourceType = "startup"; category = "startup"; }
  else if (parts.includes("世界模式")) { resourceType = "world-mode"; category = "world-mode"; }
  else if (parts.includes("April Fools")) { resourceType = "phigros-april-fools"; category = "april-fools"; }
  else reasons.push("无法识别资源目录");
  const optimization = /(?:_optimization|_opt)(?:\.[^.]+)?$/iu.test(filename);
  const renditionType = game === "arcaea" && resourceType === "jacket" && (category === "upscaled-jacket" || optimization) ? "upscaled" : "original";
  if (game === "unknown") reasons.push("无法识别游戏");
  if (optimization && path.extname(filename).toLowerCase() === ".png") reasons.push("_optimization.png 需要先人工检查并转换为 q95 JPG");
  const stem = filename.replace(/\.[^.]+$/u, "");
  const difficultyMatch = game === "arcaea" && resourceType === "jacket" ? stem.match(/(?:_|\s)([0-4])$/u) : undefined;
  const difficulty = difficultyMatch ? (["PST", "PRS", "FTR", "BYD", "ETR"] as const)[Number(difficultyMatch[1])] : undefined;
  if (difficulty) reasons.push(`Arcaea difficulty marker ${difficulty} needs Variant review`);
  if (resourceType === "jacket" && game === "phigros" && !/\s-\s/iu.test(stem)) reasons.push("Phigros title/artist metadata is incomplete");
  if (parts.some((part) => part.toLowerCase() === "_256" || part.includes("_256")) || /_256(?:\.|$)/iu.test(filename)) reasons.push("_256 semantics remain unresolved");
  return { game, resourceType, category, renditionType, ...(version ? { version } : {}), reasons, ...(difficulty ? { difficulty } : {}) };
}

async function walk(rootPath: string): Promise<ScannedFile[]> {
  const result: ScannedFile[] = [];
  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(absolutePath);
      else if (entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        const fileStats = await stat(absolutePath);
        result.push({ absolutePath, relativePath: posix(path.relative(rootPath, absolutePath)), filename: entry.name, sizeBytes: fileStats.size, mtimeMs: Math.trunc(fileStats.mtimeMs) });
      }
    }
  }
  await visit(rootPath);
  return result.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "zh-CN"));
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk as Uint8Array);
  return hash.digest("hex");
}

function estimateThumbnailBytes(sizeBytes: number, width: number, height: number, target: number): number {
  const areaRatio = Math.min(1, (target * target) / Math.max(1, width * height));
  return Math.max(512, Math.min(sizeBytes, Math.round(sizeBytes * Math.max(areaRatio * 0.8, 0.01))));
}

function titleArtist(filename: string): { title?: string; artist?: string } {
  const stem = filename.replace(/\.[^.]+$/u, "");
  const parts = stem.split(/\s+-\s+/u).map((value) => value.trim()).filter(Boolean);
  if (parts.length >= 2) return { ...(parts[0] ? { title: parts[0] } : {}), artist: parts.slice(1).join(" - ") };
  return stem ? { title: stem } : {};
}

function isBlockingReason(reason: string): boolean {
  return reason.includes("无法识别资源目录")
    || reason.includes("无法识别游戏")
    || reason.includes("无法计算 SHA-256")
    || reason.includes("图片无法读取")
    || reason.includes("optimization")
    || reason.includes("无法从文件名获得资源标题");
}

function issueCodeForReason(reason: string): string {
  if (reason.includes("无法识别资源目录")) return "UNKNOWN_RESOURCE_TYPE";
  if (reason.includes("无法识别游戏")) return "UNKNOWN_GAME";
  if (reason.includes("无法计算 SHA-256") || reason.includes("图片无法读取")) return "IMAGE_READ_FAILED";
  if (reason.includes("optimization")) return "OPTIMIZATION_PNG_REQUIRES_CONVERSION";
  if (reason.includes("无法从文件名获得资源标题")) return "MISSING_RESOURCE_IDENTITY";
  if (reason.includes("Phigros")) return "PHIGROS_METADATA_WARNING";
  if (reason.includes("difficulty")) return "SPECIAL_DIFFICULTY_WARNING";
  if (reason.includes("_256")) return "UNRESOLVED_256_WARNING";
  if (reason.includes("normalized basename")) return "NORMALIZED_NAME_WARNING";
  return "MIGRATION_WARNING";
}

function issueForReason(reason: string, sourceRelativePath: string, proposalKey: string): LegacyMigrationIssue {
  return { sourceRelativePath, proposalKey, code: issueCodeForReason(reason), message: reason };
}

export type LegacyScanAdditionalFile = {
  absolutePath: string;
  sourceRelativePath: string;
  sourceFilename: string;
  sourceVersion?: string;
  source: NonNullable<LegacyFileRecord["source"]>;
  game: LegacyFileRecord["game"];
  resourceType: string;
  category: string;
  renditionType: LegacyFileRecord["renditionType"];
  evidence?: string[];
};

export type LegacyScanOptions = {
  sourceRoot?: string;
  now?: Date | string;
  fileFilter?: (item: ScannedFile) => boolean;
  sourceResolver?: (item: ScannedFile, classification: ReturnType<typeof classify>) => LegacyFileRecord["source"];
  additionalFiles?: LegacyScanAdditionalFile[];
  notes?: string[];
  sourceSummary?: LegacyMigrationPlan["sourceSummary"];
};

export async function scanLegacyAssets(options: LegacyScanOptions = {}): Promise<LegacyMigrationPlan> {
  const sourceRoot = path.resolve(options.sourceRoot ?? DEFAULT_LEGACY_ASSET_ROOT);
  const scannedAt = options.now instanceof Date ? options.now.toISOString() : options.now ?? new Date().toISOString();
  let scanned: ScanInput[];
  try { scanned = await walk(sourceRoot); }
  catch { throw new Error("Legacy Asset Root could not be read."); }
  scanned = scanned.filter((item) => options.fileFilter?.(item) ?? true);
  scanned.push(...(options.additionalFiles ?? []).map((item) => ({
    absolutePath: item.absolutePath,
    relativePath: item.sourceRelativePath,
    filename: item.sourceFilename,
    sizeBytes: 0,
    mtimeMs: 0,
    source: item.source,
    ...(item.sourceVersion ? { sourceVersion: item.sourceVersion } : {}),
    classification: {
      game: item.game,
      resourceType: item.resourceType,
      category: item.category,
      renditionType: item.renditionType,
      reasons: [],
    },
    ...(item.evidence ? { evidence: item.evidence } : {}),
  })));
  const files: LegacyFileRecord[] = [];
  for (const item of scanned) {
    const classification = item.classification ?? classify(item.relativePath, item.filename);
    const source = item.source ?? options.sourceResolver?.(item, classification);
    const extension = path.extname(item.filename).toLowerCase();
    if (item.sizeBytes === 0) {
      try {
        item.sizeBytes = (await stat(item.absolutePath)).size;
      } catch {
        // The image/hash read below records the normal integrity issue.
      }
    }
    let metadata: sharp.Metadata | undefined;
    let sha256: string | undefined;
    let imageReadFailed = false;
    try {
      [metadata, sha256] = await Promise.all([sharp(item.absolutePath, { animated: true }).metadata(), sha256File(item.absolutePath)]);
    } catch {
      imageReadFailed = true;
    }
    const reasons = [...classification.reasons, ...(imageReadFailed ? ["图片无法读取或计算 SHA-256"] : !sha256 ? ["无法计算 SHA-256"] : [])];
    const reviewStatus: LegacyFileRecord["reviewStatus"] = reasons.some((reason) => reason.includes("_256") || isBlockingReason(reason)) ? "unresolved" : reasons.length > 0 ? "needs-review" : "auto";
    files.push({
      candidateId: createUuidV7(),
      sourceRelativePath: item.relativePath,
      sourceFilename: item.filename,
      ...(source ? { source } : {}),
      ...(item.sourceVersion ?? classification.version ? { sourceVersion: item.sourceVersion ?? classification.version } : {}),
      game: classification.game,
      resourceType: classification.resourceType,
      category: classification.category,
      renditionType: classification.renditionType,
      extension: extension.slice(1),
      mime: mimeForExtension(extension),
      sizeBytes: item.sizeBytes,
      ...(metadata?.width ? { width: metadata.width } : {}),
      ...(metadata?.height ? { height: metadata.height } : {}),
      ...(sha256 ? { sha256 } : {}),
      normalizedPairKey: item.source === "current-apk" ? normalizeFilenameStem(item.relativePath) : normalizeFilenameStem(item.filename),
      ...(classification.difficulty ? { difficulty: classification.difficulty } : {}),
      reviewStatus,
      reviewReasons: reasons,
      evidence: [...(item.evidence ?? [`legacy source path: ${item.relativePath}`]), `category: ${classification.category}`, ...(sha256 ? ["sha256: local read"] : [])],
      provisionalOptimizationPng: /(?:_optimization|_opt)(?:\.[^.]+)?$/iu.test(item.filename) && extension === ".png",
    });
  }

  const byPair = new Map<string, LegacyFileRecord[]>();
  for (const record of files) {
    const key = `${record.game}:${record.resourceType}:${record.normalizedPairKey}`;
    byPair.set(key, [...(byPair.get(key) ?? []), record]);
  }
  const proposals: LegacyMigrationProposal[] = [];
  const blockingIssues: LegacyMigrationIssue[] = [];
  const warnings: LegacyMigrationIssue[] = [];
  for (const [key, group] of byPair) {
    const originals = group.filter((item) => item.renditionType === "original");
    const upscaled = group.filter((item) => item.renditionType === "upscaled");
    const canPair = originals.length === 1 && upscaled.length === 1 && originals[0]!.resourceType === "jacket";
    const groupIsBlocking = originals.length > 1
      || upscaled.length > 1
      || (upscaled.length > 0 && originals.length === 0)
      || (originals.length > 0 && upscaled.length > 0 && !canPair);
    const groupBlockingReason = originals.length > 1 || upscaled.length > 1
      ? "normalized pair has multiple original/upscaled files"
      : "original / upscaled files cannot be safely paired";
    if (groupIsBlocking) {
      for (const record of group) {
        record.reviewStatus = "unresolved";
        record.reviewReasons = [...new Set([...record.reviewReasons, groupBlockingReason])];
      }
    }
    for (const record of canPair ? [originals[0]!] : group) {
      const relatedUpscaled = canPair ? upscaled[0] : undefined;
      const identity = titleArtist(record.sourceFilename);
      const reasons = [...new Set([
        ...record.reviewReasons,
        ...(group.length > 2 && !groupIsBlocking ? ["同一 normalized basename 存在多个文件，未自动合并"] : []),
        ...(!identity.title ? ["无法从文件名获得资源标题"] : []),
      ])];
      const proposalKey = canPair ? key : `${key}:${record.sourceRelativePath}`;
      const blockingReasons = reasons.filter(isBlockingReason);
      const warningReasons = reasons.filter((reason) => !isBlockingReason(reason) && reason !== groupBlockingReason);
      const status: LegacyMigrationProposal["reviewStatus"] = groupIsBlocking || reasons.some((reason) => reason.includes("_256") || isBlockingReason(reason))
        ? "unresolved"
        : reasons.length > 0 || !identity.title || (record.game === "phigros" && !identity.artist) ? "needs-review" : "auto";
      proposals.push({
        candidateId: record.candidateId,
        proposalKey,
        ...(record.source ? { source: record.source } : {}),
        game: record.game,
        resourceType: record.resourceType,
        ...(identity.title ? { title: identity.title } : {}),
        ...(identity.artist ? { artist: identity.artist } : {}),
        ...(record.difficulty ? { variantKey: record.difficulty } : {}),
        variantStatus: reasons.some((reason) => reason.includes("_256")) ? "unresolved" : "confirmed",
        ...(record.renditionType === "original" ? { original: record.sourceRelativePath } : {}),
        ...(relatedUpscaled ? { upscaled: relatedUpscaled.sourceRelativePath } : {}),
        downloadFilename: record.sourceFilename,
        sourceFiles: [record.sourceRelativePath, ...(relatedUpscaled ? [relatedUpscaled.sourceRelativePath] : [])],
        objectIds: [record.sha256, relatedUpscaled?.sha256].filter((value): value is string => Boolean(value)).map((value) => `sha256:${value}`),
        reviewStatus: status,
        reviewReasons: reasons,
        notes: canPair ? ["Arcaea original / AI normalized basename pair"] : [],
      });
      if (blockingReasons.length > 0) {
        blockingIssues.push({ ...issueForReason(blockingReasons[0]!, record.sourceRelativePath, proposalKey), message: blockingReasons.join("；") });
      }
      if (warningReasons.length > 0) {
        warnings.push({ ...issueForReason(warningReasons[0]!, record.sourceRelativePath, proposalKey), message: warningReasons.join("；") });
      }
    }
    if (groupIsBlocking) {
      const sourceRelativePath = group[0]?.sourceRelativePath;
      blockingIssues.push({
        proposalKey: key,
        ...(sourceRelativePath ? { sourceRelativePath } : {}),
        code: originals.length > 1 || upscaled.length > 1 ? "PAIR_AMBIGUOUS" : "UNSAFE_UPSCALE_PAIR",
        message: `${key}: ${groupBlockingReason}`,
      });
    }
  }

  const hashGroups = new Map<string, LegacyFileRecord[]>();
  for (const record of files) if (record.sha256) hashGroups.set(record.sha256, [...(hashGroups.get(record.sha256) ?? []), record]);
  const duplicateHashGroups = [...hashGroups.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([sha256, group]) => ({ sha256, files: group.map((item) => item.sourceRelativePath).sort((a, b) => a.localeCompare(b, "zh-CN")), sizeBytes: group[0]!.sizeBytes }));
  const proposalBySourcePath = new Map<string, string>();
  for (const proposal of proposals) for (const sourceFile of proposal.sourceFiles) proposalBySourcePath.set(sourceFile, proposal.proposalKey);
  for (const duplicateGroup of duplicateHashGroups) {
    const proposalKeys = new Set(duplicateGroup.files.map((file) => proposalBySourcePath.get(file)).filter((value): value is string => Boolean(value)));
    if (proposalKeys.size > 1) {
      const sourceRelativePath = duplicateGroup.files[0];
      if (!sourceRelativePath) continue;
      warnings.push({
        sourceRelativePath,
        code: "DUPLICATE_HASH_DIFFERENT_SEMANTICS",
        message: `SHA-256 ${duplicateGroup.sha256} is shared by multiple semantic Resources; keep them separate and share the Object.`,
      });
    }
  }
  const distinctHashes = hashGroups.size;
  const fileBySourcePath = new Map(files.map((file) => [file.sourceRelativePath, file]));
  const previewSources = proposals.map((proposal) => {
    const candidates = proposal.sourceFiles
      .map((sourceRelativePath) => fileBySourcePath.get(sourceRelativePath))
      .filter((file): file is LegacyFileRecord => Boolean(file));
    return selectPreviewSource(candidates);
  }).filter((file): file is LegacyFileRecord & { width: number; height: number } => Boolean(file?.width && file?.height));
  const thumbnailCount = previewSources.length * THUMBNAIL_WIDTHS.length;
  const estimatedThumbnailBytes = previewSources.reduce((sum, file) => sum + THUMBNAIL_WIDTHS.reduce((inner, width) => inner + estimateThumbnailBytes(file.sizeBytes, file.width, file.height, width), 0), 0);
  const sourceFileCount = files.filter((file) => file.renditionType !== "upscaled").length;
  const upscaledCount = files.filter((file) => file.renditionType === "upscaled").length;
  const stats: LegacyDryRunStats = {
    resourceCount: proposals.length,
    fileCount: files.length,
    sourceFileCount,
    upscaledCount,
    variantCount: proposals.filter((proposal) => Boolean(proposal.variantKey)).length,
    duplicateObjectCount: files.length - distinctHashes,
    duplicateHashGroupCount: duplicateHashGroups.length,
    estimatedRosObjectCount: distinctHashes + thumbnailCount,
    estimatedUploadBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0) + estimatedThumbnailBytes,
    estimatedThumbnailBytes,
    unrecognizedCount: files.filter((file) => file.game === "unknown" || file.resourceType === "other").length,
    blockingIssueCount: blockingIssues.length,
    warningCount: warnings.length,
    thumbnailCount,
  };
  const sourceSnapshot = crypto.createHash("sha256").update(`${sourceRoot}\n${scannedAt}\n${files.map((file) => `${file.sourceRelativePath}:${file.sizeBytes}:${file.sha256 ?? ""}`).join("\n")}`).digest("hex");
  const plan: LegacyMigrationPlan = {
    schemaVersion: "1.0",
    sourceRoot,
    scannedAt,
    sourceSnapshot: `legacy:${sourceSnapshot}`,
    readOnly: true,
    stats,
    files,
    proposals,
    duplicateHashGroups,
    blockingIssues,
    warnings,
    notes: [
      "Legacy Asset Root is read-only; this scan does not rename, delete, convert, or upload source files.",
      "Arcaea original / AI pairing uses normalized basenames only; songId is not treated as Resource identity.",
      "Same SHA-256 files remain separate semantic proposals until human review.",
      "Preview thumbnails are estimated once per Resource/Variant; paired original/upscaled files use upscaled as the preview source.",
      "Thumbnail byte and object counts are estimates; no thumbnail files were generated during dry-run.",
      ...(options.notes ?? []),
    ],
    ...(options.sourceSummary ? { sourceSummary: options.sourceSummary } : {}),
  };
  sourcePathByPlan.set(plan, new Map(scanned.map((item) => [item.relativePath, item.absolutePath])));
  return plan;
}

export type FirstMigrationScanOptions = {
  sourceRoot?: string;
  arcaeaApkDirectory?: string;
  legacyExtractorRoot?: string;
  runtimeRoot?: string;
  now?: Date | string;
};

function isCuratedArcaeaLegacyPath(relativePath: string): boolean {
  return /^Arcaea(?:（至\d+(?:\.\d+)*）)?\/(?:曲绘|曲绘（AI超分后）)\//u.test(relativePath);
}

function isFirstMigrationLegacyPath(item: ScannedFile): boolean {
  return isCuratedArcaeaLegacyPath(item.relativePath) || /^Phigros\//u.test(item.relativePath);
}

/**
 * First migration source boundary:
 * - curated Arcaea jackets from E:\\曲绘\\Arcaea\\曲绘 (+ its curated AI pair folder)
 * - Phigros from the existing Legacy rules
 * - all other Arcaea images from the current local APK snapshot
 */
export async function scanFirstMigrationPlan(options: FirstMigrationScanOptions = {}): Promise<LegacyMigrationPlan> {
  const sourceRoot = path.resolve(options.sourceRoot ?? DEFAULT_LEGACY_ASSET_ROOT);
  const extractorRoot = path.resolve(options.legacyExtractorRoot ?? path.resolve("..", "rhythm-assets-gallery"));
  let currentSnapshot: Awaited<ReturnType<typeof extractArcaeaCurrentAssets>>;
  const notes: string[] = [
    "Arcaea jacket source: legacy-curated (E:\\曲绘\\Arcaea\\曲绘 plus versioned Arcaea（至...） overlay folders and their curated AI pair folders).",
    "Arcaea non-jacket source: current-apk; historical Arcaea non-jacket files are excluded from this plan.",
    "Phigros source: legacy.",
    "Arcaea difficulty suffixes are inferred only for jacket resources; _256 remains unresolved.",
  ];
  if (options.arcaeaApkDirectory) {
    currentSnapshot = await extractArcaeaCurrentAssets({
      apkDirectoryOrPath: options.arcaeaApkDirectory,
      extractorRoot,
      ...(options.runtimeRoot ? { runtimeRoot: options.runtimeRoot } : {}),
    });
    if (!currentSnapshot) notes.push("未找到 Arcaea APK。");
  } else {
    notes.push("未找到 Arcaea APK。");
  }

  const plan = await scanLegacyAssets({
    sourceRoot,
    ...(options.now ? { now: options.now } : {}),
    fileFilter: isFirstMigrationLegacyPath,
    sourceResolver: (_item, classification) => classification.game === "arcaea" && classification.resourceType === "jacket" ? "legacy-curated" : "legacy",
    additionalFiles: currentSnapshot
      ? currentSnapshot.result.candidates.map((candidate) => currentSnapshotFile(candidate, currentSnapshot!.apk))
      : [],
    notes,
  });
  const arcaeaJacketFileCount = plan.files.filter((file) => file.source === "legacy-curated" && file.game === "arcaea" && file.resourceType === "jacket").length;
  const arcaeaJacketCount = plan.proposals.filter((proposal) => proposal.source === "legacy-curated" && proposal.game === "arcaea" && proposal.resourceType === "jacket").length;
  plan.sourceSummary = {
    arcaeaJacketCount,
    arcaeaJacketFileCount,
    arcaeaCurrentNonJacketCount: currentSnapshot?.nonJacketCount ?? 0,
    ...(currentSnapshot ? { currentArcaeaApk: { version: currentSnapshot.apk.version, filename: currentSnapshot.apk.filename, absolutePath: currentSnapshot.apk.absolutePath } } : {}),
  };
  return plan;
}

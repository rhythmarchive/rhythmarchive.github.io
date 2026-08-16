import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  Catalog,
  type Candidate as CandidateType,
  type Catalog as CatalogType,
  type WorkspaceHandle,
  candidateCanBeConfirmed,
  computeUpdateBatchProgress,
  confirmCandidateInWorkspace,
  convertSelectedUpscale,
  createPublishPlanDryRun,
  createReleaseManifestDraft,
  executePublishPlan,
  rosStorageStatus,
  S3StorageClient,
  scanFirstMigrationPlan,
  type LegacyMigrationPlan,
  type PublishProgress,
  effectiveCandidateArtist,
  effectiveCandidateMetadata,
  effectiveCandidateFilename,
  effectiveCandidateResourceType,
  effectiveCandidateTitle,
  effectiveCandidateVariantKey,
  finalizeWorkspaceCandidate,
  applyCatalogDiffToWorkspace,
  loadWorkspaceState,
  loadWorkspacePublishRecord,
  markWorkspacePublished,
  replaceCandidateImageInWorkspace,
  removeCandidateFromUpdate,
  restoreCandidateOriginal,
  runUpscaleBatch,
  retryUpscaleCandidate,
  skipUpscaleForCandidate,
  resolveRealEsrganConfig,
  prepareUpscaleInputs,
  reconcileUpscaleOutputs,
  reconcileWorkspace,
  resolveCandidateIdentityInWorkspace,
  selectUpscaleAttempt,
  overrideCandidateFilenameInWorkspace,
  overrideCandidateMetadataInWorkspace,
  type CandidateMetadataOverride,
  type CandidateConversionResult,
  type UpscaleReconciliationResult,
} from "../../domain/src/index.js";
import { createUuidV7 } from "../../domain/src/identity.js";
import { loadCatalogFile } from "../../domain/src/catalog.js";
import { GAME_REGISTRY, gameConfig, type GameId } from "./registry.js";
import type { AdminConfig } from "./config.js";

export type WorkspaceSummary = {
  id: string;
  game: GameId;
  gameName: string;
  baseVersion: string;
  targetVersion: string;
  candidateCount: number;
  pendingCount: number;
  needsInfoCount: number;
  needsUpscaleCount: number;
  blockedCount: number;
  readyCount: number;
  status: string;
  updatedAt: string;
};

export type CandidateView = {
  id: string;
  title?: string;
  suggestedTitle?: string;
  artist?: string;
  filename: string;
  resourceType: string;
  variant?: string;
  difficulty?: string;
  status: CandidateType["status"];
  reviewState: CandidateType["review"]["state"];
  disposition: CandidateType["review"]["disposition"];
  modified: boolean;
  replacedImage: boolean;
  target?: { resourceId: string; variantId: string; renditionId: string; downloadFilename?: string };
  confirmed: boolean;
  confidence: CandidateType["suggestedMapping"]["confidence"];
  needsInfo: boolean;
  needsUpscale: boolean;
  issues: string[];
  previewUrl: string;
  originalPreviewUrl: string;
  upscaledPreviewUrl?: string;
  file: {
    sizeBytes: number;
    width?: number;
    height?: number;
    mime: CandidateType["files"][number]["mime"];
  };
  upscale: {
    state: CandidateType["processing"]["state"];
    matches: Array<{ fileId: string; filename: string; state: "matched" | "ambiguous" | "unmatched"; selected: boolean }>;
    converted: boolean;
    inputBytes?: number;
    outputBytes?: number;
    sizeReductionRatio?: number;
  };
  metadata: { artist?: string; pack?: string; difficulty?: string; addressablesKey?: string };
  details: {
    sourceRelativePath?: string;
    sourceFilename: string;
    sourceGameVersion?: string;
    sourceSha256?: string;
    sourceType: string;
    externalIdentities: CandidateType["suggestedMapping"]["externalIdentities"];
    evidence: CandidateType["suggestedMapping"]["evidence"];
    provenance?: CandidateType["provenance"];
    reviewRequirements: CandidateType["reviewRequirements"];
    files: Array<{ id: string; role: string; filename: string; relativePath: string; sizeBytes: number; availability: string }>;
  };
};

export type WorkspaceView = WorkspaceSummary & {
  progress: ReturnType<typeof computeUpdateBatchProgress>;
  diffSummary: { added: number; contentChanged: number; metadataOnly: number; unchanged: number; unmatched: number; removed: number };
  candidates: CandidateView[];
  notes: string[];
  recentOperations: Array<{ type: string; detail: string; at: string }>;
};

export type PublishPreview = {
  manifest: Awaited<ReturnType<typeof createReleaseManifestDraft>>;
  plan: Awaited<ReturnType<typeof createPublishPlanDryRun>>;
  summary: {
    addedResources: number;
    updatedResources: number;
    metadataOnly: number;
    removedFromCurrentSource: number;
    upscaledRenditions: number;
    originalRenditions: number;
    replacedImages: number;
    uploadObjects: number;
    uploadBytes: number;
  };
  ros: ReturnType<typeof rosStorageStatus>;
};

export type PublishExecutionView = {
  status: "published";
  uploadedObjectKeys: string[];
  skippedObjectKeys: string[];
  releaseManifestId: string;
  progress: PublishProgress[];
  ros: ReturnType<typeof rosStorageStatus>;
};

export class AdminOperationError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly detail?: string;

  constructor(code: string, message: string, statusCode = 400, detail?: string) {
    super(message);
    this.name = "AdminOperationError";
    this.code = code;
    this.statusCode = statusCode;
    if (detail) this.detail = detail;
  }
}

function within(rootPath: string, targetPath: string): boolean {
  const root = path.resolve(rootPath);
  const target = path.resolve(targetPath);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return target === root || target.startsWith(prefix);
}

function safeSegment(value: string): boolean {
  return value.length > 0 && value !== "." && value !== ".." && !/[\\/\0]/u.test(value);
}

export function workspaceIdFor(game: GameId, targetVersion: string): string {
  return Buffer.from(`${game}/${targetVersion}`, "utf8").toString("base64url");
}

function decodeWorkspaceId(id: string): { game: GameId; targetVersion: string } {
  let decoded: string;
  try {
    decoded = Buffer.from(id, "base64url").toString("utf8");
  } catch {
    throw new AdminOperationError("INVALID_WORKSPACE", "这个工作区标识无效。", 400);
  }
  const [game, ...versionParts] = decoded.split("/");
  const targetVersion = versionParts.join("/");
  if ((game !== "arcaea" && game !== "phigros") || !safeSegment(targetVersion) || workspaceIdFor(game, targetVersion) !== id) {
    throw new AdminOperationError("INVALID_WORKSPACE", "这个工作区标识无效。", 400);
  }
  return { game, targetVersion };
}

export function workspaceRootFor(config: AdminConfig, id: string): string {
  const decoded = decodeWorkspaceId(id);
  const runtimeRoot = path.resolve(config.workspaceRuntimePath);
  const rootPath = path.resolve(runtimeRoot, decoded.game, decoded.targetVersion);
  if (!within(runtimeRoot, rootPath)) throw new AdminOperationError("INVALID_WORKSPACE", "工作区路径不在配置的 runtime 目录内。", 400);
  return rootPath;
}

function gameName(game: GameId): string {
  return gameConfig(game).name;
}

function userIssue(reason: string): string {
  if (reason.includes("MISSING_FROM_WORKSPACE")) return "工作文件已移除，请重新放回或明确处理";
  if (reason.includes("BLOCKED_AMBIGUOUS_RENAME")) return "这个文件无法确定对应哪一个候选，请手动处理";
  if (reason.includes("BLOCKED_AMBIGUOUS_UPSCALE")) return "超分输出对应多个候选，请手动选择";
  if (reason.includes("UPSCALE_OUTPUT_MISSING")) return "AI 超分结果缺少文件";
  if (reason.includes("artist")) return "需要补充曲师";
  if (reason.includes("title")) return "需要补充曲名";
  if (reason.includes("filename")) return "需要检查下载文件名";
  if (reason.includes("identity")) return "无法确认资源对应关系";
  if (reason.includes("variant")) return "Variant 语义待确认";
  if (reason.includes("metadata")) return "需要补充 metadata";
  return reason;
}

function candidateNeedsInfo(candidate: CandidateType): boolean {
  return candidate.reviewRequirements.metadataReviewRequired
    || candidate.reviewRequirements.manualNamingRequired
    || candidate.reviewRequirements.identityReviewRequired;
}

function candidatePending(candidate: CandidateType): boolean {
  return !candidate.review.confirmed && !["READY", "REJECTED", "BLOCKED"].includes(candidate.status);
}

function candidateNeedsUpscale(candidate: CandidateType): boolean {
  return candidate.processing.requiresUpscale && !candidate.processing.conversion && candidate.status !== "REJECTED";
}

function previewFile(candidate: CandidateType): CandidateType["files"][number] {
  return candidate.files.find((file) => file.role === "processed-upscaled" && file.availability === "present")
    ?? candidate.files.find((file) => file.role === "work-original" && file.availability === "present")
    ?? candidate.files.find((file) => file.role === "raw-original")
    ?? candidate.files[0]!;
}

function candidateView(candidate: CandidateType, workspaceId: string): CandidateView {
  const file = previewFile(candidate);
  const originalFile = candidate.files.find((item) => item.role === "work-original" && item.availability === "present") ?? candidate.files.find((item) => item.role === "raw-original") ?? file;
  const upscaledFile = candidate.files.find((item) => item.role === "processed-upscaled" && item.availability === "present");
  const title = effectiveCandidateTitle(candidate);
  const artist = effectiveCandidateArtist(candidate);
  const issues = candidate.reviewRequirements.reasons.map(userIssue);
  if (candidate.status === "BLOCKED" && candidate.review.note) issues.push(userIssue(candidate.review.note));
  if (candidate.processing.note && candidate.processing.note !== candidate.review.note) issues.push(userIssue(candidate.processing.note));
  const uniqueIssues = [...new Set(issues)];
  const metadata = effectiveCandidateMetadata(candidate);
  const resourceType = effectiveCandidateResourceType(candidate);
  const variantKey = effectiveCandidateVariantKey(candidate);
  const difficulty = typeof metadata.difficulty === "string" ? metadata.difficulty : variantKey;
  return {
    id: candidate.id,
    ...(title ? { title } : {}),
    ...(candidate.suggestedMapping.title ? { suggestedTitle: candidate.suggestedMapping.title } : {}),
    ...(artist ? { artist } : {}),
    filename: effectiveCandidateFilename(candidate),
    resourceType,
    ...(variantKey ? { variant: variantKey } : {}),
    ...(difficulty ? { difficulty } : {}),
    status: candidate.status,
    reviewState: candidate.review.state,
    disposition: candidate.review.disposition,
    modified: Object.keys(candidate.review.overrides).length > 0 || Boolean(candidate.naming.reviewedFilename || candidate.naming.finalFilename) || candidate.files.some((item) => item.role === "work-original" && item.revisions.some((revision) => revision.reason === "content-replacement")),
    replacedImage: candidate.files.some((item) => item.role === "work-original" && item.revisions.some((revision) => revision.reason === "content-replacement")),
    ...(candidate.target?.resourceId && candidate.target.variantId && candidate.target.renditionId ? { target: { resourceId: candidate.target.resourceId, variantId: candidate.target.variantId, renditionId: candidate.target.renditionId, ...(candidate.target.downloadFilename ? { downloadFilename: candidate.target.downloadFilename } : {}) } } : {}),
    confirmed: candidate.review.confirmed,
    confidence: candidate.suggestedMapping.confidence,
    needsInfo: candidateNeedsInfo(candidate),
    needsUpscale: candidateNeedsUpscale(candidate),
    issues: uniqueIssues,
    previewUrl: `/api/workspaces/${workspaceId}/preview/${candidate.id}`,
    originalPreviewUrl: `/api/workspaces/${workspaceId}/preview/${candidate.id}?role=original`,
    ...(upscaledFile ? { upscaledPreviewUrl: `/api/workspaces/${workspaceId}/preview/${candidate.id}?role=upscaled` } : {}),
    file: { sizeBytes: file.sizeBytes, ...(file.width ? { width: file.width } : {}), ...(file.height ? { height: file.height } : {}), mime: file.mime },
    upscale: {
      state: candidate.processing.state,
      matches: candidate.processing.optimizationMatches.map((match) => {
        const output = candidate.files.find((item) => item.id === match.outputFileId);
        return { fileId: match.outputFileId, filename: output?.filename ?? "超分输出", state: match.state, selected: candidate.processing.selectedOutputFileId === match.outputFileId };
      }),
      converted: Boolean(candidate.processing.conversion),
      ...(candidate.processing.conversion?.inputPngSizeBytes !== undefined ? { inputBytes: candidate.processing.conversion.inputPngSizeBytes } : {}),
      ...(candidate.processing.conversion?.outputJpgSizeBytes !== undefined ? { outputBytes: candidate.processing.conversion.outputJpgSizeBytes } : {}),
      ...(candidate.processing.conversion?.sizeReductionRatio !== undefined ? { sizeReductionRatio: candidate.processing.conversion.sizeReductionRatio } : {}),
    },
    metadata: {
      ...(artist ? { artist } : {}),
      ...(typeof metadata.packId === "string" ? { pack: metadata.packId } : {}),
      ...(difficulty ? { difficulty } : {}),
      ...(typeof metadata.addressablesKey === "string" ? { addressablesKey: metadata.addressablesKey } : {}),
    },
    details: {
      ...(candidate.sourceEvidence.sourceRelativePath ? { sourceRelativePath: candidate.sourceEvidence.sourceRelativePath } : {}),
      sourceFilename: candidate.sourceEvidence.sourceFilename,
      ...(candidate.sourceEvidence.sourceGameVersion ? { sourceGameVersion: candidate.sourceEvidence.sourceGameVersion } : {}),
      ...(candidate.sourceEvidence.sourceSha256 ? { sourceSha256: candidate.sourceEvidence.sourceSha256 } : {}),
      sourceType: candidate.sourceEvidence.sourceType,
      externalIdentities: candidate.suggestedMapping.externalIdentities,
      evidence: candidate.suggestedMapping.evidence,
      ...(candidate.provenance ? { provenance: candidate.provenance } : {}),
      reviewRequirements: candidate.reviewRequirements,
      files: candidate.files.map((item) => ({ id: item.id, role: item.role, filename: item.filename, relativePath: item.relativePath, sizeBytes: item.sizeBytes, availability: item.availability })),
    },
  };
}

function summaryFromHandle(handle: WorkspaceHandle, id: string): WorkspaceSummary {
  const progress = computeUpdateBatchProgress(handle.candidates);
  return {
    id,
    game: handle.batch.game,
    gameName: gameName(handle.batch.game),
    baseVersion: handle.batch.baseVersion,
    targetVersion: handle.batch.targetVersion,
    candidateCount: progress.total,
    pendingCount: handle.candidates.filter(candidatePending).length,
    needsInfoCount: handle.candidates.filter(candidateNeedsInfo).length,
    needsUpscaleCount: handle.candidates.filter(candidateNeedsUpscale).length,
    blockedCount: progress.blocked,
    readyCount: progress.ready,
    status: progress.status,
    updatedAt: handle.reviewLog.events.at(-1)?.at ?? handle.batch.createdAt,
  };
}

export async function workspaceView(config: AdminConfig, id: string): Promise<WorkspaceView> {
  const rootPath = workspaceRootFor(config, id);
  const handle = await loadWorkspaceState(rootPath);
  const progress = computeUpdateBatchProgress(handle.candidates);
  const summary = summaryFromHandle(handle, id);
  return {
    ...summary,
    progress,
    diffSummary: handle.batch.diffSummary ?? { added: 0, contentChanged: 0, metadataOnly: 0, unchanged: 0, unmatched: 0, removed: 0 },
    candidates: handle.candidates.map((candidate) => candidateView(candidate, id)),
    notes: handle.candidateManifest.notes,
    recentOperations: handle.reviewLog.events.slice(-12).reverse().map((event) => ({ type: event.type, detail: event.detail, at: event.at })),
  };
}

async function workspaceSummary(config: AdminConfig, game: GameId, targetVersion: string): Promise<WorkspaceSummary | undefined> {
  const id = workspaceIdFor(game, targetVersion);
  try {
    return summaryFromHandle(await loadWorkspaceState(workspaceRootFor(config, id)), id);
  } catch {
    return undefined;
  }
}

export async function listWorkspaces(config: AdminConfig): Promise<WorkspaceSummary[]> {
  const runtimeRoot = path.resolve(config.workspaceRuntimePath);
  await mkdir(runtimeRoot, { recursive: true });
  const summaries: WorkspaceSummary[] = [];
  for (const game of GAME_REGISTRY) {
    const gameRoot = path.join(runtimeRoot, game.id);
    const entries = await readdir(gameRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !safeSegment(entry.name)) continue;
      const summary = await workspaceSummary(config, game.id, entry.name);
      if (summary) summaries.push(summary);
    }
  }
  return summaries.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

export async function loadCatalog(config: AdminConfig): Promise<CatalogType> {
  if (!config.catalogPath) return Catalog.parse({ catalogSchemaVersion: "1.0", catalogId: createUuidV7(), generatedAt: new Date().toISOString(), resources: [], variants: [], renditions: [], objects: [], releaseManifestIds: [] });
  try {
    return await loadCatalogFile(config.catalogPath);
  } catch (error) {
    throw new AdminOperationError("CATALOG_READ_FAILED", "Catalog 文件无法读取或格式不正确。", 409, error instanceof Error ? error.message : String(error));
  }
}

export async function confirmCandidate(config: AdminConfig, workspaceId: string, candidateId: string): Promise<WorkspaceView> {
  const rootPath = workspaceRootFor(config, workspaceId);
  await confirmCandidateInWorkspace(rootPath, candidateId);
  return workspaceView(config, workspaceId);
}

export async function confirmAllSafeCandidates(config: AdminConfig, workspaceId: string): Promise<{ confirmed: number; skipped: number; view: WorkspaceView }> {
  const rootPath = workspaceRootFor(config, workspaceId);
  const before = await loadWorkspaceState(rootPath);
  const safe = before.candidates.filter((candidate) => candidateCanBeConfirmed(candidate).ok);
  let confirmed = 0;
  for (const candidate of safe) {
    await confirmCandidateInWorkspace(rootPath, candidate.id);
    confirmed += 1;
  }
  return { confirmed, skipped: before.candidates.length - confirmed, view: await workspaceView(config, workspaceId) };
}

export async function applyCandidateOverride(config: AdminConfig, workspaceId: string, candidateId: string, input: { title?: string; artist?: string; filename?: string; category?: CandidateType["suggestedMapping"]["resourceType"] }): Promise<WorkspaceView> {
  const rootPath = workspaceRootFor(config, workspaceId);
  const metadata: CandidateMetadataOverride = {
    ...(input.title?.trim() ? { title: input.title.trim() } : {}),
    ...(input.artist?.trim() ? { artist: input.artist.trim() } : {}),
    ...(input.category ? { resourceType: input.category } : {}),
  };
  if (Object.keys(metadata).length > 0) await overrideCandidateMetadataInWorkspace(rootPath, candidateId, metadata);
  if (input.filename?.trim()) await overrideCandidateFilenameInWorkspace(rootPath, candidateId, input.filename.trim(), { finalize: true });
  if (Object.keys(metadata).length === 0 && !input.filename?.trim()) throw new AdminOperationError("EMPTY_OVERRIDE", "至少填写一项需要修改的内容。", 400);
  return workspaceView(config, workspaceId);
}

export async function replaceCandidateImage(config: AdminConfig, workspaceId: string, candidateId: string, sourcePath: string): Promise<WorkspaceView> {
  if (!sourcePath.trim()) throw new AdminOperationError("REPLACEMENT_REQUIRED", "请选择要替换的本地图片。", 400);
  await replaceCandidateImageInWorkspace(workspaceRootFor(config, workspaceId), candidateId, sourcePath.trim());
  return workspaceView(config, workspaceId);
}

export async function removeCandidate(config: AdminConfig, workspaceId: string, candidateId: string, disposition: "removed" | "ignored" = "removed"): Promise<WorkspaceView> {
  await removeCandidateFromUpdate(workspaceRootFor(config, workspaceId), candidateId, disposition, disposition === "ignored" ? "用户确认忽略此候选资源" : "用户将候选从本次 Update 移除");
  return workspaceView(config, workspaceId);
}

export async function restoreCandidate(config: AdminConfig, workspaceId: string, candidateId: string): Promise<WorkspaceView> {
  await restoreCandidateOriginal(workspaceRootFor(config, workspaceId), candidateId);
  return workspaceView(config, workspaceId);
}

export async function resolveCandidateIdentity(config: AdminConfig, workspaceId: string, candidateId: string, identity: { resourceId: string; variantId?: string; renditionId?: string; relatedResourceId?: string }): Promise<WorkspaceView> {
  const rootPath = workspaceRootFor(config, workspaceId);
  await resolveCandidateIdentityInWorkspace(rootPath, candidateId, identity);
  return workspaceView(config, workspaceId);
}

export async function finalizeCandidate(config: AdminConfig, workspaceId: string, candidateId: string, input: { createNewTarget?: boolean; target?: { resourceId: string; variantId: string; renditionId: string; sourceRenditionId?: string; downloadFilename?: string }; downloadFilename?: string }): Promise<WorkspaceView> {
  const rootPath = workspaceRootFor(config, workspaceId);
  const state = await loadWorkspaceState(rootPath);
  const candidate = state.candidates.find((item) => item.id === candidateId);
  if (!candidate) throw new AdminOperationError("UNKNOWN_CANDIDATE", "找不到这个候选资源。", 404);
  const requestedTarget = input.target ?? (input.createNewTarget
    ? { resourceId: createUuidV7(), variantId: createUuidV7(), renditionId: createUuidV7(), ...(input.downloadFilename ? { downloadFilename: input.downloadFilename } : {}) }
    : candidate.target);
  if (!requestedTarget) throw new AdminOperationError("TARGET_REQUIRED", "请先绑定发布目标，或明确选择新建资源。", 409);
  const target = candidate.processing.requiresUpscale && !requestedTarget.sourceRenditionId
    ? { ...requestedTarget, sourceRenditionId: createUuidV7() }
    : requestedTarget;
  await finalizeWorkspaceCandidate(rootPath, candidateId, { target, ...(input.downloadFilename ? { downloadFilename: input.downloadFilename } : {}), metadataValid: true });
  return workspaceView(config, workspaceId);
}

export async function prepareUpscale(config: AdminConfig, workspaceId: string, candidateIds?: string[]): Promise<WorkspaceView> {
  await prepareUpscaleInputs(workspaceRootFor(config, workspaceId), candidateIds ? { candidateIds } : {});
  return workspaceView(config, workspaceId);
}

async function realEsrganConfig(config: AdminConfig) {
  return resolveRealEsrganConfig({
    ...(config.realEsrganExecutable ? { executable: config.realEsrganExecutable } : {}),
    ...(config.realEsrganModelDir ? { modelDir: config.realEsrganModelDir } : {}),
    ...(config.realEsrganModelName ? { modelName: config.realEsrganModelName } : {}),
  });
}

export async function startUpscale(config: AdminConfig, workspaceId: string, candidateIds?: string[], force = false): Promise<{ view: WorkspaceView; result: Awaited<ReturnType<typeof runUpscaleBatch>> }> {
  const rootPath = workspaceRootFor(config, workspaceId);
  try {
    const result = await runUpscaleBatch({ rootPath, ...(candidateIds ? { candidateIds } : {}), config: await realEsrganConfig(config), force });
    return { view: await workspaceView(config, workspaceId), result };
  } catch (error) {
    throw new AdminOperationError("UPSCALER_NOT_READY", "Real-ESRGAN 尚未配置好，请检查 executable、模型目录和模型文件。", 409, error instanceof Error ? error.message : String(error));
  }
}

export async function retryUpscale(config: AdminConfig, workspaceId: string, candidateId: string): Promise<{ view: WorkspaceView; result: Awaited<ReturnType<typeof retryUpscaleCandidate>> }> {
  try {
    const result = await retryUpscaleCandidate(workspaceRootFor(config, workspaceId), candidateId, await realEsrganConfig(config));
    return { view: await workspaceView(config, workspaceId), result };
  } catch (error) {
    throw new AdminOperationError("UPSCALER_NOT_READY", "超分失败，可检查本机 Real-ESRGAN 配置后重试。", 409, error instanceof Error ? error.message : String(error));
  }
}

export async function skipUpscale(config: AdminConfig, workspaceId: string, candidateId: string): Promise<WorkspaceView> {
  await skipUpscaleForCandidate(workspaceRootFor(config, workspaceId), candidateId);
  return workspaceView(config, workspaceId);
}

export async function rescanWorkspace(config: AdminConfig, workspaceId: string): Promise<{ view: WorkspaceView; messages: string[] }> {
  const result = await reconcileWorkspace(workspaceRootFor(config, workspaceId));
  const messages = result.diffs
    .filter((diff) => ["RENAMED", "MOVED", "AMBIGUOUS", "MISSING", "MANUAL_ADDITION", "DUPLICATED"].includes(diff.kind))
    .map((diff) => diff.kind === "RENAMED" || diff.kind === "MOVED" ? "检测到 1 个文件已重命名或移动" : diff.kind === "MANUAL_ADDITION" || diff.kind === "DUPLICATED" ? "检测到新增文件，已加入待审核列表" : diff.kind === "MISSING" ? "有文件从工作区移除，相关候选已阻塞" : "检测到无法自动对应的文件，需要手动处理");
  return { view: await workspaceView(config, workspaceId), messages: [...new Set(messages)] };
}

export async function rescanUpscale(config: AdminConfig, workspaceId: string): Promise<{ view: WorkspaceView; result: UpscaleReconciliationResult }> {
  const result = await reconcileUpscaleOutputs(workspaceRootFor(config, workspaceId));
  return { view: await workspaceView(config, workspaceId), result };
}

export async function selectUpscale(config: AdminConfig, workspaceId: string, candidateId: string, outputFileId: string): Promise<WorkspaceView> {
  await selectUpscaleAttempt(workspaceRootFor(config, workspaceId), candidateId, outputFileId);
  return workspaceView(config, workspaceId);
}

export async function convertUpscale(config: AdminConfig, workspaceId: string, candidateId: string, alphaPolicy?: "block" | "flatten-white"): Promise<{ view: WorkspaceView; result: CandidateConversionResult }> {
  const result = await convertSelectedUpscale(workspaceRootFor(config, workspaceId), candidateId, alphaPolicy ? { conversion: { alphaPolicy } } : {});
  if (!["converted", "skipped"].includes(result.conversion.status)) {
    const message = result.conversion.hasActualTransparency
      ? "图片包含透明区域，不能直接转换为 JPG。"
      : result.conversion.message ?? "JPG 转换失败，请检查超分输出。";
    throw new AdminOperationError("UPSCALE_CONVERSION_BLOCKED", message, 409, result.conversion.message);
  }
  return { view: await workspaceView(config, workspaceId), result };
}

export async function publishPreview(config: AdminConfig, workspaceId: string): Promise<PublishPreview> {
  const rootPath = workspaceRootFor(config, workspaceId);
  const state = await loadWorkspaceState(rootPath);
  try {
    const catalog = await loadCatalog(config);
    const manifest = await createReleaseManifestDraft({ batch: state.batch, candidates: state.candidates, workspaceRoot: rootPath, catalog });
    const plan = await createPublishPlanDryRun({ batch: state.batch, candidates: state.candidates, workspaceRoot: rootPath, catalog, releaseManifest: manifest });
    return {
      manifest,
      plan,
      summary: {
        addedResources: manifest.changes.filter((change) => change.changeType === "added-resource").length,
        updatedResources: manifest.changes.filter((change) => ["metadata-changed", "alias-added", "replaced-rendition"].includes(change.changeType)).length,
        metadataOnly: manifest.changes.filter((change) => change.changeType === "metadata-changed").length,
        removedFromCurrentSource: manifest.removedFromCurrentSource.length,
        upscaledRenditions: manifest.changes.filter((change) => change.detail.includes("upscaled")).length,
        originalRenditions: manifest.changes.filter((change) => change.detail.includes("original")).length,
        replacedImages: state.candidates.filter((candidate) => candidate.files.some((file) => file.role === "work-original" && file.revisions.some((revision) => revision.reason === "content-replacement"))).length,
        uploadObjects: plan.objectsToCreate.length,
        uploadBytes: plan.objectsToCreate.reduce((sum, object) => sum + object.sizeBytes, 0),
      },
      ros: rosStorageStatus(),
    };
  } catch (error) {
    if (error instanceof AdminOperationError) throw error;
    throw new AdminOperationError("PUBLISH_PREVIEW_BLOCKED", "当前工作区还不能生成发布计划。请先完成审核、超分和发布目标绑定。", 409, error instanceof Error ? error.message : String(error));
  }
}

export async function publishExecute(config: AdminConfig, workspaceId: string): Promise<PublishExecutionView> {
  const rootPath = workspaceRootFor(config, workspaceId);
  const previous = await loadWorkspacePublishRecord<PublishExecutionView>(rootPath);
  if (previous?.status === "published") return { ...previous, ros: rosStorageStatus() };
  const state = await loadWorkspaceState(rootPath);
  const catalog = await loadCatalog(config);
  const manifest = await createReleaseManifestDraft({ batch: state.batch, candidates: state.candidates, workspaceRoot: rootPath, catalog });
  const plan = await createPublishPlanDryRun({ batch: state.batch, candidates: state.candidates, workspaceRoot: rootPath, catalog, releaseManifest: manifest });
  const progress: PublishProgress[] = [];
  try {
    const result = await executePublishPlan({
      plan,
      manifest,
      batch: state.batch,
      candidates: state.candidates,
      catalog,
      workspaceRoot: rootPath,
      storage: new S3StorageClient(),
      ...(config.catalogPath ? { catalogPath: config.catalogPath } : {}),
      ...(config.catalogPath ? { releasesDirectory: path.join(path.dirname(config.catalogPath), "releases") } : {}),
      onProgress: (value) => progress.push(value),
    });
    const response: PublishExecutionView = { status: "published", uploadedObjectKeys: result.uploadedObjectKeys, skippedObjectKeys: result.skippedObjectKeys, releaseManifestId: result.releaseManifest.id, progress, ros: rosStorageStatus() };
    await markWorkspacePublished(rootPath, response);
    return response;
  } catch (error) {
    if (error instanceof Error && error.message === "ROS credentials are not configured.") throw new AdminOperationError("ROS_NOT_CONFIGURED", "ROS 凭据未配置。", 409);
    if (error instanceof Error && "code" in error && (error as { code?: unknown }).code === "NOT_CONFIGURED") throw new AdminOperationError("ROS_NOT_CONFIGURED", "ROS 凭据未配置。", 409);
    throw error;
  }
}

export async function legacyMigrationDryRun(config: AdminConfig): Promise<LegacyMigrationPlan> {
  if (!config.legacyAssetRoot) throw new AdminOperationError("LEGACY_ROOT_NOT_CONFIGURED", "Legacy 目录未配置。", 409);
  try {
    return await scanFirstMigrationPlan({
      sourceRoot: config.legacyAssetRoot,
      ...(config.arcaeaApkDir ? { arcaeaApkDirectory: config.arcaeaApkDir } : {}),
      ...(config.legacyExtractorRoot ? { legacyExtractorRoot: config.legacyExtractorRoot } : {}),
      runtimeRoot: config.workspaceRuntimePath,
    });
  }
  catch { throw new AdminOperationError("LEGACY_SCAN_FAILED", "Legacy 目录无法读取。", 409); }
}

export async function previewFilePath(config: AdminConfig, workspaceId: string, candidateId: string, role?: "original" | "upscaled"): Promise<{ filePath: string; mime: CandidateType["files"][number]["mime"] }> {
  const rootPath = workspaceRootFor(config, workspaceId);
  const handle = await loadWorkspaceState(rootPath);
  const candidate = handle.candidates.find((item) => item.id === candidateId);
  if (!candidate) throw new AdminOperationError("PREVIEW_NOT_FOUND", "预览文件不存在。", 404);
  const file = role === "original"
    ? candidate.files.find((item) => item.role === "work-original" && item.availability === "present") ?? candidate.files.find((item) => item.role === "raw-original")
    : role === "upscaled"
      ? candidate.files.find((item) => item.role === "processed-upscaled" && item.availability === "present")
      : previewFile(candidate);
  if (!file) throw new AdminOperationError("PREVIEW_NOT_FOUND", "预览文件不存在。", 404);
  const filePath = path.resolve(rootPath, file.relativePath);
  if (!within(rootPath, filePath)) throw new AdminOperationError("PREVIEW_NOT_FOUND", "预览文件路径无效。", 404);
  try {
    const [realRoot, realFile] = await Promise.all([realpath(rootPath), realpath(filePath)]);
    if (!within(realRoot, realFile) || !(await stat(realFile)).isFile()) throw new Error("not a file inside workspace");
    return { filePath: realFile, mime: file.mime };
  } catch {
    throw new AdminOperationError("PREVIEW_NOT_FOUND", "预览文件不存在。", 404);
  }
}

export function knownWorkspaceFolder(config: AdminConfig, workspaceId: string, folder: "workspace" | "upscale-input" | "upscale-output" | "processed"): string {
  const rootPath = workspaceRootFor(config, workspaceId);
  const directory = folder === "workspace" ? rootPath : path.join(rootPath, folder);
  if (!within(rootPath, directory)) throw new AdminOperationError("INVALID_FOLDER", "文件夹路径无效。", 400);
  return directory;
}

export function candidateStatusCounts(view: WorkspaceView) {
  return {
    all: view.candidates.length,
    pending: view.candidates.filter((candidate) => !candidate.confirmed && !["READY", "REJECTED", "BLOCKED"].includes(candidate.status)).length,
    info: view.candidates.filter((candidate) => candidate.needsInfo).length,
    upscale: view.candidates.filter((candidate) => candidate.needsUpscale).length,
    done: view.candidates.filter((candidate) => candidate.confirmed || candidate.status === "READY").length,
    blocked: view.candidates.filter((candidate) => candidate.status === "BLOCKED").length,
  };
}

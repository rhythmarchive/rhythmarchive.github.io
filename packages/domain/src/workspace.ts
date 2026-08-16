import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  Candidate,
  CandidateFile,
  CandidateManifest,
  RawManifest,
  ReviewLog,
  UpdateBatch,
  WorkspaceScanSnapshot,
  type Candidate as CandidateType,
  type CandidateFile as CandidateFileType,
  type CandidateManifest as CandidateManifestType,
  type RawManifest as RawManifestType,
  type ReviewEvent as ReviewEventType,
  type ReviewLog as ReviewLogType,
  type UpdateBatch as UpdateBatchType,
  type Catalog as CatalogType,
} from "./schema.js";
import {
  createUuidV7,
  candidateFilenameAliases,
  normalizeFilenameStem,
  renameCandidate as renameCandidateIdentity,
} from "./identity.js";
import {
  DEFAULT_WORKSPACE_LAYOUT,
  ensureWorkspaceLayout,
  validateWorkspaceRelativePath,
} from "./workflow.js";
import {
  candidateCanBeConfirmed,
  confirmCandidate as confirmCandidateReview,
  overrideCandidateFilename as overrideCandidateFilenameReview,
  overrideCandidateMetadata as overrideCandidateMetadataReview,
  resolveCandidateIdentity as resolveCandidateIdentityReview,
  effectiveCandidateFilename,
  effectiveCandidateResourceType,
  identityReviewSatisfied,
  isUpscaleEligible,
  metadataReviewSatisfied,
  type CandidateMetadataOverride,
} from "./review.js";
import {
  convertOptimizationPngToJpeg,
  inspectImageAlpha,
  isOptimizationFilename,
  matchOptimizationOutputs,
  preserveOptimizationPng,
  type JpegConversionOptions,
  type OptimizationOutput,
} from "./upscale.js";
import { applyCatalogTargets, catalogSourceRecords, classifySemanticDiff, candidateSourceRecord, sourceInventoryRecord, writeUpdateDiff, type SourceInventoryRecord, type UpdateDiffResult } from "./diff.js";

const WORKSPACE_STATE_FILE = "metadata/candidates.json";
const RAW_MANIFEST_FILE = "metadata/raw-manifest.json";
const CANDIDATE_MANIFEST_FILE = "metadata/candidate-manifest.json";
const REVIEW_LOG_FILE = "metadata/review-log.json";
const SCAN_SNAPSHOT_FILE = "metadata/workspace-scan.json";
const UPSCALE_MAP_FILE = "metadata/upscale-map.json";
const UPSCALE_RECONCILIATION_FILE = "metadata/upscale-reconciliation.json";
const PUBLISH_RESULT_FILE = "metadata/publish-result.json";

type IsoInput = Date | string | undefined;

function timestamp(value: IsoInput): string {
  const result = value instanceof Date ? value.toISOString() : value ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(result))) throw new Error(`invalid timestamp: ${result}`);
  return result;
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.partial-${process.pid}-${createUuidV7()}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

function portableRelative(rootPath: string, absolutePath: string): string {
  const relative = path.relative(rootPath, absolutePath).split(path.sep).join("/");
  if (!validateWorkspaceRelativePath(relative)) throw new Error(`path escapes workspace: ${absolutePath}`);
  return relative;
}

function resolveWorkspacePath(rootPath: string, relativePath: string): string {
  if (!validateWorkspaceRelativePath(relativePath)) throw new Error(`invalid workspace relative path: ${relativePath}`);
  const root = path.resolve(rootPath);
  const resolved = path.resolve(root, relativePath);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (resolved !== root && !resolved.startsWith(prefix)) throw new Error(`workspace path escapes root: ${relativePath}`);
  return resolved;
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const input = await readFile(filePath);
  hash.update(input);
  return hash.digest("hex");
}

type ScannedFile = {
  relativePath: string;
  filename: string;
  sizeBytes: number;
  sha256: string;
  mtimeMs: number;
};

async function walkFiles(rootPath: string): Promise<ScannedFile[]> {
  if (!(await exists(rootPath))) return [];
  const result: ScannedFile[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile()) {
        const fileStats = await stat(absolutePath);
        result.push({
          relativePath: portableRelative(rootPath, absolutePath),
          filename: entry.name,
          sizeBytes: fileStats.size,
          sha256: await sha256File(absolutePath),
          mtimeMs: fileStats.mtimeMs,
        });
      }
    }
  }
  await visit(rootPath);
  return result;
}

function extensionFor(filename: string): CandidateFileType["extension"] {
  const extension = path.extname(filename).slice(1).toLowerCase();
  if (["jpg", "jpeg", "png", "webp", "avif", "gif"].includes(extension)) return extension as CandidateFileType["extension"];
  return "bin";
}

function mimeFor(filename: string): CandidateFileType["mime"] {
  const extension = extensionFor(filename);
  return extension === "jpg" || extension === "jpeg"
    ? "image/jpeg"
    : extension === "png"
      ? "image/png"
      : extension === "webp"
        ? "image/webp"
        : extension === "avif"
          ? "image/avif"
          : extension === "gif"
            ? "image/gif"
            : "application/octet-stream";
}

async function imageFields(filePath: string, filename: string): Promise<Pick<CandidateFileType, "mime" | "extension" | "width" | "height" | "alpha">> {
  const mime = mimeFor(filename);
  const extension = extensionFor(filename);
  if (!mime.startsWith("image/")) return { mime, extension };
  try {
    const metadata = await sharp(filePath, { animated: false }).metadata();
    let alpha: CandidateFileType["alpha"] = "none";
    if (metadata.hasAlpha) {
      const stats = await sharp(filePath, { animated: false }).stats();
      alpha = stats.isOpaque ? "opaque" : "translucent";
    }
    return { mime, extension, width: metadata.width, height: metadata.height, alpha };
  } catch {
    return { mime, extension, alpha: "unknown" };
  }
}

async function candidateFileFromPath(options: {
  rootPath: string;
  relativePath: string;
  candidateId: string;
  role: CandidateFileType["role"];
  generatedBy: CandidateFileType["generatedBy"];
  id?: string;
  reason?: CandidateFileType["revisions"][number]["reason"];
  observedAt?: string;
}): Promise<CandidateFileType> {
  const fullPath = resolveWorkspacePath(options.rootPath, options.relativePath);
  const fileStats = await stat(fullPath);
  const filename = path.basename(options.relativePath);
  const sha256 = await sha256File(fullPath);
  const details = await imageFields(fullPath, filename);
  const observedAt = options.observedAt ?? new Date().toISOString();
  return {
    workspaceSchemaVersion: "1.0",
    id: options.id ?? createUuidV7(),
    candidateId: options.candidateId,
    role: options.role,
    relativePath: options.relativePath,
    filename,
    ...details,
    sizeBytes: fileStats.size,
    sha256,
    mtimeMs: fileStats.mtimeMs,
    availability: "present",
    revisions: [{
      revision: 1,
      relativePath: options.relativePath,
      filename,
      sizeBytes: fileStats.size,
      sha256,
      mtimeMs: fileStats.mtimeMs,
      observedAt,
      reason: options.reason ?? "initial",
    }],
    createdAt: observedAt,
    generatedBy: options.generatedBy,
  };
}

function appendRevision(file: CandidateFileType, next: {
  relativePath: string;
  filename: string;
  sizeBytes: number;
  sha256: string;
  mtimeMs: number;
  observedAt: string;
  reason: CandidateFileType["revisions"][number]["reason"];
}): CandidateFileType {
  const last = file.revisions.at(-1);
  if (last && last.relativePath === next.relativePath && last.sha256 === next.sha256 && last.sizeBytes === next.sizeBytes) return {
    ...file,
    relativePath: next.relativePath,
    filename: next.filename,
    sizeBytes: next.sizeBytes,
    sha256: next.sha256,
    mtimeMs: next.mtimeMs,
  };
  return {
    ...file,
    relativePath: next.relativePath,
    filename: next.filename,
    sizeBytes: next.sizeBytes,
    sha256: next.sha256,
    mtimeMs: next.mtimeMs,
    revisions: [...file.revisions, { revision: file.revisions.length + 1, ...next }],
  };
}

export type CandidateManifestAdapterCandidate = {
  id?: string;
  sourcePath?: string;
  sourceRelativePath?: string;
  sourceFilename?: string;
  sourceGameVersion?: string;
  sourceSha256?: string;
  detection?: CandidateType["sourceEvidence"]["detection"];
  evidence?: CandidateType["sourceEvidence"]["evidence"];
  suggestedFilename?: string;
  resourceType?: CandidateType["suggestedMapping"]["resourceType"];
  title?: string;
  variantKey?: string;
  variantKind?: CandidateType["suggestedMapping"]["variantKind"];
  metadata?: CandidateType["suggestedMapping"]["metadata"];
  externalIdentities?: CandidateType["suggestedMapping"]["externalIdentities"];
  confidence?: CandidateType["suggestedMapping"]["confidence"];
  mappingEvidence?: CandidateType["suggestedMapping"]["evidence"];
  provenance?: CandidateType["provenance"];
  reviewRequirements?: CandidateType["reviewRequirements"];
  initialStatus?: CandidateType["status"];
  blockedReason?: string;
  requiresUpscale?: boolean;
  target?: CandidateType["target"];
};

export type CandidateManifestAdapterInput = {
  id?: string;
  game: CandidateManifestType["game"];
  sourceType: CandidateManifestType["sourceType"];
  sourceSnapshot: string;
  extractorVersion?: string;
  notes?: string[];
  candidates: Array<CandidateManifestAdapterCandidate | CandidateType>;
};

export type CreateWorkspaceOptions = {
  rootPath?: string;
  workspaceRoot?: string;
  game: CandidateManifestType["game"];
  baseVersion: string;
  targetVersion: string;
  sourceManifest: CandidateManifestAdapterInput | CandidateManifestType;
  candidates?: Array<CandidateManifestAdapterCandidate | CandidateType>;
  sourceFiles?: Record<string, string>;
  sourceRoot?: string;
  baseApk?: UpdateBatchType["baseApk"];
  targetApk?: UpdateBatchType["targetApk"];
  extractorVersion?: string;
  now?: IsoInput;
};

export type WorkspaceHandle = {
  rootPath: string;
  created: boolean;
  batch: UpdateBatchType;
  candidateManifest: CandidateManifestType;
  candidates: CandidateType[];
  rawManifest: RawManifestType;
  reviewLog: ReviewLogType;
};

export type AdaptedCandidateManifest = {
  manifest: CandidateManifestType;
  candidateIds: string[];
};

function isCandidate(value: CandidateManifestAdapterCandidate | CandidateType): value is CandidateType {
  return "batchId" in value && "naming" in value && "suggestedMapping" in value && "files" in value;
}

/**
 * Small adapter contract for future Arcaea/Phigros extractors. It only builds
 * the workspace-facing envelope; it does not assign semantic Catalog IDs or
 * touch the filesystem.
 */
export function adaptCandidateManifest(input: CandidateManifestAdapterInput, now?: IsoInput): AdaptedCandidateManifest {
  const createdAt = timestamp(now);
  const candidateIds = input.candidates.map((candidate) => isCandidate(candidate) ? candidate.id : candidate.id ?? createUuidV7(Date.parse(createdAt)));
  const manifest = CandidateManifest.parse({
    workspaceSchemaVersion: "1.0",
    id: input.id ?? createUuidV7(Date.parse(createdAt)),
    sourceType: input.sourceType,
    game: input.game,
    sourceSnapshot: input.sourceSnapshot,
    createdAt,
    ...(input.extractorVersion ? { extractorVersion: input.extractorVersion } : {}),
    candidateIds,
    candidateCount: candidateIds.length,
    notes: input.notes ?? [],
  });
  return { manifest, candidateIds };
}

function manifestInput(options: CreateWorkspaceOptions): CandidateManifestAdapterInput {
  const raw = options.sourceManifest;
  if ("candidates" in raw) return raw;
  const candidates = options.candidates ?? [];
  if (candidates.length === 0) throw new Error("createWorkspace requires Candidate objects or adapter candidates");
  return {
    ...(raw.id ? { id: raw.id } : {}),
    game: raw.game,
    sourceType: raw.sourceType,
    sourceSnapshot: raw.sourceSnapshot,
    ...(raw.extractorVersion ? { extractorVersion: raw.extractorVersion } : {}),
    ...(raw.notes ? { notes: raw.notes } : {}),
    candidates,
  };
}

function sourcePathFor(options: CreateWorkspaceOptions, input: CandidateManifestAdapterCandidate | CandidateType, candidateId: string): string {
  if (!isCandidate(input) && input.sourcePath) return path.resolve(input.sourcePath);
  const sourceFiles = options.sourceFiles ?? {};
  const candidate = isCandidate(input) ? input : undefined;
  const sourceRelativePath = candidate?.sourceEvidence.sourceRelativePath ?? (!isCandidate(input) ? input.sourceRelativePath : undefined);
  const mapped = sourceFiles[candidateId] ?? (sourceRelativePath ? sourceFiles[sourceRelativePath] : undefined);
  if (mapped) return path.resolve(mapped);
  if (options.sourceRoot && sourceRelativePath) return path.resolve(options.sourceRoot, sourceRelativePath);
  throw new Error(`no source file mapping for Candidate ${candidateId}`);
}

function candidateFilename(input: CandidateManifestAdapterCandidate | CandidateType, sourcePath: string): string {
  if (isCandidate(input)) return input.naming.sourceFilename;
  return input.sourceFilename ?? path.basename(sourcePath);
}

function suggestedFilename(input: CandidateManifestAdapterCandidate | CandidateType, sourceFilename: string): string {
  if (isCandidate(input)) return input.naming.suggestedFilename;
  return input.suggestedFilename ?? sourceFilename;
}

function uniqueWorkRelativePath(used: Set<string>, filename: string, candidateId: string): string {
  const normalized = filename.replace(/[\\/\0]/g, "_").trim() || `${candidateId}.bin`;
  const direct = `work/${normalized}`;
  if (!used.has(direct.toLowerCase())) {
    used.add(direct.toLowerCase());
    return direct;
  }
  const fallback = `work/candidates/${candidateId}/${normalized}`;
  used.add(fallback.toLowerCase());
  return fallback;
}

function defaultApk(role: "base" | "target", version: string, rootPath: string): UpdateBatchType["baseApk"] {
  return {
    role,
    version,
    filename: `local-${version}.apk`,
    absolutePath: path.join(rootPath, "source-apks", `local-${version}.apk`),
    verification: "unverified",
  };
}

async function loadWorkspace(rootPath: string): Promise<WorkspaceHandle> {
  const root = path.resolve(rootPath);
  const batch = UpdateBatch.parse(await readJson(path.join(root, DEFAULT_WORKSPACE_LAYOUT.batchManifest)));
  const candidateManifest = CandidateManifest.parse(await readJson(path.join(root, CANDIDATE_MANIFEST_FILE)));
  const candidates = (await readJson<unknown[]>(path.join(root, WORKSPACE_STATE_FILE))).map((value) => Candidate.parse(value));
  const rawManifest = RawManifest.parse(await readJson(path.join(root, RAW_MANIFEST_FILE)));
  const reviewLog = ReviewLog.parse(await readJson(path.join(root, REVIEW_LOG_FILE)));
  return { rootPath: root, created: false, batch, candidateManifest, candidates, rawManifest, reviewLog };
}

async function writeWorkspaceState(handle: WorkspaceHandle): Promise<void> {
  await atomicWriteJson(path.join(handle.rootPath, WORKSPACE_STATE_FILE), handle.candidates);
  await atomicWriteJson(path.join(handle.rootPath, DEFAULT_WORKSPACE_LAYOUT.batchManifest), handle.batch);
  await atomicWriteJson(path.join(handle.rootPath, CANDIDATE_MANIFEST_FILE), handle.candidateManifest);
  await atomicWriteJson(path.join(handle.rootPath, RAW_MANIFEST_FILE), handle.rawManifest);
  await atomicWriteJson(path.join(handle.rootPath, REVIEW_LOG_FILE), handle.reviewLog);
}

function reviewEvent(type: ReviewEventType["type"], detail: string, candidateId?: string, data: Record<string, unknown> = {}, at?: string): ReviewEventType {
  return { id: createUuidV7(), candidateId, at: at ?? new Date().toISOString(), type, detail, data };
}

function addReviewEvents(handle: WorkspaceHandle, events: ReviewEventType[]): WorkspaceHandle {
  handle.reviewLog = { ...handle.reviewLog, events: [...handle.reviewLog.events, ...events] };
  return handle;
}

export async function createVersionWorkspace(options: CreateWorkspaceOptions): Promise<WorkspaceHandle> {
  const rootPath = path.resolve(options.rootPath ?? options.workspaceRoot ?? path.resolve(".runtime", "updates", options.game, options.targetVersion));
  const existingBatch = path.join(rootPath, DEFAULT_WORKSPACE_LAYOUT.batchManifest);
  if (await exists(existingBatch) && await exists(path.join(rootPath, WORKSPACE_STATE_FILE))) return loadWorkspace(rootPath);

  const input = manifestInput(options);
  if (input.game !== options.game) throw new Error(`source manifest game ${input.game} does not match ${options.game}`);
  const createdAt = timestamp(options.now);
  const batchId = createUuidV7(Date.parse(createdAt));
  const sourceManifestId = input.id ?? createUuidV7(Date.parse(createdAt));
  await ensureWorkspaceLayout(rootPath);

  const usedWorkPaths = new Set<string>();
  const candidates: CandidateType[] = [];
  const rawEntries: RawManifestType["entries"] = [];
  for (const rawCandidate of input.candidates) {
    const candidateId = isCandidate(rawCandidate) ? rawCandidate.id : rawCandidate.id ?? createUuidV7(Date.parse(createdAt));
    const sourcePath = sourcePathFor(options, rawCandidate, candidateId);
    const sourceFilename = candidateFilename(rawCandidate, sourcePath);
    const suggested = suggestedFilename(rawCandidate, sourceFilename);
    const workFilename = isCandidate(rawCandidate)
      ? rawCandidate.naming.finalFilename ?? rawCandidate.naming.reviewedFilename ?? rawCandidate.naming.suggestedFilename
      : suggested;
    const rawRelativePath = `raw/candidates/${candidateId}/${sourceFilename.replace(/[\\/\0]/g, "_")}`;
    const workRelativePath = uniqueWorkRelativePath(usedWorkPaths, workFilename, candidateId);
    const rawPath = resolveWorkspacePath(rootPath, rawRelativePath);
    const workPath = resolveWorkspacePath(rootPath, workRelativePath);
    await mkdir(path.dirname(rawPath), { recursive: true });
    await mkdir(path.dirname(workPath), { recursive: true });
    await copyFile(sourcePath, rawPath);
    await copyFile(rawPath, workPath);
    const rawStats = await stat(rawPath);
    const rawSha256 = await sha256File(rawPath);
    const rawDetails = await imageFields(rawPath, sourceFilename);
    rawEntries.push({ candidateId, relativePath: rawRelativePath, filename: sourceFilename, sizeBytes: rawStats.size, sha256: rawSha256 });

    const existingCandidate = isCandidate(rawCandidate) ? rawCandidate : undefined;
    const resourceType = isCandidate(rawCandidate) ? rawCandidate.suggestedMapping.resourceType : rawCandidate.resourceType ?? "other";
    const requestedRequiresUpscale = !isCandidate(rawCandidate)
      ? rawCandidate.requiresUpscale ?? false
      : rawCandidate.processing.requiresUpscale;
    const requiresUpscale = isUpscaleEligible(options.game, resourceType) && requestedRequiresUpscale;
    const metadata = isCandidate(rawCandidate) ? rawCandidate.suggestedMapping.metadata : rawCandidate.metadata ?? {};
    const variantKind = isCandidate(rawCandidate) ? rawCandidate.suggestedMapping.variantKind : rawCandidate.variantKind;
    const variantKey = isCandidate(rawCandidate) ? rawCandidate.suggestedMapping.variantKey : rawCandidate.variantKey;
    const title = isCandidate(rawCandidate) ? rawCandidate.suggestedMapping.title : rawCandidate.title;
    const reviewRequirements = isCandidate(rawCandidate)
      ? rawCandidate.reviewRequirements
      : rawCandidate.reviewRequirements ?? {
          reviewRequired: true,
          manualNamingRequired: false,
          metadataReviewRequired: false,
          identityReviewRequired: false,
          upscaleRecommended: false,
          upscaleRequired: false,
          reasons: [],
        };
    const requestedStatus = isCandidate(rawCandidate) ? rawCandidate.status : rawCandidate.initialStatus;
    const initialStatus: CandidateType["status"] = requestedStatus
      ?? (!isCandidate(rawCandidate) && (rawCandidate.reviewRequirements?.identityReviewRequired || rawCandidate.blockedReason) ? "BLOCKED" : "EXTRACTED");
    const blockedReason = isCandidate(rawCandidate) ? rawCandidate.review.note : rawCandidate.blockedReason;
    const initialReview = initialStatus === "BLOCKED"
      ? { state: "blocked" as const, note: blockedReason ?? "extractor marked Candidate as blocked", confirmed: false, disposition: "active" as const, overrides: {} }
      : { state: "not-started" as const, confirmed: false, disposition: "active" as const, overrides: {} };
    const initialProcessingState = initialStatus === "BLOCKED"
      ? "blocked" as const
      : requiresUpscale
        ? "needs-upscale" as const
        : "not-required" as const;
    const sourceEvidence = isCandidate(rawCandidate)
      ? rawCandidate.sourceEvidence.evidence
      : rawCandidate.evidence ?? [{ kind: "source-path" as const, detail: "CandidateManifest adapter input", confidence: "medium" as const }];
    const mappingEvidence = isCandidate(rawCandidate)
      ? rawCandidate.suggestedMapping.evidence
      : rawCandidate.mappingEvidence ?? sourceEvidence;
    const rawFile = await candidateFileFromPath({ rootPath, relativePath: rawRelativePath, candidateId, role: "raw-original", generatedBy: "extractor", ...(existingCandidate?.files.find((file) => file.role === "raw-original")?.id ? { id: existingCandidate.files.find((file) => file.role === "raw-original")!.id } : {}), observedAt: createdAt });
    const workFile = await candidateFileFromPath({ rootPath, relativePath: workRelativePath, candidateId, role: "work-original", generatedBy: "extractor", ...(existingCandidate?.files.find((file) => file.role === "work-original")?.id ? { id: existingCandidate.files.find((file) => file.role === "work-original")!.id } : {}), observedAt: createdAt });
    const namingBase = existingCandidate?.naming;
    const candidate: CandidateType = {
      workspaceSchemaVersion: "1.0",
      id: candidateId,
      batchId,
      sourceEvidence: {
        sourceType: input.sourceType,
        sourceRelativePath: isCandidate(rawCandidate) ? rawCandidate.sourceEvidence.sourceRelativePath : rawCandidate.sourceRelativePath,
        sourceFilename,
        sourceGameVersion: isCandidate(rawCandidate) ? rawCandidate.sourceEvidence.sourceGameVersion : rawCandidate.sourceGameVersion ?? options.targetVersion,
        sourceSha256: rawSha256,
        detection: isCandidate(rawCandidate) ? rawCandidate.sourceEvidence.detection : rawCandidate.detection ?? "added",
        changeKind: isCandidate(rawCandidate)
          ? rawCandidate.sourceEvidence.changeKind
          : rawCandidate.detection === "changed"
            ? "content-changed"
            : rawCandidate.detection === "renamed"
              ? "unmatched"
              : "added",
        evidence: sourceEvidence,
      },
      naming: {
        sourceFilename,
        suggestedFilename: namingBase?.suggestedFilename ?? suggested,
        reviewedFilename: undefined,
        finalFilename: undefined,
        knownBasenames: [...new Set([...(namingBase?.knownBasenames ?? []), sourceFilename, suggested])],
      },
      suggestedMapping: {
        resourceType,
        title,
        variantKey,
        variantKind,
        externalIdentities: isCandidate(rawCandidate) ? rawCandidate.suggestedMapping.externalIdentities : rawCandidate.externalIdentities ?? [],
        metadata,
        confidence: isCandidate(rawCandidate) ? rawCandidate.suggestedMapping.confidence : rawCandidate.confidence ?? "unknown",
        evidence: mappingEvidence,
      },
      provenance: rawCandidate.provenance,
      reviewRequirements,
      files: [rawFile, workFile],
      review: initialReview,
      processing: { state: initialProcessingState, requiresUpscale, optimizationMatches: [], ...(blockedReason ? { note: blockedReason } : {}) },
      status: initialStatus,
      target: existingCandidate?.target,
    };
    // These values are calculated from the copied bytes, not trusted from an extractor hint.
    if (rawDetails.width && rawDetails.height) {
      candidate.files = candidate.files.map((file) => ({ ...file, width: rawDetails.width, height: rawDetails.height, alpha: rawDetails.alpha }));
    }
    candidates.push(Candidate.parse(candidate));
  }

  const candidateManifest = CandidateManifest.parse({
    workspaceSchemaVersion: "1.0",
    id: sourceManifestId,
    sourceType: input.sourceType,
    game: input.game,
    sourceSnapshot: input.sourceSnapshot,
    createdAt,
    extractorVersion: options.extractorVersion ?? input.extractorVersion,
    candidateIds: candidates.map((candidate) => candidate.id),
    candidateCount: candidates.length,
    notes: input.notes ?? [],
  });
  const rawManifest = RawManifest.parse({ workspaceSchemaVersion: "1.0", batchId, createdAt, entries: rawEntries });
  const reviewLog = ReviewLog.parse({ workspaceSchemaVersion: "1.0", batchId, events: [] });
  const progress = computeUpdateBatchProgress(candidates);
  const batch = UpdateBatch.parse({
    workspaceSchemaVersion: "1.0",
    id: batchId,
    game: options.game,
    targetVersion: options.targetVersion,
    baseVersion: options.baseVersion,
    baseApk: options.baseApk ?? defaultApk("base", options.baseVersion, rootPath),
    targetApk: options.targetApk ?? defaultApk("target", options.targetVersion, rootPath),
    createdAt,
    extractorVersion: options.extractorVersion ?? input.extractorVersion ?? "candidate-manifest-adapter@0.1.0",
    workspace: { rootPath, layout: DEFAULT_WORKSPACE_LAYOUT },
    candidateIds: candidates.map((candidate) => candidate.id),
    candidateCount: candidates.length,
    filenameReviewProgress: progress.filenameReviewProgress,
    namingEditProgress: progress.namingEditProgress,
    metadataReviewProgress: progress.metadataReviewProgress,
    confirmationProgress: progress.confirmationProgress,
    upscaleProgress: progress.upscaleProgress,
    finalReviewProgress: progress.finalReviewProgress,
    status: candidates.length === 0 ? "READY_TO_PUBLISH" : progress.blocked > 0 ? "BLOCKED" : "EXTRACTED",
  });
  const handle: WorkspaceHandle = { rootPath, created: true, batch, candidateManifest, candidates, rawManifest, reviewLog };
  await writeWorkspaceState(handle);
  const initialWorkFiles = await walkFiles(path.join(rootPath, DEFAULT_WORKSPACE_LAYOUT.work));
  await atomicWriteJson(path.join(rootPath, SCAN_SNAPSHOT_FILE), WorkspaceScanSnapshot.parse({ workspaceSchemaVersion: "1.0", scannedAt: createdAt, workFiles: initialWorkFiles, upscaleOutputFiles: [] }));
  return handle;
}

export const createWorkspace = createVersionWorkspace;

export type RawIntegrityCode = "RAW_SOURCE_MODIFIED" | "RAW_SOURCE_MISSING" | "RAW_SOURCE_UNEXPECTED";
export type RawIntegrityIssue = {
  code: RawIntegrityCode;
  relativePath: string;
  expectedSha256?: string;
  actualSha256?: string;
  detail: string;
};

export type WorkspaceDiffKind = "UNCHANGED" | "RENAMED" | "MOVED" | "MODIFIED_CONTENT" | "MISSING" | "MANUAL_ADDITION" | "AMBIGUOUS" | "DUPLICATED";
export type WorkspaceDiff = {
  kind: WorkspaceDiffKind;
  code?: "BLOCKED_AMBIGUOUS_RENAME" | "MISSING_FROM_WORKSPACE" | "DUPLICATED_CONTENT";
  candidateId?: string;
  previousRelativePath?: string;
  relativePath?: string;
  sha256?: string;
  competingCandidateIds?: string[];
  competingPaths?: string[];
  detail: string;
};

export type WorkspaceScanResult = {
  rootPath: string;
  scannedAt: string;
  candidates: CandidateType[];
  workFiles: ScannedFile[];
  upscaleOutputFiles: ScannedFile[];
  diffs: WorkspaceDiff[];
  rawIntegrity: RawIntegrityIssue[];
  snapshot: WorkspaceScanSnapshot;
};

async function checkRawIntegrity(handle: WorkspaceHandle, scannedRaw?: ScannedFile[]): Promise<RawIntegrityIssue[]> {
  const files = scannedRaw ?? await walkFiles(path.join(handle.rootPath, DEFAULT_WORKSPACE_LAYOUT.raw));
  const byPath = new Map(files.map((file) => [`${DEFAULT_WORKSPACE_LAYOUT.raw}/${file.relativePath}`, file]));
  const issues: RawIntegrityIssue[] = [];
  for (const entry of handle.rawManifest.entries) {
    const current = byPath.get(entry.relativePath);
    if (!current) {
      issues.push({ code: "RAW_SOURCE_MISSING", relativePath: entry.relativePath, expectedSha256: entry.sha256, detail: "raw manifest entry is missing from immutable raw/" });
    } else if (current.sha256.toLowerCase() !== entry.sha256.toLowerCase()) {
      issues.push({ code: "RAW_SOURCE_MODIFIED", relativePath: entry.relativePath, expectedSha256: entry.sha256, actualSha256: current.sha256, detail: "raw file bytes differ from the initial raw manifest" });
    }
  }
  const expected = new Set(handle.rawManifest.entries.map((entry) => entry.relativePath));
  for (const current of files) {
    const relativePath = `${DEFAULT_WORKSPACE_LAYOUT.raw}/${current.relativePath}`;
    if (!expected.has(relativePath)) issues.push({ code: "RAW_SOURCE_UNEXPECTED", relativePath, actualSha256: current.sha256, detail: "raw/ contains a file absent from the initial raw manifest" });
  }
  return issues;
}

function previousWorkFile(candidate: CandidateType): CandidateFileType | undefined {
  return candidate.files.find((file) => file.role === "work-original");
}

function invalidateReviewForWorkspaceChange(candidate: CandidateType, detail: string): CandidateType {
  if (candidate.status === "REJECTED" || candidate.status === "BLOCKED") return candidate;
  const status = candidate.status === "READY" || candidate.status === "FINAL_REVIEW" || candidate.status === "UPSCALE_CONVERTED" || candidate.status === "UPSCALE_DETECTED" || candidate.status === "UPSCALE_PENDING"
    ? "NAMING_REVIEW"
    : candidate.status;
  return {
    ...candidate,
    status,
    review: { ...candidate.review, state: "naming-review", confirmed: false, confirmedAt: undefined, reviewedAt: undefined, note: detail },
  };
}

function compareWorkFiles(candidates: CandidateType[], files: ScannedFile[]): WorkspaceDiff[] {
  const byPath = new Map(files.map((file) => [file.relativePath.toLowerCase(), file]));
  const assigned = new Set<string>();
  const missing: Array<{ candidate: CandidateType; file: CandidateFileType }> = [];
  const diffs: WorkspaceDiff[] = [];
  for (const candidate of candidates) {
    if (candidate.status === "REJECTED") continue;
    const file = previousWorkFile(candidate);
    if (!file) continue;
    const current = byPath.get(file.relativePath.replace(/^work\//iu, "").toLowerCase());
    if (!current) {
      missing.push({ candidate, file });
      continue;
    }
    assigned.add(current.relativePath.toLowerCase());
    const currentWorkspaceRelativePath = `work/${current.relativePath}`;
    if (file.sha256 && file.sha256.toLowerCase() !== current.sha256.toLowerCase()) {
      diffs.push({ kind: "MODIFIED_CONTENT", candidateId: candidate.id, previousRelativePath: file.relativePath, relativePath: currentWorkspaceRelativePath, sha256: current.sha256, detail: "same workspace path exists with different bytes; retain Candidate identity and append a content revision" });
    } else if (file.relativePath !== currentWorkspaceRelativePath) {
      const previousDirectory = path.posix.dirname(file.relativePath);
      const currentDirectory = path.posix.dirname(currentWorkspaceRelativePath);
      diffs.push({ kind: previousDirectory === currentDirectory ? "RENAMED" : "MOVED", candidateId: candidate.id, previousRelativePath: file.relativePath, relativePath: currentWorkspaceRelativePath, sha256: current.sha256, detail: "known work file has the same bytes but its portable path casing/name changed" });
    } else {
      diffs.push({ kind: "UNCHANGED", candidateId: candidate.id, previousRelativePath: file.relativePath, relativePath: currentWorkspaceRelativePath, sha256: current.sha256, detail: "known work file path and content are unchanged" });
    }
  }

  const missingByHash = new Map<string, typeof missing>();
  for (const entry of missing) {
    if (!entry.file.sha256) continue;
    const key = entry.file.sha256.toLowerCase();
    const group = missingByHash.get(key) ?? [];
    group.push(entry);
    missingByHash.set(key, group);
  }
  const availableByHash = new Map<string, ScannedFile[]>();
  for (const file of files) {
    if (assigned.has(file.relativePath.toLowerCase())) continue;
    const key = file.sha256.toLowerCase();
    const group = availableByHash.get(key) ?? [];
    group.push(file);
    availableByHash.set(key, group);
  }
  for (const entry of missing) {
    const key = entry.file.sha256?.toLowerCase();
    const candidatesForHash = key ? (missingByHash.get(key) ?? []) : [];
    const filesForHash = key ? (availableByHash.get(key) ?? []) : [];
    if (candidatesForHash.length === 1 && filesForHash.length === 1) {
      const current = filesForHash[0]!;
      assigned.add(current.relativePath.toLowerCase());
      const previousDirectory = path.posix.dirname(entry.file.relativePath);
      const currentDirectory = path.posix.dirname(`work/${current.relativePath}`);
      const kind: WorkspaceDiffKind = previousDirectory === currentDirectory && entry.file.filename !== current.filename ? "RENAMED" : "MOVED";
      diffs.push({ kind, candidateId: entry.candidate.id, previousRelativePath: entry.file.relativePath, relativePath: `work/${current.relativePath}`, sha256: current.sha256, detail: "old work path disappeared and one unique same-hash file was found" });
    } else if (filesForHash.length > 0) {
      diffs.push({ kind: "AMBIGUOUS", code: "BLOCKED_AMBIGUOUS_RENAME", candidateId: entry.candidate.id, previousRelativePath: entry.file.relativePath, ...(key ? { sha256: key } : {}), competingCandidateIds: candidatesForHash.map((item) => item.candidate.id), competingPaths: filesForHash.map((item) => `work/${item.relativePath}`), detail: "same-hash reconciliation has more than one possible candidate or file; no automatic binding was made" });
    } else {
      diffs.push({ kind: "MISSING", code: "MISSING_FROM_WORKSPACE", candidateId: entry.candidate.id, previousRelativePath: entry.file.relativePath, detail: "known work file disappeared and no same-hash replacement exists; this is not a rejection" });
    }
  }

  const knownHashes = new Map<string, string[]>();
  for (const candidate of candidates) {
    for (const file of candidate.files.filter((item) => item.role === "work-original")) {
      if (!file.sha256) continue;
      const group = knownHashes.get(file.sha256.toLowerCase()) ?? [];
      group.push(candidate.id);
      knownHashes.set(file.sha256.toLowerCase(), group);
    }
  }
  for (const file of files) {
    if (assigned.has(file.relativePath.toLowerCase())) continue;
    const duplicateCandidateIds = [...new Set(knownHashes.get(file.sha256.toLowerCase()) ?? [])];
    if (duplicateCandidateIds.length > 0) {
      diffs.push({ kind: "DUPLICATED", code: "DUPLICATED_CONTENT", relativePath: `work/${file.relativePath}`, sha256: file.sha256, competingCandidateIds: duplicateCandidateIds, detail: "new work file has bytes already seen in another Candidate; retain semantic separation and require review" });
    } else {
      diffs.push({ kind: "MANUAL_ADDITION", relativePath: `work/${file.relativePath}`, sha256: file.sha256, detail: "new work file has no prior Candidate mapping and will become a manual Candidate" });
    }
  }
  return diffs;
}

export async function scanWorkspace(rootPath: string): Promise<WorkspaceScanResult> {
  const handle = await loadWorkspace(rootPath);
  const scannedAt = new Date().toISOString();
  const workFiles = await walkFiles(path.join(handle.rootPath, DEFAULT_WORKSPACE_LAYOUT.work));
  const upscaleOutputFiles = (await walkFiles(path.join(handle.rootPath, DEFAULT_WORKSPACE_LAYOUT.upscaleOutput))).filter((file) => isOptimizationFilename(file.filename));
  const rawFiles = await walkFiles(path.join(handle.rootPath, DEFAULT_WORKSPACE_LAYOUT.raw));
  const rawIntegrity = await checkRawIntegrity(handle, rawFiles);
  const snapshot = WorkspaceScanSnapshot.parse({
    workspaceSchemaVersion: "1.0",
    scannedAt,
    workFiles,
    upscaleOutputFiles,
  });
  return { rootPath: handle.rootPath, scannedAt, candidates: handle.candidates, workFiles, upscaleOutputFiles, diffs: compareWorkFiles(handle.candidates, workFiles), rawIntegrity, snapshot };
}

function manualCandidateFromFile(handle: WorkspaceHandle, file: ScannedFile, now: string, requiresUpscale = false): Promise<CandidateType> {
  const candidateId = createUuidV7(Date.parse(now));
  return candidateFileFromPath({ rootPath: handle.rootPath, relativePath: `work/${file.relativePath}`, candidateId, role: "work-original", generatedBy: "manual", reason: "manual-addition", observedAt: now }).then((workFile) => Candidate.parse({
    workspaceSchemaVersion: "1.0",
    id: candidateId,
    batchId: handle.batch.id,
    sourceEvidence: {
      sourceType: "manual",
      sourceFilename: file.filename,
      sourceSha256: file.sha256,
      detection: "manual",
      changeKind: "added",
      evidence: [{ kind: "manual-note", detail: "file appeared in work/ during reconciliation", confidence: "high" }],
    },
    naming: { sourceFilename: file.filename, suggestedFilename: file.filename, knownBasenames: [file.filename] },
    suggestedMapping: { resourceType: "other", externalIdentities: [], metadata: {}, confidence: "unknown", evidence: [{ kind: "manual-note", detail: "manual addition requires human metadata", confidence: "high" }] },
    files: [workFile],
    review: { state: "naming-review", confirmed: false, overrides: {}, note: "manual addition requires metadata and semantic review" },
    processing: { state: requiresUpscale ? "needs-upscale" : "not-required", requiresUpscale, optimizationMatches: [] },
    status: "NAMING_REVIEW",
  }));
}

function updateBatchFromCandidates(batch: UpdateBatchType, candidates: CandidateType[], rawIntegrity: RawIntegrityIssue[]): UpdateBatchType {
  const progress = computeUpdateBatchProgress(candidates);
  const status = rawIntegrity.length > 0 || progress.blocked > 0
    ? "BLOCKED"
    : progress.total === 0
      ? "READY_TO_PUBLISH"
      : progress.ready + progress.rejected === progress.total
        ? "READY_TO_PUBLISH"
        : progress.ready > 0 || progress.filenameReviewProgress.completed > 0
          ? "IN_REVIEW"
          : "EXTRACTED";
  return {
    ...batch,
    candidateIds: candidates.map((candidate) => candidate.id),
    candidateCount: candidates.length,
    filenameReviewProgress: progress.filenameReviewProgress,
    namingEditProgress: progress.namingEditProgress,
    metadataReviewProgress: progress.metadataReviewProgress,
    confirmationProgress: progress.confirmationProgress,
    upscaleProgress: progress.upscaleProgress,
    finalReviewProgress: progress.finalReviewProgress,
    status,
  };
}

export type UpdateBatchProgress = {
  total: number;
  filenameReviewProgress: UpdateBatchType["filenameReviewProgress"];
  namingEditProgress: UpdateBatchType["namingEditProgress"];
  metadataReviewProgress: UpdateBatchType["metadataReviewProgress"];
  confirmationProgress: UpdateBatchType["confirmationProgress"];
  upscaleProgress: UpdateBatchType["upscaleProgress"];
  finalReviewProgress: UpdateBatchType["finalReviewProgress"];
  filenameReviewed: number;
  namingEditRequired: number;
  metadataReviewRequired: number;
  confirmationRequired: number;
  confirmed: number;
  needsUpscale: number;
  upscaleCompleted: number;
  ready: number;
  blocked: number;
  rejected: number;
  status: UpdateBatchType["status"];
};

export function computeUpdateBatchProgress(candidates: CandidateType[]): UpdateBatchProgress {
  const total = candidates.length;
  const namingCandidates = candidates.filter((candidate) => candidate.reviewRequirements.manualNamingRequired);
  const metadataCandidates = candidates.filter((candidate) => candidate.reviewRequirements.metadataReviewRequired);
  const confirmationCandidates = candidates.filter((candidate) => candidate.reviewRequirements.reviewRequired);
  const filenameReviewed = namingCandidates.filter((candidate) => Boolean(candidate.review.overrides.filename)).length;
  const needsUpscale = candidates.filter((candidate) => candidate.processing.requiresUpscale && candidate.status !== "REJECTED").length;
  const upscaleCompleted = candidates.filter((candidate) => candidate.processing.requiresUpscale && Boolean(candidate.processing.processedFileId && candidate.processing.conversion)).length;
  const ready = candidates.filter((candidate) => candidate.status === "READY").length;
  const blocked = candidates.filter((candidate) => candidate.status === "BLOCKED").length;
  const rejected = candidates.filter((candidate) => candidate.status === "REJECTED").length;
  const finalReviewed = candidates.filter((candidate) => candidate.review.state === "approved" || candidate.status === "READY").length;
  const namingEditCompleted = filenameReviewed;
  const metadataReviewCompleted = metadataCandidates.filter((candidate) => metadataReviewSatisfied(candidate)).length;
  const confirmationCompleted = confirmationCandidates.filter((candidate) => candidate.review.confirmed || candidate.status === "READY" || candidate.status === "REJECTED").length;
  const scopedBlocked = (scope: CandidateType[]) => scope.filter((candidate) => candidate.status === "BLOCKED").length;
  const status: UpdateBatchType["status"] = blocked > 0
    ? "BLOCKED"
    : total === 0
      ? "READY_TO_PUBLISH"
    : ready + rejected === total && total > 0
      ? "READY_TO_PUBLISH"
      : "IN_REVIEW";
  return {
    total,
    // A filename edit is optional. Confirmation is the normal review path.
    filenameReviewProgress: { total: namingCandidates.length, completed: namingEditCompleted, blocked: scopedBlocked(namingCandidates) },
    namingEditProgress: { total: namingCandidates.length, completed: namingEditCompleted, blocked: scopedBlocked(namingCandidates) },
    metadataReviewProgress: { total: metadataCandidates.length, completed: metadataReviewCompleted, blocked: scopedBlocked(metadataCandidates) },
    confirmationProgress: { total: confirmationCandidates.length, completed: confirmationCompleted, blocked: scopedBlocked(confirmationCandidates) },
    upscaleProgress: { total: needsUpscale, completed: upscaleCompleted, blocked },
    finalReviewProgress: { total, completed: finalReviewed, blocked },
    filenameReviewed,
    namingEditRequired: namingCandidates.length,
    metadataReviewRequired: metadataCandidates.length,
    confirmationRequired: confirmationCandidates.length,
    confirmed: confirmationCompleted,
    needsUpscale,
    upscaleCompleted,
    ready,
    blocked,
    rejected,
    status,
  };
}

export async function reconcileWorkspace(rootPath: string, options: { now?: IsoInput; manualAdditionRequiresUpscale?: boolean } = {}): Promise<WorkspaceScanResult> {
  const handle = await loadWorkspace(rootPath);
  const scan = await scanWorkspace(handle.rootPath);
  const now = timestamp(options.now);
  const nextCandidates = [...handle.candidates];
  const events: ReviewEventType[] = [];
  for (const diff of scan.diffs) {
    if (diff.kind === "MANUAL_ADDITION" || diff.kind === "DUPLICATED") {
      if (!diff.relativePath) continue;
      const file = scan.workFiles.find((item) => `work/${item.relativePath}` === diff.relativePath);
      if (!file) continue;
      const candidate = await manualCandidateFromFile(handle, file, now, options.manualAdditionRequiresUpscale ?? false);
      nextCandidates.push(candidate);
      events.push(reviewEvent("manual-addition", diff.kind === "DUPLICATED" ? "duplicated work file recorded as a separate manual Candidate" : "new work file recorded as a manual Candidate", candidate.id, { relativePath: diff.relativePath, duplicateCandidateIds: diff.competingCandidateIds ?? [] }, now));
      if (diff.kind === "DUPLICATED") events.push(reviewEvent("duplicated-work-file", diff.detail, candidate.id, { duplicateCandidateIds: diff.competingCandidateIds ?? [] }, now));
      continue;
    }
    if (!diff.candidateId) continue;
    const index = nextCandidates.findIndex((candidate) => candidate.id === diff.candidateId);
    if (index < 0) continue;
    const candidate = nextCandidates[index]!;
    const workFile = previousWorkFile(candidate);
    if (!workFile) continue;
    if (diff.kind === "RENAMED" || diff.kind === "MOVED") {
      const current = scan.workFiles.find((file) => `work/${file.relativePath}` === diff.relativePath);
      if (!current) continue;
      const updatedFile = appendRevision(workFile, { relativePath: `work/${current.relativePath}`, filename: current.filename, sizeBytes: current.sizeBytes, sha256: current.sha256, mtimeMs: current.mtimeMs, observedAt: now, reason: diff.kind === "RENAMED" ? "rename" : "move" });
      const oldFilename = workFile.filename;
      const updated: CandidateType = {
        ...candidate,
        naming: {
          ...candidate.naming,
          reviewedFilename: current.filename,
          finalFilename: candidate.naming.finalFilename === oldFilename ? current.filename : candidate.naming.finalFilename,
          knownBasenames: [...new Set([...candidate.naming.knownBasenames, oldFilename, current.filename])],
        },
        sourceEvidence: { ...candidate.sourceEvidence, detection: "renamed", oldRelativePath: workFile.relativePath },
        files: candidate.files.map((file) => file.id === workFile.id ? updatedFile : file),
      };
      nextCandidates[index] = updated;
      events.push(reviewEvent("manual-rename", `${diff.kind.toLowerCase()} detected from work/ filesystem state`, candidate.id, { oldRelativePath: workFile.relativePath, relativePath: diff.relativePath }, now));
    } else if (diff.kind === "MODIFIED_CONTENT") {
      const current = scan.workFiles.find((file) => `work/${file.relativePath}` === diff.relativePath);
      if (!current) continue;
      const currentDetails = await imageFields(resolveWorkspacePath(handle.rootPath, diff.relativePath!), current.filename);
      nextCandidates[index] = await invalidateUpscaleArtifacts(handle, invalidateReviewForWorkspaceChange({
        ...candidate,
        files: candidate.files.map((file) => file.id === workFile.id
          ? {
              ...appendRevision(workFile, { relativePath: workFile.relativePath, filename: current.filename, sizeBytes: current.sizeBytes, sha256: current.sha256, mtimeMs: current.mtimeMs, observedAt: now, reason: "content-replacement" }),
              ...currentDetails,
          }
          : file),
      }, "work file content changed; final review must be repeated"), now);
      events.push(reviewEvent("content-replaced", "same work path has new bytes; Candidate identity was retained and a new file revision was recorded", candidate.id, { relativePath: diff.relativePath, sha256: diff.sha256 }, now));
    } else if (diff.kind === "MISSING") {
      nextCandidates[index] = { ...candidate, status: "BLOCKED", review: { ...candidate.review, state: "blocked", confirmed: false, confirmedAt: undefined, note: "work file is missing; explicit rejection is still required" }, processing: { ...candidate.processing, state: "blocked", note: "MISSING_FROM_WORKSPACE" } };
      events.push(reviewEvent("missing-from-workspace", diff.detail, candidate.id, { previousRelativePath: diff.previousRelativePath }, now));
    } else if (diff.kind === "AMBIGUOUS") {
      nextCandidates[index] = { ...candidate, status: "BLOCKED", review: { ...candidate.review, state: "blocked", confirmed: false, confirmedAt: undefined, note: "same-hash rename/move is ambiguous" }, processing: { ...candidate.processing, state: "blocked", note: "BLOCKED_AMBIGUOUS_RENAME" } };
      events.push(reviewEvent("ambiguous-rename", diff.detail, candidate.id, { competingCandidateIds: diff.competingCandidateIds ?? [], competingPaths: diff.competingPaths ?? [] }, now));
    }
  }
  for (const issue of scan.rawIntegrity) events.push(reviewEvent("raw-integrity", issue.detail, issue.code === "RAW_SOURCE_UNEXPECTED" ? undefined : handle.rawManifest.entries.find((entry) => entry.relativePath === issue.relativePath)?.candidateId, { code: issue.code, relativePath: issue.relativePath }, now));
  const updatedHandle: WorkspaceHandle = {
    ...handle,
    candidates: nextCandidates,
    batch: updateBatchFromCandidates(handle.batch, nextCandidates, scan.rawIntegrity),
    candidateManifest: { ...handle.candidateManifest, candidateIds: nextCandidates.map((candidate) => candidate.id), candidateCount: nextCandidates.length },
  };
  addReviewEvents(updatedHandle, events);
  await writeWorkspaceState(updatedHandle);
  await atomicWriteJson(path.join(updatedHandle.rootPath, SCAN_SNAPSHOT_FILE), scan.snapshot);
  return { ...scan, candidates: nextCandidates, diffs: scan.diffs, rawIntegrity: scan.rawIntegrity };
}

export async function checkWorkspaceRawIntegrity(rootPath: string): Promise<RawIntegrityIssue[]> {
  const handle = await loadWorkspace(rootPath);
  return checkRawIntegrity(handle);
}

export async function rejectCandidate(rootPath: string, candidateId: string, note = "explicitly rejected by human review", now?: IsoInput): Promise<CandidateType> {
  const handle = await loadWorkspace(rootPath);
  const index = handle.candidates.findIndex((candidate) => candidate.id === candidateId);
  if (index < 0) throw new Error(`unknown Candidate ${candidateId}`);
  const candidate = handle.candidates[index]!;
  const rejected: CandidateType = { ...candidate, status: "REJECTED", review: { ...candidate.review, disposition: "removed", state: "rejected", decision: "reject", reviewedAt: timestamp(now), confirmed: false, confirmedAt: undefined, note } };
  handle.candidates[index] = rejected;
  handle.batch = updateBatchFromCandidates(handle.batch, handle.candidates, await checkRawIntegrity(handle));
  addReviewEvents(handle, [reviewEvent("rejected", note, candidateId, {}, timestamp(now))]);
  await writeWorkspaceState(handle);
  return rejected;
}

export async function ignoreCandidate(rootPath: string, candidateId: string, note = "ignored during local review", now?: IsoInput): Promise<void> {
  const handle = await loadWorkspace(rootPath);
  const index = handle.candidates.findIndex((candidate) => candidate.id === candidateId);
  if (index < 0) throw new Error(`unknown Candidate ${candidateId}`);
  handle.candidates[index] = { ...handle.candidates[index]!, status: "REJECTED", review: { ...handle.candidates[index]!.review, disposition: "ignored", state: "rejected", confirmed: false, confirmedAt: undefined, reviewedAt: timestamp(now), note } };
  handle.batch = updateBatchFromCandidates(handle.batch, handle.candidates, await checkRawIntegrity(handle));
  addReviewEvents(handle, [reviewEvent("ignored", note, candidateId, {}, timestamp(now))]);
  await writeWorkspaceState(handle);
}

async function moveWorkspaceArtifactToStale(handle: WorkspaceHandle, candidateId: string, file: CandidateFileType, now: string): Promise<CandidateFileType> {
  const currentPath = resolveWorkspacePath(handle.rootPath, file.relativePath);
  const staleRelativePath = `metadata/stale-upscale/${candidateId}/${file.role}-${file.id}-${file.filename}`.replace(/[\\/\0]/g, (value) => value === "/" ? "/" : "_");
  const stalePath = resolveWorkspacePath(handle.rootPath, staleRelativePath);
  if (await exists(currentPath)) {
    await mkdir(path.dirname(stalePath), { recursive: true });
    await rename(currentPath, stalePath);
  }
  const moved = appendRevision(file, { relativePath: staleRelativePath, filename: file.filename, sizeBytes: file.sizeBytes, sha256: file.sha256 ?? "0".repeat(64), mtimeMs: file.mtimeMs ?? Date.now(), observedAt: now, reason: "content-replacement" });
  return { ...moved, availability: "missing" };
}

async function invalidateUpscaleArtifacts(handle: WorkspaceHandle, candidate: CandidateType, now: string): Promise<CandidateType> {
  const staleFiles: CandidateFileType[] = [];
  for (const file of candidate.files) {
    if (file.role !== "upscale-output" && file.role !== "processed-upscaled") {
      staleFiles.push(file);
      continue;
    }
    staleFiles.push(await moveWorkspaceArtifactToStale(handle, candidate.id, file, now));
  }
  const { inputFileId: _inputFileId, selectedOutputFileId: _selectedOutputFileId, processedFileId: _processedFileId, conversion: _conversion, ...processingBase } = candidate.processing;
  const requiresUpscale = isUpscaleEligible(handle.batch.game, effectiveCandidateResourceType(candidate));
  const nextProcessing: CandidateType["processing"] = {
    ...processingBase,
    state: requiresUpscale ? "needs-upscale" : "not-required",
    requiresUpscale,
    optimizationMatches: [],
    note: requiresUpscale ? "original candidate changed; previous upscale result was invalidated" : undefined,
  };
  return {
    ...candidate,
    files: staleFiles,
    processing: nextProcessing,
    status: requiresUpscale ? "NEEDS_UPSCALE" : "NAMING_REVIEW",
    review: { ...candidate.review, state: "naming-review", confirmed: false, confirmedAt: undefined, reviewedAt: undefined, note: "candidate image changed; review and upscale must be repeated" },
  };
}

export async function replaceCandidateImageInWorkspace(rootPath: string, candidateId: string, sourcePath: string, now?: IsoInput): Promise<CandidateType> {
  const handle = await loadWorkspace(rootPath);
  const index = handle.candidates.findIndex((candidate) => candidate.id === candidateId);
  if (index < 0) throw new Error(`unknown Candidate ${candidateId}`);
  const candidate = handle.candidates[index]!;
  const source = path.resolve(sourcePath);
  const sourceStats = await stat(source).catch(() => undefined);
  if (!sourceStats?.isFile()) throw new Error("replacement image is not a readable file");
  const sourceFilename = path.basename(source).replace(/[\\/\0]/g, "_");
  const sourceMetadata = await sharp(source).metadata();
  if (!sourceMetadata.width || !sourceMetadata.height || !sourceMetadata.format) throw new Error("replacement file is not a readable image");
  const workFile = previousWorkFile(candidate);
  if (!workFile) throw new Error(`Candidate ${candidateId} has no work-original file`);
  const nextRelativePath = `work/replacements/${candidateId}/${sourceFilename}`;
  const nextPath = resolveWorkspacePath(handle.rootPath, nextRelativePath);
  await mkdir(path.dirname(nextPath), { recursive: true });
  if (path.resolve(source) !== path.resolve(nextPath)) {
    const temporaryPath = `${nextPath}.partial-${process.pid}-${createUuidV7()}`;
    await copyFile(source, temporaryPath);
    await rename(temporaryPath, nextPath);
  }
  const nowValue = timestamp(now);
  const currentStats = await stat(nextPath);
  const currentDetails = await imageFields(nextPath, sourceFilename);
  const replacedFile = { ...appendRevision(workFile, { relativePath: nextRelativePath, filename: sourceFilename, sizeBytes: currentStats.size, sha256: await sha256File(nextPath), mtimeMs: currentStats.mtimeMs, observedAt: nowValue, reason: "content-replacement" }), ...currentDetails, availability: "present" as const, generatedBy: "human" as const };
  if (workFile.relativePath !== nextRelativePath && await exists(resolveWorkspacePath(handle.rootPath, workFile.relativePath))) await unlink(resolveWorkspacePath(handle.rootPath, workFile.relativePath));
  const invalidated = await invalidateUpscaleArtifacts(handle, { ...candidate, files: candidate.files.map((file) => file.id === workFile.id ? replacedFile : file) }, nowValue);
  handle.candidates[index] = invalidated;
  handle.batch = updateBatchFromCandidates(handle.batch, handle.candidates, await checkRawIntegrity(handle));
  addReviewEvents(handle, [reviewEvent("candidate-replaced-image", "human replacement image copied into the update workspace; prior upscale artifacts were invalidated", candidateId, { sourceFilename, relativePath: nextRelativePath }, nowValue)]);
  await writeWorkspaceState(handle);
  return invalidated;
}

export async function removeCandidateFromUpdate(rootPath: string, candidateId: string, disposition: "removed" | "ignored" = "removed", note = "removed from this Update during review", now?: IsoInput): Promise<CandidateType> {
  const handle = await loadWorkspace(rootPath);
  const index = handle.candidates.findIndex((candidate) => candidate.id === candidateId);
  if (index < 0) throw new Error(`unknown Candidate ${candidateId}`);
  const candidate = handle.candidates[index]!;
  const next: CandidateType = {
    ...candidate,
    status: "REJECTED",
    review: { ...candidate.review, disposition, state: "rejected", decision: "reject", confirmed: false, confirmedAt: undefined, reviewedAt: timestamp(now), note },
  };
  handle.candidates[index] = next;
  handle.batch = updateBatchFromCandidates(handle.batch, handle.candidates, await checkRawIntegrity(handle));
  addReviewEvents(handle, [reviewEvent(disposition === "ignored" ? "ignored" : "candidate-removed", note, candidateId, { disposition }, timestamp(now))]);
  await writeWorkspaceState(handle);
  return next;
}

export async function restoreCandidateOriginal(rootPath: string, candidateId: string, now?: IsoInput): Promise<CandidateType> {
  const handle = await loadWorkspace(rootPath);
  const index = handle.candidates.findIndex((candidate) => candidate.id === candidateId);
  if (index < 0) throw new Error(`unknown Candidate ${candidateId}`);
  const candidate = handle.candidates[index]!;
  const rawFile = candidate.files.find((file) => file.role === "raw-original");
  const workFile = previousWorkFile(candidate);
  if (!rawFile || !workFile) throw new Error(`Candidate ${candidateId} has no extractor original to restore`);
  const rawPath = resolveWorkspacePath(handle.rootPath, rawFile.relativePath);
  const restoredRelativePath = `work/restored/${candidateId}/${rawFile.filename}`;
  const restoredPath = resolveWorkspacePath(handle.rootPath, restoredRelativePath);
  await mkdir(path.dirname(restoredPath), { recursive: true });
  await copyFile(rawPath, restoredPath);
  if (workFile.relativePath !== restoredRelativePath && await exists(resolveWorkspacePath(handle.rootPath, workFile.relativePath))) await unlink(resolveWorkspacePath(handle.rootPath, workFile.relativePath));
  const nowValue = timestamp(now);
  const restored = { ...appendRevision(workFile, { relativePath: restoredRelativePath, filename: rawFile.filename, sizeBytes: rawFile.sizeBytes, sha256: rawFile.sha256 ?? await sha256File(restoredPath), mtimeMs: (await stat(restoredPath)).mtimeMs, observedAt: nowValue, reason: "content-replacement" }), availability: "present" as const, generatedBy: "extractor" as const, ...(await imageFields(restoredPath, rawFile.filename)) };
  const resetReview = { state: "not-started" as const, confirmed: false, disposition: "active" as const, overrides: {}, note: "extractor original restored; review is required again" };
  const restoredTarget = candidate.target && candidate.review.overrides.filename
    ? (() => {
      const { downloadFilename: _downloadFilename, ...target } = candidate.target!;
      return target;
    })()
    : candidate.target;
  const restoredBase: CandidateType = {
    ...candidate,
    naming: { sourceFilename: candidate.naming.sourceFilename, suggestedFilename: candidate.naming.suggestedFilename, knownBasenames: [...new Set([candidate.naming.sourceFilename, candidate.naming.suggestedFilename])] },
    files: candidate.files.filter((file) => file.role !== "work-original").concat(restored),
    ...(restoredTarget ? { target: restoredTarget } : {}),
    review: resetReview,
  };
  const invalidated = await invalidateUpscaleArtifacts(handle, restoredBase, nowValue);
  const requiresUpscale = invalidated.processing.requiresUpscale;
  const restoredCandidate: CandidateType = {
    ...invalidated,
    review: resetReview,
    processing: { ...invalidated.processing, state: requiresUpscale ? "needs-upscale" : "not-required", requiresUpscale, optimizationMatches: [], note: requiresUpscale ? "extractor original restored; ready for upscale" : undefined },
    status: requiresUpscale ? "NEEDS_UPSCALE" : "EXTRACTED",
  };
  handle.candidates[index] = Candidate.parse(restoredCandidate);
  handle.batch = updateBatchFromCandidates(handle.batch, handle.candidates, await checkRawIntegrity(handle));
  addReviewEvents(handle, [reviewEvent("candidate-restored", "extractor original and automatic metadata were restored in the update workspace", candidateId, {}, nowValue)]);
  await writeWorkspaceState(handle);
  return handle.candidates[index]!;
}

export async function markUpscaleFailure(rootPath: string, candidateId: string, message: string, now?: IsoInput): Promise<CandidateType> {
  const handle = await loadWorkspace(rootPath);
  const index = handle.candidates.findIndex((candidate) => candidate.id === candidateId);
  if (index < 0) throw new Error(`unknown Candidate ${candidateId}`);
  const candidate = handle.candidates[index]!;
  const invalidated = await invalidateUpscaleArtifacts(handle, candidate, timestamp(now));
  const next: CandidateType = {
    ...invalidated,
    status: "NEEDS_UPSCALE",
    processing: { ...invalidated.processing, state: "needs-upscale", requiresUpscale: isUpscaleEligible(handle.batch.game, effectiveCandidateResourceType(candidate)), note: message },
    review: { ...candidate.review, note: "upscale failed; retry or explicitly publish the original" },
  };
  handle.candidates[index] = Candidate.parse(next);
  handle.batch = updateBatchFromCandidates(handle.batch, handle.candidates, await checkRawIntegrity(handle));
  addReviewEvents(handle, [reviewEvent("upscale-attempt-failure", message, candidateId, {}, timestamp(now))]);
  await writeWorkspaceState(handle);
  return handle.candidates[index]!;
}

export async function skipUpscaleForCandidate(rootPath: string, candidateId: string, note = "human chose to publish the original without upscale", now?: IsoInput): Promise<CandidateType> {
  const handle = await loadWorkspace(rootPath);
  const index = handle.candidates.findIndex((candidate) => candidate.id === candidateId);
  if (index < 0) throw new Error(`unknown Candidate ${candidateId}`);
  const candidate = handle.candidates[index]!;
  if (!isUpscaleEligible(handle.batch.game, effectiveCandidateResourceType(candidate))) throw new Error("only an Arcaea jacket can have an upscale skip decision");
  const at = timestamp(now);
  const staleFiles: CandidateFileType[] = [];
  for (const file of candidate.files) {
    if (file.role === "upscale-output" || file.role === "processed-upscaled") staleFiles.push(await moveWorkspaceArtifactToStale(handle, candidate.id, file, at));
    else staleFiles.push(file);
  }
  const { inputFileId: _inputFileId, selectedOutputFileId: _selectedOutputFileId, processedFileId: _processedFileId, conversion: _conversion, ...processingBase } = candidate.processing;
  const target = candidate.target?.sourceRenditionId
    ? (() => {
        const { sourceRenditionId: _sourceRenditionId, ...targetBase } = candidate.target!;
        return { ...targetBase, renditionId: _sourceRenditionId };
      })()
    : candidate.target;
  const next: CandidateType = Candidate.parse({
    ...candidate,
    files: staleFiles,
    ...(target ? { target } : {}),
    processing: { ...processingBase, state: "ready", requiresUpscale: false, optimizationMatches: [], note },
    status: candidate.review.state === "approved" ? "FINAL_REVIEW" : "NAMING_REVIEW",
    review: { ...candidate.review, note },
  });
  handle.candidates[index] = next;
  handle.batch = updateBatchFromCandidates(handle.batch, handle.candidates, await checkRawIntegrity(handle));
  addReviewEvents(handle, [reviewEvent("upscale-skipped", note, candidateId, { publishOriginal: true }, at)]);
  await writeWorkspaceState(handle);
  return next;
}

export async function loadWorkspaceState(rootPath: string): Promise<WorkspaceHandle> {
  return loadWorkspace(rootPath);
}

export async function loadWorkspacePublishRecord<T = unknown>(rootPath: string): Promise<T | undefined> {
  try {
    return await readJson<T>(path.join(path.resolve(rootPath), PUBLISH_RESULT_FILE));
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
}

export async function markWorkspacePublished(rootPath: string, result: unknown): Promise<void> {
  const handle = await loadWorkspace(rootPath);
  handle.batch = { ...handle.batch, status: "PUBLISHED", statusNote: "ROS increment published and Catalog updated atomically" };
  await writeWorkspaceState(handle);
  await atomicWriteJson(path.join(handle.rootPath, PUBLISH_RESULT_FILE), result);
}

/**
 * Attach the current Catalog's stable targets to extractor candidates. This
 * is intentionally a one-way annotation: existing manual targets and review
 * overrides win, while ambiguous identities remain blocked for confirmation.
 */
export async function applyCatalogDiffToWorkspace(rootPath: string, catalog: CatalogType): Promise<{ handle: WorkspaceHandle; diff: UpdateDiffResult }> {
  const handle = await loadWorkspace(rootPath);
  const result = applyCatalogTargets(handle.candidates, catalog);
  let diff = result.diff;
  let candidates = result.candidates;
  try {
    const inventory = await readJson<{ records?: SourceInventoryRecord[] }>(path.join(handle.rootPath, "metadata", "source-inventory.json"));
    if (Array.isArray(inventory.records) && inventory.records.length > 0) {
      const sourceDiff = classifySemanticDiff(catalogSourceRecords(catalog, handle.batch.game), inventory.records.map((record) => sourceInventoryRecord(record)));
      const sourceEntries = new Map<string, (typeof sourceDiff.entries)[number] | null>();
      for (const entry of sourceDiff.entries) {
        if (!entry.identity) continue;
        if (!sourceEntries.has(entry.identity)) sourceEntries.set(entry.identity, entry);
        else sourceEntries.set(entry.identity, null);
      }
      candidates = candidates.map((candidate) => {
        const source = candidateSourceRecord(candidate);
        const entry = source.identity ? sourceEntries.get(source.identity) ?? undefined : undefined;
        return entry ? Candidate.parse({ ...candidate, sourceEvidence: { ...candidate.sourceEvidence, changeKind: entry.kind } }) : candidate;
      });
      diff = sourceDiff;
    }
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
  const nextHandle: WorkspaceHandle = {
    ...handle,
    candidates,
    batch: updateBatchFromCandidates({ ...handle.batch, diffSummary: diff.summary }, candidates, await checkRawIntegrity(handle)),
  };
  addReviewEvents(nextHandle, candidates.filter((candidate, index) => candidate.sourceEvidence.changeKind !== handle.candidates[index]?.sourceEvidence.changeKind).map((candidate) => reviewEvent("source-changed-again", `source diff classified Candidate as ${candidate.sourceEvidence.changeKind}; manual review state was retained`, candidate.id, { changeKind: candidate.sourceEvidence.changeKind }, new Date().toISOString())));
  await writeWorkspaceState(nextHandle);
  await writeUpdateDiff(nextHandle.rootPath, diff);
  return { handle: nextHandle, diff };
}

export type UpscaleMapEntry = {
  inputFilename: string;
  candidateId: string;
  variantId?: string;
  sourceHash: string;
  sourceRelativePath: string;
  outputFilename?: string;
  active?: boolean;
};

export type UpscaleInputPreparationResult = {
  rootPath: string;
  entries: UpscaleMapEntry[];
  candidates: CandidateType[];
  skippedCandidateIds: string[];
};

function inputFilenameFor(candidate: CandidateType, workFile: CandidateFileType, used: Set<string>): string {
  const preferred = candidate.naming.finalFilename ?? candidate.naming.reviewedFilename ?? workFile.filename;
  const normalized = preferred.replace(/[\\/\0]/g, "_").trim() || `${candidate.id}.bin`;
  if (!used.has(normalized.toLowerCase())) {
    used.add(normalized.toLowerCase());
    return normalized;
  }
  const fallback = `candidate_${candidate.id}__${normalized}`;
  used.add(fallback.toLowerCase());
  return fallback;
}

export async function prepareUpscaleInputs(rootPath: string, options: { candidateIds?: string[]; now?: IsoInput } = {}): Promise<UpscaleInputPreparationResult> {
  const handle = await loadWorkspace(rootPath);
  const now = timestamp(options.now);
  const selectedIds = options.candidateIds ? new Set(options.candidateIds) : undefined;
  const usedNames = new Set<string>();
  const entries: UpscaleMapEntry[] = [];
  let previousEntries: UpscaleMapEntry[] = [];
  try {
    const previous = await readJson<{ entries?: UpscaleMapEntry[] }>(path.join(handle.rootPath, UPSCALE_MAP_FILE));
    previousEntries = previous.entries ?? [];
  } catch {
    previousEntries = [];
  }
  const skippedCandidateIds: string[] = [];
  const nextCandidates: CandidateType[] = [];
  const events: ReviewEventType[] = [];
  for (const original of handle.candidates) {
    if (selectedIds && !selectedIds.has(original.id)) {
      nextCandidates.push(original);
      continue;
    }
    if (original.processing.requiresUpscale && !isUpscaleEligible(handle.batch.game, effectiveCandidateResourceType(original))) {
      throw new Error("only an Arcaea jacket Candidate may enter the upscale queue");
    }
    if (!original.processing.requiresUpscale || original.status === "REJECTED") {
      skippedCandidateIds.push(original.id);
      nextCandidates.push(original);
      continue;
    }
    const workFile = previousWorkFile(original);
    if (!workFile) throw new Error(`Candidate ${original.id} has no work-original file`);
    const sourcePath = resolveWorkspacePath(handle.rootPath, workFile.relativePath);
    const inputFile = original.files.find((file) => file.role === "upscale-input");
    const inputFilename = inputFile?.filename ?? inputFilenameFor(original, workFile, usedNames);
    usedNames.add(inputFilename.toLowerCase());
    const inputRelativePath = inputFile?.relativePath ?? `upscale-input/${inputFilename}`;
    const inputPath = resolveWorkspacePath(handle.rootPath, inputRelativePath);
    await mkdir(path.dirname(inputPath), { recursive: true });
    const inputMetadata = inputFile && inputFile.relativePath === inputRelativePath && await exists(inputPath) ? await candidateFileFromPath({ rootPath: handle.rootPath, relativePath: inputRelativePath, candidateId: original.id, role: "upscale-input", generatedBy: "human", id: inputFile.id, observedAt: now }) : undefined;
    if (!inputMetadata || inputMetadata.sha256 !== workFile.sha256) {
      const temporaryPath = `${inputPath}.partial-${process.pid}-${createUuidV7()}`;
      await copyFile(sourcePath, temporaryPath);
      await rename(temporaryPath, inputPath);
    }
    const nextInputFile = await candidateFileFromPath({ rootPath: handle.rootPath, relativePath: inputRelativePath, candidateId: original.id, role: "upscale-input", generatedBy: "human", ...(inputFile?.id ? { id: inputFile.id } : {}), observedAt: now });
    const completedInputStillMatches = Boolean(original.processing.processedFileId && original.processing.conversion && nextInputFile.sha256 && nextInputFile.sha256 === workFile.sha256);
    const nextCandidate: CandidateType = completedInputStillMatches
      ? { ...original, files: [...original.files.filter((file) => file.role !== "upscale-input"), nextInputFile] }
      : {
          ...original,
          files: [...original.files.filter((file) => file.role !== "upscale-input"), nextInputFile],
          processing: { ...original.processing, state: "upscale-pending", inputFileId: nextInputFile.id },
          status: original.status === "READY" ? "READY" : "UPSCALE_PENDING",
        };
    nextCandidates.push(nextCandidate);
    entries.push({ inputFilename, candidateId: original.id, ...(original.target?.variantId ? { variantId: original.target.variantId } : {}), sourceHash: workFile.sha256 ?? "", sourceRelativePath: workFile.relativePath });
    events.push(reviewEvent("upscale-input-prepared", "copied work-original to upscale-input as a regular file", original.id, { inputFilename, sourceRelativePath: workFile.relativePath }, now));
  }
  const historicalEntries = previousEntries.map((entry) => ({ ...entry, active: false }));
  const mapEntries = [...historicalEntries];
  for (const entry of entries) {
    for (let index = mapEntries.length - 1; index >= 0; index -= 1) {
      if (mapEntries[index]!.candidateId === entry.candidateId && mapEntries[index]!.inputFilename === entry.inputFilename) mapEntries.splice(index, 1);
    }
    mapEntries.push({ ...entry, active: true });
  }
  const mapValue = { workspaceSchemaVersion: "1.0", generatedAt: now, entries: mapEntries };
  handle.candidates = nextCandidates;
  handle.batch = updateBatchFromCandidates(handle.batch, nextCandidates, await checkRawIntegrity(handle));
  addReviewEvents(handle, events);
  await writeWorkspaceState(handle);
  await atomicWriteJson(path.join(handle.rootPath, UPSCALE_MAP_FILE), mapValue);
  return { rootPath: handle.rootPath, entries, candidates: nextCandidates, skippedCandidateIds };
}

type UpscaleSidecar = {
  entries?: Array<Partial<UpscaleMapEntry> & { candidateId?: string }>;
  outputs?: Array<{ outputFilename?: string; candidateId?: string; inputFilename?: string }>;
};

async function loadUpscaleSidecars(handle: WorkspaceHandle): Promise<UpscaleSidecar[]> {
  const sidecars: UpscaleSidecar[] = [];
  const paths = [path.join(handle.rootPath, UPSCALE_MAP_FILE)];
  const outputFiles = await readdir(path.join(handle.rootPath, DEFAULT_WORKSPACE_LAYOUT.upscaleOutput), { withFileTypes: true }).catch(() => []);
  for (const entry of outputFiles) if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) paths.push(path.join(handle.rootPath, DEFAULT_WORKSPACE_LAYOUT.upscaleOutput, entry.name));
  for (const sidecarPath of paths) {
    try {
      if (await exists(sidecarPath)) sidecars.push(await readJson<UpscaleSidecar>(sidecarPath));
    } catch {
      // A malformed optional sidecar is recorded by the caller as unmatched output;
      // it must never make filename matching guess a different Candidate.
    }
  }
  return sidecars;
}

function explicitOutputCandidateIds(output: ScannedFile, sidecars: UpscaleSidecar[]): string[] {
  const outputStem = normalizeFilenameStem(output.filename);
  const candidateIds = new Set<string>();
  for (const sidecar of sidecars) {
    for (const entry of [...(sidecar.outputs ?? []), ...(sidecar.entries ?? [])]) {
      if ("active" in entry && entry.active === false) continue;
      if (!entry.candidateId) continue;
      if (entry.outputFilename && entry.outputFilename.toLowerCase() === output.filename.toLowerCase()) candidateIds.add(entry.candidateId);
      if (entry.inputFilename && normalizeFilenameStem(entry.inputFilename) === outputStem) candidateIds.add(entry.candidateId);
    }
  }
  return [...candidateIds];
}

export type UpscaleOutputReconciliation = {
  output: ScannedFile;
  state: "matched" | "ambiguous" | "unmatched";
  code?: "BLOCKED_AMBIGUOUS_UPSCALE" | "UNMATCHED_UPSCALE";
  matchedBy: "manifest" | "filename-alias" | "manual";
  candidateIds: string[];
  outputFileIds: string[];
  detail: string;
};

export type UpscaleReconciliationResult = {
  rootPath: string;
  outputs: UpscaleOutputReconciliation[];
  candidates: CandidateType[];
};

async function upsertUpscaleOutputFile(handle: WorkspaceHandle, candidate: CandidateType, output: ScannedFile, now: string): Promise<{ candidate: CandidateType; file: CandidateFileType }> {
  const relativePath = `upscale-output/${output.relativePath}`;
  const existing = candidate.files.find((file) => file.role === "upscale-output" && file.relativePath.toLowerCase() === relativePath.toLowerCase());
  if (existing) {
    const current = appendRevision(existing, { relativePath, filename: output.filename, sizeBytes: output.sizeBytes, sha256: output.sha256, mtimeMs: output.mtimeMs, observedAt: now, reason: "upscale-output" });
    const currentDetails = await imageFields(resolveWorkspacePath(handle.rootPath, relativePath), output.filename);
    const refreshed = { ...current, ...currentDetails, availability: "present" as const };
    return { candidate: { ...candidate, files: candidate.files.map((file) => file.id === existing.id ? refreshed : file) }, file: refreshed };
  }
  const file = await candidateFileFromPath({ rootPath: handle.rootPath, relativePath, candidateId: candidate.id, role: "upscale-output", generatedBy: "external-ai", reason: "upscale-output", observedAt: now });
  return { candidate: { ...candidate, files: [...candidate.files, file] }, file };
}

export async function reconcileUpscaleOutputs(rootPath: string, options: { now?: IsoInput } = {}): Promise<UpscaleReconciliationResult> {
  const handle = await loadWorkspace(rootPath);
  const now = timestamp(options.now);
  const outputFiles = (await walkFiles(path.join(handle.rootPath, DEFAULT_WORKSPACE_LAYOUT.upscaleOutput))).filter((file) => isOptimizationFilename(file.filename));
  const sidecars = await loadUpscaleSidecars(handle);
  const candidateById = new Map(handle.candidates.map((candidate) => [candidate.id, candidate]));
  const outputsForMatching: OptimizationOutput[] = outputFiles.map((output) => {
    const manifestCandidateIds = explicitOutputCandidateIds(output, sidecars);
    const optimizationOutput: OptimizationOutput = { id: createUuidV7(), filename: output.filename, relativePath: `upscale-output/${output.relativePath}` };
    if (manifestCandidateIds.length === 1) optimizationOutput.manifestCandidateId = manifestCandidateIds[0]!;
    if (manifestCandidateIds.length > 1) optimizationOutput.manifestCandidateIds = manifestCandidateIds;
    return optimizationOutput;
  });
  const matched = matchOptimizationOutputs(handle.candidates.filter((candidate) => candidate.status !== "REJECTED" && candidate.processing.requiresUpscale && isUpscaleEligible(handle.batch.game, effectiveCandidateResourceType(candidate))), outputsForMatching);
  const results: UpscaleOutputReconciliation[] = [];
  const events: ReviewEventType[] = [];
  const currentOutputPaths = new Set(outputFiles.map((file) => `upscale-output/${file.relativePath}`.toLowerCase()));
  for (const [candidateId, candidate] of candidateById) {
    if (candidate.status === "REJECTED") continue;
    const activeMatchIds = new Set(candidate.processing.optimizationMatches.map((match) => match.outputFileId));
    const missingAttempts = candidate.files.filter((file) => file.role === "upscale-output" && !currentOutputPaths.has(file.relativePath.toLowerCase()) && (file.availability !== "missing" || activeMatchIds.has(file.id)));
    if (missingAttempts.length === 0) continue;
    const missingIds = new Set(missingAttempts.map((file) => file.id));
    const selectedMissing = candidate.processing.selectedOutputFileId ? missingIds.has(candidate.processing.selectedOutputFileId) : false;
    const remainingMatches = candidate.processing.optimizationMatches.filter((match) => !missingIds.has(match.outputFileId));
    const shouldBlock = candidate.processing.requiresUpscale && (selectedMissing || remainingMatches.length === 0);
    candidateById.set(candidateId, {
      ...candidate,
      files: candidate.files.map((file) => missingIds.has(file.id) ? { ...file, availability: "missing" as const } : file),
      processing: {
        ...candidate.processing,
        optimizationMatches: remainingMatches,
        ...(selectedMissing ? { selectedOutputFileId: undefined } : {}),
        ...(shouldBlock ? { state: "blocked" as const, note: "UPSCALE_OUTPUT_MISSING" } : {}),
      },
      ...(shouldBlock ? { status: "BLOCKED" as const, review: { ...candidate.review, state: "blocked" as const, confirmed: false, confirmedAt: undefined, note: "selected or only upscale output disappeared from upscale-output/" } } : {}),
    });
    events.push(reviewEvent("upscale-attempt-failure", "previously recorded optimization output is missing from upscale-output/", candidateId, { missingOutputFileIds: [...missingIds], selectedMissing }, now));
  }
  for (let index = 0; index < outputFiles.length; index += 1) {
    const output = outputFiles[index]!;
    const match = matched[index]!;
    const state = match.state;
    const candidateIds = match.candidateIds;
    const outputFileIds: string[] = [];
    for (const candidateId of candidateIds) {
      const candidate = candidateById.get(candidateId);
      if (!candidate) continue;
      const updated = await upsertUpscaleOutputFile(handle, candidate, output, now);
      const competingCandidateIds = state === "ambiguous" ? candidateIds.filter((id) => id !== candidateId) : [];
      const optimizationMatch = {
        outputFileId: updated.file.id,
        normalizedStem: match.normalizedStem,
        state,
        matchedBy: match.matchedBy,
        competingCandidateIds,
      } as const;
      const priorMatches = updated.candidate.processing.optimizationMatches.filter((item) => item.outputFileId !== updated.file.id);
      const preserveBlocked = updated.candidate.status === "BLOCKED" || updated.candidate.review.state === "blocked";
      const nextProcessing = {
        ...updated.candidate.processing,
        optimizationMatches: [...priorMatches, optimizationMatch],
        state: state === "ambiguous" || preserveBlocked ? "blocked" : "upscale-detected",
        selectedOutputFileId: updated.candidate.processing.selectedOutputFileId === updated.file.id ? updated.candidate.processing.selectedOutputFileId : undefined,
        ...(state === "ambiguous" ? { note: "BLOCKED_AMBIGUOUS_UPSCALE" } : {}),
      } as CandidateType["processing"];
      const nextCandidate: CandidateType = {
        ...updated.candidate,
        processing: nextProcessing,
        status: state === "ambiguous" || preserveBlocked ? "BLOCKED" : updated.candidate.status === "READY" ? "READY" : "UPSCALE_DETECTED",
        review: state === "ambiguous" ? { ...updated.candidate.review, state: "blocked", confirmed: false, confirmedAt: undefined, note: "optimization output matched more than one Candidate" } : updated.candidate.review,
      };
      candidateById.set(candidateId, nextCandidate);
      outputFileIds.push(updated.file.id);
    }
    const detail = state === "matched"
      ? "optimization output uniquely matched a Candidate"
      : state === "ambiguous"
        ? "optimization output matched multiple Candidates; manual disambiguation is required"
        : "optimization output did not match a Candidate; no semantic binding was guessed";
    results.push({ output, state, ...(state === "ambiguous" ? { code: "BLOCKED_AMBIGUOUS_UPSCALE" as const } : state === "unmatched" ? { code: "UNMATCHED_UPSCALE" as const } : {}), matchedBy: match.matchedBy, candidateIds, outputFileIds, detail });
    if (state === "matched") events.push(reviewEvent("upscale-output-detected", detail, candidateIds[0], { relativePath: `upscale-output/${output.relativePath}`, matchedBy: match.matchedBy }, now));
    if (state === "ambiguous") events.push(reviewEvent("upscale-attempt-failure", detail, undefined, { relativePath: `upscale-output/${output.relativePath}`, candidateIds }, now));
    if (state === "unmatched") events.push(reviewEvent("upscale-attempt-failure", detail, undefined, { relativePath: `upscale-output/${output.relativePath}` }, now));
  }
  const candidates = handle.candidates.map((candidate) => candidateById.get(candidate.id) ?? candidate);
  handle.candidates = candidates;
  handle.batch = updateBatchFromCandidates(handle.batch, candidates, await checkRawIntegrity(handle));
  addReviewEvents(handle, events);
  await writeWorkspaceState(handle);
  const currentWorkFiles = await walkFiles(path.join(handle.rootPath, DEFAULT_WORKSPACE_LAYOUT.work));
  await atomicWriteJson(path.join(handle.rootPath, SCAN_SNAPSHOT_FILE), WorkspaceScanSnapshot.parse({ workspaceSchemaVersion: "1.0", scannedAt: now, workFiles: currentWorkFiles, upscaleOutputFiles: outputFiles }));
  await atomicWriteJson(path.join(handle.rootPath, UPSCALE_RECONCILIATION_FILE), { workspaceSchemaVersion: "1.0", reconciledAt: now, outputs: results });
  return { rootPath: handle.rootPath, outputs: results, candidates };
}

export const discoverOptimizationOutputs = reconcileUpscaleOutputs;

export async function selectUpscaleAttempt(rootPath: string, candidateId: string, outputFileId: string, now?: IsoInput): Promise<CandidateType> {
  const handle = await loadWorkspace(rootPath);
  const index = handle.candidates.findIndex((candidate) => candidate.id === candidateId);
  if (index < 0) throw new Error(`unknown Candidate ${candidateId}`);
  const candidate = handle.candidates[index]!;
  if (!candidate.processing.requiresUpscale || !isUpscaleEligible(handle.batch.game, effectiveCandidateResourceType(candidate))) throw new Error("only an eligible Arcaea jacket Candidate may use an upscale result");
  const output = candidate.files.find((file) => file.id === outputFileId && file.role === "upscale-output");
  if (!output) throw new Error(`Candidate ${candidateId} has no upscale attempt ${outputFileId}`);
  const selected: CandidateType = {
    ...candidate,
    processing: {
      ...candidate.processing,
      state: "upscale-detected",
      selectedOutputFileId: outputFileId,
      optimizationMatches: candidate.processing.optimizationMatches.map((match) => match.outputFileId === outputFileId ? { ...match, state: "matched", matchedBy: "manual", competingCandidateIds: [] } : match),
    },
    status: "UPSCALE_DETECTED",
    review: candidate.review.state === "blocked" ? { ...candidate.review, state: "naming-review", confirmed: false, confirmedAt: undefined, note: "optimization attempt selected manually; continue review" } : candidate.review,
  };
  handle.candidates[index] = selected;
  handle.batch = updateBatchFromCandidates(handle.batch, handle.candidates, await checkRawIntegrity(handle));
  addReviewEvents(handle, [reviewEvent("upscale-selected", "human selected the optimization attempt; no automatic attempt selection is used", candidateId, { outputFileId }, timestamp(now))]);
  await writeWorkspaceState(handle);
  return selected;
}

export type CandidateConversionResult = {
  candidate: CandidateType;
  conversion: Awaited<ReturnType<typeof convertOptimizationPngToJpeg>> | Awaited<ReturnType<typeof preserveOptimizationPng>>;
};

type CandidateConversionOptions = Omit<Partial<JpegConversionOptions>, "alphaPolicy"> & {
  alphaPolicy?: JpegConversionOptions["alphaPolicy"] | "preserve-png";
  outputFormat?: "jpeg" | "png";
};

export async function convertSelectedUpscale(rootPath: string, candidateId: string, options: { conversion?: CandidateConversionOptions; outputFilename?: string; now?: IsoInput } = {}): Promise<CandidateConversionResult> {
  const handle = await loadWorkspace(rootPath);
  const index = handle.candidates.findIndex((candidate) => candidate.id === candidateId);
  if (index < 0) throw new Error(`unknown Candidate ${candidateId}`);
  const candidate = handle.candidates[index]!;
  if (!candidate.processing.requiresUpscale || !isUpscaleEligible(handle.batch.game, effectiveCandidateResourceType(candidate))) throw new Error("only an eligible Arcaea jacket Candidate may be converted from upscale");
  if (!candidate.processing.selectedOutputFileId) throw new Error(`Candidate ${candidateId} has no selected upscale attempt`);
  const outputFile = candidate.files.find((file) => file.id === candidate.processing.selectedOutputFileId && file.role === "upscale-output");
  if (!outputFile) throw new Error(`selected upscale attempt ${candidate.processing.selectedOutputFileId} is missing`);
  const inputPath = resolveWorkspacePath(handle.rootPath, outputFile.relativePath);
  const alpha = await inspectImageAlpha(inputPath);
  const preserveAlpha = options.conversion?.outputFormat === "png"
    || options.conversion?.alphaPolicy === "preserve-png"
    || (options.conversion?.alphaPolicy === undefined && alpha.hasActualTransparency);
  const outputName = options.outputFilename ?? candidate.target?.downloadFilename ?? candidate.naming.finalFilename ?? candidate.naming.reviewedFilename ?? candidate.naming.sourceFilename;
  const outputStem = outputName.replace(/\.[^.]+$/u, "") || candidate.id;
  const processedName = `${outputStem}.${preserveAlpha ? "png" : "jpg"}`;
  const outputRelativePath = `processed/${processedName.replace(/[\\/\0]/g, "_")}`;
  const jpegConversion: Partial<JpegConversionOptions> | undefined = options.conversion
    ? (() => {
      const { outputFormat: _outputFormat, alphaPolicy, ...jpegOptions } = options.conversion!;
      if (alphaPolicy === "preserve-png") return jpegOptions;
      return alphaPolicy ? { ...jpegOptions, alphaPolicy } : jpegOptions;
    })()
    : undefined;
  const conversion = preserveAlpha
    ? await preserveOptimizationPng({ inputPath, outputPath: resolveWorkspacePath(handle.rootPath, outputRelativePath) })
    : await convertOptimizationPngToJpeg({
      inputPath,
      outputPath: resolveWorkspacePath(handle.rootPath, outputRelativePath),
      ...(jpegConversion ? { conversion: jpegConversion } : {}),
    });
  const now = timestamp(options.now);
  if (conversion.status !== "converted" && conversion.status !== "skipped") {
    addReviewEvents(handle, [reviewEvent("upscale-attempt-failure", conversion.message ?? "optimization PNG conversion failed", candidateId, { outputFileId: outputFile.id, status: conversion.status }, now)]);
    await writeWorkspaceState(handle);
    return { candidate, conversion };
  }
  const processedFile = await candidateFileFromPath({ rootPath: handle.rootPath, relativePath: outputRelativePath, candidateId, role: "processed-upscaled", generatedBy: "converter", observedAt: now });
  const conversionRecord: NonNullable<CandidateType["processing"]["conversion"]> = {
    outputFormat: conversion.outputFormat ?? (preserveAlpha ? "png" : "jpeg"),
    quality: conversion.quality ?? options.conversion?.quality ?? 95,
    chromaSubsampling: conversion.chromaSubsampling ?? options.conversion?.chromaSubsampling ?? "4:4:4",
    progressive: conversion.progressive ?? options.conversion?.progressive ?? true,
    mozjpeg: conversion.mozjpeg ?? options.conversion?.mozjpeg ?? false,
    alphaPolicy: conversion.alphaPolicy ?? options.conversion?.alphaPolicy ?? (preserveAlpha ? "preserve-png" : "block"),
    flattenBackground: conversion.flattenBackground ?? options.conversion?.flattenBackground ?? "#ffffff",
    inputPngSha256: conversion.inputSha256!,
    inputPngSizeBytes: conversion.inputBytes,
    sizeReductionBytes: conversion.sizeReductionBytes ?? conversion.inputBytes - (conversion.outputBytes ?? processedFile.sizeBytes),
    sizeReductionRatio: conversion.sizeReductionRatio ?? (conversion.outputBytes === undefined ? 0 : 1 - conversion.outputBytes / conversion.inputBytes),
    sourcePngRetained: true as const,
    ...(preserveAlpha
      ? { outputPngSha256: conversion.outputSha256 ?? processedFile.sha256!, outputPngSizeBytes: conversion.outputBytes ?? processedFile.sizeBytes }
      : { outputJpgSha256: conversion.outputSha256 ?? processedFile.sha256!, outputJpgSizeBytes: conversion.outputBytes ?? processedFile.sizeBytes }),
  };
  const nextCandidate: CandidateType = {
    ...candidate,
    files: [...candidate.files.filter((file) => file.role !== "processed-upscaled"), processedFile],
    processing: { ...candidate.processing, state: "upscale-converted", processedFileId: processedFile.id, conversion: conversionRecord },
    status: "UPSCALE_CONVERTED",
    review: candidate.review.state === "blocked" ? { ...candidate.review, state: "final-review", confirmed: false, confirmedAt: undefined, note: "conversion completed; final review is required" } : candidate.review,
  };
  handle.candidates[index] = nextCandidate;
  handle.batch = updateBatchFromCandidates(handle.batch, handle.candidates, await checkRawIntegrity(handle));
  addReviewEvents(handle, [reviewEvent("conversion", preserveAlpha ? "optimization PNG retained as processed PNG with alpha preserved; source PNG retained" : "optimization PNG converted to processed JPEG; source PNG retained", candidateId, { renditionRole: "upscaled", outputRelativePath, outputFormat: conversionRecord.outputFormat, quality: conversionRecord.quality }, now)]);
  await writeWorkspaceState(handle);
  return { candidate: nextCandidate, conversion };
}

export type CandidateFinalizationOptions = {
  target?: NonNullable<CandidateType["target"]>;
  downloadFilename?: string;
  metadataValid?: boolean;
  rawIntegrityOk?: boolean;
  now?: IsoInput;
};

export function approveCandidate(candidate: CandidateType, options: { decision?: NonNullable<CandidateType["review"]["decision"]>; note?: string; now?: IsoInput } = {}): CandidateType {
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
      note: options.note ?? candidate.review.note ?? "human review approved",
    },
  });
}

export function finalizeCandidate(candidate: CandidateType, options: CandidateFinalizationOptions = {}): CandidateType {
  if (candidate.status === "REJECTED" || candidate.review.disposition !== "active") throw new Error("removed or ignored Candidate cannot be finalized");
  if (candidate.status === "BLOCKED") throw new Error("BLOCKED Candidate must be resolved before finalization");
  if (candidate.review.state !== "approved") throw new Error("final review must be explicitly approved before READY");
  if (!identityReviewSatisfied(candidate)) throw new Error("external identity resolution is required before READY");
  if (!metadataReviewSatisfied(candidate)) throw new Error("metadata review is not resolved before READY");
  if (options.metadataValid === false || (options.metadataValid === undefined && candidate.sourceEvidence.sourceType === "manual" && Object.keys(candidate.suggestedMapping.metadata).length === 0)) {
    throw new Error("Candidate metadata is not valid or has not been supplied");
  }
  if (options.rawIntegrityOk === false) throw new Error("raw integrity problems block Candidate finalization");
  const target = options.target ?? candidate.target;
  if (!target?.resourceId || !target.variantId || !target.renditionId) throw new Error("READY Candidate requires Resource, Variant and Rendition targets");
  if (candidate.processing.requiresUpscale && !target.sourceRenditionId) throw new Error("upscaled Candidate requires a stable original sourceRenditionId");
  const fileIds = new Set(candidate.files.map((file) => file.id));
  if (candidate.processing.requiresUpscale) {
    if (!candidate.processing.selectedOutputFileId || !fileIds.has(candidate.processing.selectedOutputFileId)) throw new Error("a selected upscale attempt is required");
    if (!candidate.processing.processedFileId || !fileIds.has(candidate.processing.processedFileId) || !candidate.processing.conversion) throw new Error("selected upscale result must be converted before READY");
    if (candidate.processing.optimizationMatches.some((match) => match.state !== "matched")) throw new Error("unresolved upscale match ambiguity blocks READY");
    if (!candidate.processing.optimizationMatches.some((match) => match.outputFileId === candidate.processing.selectedOutputFileId && match.state === "matched")) throw new Error("selected upscale attempt must have a matched optimization entry");
  } else if (!["not-required", "ready"].includes(candidate.processing.state)) {
    throw new Error("Candidate processing policy is unresolved");
  }
  const automaticOrReviewedFilename = effectiveCandidateFilename(candidate);
  const downloadFilename = options.downloadFilename ?? target.downloadFilename ?? automaticOrReviewedFilename;
  const naming = candidate.naming.finalFilename
    ? candidate.naming
    : { ...candidate.naming, finalFilename: downloadFilename };
  return Candidate.parse({
    ...candidate,
    naming,
    target: { ...target, downloadFilename },
    processing: { ...candidate.processing, state: "ready" },
    review: { ...candidate.review, state: "approved", reviewedAt: candidate.review.reviewedAt ?? timestamp(options.now) },
    status: "READY",
  });
}

export async function approveCandidateInWorkspace(rootPath: string, candidateId: string, options: { decision?: NonNullable<CandidateType["review"]["decision"]>; note?: string; now?: IsoInput } = {}): Promise<CandidateType> {
  const handle = await loadWorkspace(rootPath);
  const index = handle.candidates.findIndex((candidate) => candidate.id === candidateId);
  if (index < 0) throw new Error(`unknown Candidate ${candidateId}`);
  const candidate = approveCandidate(handle.candidates[index]!, options);
  handle.candidates[index] = candidate;
  handle.batch = updateBatchFromCandidates(handle.batch, handle.candidates, await checkRawIntegrity(handle));
  addReviewEvents(handle, [reviewEvent("final-review", "human final review approved; READY still requires explicit finalization", candidateId, {}, timestamp(options.now))]);
  await writeWorkspaceState(handle);
  return candidate;
}

/** Confirm the automatic proposal without manufacturing a filename override. */
export async function confirmCandidateInWorkspace(rootPath: string, candidateId: string, options: { decision?: NonNullable<CandidateType["review"]["decision"]>; note?: string; now?: IsoInput } = {}): Promise<CandidateType> {
  const handle = await loadWorkspace(rootPath);
  const index = handle.candidates.findIndex((candidate) => candidate.id === candidateId);
  if (index < 0) throw new Error(`unknown Candidate ${candidateId}`);
  const before = handle.candidates[index]!;
  const allowed = candidateCanBeConfirmed(before);
  if (!allowed.ok) throw new Error(allowed.reason);
  const candidate = confirmCandidateReview(before, options);
  handle.candidates[index] = candidate;
  handle.batch = updateBatchFromCandidates(handle.batch, handle.candidates, await checkRawIntegrity(handle));
  addReviewEvents(handle, [reviewEvent("candidate-confirmed", "human confirmed the automatic proposal without a field override", candidateId, { automaticFilename: candidate.naming.suggestedFilename, filenameOverride: false }, timestamp(options.now))]);
  await writeWorkspaceState(handle);
  return candidate;
}

export async function overrideCandidateMetadataInWorkspace(rootPath: string, candidateId: string, override: CandidateMetadataOverride, options: { note?: string; now?: IsoInput } = {}): Promise<CandidateType> {
  const handle = await loadWorkspace(rootPath);
  const index = handle.candidates.findIndex((candidate) => candidate.id === candidateId);
  if (index < 0) throw new Error(`unknown Candidate ${candidateId}`);
  const before = handle.candidates[index]!;
  const candidate = overrideCandidateMetadataReview(before, override, options);
  const beforeEligible = isUpscaleEligible(handle.batch.game, effectiveCandidateResourceType(before));
  const afterEligible = isUpscaleEligible(handle.batch.game, effectiveCandidateResourceType(candidate));
  const normalizedCandidate = beforeEligible === afterEligible ? candidate : await invalidateUpscaleArtifacts(handle, candidate, timestamp(options.now));
  handle.candidates[index] = normalizedCandidate;
  handle.batch = updateBatchFromCandidates(handle.batch, handle.candidates, await checkRawIntegrity(handle));
  addReviewEvents(handle, [reviewEvent("metadata-override", "human metadata override recorded; extractor proposal and provenance were preserved", candidateId, { fields: Object.keys(override), provenancePreserved: true }, timestamp(options.now))]);
  await writeWorkspaceState(handle);
  return normalizedCandidate;
}

export async function overrideCandidateFilenameInWorkspace(rootPath: string, candidateId: string, filename: string, options: { note?: string; now?: IsoInput; finalize?: boolean } = {}): Promise<CandidateType> {
  const handle = await loadWorkspace(rootPath);
  const index = handle.candidates.findIndex((candidate) => candidate.id === candidateId);
  if (index < 0) throw new Error(`unknown Candidate ${candidateId}`);
  const renamed = overrideCandidateFilenameReview(handle.candidates[index]!, filename, options);
  const effectiveFilename = renamed.naming.finalFilename ?? renamed.naming.reviewedFilename ?? renamed.naming.suggestedFilename;
  const candidate = renamed.target
    ? Candidate.parse({ ...renamed, target: { ...renamed.target, downloadFilename: effectiveFilename } })
    : renamed;
  handle.candidates[index] = candidate;
  handle.batch = updateBatchFromCandidates(handle.batch, handle.candidates, await checkRawIntegrity(handle));
  addReviewEvents(handle, [reviewEvent("manual-rename", "human filename override recorded explicitly", candidateId, { filename, finalized: options.finalize ?? true, automaticProposal: candidate.naming.suggestedFilename }, timestamp(options.now))]);
  await writeWorkspaceState(handle);
  return candidate;
}

export async function resolveCandidateIdentityInWorkspace(rootPath: string, candidateId: string, identity: { resourceId: string; variantId?: string; renditionId?: string; relatedResourceId?: string }, options: { note?: string; now?: IsoInput } = {}): Promise<CandidateType> {
  const handle = await loadWorkspace(rootPath);
  const index = handle.candidates.findIndex((candidate) => candidate.id === candidateId);
  if (index < 0) throw new Error(`unknown Candidate ${candidateId}`);
  const candidate = resolveCandidateIdentityReview(handle.candidates[index]!, identity, options);
  handle.candidates[index] = candidate;
  handle.batch = updateBatchFromCandidates(handle.batch, handle.candidates, await checkRawIntegrity(handle));
  addReviewEvents(handle, [reviewEvent("identity-resolved", "human resolved Candidate external identity; source evidence was retained", candidateId, { resourceId: identity.resourceId, variantId: identity.variantId, provenancePreserved: true }, timestamp(options.now))]);
  await writeWorkspaceState(handle);
  return candidate;
}

export async function renameCandidateInWorkspace(rootPath: string, candidateId: string, reviewedFilename: string, options: { finalize?: boolean; now?: IsoInput } = {}): Promise<CandidateType> {
  const handle = await loadWorkspace(rootPath);
  const index = handle.candidates.findIndex((candidate) => candidate.id === candidateId);
  if (index < 0) throw new Error(`unknown Candidate ${candidateId}`);
  const renamed = renameCandidateIdentity(handle.candidates[index]!, reviewedFilename, options);
  const effectiveFilename = renamed.naming.finalFilename ?? renamed.naming.reviewedFilename ?? renamed.naming.suggestedFilename;
  const candidate = renamed.target
    ? Candidate.parse({ ...renamed, target: { ...renamed.target, downloadFilename: effectiveFilename } })
    : renamed;
  handle.candidates[index] = candidate;
  handle.batch = updateBatchFromCandidates(handle.batch, handle.candidates, await checkRawIntegrity(handle));
  addReviewEvents(handle, [reviewEvent("manual-rename", "filename review was recorded explicitly", candidateId, { reviewedFilename, finalized: options.finalize === true }, timestamp(options.now))]);
  await writeWorkspaceState(handle);
  return candidate;
}

export async function finalizeWorkspaceCandidate(rootPath: string, candidateId: string, options: CandidateFinalizationOptions = {}): Promise<CandidateType> {
  const handle = await loadWorkspace(rootPath);
  const index = handle.candidates.findIndex((candidate) => candidate.id === candidateId);
  if (index < 0) throw new Error(`unknown Candidate ${candidateId}`);
  if (handle.candidates[index]!.processing.requiresUpscale && !isUpscaleEligible(handle.batch.game, effectiveCandidateResourceType(handle.candidates[index]!))) throw new Error("only an eligible Arcaea jacket Candidate may require upscale before READY");
  const rawIntegrity = await checkRawIntegrity(handle);
  const candidate = finalizeCandidate(handle.candidates[index]!, { ...options, rawIntegrityOk: options.rawIntegrityOk ?? rawIntegrity.length === 0 });
  handle.candidates[index] = candidate;
  handle.batch = updateBatchFromCandidates(handle.batch, handle.candidates, rawIntegrity);
  addReviewEvents(handle, [reviewEvent("final-review", "Candidate finalized as READY after explicit review and policy checks", candidateId, { downloadFilename: candidate.target?.downloadFilename }, timestamp(options.now))]);
  await writeWorkspaceState(handle);
  return candidate;
}

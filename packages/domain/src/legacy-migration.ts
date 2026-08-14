import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  AssetObject,
  Catalog,
  ReleaseManifest,
  Rendition,
  Resource,
  Variant,
  type AssetObject as AssetObjectType,
  type Catalog as CatalogType,
  type ReleaseManifest as ReleaseManifestType,
  type Rendition as RenditionType,
  type Resource as ResourceType,
  type Variant as VariantType,
} from "./schema.js";
import { atomicWriteJson, DEFAULT_CATALOG_PATH, DEFAULT_CATALOG_RELEASES_PATH, loadCatalogFile, writeCatalogAndReleasesAtomic } from "./catalog.js";
import { createUuidV7, immutableObjectKey, objectIdFromSha256 } from "./identity.js";
import { resolveLegacyMigrationSourcePath, type LegacyFileRecord, type LegacyMigrationPlan, type LegacyMigrationProposal } from "./legacy.js";
import { selectPreviewSource, generateThumbnailSet } from "./thumbnails.js";
import { IMMUTABLE_OBJECT_CACHE_CONTROL, type StorageClient } from "./storage.js";
import { sha256File } from "./workspace.js";
import { validateCatalog, validateReleaseManifestConsistency } from "./validation.js";

type MigrationGame = "arcaea" | "phigros";

export type LegacyMigrationValidation = {
  valid: boolean;
  issues: string[];
};

export type LegacyMigrationProgress = {
  stage: "prepare" | "check" | "upload" | "verify" | "catalog" | "complete";
  completed: number;
  total: number;
  message: string;
};

export type LegacyMigrationReport = {
  schemaVersion: "1.0";
  status: "running" | "completed" | "failed";
  sourceSnapshot: string;
  startedAt: string;
  completedAt?: string;
  plannedObjectCount: number;
  plannedObjectBytes: number;
  uploadedObjectCount: number;
  skippedObjectCount: number;
  failedUploadCount: number;
  uploadedBytes: number;
  resourceCount: number;
  objectCount: number;
  catalogPath: string;
  releaseManifestPaths: string[];
  failureCode?: string;
};

export type LegacyMigrationOptions = {
  plan: LegacyMigrationPlan;
  storage: StorageClient;
  runtimeRoot: string;
  catalogPath?: string;
  releasesDirectory?: string;
  reportPath?: string;
  now?: Date | string;
  onProgress?: (progress: LegacyMigrationProgress) => void;
};

export type LegacyMigrationResult = {
  status: "published";
  catalog: CatalogType;
  releaseManifests: ReleaseManifestType[];
  uploadedObjectCount: number;
  skippedObjectCount: number;
  failedUploadCount: number;
  uploadedBytes: number;
  catalogPath: string;
  releaseManifestPaths: string[];
  reportPath: string;
};

export type LegacyConsistencyResult = {
  status: "PASS" | "FAIL" | "NOT_RUN" | "NOT_CONFIGURED";
  missingObjectCount: number;
  headFailureCount: number;
  failedUploadCount: number;
  uploadedObjectCount: number;
  skippedObjectCount: number;
  uploadedBytes: number;
  resourceCount: number;
  objectCount: number;
  catalogPath: string;
  reportPath: string;
};

type PreparedObject = {
  object: AssetObjectType;
  localPath?: string;
};

type PreparedMigration = {
  catalog: CatalogType;
  releaseManifests: ReleaseManifestType[];
  objects: PreparedObject[];
  previewRoot: string;
  catalogPath: string;
  releasesDirectory: string;
  reportPath: string;
};

function iso(value?: Date | string): string {
  const result = value instanceof Date ? value.toISOString() : value ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(result))) throw new Error("invalid migration timestamp");
  return result;
}

function sourceTypeForFile(file: LegacyFileRecord): "legacy" | "arcaea_apk" {
  return file.source === "current-apk" ? "arcaea_apk" : "legacy";
}

function sourceEvidence(file: LegacyFileRecord, detail: string) {
  return [
    { kind: "source-path" as const, detail: `${detail}: ${file.sourceRelativePath}`, confidence: "high" as const },
    { kind: "sha256" as const, detail: "SHA-256 calculated locally", confidence: "high" as const },
  ];
}

function resourceProvenance(file: LegacyFileRecord, sourceSnapshot: string) {
  return {
    sourceType: sourceTypeForFile(file),
    sourceSnapshot,
    ...(file.sourceVersion ? { gameVersion: file.sourceVersion } : {}),
    sourceRelativePath: file.sourceRelativePath,
    sourceFilename: file.sourceFilename,
    sourceSha256: file.sha256!,
    evidence: sourceEvidence(file, "Legacy migration source"),
  };
}

function objectProvenance(file: LegacyFileRecord) {
  return {
    sourceType: sourceTypeForFile(file),
    ...(file.sourceVersion ? { gameVersion: file.sourceVersion } : {}),
    sourceRelativePath: file.sourceRelativePath,
    sourceFilename: file.sourceFilename,
    sourceSha256: file.sha256!,
    evidence: sourceEvidence(file, "Immutable Object source"),
  };
}

function derivedObjectProvenance(file: LegacyFileRecord, sha256: string, width: number): AssetObjectType["provenance"][number] {
  return {
    sourceType: sourceTypeForFile(file),
    ...(file.sourceVersion ? { gameVersion: file.sourceVersion } : {}),
    sourceRelativePath: `derived/previews/${sha256}/${width}.webp`,
    sourceFilename: `${width}.webp`,
    sourceSha256: sha256,
    evidence: [{ kind: "metadata", detail: `preview generated from ${file.sourceRelativePath}`, confidence: "high" }],
  };
}

function mergeProvenance<T extends { sourceRelativePath: string; sourceSha256: string }>(current: T[], additions: T[]): T[] {
  const result = [...current];
  for (const addition of additions) {
    if (!result.some((item) => item.sourceRelativePath === addition.sourceRelativePath && item.sourceSha256.toLowerCase() === addition.sourceSha256.toLowerCase())) result.push(addition);
  }
  return result;
}

function migrationVariantKey(proposal: LegacyMigrationProposal): string {
  return proposal.variantKey ?? "default";
}

function difficultyForVariant(variantKey: string): "PST" | "PRS" | "FTR" | "BYD" | "ETR" | undefined {
  return ["PST", "PRS", "FTR", "BYD", "ETR"].includes(variantKey) ? variantKey as "PST" | "PRS" | "FTR" | "BYD" | "ETR" : undefined;
}

function safeFilename(value: string): string {
  if (!value || /[\\/\0]/u.test(value)) throw new Error("Legacy migration produced an invalid download filename.");
  return value;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function reportFailureCode(error: unknown): string {
  if (error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string") {
    const code = (error as { code: string }).code;
    if (/^[A-Z][A-Z0-9_]*$/u.test(code)) return code;
  }
  return "MIGRATION_FAILED";
}

export function validateLegacyMigrationPlan(plan: LegacyMigrationPlan): LegacyMigrationValidation {
  const issues: string[] = [];
  if (plan.readOnly !== true) issues.push("MigrationPlan must be read-only.");
  if (plan.stats.resourceCount !== plan.proposals.length) issues.push("resourceCount does not match proposals.");
  if (plan.stats.fileCount !== plan.files.length) issues.push("fileCount does not match files.");
  if (plan.stats.blockingIssueCount !== plan.blockingIssues.length) issues.push("blockingIssueCount does not match blockingIssues.");
  if (plan.stats.warningCount !== plan.warnings.length) issues.push("warningCount does not match warnings.");
  if (plan.stats.thumbnailCount !== plan.proposals.length * 3) issues.push("thumbnailCount must be one 320/640/1280 set per proposal.");
  if (plan.sourceSummary) {
    if (!plan.sourceSummary.currentArcaeaApk) issues.push("Current Arcaea APK snapshot is required for the formal first migration.");
    if (plan.sourceSummary.arcaeaJacketFileCount !== undefined && plan.sourceSummary.arcaeaJacketFileCount !== plan.files.filter((file) => file.source === "legacy-curated" && file.game === "arcaea" && file.resourceType === "jacket").length) {
      issues.push("Arcaea curated jacket file count does not match the MigrationPlan.");
    }
    if (plan.sourceSummary.arcaeaCurrentNonJacketCount !== plan.files.filter((file) => file.source === "current-apk" && file.game === "arcaea").length) {
      issues.push("Arcaea current APK non-jacket count does not match the MigrationPlan.");
    }
  }
  for (const file of plan.files) {
    if (!file.sha256 || !file.width || !file.height) issues.push(`file ${file.sourceRelativePath} has no verified bytes or dimensions.`);
    if (file.game === "arcaea" && !(file.source === "current-apk" || (file.source === "legacy-curated" && file.resourceType === "jacket"))) {
      issues.push(`Arcaea file ${file.sourceRelativePath} violates the first-migration source boundary.`);
    }
    if (file.game === "phigros" && file.source !== "legacy") issues.push(`Phigros file ${file.sourceRelativePath} must use the Legacy source.`);
    if (file.renditionType === "upscaled" && (file.game !== "arcaea" || file.resourceType !== "jacket")) {
      issues.push(`non-jacket upscaled file ${file.sourceRelativePath} is not allowed.`);
    }
  }
  return { valid: issues.length === 0, issues };
}

function preparedSourceObject(file: LegacyFileRecord, now: string): AssetObjectType {
  if (!file.sha256 || !file.width || !file.height) throw new Error("MigrationPlan contains an unverified source file.");
  return AssetObject.parse({
    catalogSchemaVersion: "1.0",
    id: objectIdFromSha256(file.sha256),
    sha256: file.sha256,
    mime: file.mime,
    extension: file.extension,
    sizeBytes: file.sizeBytes,
    width: file.width,
    height: file.height,
    alpha: "unknown",
    objectKey: immutableObjectKey(file.sha256, file.extension),
    createdAt: now,
    provenance: [objectProvenance(file)],
  });
}

function addPreparedObject(objects: Map<string, PreparedObject>, prepared: PreparedObject): void {
  const key = prepared.object.id.toLowerCase();
  const existing = objects.get(key);
  if (!existing) {
    objects.set(key, prepared);
    return;
  }
  if (existing.object.sizeBytes !== prepared.object.sizeBytes || existing.object.sha256.toLowerCase() !== prepared.object.sha256.toLowerCase()) {
    throw new Error("Two different byte descriptions use the same Object id.");
  }
  const merged = AssetObject.parse({
    ...existing.object,
    provenance: mergeProvenance(existing.object.provenance, prepared.object.provenance),
  });
  objects.set(key, { object: merged, ...(existing.localPath ? { localPath: existing.localPath } : prepared.localPath ? { localPath: prepared.localPath } : {}) });
}

async function verifySourceFile(plan: LegacyMigrationPlan, file: LegacyFileRecord): Promise<string> {
  const localPath = resolveLegacyMigrationSourcePath(plan, file);
  const fileStats = await stat(localPath).catch(() => undefined);
  if (!fileStats?.isFile() || fileStats.size !== file.sizeBytes) throw new Error("A Legacy source file changed or is missing.");
  if (!file.sha256 || (await sha256File(localPath)).toLowerCase() !== file.sha256.toLowerCase()) throw new Error("A Legacy source SHA-256 no longer matches the MigrationPlan.");
  return localPath;
}

function findResource(resources: ResourceType[], proposal: LegacyMigrationProposal): ResourceType | undefined {
  const sourcePaths = new Set(proposal.sourceFiles);
  return resources.find((resource) => resource.game === proposal.game
    && resource.resourceType === proposal.resourceType
    && resource.provenance.some((provenance) => sourcePaths.has(provenance.sourceRelativePath)));
}

function findVariant(variants: VariantType[], resourceId: string, variantKey: string): VariantType | undefined {
  return variants.find((variant) => variant.resourceId === resourceId && variant.variantKey === variantKey);
}

function findRendition(renditions: RenditionType[], variantId: string, renditionType: RenditionType["renditionType"]): RenditionType | undefined {
  return renditions.find((rendition) => rendition.variantId === variantId && rendition.renditionType === renditionType);
}

function addChange(changesByGame: Map<MigrationGame, ReleaseManifestType["changes"]>, game: MigrationGame, change: ReleaseManifestType["changes"][number]): void {
  changesByGame.set(game, [...(changesByGame.get(game) ?? []), change]);
}

function addPublishedRendition(
  publishedByGame: Map<MigrationGame, Map<string, ReleaseManifestType["publishedRenditions"][number]>>,
  game: MigrationGame,
  rendition: ReleaseManifestType["publishedRenditions"][number],
): void {
  const entries = publishedByGame.get(game) ?? new Map<string, ReleaseManifestType["publishedRenditions"][number]>();
  entries.set(rendition.renditionId, rendition);
  publishedByGame.set(game, entries);
}

async function prepareMigration(options: LegacyMigrationOptions, now: string): Promise<PreparedMigration> {
  const catalogPath = path.resolve(options.catalogPath ?? DEFAULT_CATALOG_PATH);
  const releasesDirectory = path.resolve(options.releasesDirectory ?? DEFAULT_CATALOG_RELEASES_PATH);
  const reportPath = path.resolve(options.reportPath ?? path.join(options.runtimeRoot, "legacy-migration", "latest.json"));
  const catalog = await loadCatalogFile(catalogPath);
  const resources = [...catalog.resources];
  const variants = [...catalog.variants];
  const renditions = [...catalog.renditions];
  const objects = new Map<string, PreparedObject>(catalog.objects.map((object) => [object.id.toLowerCase(), { object }]));
  const migrationObjectIds = new Set<string>();
  const fileByPath = new Map(options.plan.files.map((file) => [file.sourceRelativePath, file]));
  const sourceObjects = new Map<string, { file: LegacyFileRecord; localPath: string; object: AssetObjectType }>();
  const changesByGame = new Map<MigrationGame, ReleaseManifestType["changes"]>();
  const publishedByGame = new Map<MigrationGame, Map<string, ReleaseManifestType["publishedRenditions"][number]>>();
  const affectedByGame = new Map<MigrationGame, Set<string>>();
  const previewRoot = path.join(path.resolve(options.runtimeRoot), "legacy-migration", "previews", options.plan.sourceSnapshot.replace(/[^a-z0-9_-]+/giu, "_").slice(-16), createUuidV7().replaceAll("-", "").slice(-12));
  await mkdir(previewRoot, { recursive: true });

  const getSourceObject = async (file: LegacyFileRecord): Promise<{ file: LegacyFileRecord; localPath: string; object: AssetObjectType }> => {
    const existing = sourceObjects.get(file.sourceRelativePath);
    if (existing) return existing;
    const localPath = await verifySourceFile(options.plan, file);
    const object = preparedSourceObject(file, now);
    addPreparedObject(objects, { object, localPath });
    migrationObjectIds.add(object.id.toLowerCase());
    const result = { file, localPath, object };
    sourceObjects.set(file.sourceRelativePath, result);
    return result;
  };

  for (const [proposalIndex, proposal] of options.plan.proposals.entries()) {
    options.onProgress?.({ stage: "prepare", completed: proposalIndex, total: options.plan.proposals.length, message: `准备 ${proposalIndex + 1} / ${options.plan.proposals.length}` });
    const game: MigrationGame = proposal.game === "arcaea" || proposal.game === "phigros" ? proposal.game : (() => { throw new Error("MigrationPlan contains an unknown game."); })();
    const sourceRecords = proposal.sourceFiles.map((sourcePath) => fileByPath.get(sourcePath)).filter((file): file is LegacyFileRecord => Boolean(file));
    if (sourceRecords.length !== proposal.sourceFiles.length || sourceRecords.length === 0) throw new Error("MigrationPlan proposal references a missing source file.");
    const sourceObjectsForProposal = await Promise.all(sourceRecords.map((file) => getSourceObject(file)));
    const original = proposal.original ? sourceObjectsForProposal.find((item) => item.file.sourceRelativePath === proposal.original) : undefined;
    const upscaled = proposal.upscaled ? sourceObjectsForProposal.find((item) => item.file.sourceRelativePath === proposal.upscaled) : undefined;
    if (upscaled && !original) throw new Error("An upscaled Legacy source has no paired original.");
    const previewSource = selectPreviewSource(sourceObjectsForProposal.map((item) => item.file));
    if (!previewSource) throw new Error("A Legacy proposal has no preview source.");
    const previewSourceObject = sourceObjectsForProposal.find((item) => item.file.sourceRelativePath === previewSource.sourceRelativePath);
    if (!previewSourceObject) throw new Error("A Legacy preview source could not be resolved.");

    const existingResource = findResource(resources, proposal);
    const resourceSourceProvenance = sourceRecords.map((file) => resourceProvenance(file, options.plan.sourceSnapshot));
    const resourceTitle = existingResource?.title ?? proposal.title;
    const resourceMetadata = { ...(existingResource?.metadata ?? {}), ...(proposal.artist && !existingResource?.metadata.artist ? { artist: proposal.artist } : {}) };
    const downloadFilename = safeFilename(proposal.downloadFilename ?? sourceRecords[0]!.sourceFilename);
    const aliases = existingResource?.aliases ?? [];
    const nextResource = Resource.parse({
      ...(existingResource ?? {}),
      catalogSchemaVersion: "1.0",
      id: existingResource?.id ?? createUuidV7(),
      game,
      resourceType: proposal.resourceType,
      ...(resourceTitle ? { title: resourceTitle } : {}),
      aliases: aliases.some((alias) => alias.value === downloadFilename) ? aliases : [...aliases, { value: downloadFilename, kind: "filename" }],
      externalIdentities: existingResource?.externalIdentities ?? [],
      metadata: resourceMetadata,
      relations: existingResource?.relations ?? [],
      provenance: mergeProvenance(existingResource?.provenance ?? [], resourceSourceProvenance),
      lifecycle: existingResource?.lifecycle ?? { status: "published", createdAt: now, updatedAt: now, publishedAt: now },
    });
    if (!existingResource) {
      resources.push(nextResource);
      addChange(changesByGame, game, { changeType: "added-resource", resourceId: nextResource.id, detail: "add Resource from validated Legacy MigrationPlan" });
    } else if (!sameJson(existingResource, nextResource)) {
      resources[resources.indexOf(existingResource)] = nextResource;
      addChange(changesByGame, game, { changeType: "metadata-changed", resourceId: nextResource.id, detail: "update Resource metadata/provenance from validated Legacy MigrationPlan" });
    }
    affectedByGame.set(game, new Set([...(affectedByGame.get(game) ?? []), nextResource.id]));

    const variantKey = migrationVariantKey(proposal);
    const difficulty = difficultyForVariant(variantKey);
    const unresolved256 = proposal.reviewReasons.some((reason) => reason.includes("_256"));
    const existingVariant = findVariant(variants, nextResource.id, variantKey);
    const nextVariant = Variant.parse({
      ...(existingVariant ?? {}),
      catalogSchemaVersion: "1.0",
      id: existingVariant?.id ?? createUuidV7(),
      resourceId: nextResource.id,
      variantKey,
      kind: difficulty ? "difficulty" : unresolved256 ? "unknown" : "default",
      semanticStatus: existingVariant?.semanticStatus === "unresolved" || unresolved256 ? "unresolved" : "confirmed",
      ...(difficulty ? { difficulty } : {}),
      markers: {
        ...(difficulty ? { filenameSuffix: `_${["PST", "PRS", "FTR", "BYD", "ETR"].indexOf(difficulty)}` as "_0" | "_1" | "_2" | "_3" | "_4" } : {}),
        unresolved: [...new Set([...(existingVariant?.markers.unresolved ?? []), ...(unresolved256 ? ["_256_semantics" as const] : [])])],
      },
    });
    if (!existingVariant) {
      variants.push(nextVariant);
      addChange(changesByGame, game, { changeType: "added-variant", resourceId: nextResource.id, variantId: nextVariant.id, detail: "add Variant from validated Legacy MigrationPlan" });
    } else if (!sameJson(existingVariant, nextVariant)) {
      variants[variants.indexOf(existingVariant)] = nextVariant;
      addChange(changesByGame, game, { changeType: "metadata-changed", resourceId: nextResource.id, detail: "update Variant semantics from validated Legacy MigrationPlan" });
    }

    const addRendition = (source: { file: LegacyFileRecord; object: AssetObjectType }, renditionType: "original" | "upscaled", sourceRenditionId?: string): RenditionType => {
      const existing = findRendition(renditions, nextVariant.id, renditionType);
      const next = Rendition.parse({
        ...(existing ?? {}),
        catalogSchemaVersion: "1.0",
        id: existing?.id ?? createUuidV7(),
        variantId: nextVariant.id,
        renditionType,
        origin: renditionType === "original" ? "source" : "derived",
        publishable: true,
        objectId: source.object.id,
        downloadFilename,
        ...(sourceRenditionId ? { sourceRenditionId } : {}),
        generatedBy: renditionType === "original" ? "extractor" : "external-ai",
        createdAt: existing?.createdAt ?? now,
      });
      if (!existing) {
        renditions.push(next);
        addChange(changesByGame, game, { changeType: "added-rendition", resourceId: nextResource.id, variantId: nextVariant.id, renditionId: next.id, objectId: next.objectId, detail: `add ${renditionType} Rendition` });
      } else if (existing.objectId !== next.objectId) {
        renditions[renditions.indexOf(existing)] = next;
        addChange(changesByGame, game, { changeType: "replaced-rendition", resourceId: nextResource.id, variantId: nextVariant.id, renditionId: next.id, objectId: next.objectId, previousObjectId: existing.objectId, detail: `replace ${renditionType} Object` });
      }
      addPublishedRendition(publishedByGame, game, { resourceId: nextResource.id, variantId: nextVariant.id, renditionId: next.id, objectId: next.objectId, downloadFilename });
      return next;
    };

    const originalRendition = original ? addRendition(original, "original") : undefined;
    if (upscaled && originalRendition) addRendition(upscaled, "upscaled", originalRendition.id);
    if (!originalRendition) throw new Error("Every formal Legacy proposal must have an original Rendition.");

    const proposalPreviewDir = path.join(previewRoot, String(proposalIndex).padStart(6, "0"));
    const thumbnails = await generateThumbnailSet(previewSourceObject.localPath, proposalPreviewDir, "preview");
    for (const thumbnail of thumbnails) {
      const metadata = await sharp(thumbnail.absolutePath, { animated: false }).metadata();
      if (!metadata.width || !metadata.height) throw new Error("Generated preview has no dimensions.");
      const previewObject = AssetObject.parse({
        catalogSchemaVersion: "1.0",
        id: objectIdFromSha256(thumbnail.sha256),
        sha256: thumbnail.sha256,
        mime: "image/webp",
        extension: "webp",
        sizeBytes: thumbnail.sizeBytes,
        width: metadata.width,
        height: metadata.height,
        alpha: "unknown",
        objectKey: immutableObjectKey(thumbnail.sha256, "webp"),
        createdAt: now,
        provenance: [derivedObjectProvenance(previewSourceObject.file, thumbnail.sha256, thumbnail.width)],
      });
      addPreparedObject(objects, { object: previewObject, localPath: thumbnail.absolutePath });
      migrationObjectIds.add(previewObject.id.toLowerCase());
      const previewType = `thumbnail-${thumbnail.width}` as "thumbnail-320" | "thumbnail-640" | "thumbnail-1280";
      const existingPreview = findRendition(renditions, nextVariant.id, previewType);
      const nextPreview = Rendition.parse({
        ...(existingPreview ?? {}),
        catalogSchemaVersion: "1.0",
        id: existingPreview?.id ?? createUuidV7(),
        variantId: nextVariant.id,
        renditionType: previewType,
        origin: "derived",
        publishable: false,
        objectId: previewObject.id,
        downloadFilename: `${thumbnail.width}.webp`,
        sourceRenditionId: upscaled ? findRendition(renditions, nextVariant.id, "upscaled")?.id ?? originalRendition.id : originalRendition.id,
        generatedBy: "thumbnailer",
        createdAt: existingPreview?.createdAt ?? now,
      });
      if (!existingPreview) {
        renditions.push(nextPreview);
        addChange(changesByGame, game, { changeType: "added-rendition", resourceId: nextResource.id, variantId: nextVariant.id, renditionId: nextPreview.id, objectId: nextPreview.objectId, detail: `add ${previewType} preview` });
      } else if (existingPreview.objectId !== nextPreview.objectId) {
        renditions[renditions.indexOf(existingPreview)] = nextPreview;
        addChange(changesByGame, game, { changeType: "replaced-rendition", resourceId: nextResource.id, variantId: nextVariant.id, renditionId: nextPreview.id, objectId: nextPreview.objectId, previousObjectId: existingPreview.objectId, detail: `replace ${previewType} preview` });
      }
    }
  }
  options.onProgress?.({ stage: "prepare", completed: options.plan.proposals.length, total: options.plan.proposals.length, message: "准备完成" });

  const games = (["arcaea", "phigros"] as const).filter((game) => (affectedByGame.get(game)?.size ?? 0) > 0);
  const releaseManifests = games.map((game) => ReleaseManifest.parse({
    releaseSchemaVersion: "1.0",
    id: createUuidV7(),
    updateBatchId: createUuidV7(),
    game,
    baseVersion: "legacy",
    targetVersion: game === "arcaea" ? options.plan.sourceSummary?.currentArcaeaApk?.version ?? "current-apk" : "legacy",
    createdAt: now,
    status: "published",
    changes: changesByGame.get(game) ?? [],
    affectedResourceIds: [...(affectedByGame.get(game) ?? new Set<string>())],
    publishedRenditions: [...(publishedByGame.get(game)?.values() ?? [])],
    notes: ["Full Legacy Migration generated from a validated MigrationPlan.", "Preview thumbnails are one set per Resource/Variant and are not download renditions."],
  }));
  const releaseManifestIds = releaseManifests.map((manifest) => manifest.id);
  const nextCatalog = Catalog.parse({
    ...catalog,
    generatedAt: now,
    resources,
    variants,
    renditions,
    objects: [...objects.values()].map((prepared) => prepared.object),
    releaseManifestIds: [...new Set([...catalog.releaseManifestIds, ...releaseManifestIds])],
  });
  const catalogValidation = validateCatalog(nextCatalog);
  if (!catalogValidation.success) throw new Error("Generated Legacy Catalog failed validation.");
  for (const manifest of releaseManifests) {
    const consistency = validateReleaseManifestConsistency(manifest, nextCatalog);
    if (!consistency.success) throw new Error("Generated Legacy ReleaseManifest failed consistency validation.");
  }
  const objectsToProcess = [...migrationObjectIds].map((id) => objects.get(id)).filter((prepared): prepared is PreparedObject => Boolean(prepared?.localPath));
  return { catalog: catalogValidation.data, releaseManifests, objects: objectsToProcess, previewRoot, catalogPath, releasesDirectory, reportPath };
}

async function writeReport(reportPath: string, report: LegacyMigrationReport): Promise<void> {
  await atomicWriteJson(reportPath, report);
}

export async function executeLegacyMigration(options: LegacyMigrationOptions): Promise<LegacyMigrationResult> {
  if (options.storage.status !== "READY") throw new Error("ROS credentials are not configured.");
  const validation = validateLegacyMigrationPlan(options.plan);
  if (!validation.valid) throw new Error(`MigrationPlan validation failed: ${validation.issues.join("; ")}`);
  if (options.plan.stats.blockingIssueCount > 0) throw new Error("MigrationPlan contains blocking issues.");
  const now = iso(options.now);
  const prepared = await prepareMigration(options, now);
  const plannedObjectBytes = prepared.objects.reduce((sum, preparedObject) => sum + preparedObject.object.sizeBytes, 0);
  let report: LegacyMigrationReport = {
    schemaVersion: "1.0",
    status: "running",
    sourceSnapshot: options.plan.sourceSnapshot,
    startedAt: now,
    plannedObjectCount: prepared.objects.length,
    plannedObjectBytes,
    uploadedObjectCount: 0,
    skippedObjectCount: 0,
    failedUploadCount: 0,
    uploadedBytes: 0,
    resourceCount: prepared.catalog.resources.length,
    objectCount: prepared.catalog.objects.length,
    catalogPath: prepared.catalogPath,
    releaseManifestPaths: prepared.releaseManifests.map((manifest) => path.join(prepared.releasesDirectory, `${manifest.id}.json`)),
  };
  await writeReport(prepared.reportPath, report);
  const persistProgress = async () => writeReport(prepared.reportPath, report);
  try {
    for (let index = 0; index < prepared.objects.length; index += 1) {
      const preparedObject = prepared.objects[index]!;
      const object = preparedObject.object;
      const localPath = preparedObject.localPath!;
      options.onProgress?.({ stage: "check", completed: index, total: prepared.objects.length, message: `检查 ${index + 1} / ${prepared.objects.length}` });
      let existing;
      try {
        existing = await options.storage.verifyObject(object.objectKey, { sizeBytes: object.sizeBytes });
      } catch {
        report.failedUploadCount += 1;
        await persistProgress();
        throw new Error("ROS Object check failed.");
      }
      if (existing.exists) {
        if (!existing.verified) {
          report.failedUploadCount += 1;
          await persistProgress();
          throw new Error("An existing ROS Object failed size verification.");
        }
        report.skippedObjectCount += 1;
        options.onProgress?.({ stage: "check", completed: index + 1, total: prepared.objects.length, message: `跳过已存在对象 ${index + 1} / ${prepared.objects.length}` });
      } else {
        options.onProgress?.({ stage: "upload", completed: index, total: prepared.objects.length, message: `上传 ${index + 1} / ${prepared.objects.length}` });
        try {
          const body = createReadStream(localPath);
          try {
            await options.storage.putObject({ objectKey: object.objectKey, body, sizeBytes: object.sizeBytes, contentType: object.mime, cacheControl: IMMUTABLE_OBJECT_CACHE_CONTROL });
          } finally {
            body.destroy();
          }
          report.uploadedObjectCount += 1;
          report.uploadedBytes += object.sizeBytes;
        } catch {
          report.failedUploadCount += 1;
          await persistProgress();
          throw new Error("ROS Object upload failed.");
        }
        options.onProgress?.({ stage: "verify", completed: index + 1, total: prepared.objects.length, message: "验证" });
        const verification = await options.storage.verifyObject(object.objectKey, { sizeBytes: object.sizeBytes }).catch(() => undefined);
        if (!verification?.verified) {
          report.failedUploadCount += 1;
          await persistProgress();
          throw new Error("Uploaded ROS Object failed HEAD verification.");
        }
      }
      if ((index + 1) % 25 === 0 || index + 1 === prepared.objects.length) await persistProgress();
    }
    options.onProgress?.({ stage: "catalog", completed: 0, total: 1, message: "提交 Catalog" });
    const commit = await writeCatalogAndReleasesAtomic(prepared.catalog, prepared.releaseManifests, { catalogPath: prepared.catalogPath, releasesDirectory: prepared.releasesDirectory });
    report = { ...report, status: "completed", completedAt: iso(options.now), releaseManifestPaths: commit.releaseManifestPaths };
    await writeReport(prepared.reportPath, report);
    await rm(prepared.previewRoot, { recursive: true, force: true }).catch(() => undefined);
    options.onProgress?.({ stage: "catalog", completed: 1, total: 1, message: "更新 Catalog" });
    options.onProgress?.({ stage: "complete", completed: 1, total: 1, message: "完成" });
    return { status: "published", catalog: prepared.catalog, releaseManifests: prepared.releaseManifests, uploadedObjectCount: report.uploadedObjectCount, skippedObjectCount: report.skippedObjectCount, failedUploadCount: report.failedUploadCount, uploadedBytes: report.uploadedBytes, catalogPath: commit.catalogPath, releaseManifestPaths: commit.releaseManifestPaths, reportPath: prepared.reportPath };
  } catch (error) {
    report = { ...report, status: "failed", completedAt: iso(options.now), failureCode: reportFailureCode(error) };
    await writeReport(prepared.reportPath, report);
    throw error;
  }
}

async function readMigrationReport(reportPath: string): Promise<LegacyMigrationReport | undefined> {
  try {
    return JSON.parse(await readFile(reportPath, "utf8")) as LegacyMigrationReport;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

export async function checkLegacyMigrationConsistency(options: { storage: StorageClient; catalogPath?: string; reportPath?: string; runtimeRoot?: string }): Promise<LegacyConsistencyResult> {
  const catalogPath = path.resolve(options.catalogPath ?? DEFAULT_CATALOG_PATH);
  const reportPath = path.resolve(options.reportPath ?? path.join(options.runtimeRoot ?? ".runtime", "legacy-migration", "latest.json"));
  const report = await readMigrationReport(reportPath);
  const counts = {
    failedUploadCount: report?.failedUploadCount ?? 0,
    uploadedObjectCount: report?.uploadedObjectCount ?? 0,
    skippedObjectCount: report?.skippedObjectCount ?? 0,
    uploadedBytes: report?.uploadedBytes ?? 0,
  };
  if (!report) return { status: "NOT_RUN", missingObjectCount: 0, headFailureCount: 0, ...counts, resourceCount: 0, objectCount: 0, catalogPath, reportPath };
  if (options.storage.status !== "READY") return { status: "NOT_CONFIGURED", missingObjectCount: 0, headFailureCount: 0, ...counts, resourceCount: report.resourceCount, objectCount: report.objectCount, catalogPath, reportPath };
  const catalog = await loadCatalogFile(catalogPath);
  let missingObjectCount = 0;
  let headFailureCount = 0;
  for (const object of catalog.objects) {
    try {
      const verification = await options.storage.verifyObject(object.objectKey, { sizeBytes: object.sizeBytes });
      if (!verification.exists || !verification.verified) missingObjectCount += 1;
    } catch {
      headFailureCount += 1;
    }
  }
  const status = report.status === "completed" && report.failedUploadCount === 0 && missingObjectCount === 0 && headFailureCount === 0 ? "PASS" : "FAIL";
  return { status, missingObjectCount, headFailureCount, ...counts, resourceCount: catalog.resources.length, objectCount: catalog.objects.length, catalogPath, reportPath };
}

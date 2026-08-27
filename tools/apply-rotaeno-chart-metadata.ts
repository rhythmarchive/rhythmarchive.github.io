import { readFile } from "node:fs/promises";
import path from "node:path";
import { Catalog, ReleaseManifest, Resource, type Catalog as CatalogType, type ReleaseManifest as ReleaseManifestType, type Resource as ResourceType } from "../packages/domain/src/schema.js";
import { loadCatalogFile, writeCatalogAndReleaseAtomic } from "../packages/domain/src/catalog.js";
import { createDeterministicUuidV7 } from "../packages/domain/src/identity.js";
import { buildReleaseDelta, type ReleaseDelta as ReleaseDeltaType, UnifiedAssetManifest, type UnifiedAssetManifest as UnifiedAssetManifestType } from "../packages/domain/src/release.js";
import { isReviewApproved, readReviewPackage, validateReviewPackageForDelta, type ReviewPackage } from "../packages/domain/src/review-package.js";
import { sanitizeRotaenoCharts, sanitizeRotaenoSpecialCharts } from "./rotaeno/chart-metadata.js";

type JsonObject = Record<string, unknown>;

const PUBLIC_METADATA_KEYS = new Set(["charts", "specialCharts", "length", "bpm", "pack", "updateVersion", "updateDate", "metadataStatus", "chartDataSource", "chartDataVersion"]);

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function stable(value: unknown): string {
  return JSON.stringify(value);
}

function requiredOption(name: string, fallback?: string): string {
  const index = process.argv.indexOf("--" + name);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  if (!value || value.startsWith("--")) throw new Error("--" + name + " is required");
  return value;
}

function hasFlag(name: string): boolean {
  return process.argv.includes("--" + name);
}

function sourceIdentity(resource: ResourceType): string | undefined {
  return resource.externalIdentities.find((identity) => identity.namespace === "rotaeno" && identity.key === "source-identity")?.value;
}

function publicMetadata(entry: UnifiedAssetManifestType["entries"][number]): Record<string, unknown> {
  const nested = object(object(entry.metadata).metadata);
  const metadata: Record<string, unknown> = {};
  for (const key of PUBLIC_METADATA_KEYS) {
    const value = nested[key];
    if (key === "charts") {
      const charts = sanitizeRotaenoCharts(value, "Rotaeno charts for " + entry.sourceIdentity);
      if (charts) metadata[key] = charts;
    } else if (key === "specialCharts") {
      const specialCharts = sanitizeRotaenoSpecialCharts(value, "Rotaeno special charts for " + entry.sourceIdentity);
      if (specialCharts) metadata[key] = specialCharts;
    } else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      metadata[key] = value;
    }
  }
  return metadata;
}

function ensureMetadataOnlyDelta(previous: UnifiedAssetManifestType, current: UnifiedAssetManifestType, delta: ReleaseDeltaType): void {
  const recalculated = buildReleaseDelta(previous, current, { generatedAt: delta.generatedAt });
  if (stable(recalculated.entries) !== stable(delta.entries) || stable(recalculated.summary) !== stable(delta.summary)) {
    throw new Error("supplied Delta does not match the supplied manifests");
  }
  if (delta.gameId !== "rotaeno" || current.gameId !== "rotaeno" || previous.gameId !== "rotaeno") throw new Error("all manifests must be for Rotaeno");
  if (delta.summary.new !== 0 || delta.summary.removed !== 0 || delta.summary.changed === 0) throw new Error("Rotaeno chart correction must contain changed existing resources only");
  for (const entry of delta.entries) {
    if (entry.status !== "CHANGED") continue;
    if (!entry.current || !entry.previous) throw new Error("changed Delta entry is missing one manifest side: " + entry.identityKey);
    if (entry.needsRename || entry.reasons.some((reason) => reason.includes("file") || reason.includes("object key"))) {
      throw new Error("Rotaeno chart correction Delta contains a file or identity change: " + entry.identityKey);
    }
    if (entry.current.sourceIdentity !== entry.previous.sourceIdentity || entry.current.assetType !== entry.previous.assetType || entry.current.variantKey !== entry.previous.variantKey) {
      throw new Error("Rotaeno chart correction changed resource identity: " + entry.identityKey);
    }
    if (stable(entry.current.file) !== stable(entry.previous.file) || entry.current.sourcePath !== entry.previous.sourcePath) {
      throw new Error("Rotaeno chart correction changed a file field: " + entry.identityKey);
    }
  }
}

function approvedReview(review: ReviewPackage, delta: ReleaseDeltaType): void {
  const validation = validateReviewPackageForDelta(review, delta);
  if (!validation.valid) throw new Error("approved review does not match Delta: " + validation.reasons.join("; "));
  if (!isReviewApproved(review)) throw new Error("Rotaeno chart correction requires an approved review package");
}

function updateResource(resource: ResourceType, entry: UnifiedAssetManifestType["entries"][number], updatedAt: string): ResourceType {
  return Resource.parse({
    ...resource,
    ...(entry.title ? { title: entry.title } : {}),
    metadata: { ...resource.metadata, ...publicMetadata(entry) },
    lifecycle: { ...resource.lifecycle, updatedAt },
  });
}

function buildRelease(catalog: CatalogType, delta: ReleaseDeltaType, current: UnifiedAssetManifestType, now: string): ReleaseManifestType {
  const resourceByIdentity = new Map<string, ResourceType>();
  for (const resource of catalog.resources.filter((item) => item.game === "rotaeno")) {
    const identity = sourceIdentity(resource);
    if (!identity) continue;
    if (resourceByIdentity.has(identity)) throw new Error("duplicate Rotaeno source identity in Catalog: " + identity);
    resourceByIdentity.set(identity, resource);
  }
  const changes: ReleaseManifestType["changes"] = [];
  const affectedResourceIds: string[] = [];
  for (const deltaEntry of delta.entries.filter((entry) => entry.status === "CHANGED")) {
    const entry = deltaEntry.current;
    if (!entry) throw new Error("changed Delta entry is missing current manifest data: " + deltaEntry.identityKey);
    const resource = resourceByIdentity.get(entry.sourceIdentity);
    if (!resource) throw new Error("Rotaeno source identity is not present in Catalog: " + entry.sourceIdentity);
    affectedResourceIds.push(resource.id);
    changes.push({
      changeType: "metadata-changed",
      resourceId: resource.id,
      detail: "Approved Rotaeno song and chart metadata; files and object identities preserved.",
    });
  }
  const releaseId = createDeterministicUuidV7("rotaeno:release:" + current.version);
  return ReleaseManifest.parse({
    schemaVersion: "1.0",
    releaseSchemaVersion: "1.0",
    id: releaseId,
    updateBatchId: createDeterministicUuidV7("rotaeno:update-batch:" + current.version),
    game: "rotaeno",
    baseVersion: delta.previousVersion,
    targetVersion: current.version,
    createdAt: now,
    status: "published",
    changes,
    affectedResourceIds: [...new Set(affectedResourceIds)],
    publishedRenditions: [],
    removedFromCurrentSource: [],
    notes: [
      "Local-only Rotaeno song and chart metadata correction.",
      "difficulty and level were read from StandardChartDataSO.levelId/name and v2InnerDifficulty in the APK-local Journey map bundles.",
      "No canonical files, object keys, renditions, aliases, source identities, remote storage, or production publication were changed.",
    ],
  });
}

async function main(): Promise<void> {
  const manifestPath = requiredOption("manifest");
  const previousPath = requiredOption("previous");
  const deltaPath = requiredOption("delta");
  const reviewPath = requiredOption("review");
  const catalogPath = requiredOption("catalog", "catalog/index.json");
  const current = UnifiedAssetManifest.parse(JSON.parse(await readFile(path.resolve(manifestPath), "utf8")) as unknown);
  const previous = UnifiedAssetManifest.parse(JSON.parse(await readFile(path.resolve(previousPath), "utf8")) as unknown);
  const delta = JSON.parse(await readFile(path.resolve(deltaPath), "utf8")) as unknown as ReleaseDeltaType;
  const review = await readReviewPackage(path.resolve(reviewPath));
  ensureMetadataOnlyDelta(previous, current, delta);
  approvedReview(review, delta);
  if (review.gameId !== "rotaeno" || review.version !== current.version) throw new Error("review and candidate versions do not match");

  const catalog = await loadCatalogFile(path.resolve(catalogPath));
  const resourceByIdentity = new Map<string, ResourceType>();
  for (const resource of catalog.resources.filter((item) => item.game === "rotaeno")) {
    const identity = sourceIdentity(resource);
    if (!identity) continue;
    if (resourceByIdentity.has(identity)) throw new Error("duplicate Rotaeno source identity in Catalog: " + identity);
    resourceByIdentity.set(identity, resource);
  }
  const changedEntries = delta.entries.filter((entry) => entry.status === "CHANGED").map((entry) => entry.current).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  const now = new Date().toISOString();
  const updatedResources = new Map(catalog.resources.map((resource) => [resource.id, resource]));
  for (const entry of changedEntries) {
    const resource = resourceByIdentity.get(entry.sourceIdentity);
    if (!resource) throw new Error("Rotaeno source identity is not present in Catalog: " + entry.sourceIdentity);
    updatedResources.set(resource.id, updateResource(resource, entry, now));
  }
  const release = buildRelease(catalog, delta, current, now);
  const updatedCatalog = Catalog.parse({
    ...catalog,
    generatedAt: now,
    resources: [...updatedResources.values()],
    releaseManifestIds: [...new Set([...catalog.releaseManifestIds, release.id])],
  });
  const report = {
    status: hasFlag("apply") ? "APPLIED_LOCAL_ONLY" : "READY_LOCAL_ONLY",
    remoteWrite: "DISABLED",
    resourceCount: changedEntries.length,
    chartCount: changedEntries.reduce((count, entry) => { const charts = object(object(entry.metadata).metadata).charts; return count + (Array.isArray(charts) ? charts.length : 0); }, 0),
    fileChanges: 0,
    objectChanges: 0,
    releaseId: release.id,
    catalogPath: path.resolve(catalogPath),
    reviewStatus: review.status,
    reviewer: review.reviewer,
  };
  if (hasFlag("apply")) await writeCatalogAndReleaseAtomic(updatedCatalog, release, { catalogPath: path.resolve(catalogPath) });
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ status: "ERROR", message: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});

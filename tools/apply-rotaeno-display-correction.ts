import { readFile } from "node:fs/promises";
import path from "node:path";
import { createDeterministicUuidV7 } from "../packages/domain/src/identity.js";
import { loadCatalogFile, writeCatalogAndReleaseAtomic } from "../packages/domain/src/catalog.js";
import { ReleaseManifest, Resource, type Catalog as CatalogType, type ReleaseManifest as ReleaseManifestType, type Resource as ResourceType } from "../packages/domain/src/schema.js";
import { buildReleaseDelta, UnifiedAssetManifest, type UnifiedAssetManifest as UnifiedAssetManifestType, type ReleaseDelta as ReleaseDeltaType } from "../packages/domain/src/release.js";
import { isReviewApproved, readReviewPackage, validateReviewPackageForDelta, type ReviewPackage } from "../packages/domain/src/review-package.js";
import { sanitizeRotaenoCharts } from "./rotaeno/chart-metadata.js";

type JsonObject = Record<string, unknown>;

const PUBLIC_METADATA_KEYS = new Set([
  "artist",
  "illustrator",
  "pack",
  "packName",
  "packDisplayName",
  "characterName",
  "characterVariant",
  "gameVersion",
  "songId",
  "event",
  "collaboration",
  "collaborationPartner",
  "displayMetadataSource",
  "displayMetadataStatus",
  "charts",
]);

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
    } else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") metadata[key] = value;
  }
  if (entry.artist) metadata.artist = entry.artist;
  return metadata;
}

function ensureMetadataOnlyDelta(previous: UnifiedAssetManifestType, current: UnifiedAssetManifestType, delta: ReleaseDeltaType): void {
  const recalculated = buildReleaseDelta(previous, current, { generatedAt: delta.generatedAt });
  if (stable(recalculated.entries) !== stable(delta.entries) || stable(recalculated.summary) !== stable(delta.summary)) {
    throw new Error("supplied Delta does not match the supplied manifests");
  }
  if (delta.gameId !== "rotaeno" || current.gameId !== "rotaeno" || previous.gameId !== "rotaeno") throw new Error("all manifests must be for Rotaeno");
  if (delta.summary.new !== 0 || delta.summary.removed !== 0 || delta.summary.changed !== current.entries.length) throw new Error("Rotaeno correction must contain only changed existing resources");
  for (const entry of delta.entries) {
    if (entry.status !== "CHANGED" || entry.needsRename || entry.reasons.some((reason) => reason.includes("file") || reason.includes("object key"))) {
      throw new Error("Rotaeno correction Delta contains a non-metadata change: " + entry.identityKey);
    }
    if (!entry.current || !entry.previous) throw new Error("changed Delta entry is missing one manifest side: " + entry.identityKey);
    if (entry.current.sourceIdentity !== entry.previous.sourceIdentity || entry.current.assetType !== entry.previous.assetType || entry.current.variantKey !== entry.previous.variantKey) {
      throw new Error("Rotaeno correction changed a resource identity: " + entry.identityKey);
    }
    if (stable(entry.current.aliases) !== stable(entry.previous.aliases) || stable(entry.current.file) !== stable(entry.previous.file) || entry.current.sourcePath !== entry.previous.sourcePath) {
      throw new Error("Rotaeno correction changed a file, alias, or source path: " + entry.identityKey);
    }
  }
}

function approvedReview(review: ReviewPackage, delta: ReleaseDeltaType): void {
  const validation = validateReviewPackageForDelta(review, delta);
  if (!validation.valid) throw new Error("approved review does not match Delta: " + validation.reasons.join("; "));
  if (!isReviewApproved(review)) throw new Error("Rotaeno correction requires an approved review package");
}

function updateResource(resource: ResourceType, entry: UnifiedAssetManifestType["entries"][number], updatedAt: string): ResourceType {
  const metadata = { ...resource.metadata, ...publicMetadata(entry) };
  return Resource.parse({
    ...resource,
    title: entry.title,
    metadata,
    lifecycle: { ...resource.lifecycle, updatedAt },
  });
}

function buildRelease(catalog: CatalogType, previous: UnifiedAssetManifestType, current: UnifiedAssetManifestType, now: string): ReleaseManifestType {
  const resourceByIdentity = new Map<string, ResourceType>();
  for (const resource of catalog.resources.filter((item) => item.game === "rotaeno")) {
    const identity = sourceIdentity(resource);
    if (!identity) continue;
    if (resourceByIdentity.has(identity)) throw new Error("duplicate Rotaeno source identity in Catalog: " + identity);
    resourceByIdentity.set(identity, resource);
  }
  const changes: ReleaseManifestType["changes"] = [];
  const affectedResourceIds: string[] = [];
  for (const entry of current.entries) {
    const resource = resourceByIdentity.get(entry.sourceIdentity);
    if (!resource) throw new Error("Rotaeno source identity is not present in Catalog: " + entry.sourceIdentity);
    affectedResourceIds.push(resource.id);
    changes.push({
      changeType: "metadata-changed",
      resourceId: resource.id,
      detail: "Approved Rotaeno public display metadata correction; files and object identities preserved.",
    });
  }
  const releaseId = createDeterministicUuidV7("rotaeno:release:" + current.version);
  return ReleaseManifest.parse({
    schemaVersion: "1.0",
    releaseSchemaVersion: "1.0",
    id: releaseId,
    updateBatchId: createDeterministicUuidV7("rotaeno:update-batch:" + current.version),
    game: "rotaeno",
    baseVersion: previous.version,
    targetVersion: current.version,
    createdAt: now,
    status: "published",
    changes,
    affectedResourceIds,
    publishedRenditions: [],
    removedFromCurrentSource: [],
    notes: [
      "Local-only Rotaeno display metadata correction.",
      "Titles, composer names, illustrator names, pack names, character names, startup labels, and story labels were reviewed from the committed curation source.",
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
  const now = new Date().toISOString();
  const updatedResources = new Map(catalog.resources.map((resource) => [resource.id, resource]));
  for (const entry of current.entries) {
    const resource = resourceByIdentity.get(entry.sourceIdentity);
    if (!resource) throw new Error("Rotaeno source identity is not present in Catalog: " + entry.sourceIdentity);
    updatedResources.set(resource.id, updateResource(resource, entry, now));
  }
  const updatedCatalog = {
    ...catalog,
    generatedAt: now,
    resources: [...updatedResources.values()],
    releaseManifestIds: [...new Set([...catalog.releaseManifestIds, createDeterministicUuidV7("rotaeno:release:" + current.version)])],
  };
  const release = buildRelease(updatedCatalog, previous, current, now);
  const parsedCatalog = (await import("../packages/domain/src/schema.js")).Catalog.parse(updatedCatalog);
  const report = {
    status: hasFlag("apply") ? "APPLIED_LOCAL_ONLY" : "READY_LOCAL_ONLY",
    remoteWrite: "DISABLED",
    resourceCount: current.entries.length,
    changedResourceCount: current.entries.length,
    fileChanges: 0,
    objectChanges: 0,
    releaseId: release.id,
    catalogPath: path.resolve(catalogPath),
    reviewStatus: review.status,
    reviewer: review.reviewer,
  };
  if (hasFlag("apply")) {
    await writeCatalogAndReleaseAtomic(parsedCatalog, release);
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ status: "ERROR", message: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});

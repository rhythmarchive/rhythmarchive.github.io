import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createDeterministicUuidV7 } from "../packages/domain/src/identity.js";
import { loadCatalogFile, writeCatalogAndReleaseAtomic, writeCatalogAtomic } from "../packages/domain/src/catalog.js";
import { Catalog, ReleaseManifest, Resource, type Catalog as CatalogType } from "../packages/domain/src/schema.js";
import { validateReleaseManifestConsistency } from "../packages/domain/src/validation.js";

const GAME = "arcaea" as const;
const VERSION = "7.0.0c";
const SOURCE_PREFIX = "Arcaea/current-apk/app-data/story/vn/res/";
const IMAGE_EXTENSIONS = /\.(?:jpg|jpeg|png|webp)$/iu;
const DEFAULT_REPORT = "temp/rhythmctl/arcaea/7.0.0c/story-vn-cg-promotion.json";
const RULE_NOTE = "User-approved scope: every image below app-data/story/vn/res/<subdirectory>/ is a public VN CG; root-level VN textures remain excluded.";

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

function sourceAssetPath(resource: Resource): string | undefined {
  const candidates = [
    typeof resource.metadata.sourceRelativePath === "string" ? resource.metadata.sourceRelativePath : undefined,
    ...resource.provenance.map((item) => item.sourceRelativePath),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = candidate.replaceAll("\\", "/");
    const marker = normalized.indexOf(SOURCE_PREFIX);
    if (marker < 0) continue;
    const relative = normalized.slice(marker + SOURCE_PREFIX.length);
    if (relative.includes("/") && IMAGE_EXTENSIONS.test(relative)) return `assets/app-data/story/vn/res/${relative}`;
  }
  return undefined;
}

function assertExistingRenditions(catalog: CatalogType, resource: Resource): void {
  const variants = catalog.variants.filter((variant) => variant.resourceId === resource.id);
  const variantIds = new Set(variants.map((variant) => variant.id));
  const renditions = catalog.renditions.filter((rendition) => variantIds.has(rendition.variantId));
  const publishableOriginal = renditions.find((rendition) => rendition.renditionType === "original" && rendition.publishable);
  if (!publishableOriginal) throw new Error(`Missing publishable original rendition for ${resource.id}`);
  for (const renditionType of ["thumbnail-320", "thumbnail-640", "thumbnail-1280"] as const) {
    if (!renditions.some((rendition) => rendition.renditionType === renditionType && catalog.objects.some((object) => object.id === rendition.objectId))) {
      throw new Error(`Missing ${renditionType} object for ${resource.id}`);
    }
  }
}

function updateResource(resource: Resource, updatedAt: string): Resource {
  const provenance = resource.provenance.map((item) => ({
    ...item,
    evidence: item.evidence.some((evidence) => evidence.detail === RULE_NOTE)
      ? item.evidence
      : [...item.evidence, { kind: "manual-note" as const, detail: RULE_NOTE, confidence: "high" as const }],
    reviewerNote: item.reviewerNote ?? "User-approved VN subdirectory CG publication scope.",
  }));
  const isCurrentVersionResource = resource.provenance.some((item) => item.gameVersion === VERSION);
  return Resource.parse({
    ...resource,
    metadata: { ...resource.metadata, storyVisualKind: "vn-cg" },
    provenance,
    lifecycle: isCurrentVersionResource ? { ...resource.lifecycle, updatedAt } : resource.lifecycle,
  });
}

function loadBaselineCatalog(catalogPath: string): CatalogType {
  const relativePath = path.relative(process.cwd(), catalogPath).replaceAll("\\", "/");
  if (!relativePath || relativePath.startsWith("../") || path.isAbsolute(relativePath)) {
    throw new Error("Cannot resolve a repository-relative baseline for " + catalogPath);
  }
  const result = spawnSync("git", ["show", "HEAD:" + relativePath], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    throw new Error("Could not read Git baseline catalog: " + (result.stderr || "git show failed"));
  }
  return Catalog.parse(JSON.parse(result.stdout));
}

async function main(): Promise<void> {
  const catalogPath = path.resolve(option("--catalog", "catalog/index.json"));
  const reportPath = path.resolve(option("--report", DEFAULT_REPORT));
  const catalog = await loadCatalogFile(catalogPath);
  const targets = catalog.resources
    .filter((resource) => resource.game === GAME && resource.resourceType === "story-texture" && resource.lifecycle.status === "published" && Boolean(sourceAssetPath(resource)))
    .sort((left, right) => (sourceAssetPath(left) ?? left.id).localeCompare(sourceAssetPath(right) ?? right.id, "en"));
  if (targets.length !== 171) throw new Error(`Expected 171 nested VN image resources, found ${targets.length}`);
  for (const resource of targets) assertExistingRenditions(catalog, resource);
  if (hasFlag("--repair-historical-lifecycle")) {
    const baseline = loadBaselineCatalog(catalogPath);
    const baselineById = new Map(baseline.resources.map((resource) => [resource.id, resource]));
    const targetIds = new Set(targets.map((resource) => resource.id));
    let repairedCount = 0;
    const repairedResources = catalog.resources.map((resource) => {
      if (!targetIds.has(resource.id) || resource.provenance.some((item) => item.gameVersion === VERSION)) return resource;
      const original = baselineById.get(resource.id);
      if (!original || original.lifecycle.updatedAt === resource.lifecycle.updatedAt) return resource;
      repairedCount += 1;
      return Resource.parse({ ...resource, lifecycle: original.lifecycle });
    });
    const nextCatalog = Catalog.parse({ ...catalog, resources: repairedResources });
    const report = {
      status: hasFlag("--apply") ? "REPAIRED_LOCAL_ONLY" : "READY_REPAIR_LOCAL_ONLY",
      remoteWrite: "DISABLED",
      catalogPath,
      reportPath,
      version: VERSION,
      rule: "Restore lifecycle timestamps for promoted VN CG resources whose provenance is historical-only.",
      targetCount: targets.length,
      repairedCount,
      releaseId: null,
      preservedObjectAndRenditionCount: targets.length,
    };
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
    if (hasFlag("--apply")) await writeCatalogAtomic(nextCatalog, catalogPath);
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const changed = targets.filter((resource) => resource.metadata.storyVisualKind !== "vn-cg");
  const now = new Date().toISOString();
  const updatedById = new Map(catalog.resources.map((resource) => [resource.id, resource]));
  for (const resource of changed) updatedById.set(resource.id, updateResource(resource, now));
  const release = ReleaseManifest.parse({
    schemaVersion: "1.0",
    releaseSchemaVersion: "1.0",
    id: createDeterministicUuidV7(`arcaea:release:story-vn-cg:${VERSION}:${catalog.catalogId}`),
    updateBatchId: createDeterministicUuidV7(`arcaea:update-batch:story-vn-cg:${VERSION}:${catalog.catalogId}`),
    game: GAME,
    baseVersion: VERSION,
    targetVersion: VERSION,
    createdAt: now,
    status: "published",
    changes: changed.map((resource) => ({
      changeType: "metadata-changed" as const,
      resourceId: resource.id,
      detail: RULE_NOTE + " Existing Object IDs and Renditions preserved.",
    })),
    affectedResourceIds: changed.map((resource) => resource.id),
    publishedRenditions: [],
    removedFromCurrentSource: [],
    notes: [
      "Local-only Arcaea Story VN CG public-scope metadata correction.",
      RULE_NOTE,
      "The 34 root-level vn/res images remain hidden and are not part of this release.",
      "No canonical files, Object IDs, Renditions, remote keys, ROS writes, or deletions were performed.",
    ],
  });
  const nextCatalog = Catalog.parse({
    ...catalog,
    generatedAt: now,
    resources: [...updatedById.values()],
    releaseManifestIds: [...new Set([...catalog.releaseManifestIds, release.id])],
  });
  const consistency = validateReleaseManifestConsistency(release, nextCatalog);
  if (!consistency.success) throw new Error("ReleaseManifest consistency failed: " + consistency.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
  const report = {
    status: hasFlag("--apply") ? "APPLIED_LOCAL_ONLY" : "READY_LOCAL_ONLY",
    remoteWrite: "DISABLED",
    catalogPath,
    reportPath,
    version: VERSION,
    rule: RULE_NOTE,
    targetCount: targets.length,
    changedCount: changed.length,
    resourceIds: targets.map((resource) => resource.id),
    releaseId: release.id,
    preservedObjectAndRenditionCount: targets.length,
  };
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (hasFlag("--apply")) {
    await writeCatalogAndReleaseAtomic(nextCatalog, release, { catalogPath });
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ status: "ERROR", message: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});

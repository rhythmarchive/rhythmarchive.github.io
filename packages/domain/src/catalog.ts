import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Catalog, ReleaseManifest, type Catalog as CatalogType, type ReleaseManifest as ReleaseManifestType } from "./schema.js";
import { createUuidV7 } from "./identity.js";
import { validateCatalog, validateReleaseManifestConsistency } from "./validation.js";
import { browseProjectionJsonFiles, validateBrowseProjectionSet, type BrowseProjectionBuildResult } from "./browse.js";

export const DEFAULT_CATALOG_PATH = path.resolve("catalog", "index.json");
export const DEFAULT_CATALOG_RELEASES_PATH = path.resolve("catalog", "releases");

export function createEmptyCatalog(now = new Date().toISOString()): CatalogType {
  return Catalog.parse({
    catalogSchemaVersion: "1.0",
    catalogId: createUuidV7(),
    generatedAt: now,
    resources: [],
    variants: [],
    renditions: [],
    objects: [],
    releaseManifestIds: [],
  });
}

export async function loadCatalogFile(catalogPath = DEFAULT_CATALOG_PATH): Promise<CatalogType> {
  try {
    const parsed: unknown = JSON.parse(await readFile(catalogPath, "utf8"));
    const validation = validateCatalog(parsed);
    if (!validation.success) throw new Error(validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    return validation.data;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return createEmptyCatalog();
    throw new Error("Catalog could not be read or validated.");
  }
}

export async function writeCatalogAtomic(catalog: CatalogType, catalogPath = DEFAULT_CATALOG_PATH): Promise<void> {
  const validation = validateCatalog(catalog);
  if (!validation.success) throw new Error("Catalog cannot be written because validation failed.");
  await atomicWriteJson(catalogPath, validation.data);
}

export async function writeReleaseManifestAtomic(manifest: ReleaseManifestType, releasesDirectory = DEFAULT_CATALOG_RELEASES_PATH): Promise<string> {
  const targetPath = path.join(releasesDirectory, `${manifest.id}.json`);
  await atomicWriteJson(targetPath, manifest);
  return targetPath;
}

export async function atomicWriteJson(targetPath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.partial-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export type CatalogReleaseCommitResult = {
  catalogPath: string;
  releaseManifestPath: string;
};

export type CatalogReleasesCommitResult = {
  catalogPath: string;
  releaseManifestPaths: string[];
};

async function moveIfPresent(sourcePath: string, targetPath: string): Promise<boolean> {
  try {
    await rename(sourcePath, targetPath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Stage and commit one Catalog plus one or more ReleaseManifests. All release
 * files are renamed before the Catalog, and a caught failure restores every
 * old file. This keeps the small mixed-game Legacy migration commit atomic
 * without introducing a transaction system.
 */
export async function writeCatalogAndReleasesAtomic(
  catalog: CatalogType,
  manifests: ReleaseManifestType[],
  options: { catalogPath?: string; releasesDirectory?: string } = {},
): Promise<CatalogReleasesCommitResult> {
  if (manifests.length === 0) throw new Error("At least one ReleaseManifest is required.");
  const catalogValidation = validateCatalog(catalog);
  if (!catalogValidation.success) throw new Error("Catalog cannot be written because validation failed.");
  const manifestValidations = manifests.map((manifest) => validateReleaseManifestConsistency(manifest, catalogValidation.data));
  if (manifestValidations.some((validation) => !validation.success)) throw new Error("ReleaseManifest cannot be written because it does not match the Catalog.");

  const catalogPath = options.catalogPath ?? DEFAULT_CATALOG_PATH;
  const releaseDirectory = options.releasesDirectory ?? DEFAULT_CATALOG_RELEASES_PATH;
  const releaseManifestPaths = manifests.map((manifest) => path.join(releaseDirectory, `${manifest.id}.json`));
  await mkdir(path.dirname(catalogPath), { recursive: true });
  await mkdir(releaseDirectory, { recursive: true });

  const token = `${process.pid}-${randomUUID()}`;
  const catalogTemporaryPath = `${catalogPath}.partial-${token}`;
  const catalogBackupPath = `${catalogPath}.backup-${token}`;
  const releaseFiles = releaseManifestPaths.map((targetPath) => ({
    targetPath,
    temporaryPath: `${targetPath}.partial-${token}`,
    backupPath: `${targetPath}.backup-${token}`,
    backedUp: false,
    committed: false,
  }));
  let catalogBackedUp = false;
  let catalogCommitted = false;

  try {
    await writeFile(catalogTemporaryPath, `${JSON.stringify(catalogValidation.data, null, 2)}\n`, "utf8");
    for (const [index, releaseFile] of releaseFiles.entries()) {
      await writeFile(releaseFile.temporaryPath, `${JSON.stringify(ReleaseManifest.parse(manifests[index]!), null, 2)}\n`, "utf8");
    }
    catalogBackedUp = await moveIfPresent(catalogPath, catalogBackupPath);
    for (const releaseFile of releaseFiles) releaseFile.backedUp = await moveIfPresent(releaseFile.targetPath, releaseFile.backupPath);
    for (const releaseFile of releaseFiles) {
      await rename(releaseFile.temporaryPath, releaseFile.targetPath);
      releaseFile.committed = true;
    }
    await rename(catalogTemporaryPath, catalogPath);
    catalogCommitted = true;
  } catch (error) {
    if (catalogCommitted) await rm(catalogPath, { force: true }).catch(() => undefined);
    if (catalogBackedUp) await rename(catalogBackupPath, catalogPath).catch(() => undefined);
    for (const releaseFile of [...releaseFiles].reverse()) {
      if (releaseFile.committed) await rm(releaseFile.targetPath, { force: true }).catch(() => undefined);
      if (releaseFile.backedUp) await rename(releaseFile.backupPath, releaseFile.targetPath).catch(() => undefined);
    }
    await rm(catalogTemporaryPath, { force: true }).catch(() => undefined);
    for (const releaseFile of releaseFiles) {
      await rm(releaseFile.temporaryPath, { force: true }).catch(() => undefined);
      await rm(releaseFile.backupPath, { force: true }).catch(() => undefined);
    }
    throw error;
  }

  await rm(catalogBackupPath, { force: true }).catch(() => undefined);
  for (const releaseFile of releaseFiles) await rm(releaseFile.backupPath, { force: true }).catch(() => undefined);
  return { catalogPath, releaseManifestPaths };
}

export async function writeCatalogAndReleaseAtomic(
  catalog: CatalogType,
  manifest: ReleaseManifestType,
  options: { catalogPath?: string; releasesDirectory?: string } = {},
): Promise<CatalogReleaseCommitResult> {
  const result = await writeCatalogAndReleasesAtomic(catalog, [manifest], options);
  return { catalogPath: result.catalogPath, releaseManifestPath: result.releaseManifestPaths[0]! };
}

export type CatalogReleaseBrowseCommitResult = {
  catalogPath: string;
  releaseManifestPath: string;
  browsePaths: string[];
};

/**
 * Stage Catalog, its ReleaseManifest, and a Browse Projection together. The
 * Browse manifest is checked against the candidate Catalog before any target
 * is moved, and rollback restores every previous target if a later rename
 * fails. This is the Phase 6 publication boundary; callers may still choose
 * the Catalog-only writer for older workflows.
 */
export async function writeCatalogAndReleaseAndBrowseAtomic(
  catalog: CatalogType,
  manifest: ReleaseManifestType,
  browse: BrowseProjectionBuildResult,
  options: { catalogPath?: string; releasesDirectory?: string; browseDirectory?: string } = {},
): Promise<CatalogReleaseBrowseCommitResult> {
  const catalogValidation = validateCatalog(catalog);
  if (!catalogValidation.success) throw new Error("Catalog cannot be written because validation failed.");
  const manifestValidation = validateReleaseManifestConsistency(manifest, catalogValidation.data);
  if (!manifestValidation.success) throw new Error("ReleaseManifest cannot be written because it does not match the Catalog.");
  const browseValidation = validateBrowseProjectionSet(browse, catalogValidation.data);
  if (!browseValidation.success) throw new Error(`Browse Projection cannot be written: ${browseValidation.issues.join("; ")}`);

  const catalogPath = options.catalogPath ?? DEFAULT_CATALOG_PATH;
  const releaseManifestPath = path.join(options.releasesDirectory ?? DEFAULT_CATALOG_RELEASES_PATH, `${manifest.id}.json`);
  const browseDirectory = options.browseDirectory ?? path.resolve("catalog", "browse");
  const browseFiles = browseProjectionJsonFiles(browse).map(({ filename, value }) => ({
    targetPath: path.join(browseDirectory, filename),
    value,
  }));
  const targets = [catalogPath, releaseManifestPath, ...browseFiles.map((file) => file.targetPath)].map((targetPath) => path.resolve(targetPath));
  if (new Set(targets).size !== targets.length) throw new Error("Catalog, ReleaseManifest, and Browse targets must be distinct.");

  const token = `${process.pid}-${randomUUID()}`;
  const files = [
    { targetPath: catalogPath, value: catalogValidation.data },
    { targetPath: releaseManifestPath, value: ReleaseManifest.parse(manifestValidation.data) },
    ...browseFiles,
  ].map((file) => ({
    ...file,
    temporaryPath: `${file.targetPath}.partial-${token}`,
    backupPath: `${file.targetPath}.backup-${token}`,
    backedUp: false,
    committed: false,
  }));

  await mkdir(path.dirname(catalogPath), { recursive: true });
  await mkdir(path.dirname(releaseManifestPath), { recursive: true });
  await mkdir(browseDirectory, { recursive: true });

  try {
    for (const file of files) await writeFile(file.temporaryPath, `${JSON.stringify(file.value, null, 2)}\n`, "utf8");
    for (const file of files) file.backedUp = await moveIfPresent(file.targetPath, file.backupPath);
    for (const file of files) {
      await rename(file.temporaryPath, file.targetPath);
      file.committed = true;
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const file of [...files].reverse()) {
      if (file.committed) {
        try { await rm(file.targetPath, { force: true }); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      if (file.backedUp) {
        try { await rename(file.backupPath, file.targetPath); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
    }
    for (const file of files) {
      try { await rm(file.temporaryPath, { force: true }); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      try { await rm(file.backupPath, { force: true }); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (rollbackErrors.length > 0) throw new AggregateError([error, ...rollbackErrors], "Catalog and Browse commit failed and rollback was incomplete.");
    throw error;
  }

  for (const file of files) await rm(file.backupPath, { force: true }).catch(() => undefined);
  return { catalogPath, releaseManifestPath, browsePaths: browseFiles.map((file) => file.targetPath) };
}

export function catalogObjectById(catalog: CatalogType, objectId: string) {
  return catalog.objects.find((object) => object.id === objectId);
}

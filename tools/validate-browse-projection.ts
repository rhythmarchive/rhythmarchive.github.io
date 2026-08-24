import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  ArcaeaBrowseProjection,
  ArcaeaCategoryBrowseProjection,
  BrowseDiagnostics,
  BrowseManifest,
  PhigrosCategoryBrowseProjection,
  PhigrosBrowseProjection,
  RizlineBrowseProjection,
  RizlineCategoryBrowseProjection,
  browseProjectionSha256,
  catalogSha256FromValue,
  loadCatalogFile,
  validateBrowsePublicData,
  validateCategoryBrowseProjection,
  validateRizlineBrowseProjection,
  validateBrowseProjectionSet,
  type BrowseProjectionBuildResult,
} from "../packages/domain/src/index.js";

function argument(argv: string[], name: string, fallback: string): string {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1]! : fallback;
}

async function json(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const catalogPath = path.resolve(argument(argv, "--catalog", "catalog/index.json"));
  const outputDirectory = path.resolve(argument(argv, "--output", "catalog/browse"));
  const catalog = await loadCatalogFile(catalogPath);
  const arcaea = ArcaeaBrowseProjection.parse(await json(path.join(outputDirectory, "arcaea.json")));
  const phigros = PhigrosBrowseProjection.parse(await json(path.join(outputDirectory, "phigros.json")));
  const arcaeaSemantics = ArcaeaCategoryBrowseProjection.parse(await json(path.join(outputDirectory, "arcaea-semantics.json")));
  const phigrosSemantics = PhigrosCategoryBrowseProjection.parse(await json(path.join(outputDirectory, "phigros-semantics.json")));
  const manifest = BrowseManifest.parse(await json(path.join(outputDirectory, "manifest.json")));
  const rizlineFile = manifest.files.rizline;
  const rizlineSemanticsFile = manifest.files.rizlineSemantics;
  const rizlineManifest = manifest.games.rizline;
  if (!rizlineFile || !rizlineSemanticsFile || !rizlineManifest) throw new Error("Browse manifest does not register Rizline projections.");
  const rizline = RizlineBrowseProjection.parse(await json(path.join(outputDirectory, rizlineFile)));
  const rizlineSemantics = RizlineCategoryBrowseProjection.parse(await json(path.join(outputDirectory, rizlineSemanticsFile)));
  const diagnostics = BrowseDiagnostics.parse(await json(path.join(outputDirectory, "diagnostics.json")));
  const result = { arcaea, phigros, manifest, diagnostics } satisfies BrowseProjectionBuildResult;
  const validation = validateBrowseProjectionSet(result, catalog);
  if (!validation.success) throw new Error(`Browse Projection validation failed: ${validation.issues.join("; ")}`);
  const arcaeaSemanticValidation = validateCategoryBrowseProjection(arcaeaSemantics, catalog);
  if (!arcaeaSemanticValidation.success) throw new Error(`Arcaea semantic Browse validation failed: ${arcaeaSemanticValidation.issues.join("; ")}`);
  const phigrosSemanticValidation = validateCategoryBrowseProjection(phigrosSemantics, catalog);
  if (!phigrosSemanticValidation.success) throw new Error(`Phigros semantic Browse validation failed: ${phigrosSemanticValidation.issues.join("; ")}`);
  const rizlineValidation = validateRizlineBrowseProjection(rizline, catalog);
  if (!rizlineValidation.success) throw new Error("Rizline Browse validation failed: " + rizlineValidation.issues.join("; "));
  const rizlineSemanticValidation = validateCategoryBrowseProjection(rizlineSemantics, catalog);
  if (!rizlineSemanticValidation.success) throw new Error("Rizline semantic Browse validation failed: " + rizlineSemanticValidation.issues.join("; "));
  if (rizlineManifest.fileSha256 !== browseProjectionSha256(rizline)) throw new Error("Browse manifest Rizline file hash does not match rizline.json.");
  if (rizlineManifest.sourceVersion !== rizline.source.version || rizlineManifest.sourceSha256 !== rizline.source.sha256) throw new Error("Browse manifest Rizline source metadata does not match rizline.json.");
  if (manifest.catalog.catalogSha256 !== catalogSha256FromValue(catalog)) throw new Error("Browse manifest Catalog hash does not match catalog/index.json.");
  const publicDataIssues = validateBrowsePublicData({ ...result, rizline });
  if (publicDataIssues.length > 0) throw new Error(`Browse JSON contains local/sensitive data: ${publicDataIssues.join("; ")}`);
  const semanticPublicDataIssues = validateBrowsePublicData({ arcaea: arcaeaSemantics, phigros: phigrosSemantics, rizline: rizlineSemantics });
  if (semanticPublicDataIssues.length > 0) throw new Error(`Semantic Browse JSON contains local/sensitive data: ${semanticPublicDataIssues.join("; ")}`);
  console.log(JSON.stringify({
    outputDirectory,
    schemaVersion: manifest.schemaVersion,
    arcaea: arcaea.recordCounts,
    phigros: phigros.recordCounts,
    semantic: { arcaeaResources: arcaeaSemantics.resources.length, phigrosResources: phigrosSemantics.resources.length, rizlineResources: rizlineSemantics.resources.length },
    diagnostics: { arcaea: diagnostics.arcaea, phigros: diagnostics.phigros },
    localSensitivePaths: false,
  }, null, 2));
}

await main();

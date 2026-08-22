import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  ArcaeaBrowseProjection,
  ArcaeaCategoryBrowseProjection,
  BrowseDiagnostics,
  BrowseManifest,
  PhigrosCategoryBrowseProjection,
  PhigrosBrowseProjection,
  catalogSha256FromValue,
  loadCatalogFile,
  validateBrowsePublicData,
  validateCategoryBrowseProjection,
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
  const diagnostics = BrowseDiagnostics.parse(await json(path.join(outputDirectory, "diagnostics.json")));
  const result = { arcaea, phigros, manifest, diagnostics } satisfies BrowseProjectionBuildResult;
  const validation = validateBrowseProjectionSet(result, catalog);
  if (!validation.success) throw new Error(`Browse Projection validation failed: ${validation.issues.join("; ")}`);
  const arcaeaSemanticValidation = validateCategoryBrowseProjection(arcaeaSemantics, catalog);
  if (!arcaeaSemanticValidation.success) throw new Error(`Arcaea semantic Browse validation failed: ${arcaeaSemanticValidation.issues.join("; ")}`);
  const phigrosSemanticValidation = validateCategoryBrowseProjection(phigrosSemantics, catalog);
  if (!phigrosSemanticValidation.success) throw new Error(`Phigros semantic Browse validation failed: ${phigrosSemanticValidation.issues.join("; ")}`);
  if (manifest.catalog.catalogSha256 !== catalogSha256FromValue(catalog)) throw new Error("Browse manifest Catalog hash does not match catalog/index.json.");
  const publicDataIssues = validateBrowsePublicData(result);
  if (publicDataIssues.length > 0) throw new Error(`Browse JSON contains local/sensitive data: ${publicDataIssues.join("; ")}`);
  const semanticPublicDataIssues = validateBrowsePublicData({ arcaea: arcaeaSemantics, phigros: phigrosSemantics });
  if (semanticPublicDataIssues.length > 0) throw new Error(`Semantic Browse JSON contains local/sensitive data: ${semanticPublicDataIssues.join("; ")}`);
  console.log(JSON.stringify({
    outputDirectory,
    schemaVersion: manifest.schemaVersion,
    arcaea: arcaea.recordCounts,
    phigros: phigros.recordCounts,
    semantic: { arcaeaResources: arcaeaSemantics.resources.length, phigrosResources: phigrosSemantics.resources.length },
    diagnostics: { arcaea: diagnostics.arcaea, phigros: diagnostics.phigros },
    localSensitivePaths: false,
  }, null, 2));
}

await main();

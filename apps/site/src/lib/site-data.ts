import fs from "node:fs";
import path from "node:path";
import { ArcaeaBrowseProjection, BrowseDiagnostics, BrowseManifest, PhigrosBrowseProjection, validateBrowseProjectionSet, validateBrowsePublicData, type ArcaeaBrowseProjectionType, type PhigrosBrowseProjectionType } from "../../../../packages/domain/src/browse.js";
import { validateCatalog } from "../../../../packages/domain/src/validation.js";
import type { Catalog } from "../../../../packages/domain/src/schema.js";
import { buildBrowseGalleryData } from "./browse-gallery";
import { projectCatalog } from "./catalog-projection";
import { ROS_BASE_URL } from "./site-config";
import type { PublicSiteData } from "./types";

let cachedSiteData: PublicSiteData | undefined;
let cachedBrowseProjections: FormalBrowseProjections | undefined;
let cachedBrowseGalleryBuild: ReturnType<typeof buildBrowseGalleryData> | undefined;

export type FormalBrowseProjections = {
  arcaea: ArcaeaBrowseProjectionType;
  phigros: PhigrosBrowseProjectionType;
};

export function loadFormalCatalog(): Catalog {
  const catalogPath = findWorkspaceFile("catalog", "index.json");
  const parsed = JSON.parse(fs.readFileSync(catalogPath, "utf8")) as unknown;
  const validation = validateCatalog(parsed);
  if (!validation.success) {
    const details = validation.issues.slice(0, 3).map((issue) => `${issue.path}: ${issue.message}`).join("; ");
    throw new Error(`Formal Catalog failed runtime validation: ${details}`);
  }
  return validation.data;
}

export function getSiteData(): PublicSiteData {
  cachedSiteData ??= projectCatalog(loadFormalCatalog(), ROS_BASE_URL);
  return cachedSiteData;
}

export function loadFormalBrowseProjections(): FormalBrowseProjections {
  if (cachedBrowseProjections) return cachedBrowseProjections;

  const catalog = loadFormalCatalog();
  const result = {
    arcaea: parseFormalBrowseFile("arcaea.json", ArcaeaBrowseProjection),
    phigros: parseFormalBrowseFile("phigros.json", PhigrosBrowseProjection),
    manifest: parseFormalBrowseFile("manifest.json", BrowseManifest),
    diagnostics: parseFormalBrowseFile("diagnostics.json", BrowseDiagnostics),
  };
  const validation = validateBrowseProjectionSet(result, catalog);
  if (!validation.success) throw new Error(`Formal Browse Projection failed runtime validation: ${validation.issues.slice(0, 5).join("; ")}`);
  const publicDataIssues = validateBrowsePublicData(result);
  if (publicDataIssues.length > 0) throw new Error(`Formal Browse Projection contains local or sensitive data: ${publicDataIssues.slice(0, 5).join("; ")}`);

  cachedBrowseProjections = { arcaea: result.arcaea, phigros: result.phigros };
  return cachedBrowseProjections;
}

export function getBrowseGalleryBuild(): ReturnType<typeof buildBrowseGalleryData> {
  cachedBrowseGalleryBuild ??= buildBrowseGalleryData(getSiteData(), loadFormalBrowseProjections());
  return cachedBrowseGalleryBuild;
}

export function findWorkspaceRoot(): string {
  const candidates = [
    path.resolve(process.cwd()),
    path.resolve(process.cwd(), "..", ".."),
  ];
  const root = candidates.find((candidate) => fs.existsSync(path.join(candidate, "catalog", "index.json")));
  if (!root) throw new Error("Workspace root with catalog/index.json was not found.");
  return root;
}

function findWorkspaceFile(...parts: string[]): string {
  const root = findWorkspaceRoot();
  return path.join(root, ...parts);
}

function parseFormalBrowseFile<T>(filename: string, schema: { parse: (value: unknown) => T }): T {
  return schema.parse(JSON.parse(fs.readFileSync(findWorkspaceFile("catalog", "browse", filename), "utf8")) as unknown);
}


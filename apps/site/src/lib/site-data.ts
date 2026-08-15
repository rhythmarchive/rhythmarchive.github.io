import fs from "node:fs";
import path from "node:path";
import { validateCatalog } from "../../../../packages/domain/src/validation.js";
import type { Catalog } from "../../../../packages/domain/src/schema.js";
import { projectCatalog } from "./catalog-projection";
import { ROS_BASE_URL } from "./site-config";
import type { PublicSiteData } from "./types";

let cachedSiteData: PublicSiteData | undefined;

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


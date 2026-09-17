import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getSiteData, loadFormalCatalog } from "../src/lib/site-data.js";

const workspaceRoot = path.resolve(process.cwd());
const outputPath = path.join(workspaceRoot, "workers", "stats", "src", "public-resource-registry.ts");
const checkOnly = process.argv.includes("--check");

const catalog = loadFormalCatalog();
const siteData = getSiteData();
const resourceIds = [...new Set(siteData.resources.map((resource) => resource.resourceId))].sort((left, right) => left.localeCompare(right, "en"));
const games = [...siteData.games].sort((left, right) => left.slug.localeCompare(right.slug, "en"));

const output = `/* GENERATED FILE. Run npm run stats:registry after a public Catalog change. */
export const PUBLIC_RESOURCE_CATALOG_GENERATED_AT = ${JSON.stringify(catalog.generatedAt)} as const;
export const PUBLIC_RESOURCE_ID_LIST = ${JSON.stringify(resourceIds, null, 2)} as const;
export const PUBLIC_RESOURCE_IDS = new Set<string>(PUBLIC_RESOURCE_ID_LIST);
export const PUBLIC_GAME_SLUGS = ${JSON.stringify(games.map((game) => game.slug))} as const;
export type PublicGameSlug = typeof PUBLIC_GAME_SLUGS[number];
export const PUBLIC_GAME_DISPLAY_NAMES: Record<PublicGameSlug, string> = ${JSON.stringify(Object.fromEntries(games.map((game) => [game.slug, game.displayName])), null, 2)};
`;

if (checkOnly) {
  let current: string;
  try {
    current = await readFile(outputPath, "utf8");
  } catch {
    throw new Error(`Public stats resource registry is missing: ${path.relative(workspaceRoot, outputPath)}`);
  }
  if (current !== output) throw new Error(`Public stats resource registry is stale: run npm run stats:registry (${path.relative(workspaceRoot, outputPath)}).`);
  console.log(`Public stats resource registry is current: ${resourceIds.length} resources, ${games.length} games.`);
} else {
  await writeFile(outputPath, output, "utf8");
  console.log(`Public stats resource registry generated: ${resourceIds.length} resources, ${games.length} games.`);
}

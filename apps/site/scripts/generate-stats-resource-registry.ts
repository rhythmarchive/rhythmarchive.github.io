import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { loadFormalCatalog } from "../src/lib/site-data.js";
import { projectCatalog } from "../src/lib/catalog-projection.js";
import { ROS_BASE_URL } from "../src/lib/site-config.js";
import { fileURLToPath } from "node:url";

export async function generateStatsResourceRegistry(checkOnly = false): Promise<void> {
const workspaceRoot = path.resolve(process.cwd());
const outputPath = path.join(workspaceRoot, "workers", "stats", "src", "public-resource-registry.ts");

const catalog = loadFormalCatalog();
// Membership needs only the canonical public projection, never Browse/Updates timestamps.
const siteData = projectCatalog(catalog, ROS_BASE_URL);
const resourceIds = [...new Set(siteData.resources.map((resource) => resource.resourceId))].sort((left, right) => left.localeCompare(right, "en"));
const games = [...siteData.games].sort((left, right) => left.slug.localeCompare(right.slug, "en"));
const registryHash = createHash("sha256").update(JSON.stringify([resourceIds, games.map(game => [game.slug, game.displayName])])).digest("hex");
const current = await readFile(outputPath, "utf8").then(text => text.replaceAll("\r\n", "\n")).catch(() => "");
// Metadata-only Catalog timestamps must not redeploy an identical public registry.
const unchanged = current.includes(`PUBLIC_RESOURCE_REGISTRY_SHA256 = "${registryHash}"`);
const generatedAt = unchanged ? current.match(/PUBLIC_RESOURCE_CATALOG_GENERATED_AT = "([^"]+)"/)?.[1] ?? catalog.generatedAt : catalog.generatedAt;

const output = `/* GENERATED FILE. Run npm run stats:registry after a public Catalog change. */
export const PUBLIC_RESOURCE_CATALOG_GENERATED_AT = ${JSON.stringify(generatedAt)} as const;
export const PUBLIC_RESOURCE_REGISTRY_SHA256 = ${JSON.stringify(registryHash)} as const;
export const PUBLIC_RESOURCE_ID_LIST = ${JSON.stringify(resourceIds, null, 2)} as const;
export const PUBLIC_RESOURCE_IDS = new Set<string>(PUBLIC_RESOURCE_ID_LIST);
export const PUBLIC_GAME_SLUGS = ${JSON.stringify(games.map((game) => game.slug))} as const;
export type PublicGameSlug = typeof PUBLIC_GAME_SLUGS[number];
export const PUBLIC_GAME_DISPLAY_NAMES: Record<PublicGameSlug, string> = ${JSON.stringify(Object.fromEntries(games.map((game) => [game.slug, game.displayName])), null, 2)};
`;

if (checkOnly) {
  if (!current) {
    throw new Error(`Public stats resource registry is missing: ${path.relative(workspaceRoot, outputPath)}`);
  }
  if (current !== output) throw new Error(`Public stats resource registry is stale: run npm run stats:registry (${path.relative(workspaceRoot, outputPath)}).`);
  console.log(`Public stats resource registry is current: ${resourceIds.length} resources, ${games.length} games.`);
} else {
  if (current !== output) await writeFile(outputPath, output, "utf8");
  console.log(`Public stats resource registry generated: ${resourceIds.length} resources, ${games.length} games.`);
}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generateStatsResourceRegistry(process.argv.includes("--check"));
}

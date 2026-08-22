import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildBrowseGalleryData } from "../src/lib/browse-gallery.js";
import { findWorkspaceRoot, getSiteData, loadFormalBrowseProjections } from "../src/lib/site-data.js";

const root = findWorkspaceRoot();
const rosBaseUrl = process.env.PUBLIC_ROS_BASE_URL?.trim() || "https://rhythm-assets.cn-nb1.rains3.com";
const data = getSiteData(rosBaseUrl);
const browseBuild = buildBrowseGalleryData(data, loadFormalBrowseProjections());
const generatedSourceDir = path.join(root, "apps", "site", "src", "generated");
const publicDataDir = path.join(root, "apps", "site", "public", "data");
const galleryDir = path.join(publicDataDir, "galleries");
const browseGalleryDir = path.join(publicDataDir, "browse");

await mkdir(generatedSourceDir, { recursive: true });
await mkdir(galleryDir, { recursive: true });
await writeJson(path.join(generatedSourceDir, "public-site-data.json"), data, true);
await writeJson(path.join(publicDataDir, "resources.json"), data.resources);
await writeJson(path.join(publicDataDir, "game-index.json"), data.games);
await writeJson(path.join(publicDataDir, "search-index.json"), data.searchIndex);

for (const [key, resources] of Object.entries(data.galleries)) {
  const [game, category] = key.split("/");
  if (!game || !category) continue;
  await mkdir(path.join(galleryDir, game), { recursive: true });
  await writeJson(path.join(galleryDir, game, `${category}.json`), resources);
}

for (const [game, browseData] of Object.entries({ arcaea: browseBuild.arcaea, phigros: browseBuild.phigros })) {
  await mkdir(path.join(browseGalleryDir, game), { recursive: true });
  await writeJson(path.join(browseGalleryDir, game, "jacket.json"), browseData);
}

console.log(`Public data generated: ${data.resources.length} resources, ${data.searchIndex.length} search entries.`);
console.log(`Browse galleries generated: Arcaea ${browseBuild.arcaea.items.length} items, Phigros ${browseBuild.phigros.items.length} items.`);
for (const [game, diagnostics] of Object.entries(browseBuild.diagnostics)) {
  if (diagnostics.skipped.length > 0) {
    console.log(`Browse records skipped (${game}): ${diagnostics.skipped.length} (${diagnostics.skipped.map((record) => `${record.identity}: ${record.reason}`).join(", ")}).`);
  }
}

async function writeJson(filePath: string, value: unknown, pretty = false): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, pretty ? 2 : 0)}\n`, "utf8");
}

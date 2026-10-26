import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildBrowseGalleryData } from "../src/lib/browse-gallery.js";
import { GAME_CONFIG } from "../src/lib/game-config.js";
import { batchDownloads, browserBrowseData, galleryCard } from "../src/lib/gallery-projection.js";
import { selectCardPreview, cardImage } from "../src/lib/card-preview.js";
import { rankingShardKey } from "../src/lib/ranking.js";
import { buildSearchSuggestions } from "../src/lib/search-suggestions.js";
import { findWorkspaceRoot, getSiteData, loadCategoryBrowseProjections, loadFormalBrowseProjections } from "../src/lib/site-data.js";

const root = findWorkspaceRoot();
const rosBaseUrl = process.env.PUBLIC_ROS_BASE_URL?.trim() || "https://rhythm-assets.cn-nb1.rains3.com";
const data = getSiteData(rosBaseUrl);
const categoryBrowse = loadCategoryBrowseProjections();
const browseBuild = buildBrowseGalleryData(data, loadFormalBrowseProjections());
const publicDataDir = path.join(root, "apps", "site", "public", "data");
const galleryDir = path.join(publicDataDir, "galleries");
const batchDir = path.join(publicDataDir, "batch");
const browseGalleryDir = path.join(publicDataDir, "browse");
const storyDataDir = path.join(publicDataDir, "story");
const rankingDir = path.join(publicDataDir, "ranking");
const hiddenArcaeaCategories = ["startup", "story-texture"];

const relativePublicDataDir = path.relative(path.resolve(root), path.resolve(publicDataDir));
if (relativePublicDataDir !== path.join("apps", "site", "public", "data")) throw new Error("Unexpected generated public data path");
await rm(publicDataDir, { recursive: true, force: true });
await mkdir(galleryDir, { recursive: true });
await mkdir(batchDir, { recursive: true });
await mkdir(storyDataDir, { recursive: true });
await mkdir(rankingDir, { recursive: true });
for (const category of hiddenArcaeaCategories) {
  await rm(path.join(galleryDir, "arcaea", `${category}.json`), { force: true });
}
await writeJson(path.join(publicDataDir, "game-index.json"), data.games);
// The v1 search bundle predates Berry Melody and cannot resolve its GameConfig.
await writeJson(path.join(publicDataDir, "search-index.json"), data.searchIndex.filter(entry => entry.game !== "berrymelody"));
await writeJson(path.join(publicDataDir, "search-index-v2.json"), data.searchIndex);
await writeJson(path.join(publicDataDir, "search-suggestions-v1.json"), buildSearchSuggestions(data.searchIndex, data.generatedAt));
// Retain the unversioned contract for already-open predeployment search clients.
await writeJson(path.join(publicDataDir, "search-cards.json"), data.resources.map(resource => ({ ...toSearchCard(resource), route: resource.route, displayTitle: resource.displayTitle })));
await writeJson(path.join(publicDataDir, "search-cards-v2.json"), data.resources.map(toSearchCard));
const rankingShards = new Map<string, ReturnType<typeof toRankingCard>[]>();
for (const resource of data.resources) {
  const key = rankingShardKey(resource.resourceId);
  const shard = rankingShards.get(key) ?? [];
  shard.push(toRankingCard(resource));
  rankingShards.set(key, shard);
}
for (const [key, cards] of rankingShards) await writeJson(path.join(rankingDir, `${key}.json`), cards);
if (categoryBrowse.arcaea.storyAtlas) await writeJson(path.join(storyDataDir, "arcaea.json"), categoryBrowse.arcaea.storyAtlas);

for (const [key, resources] of Object.entries(data.galleries)) {
  const [game, category] = key.split("/");
  if (!game || !category) continue;
  await mkdir(path.join(galleryDir, game), { recursive: true });
  await writeJson(path.join(galleryDir, game, `${category}.json`), resources.map(galleryCard));
  await mkdir(path.join(batchDir, game), { recursive: true });
  await writeJson(path.join(batchDir, game, `${category}.json`), batchDownloads(resources));
}

for (const game of Object.keys(GAME_CONFIG) as Array<keyof typeof GAME_CONFIG>) {
  if (game === "rotaeno") continue;
  const browseData = (browseBuild as unknown as Record<string, { items: unknown[] }>)[game];
  if (!browseData) continue;
  await mkdir(path.join(browseGalleryDir, game), { recursive: true });
  await writeJson(path.join(browseGalleryDir, game, "jacket.json"), browserBrowseData(browseData as Parameters<typeof browserBrowseData>[0]));
}

console.log(`Public data generated: ${data.resources.length} resources, ${data.searchIndex.length} search entries.`);
console.log("Browse galleries generated: " + Object.entries(browseBuild.diagnostics).map(([game, diagnostics]) => game + " " + (diagnostics.projectionRecords - diagnostics.skipped.length) + " items").join(", ") + ".");
for (const [game, diagnostics] of Object.entries(browseBuild.diagnostics)) {
  if (diagnostics.skipped.length > 0) {
    console.log(`Browse records skipped (${game}): ${diagnostics.skipped.length} (${diagnostics.skipped.map((record) => `${record.identity}: ${record.reason}`).join(", ")}).`);
  }
}

function toSearchCard(resource: ReturnType<typeof getSiteData>["resources"][number]) {
  const { primary, fallback } = selectCardPreview(resource.preview);
  const image = cardImage(primary);
  const fallbackImage = resource.game === "dynamix" && resource.resourceType === "character-portrait" ? null : cardImage(fallback);
  const variantLabels = resource.badges?.length
    ? resource.badges
    : resource.variants.filter((variant) => variant.label !== "默认").map((variant) => variant.label);
  return {
    resourceId: resource.resourceId,
    game: resource.game,
    resourceType: resource.resourceType,
    categoryLabel: resource.categoryLabel,
    ...(resource.artist ? { artist: resource.artist } : {}),
    image,
    fallback: fallbackImage,
    ...(resource.upscaled ? { upscaled: true } : {}),
    ...(variantLabels.length > 0 ? { variantLabels } : {}),
  };
}

function toRankingCard(resource: ReturnType<typeof getSiteData>["resources"][number]) {
  const previews = [resource.preview.small, resource.preview.medium, resource.preview.large].filter((asset): asset is NonNullable<typeof resource.preview.small> => Boolean(asset));
  const primary = previews[0];
  const fallback = previews[1];
  return {
    resourceId: resource.resourceId,
    route: resource.route,
    game: resource.game,
    resourceType: resource.resourceType,
    displayTitle: resource.displayTitle,
    categoryLabel: resource.categoryLabel,
    ...(resource.artist ? { artist: resource.artist } : {}),
    image: primary ? toRankingImage(primary) : null,
    fallback: fallback ? toRankingImage(fallback) : null,
  };
}

function toRankingImage(asset: NonNullable<ReturnType<typeof getSiteData>["resources"][number]["preview"]["small"]>) {
  return { url: asset.url, width: asset.width, height: asset.height };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { categoryLabel, gameCategoryLabel, GAME_CONFIG, type GameId, type ResourceTypeId } from "./game-config";
import type { PublicGameIndex, PublicResource, PublicSearchImage, PublicSiteData, PublicUpdate, PublicUpdateChange, PublicUpdateItem } from "./types";

const UpdateChange = z.enum(["added", "supplemented", "replaced"]);
const RawUpdateItem = z.object({ resourceId: z.string().min(1), change: UpdateChange });
const RawUpdateRecord = z.object({
  id: z.string().min(1),
  game: z.string().min(1),
  releaseIds: z.array(z.string().min(1)).min(1),
  kind: z.enum(["baseline", "update"]),
  publishedAt: z.string().datetime({ offset: true }),
  contentVersion: z.string().min(1).optional(),
  items: z.array(RawUpdateItem),
});
const RawBaseline = z.object({
  id: z.string().min(1),
  game: z.string().min(1),
  releaseIds: z.array(z.string().min(1)).min(1),
  publishedAt: z.string().datetime({ offset: true }),
  contentVersion: z.string().min(1).optional(),
});
const RawUpdateHistory = z.object({ schemaVersion: z.literal(1), baselines: z.array(RawBaseline).default([]), records: z.array(RawUpdateRecord) });

type RawUpdateRecord = z.infer<typeof RawUpdateRecord>;
type RawUpdateHistory = z.infer<typeof RawUpdateHistory>;
const CHANGE_PRIORITY: Record<PublicUpdateChange, number> = { added: 3, supplemented: 2, replaced: 1 };

export function loadRawUpdateHistory(root: string): RawUpdateHistory {
  const filePath = path.join(root, "catalog", "updates", "index.json");
  if (!fs.existsSync(filePath)) return { schemaVersion: 1, baselines: [], records: [] };
  return RawUpdateHistory.parse(JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown);
}

function publicImage(resource: PublicResource): { image: PublicSearchImage | null; fallback: PublicSearchImage | null } {
  const toImage = (asset: { url: string; width?: number; height?: number } | null | undefined): PublicSearchImage | null => asset
    ? { url: asset.url, ...(asset.width !== undefined ? { width: asset.width } : {}), ...(asset.height !== undefined ? { height: asset.height } : {}) }
    : null;
  const preview = resource.preview.small ?? resource.preview.medium ?? resource.preview.large;
  return { image: toImage(preview), fallback: toImage(resource.original) };
}

function gameId(value: string): GameId | undefined {
  return Object.prototype.hasOwnProperty.call(GAME_CONFIG, value) ? value as GameId : undefined;
}

function mergeRawItems(record: RawUpdateRecord): Map<string, PublicUpdateChange> {
  const items = new Map<string, PublicUpdateChange>();
  for (const item of record.items) {
    const previous = items.get(item.resourceId);
    if (!previous || CHANGE_PRIORITY[item.change] > CHANGE_PRIORITY[previous]) items.set(item.resourceId, item.change);
  }
  return items;
}

export function projectUpdates(siteData: Omit<PublicSiteData, "updates">, root: string): PublicUpdate[] {
  const raw = loadRawUpdateHistory(root);
  const resourcesById = new Map(siteData.resources.map((resource) => [resource.resourceId, resource]));
  const gamesById = new Map(siteData.games.map((game) => [game.slug, game]));
  const updates: PublicUpdate[] = [];

  for (const record of raw.records) {
    if (record.kind !== "update") continue;
    const game = gameId(record.game);
    if (!game) continue;
    const mergedItems = mergeRawItems(record);
    const items: PublicUpdateItem[] = [];
    for (const [resourceId, change] of mergedItems) {
      const resource = resourcesById.get(resourceId);
      if (!resource || resource.game !== game) continue;
      const { image, fallback } = publicImage(resource);
      items.push({
        resourceId: resource.resourceId,
        route: resource.route,
        game,
        resourceType: resource.resourceType,
        category: resource.category,
        categoryLabel: resource.categoryLabel || gameCategoryLabel(game, resource.resourceType as ResourceTypeId) || categoryLabel(resource.resourceType as ResourceTypeId),
        displayTitle: resource.displayTitle,
        image,
        fallback,
        change,
      });
    }
    if (items.length === 0) continue;
    items.sort((left, right) => left.category.localeCompare(right.category, "en") || left.displayTitle.localeCompare(right.displayTitle, "zh-CN") || left.resourceId.localeCompare(right.resourceId, "en"));
    const summary: PublicUpdate["summary"] = { added: 0, supplemented: 0, replaced: 0 };
    const categoriesBySlug = new Map<string, PublicUpdate["categories"][number]>();
    for (const item of items) {
      summary[item.change] += 1;
      const category = categoriesBySlug.get(item.category) ?? { slug: item.category, label: item.categoryLabel, count: 0 };
      category.count += 1;
      categoriesBySlug.set(item.category, category);
    }
    const gameEntry: PublicGameIndex | undefined = gamesById.get(game);
    updates.push({
      id: record.id,
      game,
      displayName: gameEntry?.displayName ?? GAME_CONFIG[game].displayName,
      publishedAt: record.publishedAt,
      ...(record.contentVersion ? { contentVersion: record.contentVersion } : {}),
      totalItemCount: mergedItems.size,
      availableItemCount: items.length,
      summary,
      categories: [...categoriesBySlug.values()].sort((left, right) => left.label.localeCompare(right.label, "zh-CN") || left.slug.localeCompare(right.slug, "en")),
      items,
    });
  }

  return updates.sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt) || right.id.localeCompare(left.id, "en"));
}

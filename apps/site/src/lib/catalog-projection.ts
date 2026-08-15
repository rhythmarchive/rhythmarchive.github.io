import type { AssetObject, Catalog, Rendition, Resource, Variant } from "../../../../packages/domain/src/schema.js";
import { categoryLabel, categoryOrderIndex, displayVariantLabel, GAME_CONFIG, type GameId, type ResourceTypeId } from "./game-config";
import { normalizePublicDisplay } from "./public-display";
import { normalizeSearchText } from "./search";
import type { PublicAsset, PublicCategory, PublicDownload, PublicGameIndex, PublicPreview, PublicResource, PublicSearchEntry, PublicSiteData, PublicVariant } from "./types";
import { objectUrl } from "./url";

const PUBLIC_METADATA_KEYS = new Set([
  "artist",
  "pack",
  "packName",
  "packDisplayName",
  "side",
  "version",
  "bpm",
  "characterName",
  "characterEnglishName",
  "characterVariant",
  "storyPathTitle",
  "storyType",
  "storyAct",
  "relatedSongTitle",
  "relatedSongId",
  "songId",
]);

const PREVIEW_TYPES = {
  small: "thumbnail-320",
  medium: "thumbnail-640",
  large: "thumbnail-1280",
} as const;

export function selectPreviewRendition(renditions: Rendition[], size: keyof typeof PREVIEW_TYPES): Rendition | undefined {
  return renditions.find((rendition) => rendition.renditionType === PREVIEW_TYPES[size]);
}

export function projectCatalog(catalog: Catalog, rosBaseUrl: string): PublicSiteData {
  const objectsById = new Map(catalog.objects.map((object) => [object.id, object]));
  const variantsByResource = groupBy(catalog.variants, (variant) => variant.resourceId);
  const renditionsByVariant = groupBy(catalog.renditions, (rendition) => rendition.variantId);

  const resources = catalog.resources
    .filter((resource) => resource.lifecycle.status === "published")
    .map((resource) => projectResource(resource, variantsByResource.get(resource.id) ?? [], renditionsByVariant, objectsById, rosBaseUrl))
    .sort(compareResources);

  const games = (Object.keys(GAME_CONFIG) as GameId[]).map((game) => {
    const gameResources = resources.filter((resource) => resource.game === game);
    const categories = buildCategories(game, gameResources);
    return {
      slug: game,
      displayName: GAME_CONFIG[game].displayName,
      count: gameResources.length,
      categories,
      featuredCategories: GAME_CONFIG[game].featuredCategories
        .map((slug) => categories.find((category) => category.slug === slug))
        .filter((category): category is PublicCategory => Boolean(category)),
    } satisfies PublicGameIndex;
  });

  const galleries: Record<string, PublicResource[]> = {};
  for (const game of games) {
    const gameResources = resources.filter((resource) => resource.game === game.slug);
    galleries[galleryKey(game.slug, "all")] = gameResources;
    for (const category of game.categories) galleries[galleryKey(game.slug, category.slug)] = gameResources.filter((resource) => resource.category === category.slug);
  }

  const sourceResourcesById = new Map(catalog.resources.map((resource) => [resource.id, resource]));
  const searchIndex = resources.map((resource) => toSearchEntry(resource, sourceResourcesById.get(resource.resourceId)));
  return { generatedAt: catalog.generatedAt, resources, games, searchIndex, galleries };
}

function projectResource(resource: Resource, variants: Variant[], renditionsByVariant: Map<string, Rendition[]>, objectsById: Map<string, AssetObject>, rosBaseUrl: string): PublicResource {
  const projectedVariants = variants
    .map((variant) => projectVariant(variant, renditionsByVariant.get(variant.id) ?? [], objectsById, rosBaseUrl))
    .sort((a, b) => a.label.localeCompare(b.label, "en") || a.variantId.localeCompare(b.variantId));
  const active = projectedVariants[0];
  const original = active?.original;
  const upscaled = active?.upscaled;
  const display = normalizePublicDisplay(resource, original?.downloadFilename);
  const metadata = { ...pickPublicMetadata(resource), ...filterPublicMetadata(display.metadata) };
  const artist = display.artist ?? (typeof metadata.artist === "string" ? metadata.artist : undefined);

  return {
    resourceId: resource.id,
    route: `/r/${encodeURIComponent(resource.id)}/`,
    game: resource.game,
    resourceType: resource.resourceType,
    category: resource.resourceType,
    categoryLabel: categoryLabel(resource.resourceType),
    displayTitle: display.title || original?.downloadFilename || "未命名资源",
    ...(artist ? { artist } : {}),
    metadata,
    variants: projectedVariants,
    preview: active?.preview ?? emptyPreview(),
    ...(original ? { original, downloadFilename: original.downloadFilename, mime: original.mime, sizeBytes: original.sizeBytes } : {}),
    ...(upscaled ? { upscaled } : {}),
  };
}

function projectVariant(variant: Variant, renditions: Rendition[], objectsById: Map<string, AssetObject>, rosBaseUrl: string): PublicVariant {
  const preview = {
    small: projectPreview(renditions, "small", objectsById, rosBaseUrl),
    medium: projectPreview(renditions, "medium", objectsById, rosBaseUrl),
    large: projectPreview(renditions, "large", objectsById, rosBaseUrl),
  } satisfies PublicPreview;
  const originalRendition = renditions.find((rendition) => rendition.renditionType === "original" && rendition.publishable);
  const upscaledRendition = renditions.find((rendition) => rendition.renditionType === "upscaled" && rendition.publishable);
  const original = originalRendition ? projectDownload(originalRendition, objectsById, rosBaseUrl) : undefined;
  const upscaled = upscaledRendition ? projectDownload(upscaledRendition, objectsById, rosBaseUrl) : undefined;
  const publicVariant: PublicVariant = {
    variantId: variant.id,
    label: displayVariantLabel(variant),
    preview,
    ...(variant.difficulty ? { difficulty: variant.difficulty } : {}),
    ...(original ? { original } : {}),
    ...(upscaled ? { upscaled } : {}),
  };
  return publicVariant;
}

function projectPreview(renditions: Rendition[], size: keyof typeof PREVIEW_TYPES, objectsById: Map<string, AssetObject>, rosBaseUrl: string): PublicAsset | null {
  const rendition = selectPreviewRendition(renditions, size);
  if (!rendition) return null;
  const object = objectsById.get(rendition.objectId);
  if (!object) return null;
  return { url: objectUrl(object.objectKey, rosBaseUrl), width: object.width, height: object.height, mime: object.mime };
}

function projectDownload(rendition: Rendition, objectsById: Map<string, AssetObject>, rosBaseUrl: string): PublicDownload | undefined {
  const object = objectsById.get(rendition.objectId);
  if (!object) return undefined;
  return { url: objectUrl(object.objectKey, rosBaseUrl), downloadFilename: rendition.downloadFilename, mime: object.mime, sizeBytes: object.sizeBytes };
}

function pickPublicMetadata(resource: Resource): Record<string, string | number | boolean> {
  return filterPublicMetadata(resource.metadata);
}

function filterPublicMetadata(input: Record<string, unknown>): Record<string, string | number | boolean> {
  const output: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!PUBLIC_METADATA_KEYS.has(key)) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") output[key] = value;
  }
  return output;
}

function toSearchEntry(resource: PublicResource, sourceResource?: Resource): PublicSearchEntry {
  const keywordSet = new Set<string>();
  for (const value of Object.values(resource.metadata)) keywordSet.add(String(value));
  for (const variant of resource.variants) keywordSet.add(variant.label);
  for (const value of [sourceResource?.title, ...(sourceResource?.aliases ?? []).map((alias) => alias.value), ...(sourceResource?.provenance ?? []).map((entry) => entry.sourceFilename)]) {
    if (value) keywordSet.add(value);
  }
  return {
    resourceId: resource.resourceId,
    route: resource.route,
    title: resource.displayTitle,
    game: resource.game,
    category: resource.category,
    categoryLabel: resource.categoryLabel,
    ...(resource.artist ? { artist: resource.artist } : {}),
    keywords: [...keywordSet].filter((value) => normalizeSearchText(value)).sort((a, b) => normalizeSearchText(a).localeCompare(normalizeSearchText(b), "zh-CN")),
  };
}

function buildCategories(game: GameId, resources: PublicResource[]): PublicCategory[] {
  const counts = new Map<ResourceTypeId, number>();
  for (const resource of resources) counts.set(resource.resourceType, (counts.get(resource.resourceType) ?? 0) + 1);
  const known = GAME_CONFIG[game].categoryOrder.filter((category) => counts.has(category));
  const unknown = [...counts.keys()].filter((category) => !known.includes(category)).sort();
  return [...known, ...unknown].map((slug) => ({ slug, label: categoryLabel(slug), count: counts.get(slug) ?? 0 }));
}

function compareResources(a: PublicResource, b: PublicResource): number {
  return a.game.localeCompare(b.game) || categoryOrderIndex(a.game, a.resourceType) - categoryOrderIndex(b.game, b.resourceType) || normalizeSearchText(a.displayTitle).localeCompare(normalizeSearchText(b.displayTitle), "zh-CN") || a.resourceId.localeCompare(b.resourceId);
}

function emptyPreview(): PublicPreview {
  return { small: null, medium: null, large: null };
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const output = new Map<string, T[]>();
  for (const item of items) {
    const group = output.get(key(item)) ?? [];
    group.push(item);
    output.set(key(item), group);
  }
  return output;
}

export function galleryKey(game: GameId, category: string): string {
  return `${game}/${category}`;
}

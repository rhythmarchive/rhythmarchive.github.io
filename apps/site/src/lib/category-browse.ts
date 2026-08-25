import type {
  ArcaeaCategoryBrowseProjectionType,
  PhigrosCategoryBrowseProjectionType,
  RizlineCategoryBrowseProjectionType,
  InfalsusCategoryBrowseProjectionType,
} from "../../../../packages/domain/src/browse.js";
import { categoryLabel, gameCategoryLabel, type GameId, type ResourceTypeId } from "./game-config";
import { galleryKey } from "./catalog-projection";
import { normalizeSearchText } from "./search";
import type { PublicResource, PublicSearchEntry, PublicSiteData } from "./types";

export type CategoryBrowseFacetOption = { value: string; label: string };

export type CategoryBrowseFacet = {
  key: string;
  label: string;
  options: CategoryBrowseFacetOption[];
};

export type CategoryBrowseSortOption = {
  value: "default" | "title-asc" | "title-desc" | "artist-asc";
  label: string;
};

export type CategoryBrowseConfig = {
  searchPlaceholder: string;
  sortOptions: CategoryBrowseSortOption[];
  facets: CategoryBrowseFacet[];
};

export type CategoryBrowseProjections = {
  arcaea: ArcaeaCategoryBrowseProjectionType;
  phigros: PhigrosCategoryBrowseProjectionType;
  rizline: RizlineCategoryBrowseProjectionType;
  infalsus: InfalsusCategoryBrowseProjectionType;
};

export function applyCategoryBrowseSemantics(siteData: PublicSiteData, projections: CategoryBrowseProjections): PublicSiteData {
  const semanticById = new Map([
    ...projections.arcaea.resources.map((resource) => [resource.resourceId, resource] as const),
    ...projections.phigros.resources.map((resource) => [resource.resourceId, resource] as const),
    ...projections.infalsus.resources.map((resource) => [resource.resourceId, resource] as const),
    ...projections.rizline.resources.map((resource) => [resource.resourceId, resource] as const),
  ]);
  const resources = siteData.resources.map((resource) => {
    const semantic = semanticById.get(resource.resourceId);
    if (!semantic) return resource;
    return {
      ...resource,
      ...(semantic.displayTitle ? { displayTitle: semantic.displayTitle } : {}),
      ...(semantic.subtitle ? { subtitle: semantic.subtitle } : {}),
      ...(semantic.badges.length > 0 ? { badges: semantic.badges } : {}),
      ...(semantic.searchTerms.length > 0 ? { searchTerms: semantic.searchTerms } : {}),
      ...(semantic.sortOrder !== undefined ? { sortOrder: semantic.sortOrder } : {}),
      ...(Object.keys(semantic.facets).length > 0 ? { facets: semantic.facets } : {}),
      metadata: { ...resource.metadata, ...semantic.metadata },
    };
  });
  const resourcesById = new Map(resources.map((resource) => [resource.resourceId, resource]));
  const galleries: Record<string, PublicResource[]> = {};
  for (const [key, originalResources] of Object.entries(siteData.galleries)) {
    const [game, category] = key.split("/") as [GameId, string];
    const nextResources = originalResources.map((resource) => resourcesById.get(resource.resourceId) ?? resource);
    galleries[key] = category === "all" ? nextResources : sortSemanticResources(nextResources);
    if (game && category) galleries[galleryKey(game, category)] = galleries[key];
  }
  const previousSearch = new Map(siteData.searchIndex.map((entry) => [entry.resourceId, entry]));
  const searchIndex = resources.map((resource) => toSemanticSearchEntry(resource, previousSearch.get(resource.resourceId)));
  return { ...siteData, resources, searchIndex, galleries };
}

export function getCategoryBrowseConfig(game: GameId, category: string, resources: PublicResource[]): CategoryBrowseConfig {
  const sortOptions: CategoryBrowseSortOption[] = [
    { value: "default", label: "默认排序" },
    { value: "title-asc", label: "名称 A-Z" },
    { value: "title-desc", label: "名称 Z-A" },
  ];
  if (category === "jacket") return { searchPlaceholder: "搜索曲名或曲师", sortOptions, facets: [] };
  if (category === "all") return { searchPlaceholder: "搜索资源", sortOptions, facets: [] };

  const placeholder = game === "arcaea"
    ? ({
      "character-portrait": "搜索角色名",
      "character-avatar": "搜索角色名",
      "story-cg": "搜索剧情、关联歌曲或内容",
      "story-texture": "搜索剧情 Entry 或路径",
      "pack-cover": "搜索曲包",
      background: "搜索背景名或关联歌曲",
      "linkplay-preview": "搜索角色名",
      sticker: "搜索角色名或 Sticker",
    } as Record<string, string>)[category] ?? "搜索资源"
    : game === "rotaeno"
      ? ({
        "character-portrait": "搜索驾驶员",
        "pack-cover": "搜索曲包",
        background: "搜索活动背景",
        "special-art": "搜索特殊插画",
      } as Record<string, string>)[category] ?? "搜索资源"
    : game === "phigros"
      ? ({
        "character-avatar": "搜索头像名称",
        "pack-cover": "搜索曲包或分类",
        "phigros-april-fools": "搜索特殊资源",
      } as Record<string, string>)[category] ?? "搜索资源"
      : ({
        "special-art": "搜索特殊插画",
        "track-series": "搜索专辑名称、歌曲或合作方",
        "rizcard": "搜索 Layout 名称或 ID",
        "character-avatar": "搜索角色名",
      } as Record<string, string>)[category] ?? "搜索资源";
  const facetKeys = facetDefinitions(game, category);
  return {
    searchPlaceholder: placeholder,
    sortOptions,
    facets: facetKeys.map(({ key, label }) => ({ key, label, options: facetOptions(resources, key) })),
  };
}

function facetDefinitions(game: GameId, category: string): Array<{ key: string; label: string }> {
  if (game === "arcaea" && category === "story-cg") return [{ key: "path", label: "剧情路径" }, { key: "chapter", label: "章节" }];
  if (game === "arcaea" && category === "story-texture") return [{ key: "entry", label: "剧情 Entry" }];
  if (game === "arcaea" && category === "sticker") return [{ key: "locale", label: "语言" }];
  if (game === "phigros" && category === "pack-cover") return [{ key: "kind", label: "封面类型" }];
  return [];
}

function facetOptions(resources: PublicResource[], key: string): CategoryBrowseFacetOption[] {
  const values = new Set<string>();
  for (const resource of resources) for (const value of resource.facets?.[key] ?? []) values.add(value);
  return [...values].sort((left, right) => normalizeSearchText(left).localeCompare(normalizeSearchText(right), "zh-CN")).map((value) => ({ value, label: value }));
}

function sortSemanticResources(resources: PublicResource[]): PublicResource[] {
  return [...resources].sort((left, right) => {
    const leftOrder = left.sortOrder ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.sortOrder ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || normalizeSearchText(left.displayTitle).localeCompare(normalizeSearchText(right.displayTitle), "zh-CN") || left.resourceId.localeCompare(right.resourceId, "en");
  });
}

function toSemanticSearchEntry(resource: PublicResource, previous?: PublicSearchEntry): PublicSearchEntry {
  const keywords = new Set(previous?.keywords ?? []);
  for (const value of resource.searchTerms ?? []) keywords.add(value);
  if (resource.subtitle) keywords.add(resource.subtitle);
  for (const badge of resource.badges ?? []) keywords.add(badge);
  for (const value of Object.values(resource.metadata)) keywords.add(String(value));
  for (const values of Object.values(resource.facets ?? {})) for (const value of values) keywords.add(value);
  return {
    resourceId: resource.resourceId,
    route: resource.route,
    title: resource.displayTitle,
    game: resource.game,
    category: resource.category,
    categoryLabel: resource.categoryLabel,
    ...(resource.artist ? { artist: resource.artist } : {}),
    keywords: [...keywords].filter((value) => normalizeSearchText(value)).sort((left, right) => normalizeSearchText(left).localeCompare(normalizeSearchText(right), "zh-CN")),
  };
}

export function resourceCategoryLabel(resourceType: ResourceTypeId, game?: GameId): string {
  return game ? gameCategoryLabel(game, resourceType) : categoryLabel(resourceType);
}

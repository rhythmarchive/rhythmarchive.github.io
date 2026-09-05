import type {
  ArcaeaCategoryBrowseProjectionType,
  PhigrosCategoryBrowseProjectionType,
  RizlineCategoryBrowseProjectionType,
  InfalsusCategoryBrowseProjectionType,
} from "../../../../packages/domain/src/browse.js";
import { categoryLabel, displayFilterDifficultyLabel, gameCategoryLabel, type GameId, type ResourceTypeId } from "./game-config";
import { galleryKey } from "./catalog-projection";
import { compareNaturalText, normalizeSearchText } from "./search";
import type { PublicResource, PublicSearchEntry, PublicSiteData } from "./types";

const ROTAENO_CHART_ORDER = ["I", "II", "III", "IV", "IV_Alpha"] as const;
const PARADIGM_CHART_ORDER = ["DET", "IVD", "MSV", "RBT", "CTC"] as const;
const PHIGROS_PACK_KIND_ORDER = ["主线", "支线", "单曲", "全部曲目", "其他曲包"] as const;

export type CategoryBrowseFacetOption = { value: string; label: string };

export type CategoryBrowseFacetRange = {
  min: number;
  max: number;
  step: number;
};

export type CategoryBrowseFacet = {
  key: string;
  label: string;
  options: CategoryBrowseFacetOption[];
  range?: CategoryBrowseFacetRange;
};

export type CategoryBrowseSortOption = {
  value: "default" | "title-asc" | "title-desc" | "artist-asc" | "artist-desc" | "updated-desc" | "updated-asc" | "bpm-desc" | "bpm-asc";
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
      ...(Object.keys({ ...resource.facets, ...semantic.facets }).length > 0 ? { facets: { ...resource.facets, ...semantic.facets } } : {}),
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
  const sortOptions = baseSortOptions();
  if (category === "jacket") {
    const chartOptions = facetOptions(resources, "chart", game);
    const listFacets: CategoryBrowseFacet[] = chartOptions.length > 0 ? [{ key: "chart", label: "谱面难度", options: chartOptions }] : [];
    const rangeFacets: CategoryBrowseFacet[] = [];
    if (game === "rotaeno" || game === "paradigm-reboot") {
      const levelOptions = facetOptions(resources, "level", game);
      const constantOptions = facetOptions(resources, "constant", game);
      if (levelOptions.length > 0) listFacets.push({ key: "level", label: "难度等级", options: levelOptions });
      const constantRange = facetRange(resources, "constant", 0.1);
      if (constantOptions.length > 0) {
        const constantFacet = { key: "constant", label: "谱面定数", options: constantOptions, ...(constantRange ? { range: constantRange } : {}) };
        (constantRange ? rangeFacets : listFacets).push(constantFacet);
      }
    }
    const packOptions = facetOptions(resources, "pack", game);
    if (packOptions.length > 0) listFacets.push({ key: "pack", label: "曲包", options: packOptions });
    const bpmOptions = facetOptions(resources, "bpm", game);
    const bpmRange = facetRange(resources, "bpm");
    if (bpmOptions.length > 0) {
      const bpmFacet = { key: "bpm", label: "BPM", options: bpmOptions, ...(bpmRange ? { range: bpmRange } : {}) };
      (bpmRange ? rangeFacets : listFacets).push(bpmFacet);
    }
    const versionOptions = facetOptions(resources, "version", game);
    if (versionOptions.length > 0) listFacets.push({ key: "version", label: "加入版本", options: versionOptions });
    return {
      searchPlaceholder: "搜索曲名或曲师",
      sortOptions: jacketSortOptions(resources),
      facets: [...listFacets, ...rangeFacets],
    };
  }
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
    facets: facetKeys.map(({ key, label }) => ({ key, label, options: facetOptions(resources, key, game) })),
  };
}

function baseSortOptions(): CategoryBrowseSortOption[] {
  return [
    { value: "default", label: "默认排序" },
    { value: "title-asc", label: "名称 A-Z" },
    { value: "title-desc", label: "名称 Z-A" },
  ];
}

function jacketSortOptions(resources: PublicResource[]): CategoryBrowseSortOption[] {
  const options = [...baseSortOptions(), { value: "artist-asc" as const, label: "曲师 A-Z" }, { value: "artist-desc" as const, label: "曲师 Z-A" }];
  if (resources.some((resource) => resourceDateValue(resource) !== undefined)) {
    options.push({ value: "updated-desc", label: "更新日期：新 → 旧" }, { value: "updated-asc", label: "更新日期：旧 → 新" });
  }
  if (resources.some((resource) => numericFacetValue(resource, "bpm") !== undefined)) {
    options.push({ value: "bpm-desc", label: "BPM：高 → 低" }, { value: "bpm-asc", label: "BPM：低 → 高" });
  }
  return options;
}

function facetDefinitions(game: GameId, category: string): Array<{ key: string; label: string }> {
  if (game === "arcaea" && category === "story-cg") return [{ key: "type", label: "剧情类型" }, { key: "section", label: "篇章" }, { key: "path", label: "剧情路径" }, { key: "chapter", label: "章节" }];
  if (game === "arcaea" && category === "story-texture") return [{ key: "entry", label: "剧情 Entry" }];
  if (game === "arcaea" && category === "sticker") return [{ key: "locale", label: "语言" }];
  if (game === "phigros" && category === "pack-cover") return [{ key: "kind", label: "封面类型" }];
  return [];
}

function facetOptions(resources: PublicResource[], key: string, game?: GameId): CategoryBrowseFacetOption[] {
  const values = new Set<string>();
  for (const resource of resources) for (const value of resource.facets?.[key] ?? []) values.add(value);
  const orderedValues = [...values].filter((value) => key !== "level" || game !== "paradigm-reboot" || /^\d+(?:\+)?$/u.test(value));
  if (!(game === "arcaea" && ["type", "section", "path"].includes(key))) orderedValues.sort((left, right) => compareFacetValues(left, right, key, game));
  return orderedValues
    .map((value) => ({
      value,
      label: key === "chart"
        ? displayFilterDifficultyLabel(value, game ?? resources[0]?.game)
        : key === "version"
          ? formatVersionFacet(value)
          : value,
    }));
}

function compareFacetValues(left: string, right: string, key: string, game?: GameId): number {
  if (game === "rotaeno" && key === "chart") return compareOrderedValues(left, right, ROTAENO_CHART_ORDER);
  if (game === "paradigm-reboot" && key === "chart") return compareOrderedValues(left, right, PARADIGM_CHART_ORDER);
  if ((game === "rotaeno" || game === "paradigm-reboot") && key === "level") return compareRotaenoLevels(left, right);
  if (game === "rotaeno" && key === "constant") return compareNumericFacetValues(left, right);
  if (game === "phigros" && key === "kind") return compareOrderedValues(left, right, PHIGROS_PACK_KIND_ORDER);
  return compareNaturalText(left, right);
}

function compareOrderedValues(left: string, right: string, order: readonly string[]): number {
  const leftIndex = order.indexOf(left);
  const rightIndex = order.indexOf(right);
  if (leftIndex !== -1 || rightIndex !== -1) return (leftIndex === -1 ? order.length : leftIndex) - (rightIndex === -1 ? order.length : rightIndex);
  return compareNaturalText(left, right);
}

function compareRotaenoLevels(left: string, right: string): number {
  const leftMatch = /^(\d+)(\+)?$/u.exec(left);
  const rightMatch = /^(\d+)(\+)?$/u.exec(right);
  if (leftMatch && rightMatch) {
    const numericDifference = Number(leftMatch[1]) - Number(rightMatch[1]);
    if (numericDifference !== 0) return numericDifference;
    return Number(Boolean(leftMatch[2])) - Number(Boolean(rightMatch[2]));
  }
  if (leftMatch) return -1;
  if (rightMatch) return 1;
  return compareNaturalText(left, right);
}

function compareNumericFacetValues(left: string, right: string): number {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  const leftIsNumeric = Number.isFinite(leftNumber);
  const rightIsNumeric = Number.isFinite(rightNumber);
  if (leftIsNumeric && rightIsNumeric) return leftNumber - rightNumber || compareNaturalText(left, right);
  if (leftIsNumeric) return -1;
  if (rightIsNumeric) return 1;
  return compareNaturalText(left, right);
}

function facetRange(resources: PublicResource[], key: string, preferredStep?: number): CategoryBrowseFacetRange | undefined {
  const values = resources.flatMap((resource) => resource.facets?.[key] ?? []).flatMap((value) => numericFacetValues(value));
  if (values.length < 2) return undefined;
  const step = preferredStep ?? (values.every((value) => Number.isInteger(value)) ? 1 : 0.1);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const min = Number((Math.floor(rawMin / step) * step).toFixed(4));
  const max = Number((Math.ceil(rawMax / step) * step).toFixed(4));
  if (min >= max) return undefined;
  return { min, max, step };
}

function numericFacetValue(resource: PublicResource, key: string): number | undefined {
  const values = resource.facets?.[key] ?? (resource.metadata[key] === undefined ? [] : [String(resource.metadata[key])]);
  return Math.max(...values.flatMap((value) => numericFacetValues(value)), Number.NEGATIVE_INFINITY) === Number.NEGATIVE_INFINITY
    ? undefined
    : Math.max(...values.flatMap((value) => numericFacetValues(value)));
}

function numericFacetValues(value: string): number[] {
  return [...value.matchAll(/\d+(?:\.\d+)?/gu)].map((match) => Number(match[0])).filter((number) => Number.isFinite(number));
}

function resourceDateValue(resource: PublicResource): number | undefined {
  const value = resource.facets?.updateDate?.[0] ?? resource.metadata.updateDate;
  if (typeof value === "string") {
    const timestamp = Date.parse(value.replaceAll("/", "-"));
    if (Number.isFinite(timestamp)) return timestamp;
  }
  const version = resource.metadata.updateVersion;
  if (typeof version === "string") {
    const match = [...version.matchAll(/(20\d{2})[\/-](\d{1,2})[\/-](\d{1,2})/gu)].at(-1);
    if (match) {
      const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
      if (Number.isFinite(timestamp)) return timestamp;
    }
  }
  return undefined;
}

function formatVersionFacet(value: string): string {
  return value.split(",").map((part) => part.trim().replace(/^ver\.?\s*/iu, "").replace(/\s*\([^)]*\)$/u, "")).filter(Boolean).join(", ") || value;
}

function sortSemanticResources(resources: PublicResource[]): PublicResource[] {
  return [...resources].sort((left, right) => {
    const leftOrder = left.sortOrder ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.sortOrder ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || compareNaturalText(left.displayTitle, right.displayTitle) || left.resourceId.localeCompare(right.resourceId, "en");
  });
}

function toSemanticSearchEntry(resource: PublicResource, previous?: PublicSearchEntry): PublicSearchEntry {
  const keywords = new Set(previous?.keywords ?? []);
  for (const value of resource.searchTerms ?? []) keywords.add(value);
  if (resource.subtitle) keywords.add(resource.subtitle);
  for (const badge of resource.badges ?? []) keywords.add(badge);
  for (const value of Object.values(resource.metadata)) keywords.add(String(value));
  for (const values of Object.values(resource.facets ?? {})) for (const value of values) keywords.add(value);
  for (const chart of resource.charts ?? []) {
    keywords.add(chart.difficulty);
    if (chart.level) keywords.add(chart.level);
    if (chart.constant) keywords.add(chart.constant);
    if (chart.title) keywords.add(chart.title);
    if (chart.artist) keywords.add(chart.artist);
    if (chart.noter) keywords.add(chart.noter);
  }
  return {
    resourceId: resource.resourceId,
    route: resource.route,
    title: resource.displayTitle,
    game: resource.game,
    category: resource.category,
    categoryLabel: resource.categoryLabel,
    ...(resource.artist ? { artist: resource.artist } : {}),
    keywords: [...keywords].filter((value) => normalizeSearchText(value)).sort(compareNaturalText),
  };
}

export function resourceCategoryLabel(resourceType: ResourceTypeId, game?: GameId): string {
  return game ? gameCategoryLabel(game, resourceType) : categoryLabel(resourceType);
}

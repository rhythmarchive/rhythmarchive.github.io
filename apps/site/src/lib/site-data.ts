import fs from "node:fs";
import path from "node:path";
import { ArcaeaBrowseProjection, ArcaeaCategoryBrowseProjection, BrowseDiagnostics, BrowseManifest, PhigrosBrowseProjection, PhigrosCategoryBrowseProjection, RizlineBrowseProjection, RizlineCategoryBrowseProjection, validateBrowseProjectionSet, validateBrowsePublicData, validateCategoryBrowseProjection, validateRizlineBrowseProjection, type ArcaeaBrowseProjectionType, type PhigrosBrowseProjectionType, type RizlineBrowseProjectionType } from "../../../../packages/domain/src/browse.js";
import { InfalsusCategoryBrowseProjection } from "../../../../packages/domain/src/browse.js";
import type { CategoryBrowseProjectionType } from "../../../../packages/domain/src/browse.js";
import { validateCatalog } from "../../../../packages/domain/src/validation.js";
import type { Catalog } from "../../../../packages/domain/src/schema.js";
import { buildBrowseGalleryData } from "./browse-gallery";
import { applyCategoryBrowseSemantics, type CategoryBrowseProjections } from "./category-browse";
import { projectCatalog } from "./catalog-projection";
import { formatArcaeaAddedVersion } from "./public-display";
import { GAME_CONFIG, type GameId } from "./game-config";
import { sortPublicGames } from "./game-index";
import { ROS_BASE_URL } from "./site-config";
import type { PublicChart, PublicGameIndex, PublicSiteData } from "./types";

let cachedSiteData: PublicSiteData | undefined;
let cachedBrowseProjections: FormalBrowseProjections | undefined;
let cachedCategoryBrowseProjections: CategoryBrowseProjections | undefined;
let cachedBrowseGalleryBuild: ReturnType<typeof buildBrowseGalleryData> | undefined;

export type FormalBrowseProjections = {
  arcaea: ArcaeaBrowseProjectionType;
  infalsus: CategoryBrowseProjectionType;
  phigros: PhigrosBrowseProjectionType;
  rizline: RizlineBrowseProjectionType;
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

export function getSiteData(rosBaseUrl = ROS_BASE_URL): PublicSiteData {
  if (!cachedSiteData) {
    const catalog = loadFormalCatalog();
    const projected = enrichFormalBrowseMetadata(projectCatalog(catalog, rosBaseUrl), loadFormalBrowseProjections());
    cachedSiteData = applyCategoryBrowseSemantics(projected, loadCategoryBrowseProjections());
  }
  return cachedSiteData;
}
function enrichFormalBrowseMetadata(siteData: PublicSiteData, browse: FormalBrowseProjections): PublicSiteData {
  type MetadataValue = string | number | boolean;
  const valuesByResource = new Map<string, Map<string, Set<MetadataValue>>>();
  const chartsByResource = new Map<string, PublicChart[]>();
  const add = (resourceId: string | null | undefined, key: string, value: MetadataValue | null | undefined): void => {
    if (!resourceId || value === null || value === undefined || (typeof value === "string" && value.trim().length === 0)) return;
    const byKey = valuesByResource.get(resourceId) ?? new Map<string, Set<MetadataValue>>();
    const values = byKey.get(key) ?? new Set<MetadataValue>();
    values.add(value);
    byKey.set(key, values);
    valuesByResource.set(resourceId, byKey);
  };
  const addCharts = (resourceId: string | null | undefined, charts: PublicChart[]): void => {
    if (!resourceId || charts.length === 0) return;
    const previous = chartsByResource.get(resourceId) ?? [];
    const merged = new Map(previous.map((chart) => [chartKey(chart), chart]));
    for (const chart of charts) merged.set(chartKey(chart), chart);
    chartsByResource.set(resourceId, [...merged.values()]);
  };

  const arcaeaCharts = (charts: ArcaeaBrowseProjectionType["songs"][number]["charts"]): PublicChart[] => charts.map((chart) => ({
    difficulty: chart.difficultyClass,
    level: chart.displayLevel,
    ...(chart.title ? { title: chart.title } : {}),
    ...(chart.artist ? { artist: chart.artist } : {}),
    available: true,
    status: "available",
  }));
  const phigrosCharts = (charts: PhigrosBrowseProjectionType["tracks"][number]["charts"]): PublicChart[] => charts.map((chart) => {
    const available = chart.structurallyPresent && !chart.errorVariant;
    return {
      difficulty: chart.difficultyClass,
      available,
      status: chart.errorVariant ? "error" : chart.difficultyClass === "Legacy" ? "legacy" : available ? "available" : "unavailable",
    };
  });

  for (const song of browse.arcaea.songs) {
    for (const artwork of song.artworks) {
      if (!artwork.resourceId) continue;
      add(artwork.resourceId, "sourceTitle", song.displayTitle);
      add(artwork.resourceId, "artist", song.artist);
      add(artwork.resourceId, "songId", song.songId);
      add(artwork.resourceId, "pack", song.pack.displayName);
      add(artwork.resourceId, "version", song.version);
      add(artwork.resourceId, "bpm", song.bpm);
      add(artwork.resourceId, "side", song.sideRaw);
      const chart = artwork.difficultyClass ? song.charts.find((candidate) => candidate.difficultyClass === artwork.difficultyClass) : undefined;
      add(artwork.resourceId, "difficulty", chart?.difficultyClass);
      add(artwork.resourceId, "difficultyTitle", chart?.title);
      add(artwork.resourceId, "difficultyArtist", chart?.artist);
      addCharts(artwork.resourceId, arcaeaCharts(song.charts));
    }
  }
  for (const special of browse.arcaea.specials) {
    for (const artwork of special.artworks) {
      if (!artwork.resourceId) continue;
      add(artwork.resourceId, "sourceTitle", special.specialTitle);
      add(artwork.resourceId, "specialYear", special.year);
      add(artwork.resourceId, "specialVersion", special.version);
      add(artwork.resourceId, "specialReleaseDate", special.releaseDate);
    }
  }
  for (const track of browse.phigros.tracks) {
    add(track.artwork?.resourceId, "sourceTitle", track.displayTitle);
    add(track.artwork?.resourceId, "artist", track.displayArtist);
    addCharts(track.artwork?.resourceId, phigrosCharts(track.charts));
  }
  for (const song of browse.rizline.songs) {
    for (const artwork of song.artworks) {
      add(artwork.resourceId, "sourceTitle", song.displayTitle);
      add(artwork.resourceId, "artist", song.musicArtist);
      add(artwork.resourceId, "musicArtist", song.musicArtist);
      add(artwork.resourceId, "songId", song.songId);
      add(artwork.resourceId, "illustrator", song.illustrator);
      add(artwork.resourceId, "disc", song.disc);
      add(artwork.resourceId, "trackSeries", song.trackSeries.map((series) => series.name).join(" · "));
    }
  }

  const unique = (byKey: Map<string, Set<MetadataValue>> | undefined, key: string): MetadataValue | undefined => {
    const values = byKey?.get(key);
    return values?.size === 1 ? [...values][0] : undefined;
  };
  const resources = siteData.resources.map((resource) => {
    const byKey = valuesByResource.get(resource.resourceId);
    const metadata = { ...resource.metadata };
    for (const key of ["artist", "pack", "version", "bpm", "side", "songId", "difficulty", "difficultyTitle", "difficultyArtist", "specialYear"]) {
      const value = unique(byKey, key);
      if (value !== undefined) metadata[key] = value;
    }
    const specialVersion = unique(byKey, "specialVersion");
    if (specialVersion !== undefined) metadata.version = specialVersion;
    const specialReleaseDate = unique(byKey, "specialReleaseDate");
    if (specialReleaseDate !== undefined) metadata.releaseDate = specialReleaseDate;
    if (resource.game === "arcaea" && typeof metadata.version === "string") metadata.version = formatArcaeaAddedVersion(metadata.version);
    const charts = chartsByResource.get(resource.resourceId) ?? resource.charts ?? (resource.resourceType === "jacket" ? [] : undefined);
    const availableCharts = (charts ?? [])
      .filter((chart) => chart.available !== false && chart.status !== "error" && chart.status !== "legacy");
    const chartFacetValues = [...new Set([...availableCharts, ...(resource.specialCharts ?? []).filter((chart) => chart.available !== false && chart.status !== "error" && chart.status !== "legacy")].map((chart) => chart.difficulty))];
    const facets = { ...resource.facets };
    if (chartFacetValues.length > 0) facets.chart = chartFacetValues;
    if (resource.game === "rotaeno") {
      const levelFacetValues = [...new Set(availableCharts.map((chart) => chart.level).filter((value): value is string => Boolean(value)))];
      const constantFacetValues = [...new Set(availableCharts.map((chart) => chart.constant).filter((value): value is string => Boolean(value)))];
      if (levelFacetValues.length > 0) facets.level = levelFacetValues;
      if (constantFacetValues.length > 0) facets.constant = constantFacetValues;
    }
    const sourceTitle = unique(byKey, "sourceTitle");
    const difficulty = unique(byKey, "difficulty");
    const difficultyTitle = unique(byKey, "difficultyTitle");
    const displayTitle = resource.resourceType === "jacket"
      && typeof difficulty === "string"
      && typeof difficultyTitle === "string"
      ? difficultyTitle
      : sourceTitle;
    const artist = unique(byKey, "artist");
    return {
      ...resource,
      ...(resource.resourceType === "jacket" && typeof displayTitle === "string" ? { displayTitle } : {}),
      ...(typeof artist === "string" ? { artist } : {}),
      ...(resource.resourceType === "jacket" ? {
        charts: charts ?? [],
        chartDataStatus: (charts ?? []).length > 0 || (resource.specialCharts ?? []).length > 0 ? "available" as const : "unavailable" as const,
      } : {}),
      ...(Object.keys(facets).length > 0 ? { facets } : {}),
      metadata,
    };
  });
  const resourcesById = new Map(resources.map((resource) => [resource.resourceId, resource]));
  const galleries = Object.fromEntries(Object.entries(siteData.galleries).map(([key, items]) => [key, items.map((item) => resourcesById.get(item.resourceId) ?? item)]));
  const previousSearch = new Map(siteData.searchIndex.map((entry) => [entry.resourceId, entry]));
  const searchIndex = resources.map((resource) => {
    const previous = previousSearch.get(resource.resourceId);
    const keywords = new Set(previous?.keywords ?? []);
    keywords.add(resource.displayTitle);
    if (resource.artist) keywords.add(resource.artist);
    for (const value of Object.values(resource.metadata)) keywords.add(String(value));
    for (const chart of [...(resource.charts ?? []), ...(resource.specialCharts ?? [])]) {
      keywords.add(chart.difficulty);
      if (chart.level) keywords.add(chart.level);
      if (chart.notes !== undefined) keywords.add(String(chart.notes));
      if (chart.constant) keywords.add(chart.constant);
      if (chart.title) keywords.add(chart.title);
      if (chart.artist) keywords.add(chart.artist);
    }
    return {
      resourceId: resource.resourceId,
      route: resource.route,
      title: resource.displayTitle,
      game: resource.game,
      category: resource.category,
      categoryLabel: resource.categoryLabel,
      ...(resource.artist ? { artist: resource.artist } : {}),
      keywords: [...keywords].filter((value) => value.trim().length > 0).sort((left, right) => left.localeCompare(right, "zh-CN")),
    };
  });
  return { ...siteData, resources, searchIndex, galleries };
}

function chartKey(chart: PublicChart): string {
  return [chart.difficulty, chart.level ?? "", chart.notes ?? "", chart.constant ?? "", chart.title ?? "", chart.artist ?? "", chart.source ?? "", chart.status ?? ""].join("|");
}

export function loadCategoryBrowseProjections(): CategoryBrowseProjections {
  if (cachedCategoryBrowseProjections) return cachedCategoryBrowseProjections;
  const catalog = loadFormalCatalog();
  const arcaea = parseCategoryBrowseFile("arcaea-semantics.json", ArcaeaCategoryBrowseProjection);
  const infalsus = parseCategoryBrowseFile("infalsus-semantics.json", InfalsusCategoryBrowseProjection);
  const phigros = parseCategoryBrowseFile("phigros-semantics.json", PhigrosCategoryBrowseProjection);
  const rizline = parseCategoryBrowseFile("rizline-semantics.json", RizlineCategoryBrowseProjection);
  const arcaeaValidation = validateCategoryBrowseProjection(arcaea, catalog);
  if (!arcaeaValidation.success) throw new Error(`Arcaea semantic Browse failed runtime validation: ${arcaeaValidation.issues.slice(0, 5).join("; ")}`);
  const phigrosValidation = validateCategoryBrowseProjection(phigros, catalog);
  if (!phigrosValidation.success) throw new Error(`Phigros semantic Browse failed runtime validation: ${phigrosValidation.issues.slice(0, 5).join("; ")}`);
  const infalsusValidation = validateCategoryBrowseProjection(infalsus, catalog);
  if (!infalsusValidation.success) throw new Error("In Falsus semantic Browse failed runtime validation: " + infalsusValidation.issues.slice(0, 5).join("; "));
  const rizlineValidation = validateCategoryBrowseProjection(rizline, catalog);
  const infalsusPublicDataIssues = validateBrowsePublicData(infalsus);
  if (infalsusPublicDataIssues.length > 0) throw new Error(`In Falsus semantic Browse contains local or sensitive data: ${infalsusPublicDataIssues.slice(0, 5).join("; ")}`);
  if (!rizlineValidation.success) throw new Error("Rizline semantic Browse failed runtime validation: " + rizlineValidation.issues.slice(0, 5).join("; "));
  const publicDataIssues = validateBrowsePublicData({ arcaea, phigros, rizline, infalsus });
  if (publicDataIssues.length > 0) throw new Error(`Semantic Browse contains local or sensitive data: ${publicDataIssues.slice(0, 5).join("; ")}`);
  cachedCategoryBrowseProjections = { arcaea, phigros, rizline, infalsus };
  return cachedCategoryBrowseProjections;
}

export function loadFormalBrowseProjections(): FormalBrowseProjections {
  if (cachedBrowseProjections) return cachedBrowseProjections;

  const catalog = loadFormalCatalog();
  const result = {
    infalsus: parseFormalBrowseFile("infalsus.json", InfalsusCategoryBrowseProjection),
    arcaea: parseFormalBrowseFile("arcaea.json", ArcaeaBrowseProjection),
    phigros: parseFormalBrowseFile("phigros.json", PhigrosBrowseProjection),
    rizline: parseFormalBrowseFile("rizline.json", RizlineBrowseProjection),
    manifest: parseFormalBrowseFile("manifest.json", BrowseManifest),
    diagnostics: parseFormalBrowseFile("diagnostics.json", BrowseDiagnostics),
  };
  const infalsusValidation = validateCategoryBrowseProjection(result.infalsus, catalog);
  if (!infalsusValidation.success) throw new Error("In Falsus Browse Projection failed runtime validation: " + infalsusValidation.issues.slice(0, 5).join("; "));
  const validation = validateBrowseProjectionSet({ arcaea: result.arcaea, phigros: result.phigros, manifest: result.manifest, diagnostics: result.diagnostics }, catalog);
  if (!validation.success) throw new Error(`Formal Browse Projection failed runtime validation: ${validation.issues.slice(0, 5).join("; ")}`);
  const rizlineValidation = validateRizlineBrowseProjection(result.rizline, catalog);
  if (!rizlineValidation.success) throw new Error("Rizline Browse Projection failed runtime validation: " + rizlineValidation.issues.slice(0, 5).join("; "));
  const publicDataIssues = validateBrowsePublicData(result);
  if (publicDataIssues.length > 0) throw new Error(`Formal Browse Projection contains local or sensitive data: ${publicDataIssues.slice(0, 5).join("; ")}`);

  cachedBrowseProjections = { arcaea: result.arcaea, phigros: result.phigros, rizline: result.rizline, infalsus: result.infalsus };
  return cachedBrowseProjections;
}

export function getBrowseGalleryBuild(): ReturnType<typeof buildBrowseGalleryData> {
  cachedBrowseGalleryBuild ??= buildBrowseGalleryData(getSiteData(), loadFormalBrowseProjections());
  return cachedBrowseGalleryBuild;
}

export function getPublicNavigationGames(): PublicGameIndex[] {
  const siteData = getSiteData();
  const browseBuild = getBrowseGalleryBuild();
  const jacketCounts = Object.fromEntries(
    (Object.keys(GAME_CONFIG) as GameId[]).map((game) => [game, game === "rotaeno" ? (siteData.galleries[game + "/jacket"]?.length ?? 0) : browseBuild[game].items.length]),
  ) as Record<GameId, number>;

  const navigationGames = siteData.games.filter((game) => game.count > 0).map((game) => {
    const categories = game.categories.map((category) => category.slug === "jacket"
      ? { ...category, count: jacketCounts[game.slug] }
      : category);
    return {
      ...game,
      categories,
      featuredCategories: game.featuredCategories.map((category) => categories.find((candidate) => candidate.slug === category.slug) ?? category),
    };
  });
  return sortPublicGames(navigationGames);
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

function parseCategoryBrowseFile<T>(filename: string, schema: { parse: (value: unknown) => T }): T {
  return schema.parse(JSON.parse(fs.readFileSync(findWorkspaceFile("catalog", "browse", filename), "utf8")) as unknown);
}

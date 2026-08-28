import type { AssetObject, Catalog, Rendition, Resource, Variant } from "../../../../packages/domain/src/schema.js";
import { categoryOrderIndex, displayVariantLabel, gameCategoryLabel, GAME_CONFIG, type GameId, type ResourceTypeId } from "./game-config";
import { formatArcaeaAddedVersion, normalizePublicDisplay } from "./public-display";
import { normalizeSearchText } from "./search";
import { sortPublicGames } from "./game-index";
import type { PublicAsset, PublicCategory, PublicChart, PublicDownload, PublicGameIndex, PublicPreview, PublicResource, PublicSearchEntry, PublicSiteData, PublicVariant } from "./types";
import { objectUrl } from "./url";

const PUBLIC_METADATA_KEYS = new Set([
  "artist",
  "pack",
  "packName",
  "packDisplayName",
  "side",
  "version",
  "releaseDate",
  "bpm",
  "length",
  "updateVersion",
  "updateDate",
  "metadataStatus",
  "characterName",
  "characterEnglishName",
  "characterChineseName",
  "characterJapaneseName",
  "characterKoreanName",
  "characterVariant",
  "characterVersionFrom",
  "difficulty",
  "difficultyTitle",
  "difficultyArtist",
  "storyPathTitle",
  "storyType",
  "storyAct",
  "storyChapter",
  "storyEntry",
  "relatedSongTitle",
  "relatedSongId",
  "songId",
  "specialYear",
  "specialArtId",
  "musicArtist",
  "illustrator",
  "trackSeries",
  "jacketIllustrator",
  "seriesName",
  "disc",
  "character",
  "characterName",
  "layout",
  "layoutId",
  "songId",
  "gameVersion",
  "relatedSong",
  "relatedSongs",
  "collaborationPartner",
  "event",
  "collaboration",
  "hasOfficialStaticRender",
  "isRuntimeComposite",
  "componentRelations",
  "description",
  "rizcardId",
]);

const PUBLIC_HIDDEN_RESOURCE_TYPES = new Set<ResourceTypeId>(["story-texture", "rizcard"]);

const ARCAEA_STORY_UI_EXACT_FILES = new Set([
  "act-bg.jpg",
  "act-title-backing.png",
  "act1-part1.png",
  "act1-part2.png",
  "act1-part3.png",
  "act2-part1.png",
  "act2-part2.png",
  "complete-banner.png",
  "completion-backing.png",
  "continue-btn.png",
  "corner-btn.png",
  "corner-btn-right.png",
  "partner-btn.png",
  "arrow_cover.png",
  "bottom_black.png",
  "top_line.png",
  "button_back.png",
  "button_continue.png",
  "button_finish.png",
  "button_next_chapter.png",
  "story_pack_divider_horizontal.png",
  "story_unlock_corner.png",
  "story_ex_line.png",
]);

function isPromotedArcaeaStoryCg(resource: Resource): boolean {
  return resource.game === "arcaea" && resource.resourceType === "story-texture" && resource.metadata.storyVisualKind === "vn-cg";
}

function arcaeaStoryUiFilename(resource: Resource): string | undefined {
  if (resource.game !== "arcaea" || resource.resourceType !== "story-texture" || resource.lifecycle.status !== "published") return undefined;
  const sourcePath = resource.provenance
    .map((provenance) => provenance.sourceRelativePath.replaceAll("\\", "/"))
    .find((candidate) => candidate.includes("/img/story/") || candidate.endsWith("/img/story_ex_line.png"));
  if (!sourcePath) return undefined;
  const filename = sourcePath.split("/").at(-1);
  if (!filename || /(?:[_-]pressed|_disabled)\.png$/iu.test(filename)) return undefined;
  if (ARCAEA_STORY_UI_EXACT_FILES.has(filename) || /^(?:entry_|cell[_-])[a-z0-9_-]+\.png$/iu.test(filename)) return filename;
  return undefined;
}

function isArcaeaStoryUiResource(resource: Resource): boolean {
  return Boolean(arcaeaStoryUiFilename(resource));
}

function isPublicHiddenResource(resource: Resource): boolean {
  if (resource.resourceType === "startup") return resource.game !== "rotaeno";
  if (resource.resourceType === "story-texture") return !isPromotedArcaeaStoryCg(resource);
  return PUBLIC_HIDDEN_RESOURCE_TYPES.has(resource.resourceType);
}

function isPublicCatalogResource(resource: Resource): boolean {
  return resource.lifecycle.status === "published" && !isPublicHiddenResource(resource);
}
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
  const phigrosAprilFoolsYear = inferPhigrosAprilFoolsYear(catalog);
  const publicCatalogResources = catalog.resources.filter(isPublicCatalogResource);

  const resources = publicCatalogResources
    .map((resource) => projectResource(resource, variantsByResource.get(resource.id) ?? [], renditionsByVariant, objectsById, rosBaseUrl, phigrosAprilFoolsYear))
    .sort(compareResources);

  const games = sortPublicGames((Object.keys(GAME_CONFIG) as GameId[]).map((game) => {
    const gameResources = resources.filter((resource) => resource.game === game);
    const sourceGameResources = publicCatalogResources.filter((resource) => resource.game === game);
    const categories = buildCategories(game, gameResources);
    return {
      slug: game,
      displayName: GAME_CONFIG[game].displayName,
      count: gameResources.length,
      ...projectGameActivity(sourceGameResources),
      categories,
      featuredCategories: GAME_CONFIG[game].featuredCategories
        .map((slug) => categories.find((category) => category.slug === slug))
        .filter((category): category is PublicCategory => Boolean(category)),
    } satisfies PublicGameIndex;
  }));

  const galleries: Record<string, PublicResource[]> = {};
  for (const game of games) {
    const gameResources = resources.filter((resource) => resource.game === game.slug);
    galleries[galleryKey(game.slug, "all")] = gameResources;
    for (const category of game.categories) galleries[galleryKey(game.slug, category.slug)] = gameResources.filter((resource) => resource.category === category.slug);
  }

  const sourceResourcesById = new Map(catalog.resources.map((resource) => [resource.id, resource]));
  const searchIndex = resources.map((resource) => toSearchEntry(resource, sourceResourcesById.get(resource.resourceId)));
  return {
    generatedAt: catalog.generatedAt,
    resources,
    games,
    searchIndex,
    galleries,
    storyUi: {
      arcaea: projectArcaeaStoryUi(catalog, variantsByResource, renditionsByVariant, objectsById, rosBaseUrl, phigrosAprilFoolsYear),
    },
  };
}

function projectArcaeaStoryUi(
  catalog: Catalog,
  variantsByResource: Map<string, Variant[]>,
  renditionsByVariant: Map<string, Rendition[]>,
  objectsById: Map<string, AssetObject>,
  rosBaseUrl: string,
  phigrosAprilFoolsYear?: number,
): Record<string, PublicResource> {
  const candidates = catalog.resources
    .filter(isArcaeaStoryUiResource)
    .map((resource) => {
      const key = arcaeaStoryUiFilename(resource);
      if (!key) return undefined;
      return {
        key,
        resource,
        current: resource.provenance.some((provenance) => provenance.sourceRelativePath.replaceAll("\\", "/").includes("Arcaea/current-apk/")),
      };
    })
    .filter((candidate): candidate is { key: string; resource: Resource; current: boolean } => Boolean(candidate))
    .sort((left, right) => Number(right.current) - Number(left.current) || left.key.localeCompare(right.key, "en") || left.resource.id.localeCompare(right.resource.id, "en"));
  const output: Record<string, PublicResource> = {};
  for (const candidate of candidates) {
    if (output[candidate.key]) continue;
    output[candidate.key] = projectResource(
      candidate.resource,
      variantsByResource.get(candidate.resource.id) ?? [],
      renditionsByVariant,
      objectsById,
      rosBaseUrl,
      phigrosAprilFoolsYear,
    );
  }
  return output;
}

function projectGameActivity(resources: Resource[]): Pick<PublicGameIndex, "contentVersion" | "lastUpdatedAt"> {
  let latestTimestamp = -1;
  let lastUpdatedAt: string | undefined;
  for (const resource of resources) {
    const timestamp = Date.parse(resource.lifecycle.updatedAt);
    if (!Number.isFinite(timestamp) || timestamp <= latestTimestamp) continue;
    latestTimestamp = timestamp;
    lastUpdatedAt = resource.lifecycle.updatedAt;
  }
  if (!lastUpdatedAt || latestTimestamp < 0) return {};

  const versions = new Set<string>();
  for (const resource of resources) {
    if (Date.parse(resource.lifecycle.updatedAt) !== latestTimestamp) continue;
    for (const provenance of resource.provenance) {
      const version = provenance.gameVersion?.trim();
      if (version) versions.add(version);
    }
  }
  const [contentVersion] = versions;
  return {
    lastUpdatedAt,
    ...(versions.size === 1 && contentVersion ? { contentVersion } : {}),
  };
}

function projectResource(resource: Resource, variants: Variant[], renditionsByVariant: Map<string, Rendition[]>, objectsById: Map<string, AssetObject>, rosBaseUrl: string, phigrosAprilFoolsYear?: number): PublicResource {
  const projectedVariants = variants
    .map((variant) => projectVariant(variant, renditionsByVariant.get(variant.id) ?? [], objectsById, rosBaseUrl))
    .sort((a, b) => Number(Boolean(b.preferred)) - Number(Boolean(a.preferred)) || a.label.localeCompare(b.label, "en") || a.variantId.localeCompare(b.variantId));
  const active = projectedVariants.find((variant) => variant.preferred) ?? projectedVariants[0];
  const original = active?.original;
  const upscaled = active?.upscaled;
  const display = normalizePublicDisplay(resource, resource.game === "rotaeno" ? "Rotaeno \u56fe\u7247\u8d44\u6e90\uff08\u540d\u79f0\u5f85\u6838\u5b9e\uff09" : original?.downloadFilename);
  const metadata = formatPublicMetadata(resource.game, { ...pickPublicMetadata(resource), ...filterPublicMetadata(display.metadata), ...derivedPublicMetadata(resource, phigrosAprilFoolsYear) });
  const artist = display.artist ?? (typeof metadata.artist === "string" ? metadata.artist : undefined);
  const charts = publicChartsFromMetadata(resource);
  const specialCharts = publicSpecialChartsFromMetadata(resource);
  const promotedArcaeaStoryCg = isPromotedArcaeaStoryCg(resource);

  return {
    resourceId: resource.id,
    route: `/r/${encodeURIComponent(resource.id)}/`,
    game: resource.game,
    resourceType: resource.resourceType,
    category: promotedArcaeaStoryCg ? "story-cg" : publicCategorySlug(resource.game, resource.resourceType),
    categoryLabel: promotedArcaeaStoryCg ? "剧情 CG" : publicCategoryLabel(resource.game, resource.resourceType, metadata),
    displayTitle: display.title || (resource.game === "rotaeno" ? "Rotaeno \u56fe\u7247\u8d44\u6e90\uff08\u540d\u79f0\u5f85\u6838\u5b9e\uff09" : original?.downloadFilename || "\u672a\u547d\u540d\u8d44\u6e90"),
    ...(artist ? { artist } : {}),
    metadata,
    ...(resource.resourceType === "jacket" ? {
      charts,
      ...(specialCharts.length > 0 ? { specialCharts } : {}),
      chartDataStatus: charts.length > 0 || specialCharts.length > 0 ? "available" as const : "unavailable" as const,
    } : {}),
    variants: projectedVariants,
    preview: active?.preview ?? emptyPreview(),
    ...(original ? { original, downloadFilename: original.downloadFilename, mime: original.mime, sizeBytes: original.sizeBytes } : {}),
    ...(upscaled ? { upscaled } : {}),
  };
}

const INFALSUS_CHART_DIFFICULTIES: Record<string, string> = {
  "1": "MIN",
  "2": "EVO",
  "4": "ULT",
  "8": "FBD",
};

const ROTAENO_CHART_DIFFICULTIES = ["I", "II", "III", "IV", "IV_Alpha"] as const;
const ROTAENO_CHART_SOURCES = ["apk", "wiki", "merged"] as const;

function publicChartsFromMetadata(resource: Resource): PublicChart[] {
  if (resource.resourceType !== "jacket") return [];
  const rawCharts = resource.metadata.charts;
  if (!Array.isArray(rawCharts)) return [];
  if (resource.game === "rotaeno") {
    return rawCharts
      .flatMap((candidate) => {
        if (!candidate || typeof candidate !== "object") return [];
        const chart = candidate as Record<string, unknown>;
        const difficulty = typeof chart.difficulty === "string" ? chart.difficulty.trim() : "";
        if (!(ROTAENO_CHART_DIFFICULTIES as readonly string[]).includes(difficulty)) return [];
        const level = typeof chart.level === "number" || typeof chart.level === "string" ? String(chart.level) : undefined;
        const notes = typeof chart.notes === "number" && Number.isInteger(chart.notes) && chart.notes >= 0 ? chart.notes : undefined;
        const constant = typeof chart.constant === "number" || typeof chart.constant === "string" ? String(chart.constant).trim() || undefined : undefined;
        const artist = typeof chart.artist === "string" && chart.artist.trim() ? chart.artist.trim() : undefined;
        const source = typeof chart.source === "string" && (ROTAENO_CHART_SOURCES as readonly string[]).includes(chart.source.trim())
          ? chart.source.trim() as typeof ROTAENO_CHART_SOURCES[number]
          : undefined;
        const available = typeof chart.available === "boolean" ? chart.available : true;
        return [{ difficulty, ...(level ? { level } : {}), ...(notes !== undefined ? { notes } : {}), ...(constant ? { constant } : {}), ...(artist ? { artist } : {}), ...(source ? { source } : {}), available, status: available ? "available" as const : "unavailable" as const } satisfies PublicChart];
      })
      .sort((left, right) => (ROTAENO_CHART_DIFFICULTIES.indexOf(left.difficulty as typeof ROTAENO_CHART_DIFFICULTIES[number]) - ROTAENO_CHART_DIFFICULTIES.indexOf(right.difficulty as typeof ROTAENO_CHART_DIFFICULTIES[number])) || (left.level ?? "").localeCompare(right.level ?? "") || (left.constant ?? "").localeCompare(right.constant ?? ""));
  }
  if (resource.game !== "infalsus") return [];
  return rawCharts
    .flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object") return [];
      const chart = candidate as Record<string, unknown>;
      const rawDifficulty = typeof chart.difficulty === "number"
        ? String(chart.difficulty)
        : typeof chart.difficulty === "string"
          ? chart.difficulty.trim().toUpperCase()
          : "";
      const difficulty = INFALSUS_CHART_DIFFICULTIES[rawDifficulty] ?? (["MIN", "EVO", "ULT", "FBD"].includes(rawDifficulty) ? rawDifficulty : undefined);
      if (!difficulty) return [];
      const available = typeof chart.available === "boolean" ? chart.available : true;
      const rating = typeof chart.rating === "number" || typeof chart.rating === "string" ? String(chart.rating) : undefined;
      return [{
        difficulty,
        ...(rating ? { level: rating } : {}),
        available,
        status: available ? "available" as const : "unavailable" as const,
      } satisfies PublicChart];
    })
    .sort((left, right) => (Object.values(INFALSUS_CHART_DIFFICULTIES).indexOf(left.difficulty) - Object.values(INFALSUS_CHART_DIFFICULTIES).indexOf(right.difficulty)) || left.difficulty.localeCompare(right.difficulty));
}

function publicSpecialChartsFromMetadata(resource: Resource): PublicChart[] {
  if (resource.resourceType !== "jacket" || resource.game !== "rotaeno") return [];
  const rawCharts = resource.metadata.specialCharts;
  if (!Array.isArray(rawCharts)) return [];
  return rawCharts
    .flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object") return [];
      const chart = candidate as Record<string, unknown>;
      const difficulty = typeof chart.difficulty === "string" ? chart.difficulty.trim() : "";
      if (!difficulty) return [];
      const level = typeof chart.level === "number" || typeof chart.level === "string" ? String(chart.level) : undefined;
      const notes = typeof chart.notes === "number" && Number.isInteger(chart.notes) && chart.notes >= 0 ? chart.notes : undefined;
      const constant = typeof chart.constant === "number" || typeof chart.constant === "string" ? String(chart.constant).trim() || undefined : undefined;
      const artist = typeof chart.artist === "string" && chart.artist.trim() ? chart.artist.trim() : undefined;
      const source = typeof chart.source === "string" && (ROTAENO_CHART_SOURCES as readonly string[]).includes(chart.source.trim())
        ? chart.source.trim() as typeof ROTAENO_CHART_SOURCES[number]
        : undefined;
      const available = typeof chart.available === "boolean" ? chart.available : true;
      return [{ difficulty, ...(level ? { level } : {}), ...(notes !== undefined ? { notes } : {}), ...(constant ? { constant } : {}), ...(artist ? { artist } : {}), ...(source ? { source } : {}), available, status: available ? "available" as const : "unavailable" as const } satisfies PublicChart];
    })
    .sort((left, right) => left.difficulty.localeCompare(right.difficulty) || (left.level ?? "").localeCompare(right.level ?? "") || (left.constant ?? "").localeCompare(right.constant ?? ""));
}

function formatPublicMetadata(game: GameId, metadata: Record<string, string | number | boolean>): Record<string, string | number | boolean> {
  if (game !== "arcaea" || typeof metadata.version !== "string") return metadata;
  return { ...metadata, version: formatArcaeaAddedVersion(metadata.version) };
}

function projectVariant(variant: Variant, renditions: Rendition[], objectsById: Map<string, AssetObject>, rosBaseUrl: string): PublicVariant {
  const preview = {
    small: projectPreview(renditions, "small", objectsById, rosBaseUrl),
    medium: projectPreview(renditions, "medium", objectsById, rosBaseUrl),
    large: projectPreview(renditions, "large", objectsById, rosBaseUrl),
  } satisfies PublicPreview;
  const originalRenditions = renditions.filter((rendition) => rendition.renditionType === "original" && rendition.publishable);
  const originals = originalRenditions
    .map((rendition) => projectDownload(rendition, objectsById, rosBaseUrl))
    .filter((download): download is PublicDownload => Boolean(download));
  const upscaledRendition = renditions.find((rendition) => rendition.renditionType === "upscaled" && rendition.publishable);
  const original = originals[0];
  const upscaled = upscaledRendition ? projectDownload(upscaledRendition, objectsById, rosBaseUrl) : undefined;
  const publicVariant: PublicVariant = {
    variantId: variant.id,
    label: displayVariantLabel(variant),
    preview,
    ...(variant.variantKey ? { variantKey: variant.variantKey } : {}),
    ...(variant.preferred ? { preferred: true } : {}),
    ...(variant.difficulty ? { difficulty: variant.difficulty } : {}),
    ...(original ? { original } : {}),
    ...(originals.length > 0 ? { originals } : {}),
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
  return { url: objectUrl(object.objectKey, rosBaseUrl), downloadFilename: rendition.downloadFilename, mime: object.mime, sizeBytes: object.sizeBytes, width: object.width, height: object.height };
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

function derivedPublicMetadata(resource: Resource, phigrosAprilFoolsYear?: number): Record<string, string | number | boolean> {
  if (resource.resourceType !== "phigros-april-fools") return {};
  const candidates = [resource.title, ...resource.provenance.map((entry) => entry.sourceFilename)].filter((value): value is string => Boolean(value));
  const match = candidates
    .map((value) => value.match(/\b(?:AprilFools?|Logo)[^0-9]{0,12}(20\d{2})/iu))
    .find((value): value is RegExpMatchArray => Boolean(value));
  const year = match ? Number(match[1]) : phigrosAprilFoolsYear;
  return year ? { specialYear: year } : {};
}

function inferPhigrosAprilFoolsYear(catalog: Catalog): number | undefined {
  for (const resource of catalog.resources) {
    if (resource.game !== "phigros" || resource.resourceType !== "phigros-april-fools") continue;
    const candidates = [resource.title, ...resource.provenance.map((entry) => entry.sourceFilename)].filter((value): value is string => Boolean(value));
    const match = candidates
      .map((value) => value.match(/\b(?:AprilFools?|Logo)[^0-9]{0,12}(20\d{2})/iu))
      .find((value): value is RegExpMatchArray => Boolean(value));
    if (match) return Number(match[1]);
  }
  return undefined;
}
function publicCategoryLabel(game: GameId, resourceType: ResourceTypeId, metadata: Record<string, string | number | boolean>): string {
  if (resourceType === "phigros-april-fools" && typeof metadata.specialYear === "number") return "April Fools " + metadata.specialYear;
  return gameCategoryLabel(game, resourceType);
}

function publicCategorySlug(game: GameId, resourceType: ResourceTypeId): string {
  if (game === "rizline" && resourceType === "rizcard-layout") return "rizcard";
  return resourceType;
}

function toSearchEntry(resource: PublicResource, sourceResource?: Resource): PublicSearchEntry {
  const keywordSet = new Set<string>();
  for (const [key, value] of Object.entries(resource.metadata)) {
    if (resource.game === "rotaeno" && ["songId", "packId", "relatedSongId"].includes(key)) continue;
    keywordSet.add(String(value));
  }
  for (const variant of resource.variants) keywordSet.add(variant.label);
  for (const chart of [...(resource.charts ?? []), ...(resource.specialCharts ?? [])]) {
    keywordSet.add(chart.difficulty);
    if (chart.level) keywordSet.add(chart.level);
    if (chart.notes !== undefined) keywordSet.add(String(chart.notes));
    if (chart.constant) keywordSet.add(chart.constant);
    if (chart.title) keywordSet.add(chart.title);
    if (chart.artist) keywordSet.add(chart.artist);
  }
  const provenanceKeywords: Array<string | undefined> = sourceResource?.game === "rizline" || sourceResource?.game === "rotaeno" ? [] : (sourceResource?.provenance ?? []).map((entry) => entry.sourceFilename);
  const sourceMetadataKeywords = sourceResource?.game === "rotaeno" ? [] : [sourceResource?.title, ...(sourceResource?.aliases ?? []).map((alias) => alias.value)];
  for (const value of [...sourceMetadataKeywords, ...provenanceKeywords]) {
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
  const counts = new Map<string, number>();
  for (const resource of resources) counts.set(resource.category, (counts.get(resource.category) ?? 0) + 1);
  const known: string[] = GAME_CONFIG[game].categoryOrder.filter((category) => counts.has(category));
  const unknown = [...counts.keys()].filter((category) => !known.includes(category)).sort();
  return [...known, ...unknown].map((slug) => ({ slug, label: resources.find((resource) => resource.category === slug)?.categoryLabel ?? gameCategoryLabel(game, slug as ResourceTypeId), count: counts.get(slug) ?? 0 }));
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

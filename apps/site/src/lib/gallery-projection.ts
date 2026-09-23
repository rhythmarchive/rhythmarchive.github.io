import type { BrowseGalleryData, BrowseGalleryItem, BrowseArtwork } from "./browse-gallery";
import type { PublicChart, PublicDownload, PublicPreview, PublicResource } from "./types";

const CHART_FIELDS = ["difficulty", "difficultyClass", "displayLevel", "level", "constant", "title", "artist", "available", "status", "structurallyPresent", "errorVariant"] as const;

function chartFields<T extends object>(chart: T): Partial<T> {
  return Object.fromEntries(CHART_FIELDS.flatMap((key) => key in chart ? [[key, chart[key as keyof T]]] : [])) as Partial<T>;
}

function browserPreview(preview: PublicPreview): PublicPreview {
  return { small: preview.small, medium: preview.medium, large: preview.small && preview.medium ? null : preview.large };
}

/** Only fields read by the browser's card, filter, sort and selection paths. */
export function galleryCard(resource: PublicResource) {
  const metadata = Object.fromEntries(["updateDate", "updateVersion"].flatMap((key) => resource.metadata[key] === undefined ? [] : [[key, resource.metadata[key]]]));
  return {
    resourceId: resource.resourceId,
    route: resource.route,
    game: resource.game,
    resourceType: resource.resourceType,
    displayTitle: resource.displayTitle,
    ...(resource.subtitle ? { subtitle: resource.subtitle } : {}),
    ...(resource.badges?.length ? { badges: resource.badges } : {}),
    ...(resource.searchTerms?.length ? { searchTerms: resource.searchTerms } : {}),
    ...(resource.sortOrder !== undefined ? { sortOrder: resource.sortOrder } : {}),
    ...(resource.facets ? { facets: resource.facets } : {}),
    ...(resource.artist ? { artist: resource.artist } : {}),
    metadata,
    ...(resource.charts?.length ? { charts: resource.charts.map(chartFields) as PublicChart[] } : {}),
    ...(resource.specialCharts?.length ? { specialCharts: resource.specialCharts.map(chartFields) as PublicChart[] } : {}),
    preview: browserPreview(resource.preview),
    hasUpscaled: Boolean(resource.upscaled),
    variantLabel: resource.badges?.length ? undefined : resource.variants.find((variant) => variant.label !== "默认")?.label,
  };
}

export type GalleryCard = ReturnType<typeof galleryCard>;

function browseArtwork(artwork: BrowseArtwork) {
  return {
    resourceId: artwork.resourceId,
    route: artwork.route,
    resourceType: artwork.resourceType,
    preview: browserPreview(artwork.preview),
    hasUpscaled: artwork.hasUpscaled,
    role: artwork.role,
    ...(artwork.difficultyClass ? { difficultyClass: artwork.difficultyClass } : {}),
  };
}

export function browseCard(item: BrowseGalleryItem) {
  const optionalKeys = ["subtitle", "badges", "artist", "artworkRole", "selectedArtworkDifficulty", "selectedChartDifficulty", "badge", "pack", "version", "releaseDate", "date", "orderHint", "disc", "trackSeries", "specialYear", "variantId", "variantKey", "preferred"] as const;
  const optional = Object.fromEntries(optionalKeys.filter((key) => item[key] !== undefined).map((key) => [key, item[key]]));
  return {
    resourceId: item.resourceId,
    route: item.route,
    resourceType: item.resourceType,
    preview: browserPreview(item.preview),
    hasUpscaled: item.hasUpscaled,
    key: item.key,
    game: item.game,
    recordKind: item.recordKind,
    displayTitle: item.displayTitle,
    searchTerms: item.searchTerms,
    titleAliases: item.titleAliases,
    artistAliases: item.artistAliases,
    charts: item.charts.map(chartFields),
    artworks: item.artworks.map(browseArtwork),
    sortIndex: item.sortIndex,
    ...optional,
  };
}

export function browserBrowseData(data: BrowseGalleryData) {
  return { ...data, items: data.items.map(browseCard) };
}

export function batchDownloads(resources: PublicResource[]): Record<string, { original?: PublicDownload; upscaled?: PublicDownload }> {
  return Object.fromEntries(resources.map((resource) => [resource.resourceId, {
    ...(resource.original ? { original: resource.original } : {}),
    ...(resource.upscaled ? { upscaled: resource.upscaled } : {}),
  }]));
}

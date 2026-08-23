import type {
  ArcaeaBrowseProjectionType,
  ArcaeaSongRecordType,
  PhigrosBrowseProjectionType,
  PhigrosTrackRecordType,
} from "../../../../packages/domain/src/browse.js";
import type { GameId, ResourceTypeId } from "./game-config";
import { normalizeSearchText } from "./search";
import type { PublicDownload, PublicPreview, PublicResource, PublicSiteData } from "./types";

export const BROWSE_GALLERY_SCHEMA_VERSION = 1 as const;
export const BROWSE_PAGE_SIZE = 48;

export const ARCAEA_DIFFICULTIES = ["PST", "PRS", "FTR", "BYD", "ETR"] as const;
export type ArcaeaDifficulty = (typeof ARCAEA_DIFFICULTIES)[number];

export const PHIGROS_DIFFICULTIES = ["EZ", "HD", "IN", "AT"] as const;
export type PhigrosDifficulty = (typeof PHIGROS_DIFFICULTIES)[number];

export type BrowseGame = "arcaea" | "phigros";
export type BrowseRecordKind = "song" | "track" | "special" | "archive-extra" | "unresolved-extra";
export type BrowseBadge = string;
export type BrowseArcaeaChart = ArcaeaSongRecordType["charts"][number];
export type BrowsePhigrosChart = PhigrosTrackRecordType["charts"][number];
export type BrowseChart = BrowseArcaeaChart | BrowsePhigrosChart;

export type BrowseResolvedResource = {
  resourceId: string;
  route: string;
  resourceType: ResourceTypeId;
  preview: PublicPreview;
  original?: PublicDownload;
  upscaled?: PublicDownload;
  hasUpscaled: boolean;
};

export type BrowseArtwork = BrowseResolvedResource & {
  role: string;
  difficultyClass?: ArcaeaDifficulty;
};

export type BrowseGalleryItem = BrowseResolvedResource & {
  key: string;
  game: BrowseGame;
  recordKind: BrowseRecordKind;
  displayTitle: string;
  subtitle?: string;
  badges?: string[];
  artist?: string;
  searchTerms: string[];
  titleAliases: string[];
  artistAliases: string[];
  charts: BrowseChart[];
  artworks: BrowseArtwork[];
  artworkRole?: string;
  selectedArtworkDifficulty?: ArcaeaDifficulty;
  badge?: BrowseBadge;
  songId?: string;
  pack?: string | null;
  version?: string | null;
  releaseDate?: string;
  date?: number | null;
  orderHint?: number;
  sourceIdentityCandidate?: string;
  sourceTitle?: string;
  sourceArtist?: string | null;
  specialKind?: string;
  specialYear?: number;
  sortIndex: number;
};

export type BrowseGalleryData = {
  schemaVersion: typeof BROWSE_GALLERY_SCHEMA_VERSION;
  game: BrowseGame;
  category: "jacket";
  generatedAt: string;
  items: BrowseGalleryItem[];
};

export type BrowseGallerySkippedRecord = {
  recordKind: BrowseRecordKind;
  identity: string;
  displayTitle: string;
  reason: string;
};

export type BrowseGalleryDiagnostics = {
  projectionRecords: number;
  includedItems: number;
  skipped: BrowseGallerySkippedRecord[];
};

export type BrowseGalleryBuildResult = {
  arcaea: BrowseGalleryData;
  phigros: BrowseGalleryData;
  diagnostics: {
    arcaea: BrowseGalleryDiagnostics;
    phigros: BrowseGalleryDiagnostics;
  };
};

export type ArcaeaBrowseSort = "default" | "title-asc" | "title-desc" | "artist-asc" | "version-desc" | "version-asc";
export type PhigrosBrowseSort = "default" | "title-asc" | "title-desc" | "artist-asc";

export type ArcaeaBrowseUrlState = {
  game: "arcaea";
  q: string;
  sort: ArcaeaBrowseSort;
  pack: string[];
  chart: ArcaeaDifficulty[];
  level: string[];
  version: string[];
  ai: boolean;
};

export type PhigrosBrowseUrlState = {
  game: "phigros";
  q: string;
  sort: PhigrosBrowseSort;
  chart: PhigrosDifficulty[];
};

export type BrowseUrlState = ArcaeaBrowseUrlState | PhigrosBrowseUrlState;

export type ArcaeaFacetOptions = {
  packs: string[];
  charts: ArcaeaDifficulty[];
  levels: string[];
  versions: string[];
};

export type BrowseFacetOption = { label: string; values: string[] };

export function groupBrowseFacetOptions(values: string[], formatValue: (value: string) => string = (value) => value): BrowseFacetOption[] {
  const grouped = new Map<string, string[]>();
  for (const value of values) {
    const label = formatValue(value);
    grouped.set(label, [...(grouped.get(label) ?? []), value]);
  }
  return [...grouped].map(([label, groupedValues]) => ({ label, values: groupedValues }));
}

export type PhigrosFacetOptions = {
  charts: PhigrosDifficulty[];
};

export type BrowseFacetOptions = ArcaeaFacetOptions | PhigrosFacetOptions;

type GalleryResourceIndex = Map<string, PublicResource>;
type DiagnosticsCollector = { skipped: BrowseGallerySkippedRecord[] };

export function buildBrowseGalleryData(
  siteData: PublicSiteData,
  projections: { arcaea: ArcaeaBrowseProjectionType; phigros: PhigrosBrowseProjectionType },
): BrowseGalleryBuildResult {
  const resources = new Map(siteData.resources.map((resource) => [resource.resourceId, resource]));
  const arcaeaDiagnostics: DiagnosticsCollector = { skipped: [] };
  const phigrosDiagnostics: DiagnosticsCollector = { skipped: [] };
  const arcaeaItems = buildArcaeaItems(projections.arcaea, resources, arcaeaDiagnostics);
  const phigrosItems = buildPhigrosItems(projections.phigros, resources, phigrosDiagnostics);

  return {
    arcaea: {
      schemaVersion: BROWSE_GALLERY_SCHEMA_VERSION,
      game: "arcaea",
      category: "jacket",
      generatedAt: projections.arcaea.generatedAt,
      items: arcaeaItems,
    },
    phigros: {
      schemaVersion: BROWSE_GALLERY_SCHEMA_VERSION,
      game: "phigros",
      category: "jacket",
      generatedAt: projections.phigros.generatedAt,
      items: phigrosItems,
    },
    diagnostics: {
      arcaea: {
        projectionRecords: projections.arcaea.songs.length + projections.arcaea.specials.length + projections.arcaea.archiveExtras.length + projections.arcaea.unresolvedExtras.length,
        includedItems: arcaeaItems.length,
        skipped: arcaeaDiagnostics.skipped,
      },
      phigros: {
        projectionRecords: projections.phigros.tracks.length + projections.phigros.specials.length + projections.phigros.archiveExtras.length + projections.phigros.sourceOnlyTracks.length,
        includedItems: phigrosItems.length,
        skipped: phigrosDiagnostics.skipped,
      },
    },
  };
}

function buildArcaeaItems(
  projection: ArcaeaBrowseProjectionType,
  resources: GalleryResourceIndex,
  diagnostics: DiagnosticsCollector,
): BrowseGalleryItem[] {
  const items: BrowseGalleryItem[] = [];

  for (const [index, song] of projection.songs.entries()) {
    const artworks = song.artworks.flatMap((artwork) => {
      if (!artwork.resourceId) return [];
      const resource = resolveResource(resources, artwork.resourceId, "arcaea", ["jacket"]);
      return resource ? [{ ...toResolvedResource(resource), role: artwork.role, ...(artwork.difficultyClass ? { difficultyClass: artwork.difficultyClass } : {}) }] : [];
    });
    const selectedArtwork = artworks.find((artwork) => artwork.role === "default") ?? artworks.find((artwork) => artwork.role !== "night/special") ?? artworks[0];
    if (!selectedArtwork) {
      diagnostics.skipped.push({ recordKind: "song", identity: song.songId, displayTitle: song.displayTitle, reason: "no-resolved-artwork-resource" });
      continue;
    }
    items.push({
      ...selectedArtwork,
      key: `song:${song.songId}`,
      game: "arcaea",
      recordKind: "song",
      displayTitle: song.displayTitle,
      artist: song.artist,
      searchTerms: searchTerms([...song.searchTerms, ...song.titleAliases, ...song.artistAliases, ...song.charts.flatMap((chart) => [chart.title, chart.artist]), song.displayTitle, song.artist, song.pack.displayName]),
      titleAliases: searchTerms([...song.titleAliases, ...song.charts.map((chart) => chart.title)]),
      artistAliases: searchTerms([...song.artistAliases, ...song.charts.map((chart) => chart.artist)]),
      charts: song.charts,
      artworks,
      artworkRole: selectedArtwork.role,
      ...(selectedArtwork.difficultyClass ? { selectedArtworkDifficulty: selectedArtwork.difficultyClass } : {}),
      songId: song.songId,
      pack: song.pack.displayName,
      version: song.version,
      date: song.date,
      orderHint: song.orderHint,
      sortIndex: index,
    });
  }

  const regularCount = items.length;
  for (const [index, special] of projection.specials.entries()) {
    const artworks = special.artworks.flatMap((artwork) => {
      if (!artwork.resourceId) return [];
      const resource = resolveResource(resources, artwork.resourceId, "arcaea", ["jacket"]);
      return resource ? [{ ...toResolvedResource(resource), role: artwork.role, ...(artwork.difficultyClass ? { difficultyClass: artwork.difficultyClass } : {}) }] : [];
    });
    const selectedArtwork = artworks.find((artwork) => artwork.role === "seasonal") ?? artworks[0];
    if (!selectedArtwork) {
      diagnostics.skipped.push({ recordKind: "special", identity: special.specialId, displayTitle: special.specialTitle, reason: "no-resolved-artwork-resource" });
      continue;
    }
    items.push({
      ...selectedArtwork,
      key: `special:${special.specialId}`,
      game: "arcaea",
      recordKind: "special",
      displayTitle: special.specialTitle,
      searchTerms: searchTerms([...special.searchTerms, special.specialTitle, special.baseSongId, String(special.year)]),
      titleAliases: searchTerms([special.specialTitle]),
      artistAliases: [],
      charts: [],
      artworks,
      artworkRole: selectedArtwork.role,
      ...(selectedArtwork.difficultyClass ? { selectedArtworkDifficulty: selectedArtwork.difficultyClass } : {}),
      pack: null,
      version: special.version,
      releaseDate: special.releaseDate,
      specialYear: special.year,
      badge: "愚人节 " + special.year,
      sortIndex: regularCount + index,
    });
  }

  const extras = [
    ...projection.archiveExtras.map((extra) => ({ ...extra, recordKind: "archive-extra" as const, badge: "归档" as const })),
    ...projection.unresolvedExtras.map((extra) => ({ ...extra, recordKind: "unresolved-extra" as const, badge: "其他" as const })),
  ];
  for (const [index, extra] of extras.entries()) {
    const resource = resolveResource(resources, extra.resourceId, "arcaea", ["jacket"]);
    if (!resource) {
      diagnostics.skipped.push({ recordKind: extra.recordKind, identity: extra.resourceId, displayTitle: extra.resourceId, reason: "no-resolved-artwork-resource" });
      continue;
    }
    const artwork = { ...toResolvedResource(resource), role: extra.recordKind } satisfies BrowseArtwork;
    items.push({
      ...toResolvedResource(resource),
      key: `${extra.recordKind}:${extra.resourceId}`,
      game: "arcaea",
      recordKind: extra.recordKind,
      displayTitle: resource.displayTitle,
      ...(resource.artist ? { artist: resource.artist } : {}),
      searchTerms: searchTerms([...extra.searchTerms, resource.displayTitle, resource.artist]),
      titleAliases: searchTerms([resource.displayTitle]),
      artistAliases: resource.artist ? searchTerms([resource.artist]) : [],
      charts: [],
      artworks: [artwork],
      artworkRole: artwork.role,
      badge: extra.badge,
      sortIndex: regularCount + projection.specials.length + index,
    });
  }

  return items;
}

function buildPhigrosItems(
  projection: PhigrosBrowseProjectionType,
  resources: GalleryResourceIndex,
  diagnostics: DiagnosticsCollector,
): BrowseGalleryItem[] {
  const items: BrowseGalleryItem[] = [];

  for (const [index, track] of projection.tracks.entries()) {
    if (!track.artwork) {
      diagnostics.skipped.push({ recordKind: "track", identity: track.sourceIdentityCandidate, displayTitle: track.displayTitle, reason: "no-artwork-resource" });
      continue;
    }
    const resource = resolveResource(resources, track.artwork.resourceId, "phigros", ["jacket"]);
    if (!resource) {
      diagnostics.skipped.push({ recordKind: "track", identity: track.sourceIdentityCandidate, displayTitle: track.displayTitle, reason: "no-resolved-artwork-resource" });
      continue;
    }
    const artwork = { ...toResolvedResource(resource), role: track.artwork.role } satisfies BrowseArtwork;
    items.push({
      ...toResolvedResource(resource),
      key: `track:${track.sourceIdentityCandidate}`,
      game: "phigros",
      recordKind: "track",
      displayTitle: track.displayTitle,
      ...(track.displayArtist ? { artist: track.displayArtist } : {}),
      searchTerms: searchTerms([...track.searchTerms, track.displayTitle, track.sourceTitle, track.displayArtist, track.sourceArtist, ...track.searchAliases]),
      titleAliases: searchTerms([track.sourceTitle, ...track.searchAliases]),
      artistAliases: track.sourceArtist ? searchTerms([track.sourceArtist]) : [],
      charts: track.charts,
      artworks: [artwork],
      artworkRole: artwork.role,
      sourceIdentityCandidate: track.sourceIdentityCandidate,
      sourceTitle: track.sourceTitle,
      sourceArtist: track.sourceArtist,
      ...(track.specialKind ? { specialKind: track.specialKind } : {}),
      sortIndex: index,
    });
  }

  for (const [index, track] of projection.sourceOnlyTracks.entries()) {
    diagnostics.skipped.push({ recordKind: "track", identity: track.sourceIdentityCandidate, displayTitle: track.displayTitle, reason: "source-only-track-without-artwork-resource" });
    void index;
  }

  const currentCount = items.length;
  for (const [index, special] of projection.specials.entries()) {
    const resource = resolveResource(resources, special.artworkResourceId, "phigros", ["jacket", "phigros-april-fools"]);
    if (!resource) {
      diagnostics.skipped.push({ recordKind: "special", identity: special.specialId, displayTitle: special.displayTitle, reason: "no-resolved-artwork-resource" });
      continue;
    }
    const artwork = { ...toResolvedResource(resource), role: special.specialType } satisfies BrowseArtwork;
    items.push({
      ...toResolvedResource(resource),
      key: `special:${special.specialId}`,
      game: "phigros",
      recordKind: "special",
      displayTitle: special.displayTitle,
      searchTerms: searchTerms([...special.searchTerms, special.displayTitle, special.sourceFilename]),
      titleAliases: searchTerms([special.displayTitle, special.sourceFilename]),
      artistAliases: [],
      charts: [],
      artworks: [artwork],
      artworkRole: artwork.role,
      badge: "愚人节",
      sortIndex: currentCount + index,
    });
  }

  const extrasStart = items.length;
  for (const [index, extra] of projection.archiveExtras.entries()) {
    const resource = resolveResource(resources, extra.resourceId, "phigros", ["jacket", "phigros-april-fools"]);
    if (!resource) {
      diagnostics.skipped.push({ recordKind: "archive-extra", identity: extra.resourceId, displayTitle: extra.sourceFilename ?? extra.resourceId, reason: "no-resolved-artwork-resource" });
      continue;
    }
    const artwork = { ...toResolvedResource(resource), role: "archive" } satisfies BrowseArtwork;
    items.push({
      ...toResolvedResource(resource),
      key: `archive-extra:${extra.resourceId}`,
      game: "phigros",
      recordKind: "archive-extra",
      displayTitle: resource.displayTitle,
      ...(resource.artist ? { artist: resource.artist } : {}),
      searchTerms: searchTerms([...extra.searchTerms, resource.displayTitle, resource.artist, extra.sourceFilename]),
      titleAliases: searchTerms([resource.displayTitle, extra.sourceFilename]),
      artistAliases: resource.artist ? searchTerms([resource.artist]) : [],
      charts: [],
      artworks: [artwork],
      artworkRole: artwork.role,
      badge: "归档",
      sortIndex: extrasStart + index,
    });
  }

  return items;
}

function resolveResource(resources: GalleryResourceIndex, resourceId: string, game: BrowseGame, allowedTypes: ResourceTypeId[]): (PublicResource & { game: GameId }) | undefined {
  const resource = resources.get(resourceId);
  if (!resource || resource.game !== game || !allowedTypes.includes(resource.resourceType)) return undefined;
  return resource;
}

function toResolvedResource(resource: PublicResource): BrowseResolvedResource {
  return {
    resourceId: resource.resourceId,
    route: resource.route,
    resourceType: resource.resourceType,
    preview: resource.preview,
    ...(resource.original ? { original: resource.original } : {}),
    ...(resource.upscaled ? { upscaled: resource.upscaled } : {}),
    hasUpscaled: Boolean(resource.upscaled),
  };
}

function searchTerms(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))].sort((a, b) => normalizeSearchText(a).localeCompare(normalizeSearchText(b), "en"));
}

export function getBrowseFacetOptions(data: BrowseGalleryData): BrowseFacetOptions {
  if (data.game === "arcaea") {
    const packs = unique(data.items.flatMap((item) => item.recordKind === "song" && item.pack ? [item.pack] : []), compareText);
    const charts = ARCAEA_DIFFICULTIES.filter((difficulty) => data.items.some((item) => item.recordKind === "song" && item.charts.some((chart) => isArcaeaChart(chart) && chart.difficultyClass === difficulty)));
    const levels = unique(data.items.flatMap((item) => item.recordKind === "song" ? item.charts.filter(isArcaeaChart).map((chart) => chart.displayLevel) : []), compareDisplayLevels);
    const versions = unique(data.items.flatMap((item) => item.game === "arcaea" && item.version ? [item.version] : []), (a, b) => compareVersionStrings(b, a));
    return { packs, charts, levels, versions };
  }

  const charts = PHIGROS_DIFFICULTIES.filter((difficulty) => data.items.some((item) => item.recordKind === "track" && item.charts.some((chart) => isPhigrosChart(chart) && chart.structurallyPresent && !chart.errorVariant && chart.difficultyClass === difficulty)));
  return { charts };
}

export function selectBrowseArtwork(item: BrowseGalleryItem, selectedDifficulties: string[]): BrowseArtwork {
  for (const difficulty of difficultyOrder(item.game, selectedDifficulties)) {
    const artwork = item.artworks.find((candidate) => candidate.difficultyClass === difficulty && (candidate.role === "difficulty" || candidate.role === "permanent-byd"));
    if (artwork) return artwork;
  }
  return item.artworks.find((artwork) => artwork.role === "default" || artwork.role === "seasonal" || artwork.role === "current-track-artwork") ?? item.artworks[0] ?? {
    resourceId: item.resourceId,
    route: item.route,
    resourceType: item.resourceType,
    preview: item.preview,
    ...(item.original ? { original: item.original } : {}),
    ...(item.upscaled ? { upscaled: item.upscaled } : {}),
    hasUpscaled: item.hasUpscaled,
    role: item.artworkRole ?? "default",
    ...(item.selectedArtworkDifficulty ? { difficultyClass: item.selectedArtworkDifficulty } : {}),
  };
}

export function displayBrowseItem(item: BrowseGalleryItem, selectedDifficulties: string[]): BrowseGalleryItem {
  const artwork = selectBrowseArtwork(item, selectedDifficulties);
  const selectedChart = item.game === "arcaea" && artwork.difficultyClass
    ? item.charts.find((chart): chart is BrowseArcaeaChart => isArcaeaChart(chart) && chart.difficultyClass === artwork.difficultyClass)
    : undefined;
  return {
    ...item,
    ...artwork,
    ...(selectedChart?.title ? { displayTitle: selectedChart.title } : {}),
    ...(selectedChart?.artist ? { artist: selectedChart.artist } : {}),
    artworkRole: artwork.role,
    ...(artwork.difficultyClass ? { selectedArtworkDifficulty: artwork.difficultyClass } : {}),
  };
}

export function filterBrowseItems(items: BrowseGalleryItem[], state: BrowseUrlState): BrowseGalleryItem[] {
  const query = normalizeSearchText(state.q);
  const filtered = items.filter((item) => {
    if (query && searchRank(item, query) === undefined) return false;
    if (state.game === "arcaea") {
      if (item.pack !== undefined && state.pack.length > 0 && !state.pack.includes(item.pack ?? "")) return false;
      if (item.pack === undefined && state.pack.length > 0) return false;
      if (item.version !== undefined && state.version.length > 0 && !state.version.includes(item.version ?? "")) return false;
      if (item.version === undefined && state.version.length > 0) return false;
      if (!matchesArcaeaCharts(item, state.chart, state.level)) return false;
      if (state.ai && !displayBrowseItem(item, state.chart).hasUpscaled) return false;
    } else {
      if (!matchesPhigrosCharts(item, state.chart)) return false;
    }
    return true;
  });

  return filtered.sort((left, right) => {
    const tailDifference = compareBrowseTail(left, right);
    if (tailDifference !== 0) return tailDifference;
    if (query) {
      const rankDifference = (searchRank(left, query) ?? Number.POSITIVE_INFINITY) - (searchRank(right, query) ?? Number.POSITIVE_INFINITY);
      if (rankDifference !== 0) return rankDifference;
    }
    return compareBrowseItems(left, right, state.sort);
  });
}

function matchesArcaeaCharts(item: BrowseGalleryItem, selectedDifficulties: ArcaeaDifficulty[], selectedLevels: string[]): boolean {
  if (selectedDifficulties.length === 0 && selectedLevels.length === 0) return true;
  if (item.recordKind === "special") {
    if (selectedLevels.length > 0) return false;
    return item.artworks.some((artwork) => artwork.difficultyClass !== undefined && selectedDifficulties.includes(artwork.difficultyClass));
  }
  if (item.recordKind !== "song") return false;
  return item.charts.some((chart) => {
    if (!isArcaeaChart(chart)) return false;
    return (selectedDifficulties.length === 0 || selectedDifficulties.includes(chart.difficultyClass))
      && (selectedLevels.length === 0 || selectedLevels.includes(chart.displayLevel));
  });
}

function matchesPhigrosCharts(item: BrowseGalleryItem, selectedDifficulties: PhigrosDifficulty[]): boolean {
  if (selectedDifficulties.length === 0) return true;
  if (item.recordKind !== "track") return false;
  return item.charts.some((chart) => isPhigrosChart(chart) && chart.structurallyPresent && !chart.errorVariant && selectedDifficulties.includes(chart.difficultyClass as PhigrosDifficulty));
}

export function compareBrowseItems(left: BrowseGalleryItem, right: BrowseGalleryItem, sort: ArcaeaBrowseSort | PhigrosBrowseSort): number {
  const tailDifference = compareBrowseTail(left, right);
  if (tailDifference !== 0) return tailDifference;
  let result = 0;
  if (sort === "title-asc") result = compareText(left.displayTitle, right.displayTitle);
  else if (sort === "title-desc") result = compareText(right.displayTitle, left.displayTitle);
  else if (sort === "artist-asc") result = compareNullableText(left.artist, right.artist) || compareText(left.displayTitle, right.displayTitle);
  else if (sort === "version-desc" && left.game === "arcaea" && right.game === "arcaea") result = compareNullableVersion(right.version, left.version);
  else if (sort === "version-asc" && left.game === "arcaea" && right.game === "arcaea") result = compareNullableVersion(left.version, right.version);
  if (result !== 0) return result;
  return compareBrowseOrder(left, right);
}

function compareBrowseTail(left: BrowseGalleryItem, right: BrowseGalleryItem): number {
  const leftIsTail = left.recordKind === "archive-extra" || left.recordKind === "unresolved-extra";
  const rightIsTail = right.recordKind === "archive-extra" || right.recordKind === "unresolved-extra";
  return Number(leftIsTail) - Number(rightIsTail);
}

function compareBrowseOrder(left: BrowseGalleryItem, right: BrowseGalleryItem): number {
  const kindOrder: Record<BrowseRecordKind, number> = { song: 0, track: 0, special: 1, "archive-extra": 2, "unresolved-extra": 3 };
  const leftOrder = left.recordKind === "song" ? left.orderHint : left.sortIndex;
  const rightOrder = right.recordKind === "song" ? right.orderHint : right.sortIndex;
  const orderDifference = leftOrder === undefined && rightOrder === undefined
    ? 0
    : leftOrder === undefined
      ? 1
      : rightOrder === undefined
        ? -1
        : leftOrder - rightOrder;
  return kindOrder[left.recordKind] - kindOrder[right.recordKind]
    || (left.specialYear ?? Number.POSITIVE_INFINITY) - (right.specialYear ?? Number.POSITIVE_INFINITY)
    || orderDifference
    || compareText(left.displayTitle, right.displayTitle)
    || left.resourceId.localeCompare(right.resourceId, "en");
}

export function searchRank(item: BrowseGalleryItem, query: string): number | undefined {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return undefined;
  const title = normalizeSearchText(item.displayTitle);
  if (title === normalizedQuery) return 0;
  if (title.startsWith(normalizedQuery)) return 1;
  if (title.includes(normalizedQuery)) return 2;

  const aliases = item.titleAliases.map(normalizeSearchText);
  if (aliases.some((value) => value === normalizedQuery)) return 3;
  if (aliases.some((value) => value.startsWith(normalizedQuery))) return 4;

  const artists = [item.artist, ...item.artistAliases].filter((value): value is string => Boolean(value)).map(normalizeSearchText);
  if (artists.some((value) => value === normalizedQuery)) return 5;
  if (artists.some((value) => value.startsWith(normalizedQuery))) return 6;

  if (item.searchTerms.some((value) => normalizeSearchText(value).includes(normalizedQuery))) return 7;
  return undefined;
}

export function compareVersionStrings(left: string, right: string): number {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  if (leftParts && rightParts) {
    const length = Math.max(leftParts.length, rightParts.length);
    for (let index = 0; index < length; index += 1) {
      const leftPart = leftParts[index] ?? "0";
      const rightPart = rightParts[index] ?? "0";
      const componentDifference = compareNumericStrings(leftPart, rightPart);
      if (componentDifference !== 0) return componentDifference;
    }
    return left.localeCompare(right, "en");
  }
  return left.localeCompare(right, "en");
}

export function compareDisplayLevels(left: string, right: string): number {
  const leftMatch = /^(\d+)(\+)?$/u.exec(left);
  const rightMatch = /^(\d+)(\+)?$/u.exec(right);
  if (leftMatch && rightMatch) {
    const numericDifference = Number(leftMatch[1]) - Number(rightMatch[1]);
    if (numericDifference !== 0) return numericDifference;
    const plusDifference = Number(Boolean(leftMatch[2])) - Number(Boolean(rightMatch[2]));
    if (plusDifference !== 0) return plusDifference;
    return left.localeCompare(right, "en");
  }
  return left.localeCompare(right, "en");
}

export function defaultBrowseUrlState(game: BrowseGame): BrowseUrlState {
  return game === "arcaea"
    ? { game, q: "", sort: "default", pack: [], chart: [], level: [], version: [], ai: false }
    : { game, q: "", sort: "default", chart: [] };
}

export function parseBrowseUrlState(game: BrowseGame, input: URLSearchParams | string, items: BrowseGalleryItem[] = []): BrowseUrlState {
  const params = input instanceof URLSearchParams ? new URLSearchParams(input.toString()) : new URLSearchParams(input.replace(/^\?/u, ""));
  const options = getBrowseFacetOptions({ schemaVersion: BROWSE_GALLERY_SCHEMA_VERSION, game, category: "jacket", generatedAt: "1970-01-01T00:00:00.000Z", items } as BrowseGalleryData);
  const q = params.get("q")?.trim() ?? "";
  if (game === "arcaea") {
    const arcaeaOptions = options as ArcaeaFacetOptions;
    const sortValue = params.get("sort");
    const sort: ArcaeaBrowseSort = isArcaeaSort(sortValue) ? sortValue : "default";
    return {
      game,
      q,
      sort,
      pack: readFacetValues(params, "pack", arcaeaOptions.packs),
      chart: readFacetValues(params, "chart", arcaeaOptions.charts) as ArcaeaDifficulty[],
      level: readFacetValues(params, "level", arcaeaOptions.levels),
      version: readFacetValues(params, "version", arcaeaOptions.versions),
      ai: params.get("ai") === "1" || params.get("ai") === "true",
    };
  }

  const sortValue = params.get("sort");
  const sort: PhigrosBrowseSort = isPhigrosSort(sortValue) ? sortValue : "default";
  return { game, q, sort, chart: readFacetValues(params, "chart", (options as PhigrosFacetOptions).charts) as PhigrosDifficulty[] };
}

export function serializeBrowseUrlState(state: BrowseUrlState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.q.trim()) params.set("q", state.q.trim());
  if (state.sort !== "default") params.set("sort", state.sort);
  if (state.game === "arcaea") {
    const packs = stableValues(state.pack, compareText);
    const charts = stableValues(state.chart, (left, right) => ARCAEA_DIFFICULTIES.indexOf(left as ArcaeaDifficulty) - ARCAEA_DIFFICULTIES.indexOf(right as ArcaeaDifficulty));
    const levels = stableValues(state.level, compareDisplayLevels);
    const versions = stableValues(state.version, (left, right) => compareVersionStrings(left, right));
    if (packs.length > 0) params.set("pack", packs.join(","));
    if (charts.length > 0) params.set("chart", charts.join(","));
    if (levels.length > 0) params.set("level", levels.join(","));
    if (versions.length > 0) params.set("version", versions.join(","));
    if (state.ai) params.set("ai", "1");
  } else {
    const charts = stableValues(state.chart, (left, right) => PHIGROS_DIFFICULTIES.indexOf(left as PhigrosDifficulty) - PHIGROS_DIFFICULTIES.indexOf(right as PhigrosDifficulty));
    if (charts.length > 0) params.set("chart", charts.join(","));
  }
  return params;
}

function readFacetValues(params: URLSearchParams, name: string, allowed: string[]): string[] {
  const values = params.getAll(name).flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
  const uniqueValues = [...new Set(values)];
  if (allowed.length === 0) return uniqueValues;
  const selected = new Set(uniqueValues);
  return allowed.filter((value) => selected.has(value));
}

function isArcaeaSort(value: string | null): value is ArcaeaBrowseSort {
  return value === "default" || value === "title-asc" || value === "title-desc" || value === "artist-asc" || value === "version-desc" || value === "version-asc";
}

function isPhigrosSort(value: string | null): value is PhigrosBrowseSort {
  return value === "default" || value === "title-asc" || value === "title-desc" || value === "artist-asc";
}

function difficultyOrder(game: BrowseGame, values: string[]): string[] {
  const order = game === "arcaea" ? ARCAEA_DIFFICULTIES : PHIGROS_DIFFICULTIES;
  const selected = new Set(values);
  return order.filter((difficulty) => selected.has(difficulty));
}

function isArcaeaChart(chart: BrowseChart): chart is BrowseArcaeaChart {
  return "displayLevel" in chart;
}

function isPhigrosChart(chart: BrowseChart): chart is BrowsePhigrosChart {
  return "structurallyPresent" in chart;
}

function versionParts(value: string): string[] | undefined {
  if (!/^\d+(?:\.\d+)+$/u.test(value)) return undefined;
  return value.split(".");
}

function compareNumericStrings(left: string, right: string): number {
  const normalizedLeft = left.replace(/^0+(?=\d)/u, "");
  const normalizedRight = right.replace(/^0+(?=\d)/u, "");
  return normalizedLeft.length - normalizedRight.length || normalizedLeft.localeCompare(normalizedRight, "en");
}

function compareNullableVersion(left: string | null | undefined, right: string | null | undefined): number {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return compareVersionStrings(left, right);
}

function compareNullableText(left: string | null | undefined, right: string | null | undefined): number {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return compareText(left, right);
}

function compareText(left: string, right: string): number {
  return normalizeSearchText(left).localeCompare(normalizeSearchText(right), "en");
}

function unique<T>(values: T[], comparator: (left: T, right: T) => number): T[] {
  return [...new Set(values)].sort(comparator);
}

function stableValues(values: string[], comparator: (left: string, right: string) => number): string[] {
  return unique(values, comparator);
}


import { compareNaturalText } from "./search";

/**
 * Ordering helpers for the category gallery. They are kept free of DOM access so the
 * comparators can be unit tested directly, and so "no data" ordering stays symmetric
 * between ascending and descending sorts.
 */

export type GallerySortCard = {
  displayTitle: string;
  facets?: Record<string, string[]>;
  metadata?: Record<string, unknown>;
  charts?: Array<{ constant?: string | undefined; level?: string | undefined; available?: boolean | undefined; status?: string | undefined; structurallyPresent?: boolean | undefined; errorVariant?: boolean | undefined }>;
};

export function galleryBaseSortOptions(song = false) {
  const title = song ? "曲名" : "名称";
  return [
    { value: "default" as const, label: "默认排序" },
    { value: "title-asc" as const, label: `${title} A-Z` },
    { value: "title-desc" as const, label: `${title} Z-A` },
    ...(song ? [{ value: "artist-asc" as const, label: "曲师 A-Z" }, { value: "artist-desc" as const, label: "曲师 Z-A" }] : []),
  ];
}

export function compareNullableText(left: string | null | undefined, right: string | null | undefined, descending = false): number {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return descending ? compareNaturalText(right, left) : compareNaturalText(left, right);
}

function sortableCharts(card: GallerySortCard) {
  return (card.charts ?? []).filter(chart => chart.available !== false && chart.status !== "error" && chart.status !== "legacy" && chart.structurallyPresent !== false && !chart.errorVariant);
}

function numericTokens(value: string): number[] {
  return [...value.matchAll(/\d+(?:\.\d+)?/gu)].map((match) => Number(match[0])).filter((number) => Number.isFinite(number));
}

/** Every numeric value a facet value contains, so a range such as "45~158" yields both ends. */
export function numericFacetValues(value: string): number[] {
  return numericTokens(value);
}

/**
 * Sort weight for a numeric facet. A single value keeps its own number; a range uses the
 * average of its numbers, so "45~158" weighs 101.5 rather than 158. Cards without a usable
 * number return undefined and always sort last.
 */
export function numericFacetSortValue(card: GallerySortCard, key: string): number | undefined {
  const values = card.facets?.[key] ?? (card.metadata?.[key] === undefined ? [] : [String(card.metadata[key])]);
  const averages = values.map((value) => {
    const numbers = numericTokens(value);
    return numbers.length > 0 ? numbers.reduce((total, number) => total + number, 0) / numbers.length : undefined;
  }).filter((value): value is number => value !== undefined);
  if (averages.length === 0) return undefined;
  return averages.reduce((total, value) => total + value, 0) / averages.length;
}

export function highestChartConstant(card: GallerySortCard): number | undefined {
  const values = sortableCharts(card)
    .map((chart) => chart.constant && /^\d+(?:\.\d+)?$/u.test(chart.constant) ? Number(chart.constant) : Number.NaN)
    .filter((value) => Number.isFinite(value) && value > 0);
  return values.length > 0 ? Math.max(...values) : undefined;
}

/** Cards without a usable number always sort last, in both directions. */
export function compareNullableNumber(left: number | undefined, right: number | undefined, descending: boolean): number {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return descending ? right - left : left - right;
}

export function compareGalleryBpm(left: GallerySortCard, right: GallerySortCard, descending: boolean): number {
  return compareNullableNumber(numericFacetSortValue(left, "bpm"), numericFacetSortValue(right, "bpm"), descending)
    || compareNaturalText(left.displayTitle, right.displayTitle);
}

export function compareGalleryHighestConstant(left: GallerySortCard, right: GallerySortCard, descending: boolean): number {
  return compareNullableNumber(highestChartConstant(left), highestChartConstant(right), descending)
    || compareNaturalText(left.displayTitle, right.displayTitle);
}

export function compareGalleryHighestLevel(left: GallerySortCard, right: GallerySortCard, descending: boolean): number {
  const highest = (card: GallerySortCard): number | undefined => {
    const levels = sortableCharts(card).map(c => Number(c.level)).filter(n => Number.isFinite(n) && n > 0);
    return levels.length ? Math.max(...levels) : undefined;
  };
  return compareNullableNumber(highest(left), highest(right), descending) || compareNaturalText(left.displayTitle, right.displayTitle);
}

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
  charts?: Array<{ constant?: string }>;
};

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
  const values = (card.charts ?? [])
    .map((chart) => chart.constant === undefined ? Number.NaN : Number(chart.constant))
    .filter((value) => Number.isFinite(value));
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

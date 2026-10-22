// Build-time distribution for numeric range filters (difficulty, constant, BPM).
// Each item contributes at most once per bucket, so a bucket's count is the
// number of results the player gets by choosing that bucket alone.
export type RangeHistogram = {
  start: number;
  size: number;
  counts: number[];
  min?: number;
  max?: number;
};

const NICE_SIZES = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 25, 50, 100];
const MAX_BUCKETS = 20;

export function buildRangeHistogram(items: Array<Array<[number, number]>>, min: number, max: number, allowSparse = false, minimumSize = .1): RangeHistogram | undefined {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return undefined;
  const size = NICE_SIZES.find((candidate) => candidate >= minimumSize && Math.ceil(max / candidate - 1e-8) - Math.floor(min / candidate + 1e-8) <= MAX_BUCKETS) ?? NICE_SIZES.at(-1)!;
  const start = Number((Math.floor(min / size + 1e-8) * size).toFixed(4));
  const length = Math.max(1, Math.ceil((max - start) / size - 1e-8));
  const counts = Array.from({ length }, () => 0);
  for (const intervals of items) {
    const hit = new Set<number>();
    for (const [low, high] of intervals) {
      if (Math.min(low, high) > max) continue;
      const first = Math.min(length - 1, Math.max(0, Math.floor((Math.min(low, high) - start) / size + 1e-8)));
      const last = Math.min(length - 1, Math.floor((Math.max(low, high) - start) / size + 1e-8));
      for (let index = first; index <= last; index++) hit.add(index);
    }
    for (const index of hit) counts[index]! += 1;
  }
  if (!allowSparse && counts.filter((count) => count > 0).length < 2) return undefined;
  return { start, size, counts };
}

// Ignore the range's own selection: changing it must not move the drag axis.
// Empty distributions retain the known axis; one value gets one selectable bin.
export function adaptiveRangeHistogram(items: Array<Array<[number, number]>>, fallback: { min: number; max: number }, step = .1): RangeHistogram | undefined {
  const values = items.flat(2).filter(Number.isFinite);
  const min = values.length ? Math.min(...values) : fallback.min;
  const max = values.length ? Math.max(...values) : fallback.max;
  const upper = max > min ? max : Number((min + step).toFixed(4));
  const histogram = buildRangeHistogram(items, min, upper, true, step);
  return histogram ? { ...histogram, min, max: upper } : undefined;
}

// Facet strings such as "180" or "45~158": one number is a point, several form an interval.
export function numericIntervals(values: readonly string[]): Array<[number, number]> {
  return values.flatMap((value) => {
    const numbers = [...value.matchAll(/\d+(?:\.\d+)?/gu)].map((match) => Number(match[0])).filter(Number.isFinite);
    return numbers.length === 0 ? [] : [[Math.min(...numbers), Math.max(...numbers)] as [number, number]];
  });
}

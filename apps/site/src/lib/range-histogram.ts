// Build-time distribution for numeric range filters (difficulty, constant, BPM).
// Each item contributes at most once per bucket, so a bucket's count is the
// number of results the player gets by choosing that bucket alone.
export type RangeHistogram = {
  start: number;
  size: number;
  counts: number[];
};

const NICE_SIZES = [0.5, 1, 2, 5, 10, 20, 25, 50, 100];
const MAX_BUCKETS = 20;

export function buildRangeHistogram(items: Array<Array<[number, number]>>, min: number, max: number): RangeHistogram | undefined {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return undefined;
  const size = NICE_SIZES.find((candidate) => Math.ceil(max / candidate) - Math.floor(min / candidate) <= MAX_BUCKETS) ?? NICE_SIZES.at(-1)!;
  const start = Math.floor(min / size) * size;
  const length = Math.max(1, Math.ceil((max - start) / size + 1e-9));
  const counts = Array.from({ length }, () => 0);
  for (const intervals of items) {
    const hit = new Set<number>();
    for (const [low, high] of intervals) {
      const first = Math.max(0, Math.floor((Math.min(low, high) - start) / size));
      const last = Math.min(length - 1, Math.floor((Math.max(low, high) - start) / size));
      for (let index = first; index <= last; index++) hit.add(index);
    }
    for (const index of hit) counts[index]! += 1;
  }
  if (counts.filter((count) => count > 0).length < 2) return undefined;
  return { start, size, counts };
}

// Facet strings such as "180" or "45~158": one number is a point, several form an interval.
export function numericIntervals(values: readonly string[]): Array<[number, number]> {
  return values.flatMap((value) => {
    const numbers = [...value.matchAll(/\d+(?:\.\d+)?/gu)].map((match) => Number(match[0])).filter(Number.isFinite);
    return numbers.length === 0 ? [] : [[Math.min(...numbers), Math.max(...numbers)] as [number, number]];
  });
}

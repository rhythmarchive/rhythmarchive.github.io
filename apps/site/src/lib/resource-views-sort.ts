import { getBrowserStatsClient, type StatsClient } from "./stats-client";

// Only invoked for an explicit views sort. The shared client deduplicates requests
// and caches counts; filtering, pagination and other sorts add no stats reads.
export async function sortResourcesByViews<T>(
  items: readonly T[],
  resourceId: (item: T) => string,
  client: Pick<StatsClient, "getResourceStats"> = getBrowserStatsClient(),
): Promise<T[]> {
  const ids = items.map(resourceId);
  const stats = await client.getResourceStats(ids);
  if (ids.some((id) => !stats.has(id))) throw new Error("Resource views unavailable");
  return items.map((item, index) => ({ item, views: stats.get(ids[index]!)!.views }))
    .sort((left, right) => right.views - left.views)
    .map(({ item }) => item);
}

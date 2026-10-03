import type { ResourceRankingEntry, ResourceRankingPeriod, StatsStore } from "./core.js";
import { PUBLIC_RESOURCE_IDS, PUBLIC_RESOURCE_REGISTRY_SHA256 } from "./public-resource-registry.js";

export const RANKING_CACHE_TTL_MS = 60_000;

export interface RankingCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

// Collapse simultaneous misses within an isolate; Cache API shares completed
// results at the serving Cloudflare location, without any new binding.
const pendingRankings = new WeakMap<RankingCache, Map<string, Promise<ResourceRankingEntry[]>>>();

export async function getResourceRankingWithCache(
  store: StatsStore, cache: RankingCache | undefined, origin: string,
  period: ResourceRankingPeriod, date: string, limit: number, nowMs: number,
): Promise<ResourceRankingEntry[]> {
  if (!cache) return store.getResourceRanking(period, date, limit);
  const url = new URL(`/__stats-cache/ranking/v1/${PUBLIC_RESOURCE_REGISTRY_SHA256}`, origin);
  url.searchParams.set("period", period);
  url.searchParams.set("date", date);
  url.searchParams.set("limit", String(limit));
  const request = new Request(url);
  let pending = pendingRankings.get(cache);
  if (!pending) { pending = new Map(); pendingRankings.set(cache, pending); }
  const existing = pending.get(url.href);
  if (existing) return existing;
  const work = (async () => {
    try {
      const hit = await cache.match(request);
      if (hit?.ok) {
        const value = await hit.json() as { expiresAt?: number; entries?: ResourceRankingEntry[] };
        if (typeof value.expiresAt === "number" && value.expiresAt > nowMs && Array.isArray(value.entries)
          && value.entries.length <= limit && value.entries.every((entry) =>
            entry && PUBLIC_RESOURCE_IDS.has(entry.resourceId)
            && Number.isSafeInteger(entry.views) && entry.views >= 0
            && Number.isSafeInteger(entry.downloads) && entry.downloads >= 0)) return value.entries;
      }
    } catch { /* Cache is optional; continue to D1. */ }
    // D1 failures propagate to the handler's fail-closed 503 path, never cached.
    const entries = await store.getResourceRanking(period, date, limit);
    try {
      await cache.put(request, new Response(JSON.stringify({ expiresAt: nowMs + RANKING_CACHE_TTL_MS, entries }), {
        headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${RANKING_CACHE_TTL_MS / 1000}` },
      }));
    } catch { /* A successful D1 response does not depend on cache availability. */ }
    return entries;
  })();
  pending.set(url.href, work);
  try { return await work; }
  finally { pending.delete(url.href); }
}

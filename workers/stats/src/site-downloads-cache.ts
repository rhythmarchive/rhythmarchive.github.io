import type { StatsStore } from "./core.js";
import { RANKING_CACHE_TTL_MS, type RankingCache } from "./ranking-cache.js";

const pending = new WeakMap<RankingCache, Map<string, Promise<number>>>();

/** One historical SUM on a cache miss; no registry filter or additional writes. */
export async function getTotalDownloadsWithCache(store: StatsStore, cache: RankingCache | undefined, origin: string, nowMs: number): Promise<number> {
  if (!cache) return store.getTotalDownloads();
  const request = new Request(new URL("/__stats-cache/site-downloads/v1", origin));
  let requests = pending.get(cache);
  if (!requests) { requests = new Map(); pending.set(cache, requests); }
  const existing = requests.get(request.url);
  if (existing) return existing;
  const work = (async () => {
    try {
      const hit = await cache.match(request);
      if (hit?.ok) {
        const value = await hit.json() as { total?: number; expiresAt?: number };
        if (typeof value.total === "number" && Number.isSafeInteger(value.total) && value.total >= 0 && typeof value.expiresAt === "number" && value.expiresAt > nowMs) return value.total;
      }
    } catch { /* A cache failure falls through to D1. */ }
    const total = await store.getTotalDownloads();
    try {
      await cache.put(request, new Response(JSON.stringify({ total, expiresAt: nowMs + RANKING_CACHE_TTL_MS }), {
        headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${RANKING_CACHE_TTL_MS / 1000}` },
      }));
    } catch { /* Successful reads remain available without a writable cache. */ }
    return total;
  })();
  requests.set(request.url, work);
  try { return await work; } finally { requests.delete(request.url); }
}

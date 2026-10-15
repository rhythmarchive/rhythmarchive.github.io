import type { ResourceRankingEntry } from "./stats-client";
import type { PublicRankingCard } from "./types";

export type ResourceRankingRow = PublicRankingCard & {
  views: number;
  downloads: number;
};

export function mapResourceRankingEntries(cards: readonly PublicRankingCard[], entries: readonly ResourceRankingEntry[]): ResourceRankingRow[] {
  const cardsById = new Map(cards.map((card) => [card.resourceId, card]));
  const seen = new Set<string>();
  return entries.flatMap((entry) => {
    const card = cardsById.get(entry.resourceId);
    if (!card || seen.has(entry.resourceId)) return [];
    seen.add(entry.resourceId);
    return [{ ...card, views: entry.views, downloads: entry.downloads }];
  });
}
// Ranking rows need card data for a handful of IDs, so the public projection is
// split by the random tail of the UUIDv7 into small shards (data/ranking/xx.json)
// instead of shipping every card to resolve six rows.
export const RANKING_SHARD_COUNT = 128;

export function rankingShardKey(resourceId: string): string {
  const tail = Number.parseInt(resourceId.slice(-2), 16);
  return ((Number.isFinite(tail) ? tail : 0) % RANKING_SHARD_COUNT).toString(16).padStart(2, "0");
}

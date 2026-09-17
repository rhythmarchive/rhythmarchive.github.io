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
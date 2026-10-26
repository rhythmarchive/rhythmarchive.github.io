import type { PublicSearchEntry } from "./types";
import { GAME_CONFIG } from "./game-config";

const naturalTextCollators = new Map<string, Intl.Collator>([
  ["zh-CN", new Intl.Collator("zh-CN", { numeric: true, sensitivity: "variant" })],
]);

// Sorting compares the same titles hundreds of times; the result is pure, so a
// bounded cache removes most of that cost without holding the whole catalog.
const normalizedCache = new Map<string, string>();

export function normalizeSearchText(value: string): string {
  const cached = normalizedCache.get(value);
  if (cached !== undefined) return cached;
  const normalized = value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .trim()
    .replace(/[\u2010-\u2015\u2212]/gu, "-")
    .replace(/[\u3001\u3002，。！？；：、“”‘’（）【】《》]/gu, " ")
    .replace(/[\s_-]+/gu, " ")
    .trim();
  if (normalizedCache.size >= 8192) normalizedCache.clear();
  normalizedCache.set(value, normalized);
  return normalized;
}

export function compareNaturalText(left: string, right: string, locale = "zh-CN"): number {
  let collator = naturalTextCollators.get(locale);
  if (!collator) {
    collator = new Intl.Collator(locale, { numeric: true, sensitivity: "variant" });
    naturalTextCollators.set(locale, collator);
  }
  return collator.compare(normalizeSearchText(left), normalizeSearchText(right));
}

export function splitSearchQuery(value: string): string[] {
  return normalizeSearchText(value).split(" ").filter(Boolean);
}

export function foldSearchName(value: string): string {
  return normalizeSearchText(value).replace(/[^\p{L}\p{N}]/gu, "");
}

type SearchFields = { title: string; titles: string[]; artists: string[]; musicArtists: string[]; foldedTitles: string[]; foldedArtists: string[]; keywords: string[] };
const searchFields = new WeakMap<PublicSearchEntry, SearchFields>();

export function rankSearchEntries(entries: PublicSearchEntry[], query: string, scope: { game?: string; category?: string; field?: "artist" } = {}): PublicSearchEntry[] {
  const terms = splitSearchQuery(query);
  const normalizedQuery = normalizeSearchText(query);
  const foldedQuery = foldSearchName(query);
  if (terms.length === 0 && !scope.game && !scope.category) return [];

  const scored = entries.flatMap((entry) => {
    if ((scope.game && scope.game !== entry.game) || (scope.category && scope.category !== entry.category)) return [];
    let fields = searchFields.get(entry);
    if (!fields) {
      const game = GAME_CONFIG[entry.game];
      const titles = [entry.title, ...(entry.titleAliases ?? [])].map(normalizeSearchText);
      const artists = [entry.artist ?? "", ...(entry.artistAliases ?? [])].map(normalizeSearchText).filter(Boolean);
      const musicArtists = entry.song?.artist ? [entry.song.artist, ...(entry.artistAliases ?? [])].map(normalizeSearchText) : [];
      fields = { title: titles[0]!, titles, artists, musicArtists,
        foldedTitles: titles.map(foldSearchName), foldedArtists: artists.map(foldSearchName),
        keywords: [...entry.keywords, entry.game, game.displayName, ...(game.searchAliases ?? []), entry.category, entry.categoryLabel].map(normalizeSearchText) };
      searchFields.set(entry, fields);
    }
    // An explicit composer choice matches that complete public credit or a known
    // alias, never an illustrator, title occurrence or an inferred collaborator.
    const score = scope.field === "artist"
      ? fields.musicArtists.some(name => name === normalizedQuery || foldedQuery.length >= 3 && foldSearchName(name) === foldedQuery) ? 1 : 0
      : terms.length ? scoreEntry(fields, normalizedQuery, foldedQuery, terms) : 1;
    return score === 0 ? [] : [{ entry, score }];
  });

  return scored
    .sort((a, b) => b.score - a.score || compareNaturalText(a.entry.title, b.entry.title) || a.entry.resourceId.localeCompare(b.entry.resourceId))
    .map(({ entry }) => entry);
}

function scoreEntry(fields: SearchFields, query: string, folded: string, terms: string[]): number {
  const { title, titles, artists, keywords } = fields;
  if (title === query) return 10_000;
  if (titles.includes(query)) return 9_000;
  if (folded.length >= 3 && fields.foldedTitles.includes(folded)) return 8_000;
  const foldedArtistScore = folded.length >= 3 && fields.foldedArtists.includes(folded) ? 300 * terms.length : 0;
  let total = 0;
  for (const term of terms) {
    if (title === term) total += 1000;
    else if (title.startsWith(term)) total += 700;
    else if (title.includes(term)) total += 500;
    else if (titles.some(name => name.startsWith(term))) total += 650;
    else if (titles.some(name => name.includes(term))) total += 450;
    else if (artists.some(name => name.includes(term))) total += 300;
    else if (keywords.some((keyword) => keyword.includes(term))) total += 100;
    else return foldedArtistScore;
  }
  return Math.max(total, foldedArtistScore);
}

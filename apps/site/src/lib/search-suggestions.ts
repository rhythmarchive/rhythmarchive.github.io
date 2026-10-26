import { compareNaturalText, foldSearchName, normalizeSearchText } from "./search";
import type { PublicSearchEntry, PublicSearchSuggestions } from "./types";

/** A small name projection of the current public index, with no image/download data. */
export function buildSearchSuggestions(entries: PublicSearchEntry[], generatedAt: string): PublicSearchSuggestions {
  const songs = new Map<string, PublicSearchSuggestions["songs"][number]>();
  const artists = new Map<string, PublicSearchSuggestions["artists"][number]>();
  for (const entry of entries) {
    if (!entry.song || entry.category !== "jacket") continue;
    const song = entry.song;
    const songKey = `${entry.game}/${song.key}`;
    const existing = songs.get(songKey);
    const aliases = [...new Set([...(existing?.aliases ?? []), ...(entry.titleAliases ?? []), entry.title])].filter(name => name !== song.title);
    songs.set(songKey, { key: song.key, title: song.title, game: entry.game, ...(song.artist ? { artist: song.artist } : {}), aliases });
    if (!song.artist) continue;
    const artistKey = normalizeSearchText(song.artist);
    const artist = artists.get(artistKey);
    artists.set(artistKey, {
      name: artist?.name ?? song.artist,
      games: [...new Set([...(artist?.games ?? []), entry.game])],
      aliases: [...new Set([...(artist?.aliases ?? []), ...(entry.artistAliases ?? [])])].filter(name => normalizeSearchText(name) !== artistKey),
    });
  }
  return {
    schemaVersion: 1, generatedAt,
    songs: [...songs.values()].sort((a, b) => compareNaturalText(a.title, b.title) || a.game.localeCompare(b.game) || a.key.localeCompare(b.key)),
    artists: [...artists.values()].sort((a, b) => compareNaturalText(a.name, b.name)),
  };
}

/** Prefixes first, then contained public names; punctuation folding is auxiliary. */
export function matchSearchSuggestions(data: PublicSearchSuggestions, query: string, game = "", limit = 5) {
  const normalized = normalizeSearchText(query);
  const folded = foldSearchName(query);
  const rank = (names: string[]): number => {
    const values = names.map(normalizeSearchText);
    if (values.includes(normalized)) return 0;
    if (values.some(value => value.startsWith(normalized))) return 1;
    if (values.some(value => value.includes(normalized))) return 2;
    if (folded.length >= 3 && values.some(value => foldSearchName(value).includes(folded))) return 3;
    return 4;
  };
  const take = <T>(items: T[], names: (item: T) => string[]) => items.map(item => ({ item, rank: rank(names(item)) })).filter(item => item.rank < 4).sort((a, b) => a.rank - b.rank).slice(0, limit).map(item => item.item);
  if (!normalized) return { songs: [], artists: [] };
  return {
    songs: take(data.songs.filter(song => !game || song.game === game), song => [song.title, ...song.aliases]),
    artists: take(data.artists.filter(artist => !game || artist.games.includes(game as typeof artist.games[number])), artist => [artist.name, ...artist.aliases]),
  };
}

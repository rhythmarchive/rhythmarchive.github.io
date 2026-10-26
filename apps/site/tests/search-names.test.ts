import assert from "node:assert/strict";
import test from "node:test";
import { getSiteData, loadFormalBrowseProjections } from "../src/lib/site-data";
import { foldSearchName, normalizeSearchText, rankSearchEntries } from "../src/lib/search";
import { buildSearchSuggestions, matchSearchSuggestions } from "../src/lib/search-suggestions";
import type { PublicSearchEntry } from "../src/lib/types";

const data = getSiteData();
const suggestions = buildSearchSuggestions(data.searchIndex, data.generatedAt);

test("formal title and known aliases outrank weak related metadata", () => {
  const matches = rankSearchEntries(data.searchIndex, "worldvanquisher");
  assert.equal(matches[0]?.title, "World Vanquisher");
  assert.equal(matches[0]?.category, "jacket");
  assert.ok(matches.length >= 3, "related backgrounds remain searchable");
  assert.equal(rankSearchEntries(data.searchIndex, "愛して愛して愛して")[0]?.title, "Love me, Love me, Love me");
  const compactArtists = data.searchIndex.filter(entry => foldSearchName(entry.artist ?? "") === "tpazolite");
  assert.ok(compactArtists.length > 3);
  const resultIds = new Set(rankSearchEntries(data.searchIndex, "tpazolite").map(entry => entry.resourceId));
  assert.ok(compactArtists.every(entry => resultIds.has(entry.resourceId)));
});

test("exact multiword titles and symbol titles keep their priority", () => {
  const titles = [...new Set(data.searchIndex.map(entry => entry.title).filter(title => normalizeSearchText(title).includes(" ")))].slice(0, 250);
  for (const title of titles) assert.equal(normalizeSearchText(rankSearchEntries(data.searchIndex, title)[0]!.title), normalizeSearchText(title), title);
  const entries: PublicSearchEntry[] = ["X", "[X]"].map(title => ({ resourceId: title, route: "/", title, game: "arcaea", category: "jacket", categoryLabel: "曲绘", keywords: [] }));
  assert.equal(rankSearchEntries(entries, "[X]")[0]?.title, "[X]");
  assert.equal(rankSearchEntries(entries, "X")[0]?.title, "X");
});

test("composer scope uses complete music credits, known aliases and current game/category scope", () => {
  const entries: PublicSearchEntry[] = [
    { resourceId: "song", route: "/", title: "Song", artist: "Composer", song: { key: "song", title: "Song", artist: "Composer" }, artistAliases: ["Known alias"], game: "arcaea", category: "jacket", categoryLabel: "曲绘", keywords: [] },
    { resourceId: "title-only", route: "/", title: "Composer", game: "arcaea", category: "jacket", categoryLabel: "曲绘", keywords: ["Composer"] },
    { resourceId: "illustrator", route: "/", title: "Portrait", artist: "Composer", game: "arcaea", category: "character-portrait", categoryLabel: "角色立绘", keywords: [] },
    { resourceId: "joint", route: "/", title: "Joint", artist: "Composer & Other", song: { key: "joint", title: "Joint", artist: "Composer & Other" }, game: "arcaea", category: "jacket", categoryLabel: "曲绘", keywords: [] },
  ];
  assert.deepEqual(rankSearchEntries(entries, "Composer", { field: "artist" }).map(entry => entry.resourceId), ["song"]);
  assert.deepEqual(rankSearchEntries(entries, "Known alias", { field: "artist" }).map(entry => entry.resourceId), ["song"]);
  assert.deepEqual(rankSearchEntries(entries, "Composer", { field: "artist", game: "phigros" }), []);
  assert.deepEqual(rankSearchEntries(entries, "Composer", { field: "artist", category: "character-portrait" }), []);
});

test("suggestions retain separate works, exclude non-song resources and contain names only", () => {
  const currentKeys = new Set(data.searchIndex.flatMap(entry => entry.song ? [`${entry.game}/${entry.song.key}`] : []));
  assert.ok(suggestions.songs.length > 2000);
  for (const song of suggestions.songs) {
    assert.ok(currentKeys.has(`${song.game}/${song.key}`));
    assert.deepEqual(Object.keys(song).sort(), (song.artist ? ["key", "title", "game", "artist", "aliases"] : ["key", "title", "game", "aliases"]).sort());
  }
  const removed = suggestions.songs[0]!;
  const remaining = data.searchIndex.filter(entry => entry.game !== removed.game || entry.song?.key !== removed.key);
  assert.ok(!buildSearchSuggestions(remaining, data.generatedAt).songs.some(song => song.game === removed.game && song.key === removed.key));
  const anotherMe = suggestions.songs.filter(song => song.game === "phigros" && song.title.startsWith("Another Me"));
  assert.ok(new Set(anotherMe.map(song => song.key)).size >= 2);
  const formal = loadFormalBrowseProjections();
  const illustratedSong = formal.rizline.songs.find(song => song.illustrator && song.musicArtist && song.illustrator !== song.musicArtist)!;
  const entry = data.searchIndex.find(entry => entry.resourceId === illustratedSong.artworks[0]!.resourceId)!;
  assert.equal(entry.song?.artist, illustratedSong.musicArtist);
  assert.ok(!entry.artistAliases?.includes(illustratedSong.illustrator!));
  assert.ok(!rankSearchEntries([entry], illustratedSong.illustrator!, { field: "artist" }).length);
  assert.ok(!suggestions.songs.some(song => data.resources.find(resource => resource.resourceId === song.key)?.metadata.contentKind === "段位封面"));
});

test("suggestion matching is local, bounded, game scoped and preserves special names", () => {
  const matches = matchSearchSuggestions(suggestions, "worldvanquisher", "arcaea");
  assert.equal(matches.songs[0]?.title, "World Vanquisher");
  assert.ok(matches.songs.every(song => song.game === "arcaea"));
  assert.ok(matches.songs.length <= 5 && matches.artists.length <= 5);
  assert.ok(matchSearchSuggestions(suggestions, "void", "arcaea").artists.some(artist => artist.name === "void (Mournfinale)"));
  assert.deepEqual(matchSearchSuggestions(suggestions, ""), { songs: [], artists: [] });
  assert.deepEqual(buildSearchSuggestions([], data.generatedAt), { schemaVersion: 1, generatedAt: data.generatedAt, songs: [], artists: [] });
});

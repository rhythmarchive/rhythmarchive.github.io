// Store identity only: current previews and downloads always come from public data.
export const LIBRARY_KEY = "rhythm-archive-library-v1";
export const FAVORITES_LIMIT = 500;
export const HISTORY_LIMIT = 200;
export const HISTORY_MAX_AGE = 90 * 24 * 60 * 60 * 1000;
export type LibraryTab = "favorites" | "history";
export type LibraryEntry = { id: string; game: string; category: string; title: string; at: number };
export type LibraryData = { version: 1; favorites: LibraryEntry[]; history: LibraryEntry[] };
type StorageAccess = () => Pick<Storage, "getItem" | "setItem">;
const empty = (): LibraryData => ({ version: 1, favorites: [], history: [] });

export function normalizeEntries(value: unknown, limit: number, since = 0, now = Date.now()): LibraryEntry[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.filter((entry): entry is LibraryEntry => {
    if (!entry || typeof entry !== "object") return false;
    return typeof entry.id === "string" && /^[a-zA-Z0-9_-]{1,100}$/u.test(entry.id)
      && typeof entry.game === "string" && /^[a-z0-9-]{1,50}$/u.test(entry.game)
      && typeof entry.category === "string" && /^[a-z0-9-]{1,50}$/u.test(entry.category)
      && typeof entry.title === "string" && entry.title.length <= 240
      && Number.isSafeInteger(entry.at) && entry.at > 0 && entry.at >= since && entry.at <= now;
  }).sort((a, b) => b.at - a.at).filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  }).slice(0, limit).map(({ id, game, category, title, at }) => ({ id, game, category, title, at }));
}

export function createLocalLibrary(access: StorageAccess = () => localStorage, clock = Date.now) {
  function read(): { data: LibraryData; warning: string; writable: boolean } {
    try {
      const raw = access().getItem(LIBRARY_KEY);
      if (!raw) return { data: empty(), warning: "", writable: true };
      if (raw.length > 500_000) return { data: empty(), warning: "本地记录过大，无法读取。", writable: false };
      let value;
      try { value = JSON.parse(raw); }
      catch { return { data: empty(), warning: "本地记录已损坏，添加收藏或浏览资源后将重新保存。", writable: true }; }
      if (!value || value.version !== 1) return { data: empty(), warning: "本地记录版本暂不支持。", writable: false };
      if (!Array.isArray(value.favorites) || !Array.isArray(value.history)) return { data: empty(), warning: "本地记录已损坏，添加收藏或浏览资源后将重新保存。", writable: true };
      const now = clock();
      return { data: { version: 1, favorites: normalizeEntries(value.favorites, FAVORITES_LIMIT, 0, now), history: normalizeEntries(value.history, HISTORY_LIMIT, now - HISTORY_MAX_AGE, now) }, warning: "", writable: true };
    } catch { return { data: empty(), warning: "浏览器本地存储不可用，无法保存收藏和浏览历史。", writable: false }; }
  }
  function change(edit: (data: LibraryData) => string | void): string {
    const state = read();
    if (!state.writable) return state.warning;
    const warning = edit(state.data);
    if (warning) return warning;
    try { access().setItem(LIBRARY_KEY, JSON.stringify(state.data)); return ""; }
    catch { return "保存失败，本地存储可能已满或被禁用。"; }
  }
  return {
    read,
    visit: (entry: Omit<LibraryEntry, "at">) => change((data) => {
      data.history = normalizeEntries([{ ...entry, at: clock() }, ...data.history.filter((item) => item.id !== entry.id)], HISTORY_LIMIT, clock() - HISTORY_MAX_AGE, clock());
    }),
    toggleFavorite: (entry: Omit<LibraryEntry, "at">) => change((data) => {
      if (data.favorites.some((item) => item.id === entry.id)) data.favorites = data.favorites.filter((item) => item.id !== entry.id);
      else {
        if (data.favorites.length >= FAVORITES_LIMIT) return `最多收藏 ${FAVORITES_LIMIT} 项，请先移除部分收藏。`;
        data.favorites = normalizeEntries([{ ...entry, at: clock() }, ...data.favorites], FAVORITES_LIMIT, 0, clock());
      }
    }),
    remove: (tab: LibraryTab, id: string) => change((data) => { data[tab] = data[tab].filter((item) => item.id !== id); }),
    clearHistory: () => change((data) => { data.history = []; }),
  };
}

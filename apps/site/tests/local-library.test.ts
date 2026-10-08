import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { createLocalLibrary, LIBRARY_KEY, FAVORITES_LIMIT, HISTORY_LIMIT, HISTORY_MAX_AGE, normalizeEntries } from "../src/lib/local-library";
import { setupDetailLibrary } from "../src/scripts/detail-library";

const now = Date.UTC(2026, 9, 8);
const entry = (id: string, at = now) => ({ id, game: "arcaea", category: "jacket", title: `Resource ${id}`, at });
function fixture() {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  let time = now;
  return { values, storage, library: createLocalLibrary(() => storage, () => time), tick: () => { time++; } };
}
test("favorite toggles and fresh reads preserve another tab's writes", () => {
  const f = fixture();
  const other = createLocalLibrary(() => f.storage, () => now);
  assert.equal(f.library.toggleFavorite(entry("A")), "");
  assert.equal(other.toggleFavorite(entry("B")), "");
  assert.deepEqual(f.library.read().data.favorites.map((r) => r.id), ["B", "A"]);
  f.library.visit(entry("A"));
  f.library.toggleFavorite(entry("A"));
  assert.deepEqual(f.library.read().data.favorites.map((r) => r.id), ["B"]);
  assert.deepEqual(f.library.read().data.history.map((r) => r.id), ["A"]);
});
test("history deduplicates, moves latest visit first, expires and stays bounded", () => {
  const f = fixture();
  for (let i = 0; i < HISTORY_LIMIT + 3; i++) { f.tick(); f.library.visit(entry(String(i))); }
  f.tick(); f.library.visit(entry("7"));
  const history = f.library.read().data.history;
  assert.equal(history.length, HISTORY_LIMIT);
  assert.equal(history[0]?.id, "7");
  assert.equal(history.filter((r) => r.id === "7").length, 1);
  assert.equal(history.some((r) => r.id === "0"), false);
  assert.deepEqual(normalizeEntries([entry("expired", now - HISTORY_MAX_AGE - 1), entry("current")], HISTORY_LIMIT, now - HISTORY_MAX_AGE, now).map((r) => r.id), ["current"]);
});
test("favorites never silently evict at capacity and history clearing preserves favorites", () => {
  const f = fixture();
  f.values.set(LIBRARY_KEY, JSON.stringify({ version: 1, favorites: Array.from({ length: FAVORITES_LIMIT }, (_, i) => entry(String(i))), history: [entry("visited")] }));
  assert.match(f.library.toggleFavorite(entry("new")), /最多收藏/);
  assert.equal(f.library.read().data.favorites.length, FAVORITES_LIMIT);
  assert.equal(f.library.toggleFavorite(entry("1")), "");
  assert.equal(f.library.toggleFavorite(entry("new")), "");
  assert.equal(f.library.clearHistory(), "");
  assert.equal(f.library.read().data.favorites.length, FAVORITES_LIMIT);
  assert.equal(f.library.read().data.history.length, 0);
});
test("blocked reads/writes, corrupt data and future versions fail visibly without false success", () => {
  const blocked = createLocalLibrary(() => { throw new Error("SecurityError"); }, () => now);
  assert.equal(blocked.read().writable, false);
  assert.match(blocked.visit(entry("A")), /不可用/);
  const f = fixture();
  const full = createLocalLibrary(() => ({ getItem: f.storage.getItem, setItem: () => { throw new Error("QuotaExceededError"); } }), () => now);
  assert.match(full.toggleFavorite(entry("A")), /保存失败/);
  assert.equal(f.library.read().data.favorites.length, 0);
  f.values.set(LIBRARY_KEY, "{corrupt");
  assert.match(f.library.read().warning, /损坏/);
  assert.equal(f.library.visit(entry("A")), "");
  f.values.set(LIBRARY_KEY, '{"version":2}');
  assert.match(f.library.toggleFavorite(entry("A")), /版本/);
  assert.equal(f.values.get(LIBRARY_KEY), '{"version":2}');
  f.values.set(LIBRARY_KEY, "x".repeat(500_001));
  assert.equal(f.library.read().writable, false);
});
test("invalid paths/timestamps are discarded and only identity metadata is stored", () => {
  const valid = { ...entry("safe"), original: "https://original.test/secret", preview: "stale.webp" };
  const items = normalizeEntries([valid, entry("safe"), { ...entry("bad"), category: "../../private" }, entry("future", now + 1), { ...entry("badtime"), at: "123" }, { ...entry("long"), title: "x".repeat(241) }], 500, 0, now);
  assert.deepEqual(items, [entry("safe")]);
});
test("detail visit/favorite controls persist, sync other tabs, and never claim failed writes", (t) => {
  const values = new Map<string, string>();
  let rejectWrites = false;
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => {
    if (rejectWrites) throw new Error("QuotaExceededError");
    values.set(key, value);
  } };
  const windowEvents = new Map<string, (event: { key?: string; persisted?: boolean }) => void>();
  let click = () => {};
  const attrs = new Map<string, string>();
  const button = {
    hidden: true, disabled: false, textContent: "",
    setAttribute: (key: string, value: string) => attrs.set(key, value),
    getAttribute: (key: string) => attrs.get(key),
    addEventListener: (_: string, fn: () => void) => { click = fn; },
  };
  const status = { textContent: "" };
  for (const [name, value] of Object.entries({ localStorage: storage, window: { addEventListener: (key: string, fn: (event: { key?: string; persisted?: boolean }) => void) => windowEvents.set(key, fn) } })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => { if (original) Object.defineProperty(globalThis, name, original); else Reflect.deleteProperty(globalThis, name); });
  }
  const root = { dataset: { resourceId: "A", game: "arcaea", category: "jacket", resourceTitle: "Title" }, querySelector: (selector: string) => selector === "[data-favorite-toggle]" ? button : status } as unknown as HTMLElement;
  setupDetailLibrary(root);
  const library = createLocalLibrary(() => storage);
  assert.deepEqual(library.read().data.history.map((r) => r.id), ["A"]);
  assert.equal(button.hidden, false);
  click();
  assert.equal(attrs.get("aria-pressed"), "true");
  assert.equal(button.textContent, "已收藏");
  rejectWrites = true;
  click();
  assert.match(status.textContent, /保存失败/);
  assert.equal(attrs.get("aria-pressed"), "true");
  rejectWrites = false;
  library.remove("favorites", "A");
  windowEvents.get("storage")!({ key: LIBRARY_KEY });
  assert.equal(attrs.get("aria-pressed"), "false");
  library.clearHistory();
  windowEvents.get("pageshow")!({ persisted: true });
  assert.equal(library.read().data.history.length, 1);
});
test("collection stays on page/detail paths and reuses lazy cards, category indices, tray and navigation", () => {
  const source = (name: string) => fs.readFileSync(`apps/site/src/${name}`, "utf8");
  const page = source("scripts/local-library-page.ts");
  assert.match(page, /data\/galleries\/\$\{key\}/);
  assert.match(page, /entries\.slice\(0, visibleCount\)/);
  assert.match(page, /Math\.min\(3, keys\.length\)/);
  for (const existing of ["renderResourceCard", "createBatchTray", "downloadSelectedBatchFromManifest", "setupListNavigation"]) assert.ok(page.includes(existing));
  assert.doesNotMatch(page, /search-index|search-cards|trackResourceDetail|updateResourceStatsInDom|setInterval/);
  assert.doesNotMatch(source("layouts/BaseLayout.astro"), /local-library|detail-library/);
  assert.match(source("scripts/render-resource-card.ts"), /observeImage\(image\)/);
});

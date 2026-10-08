import { createLocalLibrary, LIBRARY_KEY, type LibraryEntry, type LibraryTab } from "../lib/local-library";
import { galleryCardView } from "../lib/card-view-model";
import type { GalleryCard } from "../lib/gallery-projection";
import { GAME_CONFIG, CATEGORY_LABELS, type GameId, type ResourceTypeId } from "../lib/game-config";
import { sitePath } from "../lib/url";
import { renderResourceCard } from "./render-resource-card";
import { createBatchTray, downloadSelectedBatchFromManifest } from "./batch-tray";
import { setupListNavigation } from "./list-navigation";

const root = document.querySelector<HTMLElement>("[data-library-root]");
if (root) initialize(root);

function initialize(root: HTMLElement): void {
  const grid = root.querySelector<HTMLElement>("[data-library-grid]")!;
  const count = root.querySelector<HTMLElement>("[data-library-count]")!;
  const warning = root.querySelector<HTMLElement>("[data-library-warning]")!;
  const empty = root.querySelector<HTMLElement>("[data-library-empty]")!;
  const more = root.querySelector<HTMLButtonElement>("[data-library-more]")!;
  const retry = root.querySelector<HTMLButtonElement>("[data-library-retry]")!;
  const clear = root.querySelector<HTMLButtonElement>("[data-clear-history]")!;
  const panel = root.querySelector<HTMLElement>('[role="tabpanel"]')!;
  const tabs = [...root.querySelectorAll<HTMLButtonElement>("[data-library-tab]")];
  const categories = new Set<string>(JSON.parse(root.dataset.categories ?? "[]"));
  const library = createLocalLibrary();
  const base = document.documentElement.dataset.basePath ?? "/";
  const navigation = setupListNavigation(grid, "local-library");
  let tab: LibraryTab = new URL(location.href).searchParams.get("tab") === "history" ? "history" : "favorites";
  let visibleCount = Math.min(500, navigation.visibleCount(48));
  let data = library.read().data;
  let cards = new Map<string, GalleryCard>();
  let loaded = new Set<string>();
  let pending = new Map<string, Promise<void>>();
  let runToken = 0;
  let busy = false;
  let writable = true;
  let reloadPending = false;
  const categoryKey = (entry: LibraryEntry) => `${entry.game}/${entry.category}`;
  const tray = createBatchTray({
    root, grid,
    getResource: (id) => cards.get(id),
    onDownload: async (preferUpscaled, selectedIds, setStatus) => {
      busy = true;
      setControls();
      try {
        const manifestUrl = [...new Set(selectedIds.map((id) => {
          const entry = [...data.favorites, ...data.history].find((item) => item.id === id)!;
          return sitePath(`/data/batch/${categoryKey(entry)}.json`, base);
        }))];
        await downloadSelectedBatchFromManifest({ selectedIds, manifestUrl, getResource: (id) => cards.get(id), preferUpscaled, filename: "rhythm-archive-collection.zip", setStatus });
      } finally {
        busy = false;
        if (reloadPending) reload(); else void refresh();
      }
    },
  });

  // Fetch only categories needed by the visible slice. Retain only saved cards,
  // never the category arrays or download manifests, and retry failed requests.
  async function loadCategory(key: string): Promise<void> {
    if (loaded.has(key) || !categories.has(key)) return;
    let request = pending.get(key);
    if (!request) {
      const targetCards = cards;
      const targetLoaded = loaded;
      const targetPending = pending;
      const wanted = new Set([...data.favorites, ...data.history].filter((entry) => categoryKey(entry) === key).map((entry) => entry.id));
      request = (async () => {
        const response = await fetch(sitePath(`/data/galleries/${key}.json`, base), { credentials: "omit" });
        if (!response.ok) throw new Error(`gallery failed with ${response.status}`);
        const resources = await response.json() as GalleryCard[];
        if (!Array.isArray(resources)) throw new Error("Invalid gallery data");
        for (const resource of resources) if (wanted.has(resource.resourceId)) targetCards.set(resource.resourceId, resource);
        targetLoaded.add(key);
      })().finally(() => targetPending.delete(key));
      pending.set(key, request);
    }
    await request;
  }

  async function refresh(message = ""): Promise<void> {
    const token = ++runToken;
    const state = library.read();
    data = state.data;
    writable = state.writable;
    const retained = new Set([...data.favorites, ...data.history].map((entry) => entry.id));
    if (!busy && tray.selectedIds().some((id) => !retained.has(id))) tray.clearSelection();
    warning.textContent = message || state.warning;
    const entries = data[tab];
    for (const button of tabs) {
      const active = button.dataset.libraryTab === tab;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    }
    panel.setAttribute("aria-labelledby", `${tab}-tab`);
    clear.hidden = tab !== "history" || !entries.length;
    empty.hidden = entries.length > 0;
    root.querySelector<HTMLElement>("[data-library-empty-copy]")!.textContent = tab === "favorites" ? "暂无收藏。在资源详情页点击“收藏”即可添加。" : "暂无浏览历史。浏览资源详情后会自动记录。";
    more.hidden = true;
    retry.hidden = true;
    count.textContent = entries.length ? "加载中…" : "0 项资源";
    const visible = entries.slice(0, visibleCount);
    const keys = [...new Set(visible.map(categoryKey))];
    const failed = new Set<string>();
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(3, keys.length) }, async () => {
      while (next < keys.length && token === runToken) {
        const key = keys[next++]!;
        try { await loadCategory(key); } catch { failed.add(key); }
      }
    }));
    if (token !== runToken) return;
    grid.replaceChildren(...visible.map((entry, index) => renderEntry(entry, index, failed.has(categoryKey(entry)))));
    count.textContent = `${entries.length} 项资源`;
    retry.hidden = failed.size === 0;
    if (failed.size) warning.textContent = [warning.textContent, "部分资源加载失败，请重试。"].filter(Boolean).join(" ");
    more.hidden = visible.length >= entries.length;
    tray.syncCards();
    setControls();
    navigation.restore();
  }

  function renderEntry(entry: LibraryEntry, index: number, failed: boolean): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "library-entry";
    const resource = cards.get(entry.id);
    if (resource) {
      const view = galleryCardView(resource);
      view.subtitle = `${GAME_CONFIG[entry.game as GameId]?.displayName ?? entry.game} · ${CATEGORY_LABELS[entry.category as ResourceTypeId] ?? entry.category}`;
      wrapper.append(renderResourceCard(view, { basePath: base, index, isSelected: tray.isSelected(entry.id) }));
    } else {
      const placeholder = document.createElement("div");
      placeholder.className = "library-unavailable";
      const title = document.createElement("h3");
      title.textContent = entry.title || "资源";
      const note = document.createElement("p");
      note.textContent = failed ? "加载失败，请重试" : "资源已下架或暂不可用";
      placeholder.append(title, note);
      wrapper.append(placeholder);
    }
    const footer = document.createElement("div");
    footer.className = "library-entry-footer";
    const time = document.createElement("time");
    time.dateTime = new Date(entry.at).toISOString();
    time.textContent = new Date(entry.at).toLocaleDateString("zh-CN");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "text-link";
    remove.dataset.libraryRemove = entry.id;
    remove.textContent = tab === "favorites" ? "取消收藏" : "删除记录";
    remove.setAttribute("aria-label", `${remove.textContent} ${entry.title}`);
    footer.append(time, remove);
    wrapper.append(footer);
    return wrapper;
  }
  function setControls(): void {
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-library-tab], [data-library-remove], [data-clear-history], [data-library-more], [data-library-retry], [data-select-resource]")) button.disabled = busy;
    if (!writable) {
      clear.disabled = true;
      for (const button of root.querySelectorAll<HTMLButtonElement>("[data-library-remove]")) button.disabled = true;
    }
  }
  function switchTab(next: LibraryTab): void {
    if (busy || next === tab) return;
    tab = next;
    tray.clearSelection();
    visibleCount = 48;
    const url = new URL(location.href);
    url.searchParams.set("tab", tab);
    history.replaceState({}, "", url);
    grid.replaceChildren();
    void refresh();
  }
  tabs.forEach((button, index) => {
    button.addEventListener("click", () => switchTab(button.dataset.libraryTab as LibraryTab));
    button.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || busy) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
      tabs[next]!.click(); tabs[next]!.focus();
    });
  });
  grid.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-library-remove]") : null;
    if (!button || busy) return;
    const id = button.dataset.libraryRemove!;
    if (tray.isSelected(id)) { warning.textContent = "请先取消选择，再移除此资源。"; return; }
    void refresh(library.remove(tab, id));
  });
  clear.addEventListener("click", () => {
    if (busy) return;
    if (tray.selectedIds().length) { warning.textContent = "请先清空选择，再清空历史。"; return; }
    if (confirm("清空全部浏览历史？收藏夹不受影响。")) void refresh(library.clearHistory());
  });
  more.addEventListener("click", () => { if (!busy) { visibleCount += 48; void refresh(); } });
  retry.addEventListener("click", () => { if (!busy) void refresh(); });
  const reload = () => {
    if (busy) { reloadPending = true; return; }
    reloadPending = false;
    tray.clearSelection();
    cards = new Map(); loaded = new Set(); pending = new Map();
    void refresh();
  };
  window.addEventListener("storage", (event) => { if (event.key === LIBRARY_KEY || event.key === null) reload(); });
  window.addEventListener("pageshow", (event) => { if (event.persisted) reload(); });
  void refresh();
}

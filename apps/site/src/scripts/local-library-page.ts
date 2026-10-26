import { loadStaticData } from "./static-data";
import { onPageLoad, pageSignal } from "./page-lifecycle";
import { createLocalLibrary, LIBRARY_KEY, matchesHistoryFilter, type HistoryFilter, type LibraryEntry, type LibraryTab } from "../lib/local-library";
import { galleryCardView } from "../lib/card-view-model";
import type { GalleryCard } from "../lib/gallery-projection";
import { GAME_CONFIG, CATEGORY_LABELS, type GameId, type ResourceTypeId } from "../lib/game-config";
import { sitePath } from "../lib/url";
import { renderResourceCard } from "./render-resource-card";
import { createBatchTray, downloadSelectedBatchFromManifest } from "./batch-tray";
import { setupListNavigation } from "./list-navigation";
import { revealContent, setSurfaceVisible } from "./motion";

onPageLoad(() => {
  const root = document.querySelector<HTMLElement>("[data-library-root]");
  if (root) initialize(root);
});

function initialize(root: HTMLElement): void {
  const signal = pageSignal();
  const grid = root.querySelector<HTMLElement>("[data-library-grid]")!;
  const loading = root.querySelector<HTMLElement>("[data-library-loading]");
  const count = root.querySelector<HTMLElement>("[data-library-count]")!;
  const warning = root.querySelector<HTMLElement>("[data-library-warning]")!;
  const empty = root.querySelector<HTMLElement>("[data-library-empty]")!;
  const more = root.querySelector<HTMLButtonElement>("[data-library-more]")!;
  const retry = root.querySelector<HTMLButtonElement>("[data-library-retry]")!;
  const clear = root.querySelector<HTMLButtonElement>("[data-clear-history]")!;
  const toolsToggle = root.querySelector<HTMLButtonElement>("[data-history-tools-toggle]")!;
  const tools = root.querySelector<HTMLFormElement>("[data-history-tools]")!;
  const before = root.querySelector<HTMLInputElement>("[data-history-before]")!;
  const game = root.querySelector<HTMLSelectElement>("[data-history-game]")!;
  const match = root.querySelector<HTMLElement>("[data-history-match]")!;
  const deleteHistory = root.querySelector<HTMLButtonElement>("[data-history-delete]")!;
  const panel = root.querySelector<HTMLElement>('[role="tabpanel"]')!;
  const viewHistory = root.querySelector<HTMLButtonElement>("[data-library-view-history]")!;
  const emptyGames = root.querySelector<HTMLAnchorElement>("[data-library-empty-games]")!;
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
    onDetailLink: navigation.captureLink,
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
        const resources = await loadStaticData<GalleryCard[]>(sitePath(`/data/galleries/${key}.json`, base));
        if (signal.aborted) return;
        if (!Array.isArray(resources)) throw new Error("Invalid gallery data");
        for (const resource of resources) if (wanted.has(resource.resourceId)) targetCards.set(resource.resourceId, resource);
        targetLoaded.add(key);
      })().finally(() => targetPending.delete(key));
      pending.set(key, request);
    }
    await request;
  }

  async function refresh(message = ""): Promise<void> {
    if (signal.aborted) return;
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
      const key = button.dataset.libraryTab as LibraryTab;
      button.querySelector<HTMLElement>("[data-library-tab-count]")!.textContent = state.writable ? String(data[key].length) : "—";
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    }
    panel.setAttribute("aria-labelledby", `${tab}-tab`);
    clear.hidden = tab !== "history" || !entries.length;
    toolsToggle.hidden = clear.hidden;
    if (clear.hidden) toggleHistoryTools(false, false);
    const selectedGame = game.value;
    const games = new Set(data.history.map((entry) => entry.game));
    if (selectedGame) games.add(selectedGame);
    game.replaceChildren(new Option("全部游戏", ""), ...[...games].map((id) => new Option(GAME_CONFIG[id as GameId]?.displayName ?? id, id)));
    game.value = selectedGame;
    empty.hidden = entries.length > 0;
    const hasRecent = tab === "favorites" && data.history.length > 0;
    viewHistory.hidden = !hasRecent;
    emptyGames.hidden = hasRecent;
    root.querySelector<HTMLElement>("[data-library-empty-copy]")!.textContent = tab === "favorites"
      ? hasRecent ? "暂无收藏。可以从最近浏览中打开资源详情并收藏。" : "暂无收藏。在资源详情页点击“收藏”即可添加。"
      : "暂无最近浏览。打开资源详情后会自动记录。";
    more.hidden = true;
    retry.hidden = true;
    count.textContent = entries.length ? "加载中…" : "0 项资源";
    const visible = entries.slice(0, visibleCount);
    if (loading) loading.hidden = !visible.length || grid.childElementCount > 0;
    grid.setAttribute("aria-busy", "true");
    const keys = [...new Set(visible.map(categoryKey))];
    const failed = new Set<string>();
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(3, keys.length) }, async () => {
      while (!signal.aborted && next < keys.length && token === runToken) {
        const key = keys[next++]!;
        try { await loadCategory(key); } catch { failed.add(key); }
      }
    }));
    if (signal.aborted || token !== runToken) return;
    if (loading) loading.hidden = true;
    grid.removeAttribute("aria-busy");
    grid.replaceChildren(...visible.map((entry, index) => renderEntry(entry, index, failed.has(categoryKey(entry)))));
    navigation.remember(visibleCount);
    revealContent(grid);
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
      wrapper.append(renderResourceCard(view, { basePath: base, index, isSelected: tray.isSelected(entry.id), showViews: false }));
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
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-library-tab], [data-library-remove], [data-clear-history], [data-history-tools-toggle], [data-library-more], [data-library-retry], [data-select-resource]")) button.disabled = busy;
    before.disabled = game.disabled = busy || !writable;
    updateHistoryMatch();
    if (!writable) {
      clear.disabled = toolsToggle.disabled = true;
      for (const button of root.querySelectorAll<HTMLButtonElement>("[data-library-remove]")) button.disabled = true;
    }
  }
  function historyFilter(): HistoryFilter {
    // Date inputs use calendar dates; interpret the cutoff in the browser's local
    // timezone, matching the dates displayed on the records (not UTC parsing).
    const parts = before.value.split("-").map(Number);
    const cutoff = before.value ? new Date(parts[0]!, parts[1]! - 1, parts[2]!).getTime() : undefined;
    return { ...(game.value ? { game: game.value } : {}), ...(cutoff === undefined ? {} : { before: cutoff }) };
  }
  function updateHistoryMatch(): void {
    const filter = historyFilter();
    const total = data.history.filter((entry) => matchesHistoryFilter(entry, filter)).length;
    match.textContent = !filter.game && filter.before === undefined ? "请选择日期或游戏。" : `匹配 ${total} 条浏览记录`;
    deleteHistory.textContent = total ? `删除 ${total} 条记录` : "删除记录";
    deleteHistory.disabled = busy || !writable || !total || !before.validity.valid;
  }
  function toggleHistoryTools(visible: boolean, focus = true): void {
    toolsToggle.setAttribute("aria-expanded", String(visible));
    void setSurfaceVisible(tools, visible, "fade");
    if (focus) (visible ? before : toolsToggle).focus();
  }
  function switchTab(next: LibraryTab): void {
    if (busy || next === tab) return;
    tab = next;
    tray.clearSelection();
    visibleCount = 48;
    const url = new URL(location.href);
    url.searchParams.set("tab", tab);
    history.replaceState({ ...history.state }, "", url);
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
  toolsToggle.addEventListener("click", () => {
    if (busy) return;
    updateHistoryMatch();
    toggleHistoryTools(toolsToggle.getAttribute("aria-expanded") !== "true");
  });
  root.querySelector("[data-history-tools-close]")!.addEventListener("click", () => toggleHistoryTools(false));
  tools.addEventListener("input", updateHistoryMatch);
  tools.addEventListener("submit", (event) => {
    event.preventDefault();
    if (busy || !writable || tab !== "history") return;
    if (tray.selectedIds().length) { warning.textContent = "请先清空选择，再批量删除记录。"; return; }
    data = library.read().data;
    updateHistoryMatch();
    if (deleteHistory.disabled) return;
    const filter = historyFilter();
    const total = data.history.filter((entry) => matchesHistoryFilter(entry, filter)).length;
    const scope = [filter.game ? game.selectedOptions[0]!.text : "全部游戏", before.value ? `${before.value} 之前（不含当天）` : "全部日期"].join("，");
    if (confirm(`删除 ${total} 条浏览记录？\n${scope}。收藏夹不受影响，此操作无法撤销。`)) {
      const message = library.removeHistory(filter);
      if (!message) toggleHistoryTools(false);
      void refresh(message);
    }
  });
  viewHistory.addEventListener("click", () => {
    switchTab("history");
    tabs.find((button) => button.dataset.libraryTab === "history")?.focus();
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
  window.addEventListener("storage", (event) => { if (event.key === LIBRARY_KEY || event.key === null) reload(); }, { signal });
  window.addEventListener("pageshow", (event) => { if (event.persisted) reload(); }, { signal });
  void refresh();
}

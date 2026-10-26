import { loadStaticData } from "./static-data";
import { onPageLoad, pageSignal, onPageCleanup } from "./page-lifecycle";
import { compareNaturalText, rankSearchEntries } from "../lib/search";
import { setupListNavigation } from "./list-navigation";
import { sitePath } from "../lib/url";
import { GAME_CONFIG } from "../lib/game-config";
import { updateResourceStatsInDom } from "../lib/stats-client";
import { createCardReconciler } from "./render-resource-card";
import type { CardViewModel } from "../lib/card-view-model";
import { cardFrameFor } from "../lib/card-frame";
import type { PublicSearchCard, PublicSearchEntry } from "../lib/types";
import type { BatchResource } from "../lib/batch";
import { createBatchTray, downloadSelectedBatchFromManifest } from "./batch-tray";
import { setupGalleryDownload } from "./gallery-download";

onPageLoad(() => {
  const root = document.querySelector<HTMLElement>("[data-search-page]");
  if (root) void initializeSearch(root);
});

async function initializeSearch(root: HTMLElement): Promise<void> {
  const signal = pageSignal();
  const input = root.previousElementSibling?.querySelector<HTMLInputElement>("input[name=q]") ?? document.querySelector<HTMLInputElement>(".search-page input[name=q]");
  const results = root.querySelector<HTMLElement>("[data-search-results]");
  const loading = root.querySelector<HTMLElement>("[data-search-loading]");
  const status = root.querySelector<HTMLElement>("[data-search-status]");
  const empty = root.querySelector<HTMLElement>("[data-search-empty]");
  const retry = root.querySelector<HTMLButtonElement>("[data-search-retry]");
  const more = root.querySelector<HTMLButtonElement>("[data-search-more]");
  const game = document.querySelector<HTMLSelectElement>("[data-search-game]");
  const category = document.querySelector<HTMLSelectElement>("[data-search-category]");
  const sort = document.querySelector<HTMLSelectElement>("[data-search-sort]");
  const upscaled = document.querySelector<HTMLInputElement>("[data-search-upscaled]");
  const filterNote = document.querySelector<HTMLElement>("[data-search-filter-note]");
  const emptyCopy = root.querySelector<HTMLElement>("[data-search-empty-copy]");
  const clearCategory = root.querySelector<HTMLButtonElement>("[data-search-clear-category]");
  const clearFilters = root.querySelector<HTMLButtonElement>("[data-search-clear-filters]");
  if (!input || !results || !status || !more || !game || !category || !sort || !upscaled) return;
  const navigation = setupListNavigation(results, "search");
  const reconcile = createCardReconciler(results);
  let initialRun = true;

  const queryFromUrl = new URLSearchParams(window.location.search).get("q");
  if (queryFromUrl !== null) input.value = queryFromUrl;
  const params = new URLSearchParams(window.location.search);
  const field = input.closest("form")?.querySelector<HTMLInputElement>("[data-search-field]");
  if (field) field.disabled = params.get("field") !== "artist" || !input.value.trim();
  game.value = params.get("game") ?? "";
  category.value = params.get("category") ?? "";
  sort.value = ["title-asc", "title-desc"].includes(params.get("sort") ?? "") ? params.get("sort")! : "relevance";
  upscaled.checked = params.get("ai") === "1";

  let entriesPromise: Promise<PublicSearchEntry[]> | undefined;
  let searchCardsPromise: Promise<Map<string, PublicSearchCard>> | undefined;
  let runToken = 0;
  let matches: PublicSearchCard[] = [];
  let visibleCount = 48;
  let timer: number | undefined;
  let composing = false;
  let loadedEntries: PublicSearchEntry[] | undefined;
  let loadedCards: Map<string, PublicSearchCard> | undefined;
  let tray: ReturnType<typeof createBatchTray> | undefined;
  let resultDownload: ReturnType<typeof setupGalleryDownload> | undefined;

  function setupBatch(entries: PublicSearchEntry[], cards: Map<string, PublicSearchCard>): void {
    if (tray) return;
    const byId = new Map(entries.map(entry => [entry.resourceId, entry]));
    const base = document.documentElement.dataset.basePath ?? "/";
    // Resolve saved selections from the entire loaded index, even after filters
    // hide them. Only selected/downloaded items need this small preview adapter.
    const getResource = (id: string): BatchResource | undefined => {
      const card = cards.get(id);
      const entry = byId.get(id);
      return card && entry ? {
        resourceId: id, route: card.route ?? entry.route, displayTitle: card.displayTitle ?? entry.title,
        preview: { small: card.image, medium: card.fallback, large: null }, hasUpscaled: Boolean(card.upscaled),
      } : undefined;
    };
    tray = createBatchTray({
      root: root.parentElement!, grid: results!, getResource,
      selectionScope: "search",
      onDetailLink: navigation.captureLink,
      onDownload: (preferUpscaled, selectedIds, setStatus, taskSignal) => downloadSelectedBatchFromManifest({
        selectedIds, getResource, preferUpscaled, setStatus, filename: "rhythm-archive-search.zip",
        manifestUrl: [...new Set(selectedIds.flatMap(id => {
          const entry = byId.get(id);
          return entry ? [sitePath(`/data/batch/${entry.game}/${entry.category}.json`, base)] : [];
        }))],
        ...(taskSignal ? { signal: taskSignal } : {}),
      }),
    });
    // The shared result action only reads count, IDs and upscale availability;
    // keep the full matches array and adapt at most 30 resources on download.
    resultDownload = setupGalleryDownload(root.parentElement!, () => matches, tray, () => {
      if (composing) { matches = []; resultDownload?.update(); }
      else if (timer !== undefined) void run();
    });
  }

  const render = (): void => {
    const visible = matches.slice(0, visibleCount);
    reconcile(visible.map(resultCardView), { basePath: document.documentElement.dataset.basePath ?? "/" });
    tray?.syncCards();
    resultDownload?.update();
    navigation.remember(visibleCount);
    more.hidden = visible.length >= matches.length;
    if (empty) empty.hidden = matches.length > 0;
    status.textContent = `找到 ${matches.length.toLocaleString("zh-CN")} 项资源`;
    void updateResourceStatsInDom(results);
  };

  const syncQueryUrl = (value: string): void => {
    const url = new URL(window.location.href);
    const query = value.trim();
    if (query) url.searchParams.set("q", query); else url.searchParams.delete("q");
    if (query && field && !field.disabled) url.searchParams.set("field", "artist"); else url.searchParams.delete("field");
    for (const [key, value] of [["game", game.value], ["category", category.value], ["sort", sort.value === "relevance" ? "" : sort.value], ["ai", upscaled.checked ? "1" : ""]]) {
      if (value) url.searchParams.set(key!, value); else url.searchParams.delete(key!);
    }
    window.history.replaceState({ ...history.state }, "", url);
  };

  const loadSearchIndex = async (): Promise<PublicSearchEntry[]> => {
    if (!entriesPromise) {
      entriesPromise = loadStaticData<PublicSearchEntry[]>(resolveSitePath("data/search-index-v2.json"));
    }
    try {
      return await entriesPromise;
    } catch (error) {
      entriesPromise = undefined;
      throw error;
    }
  };

  const loadSearchCards = async (): Promise<Map<string, PublicSearchCard>> => {
    if (!searchCardsPromise) {
      searchCardsPromise = loadStaticData<PublicSearchCard[]>(resolveSitePath("data/search-cards-v2.json")).then((cards) => new Map(cards.map((card) => [card.resourceId, card])));
    }
    try {
      return await searchCardsPromise;
    } catch (error) {
      searchCardsPromise = undefined;
      throw error;
    }
  };
  onPageCleanup(() => { ++runToken; window.clearTimeout(timer); });

  const syncCategories = (): boolean => {
    const available = new Set((game.selectedOptions[0]?.dataset.categories ?? "").split(","));
    for (const option of category.options) option.disabled = Boolean(game.value && option.value && !available.has(option.value));
    const invalid = Boolean(category.value && category.selectedOptions[0]?.disabled);
    if (filterNote) filterNote.hidden = !invalid;
    return invalid;
  };
  const showEmpty = (invalidCategory: boolean): void => {
    results.replaceChildren();
    status.textContent = "找到 0 项资源";
    if (empty) empty.hidden = false;
    if (clearCategory) clearCategory.hidden = !invalidCategory;
    if (clearFilters) clearFilters.hidden = invalidCategory || !(game.value || category.value || upscaled.checked);
    if (emptyCopy) emptyCopy.textContent = invalidCategory ? "清除分类后可继续搜索。" : game.value || category.value || upscaled.checked ? "没有符合当前条件的资源。" : input.value.trim()
      ? field && !field.disabled ? "没有找到该曲师的资源。" : "没有找到匹配的资源。试试其他关键词。"
      : "没有符合筛选条件的资源。";
  };

  const run = async (): Promise<void> => {
    if (signal.aborted) return;
    window.clearTimeout(timer);
    timer = undefined;
    const token = ++runToken;
    visibleCount = initialRun ? navigation.visibleCount(48) : 48;
    initialRun = false;
    more.hidden = true;
    matches = [];
    resultDownload?.update();
    const rawQuery = input.value;
    const query = rawQuery.trim();
    const invalidCategory = syncCategories();
    if (loading) loading.hidden = true;
    results.removeAttribute("aria-busy");
    syncQueryUrl(rawQuery);
    const page = root.closest(".search-page");
    const head = root.previousElementSibling;
    if (!query && !game.value && !category.value && !upscaled.checked) {
      page?.classList.remove("has-search-query");
      head?.classList.remove("is-results");
      results.replaceChildren();
      if (empty) empty.hidden = true;
      status.textContent = "输入关键词或选择游戏、分类";
      if (retry) retry.hidden = true;
      return;
    }

    page?.classList.add("has-search-query");
    head?.classList.add("is-results");
    // Retain previous results while searching; only the first query needs placeholders.
    results.setAttribute("aria-busy", "true");
    if (loading) loading.hidden = results.childElementCount > 0;
    if (empty) empty.hidden = true;
    status.textContent = "正在搜索…";
    if (retry) retry.hidden = true;
    if (invalidCategory) {
      showEmpty(true);
      if (loading) loading.hidden = true;
      results.removeAttribute("aria-busy");
      return;
    }
    try {
      // With data loaded, run through render synchronously so the shared pack
      // action can flush a pending input before snapshotting the whole result set.
      const [entries, cardMap] = loadedEntries && loadedCards ? [loadedEntries, loadedCards] : await Promise.all([loadSearchIndex(), loadSearchCards()]);
      if (signal.aborted || token !== runToken) return;
      loadedEntries = entries;
      loadedCards = cardMap;
      setupBatch(entries, cardMap);
      const ranked = query || game.value || category.value ? rankSearchEntries(entries, query, { game: game.value, category: category.value, ...(field && !field.disabled ? { field: "artist" as const } : {}) }) : entries;
      matches = ranked.flatMap((entry) => {
        const card = cardMap.get(entry.resourceId);
        return card && (!upscaled.checked || card.upscaled) ? [{ ...card, displayTitle: card.displayTitle ?? entry.title }] : [];
      });
      if (sort.value !== "relevance") matches.sort((a, b) => {
        const compared = compareNaturalText(a.displayTitle ?? "", b.displayTitle ?? "");
        return (sort.value === "title-desc" ? -compared : compared) || a.resourceId.localeCompare(b.resourceId);
      });
      if (!matches.length) { showEmpty(false); return; }
      // One frame per result set (not per batch), so "load more" never reshapes rows.
      results.dataset.cardFrame = cardFrameFor(matches.map((card) => card.image ?? card.fallback));
      render();
      navigation.restore();
    } catch (error) {
      if (signal.aborted || token !== runToken) return;
      console.error("Search data failed", error);
      results.replaceChildren();
      if (empty) empty.hidden = true;
      status.textContent = "搜索暂时不可用，请重试";
      if (retry) retry.hidden = false;
    } finally {
      if (!signal.aborted && token === runToken) {
        if (loading) loading.hidden = true;
        results.removeAttribute("aria-busy");
      }
    }
  };

  const schedule = (): void => {
    ++runToken;
    window.clearTimeout(timer);
    if (!composing) timer = window.setTimeout(() => void run(), 150);
  };
  input.addEventListener("compositionstart", () => { composing = true; schedule(); });
  input.addEventListener("compositionend", () => { composing = false; schedule(); });
  input.addEventListener("input", schedule);
  input.closest("form")?.addEventListener("submit", (event) => { event.preventDefault(); if (!composing) void run(); });
  game.addEventListener("change", () => void run());
  category.addEventListener("change", () => void run());
  sort.addEventListener("change", () => void run());
  upscaled.addEventListener("change", () => void run());
  clearCategory?.addEventListener("click", () => { category.value = ""; void run(); });
  clearFilters?.addEventListener("click", () => { game.value = category.value = ""; sort.value = "relevance"; upscaled.checked = false; void run(); });
  more.addEventListener("click", () => { visibleCount += 48; render(); });
  retry?.addEventListener("click", () => void run());
  void run();
}

function resultCardView(card: PublicSearchCard): CardViewModel {
  return {
    resourceId: card.resourceId, route: card.route ?? `/r/${encodeURIComponent(card.resourceId)}/`, game: card.game, resourceType: card.resourceType,
    displayTitle: card.displayTitle ?? "", ...(card.artist ? { artist: card.artist } : {}),
    subtitle: `${GAME_CONFIG[card.game].displayName} · ${card.categoryLabel}`,
    preview: { primary: card.image, fallback: card.fallback, srcset: "" },
    hasUpscaled: Boolean(card.upscaled), labels: card.variantLabels ?? [],
  };
}
function resolveSitePath(path: string): string {
  const base = document.documentElement.dataset.basePath ?? "/";
  return sitePath(path, base);
}

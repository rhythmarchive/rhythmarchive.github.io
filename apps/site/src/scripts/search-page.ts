import { rankSearchEntries } from "../lib/search";
import { setupListNavigation } from "./list-navigation";
import { sitePath } from "../lib/url";
import { GAME_CONFIG } from "../lib/game-config";
import { updateResourceStatsInDom } from "../lib/stats-client";
import { renderResourceCard } from "./render-resource-card";
import type { PublicSearchCard, PublicSearchEntry } from "../lib/types";

const root = document.querySelector<HTMLElement>("[data-search-page]");
if (root) void initializeSearch(root);

async function initializeSearch(root: HTMLElement): Promise<void> {
  const input = root.previousElementSibling?.querySelector<HTMLInputElement>("input[name=q]") ?? document.querySelector<HTMLInputElement>(".search-page input[name=q]");
  const results = root.querySelector<HTMLElement>("[data-search-results]");
  const status = root.querySelector<HTMLElement>("[data-search-status]");
  const empty = root.querySelector<HTMLElement>("[data-search-empty]");
  const retry = root.querySelector<HTMLButtonElement>("[data-search-retry]");
  const more = root.querySelector<HTMLButtonElement>("[data-search-more]");
  const game = document.querySelector<HTMLSelectElement>("[data-search-game]");
  const category = document.querySelector<HTMLSelectElement>("[data-search-category]");
  if (!input || !results || !status || !more || !game || !category) return;
  const navigation = setupListNavigation(results, "search");
  let initialRun = true;

  const queryFromUrl = new URLSearchParams(window.location.search).get("q");
  if (queryFromUrl !== null) input.value = queryFromUrl;
  const params = new URLSearchParams(window.location.search);
  game.value = params.get("game") ?? "";
  category.value = params.get("category") ?? "";

  let entriesPromise: Promise<PublicSearchEntry[]> | undefined;
  let searchCardsPromise: Promise<Map<string, PublicSearchCard>> | undefined;
  let runToken = 0;
  let matches: PublicSearchCard[] = [];
  let visibleCount = 48;
  let timer: number | undefined;
  let composing = false;

  const render = (): void => {
    const visible = matches.slice(0, visibleCount);
    results.replaceChildren(...visible.map((card, index) => createResultCard(card, index)));
    more.hidden = visible.length >= matches.length;
    if (empty) empty.hidden = matches.length > 0;
    status.textContent = `找到 ${matches.length.toLocaleString("zh-CN")} 项资源`;
    void updateResourceStatsInDom(results);
  };

  const syncQueryUrl = (value: string): void => {
    const url = new URL(window.location.href);
    const query = value.trim();
    if (query) url.searchParams.set("q", query); else url.searchParams.delete("q");
    for (const [key, value] of [["game", game.value], ["category", category.value]]) {
      if (value) url.searchParams.set(key!, value); else url.searchParams.delete(key!);
    }
    window.history.replaceState({}, "", url);
  };

  const loadSearchIndex = async (): Promise<PublicSearchEntry[]> => {
    if (!entriesPromise) {
      entriesPromise = fetch(resolveSitePath("data/search-index.json"), { credentials: "omit" }).then(async (response) => {
        if (!response.ok) throw new Error(`search index failed with ${response.status}`);
        return await response.json() as PublicSearchEntry[];
      });
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
      searchCardsPromise = fetch(resolveSitePath("data/search-cards.json"), { credentials: "omit" }).then(async (response) => {
        if (!response.ok) throw new Error(`search cards failed with ${response.status}`);
        const cards = await response.json() as PublicSearchCard[];
        return new Map(cards.map((card) => [card.resourceId, card]));
      });
    }
    try {
      return await searchCardsPromise;
    } catch (error) {
      searchCardsPromise = undefined;
      throw error;
    }
  };
  const run = async (): Promise<void> => {
    window.clearTimeout(timer);
    const token = ++runToken;
    visibleCount = initialRun ? navigation.visibleCount(48) : 48;
    initialRun = false;
    more.hidden = true;
    matches = [];
    const rawQuery = input.value;
    const query = rawQuery.trim();
    syncQueryUrl(rawQuery);
    const page = root.closest(".search-page");
    const head = root.previousElementSibling;
    if (!query && !game.value && !category.value) {
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
    results.replaceChildren();
    if (empty) empty.hidden = true;
    status.textContent = "正在搜索…";
    if (retry) retry.hidden = true;
    try {
      const [entries, cardMap] = await Promise.all([loadSearchIndex(), loadSearchCards()]);
      if (token !== runToken) return;
      const ranked = rankSearchEntries(entries, query, { game: game.value, category: category.value });
      if (ranked.length === 0) {
        status.textContent = "没有找到相关资源。";
        if (empty) empty.hidden = false;
        return;
      }
      matches = ranked.map((entry) => cardMap.get(entry.resourceId)).filter((card): card is PublicSearchCard => Boolean(card));
      render();
      navigation.restore();
    } catch (error) {
      if (token !== runToken) return;
      console.error("Search data failed", error);
      results.replaceChildren();
      if (empty) empty.hidden = true;
      status.textContent = "搜索暂时不可用，请重试";
      if (retry) retry.hidden = false;
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
  input.closest("form")?.addEventListener("submit", (event) => { event.preventDefault(); void run(); });
  game.addEventListener("change", () => void run());
  category.addEventListener("change", () => void run());
  more.addEventListener("click", () => { visibleCount += 48; render(); });
  retry?.addEventListener("click", () => void run());
  void run();
}

function createResultCard(card: PublicSearchCard, index: number): HTMLElement {
  return renderResourceCard({
    resourceId: card.resourceId, route: card.route, game: card.game, resourceType: card.resourceType,
    displayTitle: card.displayTitle, ...(card.artist ? { artist: card.artist } : {}),
    subtitle: `${GAME_CONFIG[card.game].displayName} · ${card.categoryLabel}`,
    preview: { primary: card.image, fallback: card.fallback, srcset: "" },
    hasUpscaled: card.upscaled, labels: card.variantLabels,
  }, { basePath: document.documentElement.dataset.basePath ?? "/", index, isSelected: false, selectable: false });
}
function resolveSitePath(path: string): string {
  const base = document.documentElement.dataset.basePath ?? "/";
  return sitePath(path, base);
}

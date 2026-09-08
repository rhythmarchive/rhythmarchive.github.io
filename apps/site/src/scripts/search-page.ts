import { rankSearchEntries } from "../lib/search";
import { cardMediaFit, cardMediaRatio } from "../lib/media-config";
import { GAME_CONFIG } from "../lib/game-config";
import { appendResourceViews, updateResourceStatsInDom } from "../lib/stats-client";
import type { PublicSearchCard, PublicSearchEntry } from "../lib/types";

const root = document.querySelector<HTMLElement>("[data-search-page]");
if (root) void initializeSearch(root);

async function initializeSearch(root: HTMLElement): Promise<void> {
  const input = root.previousElementSibling?.querySelector<HTMLInputElement>("input[name=q]") ?? document.querySelector<HTMLInputElement>(".search-page input[name=q]");
  const results = root.querySelector<HTMLElement>("[data-search-results]");
  const status = root.querySelector<HTMLElement>("[data-search-status]");
  const retry = root.querySelector<HTMLButtonElement>("[data-search-retry]");
  if (!input || !results || !status) return;

  const queryFromUrl = new URLSearchParams(window.location.search).get("q");
  if (queryFromUrl !== null) input.value = queryFromUrl;

  let entriesPromise: Promise<PublicSearchEntry[]> | undefined;
  let searchCardsPromise: Promise<Map<string, PublicSearchCard>> | undefined;
  let runToken = 0;

  const syncQueryUrl = (value: string): void => {
    const url = new URL(window.location.href);
    const query = value.trim();
    if (query) url.searchParams.set("q", query); else url.searchParams.delete("q");
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
    const token = ++runToken;
    const rawQuery = input.value;
    const query = rawQuery.trim();
    syncQueryUrl(rawQuery);
    const page = root.closest(".search-page");
    const head = root.previousElementSibling;
    if (!query) {
      page?.classList.remove("has-search-query");
      head?.classList.remove("is-results");
      results.replaceChildren();
      status.textContent = "输入关键词搜索资源";
      if (retry) retry.hidden = true;
      return;
    }

    page?.classList.add("has-search-query");
    head?.classList.add("is-results");
    results.replaceChildren();
    status.textContent = "正在搜索…";
    if (retry) retry.hidden = true;
    try {
      const entries = await loadSearchIndex();
      if (token !== runToken) return;
      const ranked = rankSearchEntries(entries, query);
      if (ranked.length === 0) {
        status.textContent = "没有找到相关资源。";
        return;
      }
      const cardMap = await loadSearchCards();
      if (token !== runToken) return;
      const matches = ranked.map((entry) => cardMap.get(entry.resourceId)).filter((card): card is PublicSearchCard => Boolean(card));
      results.replaceChildren(...matches.map((card) => createResultCard(card)));
      void updateResourceStatsInDom(results);
      status.textContent = `找到 ${matches.length.toLocaleString("zh-CN")} 项资源`;
    } catch (error) {
      if (token !== runToken) return;
      console.error("Search data failed", error);
      results.replaceChildren();
      status.textContent = "搜索暂时不可用，请重试";
      if (retry) retry.hidden = false;
    }
  };

  input.addEventListener("input", () => void run());
  retry?.addEventListener("click", () => void run());
  void run();
}

function createResultCard(card: PublicSearchCard): HTMLElement {
  const article = document.createElement("article");
  article.className = "resource-card";
  article.dataset.resourceCard = "";
  article.dataset.resourceId = card.resourceId;
  article.dataset.game = card.game;
  article.dataset.resourceType = card.resourceType;
  article.dataset.mediaRatio = cardMediaRatio(card.game, card.resourceType);
  article.dataset.mediaFit = cardMediaFit(card.game, card.resourceType);
  const anchor = document.createElement("a");
  anchor.className = "resource-card-link";
  anchor.href = resolveSitePath(card.route);
  const media = document.createElement("div");
  media.className = "resource-card-media";
  if (card.image) {
    const img = document.createElement("img");
    img.src = card.image.url;
    img.alt = card.displayTitle;
    if (card.image.width) img.width = card.image.width;
    if (card.image.height) img.height = card.image.height;
    img.loading = "lazy";
    img.decoding = "async";
    if (card.fallback?.url) {
      img.dataset.fallbackSrc = card.fallback.url;
      if (card.fallback.width) img.dataset.fallbackWidth = String(card.fallback.width);
      if (card.fallback.height) img.dataset.fallbackHeight = String(card.fallback.height);
    }
    img.sizes = "(max-width: 640px) 50vw, (max-width: 1280px) 20vw, 210px";
    media.append(img);
  } else {
    const placeholder = document.createElement("div");
    placeholder.className = "resource-card-placeholder";
    placeholder.textContent = "图片暂不可用";
    media.append(placeholder);
  }
  if (card.upscaled) {
    const badge = document.createElement("span");
    badge.className = "resource-badge is-upscaled";
    badge.textContent = "含超分版";
    media.append(badge);
  }
  const body = document.createElement("div");
  body.className = "resource-card-body";
  const title = document.createElement("h3");
  title.textContent = card.displayTitle;
  body.append(title);
  if (card.artist) {
    const artist = document.createElement("p");
    artist.textContent = card.artist;
    body.append(artist);
  }
  const context = document.createElement("p");
  context.className = "resource-card-context";
  context.textContent = `${GAME_CONFIG[card.game].displayName} · ${card.categoryLabel}`;
  body.append(context);
  for (const labelValue of card.variantLabels) {
    const label = document.createElement("span");
    label.className = "resource-card-variant";
    label.textContent = labelValue;
    body.append(label);
  }
  appendResourceViews(body);
  anchor.append(media, body);
  article.append(anchor);
  return article;
}
function resolveSitePath(path: string): string {
  const base = document.documentElement.dataset.basePath ?? "/";
  const clean = path.startsWith("/") ? path : `/${path}`;
  return base === "/" ? clean : `${base.replace(/\/+$/u, "")}${clean}`;
}

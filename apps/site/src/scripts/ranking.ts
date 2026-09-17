import { GAME_CONFIG } from "../lib/game-config";
import { mapResourceRankingEntries } from "../lib/ranking";
import { formatStatsCount, getBrowserStatsClient, isValidResourceId, type ResourceRankingPeriod } from "../lib/stats-client";
import type { PublicRankingCard } from "../lib/types";

for (const root of document.querySelectorAll<HTMLElement>("[data-ranking-root]")) {
  void initializeRanking(root);
}

async function initializeRanking(root: HTMLElement): Promise<void> {
  const list = root.querySelector<HTMLElement>("[data-ranking-list]");
  const status = root.querySelector<HTMLElement>("[data-ranking-status]");
  const retry = root.querySelector<HTMLButtonElement>("[data-ranking-retry]");
  const periodButtons = [...root.querySelectorAll<HTMLButtonElement>("[data-ranking-period]")];
  const client = getBrowserStatsClient();
  const compact = root.dataset.rankingCompact === "true";
  const limitValue = Number(root.dataset.rankingLimit);
  const limit = Number.isSafeInteger(limitValue) && limitValue > 0 && limitValue <= 50 ? limitValue : 30;
  if (!list || !status) return;

  let period = readInitialPeriod();
  let cardsPromise: Promise<PublicRankingCard[]> | undefined;
  let runToken = 0;

  for (const button of periodButtons) {
    button.addEventListener("click", () => {
      const next = button.dataset.rankingPeriod;
      if (next !== "7d" && next !== "all") return;
      if (period === next) return;
      period = next;
      const url = new URL(window.location.href);
      if (period === "7d") url.searchParams.delete("period"); else url.searchParams.set("period", period);
      window.history.replaceState({}, "", url);
      void run();
    });
  }
  retry?.addEventListener("click", () => void run());

  if (!client.enabled) {
    if (compact) root.hidden = true;
    else status!.textContent = "热榜暂时不可用，请稍后再试。";
    return;
  }
  await run();

  async function run(): Promise<void> {
    const token = ++runToken;
    root.hidden = false;
    list!.replaceChildren();
    status!.textContent = "正在获取热榜…";
    if (retry) retry.hidden = true;
    updatePeriodButtons();
    try {
      const [cards, ranking] = await Promise.all([loadCards(), client.getResourceRanking(period, limit)]);
      if (token !== runToken) return;
      if (!ranking) throw new Error("ranking request unavailable");
      const rows = mapResourceRankingEntries(cards, ranking.entries);
      list!.replaceChildren(...rows.map((row, index) => createRankingRow(row, index + 1)));
      status!.textContent = rows.length > 0
        ? (period === "7d" ? "近 7 天" : "累计") + " · " + formatStatsCount(rows.length) + " 项"
        : "暂时没有可展示的热门资源。";
    } catch (error) {
      if (token !== runToken) return;
      console.error("Ranking data failed", error);
      list!.replaceChildren();
      status!.textContent = "热榜暂时不可用，请重试。";
      if (retry) retry.hidden = false;
    }
  }

  async function loadCards(): Promise<PublicRankingCard[]> {
    if (!cardsPromise) {
      cardsPromise = fetch(root.dataset.rankingCardsUrl ?? "", { credentials: "omit" }).then(async (response) => {
        if (!response.ok) throw new Error("ranking cards failed with " + response.status);
        const values = await response.json() as unknown;
        return Array.isArray(values) ? values.filter(isRankingCard) : [];
      });
    }
    try {
      return await cardsPromise;
    } catch (error) {
      cardsPromise = undefined;
      throw error;
    }
  }

  function readInitialPeriod(): ResourceRankingPeriod {
    return new URLSearchParams(window.location.search).get("period") === "all" ? "all" : "7d";
  }

  function updatePeriodButtons(): void {
    for (const button of periodButtons) button.setAttribute("aria-pressed", String(button.dataset.rankingPeriod === period));
  }
}

function createRankingRow(row: ReturnType<typeof mapResourceRankingEntries>[number], rank: number): HTMLElement {
  const link = document.createElement("a");
  link.className = "ranking-item";
  link.href = resolveSitePath(row.route);
  link.dataset.rankingResourceId = row.resourceId;

  const position = document.createElement("span");
  position.className = "ranking-position";
  position.setAttribute("aria-label", "第 " + rank + " 名");
  position.textContent = String(rank);

  const thumb = document.createElement("span");
  thumb.className = "ranking-thumb";
  if (row.image) {
    const image = document.createElement("img");
    image.src = row.image.url;
    image.alt = row.displayTitle;
    if (row.image.width) image.width = row.image.width;
    if (row.image.height) image.height = row.image.height;
    image.loading = rank <= 3 ? "eager" : "lazy";
    image.decoding = "async";
    if (row.fallback?.url) {
      image.dataset.fallbackSrc = row.fallback.url;
      if (row.fallback.width) image.dataset.fallbackWidth = String(row.fallback.width);
      if (row.fallback.height) image.dataset.fallbackHeight = String(row.fallback.height);
    }
    thumb.append(image);
  } else {
    thumb.textContent = "暂无图片";
  }

  const copy = document.createElement("span");
  copy.className = "ranking-copy";
  const title = document.createElement("h3");
  title.textContent = row.displayTitle;
  copy.append(title);
  if (row.artist) {
    const artist = document.createElement("p");
    artist.textContent = row.artist;
    copy.append(artist);
  }
  const context = document.createElement("span");
  context.className = "ranking-context";
  context.textContent = GAME_CONFIG[row.game].displayName + " · " + row.categoryLabel;
  copy.append(context);

  const stats = document.createElement("span");
  stats.className = "ranking-stats";
  const views = document.createElement("strong");
  views.textContent = formatStatsCount(row.views);
  const label = document.createElement("small");
  label.textContent = "浏览";
  stats.append(views, label);

  link.append(position, thumb, copy, stats);
  return link;
}

function isRankingCard(value: unknown): value is PublicRankingCard {
  if (!isRecord(value) || !isValidResourceId(value.resourceId) || typeof value.route !== "string" || typeof value.displayTitle !== "string" || typeof value.categoryLabel !== "string" || typeof value.resourceType !== "string" || typeof value.game !== "string" || !Object.prototype.hasOwnProperty.call(GAME_CONFIG, value.game)) return false;
  if (value.artist !== undefined && typeof value.artist !== "string") return false;
  return isRankingImage(value.image) && isRankingImage(value.fallback);
}

function isRankingImage(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value) || typeof value.url !== "string") return false;
  return (value.width === undefined || typeof value.width === "number") && (value.height === undefined || typeof value.height === "number");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveSitePath(route: string): string {
  const base = document.documentElement.dataset.basePath ?? "/";
  const clean = route.startsWith("/") ? route : "/" + route;
  return base === "/" ? clean : base.replace(/\/+$/u, "") + clean;
}
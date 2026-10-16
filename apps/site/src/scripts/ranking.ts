import { onPageLoad, pageSignal } from "./page-lifecycle";
import { reconcileList } from "./motion";
import { GAME_CONFIG } from "../lib/game-config";
import { resourceImageAlt } from "../lib/format";
import { sitePath } from "../lib/url";
import { mapResourceRankingEntries, rankingShardKey, type ResourceRankingRow } from "../lib/ranking";
import { formatStatsCount, getBrowserStatsClient, isValidResourceId, type ResourceRanking, type ResourceRankingPeriod } from "../lib/stats-client";
import type { PublicRankingCard } from "../lib/types";

// Shards are small immutable public projections; keep them for the session so a
// period switch or a return visit only fetches shards it has not seen yet.
const shards = new Map<string, Promise<PublicRankingCard[]>>();

onPageLoad(() => {
  for (const root of document.querySelectorAll<HTMLElement>("[data-ranking-root]")) {
    void initializeRanking(root);
  }
});

async function initializeRanking(root: HTMLElement): Promise<void> {
  const signal = pageSignal();
  const list = root.querySelector<HTMLElement>("[data-ranking-list]");
  const status = root.querySelector<HTMLElement>("[data-ranking-status]");
  const retry = root.querySelector<HTMLButtonElement>("[data-ranking-retry]");
  const periodButtons = [...root.querySelectorAll<HTMLButtonElement>("[data-ranking-period]")];
  const client = getBrowserStatsClient();
  const compact = root.dataset.rankingCompact === "true";
  const shardsUrl = root.dataset.rankingShardsUrl ?? "";
  const limitValue = Number(root.dataset.rankingLimit);
  const limit = Number.isSafeInteger(limitValue) && limitValue > 0 && limitValue <= 50 ? limitValue : 30;
  if (!list || !status) return;

  let period = readInitialPeriod();
  let runToken = 0;
  const rows = new Map<string, HTMLAnchorElement>();

  for (const button of periodButtons) {
    button.addEventListener("click", () => {
      const next = button.dataset.rankingPeriod;
      if (next !== "7d" && next !== "all") return;
      if (period === next) return;
      period = next;
      const url = new URL(window.location.href);
      if (period === "7d") url.searchParams.delete("period"); else url.searchParams.set("period", period);
      window.history.replaceState({ ...history.state }, "", url);
      void run();
    });
  }
  retry?.addEventListener("click", () => void run());

  if (!client.enabled) {
    if (compact) root.hidden = true;
    else showMessage("热榜暂时不可用，请稍后再试。");
    return;
  }
  await run();

  async function run(): Promise<void> {
    const token = ++runToken;
    root.hidden = false;
    list!.setAttribute("aria-busy", "true");
    status!.textContent = "正在获取热榜…";
    if (retry) retry.hidden = true;
    updatePeriodButtons();
    try {
      const ranking = await client.getResourceRanking(period, limit);
      if (!ranking) throw new Error("ranking request unavailable");
      const cards = await loadCards(ranking.entries.map((entry) => entry.resourceId));
      if (signal.aborted || token !== runToken) return;
      const mapped = mapResourceRankingEntries(cards, ranking.entries);
      const top = mapped[0]?.views ?? 0;
      reconcileList(list!, mapped.map((row, index) => syncRow(row, index + 1, top)), (node) => node.dataset.rankingResourceId ?? "placeholder:" + node.dataset.rank);
      list!.removeAttribute("aria-busy");
      status!.textContent = mapped.length > 0 ? describeRange(ranking) : (period === "7d" ? "近 7 天还没有浏览记录。" : "还没有浏览记录。");
    } catch (error) {
      if (signal.aborted || token !== runToken) return;
      console.error("Ranking data failed", error);
      const hasRows = rows.size > 0 && list!.querySelector("[data-ranking-resource-id]");
      if (!hasRows) list!.replaceChildren();
      list!.removeAttribute("aria-busy");
      status!.textContent = hasRows ? "刷新失败，下面仍是上次的热榜，可以重试。" : "热榜暂时不可用，请重试。";
      if (retry) retry.hidden = false;
    }
  }

  function showMessage(message: string): void {
    list!.replaceChildren();
    list!.removeAttribute("aria-busy");
    status!.textContent = message;
  }

  // One row node per resource for this list, so a period switch moves the rows
  // that stay (and keeps their loaded thumbnails) instead of rebuilding them.
  function syncRow(row: ResourceRankingRow, rank: number, top: number): HTMLAnchorElement {
    const link = rows.get(row.resourceId) ?? createRankingRow(row, rank, compact);
    rows.set(row.resourceId, link);
    link.dataset.rank = String(rank);
    link.style.setProperty("--share", String(top > 0 ? Math.max(.04, row.views / top) : 0));
    link.querySelector<HTMLElement>(".ranking-position")!.textContent = String(rank);
    link.querySelector<HTMLElement>("[data-ranking-views]")!.textContent = formatStatsCount(row.views);
    const downloads = link.querySelector<HTMLElement>("[data-ranking-downloads]")!;
    downloads.textContent = row.downloads > 0 ? "下载 " + formatStatsCount(row.downloads) : "";
    downloads.hidden = row.downloads <= 0;
    link.setAttribute("aria-label", `第 ${rank} 名 ${row.displayTitle}，${formatStatsCount(row.views)} 次浏览`);
    return link;
  }

  function readInitialPeriod(): ResourceRankingPeriod {
    return new URLSearchParams(window.location.search).get("period") === "all" ? "all" : "7d";
  }

  function updatePeriodButtons(): void {
    for (const button of periodButtons) button.setAttribute("aria-pressed", String(button.dataset.rankingPeriod === period));
  }

  async function loadCards(resourceIds: readonly string[]): Promise<PublicRankingCard[]> {
    const keys = [...new Set(resourceIds.filter(isValidResourceId).map(rankingShardKey))];
    const loaded = await Promise.all(keys.map((key) => loadShard(shardsUrl + key + ".json")));
    return loaded.flat();
  }
}

function loadShard(url: string): Promise<PublicRankingCard[]> {
  const existing = shards.get(url);
  if (existing) return existing;
  const request = fetch(url, { credentials: "omit" }).then(async (response) => {
    if (!response.ok) throw new Error(`Ranking shard failed with ${response.status}`);
    const values = await response.json() as unknown;
    return Array.isArray(values) ? values.filter(isRankingCard) : [];
  });
  shards.set(url, request);
  request.catch(() => { if (shards.get(url) === request) shards.delete(url); });
  return request;
}

function describeRange(ranking: ResourceRanking): string {
  const end = formatDay(ranking.date);
  if (ranking.period === "all") return end ? `累计浏览量，统计到${end}` : "累计浏览量";
  const start = ranking.startDate ? formatDay(ranking.startDate) : undefined;
  return start && end ? `${start}至${end}的浏览量` : "近 7 天浏览量";
}

function formatDay(value: string): string | undefined {
  const match = /^\d{4}-(\d{2})-(\d{2})$/u.exec(value);
  return match ? `${Number(match[1])}月${Number(match[2])}日` : undefined;
}

function createRankingRow(row: ResourceRankingRow, rank: number, compact: boolean): HTMLAnchorElement {
  const link = document.createElement("a");
  link.className = "ranking-item";
  link.href = resolveSitePath(row.route);
  link.dataset.rankingResourceId = row.resourceId;

  const position = document.createElement("span");
  position.className = "ranking-position";
  position.setAttribute("aria-hidden", "true");

  const thumb = document.createElement("span");
  thumb.className = "ranking-thumb";
  if (row.image) {
    const image = document.createElement("img");
    image.src = row.image.url;
    // The full ranking shows its podium larger; let the browser pick the sharper
    // existing preview there instead of stretching the small one.
    if (!compact && rank <= 3 && row.fallback?.url && row.image.width && row.fallback.width) {
      image.srcset = `${row.image.url} ${row.image.width}w, ${row.fallback.url} ${row.fallback.width}w`;
      image.sizes = "(max-width: 760px) 92vw, 400px";
    }
    image.alt = resourceImageAlt(row);
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
  stats.setAttribute("aria-hidden", "true");
  const views = document.createElement("strong");
  views.dataset.rankingViews = "";
  const label = document.createElement("small");
  label.textContent = "次浏览";
  const downloads = document.createElement("small");
  downloads.className = "ranking-downloads";
  downloads.dataset.rankingDownloads = "";
  stats.append(views, label, downloads);

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
  return sitePath(route, base);
}

export const STATS_VISITOR_STORAGE_KEY = "rhythm-archive-anonymous-visitor-id";
export const STATS_BATCH_SIZE = 100;

const RESOURCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const VISITOR_ID_PATTERN = RESOURCE_ID_PATTERN;

export type SiteStats = {
  totalVisits: number;
  todayVisits: number;
  date?: string;
};

export type ResourceStats = {
  views: number;
  downloads: number;
};

export type StatsClient = {
  enabled: boolean;
  getVisitorId(): string | undefined;
  trackSiteVisit(): Promise<SiteStats | undefined>;
  trackResourceDetail(resourceId: string): Promise<ResourceStats | undefined>;
  trackResourceDownload(resourceId: string): Promise<ResourceStats | undefined>;
  getResourceStats(resourceIds: readonly string[]): Promise<Map<string, ResourceStats>>;
};

type StorageLike = Pick<Storage, "getItem" | "setItem">;
type StatsFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type StatsWindow = Window & { __rhythmArchiveStatsClient?: StatsClient };

declare global {
  interface Window {
    __rhythmArchiveStatsClient?: StatsClient;
  }
}

export function normalizeStatsApiUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return url.toString().replace(/\/+$/u, "");
  } catch {
    return undefined;
  }
}

export function isValidResourceId(value: unknown): value is string {
  return typeof value === "string" && RESOURCE_ID_PATTERN.test(value);
}

export function isValidVisitorId(value: unknown): value is string {
  return typeof value === "string" && VISITOR_ID_PATTERN.test(value);
}

export function formatStatsCount(value: number): string {
  return (Number.isSafeInteger(value) && value >= 0 ? value : 0).toLocaleString("zh-CN");
}

export function chunkResourceIds(resourceIds: readonly string[], chunkSize = STATS_BATCH_SIZE): string[][] {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) return [];
  const unique = [...new Set(resourceIds.filter(isValidResourceId))];
  const chunks: string[][] = [];
  for (let index = 0; index < unique.length; index += chunkSize) chunks.push(unique.slice(index, index + chunkSize));
  return chunks;
}

export function createStatsClient(options: {
  apiUrl?: string | undefined;
  storage?: StorageLike | undefined;
  fetchImpl?: StatsFetch | undefined;
  visitorIdFactory?: (() => string) | undefined;
} = {}): StatsClient {
  const apiUrl = normalizeStatsApiUrl(options.apiUrl);
  const storage = options.storage;
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const visitorIdFactory = options.visitorIdFactory ?? createAnonymousId;
  const resourceCache = new Map<string, ResourceStats>();
  const pendingResourceRequests = new Map<string, Promise<void>>();
  let cachedVisitorId: string | undefined;

  const client: StatsClient = {
    enabled: Boolean(apiUrl),
    getVisitorId,
    trackSiteVisit,
    trackResourceDetail,
    trackResourceDownload,
    getResourceStats,
  };

  return client;

  function getVisitorId(): string | undefined {
    if (cachedVisitorId) return cachedVisitorId;
    if (!storage) return undefined;
    try {
      const stored = storage.getItem(STATS_VISITOR_STORAGE_KEY);
      if (isValidVisitorId(stored)) {
        cachedVisitorId = stored;
        return cachedVisitorId;
      }
      const generated = visitorIdFactory();
      if (!isValidVisitorId(generated)) return undefined;
      storage.setItem(STATS_VISITOR_STORAGE_KEY, generated);
      cachedVisitorId = generated;
      return cachedVisitorId;
    } catch {
      return undefined;
    }
  }

  async function trackSiteVisit(): Promise<SiteStats | undefined> {
    const visitorId = getVisitorId();
    if (!apiUrl || !visitorId) return undefined;
    const payload = await postEvent({ type: "site_visit", visitorId });
    return payload ? parseSiteStats(payload.site) : undefined;
  }

  async function trackResourceDetail(resourceId: string): Promise<ResourceStats | undefined> {
    return trackResourceEvent({ type: "resource_detail", resourceId });
  }

  async function trackResourceDownload(resourceId: string): Promise<ResourceStats | undefined> {
    return trackResourceEvent({ type: "resource_download", resourceId });
  }

  async function trackResourceEvent(event: { type: "resource_detail" | "resource_download"; resourceId: string }): Promise<ResourceStats | undefined> {
    const visitorId = getVisitorId();
    if (!apiUrl || !visitorId || !isValidResourceId(event.resourceId)) return undefined;
    const payload = await postEvent({ ...event, visitorId });
    const stats = payload ? parseResourceStats(payload.resource) : undefined;
    if (stats) resourceCache.set(event.resourceId, stats);
    return stats;
  }

  async function getResourceStats(resourceIds: readonly string[]): Promise<Map<string, ResourceStats>> {
    const ids = [...new Set(resourceIds.filter(isValidResourceId))];
    if (ids.length === 0) return new Map();
    if (!apiUrl) return cachedStats(ids);

    const requests: Promise<void>[] = [];
    for (const batch of chunkResourceIds(ids)) {
      const missing = batch.filter((id) => !resourceCache.has(id) && !pendingResourceRequests.has(id));
      if (missing.length > 0) {
        const promise = requestResourceStats(missing).finally(() => {
          for (const id of missing) if (pendingResourceRequests.get(id) === promise) pendingResourceRequests.delete(id);
        });
        for (const id of missing) pendingResourceRequests.set(id, promise);
      }
      for (const id of batch) {
        const pending = pendingResourceRequests.get(id);
        if (pending) requests.push(pending);
      }
    }
    await Promise.all(requests);
    return cachedStats(ids);
  }

  function cachedStats(ids: readonly string[]): Map<string, ResourceStats> {
    return new Map(ids.flatMap((id) => {
      const stats = resourceCache.get(id);
      return stats ? [[id, stats] as [string, ResourceStats]] : [];
    }));
  }

  async function requestResourceStats(resourceIds: readonly string[]): Promise<void> {
    if (!apiUrl || resourceIds.length === 0) return;
    try {
      const response = await fetchImpl(`${apiUrl}/v1/resources/stats`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resourceIds }),
        credentials: "omit",
      });
      if (!response.ok) return;
      const body = await response.json() as { stats?: Record<string, unknown> };
      if (!body.stats || typeof body.stats !== "object") return;
      for (const resourceId of resourceIds) {
        const stats = parseResourceStats(body.stats[resourceId]);
        if (stats) resourceCache.set(resourceId, stats);
      }
    } catch {
      // Statistics are optional; gallery rendering must continue without them.
    }
  }

  async function postEvent(event: Record<string, string>): Promise<{ site?: unknown; resource?: unknown } | undefined> {
    if (!apiUrl) return undefined;
    try {
      const response = await fetchImpl(`${apiUrl}/v1/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
        credentials: "omit",
        keepalive: true,
      });
      if (!response.ok) return undefined;
      const body = await response.json() as { ok?: unknown; site?: unknown; resource?: unknown };
      return body.ok === true ? body : undefined;
    } catch {
      // A failed optional request must not surface an error in the site UI.
      return undefined;
    }
  }
}

export function getBrowserStatsClient(): StatsClient {
  if (typeof window === "undefined" || typeof document === "undefined") return createStatsClient();
  const statsWindow = window as StatsWindow;
  if (statsWindow.__rhythmArchiveStatsClient) return statsWindow.__rhythmArchiveStatsClient;
  let storage: StorageLike | undefined;
  try {
    storage = window.localStorage;
  } catch {
    storage = undefined;
  }
  const client = createStatsClient({ apiUrl: document.documentElement.dataset.statsApiUrl, storage, fetchImpl: window.fetch.bind(window) });
  statsWindow.__rhythmArchiveStatsClient = client;
  return client;
}

export async function updateResourceStatsInDom(scope: ParentNode, resourceIds?: readonly string[]): Promise<void> {
  const client = getBrowserStatsClient();
  const cards = [...scope.querySelectorAll<HTMLElement>("[data-resource-card][data-resource-id]")];
  const ids = resourceIds ? [...new Set(resourceIds.filter(isValidResourceId))] : cards.map((card) => card.dataset.resourceId).filter(isValidResourceId);
  if (ids.length === 0) return;
  const stats = await client.getResourceStats(ids);
  for (const card of cards) {
    const resourceId = card.dataset.resourceId;
    if (!resourceId) continue;
    const resourceStats = stats.get(resourceId);
    if (!resourceStats) continue;
    const node = card.querySelector<HTMLElement>("[data-resource-views]");
    const value = node?.querySelector<HTMLElement>("[data-resource-views-value]");
    if (!node || !value) continue;
    value.textContent = formatStatsCount(resourceStats.views);
    node.hidden = false;
  }
}

export function appendResourceViews(parent: HTMLElement): HTMLElement {
  const node = document.createElement("span");
  node.className = "resource-card-views";
  node.dataset.resourceViews = "";
  node.hidden = true;
  node.setAttribute("aria-label", "浏览量");
  node.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-5.5 9.5-5.5 9.5 5.5 9.5 5.5-3.5 5.5-9.5 5.5S2.5 12 2.5 12Z"></path><circle cx="12" cy="12" r="2.5"></circle></svg><span data-resource-views-value></span>';
  parent.append(node);
  return node;
}

export function renderSiteStats(stats: SiteStats | undefined, scope: ParentNode = document): void {
  if (!stats || !Number.isSafeInteger(stats.totalVisits) || !Number.isSafeInteger(stats.todayVisits) || stats.totalVisits < 0 || stats.todayVisits < 0) return;
  const container = scope.querySelector<HTMLElement>("[data-site-stats]");
  const total = scope.querySelector<HTMLElement>("[data-site-total-visits]");
  const today = scope.querySelector<HTMLElement>("[data-site-today-visits]");
  if (!container || !total || !today) return;
  total.textContent = formatStatsCount(stats.totalVisits);
  today.textContent = formatStatsCount(stats.todayVisits);
  container.hidden = false;
}

function parseSiteStats(value: unknown): SiteStats | undefined {
  if (!isRecord(value)) return undefined;
  const totalVisits = value.totalVisits;
  const todayVisits = value.todayVisits;
  if (typeof totalVisits !== "number" || typeof todayVisits !== "number") return undefined;
  return { totalVisits, todayVisits, ...(typeof value.date === "string" ? { date: value.date } : {}) };
}

function parseResourceStats(value: unknown): ResourceStats | undefined {
  if (!isRecord(value) || typeof value.views !== "number" || typeof value.downloads !== "number") return undefined;
  if (!Number.isSafeInteger(value.views) || !Number.isSafeInteger(value.downloads) || value.views < 0 || value.downloads < 0) return undefined;
  return { views: value.views, downloads: value.downloads };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createAnonymousId(): string {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject?.randomUUID) return cryptoObject.randomUUID();
  if (cryptoObject?.getRandomValues) {
    const bytes = cryptoObject.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6]! & 0x0f) | 0x70;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return "00000000-0000-7000-8000-" + Math.random().toString(16).slice(2).padEnd(12, "0").slice(0, 12);
}

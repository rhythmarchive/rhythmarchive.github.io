const DEFAULT_ALLOWED_ORIGIN = "https://rhythmarchive.github.io";
export const SITE_SESSION_WINDOW_MS = 30 * 60 * 1000;
export const DOWNLOAD_DEDUPE_WINDOW_MS = 10 * 1000;
export const MAX_RESOURCE_IDS = 100;
export const MAX_EVENT_BODY_BYTES = 16 * 1024;

const RESOURCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const VISITOR_ID_PATTERN = RESOURCE_ID_PATTERN;

export type StatsEvent =
  | { type: "site_visit"; visitorId: string }
  | { type: "resource_detail"; visitorId: string; resourceId: string }
  | { type: "resource_download"; visitorId: string; resourceId: string };

export type ResourceStats = {
  views: number;
  downloads: number;
};

export type SiteStats = {
  totalVisits: number;
  todayVisits: number;
  date: string;
};

export type RecordedEvent = {
  siteVisitCounted: boolean;
  viewCounted: boolean;
  downloadCounted: boolean;
  site?: SiteStats;
  resource?: ResourceStats;
};

export interface StatsStore {
  recordEvent(event: StatsEvent, nowMs: number, date: string): Promise<RecordedEvent>;
  getSiteStats(date: string): Promise<SiteStats>;
  getResourceStats(resourceIds: readonly string[]): Promise<Map<string, ResourceStats>>;
}

export interface D1Result<T = unknown> {
  results?: T[];
  success?: boolean;
  meta?: {
    changes?: number;
    rows_written?: number;
    [key: string]: unknown;
  };
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run<T = unknown>(): Promise<D1Result<T>>;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

export interface Env {
  DB?: D1Database;
  ALLOWED_ORIGINS?: string;
  SITE_TIME_ZONE?: string;
}

type HandlerOptions = {
  store?: StatsStore;
  now?: () => number;
};

type JsonRecord = Record<string, unknown>;

const CLAIM_DEDUPE_SQL = `
  INSERT OR IGNORE INTO event_dedupe
    (visitor_id, dedupe_kind, resource_id, expires_at)
  VALUES (?, ?, ?, ?)
`;

export class D1StatsStore implements StatsStore {
  constructor(private readonly db: D1Database) {}

  async recordEvent(event: StatsEvent, nowMs: number, date: string): Promise<RecordedEvent> {
    await this.db.prepare("DELETE FROM event_dedupe WHERE expires_at <= ?").bind(nowMs).run();

    if (event.type === "site_visit") {
      const counted = await this.claim(event.visitorId, "site", "", nowMs + SITE_SESSION_WINDOW_MS);
      if (counted) {
        await this.db.prepare(`
          UPDATE site_totals
          SET total_visits = total_visits + 1, updated_at = ?
          WHERE id = 1
        `).bind(nowMs).run();
        await this.db.prepare(`
          INSERT INTO site_daily (visit_date, total_visits, updated_at)
          VALUES (?, 1, ?)
          ON CONFLICT(visit_date) DO UPDATE SET
            total_visits = site_daily.total_visits + 1,
            updated_at = excluded.updated_at
        `).bind(date, nowMs).run();
      }
      return { siteVisitCounted: counted, viewCounted: false, downloadCounted: false, site: await this.getSiteStats(date) };
    }

    const viewCounted = await this.claim(event.visitorId, "view", event.resourceId, nowMs + SITE_SESSION_WINDOW_MS);
    if (viewCounted) await this.incrementResource(event.resourceId, "views", nowMs);

    let downloadCounted = false;
    if (event.type === "resource_download") {
      downloadCounted = await this.claim(event.visitorId, "download", event.resourceId, nowMs + DOWNLOAD_DEDUPE_WINDOW_MS);
      if (downloadCounted) await this.incrementResource(event.resourceId, "downloads", nowMs);
    }

    const resourceStats = (await this.getResourceStats([event.resourceId])).get(event.resourceId) ?? { views: 0, downloads: 0 };
    return { siteVisitCounted: false, viewCounted, downloadCounted, resource: resourceStats };
  }

  async getSiteStats(date: string): Promise<SiteStats> {
    const total = await this.db.prepare("SELECT total_visits FROM site_totals WHERE id = 1").first<{ total_visits?: number }>();
    const daily = await this.db.prepare("SELECT total_visits FROM site_daily WHERE visit_date = ?").bind(date).first<{ total_visits?: number }>();
    return {
      totalVisits: safeCounter(total?.total_visits),
      todayVisits: safeCounter(daily?.total_visits),
      date,
    };
  }

  async getResourceStats(resourceIds: readonly string[]): Promise<Map<string, ResourceStats>> {
    if (resourceIds.length === 0) return new Map();
    const placeholders = resourceIds.map(() => "?").join(", ");
    const rows = await this.db.prepare(`
      SELECT resource_id, total_views, total_downloads
      FROM resource_stats
      WHERE resource_id IN (${placeholders})
    `).bind(...resourceIds).all<{ resource_id: string; total_views?: number; total_downloads?: number }>();
    const result = new Map<string, ResourceStats>();
    for (const row of rows.results ?? []) {
      result.set(row.resource_id, { views: safeCounter(row.total_views), downloads: safeCounter(row.total_downloads) });
    }
    return result;
  }

  private async claim(visitorId: string, kind: string, resourceId: string, expiresAt: number): Promise<boolean> {
    const result = await this.db.prepare(CLAIM_DEDUPE_SQL).bind(visitorId, kind, resourceId, expiresAt).run();
    return resultChanges(result) > 0;
  }

  private async incrementResource(resourceId: string, field: "views" | "downloads", nowMs: number): Promise<void> {
    if (field === "views") {
      await this.db.prepare(`
        INSERT INTO resource_stats (resource_id, total_views, total_downloads, updated_at)
        VALUES (?, 1, 0, ?)
        ON CONFLICT(resource_id) DO UPDATE SET
          total_views = resource_stats.total_views + 1,
          updated_at = excluded.updated_at
      `).bind(resourceId, nowMs).run();
      return;
    }
    await this.db.prepare(`
      INSERT INTO resource_stats (resource_id, total_views, total_downloads, updated_at)
      VALUES (?, 0, 1, ?)
      ON CONFLICT(resource_id) DO UPDATE SET
        total_downloads = resource_stats.total_downloads + 1,
        updated_at = excluded.updated_at
    `).bind(resourceId, nowMs).run();
  }
}

export function isValidResourceId(value: unknown): value is string {
  return typeof value === "string" && RESOURCE_ID_PATTERN.test(value);
}

export function isValidVisitorId(value: unknown): value is string {
  return typeof value === "string" && VISITOR_ID_PATTERN.test(value);
}

export function validateEventPayload(value: unknown): { event?: StatsEvent; error?: string } {
  if (!isRecord(value)) return { error: "invalid_json_body" };
  if (value.type !== "site_visit" && value.type !== "resource_detail" && value.type !== "resource_download") return { error: "invalid_event_type" };
  if (!isValidVisitorId(value.visitorId)) return { error: "invalid_visitor_id" };
  if (value.type === "site_visit") return { event: { type: value.type, visitorId: value.visitorId } };
  if (!isValidResourceId(value.resourceId)) return { error: "invalid_resource_id" };
  return { event: { type: value.type, visitorId: value.visitorId, resourceId: value.resourceId } };
}

export function validateResourceIds(value: unknown): { resourceIds?: string[]; error?: string } {
  if (!isRecord(value) || !Array.isArray(value.resourceIds)) return { error: "invalid_resource_ids" };
  if (value.resourceIds.length === 0 || value.resourceIds.length > MAX_RESOURCE_IDS) return { error: "resource_id_batch_too_large" };
  if (!value.resourceIds.every(isValidResourceId)) return { error: "invalid_resource_id" };
  return { resourceIds: [...new Set(value.resourceIds)] };
}

export function siteDateKey(nowMs: number, timeZone = "Asia/Shanghai"): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const values = new Map(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.get("year") ?? "1970"}-${values.get("month") ?? "01"}-${values.get("day") ?? "01"}`;
}

export async function handleRequest(request: Request, env: Env, options: HandlerOptions = {}): Promise<Response> {
  const origin = request.headers.get("Origin");
  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  if (origin && !allowedOrigins.has(origin)) return json({ error: "origin_not_allowed" }, 403);

  const corsHeaders = createCorsHeaders(origin);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/u, "") || "/";
  if (path === "/health" && request.method === "GET") return json({ ok: true }, 200, corsHeaders);

  const store = options.store ?? (env.DB ? new D1StatsStore(env.DB) : undefined);
  if (!store) return json({ error: "stats_unavailable" }, 503, corsHeaders);
  const nowMs = options.now?.() ?? Date.now();
  const date = siteDateKey(nowMs, env.SITE_TIME_ZONE || "Asia/Shanghai");

  try {
    if (path === "/v1/site/stats" && request.method === "GET") {
      return json(await store.getSiteStats(date), 200, corsHeaders);
    }
    if (path === "/v1/events" && request.method === "POST") {
      const body = await readJsonBody(request);
      const validation = validateEventPayload(body);
      const event = validation.event;
      if (!event) return json({ error: validation.error ?? "invalid_event" }, 400, corsHeaders);
      const recorded = await store.recordEvent(event, nowMs, date);
      return json({
        ok: true,
        event: event.type,
        counted: {
          siteVisit: recorded.siteVisitCounted,
          view: recorded.viewCounted,
          download: recorded.downloadCounted,
        },
        ...(recorded.site ? { site: recorded.site } : {}),
        ...(recorded.resource && event.type !== "site_visit" ? { resource: { resourceId: event.resourceId, ...recorded.resource } } : {}),
      }, 200, corsHeaders);
    }
    if (path === "/v1/resources/stats" && request.method === "POST") {
      const body = await readJsonBody(request);
      const validation = validateResourceIds(body);
      if (!validation.resourceIds) return json({ error: validation.error ?? "invalid_resource_ids" }, 400, corsHeaders);
      const stats = await store.getResourceStats(validation.resourceIds);
      const responseStats: Record<string, ResourceStats> = {};
      for (const resourceId of validation.resourceIds) responseStats[resourceId] = stats.get(resourceId) ?? { views: 0, downloads: 0 };
      return json({ stats: responseStats }, 200, corsHeaders);
    }
    if (path === "/v1/site/stats" || path === "/v1/events" || path === "/v1/resources/stats") {
      return json({ error: "method_not_allowed" }, 405, { ...corsHeaders, Allow: path === "/v1/site/stats" ? "GET" : "POST" });
    }
    return json({ error: "not_found" }, 404, corsHeaders);
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.code }, error.status, corsHeaders);
    console.error("Stats request failed", error instanceof Error ? error.message : String(error));
    return json({ error: "stats_unavailable" }, 503, corsHeaders);
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonBody(request: Request): Promise<unknown> {
  const contentLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_EVENT_BODY_BYTES) throw new HttpError("request_too_large", 413);
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_EVENT_BODY_BYTES) throw new HttpError("request_too_large", 413);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError("invalid_json_body", 400);
  }
}

class HttpError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
  }
}

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json; charset=utf-8");
  responseHeaders.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(value), { status, headers: responseHeaders });
}

function createCorsHeaders(origin: string | null): Headers {
  const headers = new Headers({
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  });
  if (origin) headers.set("Access-Control-Allow-Origin", origin);
  return headers;
}

function parseAllowedOrigins(value: string | undefined): Set<string> {
  const configured = (value || DEFAULT_ALLOWED_ORIGIN).split(",").map((origin) => origin.trim()).filter((origin) => origin && origin !== "*");
  return new Set(configured);
}

function resultChanges(result: D1Result): number {
  return Number(result.meta?.changes ?? result.meta?.rows_written ?? 0);
}

function safeCounter(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

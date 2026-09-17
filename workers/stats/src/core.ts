import { isUuidV7, normalizeUuid } from "../../../packages/domain/src/identifiers.js";
import { PUBLIC_GAME_DISPLAY_NAMES, PUBLIC_GAME_SLUGS, PUBLIC_RESOURCE_CATALOG_GENERATED_AT, PUBLIC_RESOURCE_IDS, type PublicGameSlug } from "./public-resource-registry.js";
export type { PublicGameSlug } from "./public-resource-registry.js";

const DEFAULT_ALLOWED_ORIGIN = "https://rhythmarchive.github.io";
const PUBLIC_GAME_SLUG_SET = new Set<string>(PUBLIC_GAME_SLUGS);
export const SITE_SESSION_WINDOW_MS = 30 * 60 * 1000;
export const DOWNLOAD_DEDUPE_WINDOW_MS = 10 * 1000;
export const MAX_RESOURCE_IDS = 100;
export const DEFAULT_RANKING_LIMIT = 12;
export const MAX_RANKING_LIMIT = 50;
export const MAX_EVENT_BODY_BYTES = 16 * 1024;
export const PUBLIC_EVENT_RATE_LIMIT_WINDOW_MS = 60 * 1000;
export const PUBLIC_EVENT_RATE_LIMIT_MAX_REQUESTS = 60;
export const PUBLIC_READ_RATE_LIMIT_WINDOW_MS = 60 * 1000;
export const PUBLIC_READ_RATE_LIMIT_MAX_REQUESTS = 120;
export const UPDATE_REMINDER_IP_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
export const UPDATE_REMINDER_IP_RATE_LIMIT_MAX_REQUESTS = 20;
export const SITE_DAILY_STATS_RETENTION_DAYS = 35;
export const RESOURCE_DAILY_STATS_RETENTION_DAYS = 35;
export const UPDATE_REMINDER_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const UPDATE_REMINDER_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
export const UPDATE_REMINDER_MAX_REQUESTS_PER_WINDOW = 10;
export const UPDATE_REMINDER_NOTIFICATION_RETRY_BASE_MS = 5 * 60 * 1000;
export const UPDATE_REMINDER_NOTIFICATION_LEASE_MS = 5 * 60 * 1000;
export const UPDATE_REMINDER_NOTIFICATION_MAX_ATTEMPTS = 5;
export const UPDATE_REMINDER_NOTIFICATION_MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

export type StatsEvent =
  | { type: "site_visit"; visitorId: string }
  | { type: "resource_detail"; visitorId: string; resourceId: string }
  | { type: "resource_download"; visitorId: string; resourceId: string };

export type ResourceStats = {
  views: number;
  downloads: number;
};

export type ResourceRankingPeriod = "7d" | "all";

export type ResourceRankingEntry = ResourceStats & {
  resourceId: string;
};

export type SiteStats = {
  totalVisits: number;
  todayVisits: number;
  date: string;
};

export type UpdateReminderNotificationStatus = "none" | "pending" | "sent" | "failed";

export type UpdateReminderSummary = {
  game: PublicGameSlug;
  pending: boolean;
  cycleId: number | null;
  cycleNumber: number;
  firstReminderAt: number | null;
  lastReminderAt: number | null;
  effectiveReminderCount: number;
  cycleEffectiveReminderCount: number;
  lastNotifiedAt: number | null;
  notificationStatus: UpdateReminderNotificationStatus;
  notificationAttempts: number;
  nextNotificationAt: number | null;
  lastNotificationError: string | null;
  resolvedAt: number | null;
};

export type UpdateReminderResult =
  | { status: "accepted"; firstReminder: boolean; summary: UpdateReminderSummary }
  | { status: "duplicate"; nextAllowedAt: number; summary: UpdateReminderSummary }
  | { status: "rate_limited"; retryAfterSeconds: number };

export type UpdateReminderNotificationClaim = {
  cycleId: number;
  game: PublicGameSlug;
  cycleNumber: number;
  attempt: number;
  summary: UpdateReminderSummary;
};
export type RecordedEvent = {
  siteVisitCounted: boolean;
  viewCounted: boolean;
  downloadCounted: boolean;
  site?: SiteStats;
  resource?: ResourceStats;
};

export type RequestRateLimitResult = { allowed: boolean; retryAfterSeconds: number };
export type RateLimitBinding = { limit(options: { key: string }): Promise<{ success: boolean }> };

export interface StatsStore {
  recordEvent(event: StatsEvent, nowMs: number, date: string): Promise<RecordedEvent>;
  recordUpdateReminder(visitorId: string, game: PublicGameSlug, nowMs: number): Promise<UpdateReminderResult>;
  consumeRequestRateLimit?(rateKey: string, scope: string, nowMs: number, windowMs: number, maxRequests: number): Promise<RequestRateLimitResult>;
  cleanup?(nowMs: number, date: string): Promise<void>;
  listPendingUpdateReminders(): Promise<UpdateReminderSummary[]>;
  resolveUpdateReminder(game: PublicGameSlug, nowMs: number): Promise<UpdateReminderSummary | undefined>;
  retryUpdateReminderNotification(game: PublicGameSlug, nowMs: number): Promise<UpdateReminderSummary | undefined>;
  claimDueUpdateReminderNotifications(nowMs: number): Promise<UpdateReminderNotificationClaim[]>;
  markUpdateReminderNotificationSent(cycleId: number, game: PublicGameSlug, nowMs: number): Promise<void>;
  markUpdateReminderNotificationFailed(cycleId: number, nowMs: number, nextNotificationAt: number | null, errorCode: string): Promise<void>;
  getSiteStats(date: string): Promise<SiteStats>;
  getResourceStats(resourceIds: readonly string[]): Promise<Map<string, ResourceStats>>;
  getResourceRanking(period: ResourceRankingPeriod, date: string, limit: number): Promise<ResourceRankingEntry[]>;
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
  RATE_LIMITER?: RateLimitBinding;
  RATE_LIMIT_HASH_SECRET?: string;
  TURNSTILE_SECRET_KEY?: string;
  RESEND_API_KEY?: string;
  UPDATE_REMINDER_EMAIL_TO?: string;
  UPDATE_REMINDER_ADMIN_TOKEN?: string;
}

export type NotificationFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type HandlerOptions = {
  store?: StatsStore;
  now?: () => number;
  waitUntil?: (promise: Promise<unknown>) => void;
  fetchImpl?: NotificationFetch | undefined;
};

type JsonRecord = Record<string, unknown>;

type UpdateReminderGameRow = {
  game?: string;
  pending?: number;
  first_reminded_at?: number | null;
  last_reminded_at?: number | null;
  effective_reminder_count?: number;
  last_notified_at?: number | null;
};

type UpdateReminderCycleRow = {
  id: number;
  game: string;
  cycle_number: number;
  pending: number;
  first_reminded_at: number;
  last_reminded_at: number;
  effective_reminder_count: number;
  last_notified_at: number | null;
  notification_status: string;
  notification_attempts: number;
  last_notification_attempt_at: number | null;
  next_notification_at: number | null;
  last_notification_error: string | null;
  resolved_at: number | null;
};

const CLAIM_DEDUPE_SQL = `
  INSERT OR IGNORE INTO event_dedupe
    (visitor_id, dedupe_kind, resource_id, expires_at)
  VALUES (?, ?, ?, ?)
`;

export class D1StatsStore implements StatsStore {
  constructor(private readonly db: D1Database) {}

  async consumeRequestRateLimit(rateKey: string, scope: string, nowMs: number, windowMs: number, maxRequests: number): Promise<RequestRateLimitResult> {
    await this.db.prepare(`
      DELETE FROM request_rate_limits
      WHERE window_started_at + ? <= ?
    `).bind(24 * 60 * 60 * 1000, nowMs).run();
    await this.db.prepare(`
      INSERT INTO request_rate_limits (rate_key, scope, window_started_at, request_count)
      VALUES (?, ?, ?, 1)
      ON CONFLICT(rate_key, scope) DO UPDATE SET
        window_started_at = CASE
          WHEN request_rate_limits.window_started_at + ? <= ? THEN excluded.window_started_at
          ELSE request_rate_limits.window_started_at
        END,
        request_count = CASE
          WHEN request_rate_limits.window_started_at + ? <= ? THEN 1
          ELSE request_rate_limits.request_count + 1
        END
    `).bind(rateKey, scope, nowMs, windowMs, nowMs, windowMs, nowMs).run();
    const row = await this.db.prepare(`
      SELECT window_started_at, request_count
      FROM request_rate_limits
      WHERE rate_key = ? AND scope = ?
    `).bind(rateKey, scope).first<{ window_started_at?: number; request_count?: number }>();
    const windowStartedAt = typeof row?.window_started_at === "number" ? row.window_started_at : nowMs;
    const requestCount = safeCounter(row?.request_count);
    if (requestCount <= maxRequests) return { allowed: true, retryAfterSeconds: 0 };
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((windowStartedAt + windowMs - nowMs) / 1000)),
    };
  }
  async recordEvent(event: StatsEvent, nowMs: number, date: string): Promise<RecordedEvent> {
    if (event.type !== "site_visit" && !isPublicResourceId(event.resourceId)) throw new Error("resource is not in the public Catalog");
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
    if (viewCounted) await this.incrementResource(event.resourceId, "views", nowMs, date);

    let downloadCounted = false;
    if (event.type === "resource_download") {
      downloadCounted = await this.claim(event.visitorId, "download", event.resourceId, nowMs + DOWNLOAD_DEDUPE_WINDOW_MS);
      if (downloadCounted) await this.incrementResource(event.resourceId, "downloads", nowMs, date);
    }

    const resourceStats = (await this.getResourceStats([event.resourceId])).get(event.resourceId) ?? { views: 0, downloads: 0 };
    return { siteVisitCounted: false, viewCounted, downloadCounted, resource: resourceStats };
  }

  async cleanup(nowMs: number, date: string): Promise<void> {
    await this.db.prepare("DELETE FROM event_dedupe WHERE expires_at <= ?").bind(nowMs).run();
    await this.db.prepare("DELETE FROM request_rate_limits WHERE window_started_at + ? <= ?").bind(24 * 60 * 60 * 1000, nowMs).run();
    await this.db.prepare("DELETE FROM site_daily WHERE visit_date < ?").bind(dateOffset(date, -SITE_DAILY_STATS_RETENTION_DAYS)).run();
    await this.db.prepare("DELETE FROM resource_daily_stats WHERE stat_date < ?").bind(dateOffset(date, -RESOURCE_DAILY_STATS_RETENTION_DAYS)).run();
    await this.db.prepare(`
      DELETE FROM update_reminder_cycle_visitors
      WHERE last_reminded_at + ? <= ?
         OR cycle_id IN (SELECT id FROM update_reminder_cycles WHERE resolved_at IS NOT NULL)
    `).bind(UPDATE_REMINDER_DEDUPE_WINDOW_MS, nowMs).run();
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
    const publicResourceIds = [...new Set(resourceIds.filter(isPublicResourceId))];
    if (publicResourceIds.length === 0) return new Map();
    const placeholders = publicResourceIds.map(() => "?").join(", ");
    const rows = await this.db.prepare(`
      SELECT resource_id, total_views, total_downloads
      FROM resource_stats
      WHERE resource_id IN (${placeholders})
    `).bind(...publicResourceIds).all<{ resource_id: string; total_views?: number; total_downloads?: number }>();
    const result = new Map<string, ResourceStats>();
    for (const row of rows.results ?? []) {
      result.set(row.resource_id, { views: safeCounter(row.total_views), downloads: safeCounter(row.total_downloads) });
    }
    return result;
  }

  async getResourceRanking(period: ResourceRankingPeriod, date: string, limit: number): Promise<ResourceRankingEntry[]> {
    const rows = period === "all"
      ? await this.db.prepare(`
          SELECT resource_id, total_views, total_downloads
          FROM resource_stats
          WHERE total_views > 0 OR total_downloads > 0
          ORDER BY total_views DESC, total_downloads DESC, resource_id ASC
          LIMIT ?
        `).bind(limit).all<{ resource_id: string; total_views?: number; total_downloads?: number }>()
      : await this.db.prepare(`
          SELECT resource_id,
                 SUM(daily_views) AS total_views,
                 SUM(daily_downloads) AS total_downloads
          FROM resource_daily_stats
          WHERE stat_date BETWEEN ? AND ?
          GROUP BY resource_id
          HAVING SUM(daily_views) > 0 OR SUM(daily_downloads) > 0
          ORDER BY total_views DESC, total_downloads DESC, resource_id ASC
          LIMIT ?
        `).bind(resourceRankingDateRange(date).startDate, date, limit).all<{ resource_id: string; total_views?: number; total_downloads?: number }>();
    return (rows.results ?? []).filter((row) => isPublicResourceId(row.resource_id)).map((row) => ({
      resourceId: row.resource_id,
      views: safeCounter(row.total_views),
      downloads: safeCounter(row.total_downloads),
    }));
  }

  private async ensureUpdateReminderGame(game: PublicGameSlug): Promise<void> {
    await this.db.prepare(`
      INSERT OR IGNORE INTO update_reminder_games
        (game, pending, first_reminded_at, last_reminded_at, effective_reminder_count, last_notified_at)
      VALUES (?, 0, NULL, NULL, 0, NULL)
    `).bind(game).run();
  }

  private async getUpdateReminderSummary(game: PublicGameSlug): Promise<UpdateReminderSummary> {
    const row = await this.db.prepare(`
      SELECT game, pending, first_reminded_at, last_reminded_at, effective_reminder_count, last_notified_at
      FROM update_reminder_games
      WHERE game = ?
    `).bind(game).first<{
      game?: string;
      pending?: number;
      first_reminded_at?: number | null;
      last_reminded_at?: number | null;
      effective_reminder_count?: number;
      last_notified_at?: number | null;
    }>();
    return {
      game,
      pending: row?.pending === 1,
      firstReminderAt: nullableTimestamp(row?.first_reminded_at),
      lastReminderAt: nullableTimestamp(row?.last_reminded_at),
      effectiveReminderCount: safeCounter(row?.effective_reminder_count),
      lastNotifiedAt: nullableTimestamp(row?.last_notified_at),
      cycleId: null,
      cycleNumber: 0,
      cycleEffectiveReminderCount: 0,
      notificationStatus: "none",
      notificationAttempts: 0,
      nextNotificationAt: null,
      lastNotificationError: null,
      resolvedAt: null,
    };
  }

  async recordUpdateReminder(visitorId: string, game: PublicGameSlug, nowMs: number): Promise<UpdateReminderResult> {
    await this.ensureUpdateReminderGame(game);
    let cycle = await this.getPendingUpdateReminderCycleV2(game);
    if (!cycle) cycle = await this.createUpdateReminderCycleV2(game, nowMs);
    const existing = await this.db.prepare(`
      SELECT first_reminded_at, last_reminded_at
      FROM update_reminder_cycle_visitors
      WHERE cycle_id = ? AND visitor_id = ? AND game = ?
    `).bind(cycle.id, visitorId, game).first<{ first_reminded_at?: number; last_reminded_at?: number }>();
    if (typeof existing?.last_reminded_at === "number" && existing.last_reminded_at + UPDATE_REMINDER_DEDUPE_WINDOW_MS > nowMs) {
      return { status: "duplicate", nextAllowedAt: existing.last_reminded_at + UPDATE_REMINDER_DEDUPE_WINDOW_MS, summary: await this.getUpdateReminderSummaryV2(game) };
    }
    const firstRemindedAt = typeof existing?.first_reminded_at === "number" ? existing.first_reminded_at : nowMs;
    await this.db.prepare(`
      INSERT INTO update_reminder_cycle_visitors (cycle_id, visitor_id, game, first_reminded_at, last_reminded_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(cycle_id, visitor_id, game) DO UPDATE SET last_reminded_at = excluded.last_reminded_at
    `).bind(cycle.id, visitorId, game, firstRemindedAt, nowMs).run();
    await this.db.prepare(`
      UPDATE update_reminder_cycles
      SET last_reminded_at = ?, effective_reminder_count = effective_reminder_count + 1
      WHERE id = ? AND pending = 1 AND resolved_at IS NULL
    `).bind(nowMs, cycle.id).run();
    await this.db.prepare(`
      UPDATE update_reminder_games
      SET pending = 1,
          first_reminded_at = CASE WHEN pending = 0 THEN ? ELSE COALESCE(first_reminded_at, ?) END,
          last_reminded_at = ?,
          effective_reminder_count = effective_reminder_count + 1
      WHERE game = ?
    `).bind(nowMs, nowMs, nowMs, game).run();
    const summary = await this.getUpdateReminderSummaryV2(game);
    return { status: "accepted", firstReminder: summary.cycleEffectiveReminderCount === 1, summary };
  }
  async listPendingUpdateReminders(): Promise<UpdateReminderSummary[]> {
    const rows = await this.db.prepare(`
      SELECT game FROM update_reminder_cycles
      WHERE pending = 1 AND resolved_at IS NULL
      ORDER BY last_reminded_at DESC, game ASC
    `).all<{ game: string }>();
    return Promise.all((rows.results ?? []).flatMap((row) => isValidPublicGameSlug(row.game) ? [this.getUpdateReminderSummaryV2(row.game)] : []));
  }

  async resolveUpdateReminder(game: PublicGameSlug, nowMs: number): Promise<UpdateReminderSummary | undefined> {
    const cycle = await this.getPendingUpdateReminderCycleV2(game);
    if (!cycle) return undefined;
    const summary = await this.getUpdateReminderSummaryV2(game);
    await this.db.prepare(`
      UPDATE update_reminder_cycles SET pending = 0, resolved_at = ?, next_notification_at = NULL
      WHERE id = ? AND pending = 1 AND resolved_at IS NULL
    `).bind(nowMs, cycle.id).run();
    await this.db.prepare("UPDATE update_reminder_games SET pending = 0 WHERE game = ?").bind(game).run();
    return { ...summary, pending: false, resolvedAt: nowMs };
  }

  async retryUpdateReminderNotification(game: PublicGameSlug, nowMs: number): Promise<UpdateReminderSummary | undefined> {
    const cycle = await this.getPendingUpdateReminderCycleV2(game);
    if (!cycle) return undefined;
    if (normalizeNotificationStatus(cycle.notification_status) === "sent") return this.getUpdateReminderSummaryV2(game);
    await this.db.prepare(`
      UPDATE update_reminder_cycles
      SET notification_status = 'pending', notification_attempts = 0,
          last_notification_attempt_at = NULL, next_notification_at = ?, last_notification_error = NULL
      WHERE id = ? AND pending = 1 AND resolved_at IS NULL
    `).bind(nowMs, cycle.id).run();
    return this.getUpdateReminderSummaryV2(game);
  }
  async claimDueUpdateReminderNotifications(nowMs: number): Promise<UpdateReminderNotificationClaim[]> {
    const rows = await this.db.prepare(`
      SELECT id, game FROM update_reminder_cycles
      WHERE pending = 1 AND resolved_at IS NULL AND notification_status <> 'sent'
        AND notification_attempts < ? AND (
            (next_notification_at IS NULL AND notification_status = 'pending')
            OR (next_notification_at IS NOT NULL AND next_notification_at <= ?)
          )
      ORDER BY COALESCE(next_notification_at, 0) ASC, last_reminded_at ASC
    `).bind(UPDATE_REMINDER_NOTIFICATION_MAX_ATTEMPTS, nowMs).all<{ id: number; game: string }>();
    const claims: UpdateReminderNotificationClaim[] = [];
    for (const row of rows.results ?? []) {
      if (!isValidPublicGameSlug(row.game)) continue;
      const changed = await this.db.prepare(`
        UPDATE update_reminder_cycles
        SET notification_status = 'pending', notification_attempts = notification_attempts + 1,
            last_notification_attempt_at = ?, next_notification_at = ?
        WHERE id = ? AND pending = 1 AND resolved_at IS NULL
          AND notification_status <> 'sent' AND notification_attempts < ? AND (
            (next_notification_at IS NULL AND notification_status = 'pending')
            OR (next_notification_at IS NOT NULL AND next_notification_at <= ?)
          )
      `).bind(nowMs, nowMs + UPDATE_REMINDER_NOTIFICATION_LEASE_MS, row.id, UPDATE_REMINDER_NOTIFICATION_MAX_ATTEMPTS, nowMs).run();
      if (resultChanges(changed) <= 0) continue;
      const cycle = await this.getUpdateReminderCycleByIdV2(row.id);
      if (!cycle || !isValidPublicGameSlug(cycle.game)) continue;
      claims.push({ cycleId: cycle.id, game: cycle.game, cycleNumber: cycle.cycle_number, attempt: cycle.notification_attempts, summary: await this.getUpdateReminderSummaryV2(cycle.game) });
    }
    return claims;
  }

  async markUpdateReminderNotificationSent(cycleId: number, game: PublicGameSlug, nowMs: number): Promise<void> {
    await this.db.prepare(`
      UPDATE update_reminder_cycles
      SET last_notified_at = ?, notification_status = 'sent', next_notification_at = NULL, last_notification_error = NULL
      WHERE id = ? AND pending = 1 AND resolved_at IS NULL
    `).bind(nowMs, cycleId).run();
    await this.db.prepare("UPDATE update_reminder_games SET last_notified_at = ? WHERE game = ?").bind(nowMs, game).run();
  }

  async markUpdateReminderNotificationFailed(cycleId: number, nowMs: number, nextNotificationAt: number | null, errorCode: string): Promise<void> {
    await this.db.prepare(`
      UPDATE update_reminder_cycles SET notification_status = 'failed', next_notification_at = ?, last_notification_error = ?
      WHERE id = ? AND pending = 1 AND resolved_at IS NULL
    `).bind(nextNotificationAt, errorCode, cycleId).run();
  }
  private async createUpdateReminderCycleV2(game: PublicGameSlug, nowMs: number): Promise<UpdateReminderCycleRow> {
    const row = await this.db.prepare(`
      SELECT COALESCE(MAX(cycle_number), 0) + 1 AS next_cycle_number
      FROM update_reminder_cycles WHERE game = ?
    `).bind(game).first<{ next_cycle_number?: number }>();
    const cycleNumber = Math.max(1, safeCounter(row?.next_cycle_number));
    try {
      await this.db.prepare(`
        INSERT INTO update_reminder_cycles
          (game, cycle_number, pending, first_reminded_at, last_reminded_at, effective_reminder_count,
           last_notified_at, notification_status, notification_attempts, last_notification_attempt_at,
           next_notification_at, last_notification_error, resolved_at)
        VALUES (?, ?, 1, ?, ?, 0, NULL, 'pending', 0, NULL, NULL, NULL, NULL)
      `).bind(game, cycleNumber, nowMs, nowMs).run();
    } catch {
      const current = await this.getPendingUpdateReminderCycleV2(game);
      if (current) return current;
      throw new Error("update reminder cycle creation failed");
    }
    const created = await this.getPendingUpdateReminderCycleV2(game);
    if (!created) throw new Error("update reminder cycle creation failed");
    return created;
  }

  private async getPendingUpdateReminderCycleV2(game: PublicGameSlug): Promise<UpdateReminderCycleRow | undefined> {
    return (await this.db.prepare(`
      SELECT id, game, cycle_number, pending, first_reminded_at, last_reminded_at, effective_reminder_count,
             last_notified_at, notification_status, notification_attempts, last_notification_attempt_at,
             next_notification_at, last_notification_error, resolved_at
      FROM update_reminder_cycles WHERE game = ? AND pending = 1 AND resolved_at IS NULL
      ORDER BY cycle_number DESC LIMIT 1
    `).bind(game).first<UpdateReminderCycleRow>()) ?? undefined;
  }

  private async getUpdateReminderCycleByIdV2(id: number): Promise<UpdateReminderCycleRow | undefined> {
    return (await this.db.prepare(`
      SELECT id, game, cycle_number, pending, first_reminded_at, last_reminded_at, effective_reminder_count,
             last_notified_at, notification_status, notification_attempts, last_notification_attempt_at,
             next_notification_at, last_notification_error, resolved_at
      FROM update_reminder_cycles WHERE id = ?
    `).bind(id).first<UpdateReminderCycleRow>()) ?? undefined;
  }

  private async getUpdateReminderSummaryV2(game: PublicGameSlug): Promise<UpdateReminderSummary> {
    const gameRow = await this.db.prepare(`
      SELECT game, pending, first_reminded_at, last_reminded_at, effective_reminder_count, last_notified_at
      FROM update_reminder_games WHERE game = ?
    `).bind(game).first<UpdateReminderGameRow>();
    const cycle = await this.getPendingUpdateReminderCycleV2(game);
    return {
      game,
      pending: gameRow?.pending === 1,
      cycleId: cycle?.id ?? null,
      cycleNumber: cycle?.cycle_number ?? 0,
      firstReminderAt: nullableTimestamp(gameRow?.first_reminded_at),
      lastReminderAt: nullableTimestamp(gameRow?.last_reminded_at),
      effectiveReminderCount: safeCounter(gameRow?.effective_reminder_count),
      cycleEffectiveReminderCount: safeCounter(cycle?.effective_reminder_count),
      lastNotifiedAt: nullableTimestamp(gameRow?.last_notified_at),
      notificationStatus: cycle ? normalizeNotificationStatus(cycle.notification_status) : "none",
      notificationAttempts: safeCounter(cycle?.notification_attempts),
      nextNotificationAt: nullableTimestamp(cycle?.next_notification_at),
      lastNotificationError: cycle?.last_notification_error ?? null,
      resolvedAt: nullableTimestamp(cycle?.resolved_at),
    };
  }
  private async claim(visitorId: string, kind: string, resourceId: string, expiresAt: number): Promise<boolean> {
    const result = await this.db.prepare(CLAIM_DEDUPE_SQL).bind(visitorId, kind, resourceId, expiresAt).run();
    return resultChanges(result) > 0;
  }

  private async incrementResource(resourceId: string, field: "views" | "downloads", nowMs: number, date: string): Promise<void> {
    if (field === "views") {
      await this.db.prepare(`
        INSERT INTO resource_stats (resource_id, total_views, total_downloads, updated_at)
        VALUES (?, 1, 0, ?)
        ON CONFLICT(resource_id) DO UPDATE SET
          total_views = resource_stats.total_views + 1,
          updated_at = excluded.updated_at
      `).bind(resourceId, nowMs).run();
    } else {
      await this.db.prepare(`
        INSERT INTO resource_stats (resource_id, total_views, total_downloads, updated_at)
        VALUES (?, 0, 1, ?)
        ON CONFLICT(resource_id) DO UPDATE SET
          total_downloads = resource_stats.total_downloads + 1,
          updated_at = excluded.updated_at
      `).bind(resourceId, nowMs).run();
    }
    await this.db.prepare(`
      INSERT INTO resource_daily_stats (resource_id, stat_date, daily_views, daily_downloads, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(resource_id, stat_date) DO UPDATE SET
        daily_views = resource_daily_stats.daily_views + excluded.daily_views,
        daily_downloads = resource_daily_stats.daily_downloads + excluded.daily_downloads,
        updated_at = excluded.updated_at
    `).bind(resourceId, date, field === "views" ? 1 : 0, field === "downloads" ? 1 : 0, nowMs).run();
  }
}

export function isValidResourceId(value: unknown): value is string {
  return isUuidV7(value);
}

export function isPublicResourceId(value: unknown): value is string {
  return isValidResourceId(value) && PUBLIC_RESOURCE_IDS.has(value.toLowerCase());
}

export function isValidVisitorId(value: unknown): value is string {
  return normalizeUuid(value) !== undefined;
}

export function validateEventPayload(value: unknown): { event?: StatsEvent; error?: string } {
  if (!isRecord(value)) return { error: "invalid_json_body" };
  if (value.type !== "site_visit" && value.type !== "resource_detail" && value.type !== "resource_download") return { error: "invalid_event_type" };
  const visitorId = normalizeUuid(value.visitorId);
  if (!visitorId || !isValidVisitorId(visitorId)) return { error: "invalid_visitor_id" };
  if (value.type === "site_visit") return { event: { type: value.type, visitorId } };
  const resourceId = normalizeUuid(value.resourceId);
  if (!resourceId || !isValidResourceId(resourceId)) return { error: "invalid_resource_id" };
  if (!isPublicResourceId(resourceId)) return { error: "resource_not_public" };
  return { event: { type: value.type, visitorId, resourceId } };
}

export function isValidPublicGameSlug(value: unknown): value is PublicGameSlug {
  return typeof value === "string" && PUBLIC_GAME_SLUG_SET.has(value);
}

export function validateUpdateReminderPayload(value: unknown): { reminder?: { visitorId: string; game: PublicGameSlug; turnstileToken?: string }; error?: string } {
  if (!isRecord(value)) return { error: "invalid_json_body" };
  if (!Object.prototype.hasOwnProperty.call(value, "visitorId") || !Object.prototype.hasOwnProperty.call(value, "game")) return { error: "missing_field" };
  const visitorId = normalizeUuid(value.visitorId);
  if (!visitorId || !isValidVisitorId(visitorId)) return { error: "invalid_visitor_id" };
  if (!isValidPublicGameSlug(value.game)) return { error: "invalid_game" };
  const turnstileToken = typeof value.turnstileToken === "string" ? value.turnstileToken.trim() : "";
  if (turnstileToken.length > 2048) return { error: "invalid_turnstile_token" };
  return { reminder: { visitorId, game: value.game, ...(turnstileToken ? { turnstileToken } : {}) } };
}

export function validateResourceIds(value: unknown): { resourceIds?: string[]; error?: string } {
  if (!isRecord(value) || !Array.isArray(value.resourceIds)) return { error: "invalid_resource_ids" };
  if (value.resourceIds.length === 0 || value.resourceIds.length > MAX_RESOURCE_IDS) return { error: "resource_id_batch_too_large" };
  if (!value.resourceIds.every(isValidResourceId)) return { error: "invalid_resource_id" };
  const resourceIds = [...new Set(value.resourceIds.map((resourceId) => resourceId.toLowerCase()))];
  if (!resourceIds.every(isPublicResourceId)) return { error: "resource_not_public" };
  return { resourceIds };
}
export function validateResourceRankingQuery(searchParams: URLSearchParams): { period?: ResourceRankingPeriod; limit?: number; error?: string } {
  const periodValue = searchParams.get("period") ?? "7d";
  if (periodValue !== "7d" && periodValue !== "all") return { error: "invalid_ranking_period" };
  const rawLimit = searchParams.get("limit");
  if (rawLimit === null || rawLimit === "") return { period: periodValue, limit: DEFAULT_RANKING_LIMIT };
  if (!/^\d+$/u.test(rawLimit)) return { error: "invalid_ranking_limit" };
  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RANKING_LIMIT) return { error: "invalid_ranking_limit" };
  return { period: periodValue, limit };
}

export function resourceRankingDateRange(date: string): { startDate: string; endDate: string } {
  const endDate = /^\d{4}-\d{2}-\d{2}$/u.test(date) ? date : "1970-01-01";
  const timestamp = Date.parse(endDate + "T00:00:00Z");
  if (!Number.isFinite(timestamp)) return { startDate: endDate, endDate };
  return {
    startDate: new Date(timestamp - 6 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    endDate,
  };
}

function dateOffset(date: string, days: number): string {
  const timestamp = Date.parse(date + "T00:00:00Z");
  if (!Number.isFinite(timestamp)) return date;
  return new Date(timestamp + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
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

type RequestRateLimitConfig = {
  scope: string;
  windowMs: number;
  maxRequests: number;
};

const localRateLimitBuckets = new Map<string, { windowStartedAt: number; requestCount: number }>();

function requestRateLimitConfig(path: string, method: string): RequestRateLimitConfig | undefined {
  if (method === "POST" && path === "/v1/events") return { scope: "events", windowMs: PUBLIC_EVENT_RATE_LIMIT_WINDOW_MS, maxRequests: PUBLIC_EVENT_RATE_LIMIT_MAX_REQUESTS };
  if (method === "POST" && path === "/v1/update-reminders") return { scope: "update-reminders", windowMs: UPDATE_REMINDER_IP_RATE_LIMIT_WINDOW_MS, maxRequests: UPDATE_REMINDER_IP_RATE_LIMIT_MAX_REQUESTS };
  if (method === "POST" && path === "/v1/resources/stats") return { scope: "resource-stats", windowMs: PUBLIC_EVENT_RATE_LIMIT_WINDOW_MS, maxRequests: PUBLIC_EVENT_RATE_LIMIT_MAX_REQUESTS };
  if (method === "GET" && (path === "/v1/site/stats" || path === "/v1/resources/ranking")) return { scope: "stats-read", windowMs: PUBLIC_READ_RATE_LIMIT_WINDOW_MS, maxRequests: PUBLIC_READ_RATE_LIMIT_MAX_REQUESTS };
  return undefined;
}

async function rateLimitClientKey(request: Request, env: Env, nowMs: number): Promise<string> {
  const edgeClient = request.headers.get("CF-Connecting-IP")?.trim() || "no-edge-client";
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const salt = env.RATE_LIMIT_HASH_SECRET?.trim() || "rhythm-archive-rate-limit";
  const input = new TextEncoder().encode(salt + "\n" + day + "\n" + edgeClient);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function checkRequestRateLimit(request: Request, env: Env, store: StatsStore, config: RequestRateLimitConfig, nowMs: number, clientKeyOverride?: string): Promise<RequestRateLimitResult> {
  const clientKey = clientKeyOverride ?? await rateLimitClientKey(request, env, nowMs);
  if (env.RATE_LIMITER) {
    const result = await env.RATE_LIMITER.limit({ key: config.scope + ":" + clientKey });
    return result.success ? { allowed: true, retryAfterSeconds: 0 } : { allowed: false, retryAfterSeconds: Math.ceil(config.windowMs / 1000) };
  }
  if (store.consumeRequestRateLimit) return store.consumeRequestRateLimit(clientKey, config.scope, nowMs, config.windowMs, config.maxRequests);
  const key = config.scope + ":" + clientKey;
  const current = localRateLimitBuckets.get(key);
  const bucket = !current || current.windowStartedAt + config.windowMs <= nowMs ? { windowStartedAt: nowMs, requestCount: 0 } : current;
  bucket.requestCount += 1;
  localRateLimitBuckets.set(key, bucket);
  if (bucket.requestCount <= config.maxRequests) return { allowed: true, retryAfterSeconds: 0 };
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.windowStartedAt + config.windowMs - nowMs) / 1000)) };
}
export async function handleRequest(request: Request, env: Env, options: HandlerOptions = {}): Promise<Response> {
  const origin = request.headers.get("Origin");
  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  if (origin && !allowedOrigins.has(origin)) return json({ error: "origin_not_allowed" }, 403);

  const corsHeaders = createCorsHeaders(origin);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/u, "") || "/";
  if (path === "/health" && request.method === "GET") return json({ ok: true, catalogGeneratedAt: PUBLIC_RESOURCE_CATALOG_GENERATED_AT }, 200, corsHeaders);

  const store = options.store ?? (env.DB ? new D1StatsStore(env.DB) : undefined);
  if (!store) return json({ error: "stats_unavailable" }, 503, corsHeaders);
  const nowMs = options.now?.() ?? Date.now();
  const date = siteDateKey(nowMs, env.SITE_TIME_ZONE || "Asia/Shanghai");
  const rateLimitConfig = requestRateLimitConfig(path, request.method);
  const publicRateLimitKey = rateLimitConfig ? await rateLimitClientKey(request, env, nowMs) : undefined;
  if (rateLimitConfig) {
    const rateLimit = await checkRequestRateLimit(request, env, store, rateLimitConfig, nowMs, publicRateLimitKey);
    if (!rateLimit.allowed) return json({ error: "rate_limited", retryAfterSeconds: rateLimit.retryAfterSeconds }, 429, { ...corsHeaders, "Retry-After": String(rateLimit.retryAfterSeconds) });
  }

  try {
    const adminResolveMatch = /^\/v1\/admin\/update-reminders\/([^/]+)\/resolve$/u.exec(path);
    const adminRetryMatch = /^\/v1\/admin\/update-reminders\/([^/]+)\/retry-notification$/u.exec(path);
    if (path === "/v1/admin/update-reminders" && request.method === "GET") {
      if (!isAdminAuthorized(request, env)) return json({ error: "unauthorized" }, 401, corsHeaders);
      return json({ pending: await store.listPendingUpdateReminders() }, 200, corsHeaders);
    }
    if (adminResolveMatch && request.method === "POST") {
      if (!isAdminAuthorized(request, env)) return json({ error: "unauthorized" }, 401, corsHeaders);
      const game = decodeAdminGame(adminResolveMatch[1]);
      if (!game) return json({ error: "invalid_game" }, 400, corsHeaders);
      const resolved = await store.resolveUpdateReminder(game, nowMs);
      if (!resolved) return json({ error: "pending_not_found" }, 404, corsHeaders);
      return json({ ok: true, status: "resolved", reminder: resolved }, 200, corsHeaders);
    }
    if (adminRetryMatch && request.method === "POST") {
      if (!isAdminAuthorized(request, env)) return json({ error: "unauthorized" }, 401, corsHeaders);
      const game = decodeAdminGame(adminRetryMatch[1]);
      if (!game) return json({ error: "invalid_game" }, 400, corsHeaders);
      const retried = await store.retryUpdateReminderNotification(game, nowMs);
      if (!retried) return json({ error: "pending_not_found" }, 404, corsHeaders);
      if (retried.notificationStatus === "sent") return json({ error: "notification_already_sent" }, 409, corsHeaders);
      const task = processPendingUpdateReminderNotifications(env, { store, now: nowMs, fetchImpl: options.fetchImpl });
      if (options.waitUntil) options.waitUntil(task);
      else await task;
      return json({ ok: true, status: "retry_scheduled", reminder: retried }, 202, corsHeaders);
    }
    if (path === "/v1/site/stats" && request.method === "GET") {
      return json(await store.getSiteStats(date), 200, corsHeaders);
    }
    if (path === "/v1/resources/ranking" && request.method === "GET") {
      const validation = validateResourceRankingQuery(url.searchParams);
      if (!validation.period || !validation.limit) return json({ error: validation.error ?? "invalid_ranking_query" }, 400, corsHeaders);
      const range = resourceRankingDateRange(date);
      return json({
        period: validation.period,
        date: range.endDate,
        ...(validation.period === "7d" ? { startDate: range.startDate } : {}),
        entries: await store.getResourceRanking(validation.period, range.endDate, validation.limit),
      }, 200, corsHeaders);
    }
    if (path === "/v1/update-reminders" && request.method === "POST") {
      const body = await readJsonBody(request);
      const validation = validateUpdateReminderPayload(body);
      const reminder = validation.reminder;
      if (!reminder) return json({ error: validation.error ?? "invalid_update_reminder" }, 400, corsHeaders);
      if (env.TURNSTILE_SECRET_KEY?.trim()) {
        if (!reminder.turnstileToken || !(await verifyTurnstileToken(env.TURNSTILE_SECRET_KEY, reminder.turnstileToken, options.fetchImpl))) return json({ error: "turnstile_failed" }, 403, corsHeaders);
      }
      const recorded = await store.recordUpdateReminder(reminder.visitorId, reminder.game, nowMs);
      if (recorded.status === "rate_limited") {
        return json({ error: "rate_limited", retryAfterSeconds: recorded.retryAfterSeconds }, 429, {
          ...corsHeaders,
          "Retry-After": String(recorded.retryAfterSeconds),
        });
      }
      if (recorded.status === "duplicate") {
        return json({
          ok: false,
          status: "duplicate",
          error: "already_reminded",
          nextAllowedAt: recorded.nextAllowedAt,
        }, 409, corsHeaders);
      }
      const notificationTask = recorded.firstReminder
        ? processPendingUpdateReminderNotifications(env, { store, now: nowMs, fetchImpl: options.fetchImpl })
        : Promise.resolve({ attempted: 0, sent: 0, failed: 0 });
      if (options.waitUntil) options.waitUntil(notificationTask);
      else await notificationTask;
      return json({
        ok: true,
        status: "accepted",
        game: recorded.summary.game,
        firstReminder: recorded.firstReminder,
        reminder: recorded.summary,
      }, 202, corsHeaders);
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
    if (path === "/v1/site/stats" || path === "/v1/events" || path === "/v1/resources/stats" || path === "/v1/resources/ranking" || path === "/v1/update-reminders" || path === "/v1/admin/update-reminders" || path.startsWith("/v1/admin/update-reminders/")) {
      return json({ error: "method_not_allowed" }, 405, { ...corsHeaders, Allow: allowedMethodsForPath(path) });
    }
    return json({ error: "not_found" }, 404, corsHeaders);
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.code }, error.status, corsHeaders);
    console.error("Stats request failed", error instanceof Error ? error.message : String(error));
    return json({ error: "stats_unavailable" }, 503, corsHeaders);
  }
}

export type NotificationDeliveryResult = {
  ok: boolean;
  retryable: boolean;
  errorCode?: string;
};

export async function processPendingUpdateReminderNotifications(env: Env, options: {
  store?: StatsStore;
  now?: number;
  fetchImpl?: NotificationFetch | undefined;
} = {}): Promise<{ attempted: number; sent: number; failed: number }> {
  const store = options.store ?? (env.DB ? new D1StatsStore(env.DB) : undefined);
  if (!store || !env.RESEND_API_KEY?.trim() || !env.UPDATE_REMINDER_EMAIL_TO?.trim()) return { attempted: 0, sent: 0, failed: 0 };
  const nowMs = options.now ?? Date.now();
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  try {
    const claims = await store.claimDueUpdateReminderNotifications(nowMs);
    let sent = 0;
    let failed = 0;
    for (const claim of claims) {
      const delivery = await sendUpdateReminderNotification(env, claim, fetchImpl);
      if (delivery.ok) {
        await store.markUpdateReminderNotificationSent(claim.cycleId, claim.game, nowMs);
        sent += 1;
        continue;
      }
      const retryable = delivery.retryable && claim.attempt < UPDATE_REMINDER_NOTIFICATION_MAX_ATTEMPTS;
      const next = retryable ? nowMs + notificationRetryDelayMs(claim.attempt) : null;
      await store.markUpdateReminderNotificationFailed(claim.cycleId, nowMs, next, delivery.errorCode ?? "notification_failed");
      failed += 1;
    }
    return { attempted: claims.length, sent, failed };
  } catch (error) {
    console.error("Update reminder notification processing failed", error instanceof Error ? error.message : String(error));
    return { attempted: 0, sent: 0, failed: 1 };
  }
}

async function verifyTurnstileToken(secret: string, token: string, fetchImpl: NotificationFetch = (input, init) => fetch(input, init)): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetchImpl("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: token }).toString(),
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const value = await response.json() as unknown;
    return isRecord(value) && value.success === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}
export async function sendUpdateReminderNotification(env: Env, claim: UpdateReminderNotificationClaim, fetchImpl: NotificationFetch = (input, init) => fetch(input, init)): Promise<NotificationDeliveryResult> {
  const apiKey = env.RESEND_API_KEY?.trim();
  const recipient = env.UPDATE_REMINDER_EMAIL_TO?.trim();
  if (!apiKey || !recipient) return { ok: false, retryable: false, errorCode: "not_configured" };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5_000);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: "Bearer " + apiKey,
  };
  const displayName = PUBLIC_GAME_DISPLAY_NAMES[claim.game];
  try {
    const response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers,
      body: JSON.stringify({
        from: "Rhythm Archive <onboarding@resend.dev>",
        to: [recipient],
        subject: "[Rhythm Archive] " + displayName + " 可能有新内容",
        text: [
          "Rhythm Archive 更新提醒",
          "游戏：" + displayName,
          "game slug：" + claim.game,
          "当前 cycle 有效提醒数量：" + claim.summary.cycleEffectiveReminderCount,
          "首次提醒时间：" + formatNotificationTime(claim.summary.firstReminderAt),
          "最近提醒时间：" + formatNotificationTime(claim.summary.lastReminderAt),
          "当前 pending 状态：是",
        ].join("\n"),
      }),
      signal: controller.signal,
    });
    if (response.ok) return { ok: true, retryable: false };
    const retryable = response.status === 429 || response.status >= 500;
    return { ok: false, retryable, errorCode: "http_" + response.status };
  } catch (error) {
    return { ok: false, retryable: true, errorCode: error instanceof DOMException && error.name === "AbortError" ? "timeout" : "network" };
  } finally {
    clearTimeout(timeoutId);
  }
}

function formatNotificationTime(value: number | null): string {
  return value === null ? "未知" : new Date(value).toISOString();
}
function notificationRetryDelayMs(attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(UPDATE_REMINDER_NOTIFICATION_MAX_BACKOFF_MS, UPDATE_REMINDER_NOTIFICATION_RETRY_BASE_MS * (2 ** exponent));
}
function allowedMethodsForPath(path: string): string {
  if (path === "/v1/site/stats" || path === "/v1/resources/ranking") return "GET";
  if (path === "/v1/admin/update-reminders") return "GET";
  return "POST";
}

function isAdminAuthorized(request: Request, env: Env): boolean {
  const token = env.UPDATE_REMINDER_ADMIN_TOKEN?.trim();
  if (!token) return false;
  return request.headers.get("Authorization") === "Bearer " + token;
}

function decodeAdminGame(value: string | undefined): PublicGameSlug | undefined {
  if (!value) return undefined;
  try {
    const game = decodeURIComponent(value);
    return isValidPublicGameSlug(game) ? game : undefined;
  } catch {
    return undefined;
  }
}
function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonBody(request: Request): Promise<unknown> {
  const rawContentLength = request.headers.get("Content-Length");
  if (rawContentLength && /^\d+$/u.test(rawContentLength) && Number(rawContentLength) > MAX_EVENT_BODY_BYTES) throw new HttpError("request_too_large", 413);
  if (!request.body) throw new HttpError("invalid_json_body", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    totalBytes += chunk.value.byteLength;
    if (totalBytes > MAX_EVENT_BODY_BYTES) {
      await reader.cancel();
      throw new HttpError("request_too_large", 413);
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HttpError("invalid_json_body", 400);
  }
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
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
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

function normalizeNotificationStatus(value: unknown): UpdateReminderNotificationStatus {
  return value === "pending" || value === "sent" || value === "failed" ? value : "none";
}
function nullableTimestamp(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function safeCounter(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

import assert from "node:assert/strict";
import test from "node:test";
import {
  DOWNLOAD_DEDUPE_WINDOW_MS,
  MAX_RESOURCE_IDS,
  SITE_SESSION_WINDOW_MS,
  UPDATE_REMINDER_DEDUPE_WINDOW_MS,
  UPDATE_REMINDER_MAX_REQUESTS_PER_WINDOW,
  UPDATE_REMINDER_RATE_LIMIT_WINDOW_MS,
  UPDATE_REMINDER_NOTIFICATION_MAX_ATTEMPTS,
  UPDATE_REMINDER_NOTIFICATION_LEASE_MS,
  type Env,
  type PublicGameSlug,
  type ResourceStats,
  type SiteStats,
  type StatsEvent,
  type StatsStore,
  type UpdateReminderNotificationClaim,
  type UpdateReminderResult,
  type UpdateReminderSummary,
  handleRequest,
  processPendingUpdateReminderNotifications,
  isValidResourceId,
} from "../src/core.js";

const visitorId = "11111111-1111-7111-8111-111111111111";
const otherVisitorId = "22222222-2222-7222-8222-222222222222";
const resourceId = "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
const secondResourceId = "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb";
const baseTime = Date.UTC(2026, 8, 6, 12, 0, 0);
const testEmailConfig = { RESEND_API_KEY: "configured", UPDATE_REMINDER_EMAIL_TO: "recipient" };

class MemoryStatsStore implements StatsStore {
  private totalVisits = 0;
  private readonly dailyVisits = new Map<string, number>();
  private readonly resources = new Map<string, ResourceStats>();
  private readonly dedupe = new Map<string, number>();
  private readonly updateReminders = new Map<string, { firstReminderAt: number; lastReminderAt: number }>();
  private readonly updateReminderGames = new Map<PublicGameSlug, UpdateReminderSummary>();
  private readonly updateReminderRates = new Map<string, { windowStartedAt: number; requestCount: number }>();
  private nextCycleId = 1;

  async recordEvent(event: StatsEvent, nowMs: number, date: string) {
    this.purge(nowMs);
    if (event.type === "site_visit") {
      const counted = this.claim(event.visitorId, "site", "", nowMs + SITE_SESSION_WINDOW_MS);
      if (counted) {
        this.totalVisits += 1;
        this.dailyVisits.set(date, (this.dailyVisits.get(date) ?? 0) + 1);
      }
      return {
        siteVisitCounted: counted,
        viewCounted: false,
        downloadCounted: false,
        site: await this.getSiteStats(date),
      };
    }

    const viewCounted = this.claim(event.visitorId, "view", event.resourceId, nowMs + SITE_SESSION_WINDOW_MS);
    if (viewCounted) this.increment(event.resourceId, "views");
    let downloadCounted = false;
    if (event.type === "resource_download") {
      downloadCounted = this.claim(event.visitorId, "download", event.resourceId, nowMs + DOWNLOAD_DEDUPE_WINDOW_MS);
      if (downloadCounted) this.increment(event.resourceId, "downloads");
    }
    const resource = (await this.getResourceStats([event.resourceId])).get(event.resourceId) ?? { views: 0, downloads: 0 };
    return {
      siteVisitCounted: false,
      viewCounted,
      downloadCounted,
      resource,
    };
  }

  async getSiteStats(date: string): Promise<SiteStats> {
    return { totalVisits: this.totalVisits, todayVisits: this.dailyVisits.get(date) ?? 0, date };
  }

  async getResourceStats(ids: readonly string[]): Promise<Map<string, ResourceStats>> {
    return new Map(ids.map((id) => [id, this.resources.get(id) ?? { views: 0, downloads: 0 }]));
  }

  async recordUpdateReminder(visitorId: string, game: PublicGameSlug, nowMs: number): Promise<UpdateReminderResult> {
    const currentRate = this.updateReminderRates.get(visitorId);
    const rate = !currentRate || currentRate.windowStartedAt + UPDATE_REMINDER_RATE_LIMIT_WINDOW_MS <= nowMs
      ? { windowStartedAt: nowMs, requestCount: 0 }
      : currentRate;
    rate.requestCount += 1;
    this.updateReminderRates.set(visitorId, rate);
    if (rate.requestCount > UPDATE_REMINDER_MAX_REQUESTS_PER_WINDOW) {
      return {
        status: "rate_limited",
        retryAfterSeconds: Math.max(1, Math.ceil((rate.windowStartedAt + UPDATE_REMINDER_RATE_LIMIT_WINDOW_MS - nowMs) / 1000)),
      };
    }

    const summary = this.updateReminderGames.get(game) ?? {
      game,
      pending: false,
      cycleId: null,
      cycleNumber: 0,
      firstReminderAt: null,
      lastReminderAt: null,
      effectiveReminderCount: 0,
      cycleEffectiveReminderCount: 0,
      lastNotifiedAt: null,
      notificationStatus: "none",
      notificationAttempts: 0,
      nextNotificationAt: null,
      lastNotificationError: null,
      resolvedAt: null,
    };
    if (!summary.pending) {
      summary.pending = true;
      summary.cycleId = this.nextCycleId++;
      summary.cycleNumber += 1;
      summary.cycleEffectiveReminderCount = 0;
      summary.firstReminderAt = null;
      summary.lastReminderAt = null;
      summary.notificationStatus = "pending";
      summary.notificationAttempts = 0;
      summary.nextNotificationAt = null;
      summary.lastNotificationError = null;
      summary.resolvedAt = null;
    }
    this.updateReminderGames.set(game, summary);

    const key = String(summary.cycleId) + ":" + visitorId + ":" + game;
    const existing = this.updateReminders.get(key);
    if (existing && existing.lastReminderAt + UPDATE_REMINDER_DEDUPE_WINDOW_MS > nowMs) {
      return {
        status: "duplicate",
        nextAllowedAt: existing.lastReminderAt + UPDATE_REMINDER_DEDUPE_WINDOW_MS,
        summary: { ...summary },
      };
    }

    const firstReminderAt = existing?.firstReminderAt ?? nowMs;
    this.updateReminders.set(key, { firstReminderAt, lastReminderAt: nowMs });
    summary.pending = true;
    summary.firstReminderAt ??= nowMs;
    summary.lastReminderAt = nowMs;
    summary.effectiveReminderCount += 1;
    summary.cycleEffectiveReminderCount += 1;
    return {
      status: "accepted",
      firstReminder: summary.cycleEffectiveReminderCount === 1,
      summary: { ...summary },
    };
  }

  async listPendingUpdateReminders(): Promise<UpdateReminderSummary[]> {
    return [...this.updateReminderGames.values()].filter((summary) => summary.pending).map((summary) => ({ ...summary }));
  }

  async resolveUpdateReminder(game: PublicGameSlug, nowMs: number): Promise<UpdateReminderSummary | undefined> {
    const summary = this.updateReminderGames.get(game);
    if (!summary || !summary.pending) return undefined;
    summary.pending = false;
    summary.resolvedAt = nowMs;
    return { ...summary };
  }

  async retryUpdateReminderNotification(game: PublicGameSlug, nowMs: number): Promise<UpdateReminderSummary | undefined> {
    const summary = this.updateReminderGames.get(game);
    if (!summary || !summary.pending) return undefined;
    if (summary.notificationStatus === "sent") return { ...summary };
    summary.notificationStatus = "pending";
    summary.notificationAttempts = 0;
    summary.nextNotificationAt = nowMs;
    summary.lastNotificationError = null;
    return { ...summary };
  }

  async claimDueUpdateReminderNotifications(nowMs: number): Promise<UpdateReminderNotificationClaim[]> {
    const claims: UpdateReminderNotificationClaim[] = [];
    for (const summary of this.updateReminderGames.values()) {
      if (!summary.pending || summary.notificationStatus === "sent" || summary.notificationAttempts >= UPDATE_REMINDER_NOTIFICATION_MAX_ATTEMPTS) continue;
      const due = summary.nextNotificationAt === null
        ? summary.notificationStatus === "pending"
        : summary.nextNotificationAt <= nowMs;
      if (!due) continue;
      summary.notificationStatus = "pending";
      summary.notificationAttempts += 1;
      summary.nextNotificationAt = nowMs + UPDATE_REMINDER_NOTIFICATION_LEASE_MS;
      if (summary.cycleId === null) continue;
      claims.push({ cycleId: summary.cycleId, game: summary.game, cycleNumber: summary.cycleNumber, attempt: summary.notificationAttempts, summary: { ...summary } });
    }
    return claims;
  }

  async markUpdateReminderNotificationSent(cycleId: number, game: PublicGameSlug, nowMs: number): Promise<void> {
    const summary = this.updateReminderGames.get(game);
    if (!summary || summary.cycleId !== cycleId || !summary.pending) return;
    summary.notificationStatus = "sent";
    summary.lastNotifiedAt = nowMs;
    summary.nextNotificationAt = null;
    summary.lastNotificationError = null;
  }

  async markUpdateReminderNotificationFailed(cycleId: number, _nowMs: number, nextNotificationAt: number | null, errorCode: string): Promise<void> {
    for (const summary of this.updateReminderGames.values()) {
      if (summary.cycleId !== cycleId || !summary.pending) continue;
      summary.notificationStatus = "failed";
      summary.nextNotificationAt = nextNotificationAt;
      summary.lastNotificationError = errorCode;
    }
  }
  private claim(visitor: string, kind: string, id: string, expiresAt: number): boolean {
    const key = `${visitor}:${kind}:${id}`;
    if (this.dedupe.has(key)) return false;
    this.dedupe.set(key, expiresAt);
    return true;
  }

  private increment(id: string, field: keyof ResourceStats): void {
    const current = this.resources.get(id) ?? { views: 0, downloads: 0 };
    current[field] += 1;
    this.resources.set(id, current);
  }

  private purge(nowMs: number): void {
    for (const [key, expiresAt] of this.dedupe) if (expiresAt <= nowMs) this.dedupe.delete(key);
  }
}

function makeEnv(store: StatsStore): Env & { store: StatsStore } {
  return { ALLOWED_ORIGINS: "https://rhythmarchive.github.io,http://localhost:4321", SITE_TIME_ZONE: "UTC", store };
}

function request(path: string, method: "GET" | "POST" | "OPTIONS", body?: unknown, origin = "https://rhythmarchive.github.io"): Request {
  return new Request(`https://stats.example.test${path}`, {
    method,
    headers: { Origin: origin, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function responseJson(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}

async function postEvent(store: StatsStore, event: StatsEvent, nowMs: number): Promise<Record<string, any>> {
  return responseJson(await handleRequest(request("/v1/events", "POST", event), makeEnv(store), { store, now: () => nowMs }));
}

async function postReminder(store: StatsStore, body: unknown, nowMs: number, origin = "https://rhythmarchive.github.io"): Promise<{ response: Response; payload: Record<string, any> }> {
  const response = await handleRequest(request("/v1/update-reminders", "POST", body, origin), makeEnv(store), { store, now: () => nowMs });
  return { response, payload: await responseJson(response) };
}
test("site visits are deduplicated for 30 minutes and counted again after the window", async () => {
  const store = new MemoryStatsStore();
  const first = await postEvent(store, { type: "site_visit", visitorId }, baseTime);
  const repeated = await postEvent(store, { type: "site_visit", visitorId }, baseTime + SITE_SESSION_WINDOW_MS - 1);
  const nextSession = await postEvent(store, { type: "site_visit", visitorId }, baseTime + SITE_SESSION_WINDOW_MS);

  assert.equal(first.counted.siteVisit, true);
  assert.equal(first.site.totalVisits, 1);
  assert.equal(repeated.counted.siteVisit, false);
  assert.equal(repeated.site.totalVisits, 1);
  assert.equal(nextSession.counted.siteVisit, true);
  assert.equal(nextSession.site.totalVisits, 2);
});

test("detail and subsequent download share one resource view window", async () => {
  const store = new MemoryStatsStore();
  const detail = await postEvent(store, { type: "resource_detail", visitorId, resourceId }, baseTime);
  const download = await postEvent(store, { type: "resource_download", visitorId, resourceId }, baseTime + 1_000);
  const repeatedDownload = await postEvent(store, { type: "resource_download", visitorId, resourceId }, baseTime + 2_000);

  assert.deepEqual(detail.counted, { siteVisit: false, view: true, download: false });
  assert.deepEqual(download.counted, { siteVisit: false, view: false, download: true });
  assert.deepEqual(repeatedDownload.counted, { siteVisit: false, view: false, download: false });
  assert.deepEqual(download.resource, { resourceId, views: 1, downloads: 1 });
});

test("direct download counts one view and one download", async () => {
  const store = new MemoryStatsStore();
  const first = await postEvent(store, { type: "resource_download", visitorId, resourceId }, baseTime);
  const repeated = await postEvent(store, { type: "resource_download", visitorId, resourceId }, baseTime + DOWNLOAD_DEDUPE_WINDOW_MS - 1);
  const laterDownload = await postEvent(store, { type: "resource_download", visitorId, resourceId }, baseTime + DOWNLOAD_DEDUPE_WINDOW_MS);
  const newViewWindow = await postEvent(store, { type: "resource_detail", visitorId, resourceId }, baseTime + SITE_SESSION_WINDOW_MS);

  assert.deepEqual(first.counted, { siteVisit: false, view: true, download: true });
  assert.deepEqual(repeated.counted, { siteVisit: false, view: false, download: false });
  assert.deepEqual(laterDownload.counted, { siteVisit: false, view: false, download: true });
  assert.equal(newViewWindow.counted.view, true);
  assert.deepEqual(newViewWindow.resource, { resourceId, views: 2, downloads: 2 });
});

test("batch stats reads do not create views and return all requested IDs", async () => {
  const store = new MemoryStatsStore();
  await postEvent(store, { type: "resource_detail", visitorId, resourceId }, baseTime);
  const response = await handleRequest(request("/v1/resources/stats", "POST", { resourceIds: [resourceId, secondResourceId, resourceId] }), makeEnv(store), { store, now: () => baseTime + 1_000 });
  const payload = await responseJson(response);

  assert.equal(response.status, 200);
  assert.deepEqual(payload.stats, {
    [resourceId]: { views: 1, downloads: 0 },
    [secondResourceId]: { views: 0, downloads: 0 },
  });
  const afterRead = await postEvent(store, { type: "resource_detail", visitorId, resourceId }, baseTime + 2_000);
  assert.equal(afterRead.counted.view, false);
});

test("invalid resource IDs and oversized batches are rejected", async () => {
  const store = new MemoryStatsStore();
  const invalidEvent = await handleRequest(request("/v1/events", "POST", { type: "resource_detail", visitorId, resourceId: "not-a-resource" }), makeEnv(store), { store, now: () => baseTime });
  const invalidBatch = await handleRequest(request("/v1/resources/stats", "POST", { resourceIds: ["not-a-resource"] }), makeEnv(store), { store, now: () => baseTime });
  const tooLarge = await handleRequest(request("/v1/resources/stats", "POST", { resourceIds: Array.from({ length: MAX_RESOURCE_IDS + 1 }, (_, index) => `${String(index).padStart(8, "0")}-1111-7111-8111-111111111111`) }), makeEnv(store), { store, now: () => baseTime });

  assert.equal(invalidEvent.status, 400);
  assert.equal((await responseJson(invalidEvent)).error, "invalid_resource_id");
  assert.equal(invalidBatch.status, 400);
  assert.equal((await responseJson(invalidBatch)).error, "invalid_resource_id");
  assert.equal(tooLarge.status, 400);
  assert.equal((await responseJson(tooLarge)).error, "resource_id_batch_too_large");
  assert.equal(isValidResourceId(resourceId), true);
  assert.equal(isValidResourceId("/r/not-a-resource/"), false);
});

test("first valid update reminder is accepted, persisted as pending, and marked as first", async () => {
  const store = new MemoryStatsStore();
  const { response, payload } = await postReminder(store, { visitorId, game: "arcaea" }, baseTime);

  assert.equal(response.status, 202);
  assert.equal(payload.ok, true);
  assert.equal(payload.status, "accepted");
  assert.equal(payload.firstReminder, true);
  assert.deepEqual(payload.reminder, {
    game: "arcaea",
    pending: true,
    cycleId: 1,
    cycleNumber: 1,
    firstReminderAt: baseTime,
    lastReminderAt: baseTime,
    effectiveReminderCount: 1,
    cycleEffectiveReminderCount: 1,
    lastNotifiedAt: null,
    notificationStatus: "pending",
    notificationAttempts: 0,
    nextNotificationAt: null,
    lastNotificationError: null,
    resolvedAt: null,
  });
});

test("same visitor and game are deduplicated for 24 hours", async () => {
  const store = new MemoryStatsStore();
  await postReminder(store, { visitorId, game: "arcaea" }, baseTime);
  const repeated = await postReminder(store, { visitorId, game: "arcaea" }, baseTime + UPDATE_REMINDER_DEDUPE_WINDOW_MS - 1);

  assert.equal(repeated.response.status, 409);
  assert.equal(repeated.payload.status, "duplicate");
  assert.equal(repeated.payload.error, "already_reminded");
  assert.equal(repeated.payload.nextAllowedAt, baseTime + UPDATE_REMINDER_DEDUPE_WINDOW_MS);
});

test("different visitors create separate effective reminders for one game", async () => {
  const store = new MemoryStatsStore();
  await postReminder(store, { visitorId, game: "arcaea" }, baseTime);
  const second = await postReminder(store, { visitorId: otherVisitorId, game: "arcaea" }, baseTime + 1_000);

  assert.equal(second.response.status, 202);
  assert.equal(second.payload.firstReminder, false);
  assert.equal(second.payload.reminder.effectiveReminderCount, 2);
  assert.equal(second.payload.reminder.lastReminderAt, baseTime + 1_000);
});

test("update reminders reject invalid visitor IDs, unknown games, and missing fields", async () => {
  const store = new MemoryStatsStore();
  const invalidVisitor = await postReminder(store, { visitorId: "not-a-uuid", game: "arcaea" }, baseTime);
  const invalidGame = await postReminder(store, { visitorId, game: "unknown-game" }, baseTime);
  const missingField = await postReminder(store, { visitorId }, baseTime);

  assert.equal(invalidVisitor.response.status, 400);
  assert.equal(invalidVisitor.payload.error, "invalid_visitor_id");
  assert.equal(invalidGame.response.status, 400);
  assert.equal(invalidGame.payload.error, "invalid_game");
  assert.equal(missingField.response.status, 400);
  assert.equal(missingField.payload.error, "missing_field");
});

test("first reminder email succeeds without exposing visitor identity", async () => {
  const store = new MemoryStatsStore();
  const env = { ...makeEnv(store), ...testEmailConfig };
  let calls = 0;
  let requestInput: RequestInfo | URL | undefined;
  let requestInit: RequestInit | undefined;
  let body = "";
  const response = await handleRequest(
    request("/v1/update-reminders", "POST", { visitorId, game: "arcaea" }),
    env,
    {
      store,
      now: () => baseTime,
      fetchImpl: async (input, init) => {
        calls += 1;
        requestInput = input;
        requestInit = init;
        body = String(init?.body);
        return new Response(JSON.stringify({ id: "email-test-id" }), { status: 202, headers: { "Content-Type": "application/json" } });
      },
    },
  );

  assert.equal(response.status, 202);
  assert.equal(calls, 1);
  assert.equal(String(requestInput), "https://api.resend.com/emails");
  assert.equal(new Headers(requestInit?.headers).get("Authorization")?.startsWith("Bearer "), true);
  const email = JSON.parse(body) as { from: string; to: string[]; subject: string; text: string };
  assert.equal(email.from, "Rhythm Archive <onboarding@resend.dev>");
  assert.deepEqual(email.to, ["recipient"]);
  assert.equal(email.subject, "[Rhythm Archive] Arcaea 可能有新内容");
  assert.match(email.text, /Rhythm Archive 更新提醒/u);
  assert.match(email.text, /游戏：Arcaea/u);
  assert.match(email.text, /game slug：arcaea/u);
  assert.match(email.text, /当前 cycle 有效提醒数量：1/u);
  assert.match(email.text, new RegExp(new Date(baseTime).toISOString(), "u"));
  assert.match(email.text, /当前 pending 状态：是/u);
  assert.doesNotMatch(body, /11111111-1111-7111-8111-111111111111/u);
  const pending = await store.listPendingUpdateReminders();
  assert.equal(pending[0]?.notificationStatus, "sent");
  assert.equal(pending[0]?.lastNotifiedAt, baseTime);
});

test("later reminders in one pending cycle do not send another email", async () => {
  const store = new MemoryStatsStore();
  const env = { ...makeEnv(store), ...testEmailConfig };
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(null, { status: 204 });
  };
  const first = await handleRequest(
    request("/v1/update-reminders", "POST", { visitorId, game: "arcaea" }),
    env,
    { store, now: () => baseTime, fetchImpl },
  );
  const later = await handleRequest(
    request("/v1/update-reminders", "POST", { visitorId: otherVisitorId, game: "arcaea" }),
    env,
    { store, now: () => baseTime + 1_000, fetchImpl },
  );

  assert.equal(first.status, 202);
  assert.equal(later.status, 202);
  assert.equal(calls, 1);
  assert.equal((await responseJson(later)).reminder.cycleEffectiveReminderCount, 2);
});
test("notification failure keeps accepted reminder recoverable and scheduled retry can succeed", async () => {
  const store = new MemoryStatsStore();
  const env = { ...makeEnv(store), ...testEmailConfig };
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    return attempts === 1 ? new Response(null, { status: 503 }) : new Response(null, { status: 204 });
  };
  const response = await handleRequest(
    request("/v1/update-reminders", "POST", { visitorId, game: "arcaea" }),
    env,
    { store, now: () => baseTime, fetchImpl },
  );

  assert.equal(response.status, 202);
  assert.equal(attempts, 1);
  const failed = (await store.listPendingUpdateReminders())[0]!;
  assert.equal(failed.notificationStatus, "failed");
  assert.equal(failed.notificationAttempts, 1);
  assert.equal(failed.lastNotificationError, "http_503");
  assert.ok(failed.nextNotificationAt && failed.nextNotificationAt > baseTime);

  await processPendingUpdateReminderNotifications(env, {
    store,
    now: failed.nextNotificationAt,
    fetchImpl,
  });
  const recovered = (await store.listPendingUpdateReminders())[0]!;
  assert.equal(attempts, 2);
  assert.equal(recovered.notificationStatus, "sent");
  assert.equal(recovered.lastNotifiedAt, failed.nextNotificationAt);
});

test("Resend retry classification keeps transient errors retryable and ordinary 4xx terminal", async () => {
  for (const status of [429, 503, 400]) {
    const store = new MemoryStatsStore();
    const env = { ...makeEnv(store), ...testEmailConfig };
    const response = await handleRequest(
      request("/v1/update-reminders", "POST", { visitorId, game: "arcaea" }),
      env,
      {
        store,
        now: () => baseTime,
        fetchImpl: async () => new Response(null, { status }),
      },
    );

    assert.equal(response.status, 202);
    const pending = (await store.listPendingUpdateReminders())[0]!;
    assert.equal(pending.lastNotificationError, "http_" + status);
    assert.equal(pending.nextNotificationAt !== null, status === 429 || status >= 500);
  }
});

test("non-retryable Resend errors are not claimed again by scheduled retry", async () => {
  const store = new MemoryStatsStore();
  const env = { ...makeEnv(store), ...testEmailConfig };
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(null, { status: 400 });
  };

  const initial = await handleRequest(
    request("/v1/update-reminders", "POST", { visitorId, game: "arcaea" }),
    env,
    { store, now: () => baseTime, fetchImpl },
  );
  await processPendingUpdateReminderNotifications(env, {
    store,
    now: baseTime + UPDATE_REMINDER_NOTIFICATION_LEASE_MS + 1,
    fetchImpl,
  });

  assert.equal(initial.status, 202);
  assert.equal(calls, 1);
  const pending = (await store.listPendingUpdateReminders())[0]!;
  assert.equal(pending.notificationStatus, "failed");
  assert.equal(pending.notificationAttempts, 1);
  assert.equal(pending.nextNotificationAt, null);
});
test("Resend network and timeout errors remain recoverable", async () => {
  for (const [error, errorCode] of [
    [new Error("network failure"), "network"],
    [new DOMException("request timed out", "AbortError"), "timeout"],
  ] as const) {
    const store = new MemoryStatsStore();
    const env = { ...makeEnv(store), ...testEmailConfig };
    const response = await handleRequest(
      request("/v1/update-reminders", "POST", { visitorId, game: "arcaea" }),
      env,
      {
        store,
        now: () => baseTime,
        fetchImpl: async () => { throw error; },
      },
    );

    assert.equal(response.status, 202);
    const pending = (await store.listPendingUpdateReminders())[0]!;
    assert.equal(pending.lastNotificationError, errorCode);
    assert.ok(pending.nextNotificationAt && pending.nextNotificationAt > baseTime);
  }
});

test("a resolved cycle can send a new email in the next cycle", async () => {
  const store = new MemoryStatsStore();
  const env = { ...makeEnv(store), ...testEmailConfig };
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(null, { status: 202 });
  };

  const first = await handleRequest(
    request("/v1/update-reminders", "POST", { visitorId, game: "arcaea" }),
    env,
    { store, now: () => baseTime, fetchImpl },
  );
  const resolved = await store.resolveUpdateReminder("arcaea", baseTime + 1_000);
  const next = await handleRequest(
    request("/v1/update-reminders", "POST", { visitorId, game: "arcaea" }),
    env,
    { store, now: () => baseTime + 2_000, fetchImpl },
  );

  assert.equal(first.status, 202);
  assert.equal(resolved?.pending, false);
  assert.equal(next.status, 202);
  assert.equal(calls, 2);
  const pending = (await store.listPendingUpdateReminders())[0]!;
  assert.equal(pending.cycleNumber, 2);
  assert.equal(pending.notificationStatus, "sent");
  assert.equal(pending.lastNotifiedAt, baseTime + 2_000);
});
test("resolve closes the current cycle and the next valid reminder starts a new cycle", async () => {
  const store = new MemoryStatsStore();
  await postReminder(store, { visitorId, game: "arcaea" }, baseTime);
  const resolved = await store.resolveUpdateReminder("arcaea", baseTime + 1_000);
  assert.equal(resolved?.pending, false);
  assert.equal(resolved?.resolvedAt, baseTime + 1_000);

  const next = await postReminder(store, { visitorId, game: "arcaea" }, baseTime + 2_000);
  assert.equal(next.response.status, 202);
  assert.equal(next.payload.firstReminder, true);
  assert.equal(next.payload.reminder.cycleNumber, 2);
  assert.equal(next.payload.reminder.cycleEffectiveReminderCount, 1);
  assert.equal(next.payload.reminder.effectiveReminderCount, 2);
});

test("admin pending query and resolve require the Worker secret", async () => {
  const store = new MemoryStatsStore();
  const env = { ...makeEnv(store), UPDATE_REMINDER_ADMIN_TOKEN: "admin-secret" };
  await postReminder(store, { visitorId, game: "arcaea" }, baseTime);

  const unauthorized = await handleRequest(request("/v1/admin/update-reminders", "GET"), env, { store, now: () => baseTime });
  assert.equal(unauthorized.status, 401);

  const adminHeaders = { Origin: "https://rhythmarchive.github.io", Authorization: "Bearer admin-secret" };
  const listed = await handleRequest(new Request("https://stats.example.test/v1/admin/update-reminders", { method: "GET", headers: adminHeaders }), env, { store, now: () => baseTime });
  assert.equal(listed.status, 200);
  assert.equal((await responseJson(listed)).pending.length, 1);

  const resolved = await handleRequest(new Request("https://stats.example.test/v1/admin/update-reminders/arcaea/resolve", { method: "POST", headers: adminHeaders }), env, { store, now: () => baseTime + 1_000 });
  assert.equal(resolved.status, 200);
  assert.equal((await responseJson(resolved)).status, "resolved");

  const after = await handleRequest(new Request("https://stats.example.test/v1/admin/update-reminders", { method: "GET", headers: adminHeaders }), env, { store, now: () => baseTime + 1_000 });
  assert.deepEqual((await responseJson(after)).pending, []);
});
test("malformed JSON returns a stable 400 error", async () => {
  const store = new MemoryStatsStore();
  const malformed = new Request("https://stats.example.test/v1/update-reminders", {
    method: "POST",
    headers: { Origin: "https://rhythmarchive.github.io", "Content-Type": "application/json" },
    body: "{",
  });
  const response = await handleRequest(malformed, makeEnv(store), { store, now: () => baseTime });

  assert.equal(response.status, 400);
  assert.equal((await responseJson(response)).error, "invalid_json_body");
});

test("update reminder request frequency is limited per visitor", async () => {
  const store = new MemoryStatsStore();
  for (let index = 0; index < UPDATE_REMINDER_MAX_REQUESTS_PER_WINDOW; index += 1) {
    const result = await postReminder(store, { visitorId, game: "arcaea" }, baseTime + index * 1_000);
    assert.notEqual(result.response.status, 429);
  }
  const limited = await postReminder(store, { visitorId, game: "arcaea" }, baseTime + UPDATE_REMINDER_MAX_REQUESTS_PER_WINDOW * 1_000);

  assert.equal(limited.response.status, 429);
  assert.equal(limited.payload.error, "rate_limited");
  assert.ok(Number(limited.payload.retryAfterSeconds) > 0);
  assert.ok(Number(limited.response.headers.get("Retry-After")) > 0);
});

test("update reminder CORS follows the configured origin policy", async () => {
  const store = new MemoryStatsStore();
  const preflight = await handleRequest(request("/v1/update-reminders", "OPTIONS"), makeEnv(store), { store });
  const rejected = await handleRequest(request("/v1/update-reminders", "POST", { visitorId, game: "arcaea" }, "https://evil.example.test"), makeEnv(store), { store, now: () => baseTime });

  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), "https://rhythmarchive.github.io");
  assert.match(preflight.headers.get("Access-Control-Allow-Methods") ?? "", /POST/u);
  assert.equal(rejected.status, 403);
  assert.equal(rejected.headers.get("Access-Control-Allow-Origin"), null);
});

test("database failures become stable 503 responses", async () => {
  const failingStore: StatsStore = {
    recordEvent: async () => { throw new Error("database unavailable"); },
    recordUpdateReminder: async () => { throw new Error("database unavailable"); },
    listPendingUpdateReminders: async () => { throw new Error("database unavailable"); },
    resolveUpdateReminder: async () => { throw new Error("database unavailable"); },
    retryUpdateReminderNotification: async () => { throw new Error("database unavailable"); },
    claimDueUpdateReminderNotifications: async () => { throw new Error("database unavailable"); },
    markUpdateReminderNotificationSent: async () => { throw new Error("database unavailable"); },
    markUpdateReminderNotificationFailed: async () => { throw new Error("database unavailable"); },
    getSiteStats: async () => { throw new Error("database unavailable"); },
    getResourceStats: async () => { throw new Error("database unavailable"); },
  };
  const response = await handleRequest(
    request("/v1/update-reminders", "POST", { visitorId, game: "arcaea" }),
    makeEnv(failingStore),
    { store: failingStore, now: () => baseTime },
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await responseJson(response), { error: "stats_unavailable" });
});
test("CORS only exposes configured origins", async () => {
  const store = new MemoryStatsStore();
  const allowed = await handleRequest(request("/health", "GET"), makeEnv(store));
  const preflight = await handleRequest(request("/v1/events", "OPTIONS"), makeEnv(store), { store });
  const rejected = await handleRequest(request("/health", "GET", undefined, "https://evil.example.test"), makeEnv(store));

  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), "https://rhythmarchive.github.io");
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), "https://rhythmarchive.github.io");
  assert.equal(rejected.status, 403);
  assert.equal(rejected.headers.get("Access-Control-Allow-Origin"), null);
});

test("D1 unavailability returns a non-blocking service error", async () => {
  const response = await handleRequest(request("/v1/site/stats", "GET"), { ALLOWED_ORIGINS: "https://rhythmarchive.github.io" });
  assert.equal(response.status, 503);
  assert.equal((await responseJson(response)).error, "stats_unavailable");
});

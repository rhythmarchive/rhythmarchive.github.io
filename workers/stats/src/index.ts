import { D1StatsStore, handleRequest, processPendingUpdateReminderNotifications, siteDateKey } from "./core.js";
import { handleOperationsRequest, processDailyOperations, type OperationsEnv } from './daily-operations.js';
import type { RankingCache } from "./ranking-cache.js";
import { processResourceReports } from "./resource-reports.js";

type WorkerExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};

export default {
  fetch(request: Request, env: OperationsEnv, ctx: WorkerExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname.startsWith('/v1/admin/operations')) return handleOperationsRequest(request, env);
    let rankingCache: RankingCache | undefined;
    try { rankingCache = (globalThis.caches as (CacheStorage & { default?: RankingCache }) | undefined)?.default; }
    catch { /* Cache API availability must not affect statistics or limiting. */ }
    return handleRequest(request, env, { ...(rankingCache ? { rankingCache } : {}), waitUntil: (promise) => ctx.waitUntil(promise) });
  },
  scheduled(controller: { scheduledTime?: number }, env: OperationsEnv, ctx: WorkerExecutionContext): void {
    const nowMs = controller.scheduledTime ?? Date.now();
    const tasks: Promise<unknown>[] = [processPendingUpdateReminderNotifications(env), processResourceReports(env), processDailyOperations(env, nowMs)];
    if (env.DB) tasks.push(new D1StatsStore(env.DB).cleanup(nowMs, siteDateKey(nowMs, env.SITE_TIME_ZONE || "Asia/Shanghai")));
    ctx.waitUntil(Promise.allSettled(tasks).then(() => undefined));
  },
};

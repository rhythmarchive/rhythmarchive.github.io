import { D1StatsStore, handleRequest, processPendingUpdateReminderNotifications, siteDateKey } from "./core.js";
import type { Env } from "./core.js";
import type { RankingCache } from "./ranking-cache.js";

type WorkerExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};

export default {
  fetch(request: Request, env: Env, ctx: WorkerExecutionContext): Promise<Response> {
    let rankingCache: RankingCache | undefined;
    try { rankingCache = (globalThis.caches as (CacheStorage & { default?: RankingCache }) | undefined)?.default; }
    catch { /* Cache API availability must not affect statistics or limiting. */ }
    return handleRequest(request, env, { ...(rankingCache ? { rankingCache } : {}), waitUntil: (promise) => ctx.waitUntil(promise) });
  },
  scheduled(_controller: unknown, env: Env, ctx: WorkerExecutionContext): void {
    const nowMs = Date.now();
    const tasks: Promise<unknown>[] = [processPendingUpdateReminderNotifications(env)];
    if (env.DB) tasks.push(new D1StatsStore(env.DB).cleanup(nowMs, siteDateKey(nowMs, env.SITE_TIME_ZONE || "Asia/Shanghai")));
    ctx.waitUntil(Promise.all(tasks).then(() => undefined));
  },
};

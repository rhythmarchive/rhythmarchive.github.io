import { handleRequest, processPendingUpdateReminderNotifications } from "./core.js";
import type { Env } from "./core.js";

type WorkerExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};

export default {
  fetch(request: Request, env: Env, ctx: WorkerExecutionContext): Promise<Response> {
    return handleRequest(request, env, { waitUntil: (promise) => ctx.waitUntil(promise) });
  },
  scheduled(_controller: unknown, env: Env, ctx: WorkerExecutionContext): void {
    ctx.waitUntil(processPendingUpdateReminderNotifications(env));
  },
};

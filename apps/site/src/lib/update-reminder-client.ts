import { isValidVisitorId, normalizeStatsApiUrl } from "./stats-client";

export type UpdateReminderStatus = "accepted" | "duplicate" | "failed";
export type UpdateReminderFailureReason = "not-configured" | "invalid-request" | "network" | "server";
export type UpdateReminderResult = {
  status: UpdateReminderStatus;
  reason?: UpdateReminderFailureReason;
};

export type UpdateReminderFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type UpdateReminderResponseBody = {
  ok?: unknown;
  status?: unknown;
  code?: unknown;
};

/**
 * Future Worker contract:
 * - 2xx means the reminder was accepted.
 * - 409, or a body status/code of duplicate/already_reminded, means the visitor recently reminded this game.
 * - Any other non-2xx response is a temporary/server failure from the visitor's perspective.
 */
export function classifyUpdateReminderResponse(responseStatus: number, body: unknown): UpdateReminderStatus {
  const record = isResponseBody(body) ? body : undefined;
  const status = responseStatusToken(record?.status);
  const code = responseStatusToken(record?.code);
  if (responseStatus === 409 || status === "duplicate" || status === "already_reminded" || code === "duplicate" || code === "already_reminded") return "duplicate";
  if (responseStatus < 200 || responseStatus >= 300 || record?.ok === false || status === "error" || status === "failed") return "failed";
  return "accepted";
}

export async function submitUpdateReminder(options: {
  apiUrl?: string | undefined;
  visitorId?: string | undefined;
  game: string;
  turnstileToken?: string | undefined;
  fetchImpl?: UpdateReminderFetch | undefined;
}): Promise<UpdateReminderResult> {
  const apiUrl = normalizeStatsApiUrl(options.apiUrl);
  const visitorId = options.visitorId;
  const game = options.game.trim();
  if (!apiUrl) return { status: "failed", reason: "not-configured" };
  if (!isValidVisitorId(visitorId) || !game) return { status: "failed", reason: "invalid-request" };

  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  try {
    const response = await fetchImpl(apiUrl + "/v1/update-reminders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visitorId, game, ...(options.turnstileToken?.trim() ? { turnstileToken: options.turnstileToken.trim() } : {}) }),
      credentials: "omit",
    });
    const body = await readResponseBody(response);
    const status = classifyUpdateReminderResponse(response.status, body);
    return status === "failed" ? { status, reason: "server" } : { status };
  } catch {
    return { status: "failed", reason: "network" };
  }
}

async function readResponseBody(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown;
  } catch {
    return undefined;
  }
}

function isResponseBody(value: unknown): value is UpdateReminderResponseBody {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseStatusToken(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim().toLowerCase() : undefined;
}
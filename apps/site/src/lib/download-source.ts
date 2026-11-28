import { getDownloadLine, type DownloadLine } from "./download-preference";
import { DownloadHttpError } from "./resource-reports-client";

export const r2DownloadHost = "dl.rhythmarchive.top";

export function downloadLineOf(url: string): DownloadLine {
  return new URL(url).hostname === r2DownloadHost ? "r2" : "ros";
}

// A projected pair is R2 followed by its ROS mirror. A single URL stands alone.
export function orderDownloadSources(url: string, mirror: string | undefined, line = getDownloadLine()): [string, string?] {
  if (!mirror || mirror === url) return [url];
  return line === "ros" ? [mirror, url] : [url, mirror];
}

export async function fetchDownload(primary: string, backup: string | undefined, signal?: AbortSignal) {
  const options = { credentials: "omit", referrerPolicy: "strict-origin-when-cross-origin", signal: signal ?? null } as const;
  signal?.throwIfAborted();
  if (!backup || primary === backup) return { response: await fetch(primary, options), url: primary, automatic: false };

  // A previous failure cannot tell us whether this foreground request will work.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(primary, {
      ...options, signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    });
    if (response.ok) return { response, url: primary, automatic: false };
    void response.body?.cancel().catch(() => {});
  } catch {
    signal?.throwIfAborted();
  } finally {
    clearTimeout(timer);
  }
  signal?.throwIfAborted();
  return { response: await fetch(backup, options), url: backup, automatic: true };
}

export async function readDownload<T>(
  primary: string,
  backup: string | undefined,
  signal: AbortSignal,
  read: (response: Response) => Promise<T>,
  canRetryBody: (error: unknown) => boolean = () => true,
): Promise<{ data: T; source: DownloadLine; automatic: boolean }> {
  const readOk = (response: Response) => {
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new DownloadHttpError(response.status);
    }
    return read(response);
  };
  const delivery = await fetchDownload(primary, backup, signal);
  try {
    return { data: await readOk(delivery.response), source: downloadLineOf(delivery.url), automatic: delivery.automatic };
  } catch (error) {
    signal.throwIfAborted();
    if (delivery.automatic || !backup || !delivery.response.ok || !canRetryBody(error)) throw error;
    const retry = await fetchDownload(backup, undefined, signal);
    return { data: await readOk(retry.response), source: downloadLineOf(retry.url), automatic: true };
  }
}

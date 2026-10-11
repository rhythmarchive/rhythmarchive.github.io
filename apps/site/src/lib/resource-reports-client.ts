import { normalizeStatsApiUrl, isValidResourceId } from './stats-client';

export class DownloadHttpError extends Error {
  constructor(readonly status: number) { super(`download failed with ${status}`); }
}
export function classifyDownloadFailure(error: unknown): string | undefined {
  if (error instanceof DownloadHttpError && error.status >= 400 && error.status <= 599) return `http_${error.status}`;
  // Fetch/body network failures are TypeError. Abort and local ZIP/size/save
  // errors must not be reported as remote download faults.
  if (error instanceof TypeError) return 'network';
  return undefined;
}
const reported = new Set<string>();
export function reportDownloadFailure(resourceId: string, error: unknown): void {
  const kind = classifyDownloadFailure(error);
  if (!kind || !isValidResourceId(resourceId)) return;
  const api = normalizeStatsApiUrl(document.documentElement?.dataset.statsApiUrl);
  const key = `${resourceId}:${kind}`;
  if (!api || !kind || !isValidResourceId(resourceId) || reported.has(key) || reported.size >= 10) return;
  reported.add(key);
  // Best effort, once per page/resource/error; never retry or delay the download.
  void fetch(`${api}/v1/download-failures`, { method: 'POST', credentials: 'omit', keepalive: true,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resourceId, kind }) }).catch(() => undefined);
}

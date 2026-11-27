// Repeated failures briefly skip the foreground R2 request in this session.
let failures = 0;
let retryAt = 0;

export async function fetchDownload(primary: string, backup: string | undefined, signal?: AbortSignal) {
  const options = { credentials: "omit", referrerPolicy: "strict-origin-when-cross-origin", signal: signal ?? null } as const;
  signal?.throwIfAborted();
  if (!backup) return { response: await fetch(primary, options), automatic: false };
  if (Date.now() >= retryAt) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(primary, {
        ...options, signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      });
      if (response.ok) {
        failures = 0;
        retryAt = 0;
        return { response, automatic: false };
      }
      void response.body?.cancel().catch(() => {});
    } catch {
      signal?.throwIfAborted();
    } finally {
      clearTimeout(timer);
    }
    signal?.throwIfAborted();
    if (++failures >= 2) retryAt = Date.now() + 60000;
  }
  return { response: await fetch(backup, options), automatic: true };
}

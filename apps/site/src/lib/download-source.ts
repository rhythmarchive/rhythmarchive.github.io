export async function fetchDownload(primary: string, backup: string | undefined, signal?: AbortSignal) {
  const options = { credentials: "omit", referrerPolicy: "strict-origin-when-cross-origin", signal: signal ?? null } as const;
  signal?.throwIfAborted();
  if (!backup || primary === backup) return { response: await fetch(primary, options), automatic: false };

  // A previous failure cannot tell us whether this foreground request will work.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(primary, {
      ...options, signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    });
    if (response.ok) return { response, automatic: false };
    void response.body?.cancel().catch(() => {});
  } catch {
    signal?.throwIfAborted();
  } finally {
    clearTimeout(timer);
  }
  signal?.throwIfAborted();
  return { response: await fetch(backup, options), automatic: true };
}

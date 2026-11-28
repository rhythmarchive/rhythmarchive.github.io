import type { DownloadLine } from "./download-preference";
import { r2DownloadHost } from "./download-source";

export type DownloadLineStatus = "reachable" | "unavailable" | "unknown" | "timeout";

// This published 4,662-byte WebP is mirrored at the same immutable key on both lines.
const probeKey = "objects/00011f1daad90fa7e3934a98c935dad1a94eb0458c033ab146657e76720d96fa/webp";

async function probe(url: string): Promise<DownloadLineStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, {
      method: "HEAD", mode: "cors", credentials: "omit", redirect: "error", cache: "no-store",
      referrerPolicy: "strict-origin-when-cross-origin", signal: controller.signal,
    });
    if (response.status === 0) return "unknown";
    if (!response.ok) return "unavailable";
    return response.headers.get("Content-Length") === "4662" ? "reachable" : "unknown";
  } catch {
    return controller.signal.aborted ? "timeout" : "unknown";
  } finally {
    clearTimeout(timer);
  }
}

export async function checkDownloadLines(rosBaseUrl: string) {
  const [r2, ros] = await Promise.all([probe(`https://${r2DownloadHost}/${probeKey}`), probe(`${rosBaseUrl}/${probeKey}`)]);
  const preferred: DownloadLine | undefined = r2 === "reachable" ? "r2" : ros === "reachable" ? "ros" : undefined;
  return { r2, ros, preferred };
}

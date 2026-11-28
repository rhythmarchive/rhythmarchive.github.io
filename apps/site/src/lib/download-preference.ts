export type DownloadLine = "r2" | "ros";

export const downloadLineStorageKey = "rhythm-archive-download-line";
export const downloadLineChange = "rhythm-download-line-change";
export const downloadLineNames = { r2: "Cloudflare R2", ros: "RainYun ROS" } as const;

function savedLine(): DownloadLine {
  try { return localStorage.getItem(downloadLineStorageKey) === "ros" ? "ros" : "r2"; }
  catch { return "r2"; }
}

let preference = savedLine();

export function getDownloadLine(): DownloadLine {
  return preference;
}

export function setDownloadLine(value: unknown, persist = true): void {
  const line = value === "ros" ? "ros" : "r2";
  if (persist) {
    try { localStorage.setItem(downloadLineStorageKey, line); } catch { /* Session preference still works. */ }
  }
  if (line === preference) return;
  preference = line;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(downloadLineChange));
}

import fs from "node:fs";
import path from "node:path";
import type { GameId } from "./game-config";
import { objectUrl } from "./url";

export type ApkDownloadRecord = {
  game: GameId;
  version: string;
  filename: string;
  bytes: number;
  objectKey: string;
  updatedAt: string;
};

export type PublicApkDownload = Omit<ApkDownloadRecord, "objectKey"> & { url: string };

export function parseApkManifest(value: unknown): ApkDownloadRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (record.game !== "arcaea" && record.game !== "phigros") return [];
    if (![record.version, record.filename, record.objectKey, record.updatedAt].every((field) => typeof field === "string" && field.length > 0)) return [];
    if (typeof record.bytes !== "number" || !Number.isSafeInteger(record.bytes) || record.bytes < 0) return [];
    if (!/^((objects|assets)\/[0-9a-f]{64}\/[a-z0-9]+)$/iu.test(record.objectKey as string)) return [];
    return [{ game: record.game, version: record.version as string, filename: record.filename as string, bytes: record.bytes, objectKey: record.objectKey as string, updatedAt: record.updatedAt as string }];
  });
}

export function readApkManifest(workspaceRoot: string): ApkDownloadRecord[] {
  const manifestPath = path.join(workspaceRoot, "apps", "site", "data", "apk-downloads.json");
  if (!fs.existsSync(manifestPath)) return [];
  try {
    return parseApkManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
  } catch {
    return [];
  }
}

export function publicApkDownloads(records: ApkDownloadRecord[], rosBaseUrl: string): PublicApkDownload[] {
  return records.map(({ objectKey, ...record }) => ({ ...record, url: objectUrl(objectKey, rosBaseUrl) }));
}

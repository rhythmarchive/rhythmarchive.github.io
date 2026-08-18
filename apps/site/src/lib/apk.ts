import { ROS_BASE_URL } from "./site-config";

export type PublicArcaeaApkEntry = {
  version: string;
  versionCode: number | null;
  fileName: string;
  fileSize: number;
  sha256: string;
  url: string;
  publishedAt: string;
};

export type PublicArcaeaApkManifest = {
  schemaVersion: 1;
  game: "arcaea";
  generatedAt: string;
  latest: PublicArcaeaApkEntry;
  previous: PublicArcaeaApkEntry | null;
};

const VERSION_PATTERN = /^(\d+\.\d+\.\d+)([a-z]?)$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/iu;

function canonicalVersion(value: string): string | undefined {
  const match = value.trim().match(VERSION_PATTERN);
  if (!match) return undefined;
  return `${match[1]!.split(".").map((part) => String(Number.parseInt(part, 10))).join(".")}${match[2]!.toLowerCase()}`;
}

function validEntry(value: unknown, publicBaseUrl: string): PublicArcaeaApkEntry | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const version = typeof record.version === "string" ? canonicalVersion(record.version) : undefined;
  const fileSize = record.fileSize;
  const fileName = `Arcaea_${version ?? ""}.apk`;
  const sha256 = typeof record.sha256 === "string" ? record.sha256.toLowerCase() : "";
  const url = typeof record.url === "string" ? record.url : "";
  const publishedAt = typeof record.publishedAt === "string" ? record.publishedAt : "";
  const versionCode = record.versionCode === null ? null : typeof record.versionCode === "number" && Number.isSafeInteger(record.versionCode) && record.versionCode >= 0 ? record.versionCode : undefined;
  if (!version || record.fileName !== fileName || typeof fileSize !== "number" || !Number.isSafeInteger(fileSize) || fileSize <= 0 || !SHA256_PATTERN.test(sha256) || !publishedAt || versionCode === undefined) return null;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return null;
  }
  let expectedOrigin: string;
  try {
    const expected = new URL(publicBaseUrl);
    if (expected.protocol !== "https:" || expected.username || expected.password || expected.pathname !== "/" || expected.search || expected.hash) return null;
    expectedOrigin = expected.origin;
  } catch {
    return null;
  }
  if (parsedUrl.origin !== expectedOrigin || parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) return null;
  if (parsedUrl.pathname !== `/apk/arcaea/releases/${version}/${fileName}`) return null;
  return { version, versionCode, fileName, fileSize, sha256, url, publishedAt };
}

export function parsePublicArcaeaApkManifest(value: unknown, options: { publicBaseUrl?: string } = {}): PublicArcaeaApkManifest | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.game !== "arcaea" || typeof record.generatedAt !== "string") return null;
  const publicBaseUrl = options.publicBaseUrl ?? ROS_BASE_URL;
  const latest = validEntry(record.latest, publicBaseUrl);
  const previous = record.previous === null ? null : validEntry(record.previous, publicBaseUrl);
  if (!latest || (record.previous !== null && !previous)) return null;
  return { schemaVersion: 1, game: "arcaea", generatedAt: record.generatedAt, latest, previous };
}

export function formatPublicApkBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let size = value;
  let unit = -1;
  do {
    size /= 1024;
    unit += 1;
  } while (size >= 1024 && unit < units.length - 1);
  return `${size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${units[unit]}`;
}

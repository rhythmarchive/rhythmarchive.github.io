import { validArcaeaR2Url } from "../../../../packages/domain/src/apk-download";
export const ARCAEA_GITHUB_REPOSITORY = "rhythmarchive/rhythmarchive.github.io";
export const ARCAEA_GITHUB_RELEASE_TAG_PREFIX = "arcaea-apk-";
export const ARCAEA_OFFICIAL_CDN_HOST = "arcaea-static.lowiro-cdn.net";

export type PublicArcaeaApkDownloads = {
  github: string | null;
  r2?: string;
  official: string | null;
};

export type PublicArcaeaApkEntry = {
  version: string;
  versionCode: number | null;
  fileName: string;
  fileSize: number;
  sha256: string;
  publishedAt: string;
  downloads: PublicArcaeaApkDownloads;
};

export type PublicArcaeaApkManifest = {
  schemaVersion: 2 | 3;
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
  const numeric = match[1]!.split(".").map((part) => Number(part));
  if (numeric.some((part) => !Number.isSafeInteger(part))) return undefined;
  return `${numeric.join(".")}${match[2]!.toLowerCase()}`;
}

function expectedGithubPath(version: string, fileName: string): string {
  return `/rhythmarchive/rhythmarchive.github.io/releases/download/${ARCAEA_GITHUB_RELEASE_TAG_PREFIX}${version}/${encodeURIComponent(fileName)}`;
}

function validGithubUrl(value: string, version: string, fileName: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === "https://github.com" && url.protocol === "https:" && !url.username && !url.password && !url.port && !url.search && !url.hash && url.pathname === expectedGithubPath(version, fileName);
  } catch {
    return false;
  }
}

function validOfficialUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.toLowerCase() === ARCAEA_OFFICIAL_CDN_HOST && !url.username && !url.password && !url.port;
  } catch {
    return false;
  }
}

function validEntry(value: unknown, allowMissingOfficial = false, r2BaseUrl?: string): PublicArcaeaApkEntry | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if ("url" in record) return null;
  const version = typeof record.version === "string" ? canonicalVersion(record.version) : undefined;
  const fileSize = record.fileSize;
  const fileName = `Arcaea_${version ?? ""}.apk`;
  const sha256 = typeof record.sha256 === "string" ? record.sha256.toLowerCase() : "";
  const publishedAt = typeof record.publishedAt === "string" ? record.publishedAt : "";
  const versionCode = record.versionCode === null ? null : typeof record.versionCode === "number" && Number.isSafeInteger(record.versionCode) && record.versionCode >= 0 ? record.versionCode : undefined;
  const downloads = record.downloads;
  if (!downloads || typeof downloads !== "object") return null;
  const downloadRecord = downloads as Record<string, unknown>;
  const github = downloadRecord.github === null ? null : typeof downloadRecord.github === "string" ? downloadRecord.github : "";
  const r2 = typeof downloadRecord.r2 === "string" ? downloadRecord.r2 : undefined;
  const official = downloadRecord.official === undefined && allowMissingOfficial ? null : downloadRecord.official === null ? null : typeof downloadRecord.official === "string" ? downloadRecord.official : undefined;
  if (!version || record.fileName !== fileName || typeof fileSize !== "number" || !Number.isSafeInteger(fileSize) || fileSize <= 0 || !SHA256_PATTERN.test(sha256) || !publishedAt || versionCode === undefined || (!github && !r2) || official === undefined) return null;
  if ((github !== null && !validGithubUrl(github, version, fileName)) || (official !== null && !validOfficialUrl(official))) return null;
  if (r2 && !validArcaeaR2Url(r2, version, sha256, r2BaseUrl)) return null;
  return { version, versionCode, fileName, fileSize, sha256, publishedAt, downloads: { github, official, ...(r2 ? { r2 } : {}) } };
}

export function parsePublicArcaeaApkManifest(value: unknown, options: { publicBaseUrl?: string } = {}): PublicArcaeaApkManifest | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if ((record.schemaVersion !== 2 && record.schemaVersion !== 3) || record.game !== "arcaea" || typeof record.generatedAt !== "string") return null;
  const latest = validEntry(record.latest, false, options.publicBaseUrl);
  const previous = record.previous === null ? null : validEntry(record.previous, true, options.publicBaseUrl);
  if (!latest || (record.previous !== null && !previous)) return null;
  if (record.schemaVersion === 3 && !latest.downloads.r2) return null;
  return { schemaVersion: record.schemaVersion, game: "arcaea", generatedAt: record.generatedAt, latest, previous };
}

export function formatPublicApkBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KiB", "MiB", "GiB"];
  let size = value;
  let unit = -1;
  do {
    size /= 1024;
    unit += 1;
  } while (size >= 1024 && unit < units.length - 1);
  return `${size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${units[unit]}`;
}

export function apkDownloadLinks(entry: PublicArcaeaApkEntry): { href: string; label: string; primary: boolean }[] {
  const primary = entry.downloads.r2 ?? entry.downloads.github;
  if (!primary) return [];
  return [{ href: primary, label: "下载", primary: true },
    ...(entry.downloads.github && entry.downloads.r2 ? [{ href: entry.downloads.github, label: "备用下载", primary: false }] : [])];
}

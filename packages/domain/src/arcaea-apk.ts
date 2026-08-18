import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ReadableStream } from "node:stream/web";
import { chromium } from "playwright";
import {
  DEFAULT_ROS_PUBLIC_BASE_URL,
  IMMUTABLE_OBJECT_CACHE_CONTROL,
  publicObjectUrl,
  StorageError,
  type StorageClient,
  type StorageHead,
  type StorageObjectBody,
} from "./storage.js";

export const ARCAEA_SOURCE_PAGE = "https://arcaea.lowiro.com/zh";
export const ARCAEA_OFFICIAL_CDN_HOST = "arcaea-static.lowiro-cdn.net";
export const ARCAEA_APK_CONTENT_TYPE = "application/vnd.android.package-archive";
export const ARCAEA_APK_LATEST_KEY = "apk/arcaea/latest.json";
export const ARCAEA_APK_RELEASE_PREFIX = "apk/arcaea/releases";
export const ARCAEA_APK_MIN_SIZE_BYTES = 1024 * 1024;
export const ARCAEA_APK_MAX_SIZE_BYTES = 2 * 1024 * 1024 * 1024;
export const ARCAEA_LATEST_CACHE_CONTROL = "public, max-age=300";

const ARCAEA_VERSION_PATTERN = /^(\d+\.\d+\.\d+)([a-z]?)$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/iu;
const ARCAEA_APK_UPLOAD_LOG_INTERVAL_BYTES = 128 * 1024 * 1024;

export type ArcaeaDiscovery = {
  version: string;
  officialFilename: string;
  sourceUrl: string;
  sourceHost: typeof ARCAEA_OFFICIAL_CDN_HOST;
  discoveredAt: string;
};

export type ArcaeaApkManifestEntry = {
  version: string;
  versionCode: number | null;
  fileName: string;
  fileSize: number;
  sha256: string;
  url: string;
  publishedAt: string;
};

export type ArcaeaApkManifest = {
  schemaVersion: 1;
  game: "arcaea";
  generatedAt: string;
  latest: ArcaeaApkManifestEntry;
  previous: ArcaeaApkManifestEntry | null;
};

export type ArcaeaApkValidation = {
  filePath: string;
  fileSize: number;
  sha256: string;
  zipEntryCount: number;
  hasAndroidManifest: true;
};

type ArcaeaApkBinaryMetadata = Pick<ArcaeaApkValidation, "fileSize" | "sha256">;

export type ArcaeaUpdateResult = {
  status: "checked" | "no-update" | "published" | "blocked-version-regression";
  discovered: ArcaeaDiscovery;
  previousManifest: ArcaeaApkManifest | null;
  manifest?: ArcaeaApkManifest;
  objectKey?: string;
  uploaded: boolean;
  reusedRemote: boolean;
  cleanupWarning?: string;
};

type FetchLike = typeof fetch;

export function canonicalArcaeaVersion(value: string): string | undefined {
  const match = value.trim().match(ARCAEA_VERSION_PATTERN);
  if (!match) return undefined;
  const numeric = match[1]!.split(".").map((part) => String(Number.parseInt(part, 10)));
  return `${numeric.join(".")}${match[2]!.toLowerCase()}`;
}

function parsedVersion(value: string): { numbers: number[]; suffix: string; canonical: string } {
  const canonical = canonicalArcaeaVersion(value);
  if (!canonical) throw new Error(`Invalid Arcaea version: ${value}`);
  const match = canonical.match(ARCAEA_VERSION_PATTERN)!;
  return {
    numbers: match[1]!.split(".").map((part) => Number.parseInt(part, 10)),
    suffix: match[2]!.toLowerCase(),
    canonical,
  };
}

/**
 * Deliberately small comparator for the versions currently used by Arcaea.
 * It rejects unknown formats instead of silently guessing an ordering.
 */
export function compareArcaeaVersion(left: string, right: string): number {
  const a = parsedVersion(left);
  const b = parsedVersion(right);
  const length = Math.max(a.numbers.length, b.numbers.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0);
    if (difference !== 0) return difference;
  }
  const suffixDifference = (a.suffix ? a.suffix.charCodeAt(0) - 96 : 0) - (b.suffix ? b.suffix.charCodeAt(0) - 96 : 0);
  if (suffixDifference !== 0) return suffixDifference;
  return 0;
}

export function arcaeaVersionFromOfficialFilename(filename: string): string | undefined {
  const normalized = filename.replace(/\\/gu, "/").split("/").at(-1) ?? filename;
  const match = normalized.match(/(?:arcaea|arc)[_-]?(\d+\.\d+\.\d+[a-z]?)\.apk$/iu)
    ?? normalized.match(/(\d+\.\d+\.\d+[a-z]?)\.apk$/iu);
  return match ? canonicalArcaeaVersion(match[1]!) : undefined;
}

function filenameFromOfficialUrl(url: URL): string {
  const queryFilename = url.searchParams.get("filename");
  const candidate = queryFilename ?? url.pathname.split("/").at(-1) ?? "";
  const decoded = decodeURIComponent(candidate);
  const basename = decoded.replace(/\\/gu, "/").split("/").at(-1) ?? "";
  if (!basename || /[\u0000-\u001f\u007f]/u.test(basename)) throw new Error("Official Arcaea APK filename is invalid.");
  return basename;
}

export function canonicalArcaeaApkFilename(version: string): string {
  const canonical = canonicalArcaeaVersion(version);
  if (!canonical) throw new Error(`Invalid Arcaea version: ${version}`);
  return `Arcaea_${canonical}.apk`;
}

export function arcaeaReleaseObjectKey(version: string): string {
  const canonical = canonicalArcaeaVersion(version);
  if (!canonical) throw new Error(`Invalid Arcaea version: ${version}`);
  return `${ARCAEA_APK_RELEASE_PREFIX}/${canonical}/${canonicalArcaeaApkFilename(canonical)}`;
}

export function assertOfficialArcaeaApkUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value, ARCAEA_SOURCE_PAGE);
  } catch {
    throw new Error("Official Arcaea APK URL is invalid.");
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== ARCAEA_OFFICIAL_CDN_HOST || url.username || url.password || url.port) {
    throw new Error("Arcaea APK URL is outside the allowed official CDN.");
  }
  return url;
}

function versionFromPageText(value: string | null): string | undefined {
  if (!value) return undefined;
  const candidate = value.replace(/^\s*版本\s*/iu, "").trim();
  return canonicalArcaeaVersion(candidate);
}

export async function discoverArcaeaApk(): Promise<ArcaeaDiscovery> {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();
    await page.goto(ARCAEA_SOURCE_PAGE, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const links = page.locator(`a[href*='${ARCAEA_OFFICIAL_CDN_HOST}']`);
    await page.waitForSelector(`a[href*='${ARCAEA_OFFICIAL_CDN_HOST}']`, { timeout: 20_000 });
    let sourceUrl: URL | undefined;
    let officialFilename = "";
    for (let index = 0; index < await links.count(); index += 1) {
      const href = await links.nth(index).getAttribute("href");
      if (!href) continue;
      try {
        const candidateUrl = assertOfficialArcaeaApkUrl(new URL(href, ARCAEA_SOURCE_PAGE).toString());
        const candidateFilename = filenameFromOfficialUrl(candidateUrl);
        if (!/\.apk$/iu.test(candidateFilename)) continue;
        sourceUrl = candidateUrl;
        officialFilename = candidateFilename;
        break;
      } catch {
        continue;
      }
    }
    if (!sourceUrl || !officialFilename) throw new Error("Official Arcaea APK link was not found.");
    const pageVersion = versionFromPageText(await page.locator(".version").first().textContent().catch(() => null));
    const filenameVersion = arcaeaVersionFromOfficialFilename(officialFilename);
    let version = pageVersion ?? filenameVersion;
    if (pageVersion && filenameVersion && compareArcaeaVersion(pageVersion, filenameVersion) !== 0) {
      const pageParts = parsedVersion(pageVersion);
      const filenameParts = parsedVersion(filenameVersion);
      const numericPartsMatch = pageParts.numbers.length === filenameParts.numbers.length && pageParts.numbers.every((value, index) => value === filenameParts.numbers[index]);
      if (numericPartsMatch && !pageParts.suffix && Boolean(filenameParts.suffix)) {
        version = filenameVersion;
      } else {
        throw new Error(`Official page version ${pageVersion} does not match APK filename version ${filenameVersion}.`);
      }
    }
    if (!version) throw new Error("Could not determine the official Arcaea APK version.");
    return {
      version,
      officialFilename,
      sourceUrl: sourceUrl.toString(),
      sourceHost: ARCAEA_OFFICIAL_CDN_HOST,
      discoveredAt: new Date().toISOString(),
    };
  } finally {
    await browser.close();
  }
}

function readableFromBody(body: unknown): Readable {
  if (body instanceof Uint8Array) return Readable.from([body]);
  if (typeof body === "string") return Readable.from([body]);
  if (body && typeof body === "object" && Symbol.asyncIterator in body) {
    return Readable.from(body as AsyncIterable<Uint8Array | string>);
  }
  if (body && typeof body === "object" && "transformToByteArray" in body && typeof body.transformToByteArray === "function") {
    const transformToByteArray = (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray;
    return Readable.from((async function* () {
      yield await transformToByteArray.call(body);
    })());
  }
  throw new Error("Downloaded body is empty or not streamable.");
}

async function bodyToBuffer(body: unknown): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of readableFromBody(body)) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function bodyToText(body: unknown): Promise<string> {
  return (await bodyToBuffer(body)).toString("utf8");
}

export async function downloadOfficialArcaeaApk(discovery: ArcaeaDiscovery, directory: string, fetchImpl: FetchLike = fetch): Promise<string> {
  const sourceUrl = assertOfficialArcaeaApkUrl(discovery.sourceUrl);
  const canonicalFilename = canonicalArcaeaApkFilename(discovery.version);
  const destination = path.resolve(directory, canonicalFilename);
  const partial = `${destination}.part`;
  await mkdir(directory, { recursive: true });
  await rm(partial, { force: true });
  const response = await fetchImpl(sourceUrl, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Official Arcaea APK download failed: ${response.status} ${response.statusText}`);
  const finalUrl = assertOfficialArcaeaApkUrl(response.url || sourceUrl.toString());
  if (finalUrl.hostname.toLowerCase() !== ARCAEA_OFFICIAL_CDN_HOST) throw new Error("Official Arcaea APK redirect left the allowed CDN.");
  try {
    await pipeline(Readable.fromWeb(response.body as unknown as ReadableStream<any>), createWriteStream(partial, { flags: "w" }));
    await rename(partial, destination);
    return destination;
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

async function inspectZipArchive(filePath: string): Promise<{ entryCount: number; hasAndroidManifest: boolean }> {
  const handle = await open(filePath, "r");
  try {
    const fileSize = (await handle.stat()).size;
    const tailLength = Math.min(fileSize, 22 + 0xffff);
    const tailBuffer = Buffer.alloc(tailLength);
    const tailResult = await handle.read(tailBuffer, 0, tailLength, fileSize - tailLength);
    const tail = tailBuffer.subarray(0, tailResult.bytesRead);
    let eocdOffset = -1;
    for (let index = tail.length - 22; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) === 0x06054b50) {
        eocdOffset = index;
        break;
      }
    }
    if (eocdOffset < 0 || eocdOffset + 22 > tail.length) throw new Error("APK is not a readable ZIP archive.");
    const commentLength = tail.readUInt16LE(eocdOffset + 20);
    if (eocdOffset + 22 + commentLength > tail.length) throw new Error("APK ZIP end record is truncated.");
    const centralDirectorySize = tail.readUInt32LE(eocdOffset + 12);
    const centralDirectoryOffset = tail.readUInt32LE(eocdOffset + 16);
    if (centralDirectorySize === 0xffffffff || centralDirectoryOffset === 0xffffffff) throw new Error("ZIP64 APK archives are not supported by the lightweight validator.");
    if (centralDirectorySize <= 0 || centralDirectoryOffset + centralDirectorySize > fileSize) throw new Error("APK ZIP central directory is invalid.");
    const central = Buffer.alloc(centralDirectorySize);
    const centralResult = await handle.read(central, 0, centralDirectorySize, centralDirectoryOffset);
    if (centralResult.bytesRead !== centralDirectorySize) throw new Error("APK ZIP central directory is truncated.");
    const entries: string[] = [];
    let offset = 0;
    while (offset < central.length) {
      if (offset + 46 > central.length || central.readUInt32LE(offset) !== 0x02014b50) throw new Error("APK ZIP central directory entry is invalid.");
      const nameLength = central.readUInt16LE(offset + 28);
      const extraLength = central.readUInt16LE(offset + 30);
      const entryCommentLength = central.readUInt16LE(offset + 32);
      const end = offset + 46 + nameLength + extraLength + entryCommentLength;
      if (end > central.length) throw new Error("APK ZIP central directory entry is truncated.");
      entries.push(central.subarray(offset + 46, offset + 46 + nameLength).toString("utf8"));
      offset = end;
    }
    if (entries.length === 0) throw new Error("APK ZIP archive has no entries.");
    return { entryCount: entries.length, hasAndroidManifest: entries.includes("AndroidManifest.xml") };
  } finally {
    await handle.close();
  }
}

export async function sha256ArcaeaApkFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

export async function validateArcaeaApk(filePath: string, options: { expectedVersion?: string; minimumSizeBytes?: number; maximumSizeBytes?: number } = {}): Promise<ArcaeaApkValidation> {
  const absolutePath = path.resolve(filePath);
  const fileStats = await stat(absolutePath).catch(() => undefined);
  if (!fileStats?.isFile()) throw new Error("APK file does not exist.");
  const minimumSizeBytes = options.minimumSizeBytes ?? ARCAEA_APK_MIN_SIZE_BYTES;
  const maximumSizeBytes = options.maximumSizeBytes ?? ARCAEA_APK_MAX_SIZE_BYTES;
  if (fileStats.size <= 0 || fileStats.size < minimumSizeBytes || fileStats.size > maximumSizeBytes) throw new Error(`APK size is outside the allowed range: ${fileStats.size} bytes.`);
  if (options.expectedVersion && path.basename(absolutePath) !== canonicalArcaeaApkFilename(options.expectedVersion)) throw new Error("APK filename is not the canonical Arcaea filename.");
  if (await stat(`${absolutePath}.part`).catch(() => undefined)) throw new Error("APK partial file still exists.");
  const archive = await inspectZipArchive(absolutePath);
  if (!archive.hasAndroidManifest) throw new Error("APK does not contain AndroidManifest.xml.");
  return {
    filePath: absolutePath,
    fileSize: fileStats.size,
    sha256: await sha256ArcaeaApkFile(absolutePath),
    zipEntryCount: archive.entryCount,
    hasAndroidManifest: true,
  };
}

function publicOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Arcaea ROS public base URL must be an HTTPS origin.");
  return url.origin;
}

export function assertArcaeaPublicApkUrl(value: string, publicBaseUrl = DEFAULT_ROS_PUBLIC_BASE_URL): URL {
  let url: URL;
  try {
    url = new URL(value);
    if (url.origin !== publicOrigin(publicBaseUrl) || url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("unexpected public origin");
  } catch {
    throw new Error("Arcaea APK URL is outside the configured ROS public origin.");
  }
  return url;
}

function validManifestEntry(value: unknown, publicBaseUrl: string): ArcaeaApkManifestEntry | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const version = typeof record.version === "string" ? canonicalArcaeaVersion(record.version) : undefined;
  const expectedFilename = version ? canonicalArcaeaApkFilename(version) : "";
  const fileName = record.fileName;
  const fileSize = record.fileSize;
  const sha256 = typeof record.sha256 === "string" ? record.sha256.toLowerCase() : "";
  const url = typeof record.url === "string" ? record.url : "";
  const publishedAt = typeof record.publishedAt === "string" ? record.publishedAt : "";
  const versionCode = record.versionCode === null ? null : typeof record.versionCode === "number" && Number.isSafeInteger(record.versionCode) && record.versionCode >= 0 ? record.versionCode : undefined;
  if (!version || fileName !== expectedFilename || typeof fileSize !== "number" || !Number.isSafeInteger(fileSize) || fileSize <= 0 || !SHA256_PATTERN.test(sha256) || !publishedAt || versionCode === undefined) return null;
  try {
    const parsedUrl = assertArcaeaPublicApkUrl(url, publicBaseUrl);
    const expectedPath = `/${arcaeaReleaseObjectKey(version)}`;
    if (parsedUrl.pathname !== expectedPath) return null;
  } catch {
    return null;
  }
  return { version, versionCode, fileName, fileSize, sha256, url, publishedAt };
}

export function parseArcaeaApkManifest(value: unknown, options: { publicBaseUrl?: string } = {}): ArcaeaApkManifest | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.game !== "arcaea" || typeof record.generatedAt !== "string" || !record.latest) return null;
  const publicBaseUrl = options.publicBaseUrl ?? DEFAULT_ROS_PUBLIC_BASE_URL;
  try {
    publicOrigin(publicBaseUrl);
  } catch {
    return null;
  }
  const latest = validManifestEntry(record.latest, publicBaseUrl);
  if (!latest) return null;
  const previous = record.previous === null ? null : validManifestEntry(record.previous, publicBaseUrl);
  if (record.previous !== null && !previous) return null;
  if (previous && compareArcaeaVersion(previous.version, latest.version) >= 0) return null;
  return { schemaVersion: 1, game: "arcaea", generatedAt: record.generatedAt, latest, previous };
}

export async function readArcaeaApkManifest(storage: StorageClient): Promise<ArcaeaApkManifest | null> {
  try {
    const output = await storage.getObject(ARCAEA_APK_LATEST_KEY);
    const parsed = parseArcaeaApkManifest(JSON.parse(await bodyToText(output.Body)), { publicBaseUrl: storage.publicBaseUrl });
    if (!parsed) throw new Error("ROS latest.json has an invalid Arcaea APK schema.");
    return parsed;
  } catch (error) {
    if (error instanceof StorageError && error.notFound) return null;
    if (error instanceof SyntaxError) throw new Error("ROS latest.json is not valid JSON.");
    throw error;
  }
}

function createManifestEntry(input: { version: string; fileSize: number; sha256: string; publicBaseUrl: string; publishedAt: string }): ArcaeaApkManifestEntry {
  const fileName = canonicalArcaeaApkFilename(input.version);
  const url = publicObjectUrl(arcaeaReleaseObjectKey(input.version), input.publicBaseUrl);
  assertArcaeaPublicApkUrl(url, input.publicBaseUrl);
  return {
    version: canonicalArcaeaVersion(input.version)!,
    versionCode: null,
    fileName,
    fileSize: input.fileSize,
    sha256: input.sha256.toLowerCase(),
    url,
    publishedAt: input.publishedAt,
  };
}

function createArcaeaApkManifest(input: { discovery: ArcaeaDiscovery; validation: ArcaeaApkBinaryMetadata; previous: ArcaeaApkManifest | null; publicBaseUrl: string; now: string }): ArcaeaApkManifest {
  return {
    schemaVersion: 1,
    game: "arcaea",
    generatedAt: input.now,
    latest: createManifestEntry({ version: input.discovery.version, fileSize: input.validation.fileSize, sha256: input.validation.sha256, publicBaseUrl: input.publicBaseUrl, publishedAt: input.now }),
    previous: input.previous?.latest ?? null,
  };
}

function metadataValue(metadata: StorageHead["metadata"], key: string): string | undefined {
  const expectedKey = key.toLowerCase();
  const entry = Object.entries(metadata ?? {}).find(([metadataKey]) => metadataKey.toLowerCase() === expectedKey);
  return entry?.[1];
}

async function readReusableRemoteArcaeaApk(storage: StorageClient, objectKey: string, options: { minimumSizeBytes: number; maximumSizeBytes: number }): Promise<ArcaeaApkBinaryMetadata | undefined> {
  let head: StorageHead;
  try {
    head = await storage.headObject(objectKey);
  } catch (error) {
    if (error instanceof StorageError && error.notFound) return undefined;
    throw error;
  }
  const sha256 = metadataValue(head.metadata, "sha256");
  if (!Number.isSafeInteger(head.sizeBytes) || head.sizeBytes < options.minimumSizeBytes || head.sizeBytes > options.maximumSizeBytes || !sha256 || !SHA256_PATTERN.test(sha256)) return undefined;
  return { fileSize: head.sizeBytes, sha256: sha256.toLowerCase() };
}

async function publicValidateArcaeaApk(url: string, expectedSize: number, fetchImpl: FetchLike): Promise<void> {
  const expected = new URL(url);
  const response = await fetchImpl(expected, { method: "HEAD", redirect: "follow" });
  if (!response.ok) throw new Error(`Public ROS APK validation failed: ${response.status} ${response.statusText}`);
  const finalUrl = new URL(response.url || expected.toString());
  if (finalUrl.origin !== expected.origin || finalUrl.pathname !== expected.pathname) throw new Error("Public ROS APK validation followed an unexpected redirect.");
  const contentLength = response.headers.get("content-length");
  if (!contentLength || Number.parseInt(contentLength, 10) !== expectedSize) throw new Error("Public ROS APK Content-Length does not match the verified APK.");
}

async function verifyStoredObject(storage: StorageClient, objectKey: string, validation: ArcaeaApkBinaryMetadata): Promise<void> {
  let head: StorageHead;
  try {
    head = await storage.headObject(objectKey);
  } catch (error) {
    if (error instanceof StorageError && error.notFound) throw new Error("Existing ROS Arcaea APK does not match the verified local APK.");
    throw error;
  }
  const remoteSha256 = metadataValue(head.metadata, "sha256");
  if (head.sizeBytes !== validation.fileSize || remoteSha256?.toLowerCase() !== validation.sha256.toLowerCase() || head.contentType !== ARCAEA_APK_CONTENT_TYPE) {
    throw new Error("Existing ROS Arcaea APK does not match the verified local APK.");
  }
}

function formatMiB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

function createArcaeaUploadProgressLogger(log: (message: string) => void, expectedSizeBytes: number): (progress: { loadedBytes: number; totalBytes: number }) => void {
  let lastLoggedBytes = 0;
  let lastLoggedPercent = -1;
  return ({ loadedBytes, totalBytes }) => {
    const total = totalBytes > 0 ? totalBytes : expectedSizeBytes;
    const loaded = Math.min(Math.max(loadedBytes, 0), total);
    const percent = total > 0 ? Math.min(100, Math.floor((loaded / total) * 100)) : 0;
    if (loaded < total && loaded - lastLoggedBytes < ARCAEA_APK_UPLOAD_LOG_INTERVAL_BYTES && percent < lastLoggedPercent + 5) return;
    lastLoggedBytes = loaded;
    lastLoggedPercent = percent;
    log(`[arcaea-apk] Uploading APK to ROS: ${formatMiB(loaded)} / ${formatMiB(total)} MiB (${percent}%)`);
  };
}

function isCanonicalArcaeaReleaseObjectKey(objectKey: string): boolean {
  const prefix = `${ARCAEA_APK_RELEASE_PREFIX}/`;
  if (!objectKey.startsWith(prefix)) return false;
  const segments = objectKey.slice(prefix.length).split("/");
  if (segments.length !== 2) return false;
  const version = canonicalArcaeaVersion(segments[0]!);
  return Boolean(version && objectKey === arcaeaReleaseObjectKey(version));
}

async function cleanupUnreferencedArcaeaApks(storage: StorageClient, manifest: ArcaeaApkManifest, log: (message: string) => void): Promise<string | undefined> {
  const keep = new Set([
    arcaeaReleaseObjectKey(manifest.latest.version),
    ...(manifest.previous ? [arcaeaReleaseObjectKey(manifest.previous.version)] : []),
  ]);
  let keys: string[];
  try {
    keys = await storage.listObjects(`${ARCAEA_APK_RELEASE_PREFIX}/`);
  } catch {
    const warning = "cleanup warning: could not list unreferenced Arcaea APK objects";
    log(`[arcaea-apk] ${warning}.`);
    return warning;
  }
  const warnings: string[] = [];
  for (const objectKey of keys) {
    if (!isCanonicalArcaeaReleaseObjectKey(objectKey) || keep.has(objectKey)) continue;
    try {
      await storage.deleteObject(objectKey);
    } catch {
      const warning = `could not delete ${objectKey}`;
      warnings.push(warning);
      log(`[arcaea-apk] cleanup warning: ${warning}.`);
    }
  }
  return warnings.length > 0 ? `cleanup warning: ${warnings.join("; ")}` : undefined;
}

export async function runArcaeaApkUpdate(options: {
  mode?: "check-only" | "publish";
  storage?: StorageClient;
  stagingDirectory?: string;
  discover?: () => Promise<ArcaeaDiscovery>;
  download?: (discovery: ArcaeaDiscovery, directory: string) => Promise<string>;
  fetchImpl?: FetchLike;
  publicValidate?: (url: string, expectedSize: number) => Promise<void>;
  now?: () => Date;
  minimumSizeBytes?: number;
  maximumSizeBytes?: number;
  log?: (message: string) => void;
}): Promise<ArcaeaUpdateResult> {
  const mode = options.mode ?? "publish";
  const log = options.log ?? ((message: string) => console.log(message));
  const discover = options.discover ?? discoverArcaeaApk;
  const fetchImpl = options.fetchImpl ?? fetch;
  const discovered = await discover();
  const canonicalVersion = canonicalArcaeaVersion(discovered.version);
  if (!canonicalVersion) throw new Error("Discovered Arcaea version cannot be safely stored.");
  const normalizedDiscovery: ArcaeaDiscovery = { ...discovered, version: canonicalVersion, sourceHost: ARCAEA_OFFICIAL_CDN_HOST, sourceUrl: assertOfficialArcaeaApkUrl(discovered.sourceUrl).toString() };
  log(`[arcaea-apk] Found official version ${normalizedDiscovery.version}; CDN host ${normalizedDiscovery.sourceHost}.`);
  if (mode === "check-only") return { status: "checked", discovered: normalizedDiscovery, previousManifest: null, uploaded: false, reusedRemote: false };
  const storage = options.storage;
  if (!storage || storage.status !== "READY") throw new Error("ROS credentials are not configured.");
  const previousManifest = await readArcaeaApkManifest(storage);
  if (previousManifest) {
    const comparison = compareArcaeaVersion(normalizedDiscovery.version, previousManifest.latest.version);
    if (comparison === 0) {
      log(`[arcaea-apk] Version ${normalizedDiscovery.version} is already public; no download or ROS write.`);
      return { status: "no-update", discovered: normalizedDiscovery, previousManifest, uploaded: false, reusedRemote: false };
    }
    if (comparison < 0) {
      log(`[arcaea-apk] WARNING: official version ${normalizedDiscovery.version} is older than public version ${previousManifest.latest.version}; publish stopped.`);
      return { status: "blocked-version-regression", discovered: normalizedDiscovery, previousManifest, uploaded: false, reusedRemote: false };
    }
  }

  const root = path.resolve(options.stagingDirectory ?? path.join(process.cwd(), ".runtime", "arcaea-apk-update"));
  await mkdir(root, { recursive: true });
  const runDirectory = await mkdtemp(path.join(root, "run-"));
  const objectKey = arcaeaReleaseObjectKey(normalizedDiscovery.version);
  const minimumSizeBytes = options.minimumSizeBytes ?? ARCAEA_APK_MIN_SIZE_BYTES;
  const maximumSizeBytes = options.maximumSizeBytes ?? ARCAEA_APK_MAX_SIZE_BYTES;
  let uploaded = false;
  let reusedRemote = false;
  try {
    let validation: ArcaeaApkBinaryMetadata | undefined;
    try {
      validation = await readReusableRemoteArcaeaApk(storage, objectKey, { minimumSizeBytes, maximumSizeBytes });
      if (validation) {
        reusedRemote = true;
        log("[arcaea-apk] Reusing existing verified ROS APK.");
      }
    } catch (error) {
      throw new Error(`Existing ROS Arcaea APK cannot be safely reused: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!validation) {
      log("[arcaea-apk] Downloading official APK...");
      const filePath = await (options.download ?? ((discovery, directory) => downloadOfficialArcaeaApk(discovery, directory, fetchImpl)))(normalizedDiscovery, runDirectory);
      const downloaded = await stat(filePath);
      log(`[arcaea-apk] Download complete: ${formatMiB(downloaded.size)} MiB.`);
      log("[arcaea-apk] Validating APK...");
      const localValidation = await validateArcaeaApk(filePath, { expectedVersion: normalizedDiscovery.version, minimumSizeBytes, maximumSizeBytes });
      validation = localValidation;
      log(`[arcaea-apk] Verified ${formatMiB(validation.fileSize)} MiB APK; SHA-256 ${validation.sha256}.`);
      log("[arcaea-apk] Uploading APK to ROS...");
      await storage.putLargeObject({
        objectKey,
        body: createReadStream(localValidation.filePath) as unknown as StorageObjectBody,
        sizeBytes: localValidation.fileSize,
        contentType: ARCAEA_APK_CONTENT_TYPE,
        cacheControl: IMMUTABLE_OBJECT_CACHE_CONTROL,
        contentDisposition: `attachment; filename="${canonicalArcaeaApkFilename(normalizedDiscovery.version)}"`,
        metadata: { sha256: localValidation.sha256 },
        onProgress: createArcaeaUploadProgressLogger(log, localValidation.fileSize),
      });
      uploaded = true;
      log(`[arcaea-apk] ROS APK upload complete: ${formatMiB(localValidation.fileSize)} MiB.`);
    }
    if (!validation) throw new Error("Arcaea APK metadata is unavailable after upload or reuse.");
    log("[arcaea-apk] Verifying ROS object metadata...");
    await verifyStoredObject(storage, objectKey, validation);
    log("[arcaea-apk] ROS object verification complete.");
    const publicUrl = publicObjectUrl(objectKey, storage.publicBaseUrl || DEFAULT_ROS_PUBLIC_BASE_URL);
    log("[arcaea-apk] Verifying public APK URL...");
    await (options.publicValidate ?? ((url, size) => publicValidateArcaeaApk(url, size, fetchImpl)))(publicUrl, validation.fileSize);
    const now = (options.now ?? (() => new Date()))().toISOString();
    const manifest = createArcaeaApkManifest({ discovery: normalizedDiscovery, validation, previous: previousManifest, publicBaseUrl: storage.publicBaseUrl, now });
    log("[arcaea-apk] Publishing latest.json...");
    await storage.putObject({ objectKey: ARCAEA_APK_LATEST_KEY, body: JSON.stringify(manifest, null, 2), contentType: "application/json; charset=utf-8", cacheControl: ARCAEA_LATEST_CACHE_CONTROL });
    const reloaded = await readArcaeaApkManifest(storage);
    if (!reloaded || reloaded.latest.version !== manifest.latest.version || reloaded.latest.sha256 !== manifest.latest.sha256 || reloaded.latest.fileSize !== manifest.latest.fileSize) throw new Error("ROS latest.json verification failed after publish.");
    const cleanupWarning = await cleanupUnreferencedArcaeaApks(storage, manifest, log);
    log(`[arcaea-apk] Published ${manifest.latest.version}; previous ${manifest.previous?.version ?? "none"}.`);
    return { status: "published", discovered: normalizedDiscovery, previousManifest, manifest, objectKey, uploaded, reusedRemote, ...(cleanupWarning ? { cleanupWarning } : {}) };
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
  }
}

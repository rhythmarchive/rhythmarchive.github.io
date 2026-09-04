import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ReadableStream } from "node:stream/web";
import {
  StorageError,
  type StorageClient,
} from "./storage.js";
import {
  ARCAEA_GITHUB_REPOSITORY,
  MANAGED_ARCAEA_RELEASE_TAG_PREFIX,
  createGhGitHubReleaseClient,
  type GitHubRelease,
  type GitHubReleaseAsset,
  type GitHubReleaseClient,
} from "./github-release.js";

export const ARCAEA_SOURCE_PAGE = "https://arcaea.lowiro.com/zh";
export const ARCAEA_APK_API_URL = "https://webapi.lowiro.com/webapi/serve/static/bin/arcaea/apk";
export const ARCAEA_OFFICIAL_CDN_HOST = "arcaea-static.lowiro-cdn.net";
export const ARCAEA_APK_CONTENT_TYPE = "application/vnd.android.package-archive";
export const ARCAEA_APK_LATEST_KEY = "apk/arcaea/latest.json";
export const ARCAEA_APK_MIN_SIZE_BYTES = 1024 * 1024;
export const ARCAEA_APK_MAX_SIZE_BYTES = 2 * 1024 * 1024 * 1024;
export const ARCAEA_LATEST_CACHE_CONTROL = "public, max-age=300";
export const ARCAEA_APK_GITHUB_REPOSITORY = ARCAEA_GITHUB_REPOSITORY;
export const ARCAEA_GITHUB_RELEASE_TAG_PREFIX = MANAGED_ARCAEA_RELEASE_TAG_PREFIX;

const ARCAEA_VERSION_PATTERN = /^(\d+\.\d+\.\d+)([a-z]?)$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/iu;

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
  downloads: {
    github: string;
    official: string | null;
  };
  publishedAt: string;
};

export type ArcaeaApkManifest = {
  schemaVersion: 2;
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
  status: "checked" | "no-update" | "published" | "blocked-version-regression" | "blocked-mirror-size";
  discovered: ArcaeaDiscovery;
  previousManifest: ArcaeaApkManifest | null;
  manifest?: ArcaeaApkManifest;
  releaseTag?: string;
  githubAssetUrl?: string;
  uploaded: boolean;
  reusedRemote: boolean;
  reusedReleaseAsset?: boolean;
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

function parseOfficialArcaeaApkApiResponse(value: unknown): { version: string; officialFilename: string; sourceUrl: string } {
  if (!value || typeof value !== "object") throw new Error("Official Arcaea APK API returned an invalid response.");
  const record = value as Record<string, unknown>;
  if (record.success !== true || !record.value || typeof record.value !== "object") throw new Error("Official Arcaea APK API returned an unsuccessful response.");
  const apiValue = record.value as Record<string, unknown>;
  if (typeof apiValue.url !== "string" || typeof apiValue.version !== "string") throw new Error("Official Arcaea APK API response is missing url or version.");
  const sourceUrl = assertOfficialArcaeaApkUrl(apiValue.url);
  const officialFilename = filenameFromOfficialUrl(sourceUrl);
  const filenameVersion = arcaeaVersionFromOfficialFilename(officialFilename);
  const version = canonicalArcaeaVersion(apiValue.version);
  if (!/\.apk$/iu.test(officialFilename) || !filenameVersion || !version) throw new Error("Official Arcaea APK API returned an invalid APK filename or version.");
  if (compareArcaeaVersion(version, filenameVersion) !== 0) throw new Error("Official API version " + version + " does not match APK filename version " + filenameVersion + ".");
  return { version, officialFilename, sourceUrl: sourceUrl.toString() };
}

export async function discoverArcaeaApk(fetchImpl: FetchLike = fetch): Promise<ArcaeaDiscovery> {
  const response = await fetchImpl(ARCAEA_APK_API_URL, { headers: { Accept: "application/json" }, redirect: "follow" });
  if (!response.ok) throw new Error("Official Arcaea APK API request failed: " + response.status + " " + response.statusText);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Official Arcaea APK API returned invalid JSON.");
  }
  const parsed = parseOfficialArcaeaApkApiResponse(payload);
  return {
    ...parsed,
    sourceHost: ARCAEA_OFFICIAL_CDN_HOST,
    discoveredAt: new Date().toISOString(),
  };
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

function formatMiB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

export function arcaeaGithubReleaseTag(version: string): string {
  const canonical = canonicalArcaeaVersion(version);
  if (!canonical) throw new Error(`Invalid Arcaea version: ${version}`);
  return `${ARCAEA_GITHUB_RELEASE_TAG_PREFIX}${canonical}`;
}

export function arcaeaGithubAssetUrl(version: string): string {
  const canonical = canonicalArcaeaVersion(version);
  if (!canonical) throw new Error(`Invalid Arcaea version: ${version}`);
  return `https://github.com/${ARCAEA_APK_GITHUB_REPOSITORY}/releases/download/${arcaeaGithubReleaseTag(canonical)}/${encodeURIComponent(canonicalArcaeaApkFilename(canonical))}`;
}

export function assertArcaeaGithubApkUrl(value: string, version: string): URL {
  let url: URL;
  try {
    url = new URL(value);
    const expected = new URL(arcaeaGithubAssetUrl(version));
    if (url.origin !== expected.origin || url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || url.pathname !== expected.pathname) throw new Error("unexpected GitHub asset URL");
  } catch {
    throw new Error("Arcaea GitHub APK URL is outside the managed repository release path.");
  }
  return url;
}

function validManifestEntry(value: unknown, allowMissingOfficial = false): ArcaeaApkManifestEntry | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if ("url" in record) return null;
  const version = typeof record.version === "string" ? canonicalArcaeaVersion(record.version) : undefined;
  const expectedFilename = version ? canonicalArcaeaApkFilename(version) : "";
  const fileName = record.fileName;
  const fileSize = record.fileSize;
  const sha256 = typeof record.sha256 === "string" ? record.sha256.toLowerCase() : "";
  const publishedAt = typeof record.publishedAt === "string" ? record.publishedAt : "";
  const versionCode = record.versionCode === null ? null : typeof record.versionCode === "number" && Number.isSafeInteger(record.versionCode) && record.versionCode >= 0 ? record.versionCode : undefined;
  const downloads = record.downloads;
  if (!downloads || typeof downloads !== "object") return null;
  const downloadRecord = downloads as Record<string, unknown>;
  const github = typeof downloadRecord.github === "string" ? downloadRecord.github : "";
  const official = downloadRecord.official === undefined && allowMissingOfficial ? null : downloadRecord.official === null ? null : typeof downloadRecord.official === "string" ? downloadRecord.official : undefined;
  if (!version || fileName !== expectedFilename || typeof fileSize !== "number" || !Number.isSafeInteger(fileSize) || fileSize <= 0 || !SHA256_PATTERN.test(sha256) || !publishedAt || versionCode === undefined || !github || official === undefined) return null;
  try {
    assertArcaeaGithubApkUrl(github, version);
    if (official !== null) assertOfficialArcaeaApkUrl(official);
  } catch {
    return null;
  }
  return { version, versionCode, fileName, fileSize, sha256, downloads: { github, official }, publishedAt };
}

export function parseArcaeaApkManifest(value: unknown, _options: { publicBaseUrl?: string } = {}): ArcaeaApkManifest | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 2 || record.game !== "arcaea" || typeof record.generatedAt !== "string" || !record.latest) return null;
  const latest = validManifestEntry(record.latest);
  if (!latest) return null;
  const previous = record.previous === null ? null : validManifestEntry(record.previous, true);
  if (record.previous !== null && !previous) return null;
  if (previous && compareArcaeaVersion(previous.version, latest.version) >= 0) return null;
  return { schemaVersion: 2, game: "arcaea", generatedAt: record.generatedAt, latest, previous };
}

export async function readArcaeaApkManifest(storage: StorageClient): Promise<ArcaeaApkManifest | null> {
  try {
    const output = await storage.getObject(ARCAEA_APK_LATEST_KEY);
    const parsed = parseArcaeaApkManifest(JSON.parse(await bodyToText(output.Body)));
    if (!parsed) throw new Error("ROS latest.json has an invalid Arcaea APK schema.");
    return parsed;
  } catch (error) {
    if (error instanceof StorageError && error.notFound) return null;
    if (error instanceof SyntaxError) throw new Error("ROS latest.json is not valid JSON.");
    throw error;
  }
}

function createManifestEntry(input: { version: string; fileSize: number; sha256: string; githubUrl: string; officialUrl: string; publishedAt: string }): ArcaeaApkManifestEntry {
  const canonical = canonicalArcaeaVersion(input.version);
  if (!canonical) throw new Error(`Invalid Arcaea version: ${input.version}`);
  const fileName = canonicalArcaeaApkFilename(canonical);
  const github = assertArcaeaGithubApkUrl(input.githubUrl, canonical).toString();
  const official = assertOfficialArcaeaApkUrl(input.officialUrl).toString();
  return {
    version: canonical,
    versionCode: null,
    fileName,
    fileSize: input.fileSize,
    sha256: input.sha256.toLowerCase(),
    downloads: { github, official },
    publishedAt: input.publishedAt,
  };
}

function createArcaeaApkManifest(input: { discovery: ArcaeaDiscovery; validation: ArcaeaApkBinaryMetadata; previous: ArcaeaApkManifest | null; githubUrl: string; now: string }): ArcaeaApkManifest {
  return {
    schemaVersion: 2,
    game: "arcaea",
    generatedAt: input.now,
    latest: createManifestEntry({ version: input.discovery.version, fileSize: input.validation.fileSize, sha256: input.validation.sha256, githubUrl: input.githubUrl, officialUrl: input.discovery.sourceUrl, publishedAt: input.now }),
    previous: input.previous?.latest ?? null,
  };
}

function releaseAssetDigestMatches(asset: GitHubReleaseAsset, expectedSha256: string): boolean {
  if (asset.digest === undefined || asset.digest === null) return true;
  const digest = asset.digest.toLowerCase().replace(/^sha256:/u, "");
  return SHA256_PATTERN.test(digest) && digest === expectedSha256.toLowerCase();
}

function managedArcaeaRelease(release: GitHubRelease, version: string): boolean {
  return release.tagName === arcaeaGithubReleaseTag(version) && release.name === `Arcaea APK ${canonicalArcaeaVersion(version)}`;
}

function verifiedGithubAssetUrl(asset: GitHubReleaseAsset, version: string): string {
  const fallback = arcaeaGithubAssetUrl(version);
  if (!asset.browserDownloadUrl) return fallback;
  return assertArcaeaGithubApkUrl(asset.browserDownloadUrl, version).toString();
}

async function ensureGithubReleaseAsset(input: { client: GitHubReleaseClient; version: string; validation: ArcaeaApkBinaryMetadata; filePath: string; log: (message: string) => void }): Promise<{ uploaded: boolean; reused: boolean; assetUrl: string }> {
  const tagName = arcaeaGithubReleaseTag(input.version);
  const title = `Arcaea APK ${canonicalArcaeaVersion(input.version)}`;
  const fileName = canonicalArcaeaApkFilename(input.version);
  let release = await input.client.getRelease(tagName);
  if (!release) {
    release = await input.client.createRelease({ tagName, title });
  }
  if (!managedArcaeaRelease(release, input.version)) throw new Error("Existing GitHub Release is not managed by the Arcaea updater.");
  let asset = release.assets.find((candidate) => candidate.name === fileName);
  if (asset && asset.size === input.validation.fileSize && releaseAssetDigestMatches(asset, input.validation.sha256)) {
    input.log("[arcaea-apk] Reusing existing verified GitHub Release asset.");
    input.log("[arcaea-apk] GitHub Release asset verified.");
    return { uploaded: false, reused: true, assetUrl: verifiedGithubAssetUrl(asset, input.version) };
  }
  if (asset) await input.client.deleteAsset({ releaseId: release.id, assetId: asset.id });
  input.log("[arcaea-apk] Uploading APK to GitHub Release...");
  await input.client.uploadAsset({ tagName, filePath: input.filePath, fileName });
  release = await input.client.getRelease(tagName);
  if (!release || !managedArcaeaRelease(release, input.version)) throw new Error("GitHub Release could not be verified after APK upload.");
  asset = release.assets.find((candidate) => candidate.name === fileName);
  if (!asset || asset.size !== input.validation.fileSize || !releaseAssetDigestMatches(asset, input.validation.sha256)) throw new Error("GitHub Release asset metadata does not match the verified APK.");
  input.log("[arcaea-apk] GitHub Release asset verified.");
  return { uploaded: true, reused: false, assetUrl: verifiedGithubAssetUrl(asset, input.version) };
}

async function deleteThirdOldestManagedRelease(input: { client: GitHubReleaseClient; previous: ArcaeaApkManifest | null; log: (message: string) => void }): Promise<string | undefined> {
  const obsolete = input.previous?.previous;
  if (!obsolete) return undefined;
  const tagName = arcaeaGithubReleaseTag(obsolete.version);
  try {
    const release = await input.client.getRelease(tagName);
    if (!release) return undefined;
    if (!managedArcaeaRelease(release, obsolete.version) || !release.tagName.startsWith(MANAGED_ARCAEA_RELEASE_TAG_PREFIX)) {
      const warning = `cleanup warning: refusing to delete unmanaged GitHub Release ${tagName}`;
      input.log(`[arcaea-apk] ${warning}.`);
      return warning;
    }
    await input.client.deleteRelease({ releaseId: release.id, tagName });
    input.log(`[arcaea-apk] Deleted old managed GitHub Release ${tagName}.`);
    return undefined;
  } catch {
    const warning = `cleanup warning: could not delete managed GitHub Release ${tagName}`;
    input.log(`[arcaea-apk] ${warning}.`);
    return warning;
  }
}

export async function runArcaeaApkUpdate(options: {
  mode?: "check-only" | "publish";
  storage?: StorageClient;
  stagingDirectory?: string;
  discover?: () => Promise<ArcaeaDiscovery>;
  download?: (discovery: ArcaeaDiscovery, directory: string) => Promise<string>;
  fetchImpl?: FetchLike;
  releaseClient?: GitHubReleaseClient;
  validate?: (filePath: string, options?: { expectedVersion?: string; minimumSizeBytes?: number; maximumSizeBytes?: number }) => Promise<ArcaeaApkValidation>;
  now?: () => Date;
  minimumSizeBytes?: number;
  maximumSizeBytes?: number;
  log?: (message: string) => void;
}): Promise<ArcaeaUpdateResult> {
  const mode = options.mode ?? "publish";
  const log = options.log ?? ((message: string) => console.log(message));
  const fetchImpl = options.fetchImpl ?? fetch;
  const discover = options.discover ?? (() => discoverArcaeaApk(fetchImpl));
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
  const minimumSizeBytes = options.minimumSizeBytes ?? ARCAEA_APK_MIN_SIZE_BYTES;
  const maximumSizeBytes = options.maximumSizeBytes ?? ARCAEA_APK_MAX_SIZE_BYTES;
  let uploaded = false;
  let reusedReleaseAsset = false;
  try {
    log("[arcaea-apk] Downloading official APK...");
    const filePath = await (options.download ?? ((discovery, directory) => downloadOfficialArcaeaApk(discovery, directory, fetchImpl)))(normalizedDiscovery, runDirectory);
    const downloaded = await stat(filePath);
    log(`[arcaea-apk] Download complete: ${formatMiB(downloaded.size)} MiB.`);
    log("[arcaea-apk] Validating APK...");
    const validation = await (options.validate ?? validateArcaeaApk)(filePath, { expectedVersion: normalizedDiscovery.version, minimumSizeBytes, maximumSizeBytes });
    log(`[arcaea-apk] Verified ${formatMiB(validation.fileSize)} MiB APK; SHA-256 ${validation.sha256}.`);
    if (validation.fileSize >= ARCAEA_APK_MAX_SIZE_BYTES) {
      log("[arcaea-apk] Arcaea APK exceeds GitHub Release asset size limit.");
      return { status: "blocked-mirror-size", discovered: normalizedDiscovery, previousManifest, uploaded: false, reusedRemote: false };
    }

    const releaseClient = options.releaseClient ?? createGhGitHubReleaseClient(ARCAEA_APK_GITHUB_REPOSITORY);
    log("[arcaea-apk] Creating/Reusing GitHub Release...");
    const release = await ensureGithubReleaseAsset({ client: releaseClient, version: normalizedDiscovery.version, validation, filePath: validation.filePath, log });
    uploaded = release.uploaded;
    reusedReleaseAsset = release.reused;
    const now = (options.now ?? (() => new Date()))().toISOString();
    const manifest = createArcaeaApkManifest({ discovery: normalizedDiscovery, validation, previous: previousManifest, githubUrl: release.assetUrl, now });
    log("[arcaea-apk] Publishing latest.json...");
    await storage.putObject({ objectKey: ARCAEA_APK_LATEST_KEY, body: JSON.stringify(manifest, null, 2), contentType: "application/json; charset=utf-8", cacheControl: ARCAEA_LATEST_CACHE_CONTROL });
    const reloaded = await readArcaeaApkManifest(storage);
    if (!reloaded || reloaded.latest.version !== manifest.latest.version || reloaded.latest.sha256 !== manifest.latest.sha256 || reloaded.latest.fileSize !== manifest.latest.fileSize || reloaded.latest.downloads.github !== manifest.latest.downloads.github || reloaded.latest.downloads.official !== manifest.latest.downloads.official) throw new Error("ROS latest.json verification failed after publish.");
    const cleanupWarning = await deleteThirdOldestManagedRelease({ client: releaseClient, previous: previousManifest, log });
    log(`[arcaea-apk] Published ${manifest.latest.version}; previous ${manifest.previous?.version ?? "none"}.`);
    return { status: "published", discovered: normalizedDiscovery, previousManifest, manifest, releaseTag: arcaeaGithubReleaseTag(normalizedDiscovery.version), githubAssetUrl: manifest.latest.downloads.github, uploaded, reusedRemote: reusedReleaseAsset, reusedReleaseAsset, ...(cleanupWarning ? { cleanupWarning } : {}) };
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
  }
}

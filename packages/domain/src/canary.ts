import { readFile } from "node:fs/promises";
import { IMMUTABLE_OBJECT_CACHE_CONTROL, publicObjectUrl, StorageError, type StorageClient } from "./storage.js";
import type { Catalog as CatalogType } from "./schema.js";

export type RosCanarySample = {
  objectKey: string;
  sizeBytes: number;
  mime: string;
  body?: Uint8Array;
  label?: string;
  publicRead?: boolean;
};

export type RosCanaryResult = {
  status: "NOT_CONFIGURED" | "READY" | "PASS_WITH_WARNINGS" | "BLOCKED";
  code?: "ROS_NOT_CONFIGURED" | "NO_SAMPLES" | "PUT_FAILED" | "HEAD_FAILED" | "CONTENT_LENGTH_MISMATCH" | "PUBLIC_READ_FAILED" | "CORS_NOT_AVAILABLE" | "CANARY_FAILED";
  selected: number;
  put: number;
  head: number;
  publicRead: number;
  contentLength: "NOT_RUN" | "OK" | "MISMATCH";
  cacheControl: "NOT_RUN" | "OK" | "MISMATCH";
  cacheControlValue?: string;
  cors: "NOT_RUN" | "AVAILABLE" | "CORS_NOT_AVAILABLE";
  range: "NOT_RUN" | "AVAILABLE" | "NOT_AVAILABLE";
  rangeStatus?: number;
  rangeContentRange?: string;
  duplicateCheck: "NOT_RUN" | "OK" | "EXISTING" | "FAILED";
  cleanup: "NOT_RUN" | "OK" | "WARNING";
  cleanupObjectKey?: string;
  warnings: string[];
  details: Array<{ objectKey: string; status: "skipped" | "put-head" | "head-only" | "public-read"; message: string }>;
};

export type RosCanaryOptions = {
  storage: StorageClient;
  samples: RosCanarySample[];
  publicFetch?: (url: string) => Promise<{ ok: boolean; status: number; headers: Headers }>;
  rangeFetch?: (url: string) => Promise<{ ok: boolean; status: number; headers: Headers }>;
  maxSamples?: number;
  cacheControl?: string;
  cleanupAfter?: boolean;
  corsOrigin?: string;
};

export function selectCanarySamples(catalog: CatalogType, maxSamples = 16): RosCanarySample[] {
  const renditionByObject = new Map<string, string[]>();
  for (const rendition of catalog.renditions) renditionByObject.set(rendition.objectId, [...(renditionByObject.get(rendition.objectId) ?? []), rendition.renditionType]);
  const ranked = [...catalog.objects].map((object) => {
    const types = renditionByObject.get(object.id) ?? [];
    const score = (types.includes("original") ? 50 : 0) + (types.includes("upscaled") ? 40 : 0) + (types.some((type) => type.startsWith("thumbnail")) ? 30 : 0) + (object.mime === "image/png" ? 10 : object.mime === "image/jpeg" ? 5 : 0);
    return { object, score, types };
  }).sort((left, right) => right.score - left.score || left.object.objectKey.localeCompare(right.object.objectKey));
  const selected = ranked.slice(0, Math.min(20, Math.max(1, maxSamples)));
  const publicReadIds = new Set(selected
    .filter(({ object, types }) => object.sizeBytes <= 1024 * 1024 && types.some((type) => type.startsWith("thumbnail")))
    .slice(0, 2)
    .map(({ object }) => object.id));
  return selected.map(({ object }) => ({ objectKey: object.objectKey, sizeBytes: object.sizeBytes, mime: object.mime, label: object.objectKey, publicRead: publicReadIds.has(object.id) }));
}

export async function runRosCanary(options: RosCanaryOptions): Promise<RosCanaryResult> {
  if (options.storage.status !== "READY") return {
    status: "NOT_CONFIGURED",
    code: "ROS_NOT_CONFIGURED",
    selected: 0,
    put: 0,
    head: 0,
    publicRead: 0,
    contentLength: "NOT_RUN",
    cacheControl: "NOT_RUN",
    cors: "NOT_RUN",
    range: "NOT_RUN",
    duplicateCheck: "NOT_RUN",
    cleanup: "NOT_RUN",
    warnings: [],
    details: [],
  };
  const samples = options.samples.slice(0, Math.min(20, Math.max(1, options.maxSamples ?? 16)));
  if (samples.length === 0) return {
    status: "BLOCKED",
    code: "NO_SAMPLES",
    selected: 0,
    put: 0,
    head: 0,
    publicRead: 0,
    contentLength: "NOT_RUN",
    cacheControl: "NOT_RUN",
    cors: "NOT_RUN",
    range: "NOT_RUN",
    duplicateCheck: "NOT_RUN",
    cleanup: "NOT_RUN",
    warnings: [],
    details: [],
  };
  const details: RosCanaryResult["details"] = [];
  const warnings = new Set<string>();
  let put = 0;
  let head = 0;
  let publicRead = 0;
  let contentLength: RosCanaryResult["contentLength"] = "NOT_RUN";
  let cacheControl: RosCanaryResult["cacheControl"] = "NOT_RUN";
  let cacheControlValue: string | undefined;
  let cors: RosCanaryResult["cors"] = "NOT_RUN";
  let range: RosCanaryResult["range"] = "NOT_RUN";
  let rangeStatus: number | undefined;
  let rangeContentRange: string | undefined;
  let duplicateCheck: RosCanaryResult["duplicateCheck"] = "NOT_RUN";
  let cleanup: RosCanaryResult["cleanup"] = "NOT_RUN";
  let cleanupObjectKey: string | undefined;
  let failureCode: RosCanaryResult["code"];
  const expectedCacheControl = options.cacheControl ?? IMMUTABLE_OBJECT_CACHE_CONTROL;
  const corsOrigin = options.corsOrigin ?? "https://example.com";

  const result = (status: RosCanaryResult["status"]): RosCanaryResult => ({
    status,
    ...(failureCode ? { code: failureCode } : warnings.has("CORS_NOT_CONFIGURED") ? { code: "CORS_NOT_AVAILABLE" as const } : {}),
    selected: samples.length,
    put,
    head,
    publicRead,
    contentLength,
    cacheControl,
    ...(cacheControlValue ? { cacheControlValue } : {}),
    cors,
    range,
    ...(rangeStatus !== undefined ? { rangeStatus } : {}),
    ...(rangeContentRange ? { rangeContentRange } : {}),
    duplicateCheck,
    cleanup,
    ...(cleanupObjectKey ? { cleanupObjectKey } : {}),
    warnings: [...warnings],
    details,
  });

  for (const sample of samples) {
    const cleanupRequested = options.cleanupAfter === true;
    const cleanupAllowed = sample.objectKey.startsWith("_canary/");
    let stage: "put" | "head" | "duplicate" | "public-read" = "put";
    try {
      if (cleanupRequested && !cleanupAllowed) {
        warnings.add("CLEANUP_KEY_NOT_ALLOWED");
        cleanup = "WARNING";
        cleanupObjectKey = sample.objectKey;
      }
      const exists = await options.storage.objectExists(sample.objectKey);
      if (!exists && sample.body) {
        await options.storage.putObject({ objectKey: sample.objectKey, body: sample.body, sizeBytes: sample.sizeBytes, contentType: sample.mime, cacheControl: expectedCacheControl });
        put += 1;
        stage = "head";
        const headResult = await options.storage.headObject(sample.objectKey);
        head += 1;
        contentLength = headResult.sizeBytes === sample.sizeBytes ? "OK" : "MISMATCH";
        if (contentLength !== "OK") {
          failureCode = "CONTENT_LENGTH_MISMATCH";
          throw new StorageError("VERIFY_FAILED", "ROS canary Content-Length mismatch.");
        }
        cacheControlValue = headResult.cacheControl;
        cacheControl = headResult.cacheControl === expectedCacheControl ? "OK" : "MISMATCH";
        if (cacheControl !== "OK") warnings.add("CACHE_CONTROL_MISMATCH");
        details.push({ objectKey: sample.objectKey, status: "put-head", message: "PUT and HEAD verified" });
      } else if (exists) {
        stage = "head";
        const headResult = await options.storage.headObject(sample.objectKey);
        head += 1;
        contentLength = headResult.sizeBytes === sample.sizeBytes ? "OK" : "MISMATCH";
        if (contentLength !== "OK") {
          failureCode = "CONTENT_LENGTH_MISMATCH";
          throw new StorageError("VERIFY_FAILED", "ROS canary Content-Length mismatch.");
        }
        cacheControlValue = headResult.cacheControl;
        cacheControl = headResult.cacheControl === expectedCacheControl ? "OK" : "MISMATCH";
        if (cacheControl !== "OK") warnings.add("CACHE_CONTROL_MISMATCH");
        details.push({ objectKey: sample.objectKey, status: "head-only", message: "existing object skipped; HEAD verified" });
      } else {
        details.push({ objectKey: sample.objectKey, status: "skipped", message: "no local sample bytes supplied" });
      }
      stage = "duplicate";
      const existsAfter = await options.storage.objectExists(sample.objectKey);
      duplicateCheck = existsAfter ? (exists ? "EXISTING" : "OK") : "FAILED";
      if (!existsAfter) {
        failureCode = "HEAD_FAILED";
        throw new StorageError("HEAD_FAILED", "ROS canary duplicate check failed.");
      }
      if (sample.publicRead && options.publicFetch) {
        stage = "public-read";
        const url = publicObjectUrl(sample.objectKey, options.storage.publicBaseUrl);
        const response = await options.publicFetch(url);
        if (!response.ok) {
          failureCode = "PUBLIC_READ_FAILED";
          throw new StorageError("GET_FAILED", "ROS public read failed.");
        }
        publicRead += 1;
        const allowOrigin = response.headers.get("access-control-allow-origin");
        const corsAllowed = allowOrigin === "*" || allowOrigin === corsOrigin;
        cors = corsAllowed ? "AVAILABLE" : "CORS_NOT_AVAILABLE";
        if (!corsAllowed) warnings.add("CORS_NOT_CONFIGURED");
        details.push({ objectKey: sample.objectKey, status: "public-read", message: corsAllowed ? "public GET and CORS header observed" : `public GET succeeded; CORS header unavailable (${allowOrigin ?? "missing"})` });
        if (options.rangeFetch) {
          const rangeResponse = await options.rangeFetch(url);
          rangeStatus = rangeResponse.status;
          rangeContentRange = rangeResponse.headers.get("content-range") ?? undefined;
          range = rangeResponse.status === 206 && Boolean(rangeContentRange) ? "AVAILABLE" : "NOT_AVAILABLE";
          if (range !== "AVAILABLE") warnings.add("RANGE_NOT_AVAILABLE");
          details.push({ objectKey: sample.objectKey, status: "public-read", message: range === "AVAILABLE" ? `Range response observed (${rangeResponse.status}, ${rangeContentRange})` : `Range response unavailable (${rangeResponse.status}, ${rangeContentRange ?? "missing Content-Range"})` });
        }
      }
    } catch (error) {
      if (error instanceof StorageError && error.code === "NOT_CONFIGURED") {
        failureCode = "ROS_NOT_CONFIGURED";
      } else if (!failureCode) {
        failureCode = stage === "put" ? "PUT_FAILED" : stage === "head" || stage === "duplicate" ? "HEAD_FAILED" : stage === "public-read" ? "PUBLIC_READ_FAILED" : "CANARY_FAILED";
      }
    } finally {
      if (cleanupRequested && cleanupAllowed) {
        try {
          await options.storage.deleteObject(sample.objectKey);
          cleanup = "OK";
        } catch {
          cleanup = "WARNING";
          cleanupObjectKey = sample.objectKey;
          warnings.add("CLEANUP_WARNING");
        }
      }
    }
    if (failureCode) break;
  }
  if (failureCode === "ROS_NOT_CONFIGURED") return result("NOT_CONFIGURED");
  if (failureCode) return result("BLOCKED");
  return result(warnings.size > 0 ? "PASS_WITH_WARNINGS" : "READY");
}

export async function readCanarySample(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path));
}

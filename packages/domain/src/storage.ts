import { createHash } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
  type PutObjectCommandInput,
} from "@aws-sdk/client-s3";

export const DEFAULT_ROS_ENDPOINT = "https://cn-nb1.rains3.com";
export const DEFAULT_ROS_BUCKET = "rhythm-assets";
export const DEFAULT_ROS_PUBLIC_BASE_URL = "https://rhythm-assets.cn-nb1.rains3.com";
export const IMMUTABLE_OBJECT_CACHE_CONTROL = "public, max-age=31536000, immutable";

export type RosStorageStatus = "READY" | "NOT_CONFIGURED";

export type RosStorageConfig = {
  endpoint: string;
  bucket: string;
  publicBaseUrl: string;
  region: string;
  forcePathStyle: boolean;
  accessKey?: string;
  secretKey?: string;
};

export type PublicRosStorageStatus = {
  configured: boolean;
  endpoint: string;
  bucket: string;
  publicBaseUrl: string;
  accessKeyConfigured: boolean;
  secretKeyConfigured: boolean;
};

export type StorageObjectBody = NonNullable<PutObjectCommandInput["Body"]>;

export type StorageHead = {
  objectKey: string;
  sizeBytes: number;
  contentType?: string;
  cacheControl?: string;
  etag?: string;
};

export type StorageVerification = {
  objectKey: string;
  exists: boolean;
  verified: boolean;
  sizeBytes?: number;
  contentType?: string;
  cacheControl?: string;
  sha256?: string;
};

export type StorageClient = {
  readonly status: RosStorageStatus;
  readonly publicBaseUrl: string;
  putObject(input: { objectKey: string; body: StorageObjectBody; sizeBytes?: number; contentType?: string; cacheControl?: string }): Promise<void>;
  headObject(objectKey: string): Promise<StorageHead>;
  getObject(objectKey: string): Promise<GetObjectCommandOutput>;
  deleteObject(objectKey: string): Promise<void>;
  objectExists(objectKey: string): Promise<boolean>;
  verifyObject(objectKey: string, expected: { sizeBytes: number; sha256?: string }): Promise<StorageVerification>;
};

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function booleanEnv(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

export function loadRosStorageConfig(env: NodeJS.ProcessEnv = process.env): RosStorageConfig {
  const config: RosStorageConfig = {
    endpoint: nonEmpty(env.ROS_ENDPOINT) ?? DEFAULT_ROS_ENDPOINT,
    bucket: nonEmpty(env.ROS_BUCKET) ?? DEFAULT_ROS_BUCKET,
    publicBaseUrl: nonEmpty(env.ROS_PUBLIC_BASE_URL) ?? DEFAULT_ROS_PUBLIC_BASE_URL,
    region: nonEmpty(env.ROS_REGION) ?? "us-east-1",
    forcePathStyle: booleanEnv(env.ROS_FORCE_PATH_STYLE),
  };
  const accessKey = nonEmpty(env.ROS_ACCESS_KEY);
  const secretKey = nonEmpty(env.ROS_SECRET_KEY);
  if (accessKey) config.accessKey = accessKey;
  if (secretKey) config.secretKey = secretKey;
  return config;
}

export function rosStorageStatus(config = loadRosStorageConfig()): PublicRosStorageStatus {
  const accessKeyConfigured = Boolean(config.accessKey);
  const secretKeyConfigured = Boolean(config.secretKey);
  return {
    configured: accessKeyConfigured && secretKeyConfigured,
    endpoint: config.endpoint,
    bucket: config.bucket,
    publicBaseUrl: config.publicBaseUrl,
    accessKeyConfigured,
    secretKeyConfigured,
  };
}

export function publicObjectUrl(objectKey: string, publicBaseUrl = loadRosStorageConfig().publicBaseUrl): string {
  const base = publicBaseUrl.replace(/\/+$/u, "");
  const encodedKey = objectKey.split("/").map((part) => encodeURIComponent(part)).join("/");
  return `${base}/${encodedKey}`;
}

export class StorageError extends Error {
  readonly code: "NOT_CONFIGURED" | "PUT_FAILED" | "HEAD_FAILED" | "GET_FAILED" | "DELETE_FAILED" | "VERIFY_FAILED";
  readonly notFound: boolean;

  constructor(code: StorageError["code"], message: string, options: { notFound?: boolean } = {}) {
    super(message);
    this.name = "StorageError";
    this.code = code;
    this.notFound = options.notFound === true;
  }
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { name?: unknown; $metadata?: { httpStatusCode?: number } };
  return value.$metadata?.httpStatusCode === 404 || ["NotFound", "NoSuchKey", "NoSuchObject"].includes(String(value.name));
}

function operationError(code: Exclude<StorageError["code"], "NOT_CONFIGURED">, error: unknown, notFound = false): StorageError {
  // Do not retain the SDK error as `cause`: SDK request errors can contain
  // request metadata, and the public/admin boundary must never echo secrets.
  return new StorageError(code, `ROS ${code.replace(/_FAILED$/u, "").toLowerCase()} failed.`, { notFound: notFound || isNotFound(error) });
}

async function sha256Body(body: unknown): Promise<string | undefined> {
  if (body === undefined || body === null) return undefined;
  if (body instanceof Uint8Array) return createHash("sha256").update(body).digest("hex");
  if (typeof body === "string") return createHash("sha256").update(body).digest("hex");
  if (typeof body === "object" && "transformToByteArray" in body && typeof body.transformToByteArray === "function") {
    const bytes = await body.transformToByteArray();
    return createHash("sha256").update(bytes).digest("hex");
  }
  if (typeof body === "object" && Symbol.asyncIterator in body) {
    const hash = createHash("sha256");
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) hash.update(typeof chunk === "string" ? chunk : chunk);
    return hash.digest("hex");
  }
  return undefined;
}

export class S3StorageClient implements StorageClient {
  readonly status: RosStorageStatus;
  readonly publicBaseUrl: string;
  private readonly config: RosStorageConfig;
  private readonly client?: S3Client;

  constructor(config: RosStorageConfig = loadRosStorageConfig()) {
    this.config = config;
    this.publicBaseUrl = config.publicBaseUrl;
    this.status = rosStorageStatus(config).configured ? "READY" : "NOT_CONFIGURED";
    if (this.status === "READY") {
      this.client = new S3Client({
        endpoint: config.endpoint,
        region: config.region,
        forcePathStyle: config.forcePathStyle,
        credentials: { accessKeyId: config.accessKey!, secretAccessKey: config.secretKey! },
      });
    }
  }

  private requireClient(): S3Client {
    if (!this.client) throw new StorageError("NOT_CONFIGURED", "ROS credentials are not configured.");
    return this.client;
  }

  async putObject(input: { objectKey: string; body: StorageObjectBody; sizeBytes?: number; contentType?: string; cacheControl?: string }): Promise<void> {
    try {
      await this.requireClient().send(new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: input.objectKey,
        Body: input.body,
        ...(input.sizeBytes !== undefined ? { ContentLength: input.sizeBytes } : {}),
        ...(input.contentType ? { ContentType: input.contentType } : {}),
        CacheControl: input.cacheControl ?? IMMUTABLE_OBJECT_CACHE_CONTROL,
      }));
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw operationError("PUT_FAILED", error);
    }
  }

  async headObject(objectKey: string): Promise<StorageHead> {
    try {
      const result = await this.requireClient().send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: objectKey }));
      return {
        objectKey,
        sizeBytes: result.ContentLength ?? 0,
        ...(result.ContentType ? { contentType: result.ContentType } : {}),
        ...(result.CacheControl ? { cacheControl: result.CacheControl } : {}),
        ...(result.ETag ? { etag: result.ETag } : {}),
      };
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw operationError("HEAD_FAILED", error);
    }
  }

  async getObject(objectKey: string): Promise<GetObjectCommandOutput> {
    try {
      return await this.requireClient().send(new GetObjectCommand({ Bucket: this.config.bucket, Key: objectKey }));
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw operationError("GET_FAILED", error);
    }
  }

  async deleteObject(objectKey: string): Promise<void> {
    try {
      await this.requireClient().send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: objectKey }));
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw operationError("DELETE_FAILED", error);
    }
  }

  async objectExists(objectKey: string): Promise<boolean> {
    try {
      await this.headObject(objectKey);
      return true;
    } catch (error) {
      if (error instanceof StorageError && error.notFound) return false;
      throw error;
    }
  }

  async verifyObject(objectKey: string, expected: { sizeBytes: number; sha256?: string }): Promise<StorageVerification> {
    try {
      const head = await this.headObject(objectKey);
      const contentSha256 = expected.sha256 ? await sha256Body((await this.getObject(objectKey)).Body) : undefined;
      return {
        objectKey,
        exists: true,
        verified: head.sizeBytes === expected.sizeBytes && (!expected.sha256 || contentSha256?.toLowerCase() === expected.sha256.toLowerCase()),
        sizeBytes: head.sizeBytes,
        ...(head.contentType ? { contentType: head.contentType } : {}),
        ...(head.cacheControl ? { cacheControl: head.cacheControl } : {}),
        ...(contentSha256 ? { sha256: contentSha256 } : {}),
      };
    } catch (error) {
      if (error instanceof StorageError && error.notFound) return { objectKey, exists: false, verified: false };
      if (error instanceof StorageError) throw error;
      throw operationError("VERIFY_FAILED", error);
    }
  }
}

/**
 * A tiny in-memory adapter for tests and local dry-run verification. It has
 * the same public contract as S3StorageClient but never performs a network
 * operation.
 */
export class MemoryStorageClient implements StorageClient {
  readonly status: RosStorageStatus = "READY";
  readonly publicBaseUrl: string;
  readonly objects = new Map<string, { body: Uint8Array; sizeBytes: number; contentType?: string; cacheControl: string }>();
  failOnPutNumber?: number;
  private putCount = 0;

  constructor(publicBaseUrl = DEFAULT_ROS_PUBLIC_BASE_URL) {
    this.publicBaseUrl = publicBaseUrl;
  }

  async putObject(input: { objectKey: string; body: StorageObjectBody; sizeBytes?: number; contentType?: string; cacheControl?: string }): Promise<void> {
    this.putCount += 1;
    if (this.failOnPutNumber !== undefined && this.putCount === this.failOnPutNumber) throw new StorageError("PUT_FAILED", "ROS put failed.");
    const body = await bodyToBytes(input.body);
    this.objects.set(input.objectKey, {
      body,
      sizeBytes: input.sizeBytes ?? body.byteLength,
      ...(input.contentType ? { contentType: input.contentType } : {}),
      cacheControl: input.cacheControl ?? IMMUTABLE_OBJECT_CACHE_CONTROL,
    });
  }

  async headObject(objectKey: string): Promise<StorageHead> {
    const object = this.objects.get(objectKey);
    if (!object) throw new StorageError("HEAD_FAILED", "ROS head failed.", { notFound: true });
    return { objectKey, sizeBytes: object.sizeBytes, ...(object.contentType ? { contentType: object.contentType } : {}), cacheControl: object.cacheControl };
  }

  async getObject(objectKey: string): Promise<GetObjectCommandOutput> {
    const object = this.objects.get(objectKey);
    if (!object) throw new StorageError("GET_FAILED", "ROS get failed.", { notFound: true });
    return { Body: object.body } as unknown as GetObjectCommandOutput;
  }

  async deleteObject(objectKey: string): Promise<void> {
    this.objects.delete(objectKey);
  }

  async objectExists(objectKey: string): Promise<boolean> {
    return this.objects.has(objectKey);
  }

  async verifyObject(objectKey: string, expected: { sizeBytes: number; sha256?: string }): Promise<StorageVerification> {
    const object = this.objects.get(objectKey);
    if (!object) return { objectKey, exists: false, verified: false };
    const sha256 = createHash("sha256").update(object.body).digest("hex");
    return { objectKey, exists: true, verified: object.sizeBytes === expected.sizeBytes && (!expected.sha256 || sha256 === expected.sha256.toLowerCase()), sizeBytes: object.sizeBytes, ...(object.contentType ? { contentType: object.contentType } : {}), cacheControl: object.cacheControl, sha256 };
  }
}

async function bodyToBytes(body: StorageObjectBody): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body && typeof body === "object" && "transformToByteArray" in body && typeof body.transformToByteArray === "function") {
    return body.transformToByteArray();
  }
  if (body && typeof body === "object" && Symbol.asyncIterator in body) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  }
  // Node Readable values should be async iterable, but keep the failure
  // generic so a malformed test body cannot expose any configuration value.
  throw new StorageError("PUT_FAILED", "ROS put failed.");
}

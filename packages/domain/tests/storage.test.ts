import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { S3Client } from "@aws-sdk/client-s3";
import {
  ARCAEA_APK_CONTENT_TYPE,
  IMMUTABLE_OBJECT_CACHE_CONTROL,
  S3StorageClient,
  loadRosStorageConfig,
} from "../src/index.js";

const PART_SIZE_BYTES = 64 * 1024 * 1024;

test("large S3 upload uses multipart params and preserves APK metadata", async () => {
  const commands: Array<{ name: string; input: Record<string, unknown> }> = [];
  const client = new S3Client({ region: "us-east-1", credentials: { accessKeyId: "ak-test", secretAccessKey: "sk-test" } });
  client.send = (async (command: { input: Record<string, unknown>; constructor: { name: string } }) => {
    const name = command.constructor.name;
    commands.push({ name, input: command.input });
    if (name === "CreateMultipartUploadCommand") return { UploadId: "upload-id" };
    if (name === "UploadPartCommand") return { ETag: `"etag-${String(command.input.PartNumber)}"` };
    if (name === "CompleteMultipartUploadCommand") return {};
    throw new Error(`unexpected S3 command ${name}`);
  }) as unknown as typeof client.send;

  const storage = new S3StorageClient(loadRosStorageConfig({
    ROS_ACCESS_KEY: "ak-test",
    ROS_SECRET_KEY: "sk-test",
    ROS_BUCKET: "rhythm-assets-test",
    ROS_PUBLIC_BASE_URL: "https://example.test",
  }), client);
  const objectKey = "apk/arcaea/releases/6.17.1/Arcaea_6.17.1.apk";
  const sizeBytes = PART_SIZE_BYTES + 1;
  const progress: Array<{ loadedBytes: number; totalBytes: number }> = [];
  await storage.putLargeObject({
    objectKey,
    body: Readable.from((async function* () {
      yield Buffer.alloc(PART_SIZE_BYTES);
      yield Buffer.from([1]);
    })()) as unknown as Parameters<typeof storage.putLargeObject>[0]["body"],
    sizeBytes,
    contentType: ARCAEA_APK_CONTENT_TYPE,
    cacheControl: IMMUTABLE_OBJECT_CACHE_CONTROL,
    contentDisposition: 'attachment; filename="Arcaea_6.17.1.apk"',
    metadata: { sha256: "a".repeat(64) },
    onProgress: (event) => progress.push(event),
  });

  const create = commands.find((command) => command.name === "CreateMultipartUploadCommand");
  assert.ok(create);
  assert.equal(commands.filter((command) => command.name === "UploadPartCommand").length, 2);
  assert.equal(commands.filter((command) => command.name === "CompleteMultipartUploadCommand").length, 1);
  assert.equal(create.input.Bucket, "rhythm-assets-test");
  assert.equal(create.input.Key, objectKey);
  assert.equal(create.input.ContentLength, sizeBytes);
  assert.equal(create.input.ContentType, ARCAEA_APK_CONTENT_TYPE);
  assert.equal(create.input.CacheControl, IMMUTABLE_OBJECT_CACHE_CONTROL);
  assert.equal(create.input.ContentDisposition, 'attachment; filename="Arcaea_6.17.1.apk"');
  assert.deepEqual(create.input.Metadata, { sha256: "a".repeat(64) });
  assert.equal(progress.at(-1)?.loadedBytes, sizeBytes);
  assert.equal(progress.at(-1)?.totalBytes, sizeBytes);
});

test("S3 HEAD exposes user metadata without changing the existing object API", async () => {
  const client = new S3Client({ region: "us-east-1", credentials: { accessKeyId: "ak-test", secretAccessKey: "sk-test" } });
  client.send = (async (command: { constructor: { name: string } }) => {
    assert.equal(command.constructor.name, "HeadObjectCommand");
    return {
      ContentLength: 123,
      ContentType: ARCAEA_APK_CONTENT_TYPE,
      CacheControl: IMMUTABLE_OBJECT_CACHE_CONTROL,
      ContentDisposition: 'attachment; filename="Arcaea_6.17.1.apk"',
      Metadata: { sha256: "b".repeat(64) },
      ETag: '"etag"',
    };
  }) as unknown as typeof client.send;

  const storage = new S3StorageClient(loadRosStorageConfig({
    ROS_ACCESS_KEY: "ak-test",
    ROS_SECRET_KEY: "sk-test",
  }), client);
  const head = await storage.headObject("apk/arcaea/releases/6.17.1/Arcaea_6.17.1.apk");
  assert.equal(head.sizeBytes, 123);
  assert.equal(head.contentType, ARCAEA_APK_CONTENT_TYPE);
  assert.equal(head.cacheControl, IMMUTABLE_OBJECT_CACHE_CONTROL);
  assert.equal(head.contentDisposition, 'attachment; filename="Arcaea_6.17.1.apk"');
  assert.deepEqual(head.metadata, { sha256: "b".repeat(64) });
  assert.equal(head.etag, '"etag"');
});

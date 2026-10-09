import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand, S3Client, UploadPartCommand,
} from "@aws-sdk/client-s3";
import { loadRosStorageConfig, S3StorageClient } from "../../../packages/domain/src/storage.js";

const referer = "https://rhythmarchive.github.io/";

for (const configuredReferer of [undefined, referer]) {
  test(`ROS requests retain S3 signing with Referer ${configuredReferer ?? "unset"}`, async (t) => {
    const requests: Array<{ method: string; headers: Record<string, string> }> = [];
    const config = loadRosStorageConfig({
      ROS_ACCESS_KEY: "test-access-key", ROS_SECRET_KEY: "test-secret-key",
      ...(configuredReferer ? { ROS_REFERER: ` ${configuredReferer} ` } : {}),
    });
    assert.equal(config.referer, configuredReferer);
    const client = new S3Client({
      endpoint: config.endpoint, region: config.region,
      credentials: { accessKeyId: config.accessKey!, secretAccessKey: config.secretKey! },
      requestHandler: {
        async handle(request: { method: string; headers: Record<string, string>; query?: Record<string, string> }) {
          requests.push(request);
          const xml = request.query && "uploads" in request.query
            ? "<InitiateMultipartUploadResult><UploadId>test-upload</UploadId></InitiateMultipartUploadResult>"
            : request.query?.uploadId && request.method === "POST"
              ? "<CompleteMultipartUploadResult><ETag>test-etag</ETag></CompleteMultipartUploadResult>"
              : request.query && "list-type" in request.query
                ? "<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>"
                : "{}";
          return { response: { statusCode: 200, headers: { etag: "test-etag", "content-length": "2" }, body: Readable.from([xml]) } };
        },
      },
    });
    t.after(() => client.destroy());
    const storage = new S3StorageClient(config, client);
    await storage.getObject("apk/arcaea/latest.json");
    await storage.headObject("apk/arcaea/latest.json");
    await storage.putObject({ objectKey: "apk/arcaea/latest.json", body: "{}" });
    await storage.putLargeObject({ objectKey: "apk/arcaea/test.apk", body: Buffer.from("test"), sizeBytes: 4, metadata: {} });
    await storage.listObjects("apk/arcaea/");
    await storage.deleteObject("apk/arcaea/test.apk");
    // Multipart upload, completion and error cleanup use the same client stack.
    const object = { Bucket: config.bucket, Key: "apk/arcaea/test.apk" };
    await client.send(new CreateMultipartUploadCommand(object));
    await client.send(new UploadPartCommand({ ...object, UploadId: "test-upload", PartNumber: 1, Body: "test" }));
    await client.send(new CompleteMultipartUploadCommand({ ...object, UploadId: "test-upload", MultipartUpload: { Parts: [{ PartNumber: 1, ETag: "test-etag" }] } }));
    await client.send(new AbortMultipartUploadCommand({ ...object, UploadId: "test-upload" }));
    assert.equal(requests.length, 10);
    for (const request of requests) {
      assert.equal(request.headers.referer, configuredReferer);
      const authorization = request.headers.authorization;
      assert.ok(authorization);
      assert.match(authorization, /^AWS4-HMAC-SHA256 Credential=test-access-key\//u);
      assert.match(authorization, /Signature=[0-9a-f]{64}$/u);
      assert.ok(request.headers["x-amz-date"]);
    }
  });
}

test("blank ROS Referer leaves the existing request behavior unchanged", () => {
  assert.equal(loadRosStorageConfig({ ROS_REFERER: "  " }).referer, undefined);
});

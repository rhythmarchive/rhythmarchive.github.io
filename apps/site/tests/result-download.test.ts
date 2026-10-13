import assert from "node:assert/strict";
import test from "node:test";
import { unzipSync } from "fflate";
import { MAX_BATCH_FILES, MAX_BATCH_BYTES, resultBatchLimitMessage } from "../src/lib/batch";
import { downloadSelectedBatchFromManifest, downloadSelectedBatch } from "../src/scripts/batch-tray";

test("result download rejects zero and over-limit counts without truncating", async (t) => {
  assert.match(resultBatchLimitMessage(0)!, /没有符合/);
  assert.equal(resultBatchLimitMessage(MAX_BATCH_FILES - 1), undefined);
  assert.equal(resultBatchLimitMessage(MAX_BATCH_FILES), undefined);
  assert.match(resultBatchLimitMessage(MAX_BATCH_FILES + 1)!, /31.*30/);
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; return Response.json({}); });
  for (const count of [0, 31]) {
    let status = "";
    await downloadSelectedBatchFromManifest({ selectedIds: Array.from({ length: count }, (_, i) => String(i)), manifestUrl: "/manifest", getResource: () => undefined, preferUpscaled: false, filename: "test.zip", setStatus: (value) => { status = value; } });
    assert.ok(status);
  }
  assert.equal(requests, 0);
});

test("29 and 30 matching resources all enter the ZIP with shared objects fetched once", async (t) => {
  const originalFetch = globalThis.fetch;
  const descriptors = ["document", "window"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  let archiveUrl = "", objectRequests = 0;
  Object.defineProperty(globalThis, "document", { configurable: true, value: { body: { append() {} }, createElement: () => ({ href: "", click() { archiveUrl = this.href; }, remove() {} }) } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout() {}, __rhythmArchiveStatsClient: { trackResourceDownload: async () => undefined } } });
  t.after(() => { if (archiveUrl) URL.revokeObjectURL(archiveUrl); for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
  const cards = Array.from({ length: 30 }, (_, i) => ({ resourceId: String(i), route: `/r/${i}/`, displayTitle: String(i), preview: { small: null, medium: null, large: null } }));
  const manifest = Object.fromEntries(cards.map((card) => [card.resourceId, { original: { url: "https://assets.test/shared", mime: "image/png", sizeBytes: 2, downloadFilename: `${card.resourceId}.png` } }]));
  t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0]) => {
    if (String(url) === "/manifest") return Response.json(manifest);
    objectRequests++; return new Response(new Uint8Array([1, 2]));
  });
  for (const count of [29, 30]) {
    objectRequests = 0;
    await downloadSelectedBatchFromManifest({ selectedIds: cards.slice(0, count).map((card) => card.resourceId), getResource: (id) => cards.find((card) => card.resourceId === id), manifestUrl: "/manifest", preferUpscaled: false, filename: "test.zip", setStatus: () => undefined });
    const entries = unzipSync(new Uint8Array(await (await originalFetch(archiveUrl)).arrayBuffer()));
    assert.equal(Object.keys(entries).length, count);
    assert.equal(objectRequests, 1);
    URL.revokeObjectURL(archiveUrl); archiveUrl = "";
  }
});

test("cancelled manifest and oversized files never start image transfers", async (t) => {
  let requests = 0, status = "";
  t.mock.method(globalThis, "fetch", async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    requests++;
    return await new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("cancel", "AbortError")), { once: true }));
  });
  const controller = new AbortController();
  const pending = downloadSelectedBatchFromManifest({ selectedIds: ["id"], getResource: () => undefined, manifestUrl: "/manifest", preferUpscaled: false, filename: "test.zip", signal: controller.signal, setStatus: (value) => { status = value; } });
  controller.abort(); await pending;
  assert.equal(requests, 1); assert.equal(status, "下载已取消");
  await downloadSelectedBatch({ selectedIds: ["id"], getResource: () => ({ resourceId: "id", displayTitle: "id", route: "/r/id/", preview: { small: null, medium: null, large: null }, original: { url: "https://assets.test/huge", mime: "image/png", downloadFilename: "huge.png", sizeBytes: MAX_BATCH_BYTES + 1 } }), preferUpscaled: false, filename: "test.zip", setStatus: (value) => { status = value; } });
  assert.equal(requests, 1); assert.match(status, /300 MiB/);
});

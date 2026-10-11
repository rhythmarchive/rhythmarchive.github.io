import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { loadSelectedDetailImages, observeImage } from "../src/scripts/viewport-images.js";
import { downloadRendition } from "../src/scripts/download.js";
import { downloadSelectedBatch } from "../src/scripts/batch-tray.js";
import { unzipSync } from "fflate";
import { classifyDownloadFailure, DownloadHttpError } from '../src/lib/resource-reports-client.js';

test("offscreen and hidden images stay inert; visible responsive images bind candidates before src", async (t) => {
  let notify: (entries: unknown[]) => void = () => undefined;
  const observed: unknown[] = [], removed: unknown[] = [], writes: string[] = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver");
  t.after(() => { if (previous) Object.defineProperty(globalThis, "IntersectionObserver", previous); else Reflect.deleteProperty(globalThis, "IntersectionObserver"); });
  Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: class {
    constructor(callback: typeof notify) { notify = callback; }
    observe(target: unknown) { observed.push(target); }
    unobserve(target: unknown) { removed.push(target); }
  } });
  let hidden = false;
  const image = {
    dataset: { viewportSrc: "original-preview", viewportSrcset: "small 320w, large 640w" },
    isConnected: true,
    closest: () => hidden ? {} : null,
    set src(value: string) { writes.push("src:" + value); },
    set srcset(value: string) { writes.push("srcset:" + value); },
  } as unknown as HTMLImageElement;
  observeImage(image);
  assert.equal(observed.length, 1);
  assert.deepEqual(writes, []);
  notify([{ target: image, isIntersecting: false }]);
  hidden = true;
  notify([{ target: image, isIntersecting: true }]);
  assert.deepEqual(writes, []);
  hidden = false;
  notify([{ target: image, isIntersecting: true }]);
  assert.deepEqual(writes, ["srcset:small 320w, large 640w", "src:original-preview"]);
  assert.equal(image.dataset.viewportSrc, undefined);
  observeImage(image);
  assert.equal(observed.length, 1);
  assert.deepEqual(removed, [image]);
  const replaced = { dataset: { viewportSrc: "discarded-preview" }, isConnected: false } as unknown as HTMLImageElement;
  observeImage(replaced);
  await Promise.resolve();
  assert.deepEqual(removed, [image, replaced]);
});

test("browsers without IntersectionObserver still display image previews", () => {
  const image = { dataset: { viewportSrc: "preview" }, src: "" } as unknown as HTMLImageElement;
  observeImage(image);
  assert.equal(image.src, "preview");
});

test("detail images retain full resolution and hydrate only the selected source and variant once", () => {
  const create = (url: string, hidden: boolean) => ({ dataset: { detailSrc: url }, hidden, src: "", closest() { return this.hidden ? {} : null; } });
  const original = create("original-full", false), upscale = create("upscaled-full", true), variant = create("other-original-full", true);
  const scope = { querySelectorAll: () => [original, upscale, variant].filter(image => image.dataset.detailSrc) } as unknown as ParentNode;
  loadSelectedDetailImages(scope);
  assert.equal(original.src, "original-full");
  assert.equal(upscale.src, "");
  assert.equal(variant.src, "");
  original.hidden = true;
  upscale.hidden = false;
  loadSelectedDetailImages(scope);
  assert.equal(upscale.src, "upscaled-full");
  assert.equal(variant.src, "");
  variant.hidden = false;
  loadSelectedDetailImages(scope);
  assert.equal(variant.src, "other-original-full");
  assert.equal(scope.querySelectorAll("img").length, 0);
});

function browser(t: TestContext) {
  const tracked: string[] = [];
  let archiveUrl = "";
  const anchors: Array<{ href: string; rel: string; referrerPolicy: string }> = [];
  for (const key of ["window", "document"] as const) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); });
  }
  Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout: () => undefined, __rhythmArchiveStatsClient: { trackResourceDownload: async (id: string) => { tracked.push(id); } } } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    body: { append: () => undefined },
    createElement: () => { const anchor = { href: "", rel: "", referrerPolicy: "", click() { archiveUrl = this.href; }, remove() {} }; anchors.push(anchor); return anchor; },
  } });
  t.after(() => { if (archiveUrl.startsWith("blob:")) URL.revokeObjectURL(archiveUrl); });
  return { anchors, tracked, archiveUrl: () => archiveUrl };
}

test("batch fetches a shared ROS object once while preserving both ZIP filenames", async (t) => {
  const realFetch = globalThis.fetch;
  const ui = browser(t), requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    requests.push(String(url));
    assert.equal(init?.referrerPolicy, "strict-origin-when-cross-origin");
    return new Response(new Uint8Array([1, 2]));
  });
  await downloadSelectedBatch({ selectedIds: ["a", "b"], getResource: id => ({
    resourceId: id, route: "/", displayTitle: id, preview: { small: null, medium: null, large: null },
    original: { url: "https://assets.test/shared", downloadFilename: id + ".png", sizeBytes: 2, mime: "image/png" },
  }), preferUpscaled: false, filename: "batch.zip", setStatus: () => undefined });
  assert.deepEqual(requests, ["https://assets.test/shared"]);
  const zip = unzipSync(new Uint8Array(await (await realFetch(ui.archiveUrl())).arrayBuffer()));
  assert.deepEqual(Object.keys(zip).sort(), ["a.png", "b.png"]);
  assert.deepEqual([...zip["a.png"]!], [...zip["b.png"]!]);
});

test("batch failure aborts in-flight transfers and never starts queued ROS downloads", async (t) => {
  const ui = browser(t), signals: AbortSignal[] = [], requested: string[] = [], statuses: string[] = [];
  t.mock.method(console, "error", () => undefined);
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    requested.push(String(url));
    const signal = init!.signal as AbortSignal;
    signals.push(signal);
    if (String(url).endsWith("/a")) return new Response(null, { status: 403 });
    return await new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  });
  await downloadSelectedBatch({ selectedIds: ["a", "b", "c", "d"], getResource: id => ({
    resourceId: id, route: "/", displayTitle: id, preview: { small: null, medium: null, large: null },
    original: { url: "https://assets.test/" + id, downloadFilename: id + ".png", sizeBytes: 2, mime: "image/png" },
  }), preferUpscaled: false, filename: "batch.zip", setStatus: s => statuses.push(s) });
  assert.equal(requested.length, 3);
  assert.ok(signals.every(signal => signal.aborted));
  assert.equal(ui.anchors.length, 0);
  assert.equal(statuses.at(-1), "下载失败，请重试");
});

test("download HTTP failures are not retried as direct links; network fallback preserves Referer", async (t) => {
  const ui = browser(t), status = { textContent: "" };
  const button = { dataset: { downloadUrl: "https://assets.test/file", downloadFilename: "file.png", resourceId: "a" }, innerHTML: "下载", disabled: false,
    closest: () => ({ querySelector: () => status }),
  } as unknown as HTMLButtonElement;
  t.mock.method(console, "error", () => undefined);
  const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 403 }));
  await downloadRendition(button);
  assert.equal(ui.anchors.length, 0);
  assert.equal(fetchMock.mock.callCount(), 1);
  fetchMock.mock.mockImplementation(async () => { throw new TypeError("network error"); });
  await downloadRendition(button);
  assert.equal(ui.anchors[0]!.rel, "noopener");
  assert.equal(ui.anchors[0]!.referrerPolicy, "strict-origin-when-cross-origin");
  assert.equal(button.disabled, false);
  assert.deepEqual(ui.tracked, []);
  fetchMock.mock.mockImplementation(async () => new Response(new Uint8Array([1])));
  await downloadRendition(button);
  assert.deepEqual(ui.tracked, ['a']);
});

test('download failures classify HTTP/network only; cancellation and local limits stay silent', () => {
  assert.equal(classifyDownloadFailure(new DownloadHttpError(404)), 'http_404');
  assert.equal(classifyDownloadFailure(new TypeError('Failed to fetch')), 'network');
  assert.equal(classifyDownloadFailure(new DOMException('cancelled', 'AbortError')), undefined);
  assert.equal(classifyDownloadFailure(new Error('batch download exceeds the maximum size')), undefined);
  assert.equal(classifyDownloadFailure(new DownloadHttpError(200)), undefined);
});

test('single HTTP failures report once, keep downloads zero, and cancellation does not report', async (t) => {
  const ui = browser(t);
  const doc = document as unknown as { documentElement: unknown };
  doc.documentElement = { dataset: { statsApiUrl: 'https://api.test' } };
  const resourceId = '0008cc8e-0f13-798c-9e3a-93168d5f8d6e';
  const button = { dataset: { downloadUrl: 'https://assets.test/fail', downloadFilename: 'file.png', resourceId },
    innerHTML: '下载', disabled: false, closest: () => null } as unknown as HTMLButtonElement;
  const reports: unknown[] = [];
  t.mock.method(console, 'error', () => undefined);
  const mocked = t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith('https://api.test')) { reports.push(JSON.parse(init!.body as string)); return Response.json({ ok: true }); }
    return new Response(null, { status: 404 });
  });
  await downloadRendition(button); await downloadRendition(button);
  assert.deepEqual(reports, [{ resourceId, kind: 'http_404' }]);
  assert.deepEqual(ui.tracked, []);
  mocked.mock.mockImplementation(async () => { throw new DOMException('cancelled', 'AbortError'); });
  await downloadRendition(button);
  assert.equal(reports.length, 1);
});

test('batch attributes its triggering HTTP failure and suppresses aborted siblings and success stats', async (t) => {
  const ui = browser(t);
  (document as unknown as { documentElement: unknown }).documentElement = { dataset: { statsApiUrl: 'https://api.test' } };
  const ids = ['00495e71-9b2e-7a25-9147-bdf661b5b7c4', '007eb8d6-55f8-75c2-b119-23ce1f06c0d1'];
  const reports: unknown[] = [];
  t.mock.method(console, 'error', () => undefined);
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith('https://api.test')) { reports.push(JSON.parse(init!.body as string)); return Response.json({ ok: true }); }
    if (String(input).endsWith(ids[0]!)) return new Response(null, { status: 403 });
    return new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => reject(new DOMException('cancel', 'AbortError')), { once: true }));
  });
  await downloadSelectedBatch({ selectedIds: ids, getResource: id => ({ resourceId: id, route: `/r/${id}/`, displayTitle: id,
    preview: { small: null, medium: null, large: null }, original: { url: `https://assets.test/${id}`, downloadFilename: `${id}.png`, mime: 'image/png', sizeBytes: 1 } }),
    preferUpscaled: false, filename: 'test.zip', setStatus: () => undefined });
  assert.deepEqual(reports, [{ resourceId: ids[0], kind: 'http_403' }]);
  assert.deepEqual(ui.tracked, []);
});

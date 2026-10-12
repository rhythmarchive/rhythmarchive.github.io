import assert from "node:assert/strict";
import test from "node:test";
import { loadStaticData } from "../src/scripts/static-data";
import { loadImage, prepareImage, settleImage } from "../src/scripts/viewport-images";

test("image loading preserves responsive assignment order and settles cached/fallback states without extra requests", () => {
  const writes: string[] = [];
  let src = "", srcset = "";
  const trigger = { dataset: {} as Record<string, string> };
  const image = {
    dataset: { viewportSrc: "/preview.webp", viewportSrcset: "/small.webp 320w, /preview.webp 640w", fallbackSrc: "/fallback.webp", fallbackWidth: "640", fallbackHeight: "480" } as Record<string, string>,
    complete: false, naturalWidth: 0,
    get src() { return src; }, set src(value: string) { writes.push("src"); src = value; },
    get srcset() { return srcset; }, set srcset(value: string) { writes.push("srcset"); srcset = value; },
    removeAttribute: (key: string) => { if (key === "srcset") srcset = ""; },
    closest: () => trigger,
  } as unknown as HTMLImageElement;
  loadImage(image);
  assert.deepEqual(writes, ["srcset", "src"]);
  assert.equal(image.dataset.imageState, "loading");
  assert.equal(image.dataset.viewportSrc, undefined);
  settleImage(image, false);
  assert.equal(image.src, "/fallback.webp");
  assert.equal(image.srcset, "");
  assert.equal(trigger.dataset.lightboxPreviewWidth, "640");
  assert.equal(image.dataset.imageState, "loading");
  settleImage(image, true);
  assert.equal(image.dataset.imageState, "ready");
  settleImage(image, false);
  assert.equal(image.dataset.imageState, "error");
  assert.equal(writes.filter((write) => write === "src").length, 2);
  Object.assign(image, { complete: true, naturalWidth: 640 });
  prepareImage(image);
  assert.equal(image.dataset.imageState, "ready");
  loadImage(image);
  assert.equal(writes.length, 3);
  Object.assign(image, { naturalWidth: 0 });
  prepareImage(image);
  assert.equal(image.dataset.imageState, "error");
  assert.equal(writes.length, 3);
});

test("public projection requests deduplicate pending work, reuse parsed data and retry failures", async (t) => {
  let calls = 0;
  let fail = false;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(JSON.stringify({ calls }), { status: fail ? 503 : 200 });
  });
  const first = loadStaticData<{ calls: number }>("/navigation-test/shared.json");
  assert.equal(loadStaticData("/navigation-test/shared.json"), first);
  assert.deepEqual(await first, { calls: 1 });
  assert.deepEqual(await loadStaticData("/navigation-test/shared.json"), { calls: 1 });
  assert.equal(calls, 1);
  fail = true;
  await assert.rejects(loadStaticData("/navigation-test/retry.json"), /503/);
  fail = false;
  assert.deepEqual(await loadStaticData("/navigation-test/retry.json"), { calls: 3 });
});

test("public projection retention is bounded and recently used categories survive eviction", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response("[]");
  });
  for (let index = 0; index < 6; index++) await loadStaticData(`/navigation-test/category-${index}.json`);
  await loadStaticData("/navigation-test/category-0.json");
  await loadStaticData("/navigation-test/category-6.json");
  await loadStaticData("/navigation-test/category-0.json");
  assert.equal(calls.filter((url) => url.endsWith("category-0.json")).length, 1);
  await loadStaticData("/navigation-test/category-1.json");
  assert.equal(calls.filter((url) => url.endsWith("category-1.json")).length, 2);
});

test("a body swap expires page listeners and work while keeping future page setup", async (t) => {
  const documentEvents = new EventTarget();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentEvents });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  });
  const { onPageLoad, onPageCleanup, pageSignal } = await import("../src/scripts/page-lifecycle");
  let loads = 0;
  let clicks = 0;
  let cleanups = 0;
  onPageLoad(() => { loads++; });
  const oldSignal = pageSignal();
  documentEvents.addEventListener("click", () => { clicks++; }, { signal: oldSignal });
  onPageCleanup(() => { cleanups++; });
  documentEvents.dispatchEvent(new Event("astro:page-load"));
  documentEvents.dispatchEvent(new Event("click"));
  documentEvents.dispatchEvent(new Event("astro:before-swap"));
  documentEvents.dispatchEvent(new Event("click"));
  documentEvents.dispatchEvent(new Event("astro:page-load"));
  assert.equal(oldSignal.aborted, true);
  assert.equal(pageSignal().aborted, false);
  assert.equal(clicks, 1);
  assert.equal(cleanups, 1);
  assert.equal(loads, 2);
});

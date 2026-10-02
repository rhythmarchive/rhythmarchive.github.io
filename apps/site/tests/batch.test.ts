import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { MAX_BATCH_FILES, readResponseBytesWithinLimit, toggleBatchSelection, uniqueZipFilename } from "../src/lib/batch.js";
import { downloadSelectedBatchFromManifest } from "../src/scripts/batch-tray.js";
import { unzipSync } from "fflate";

const siteRoot = path.resolve(process.cwd(), "apps", "site");

test("update selection downloads originals from multiple existing category manifests into one ZIP", async (t) => {
  const originalFetch = globalThis.fetch;
  const descriptors = ["window", "document"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  let archiveUrl = "";
  const tracked: string[] = [];
  const requested: string[] = [];
  const statuses: string[] = [];
  t.after(() => {
    if (archiveUrl) URL.revokeObjectURL(archiveUrl);
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const download = (id: string) => ({ url: `https://assets.test/${id}`, downloadFilename: `${id}.png`, mime: "image/png", sizeBytes: 2 });
  t.mock.method(globalThis, "fetch", async (input: string) => {
    requested.push(input);
    if (input === "/batch/jacket.json") return Response.json({ jacket: { original: download("jacket") } });
    if (input === "/batch/cg.json") return Response.json({ cg: { original: download("cg") } });
    assert.match(input, /^https:\/\/assets.test\//u);
    return new Response(new Uint8Array([1, 2]));
  });
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    body: { append: () => undefined },
    createElement: () => ({ href: "", click() { archiveUrl = this.href; }, remove: () => undefined }),
  } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    setTimeout: () => undefined,
    __rhythmArchiveStatsClient: { trackResourceDownload: async (id: string) => { tracked.push(id); } },
  } });
  await downloadSelectedBatchFromManifest({
    selectedIds: ["jacket", "cg"], manifestUrl: ["/batch/jacket.json", "/batch/cg.json"],
    getResource: (id) => ({ resourceId: id, route: `/r/${id}/`, displayTitle: id, preview: { small: null, medium: null, large: null } }),
    preferUpscaled: false, filename: "update.zip", setStatus: (value) => statuses.push(value),
  });
  assert.deepEqual(requested, ["/batch/jacket.json", "/batch/cg.json", "https://assets.test/jacket", "https://assets.test/cg"]);
  assert.deepEqual(tracked, ["jacket", "cg"]);
  assert.equal(statuses.at(-1), "");
  const archive = unzipSync(new Uint8Array(await (await originalFetch(archiveUrl)).arrayBuffer()));
  assert.deepEqual(Object.keys(archive).sort(), ["cg.png", "jacket.png"]);
  assert.deepEqual([...archive["cg.png"]!], [1, 2]);
});

test("batch selection keeps the 30-file limit while allowing individual removal", () => {
  const ids = Array.from({ length: MAX_BATCH_FILES }, (_, index) => "resource-" + index);
  const full = toggleBatchSelection(ids, "resource-new");
  assert.equal(full.changed, false);
  assert.equal(full.limited, true);
  assert.equal(full.selected.length, MAX_BATCH_FILES);

  const removed = toggleBatchSelection(ids, ids[4]!);
  assert.equal(removed.changed, true);
  assert.equal(removed.limited, false);
  assert.equal(removed.selected.includes(ids[4]!), false);
  assert.equal(removed.selected.length, MAX_BATCH_FILES - 1);
});

test("batch response reads enforce actual byte limits and safe ZIP names", async () => {
  const bytes = await readResponseBytesWithinLimit(new Response(new Uint8Array([1, 2, 3])), 3);
  assert.deepEqual([...bytes], [1, 2, 3]);
  await assert.rejects(() => readResponseBytesWithinLimit(new Response(new Uint8Array([1, 2, 3, 4])), 3), /exceeds|larger/u);
  await assert.rejects(() => readResponseBytesWithinLimit(new Response(new Uint8Array([1]), { headers: { "Content-Length": "4" } }), 3), /larger/u);
  const used = new Set<string>();
  assert.equal(uniqueZipFilename(used, ".."), "resource.bin");
  assert.equal(uniqueZipFilename(used, ".."), "resource (2).bin");
});

test("Gallery and BrowseGallery share the fixed batch tray and client module", () => {
  const gallery = fs.readFileSync(path.join(siteRoot, "src", "components", "Gallery.astro"), "utf8");
  const browse = fs.readFileSync(path.join(siteRoot, "src", "components", "BrowseGallery.astro"), "utf8");
  const galleryScript = fs.readFileSync(path.join(siteRoot, "src", "scripts", "gallery.ts"), "utf8");
  const browseScript = fs.readFileSync(path.join(siteRoot, "src", "scripts", "browse-gallery.ts"), "utf8");
  const tray = fs.readFileSync(path.join(siteRoot, "src", "components", "BatchTray.astro"), "utf8");
  const batchScript = fs.readFileSync(path.join(siteRoot, "src", "scripts", "batch-tray.ts"), "utf8");
  const styles = fs.readFileSync(path.join(siteRoot, "src", "styles", "global.css"), "utf8");

  assert.match(gallery, /<BatchTray \/>/u);
  assert.match(browse, /<BatchTray \/>/u);
  assert.match(galleryScript, /createBatchTray/u);
  assert.match(browseScript, /createBatchTray/u);
  assert.match(galleryScript, /downloadSelectedBatch/u);
  assert.match(browseScript, /downloadSelectedBatch/u);
  assert.match(tray, /data-batch-view/u);
  assert.match(batchScript, /data-batch-remove/u);
  assert.match(batchScript, /upscaledButton\.hidden = !\[\.\.\.selected\]/u);
  assert.match(tray, /aria-expanded="false"/u);
  assert.match(batchScript, /toggleBatchSelection/u);
  assert.match(batchScript, /Escape/u);
  assert.match(styles, /\.batch-tray \{ position: fixed/u);
  assert.match(styles, /safe-area-inset-bottom/u);
  assert.match(styles, /batch-tray-utility-actions, \.batch-tray-download-actions \{ display: contents/u);
  assert.match(styles, /\.resource-select \{[\s\S]*pointer-events: auto/u);
  assert.match(styles, /prefers-reduced-motion/u);
});

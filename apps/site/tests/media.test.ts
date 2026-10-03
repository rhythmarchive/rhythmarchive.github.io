import assert from "node:assert/strict";
import test from "node:test";
import { Catalog } from "../../../packages/domain/src/schema.js";
import { validateCatalog } from "../../../packages/domain/src/validation.js";
import { projectCatalog } from "../src/lib/catalog-projection.js";
import { galleryCard } from "../src/lib/gallery-projection.js";
import { buildMediaItems } from "../src/lib/media.js";

function fixture() {
  const resourceId = "00000000-0000-7000-8000-000000000001";
  const variantId = "00000000-0000-7000-8000-000000000002";
  const now = "2026-10-03T00:00:00Z";
  const provenance = (hash: string, extension: string) => [{ sourceType: "phigros_apk", sourceRelativePath: `input/phigros/test.${extension}`, sourceFilename: `test.${extension}`, sourceSha256: hash, evidence: [{ kind: "sha256", detail: "Fixture", confidence: "high" }] }];
  const movieHash = "a".repeat(64), posterHash = "b".repeat(64);
  return Catalog.parse({
    catalogSchemaVersion: "1.0", catalogId: resourceId, generatedAt: now, releaseManifestIds: [],
    resources: [{ id: resourceId, game: "phigros", resourceType: "video", title: "演出", metadata: { mediaKind: "unlock" }, provenance: provenance(movieHash, "mp4"), lifecycle: { status: "published", createdAt: now, updatedAt: now, publishedAt: now } }],
    variants: [{ id: variantId, resourceId, variantKey: "intro", label: "前奏", sortOrder: 0, preferred: true, kind: "event", semanticStatus: "confirmed" }],
    objects: [
      { id: `sha256:${movieHash}`, sha256: movieHash, objectKey: `objects/${movieHash}/mp4`, mime: "video/mp4", extension: "mp4", sizeBytes: 1000, width: 1920, height: 1080, media: { durationSeconds: 40, fps: 30, hasAudio: true, videoCodec: "h264", audioCodec: "aac" }, alpha: "none", createdAt: now, provenance: provenance(movieHash, "mp4") },
      { id: `sha256:${posterHash}`, sha256: posterHash, objectKey: `objects/${posterHash}/webp`, mime: "image/webp", extension: "webp", sizeBytes: 100, width: 640, height: 360, alpha: "none", createdAt: now, provenance: provenance(posterHash, "webp") },
    ],
    renditions: [
      { id: "00000000-0000-7000-8000-000000000003", variantId, renditionType: "original", origin: "source", publishable: true, objectId: `sha256:${movieHash}`, downloadFilename: "演出.mp4", generatedBy: "extractor", createdAt: now },
      { id: "00000000-0000-7000-8000-000000000004", variantId, renditionType: "thumbnail-640", origin: "derived", publishable: false, objectId: `sha256:${posterHash}`, downloadFilename: "演出.webp", generatedBy: "thumbnailer", createdAt: now },
    ],
  });
}

test("video projection preserves original media facts and uses a static image on cards", () => {
  const catalog = fixture();
  assert.equal(validateCatalog(catalog).success, true);
  const resource = projectCatalog(catalog, "https://assets.example").resources[0]!;
  assert.equal(resource.category, "video");
  assert.equal(resource.variants[0]!.label, "前奏");
  assert.equal(resource.original!.media!.durationSeconds, 40);
  const card = galleryCard(resource);
  assert.equal(card.preview.medium!.mime, "image/webp");
  assert.ok(!JSON.stringify(card).includes("/mp4"));
  const item = buildMediaItems([resource])[0]!;
  assert.equal(item.clips[0]!.duration, 40);
  assert.equal(item.clips[0]!.original.url, resource.original!.url);
});

test("publishing an MP4 without playback metadata is rejected", () => {
  const catalog = fixture();
  delete catalog.objects[0]!.media;
  assert.equal(validateCatalog(catalog).success, false);
});

test("a video cannot use its movie bytes as a poster", () => {
  const catalog = fixture();
  catalog.renditions[1]!.objectId = catalog.objects[0]!.id;
  const resource = projectCatalog(catalog, "https://assets.example").resources[0]!;
  assert.equal(resource.preview.medium, null);
  assert.throws(() => buildMediaItems([resource]), /static poster/);
});

import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { PublicSiteData } from "../src/lib/types.js";

const siteRoot = path.resolve(process.cwd(), "apps/site");
const dist = path.join(siteRoot, "dist");
const source = JSON.parse(fs.readFileSync(path.join(siteRoot, "src/generated/public-site-data.json"), "utf8")) as PublicSiteData;
const originalUrls = new Set(source.resources.flatMap((resource) => [
  resource.original?.url, resource.upscaled?.url,
  ...resource.variants.flatMap((variant) => [variant.original?.url, variant.upscaled?.url]),
].filter((url): url is string => Boolean(url))));

const read = (relative: string): { bytes: number; gzipBytes: number; value: unknown } => {
  const buffer = fs.readFileSync(path.join(dist, relative));
  return { bytes: buffer.length, gzipBytes: gzipSync(buffer).length, value: JSON.parse(buffer.toString("utf8")) as unknown };
};
const assert = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const inspectPreview = (preview: unknown, file: string): void => {
  assert(isRecord(preview), `${file}: missing preview`);
  if (!isRecord(preview)) return;
  for (const asset of Object.values(preview)) {
    if (asset === null) continue;
    assert(isRecord(asset) && typeof asset.url === "string", `${file}: malformed preview`);
    if (isRecord(asset) && typeof asset.url === "string") assert(!originalUrls.has(asset.url), `${file}: card preview resolves to original/upscaled`);
  }
};
const checkCard = (card: unknown, file: string): void => {
  assert(isRecord(card), `${file}: malformed card`);
  if (!isRecord(card)) return;
  for (const key of ["original", "originals", "upscaled", "variants", "downloadFilename", "mime", "sizeBytes"]) assert(!(key in card), `${file}: ${key} leaked into browse payload`);
  inspectPreview(card.preview, file);
  if (isRecord(card.metadata)) assert(Object.keys(card.metadata).every((key) => key === "updateDate" || key === "updateVersion"), `${file}: full metadata leaked into card`);
  if (Array.isArray(card.artworks)) for (const artwork of card.artworks) checkCard(artwork, file);
};

const budget = (file: string, maxRaw: number, maxGzip: number) => {
  const result = read(file);
  assert(result.bytes <= maxRaw && result.gzipBytes <= maxGzip, `${file}: exceeded measured transfer budget (${result.bytes} raw, ${result.gzipBytes} gzip)`);
  return { file, bytes: result.bytes, gzipBytes: result.gzipBytes };
};

const measured = [
  budget("data/browse/arcaea/jacket.json", 1_800_000, 280_000),
  budget("data/galleries/arcaea/jacket.json", 900_000, 160_000),
  budget("data/galleries/paradigm-reboot/jacket.json", 800_000, 130_000),
  budget("data/search-cards.json", 2_800_000, 600_000),
];

assert(!fs.existsSync(path.join(dist, "data/resources.json")), "full resources.json must not be published");
for (const forbidden of ["operator-center", ".dev.vars", ".dev.vars.example", "TRAFFIC_AUDIT.md"]) assert(!fs.existsSync(path.join(dist, forbidden)), `${forbidden} must not be in Pages output`);
for (const game of fs.readdirSync(path.join(dist, "data/galleries"))) {
  for (const name of fs.readdirSync(path.join(dist, "data/galleries", game))) {
    const file = `data/galleries/${game}/${name}`;
    const cards = read(file).value;
    assert(Array.isArray(cards), `${file}: expected card array`);
    if (Array.isArray(cards)) for (const card of cards) checkCard(card, file);
  }
}
for (const game of fs.readdirSync(path.join(dist, "data/browse"))) {
  const file = `data/browse/${game}/jacket.json`;
  const data = read(file).value;
  assert(isRecord(data) && Array.isArray(data.items), `${file}: expected browse items`);
  if (isRecord(data) && Array.isArray(data.items)) for (const card of data.items) checkCard(card, file);
}
for (const file of ["data/search-cards.json", "data/ranking-cards.json"]) {
  const cards = read(file).value;
  assert(Array.isArray(cards), `${file}: expected card array`);
  if (Array.isArray(cards)) for (const card of cards) {
    assert(isRecord(card), `${file}: malformed card`);
    if (isRecord(card)) for (const image of [card.image, card.fallback]) {
      if (isRecord(image) && typeof image.url === "string") assert(!originalUrls.has(image.url), `${file}: original/upscaled card image`);
    }
  }
}

for (const page of ["arcaea/jacket/index.html", "paradigm-reboot/jacket/index.html"]) {
  const html = fs.readFileSync(path.join(dist, page), "utf8");
  const cards = html.match(/<article class="resource-card[^>]*>[\s\S]*?<\/article>/gu) ?? [];
  assert(cards.length > 0 && cards.length <= 48, `${page}: unbounded initial cards`);
  let eager = 0;
  for (const card of cards) {
    const img = card.match(/<img\b[^>]*>/u)?.[0];
    if (!img) continue;
    if (/loading="eager"/u.test(img)) eager++;
    for (const match of img.matchAll(/(?:src|data-fallback-src|srcset)="([^"]+)"/gu)) {
      for (const url of (match[1] ?? "").split(",").map((part) => part.trim().split(" ")[0] ?? "")) assert(!originalUrls.has(url), `${page}: original/upscaled image in card`);
    }
  }
  assert(eager <= 6, `${page}: too many eager card images (${eager})`);
}

for (const game of source.games) {
  for (const category of game.categories) {
    const file = path.join(dist, game.slug, category.slug, "index.html");
    if (!fs.existsSync(file)) continue;
    const html = fs.readFileSync(file, "utf8");
    for (const card of html.match(/<article class="resource-card[^>]*>[\s\S]*?<\/article>/gu) ?? []) {
      const img = card.match(/<img\b[^>]*>/u)?.[0];
      if (!img) continue;
      for (const match of img.matchAll(/(?:src|data-fallback-src|srcset)="([^"]+)"/gu)) {
        for (const url of (match[1] ?? "").split(",").map((part) => part.trim().split(" ")[0] ?? "")) assert(!originalUrls.has(url), `${game.slug}/${category.slug}: original/upscaled card image`);
      }
    }
  }
}
for (const update of source.updates) {
  const file = path.join(dist, "updates", update.id, "index.html");
  if (!fs.existsSync(file)) continue;
  const html = fs.readFileSync(file, "utf8");
  for (const card of html.match(/<a class="update-preview"[^>]*>[\s\S]*?<\/a>/gu) ?? []) {
    const img = card.match(/<img\b[^>]*>/u)?.[0];
    if (!img) continue;
    for (const match of img.matchAll(/(?:src|data-fallback-src)="([^"]+)"/gu)) assert(!originalUrls.has(match[1] ?? ""), `updates/${update.id}: original/upscaled preview`);
  }
}

console.log(JSON.stringify({ status: "PASS", measured }, null, 2));

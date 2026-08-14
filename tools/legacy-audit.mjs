import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const PROJECT_ROOT = process.cwd();
const LEGACY_ROOT = "E:\\rhythm-assets-gallery";
const ARCHIVE_ROOT = "E:\\曲绘";
const PUBLIC_ASSET_ROOT = path.join(LEGACY_ROOT, "public", "assets");
const OUTPUT_ROOT = path.join(PROJECT_ROOT, "docs", "audit", "data");
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif"]);
const APK_EXTENSIONS = new Set([".apk"]);

const legacyRequire = createRequire(path.join(LEGACY_ROOT, "package.json"));
let sharp;
try {
  sharp = legacyRequire("sharp");
} catch (error) {
  console.warn(`legacy-audit: sharp unavailable; archive image dimensions will be omitted: ${error.message}`);
}

function posix(value) {
  return value.split(path.sep).join("/");
}

function extName(fileName) {
  return path.extname(fileName).toLowerCase() || "[no extension]";
}

function classifyKind(fileName) {
  const ext = extName(fileName);
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (APK_EXTENSIONS.has(ext)) return "apk";
  if (ext === ".json") return "json";
  if (ext === ".py" || ext === ".bat" || ext === ".ps1" || ext === ".ts" || ext === ".js") return "script";
  return "other";
}

async function walk(root) {
  const result = [];
  async function visit(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile()) {
        const stat = await fs.stat(fullPath);
        result.push({
          fullPath,
          relativePath: posix(path.relative(root, fullPath)),
          sizeBytes: stat.size,
          mtimeMs: Math.trunc(stat.mtimeMs),
          extension: extName(entry.name),
          kind: classifyKind(entry.name),
        });
      }
    }
  }
  await visit(root);
  return result.sort((a, b) => a.relativePath.localeCompare(b.relativePath, "zh-CN"));
}

function archiveClassification(relativePath) {
  const parts = relativePath.split("/");
  const topLevel = parts[0] ?? "";
  const game = /arcaea/i.test(relativePath) ? "Arcaea" : /phigros/i.test(relativePath) ? "Phigros" : "Unknown";
  const versionMatch = topLevel.match(/(\d+(?:[._]\d+)+)/);
  const versionDirectory = versionMatch ? versionMatch[1].replaceAll("_", ".") : undefined;
  const gameIndex = parts.findIndex((part) => /^(?:arcaea|phigros)(?:（[^/]+）)?$/i.test(part));
  const afterGame = gameIndex >= 0 ? parts.slice(gameIndex + 1) : parts;
  let category = "Unknown";
  if (afterGame.includes("LinkPlay贴纸")) category = "LinkPlay贴纸";
  else if (afterGame.includes("剧情贴图")) category = "剧情贴图";
  else if (afterGame.includes("曲绘（AI超分后）")) category = "曲绘（AI超分后）";
  else if (afterGame.includes("曲绘")) category = "曲绘";
  else if (afterGame.includes("曲包封面")) category = "曲包封面";
  else if (afterGame.includes("LinkPlay预览")) category = "角色/LinkPlay预览";
  else if (afterGame.includes("立绘")) category = "角色/立绘";
  else if (afterGame.includes("头像")) category = "角色/头像";
  else if (afterGame.includes("启动页面")) category = "启动页面";
  else if (afterGame.includes("世界模式")) category = "世界模式";
  else if (afterGame.includes("游玩背景")) category = "游玩背景";
  else if (afterGame.includes("April Fools")) category = "April Fools";
  else if (afterGame.includes("剧情")) category = "剧情";
  else if (afterGame.some((segment) => /apk/i.test(segment))) category = "APK";
  return { topLevel, game, versionDirectory, category };
}

function normalizeSongArtKey(fileName) {
  return fileName
    .replace(/\.[^.]+$/, "")
    .replace(/\.(?:jpg|jpeg|png|webp|avif|gif)_opt$/i, "")
    .replace(/_opt$/i, "")
    .replace(/_optimization$/i, "")
    .normalize("NFC")
    .toLowerCase();
}

function hashRelativePath(relativePath) {
  return crypto.createHash("sha1").update(relativePath.normalize("NFC")).digest("hex").slice(0, 16);
}

function parseArcaeaDifficulty(fileName) {
  const stem = fileName.replace(/_opt\.(?:jpg|jpeg|png|webp|avif|gif)$/i, "").replace(/\.[^.]+$/, "");
  const match = stem.match(/_([0-4])$/i);
  if (!match) return undefined;
  return { code: Number(match[1]), label: ["PST", "PRS", "FTR", "BYD", "ETR"][Number(match[1])] };
}

function addStat(map, key, item) {
  const current = map.get(key) ?? { key, files: 0, sizeBytes: 0 };
  current.files += 1;
  current.sizeBytes += item.sizeBytes;
  map.set(key, current);
}

function statsBy(items, getKey) {
  const map = new Map();
  for (const item of items) addStat(map, getKey(item), item);
  return [...map.values()].sort((a, b) => b.files - a.files || a.key.localeCompare(b.key, "zh-CN"));
}

async function inspectImageDimensions(items) {
  if (!sharp) return [];
  const images = items.filter((item) => item.kind === "image");
  const output = [];
  let index = 0;
  const worker = async () => {
    while (true) {
      const currentIndex = index++;
      if (currentIndex >= images.length) return;
      const item = images[currentIndex];
      try {
        const metadata = await sharp(item.fullPath, { animated: true }).metadata();
        output[currentIndex] = {
          relativePath: item.relativePath,
          width: metadata.width,
          height: metadata.height,
          format: metadata.format,
          pages: metadata.pages,
        };
      } catch (error) {
        output[currentIndex] = { relativePath: item.relativePath, error: error.message };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, images.length) }, () => worker()));
  return output.filter(Boolean);
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fsSync.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const stream = fsSync.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function hashArchiveImages(items) {
  const images = items.filter((item) => item.kind === "image");
  const records = new Array(images.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const currentIndex = nextIndex++;
      if (currentIndex >= images.length) return;
      const item = images[currentIndex];
      try {
        records[currentIndex] = {
          relativePath: item.relativePath,
          sizeBytes: item.sizeBytes,
          sha256: await sha256File(item.fullPath),
        };
      } catch (error) {
        records[currentIndex] = { relativePath: item.relativePath, sizeBytes: item.sizeBytes, error: error.message };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, images.length) }, () => worker()));

  const hashGroups = groupBy(records.filter((item) => item.sha256), (item) => item.sha256);
  const duplicateGroups = [...hashGroups.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([sha256, group]) => ({ sha256, files: group.map((item) => item.relativePath).sort((a, b) => a.localeCompare(b, "zh-CN")), sizeBytes: group[0].sizeBytes }))
    .sort((a, b) => b.files.length - a.files.length || a.sha256.localeCompare(b.sha256));

  const byPath = new Map(records.filter((item) => item.sha256).map((item) => [item.relativePath, item.sha256]));
  const pairResults = [];
  const classifiedItems = items.map((item) => ({ ...item, ...archiveClassification(item.relativePath) }));
  for (const root of ["Arcaea", "Arcaea（至6.16.0）"]) {
    const rootItems = classifiedItems.filter((item) => item.kind === "image" && item.relativePath.startsWith(`${root}/`));
    const art = rootItems.filter((item) => item.game === "Arcaea" && ["曲绘", "曲绘（AI超分后）"].includes(item.category));
    const groups = groupBy(art, (item) => normalizeSongArtKey(path.posix.basename(item.relativePath)));
    let pairCount = 0;
    let sameContentCount = 0;
    for (const group of groups.values()) {
      const originals = group.filter((item) => item.category === "曲绘");
      const ais = group.filter((item) => item.category === "曲绘（AI超分后）");
      if (originals.length === 1 && ais.length === 1 && byPath.has(originals[0].relativePath) && byPath.has(ais[0].relativePath)) {
        pairCount += 1;
        if (byPath.get(originals[0].relativePath) === byPath.get(ais[0].relativePath)) sameContentCount += 1;
      }
    }
    pairResults.push({ root, pairCount, sameContentCount, differentContentCount: pairCount - sameContentCount });
  }

  return {
    filesHashed: records.filter((item) => item.sha256).length,
    hashErrors: records.filter((item) => item.error).map((item) => ({ relativePath: item.relativePath, error: item.error })),
    distinctHashes: hashGroups.size,
    duplicateHashGroupCount: duplicateGroups.length,
    duplicateFileCount: duplicateGroups.reduce((sum, item) => sum + item.files.length, 0),
    duplicateGroups,
    arcaeaOriginalAiPairs: pairResults,
    records,
  };
}

function fieldStats(items) {
  const fields = new Set(items.flatMap((item) => Object.keys(item)));
  return [...fields].sort().map((field) => {
    const present = items.filter((item) => item[field] !== undefined && item[field] !== null && item[field] !== "").length;
    const values = new Set(items.filter((item) => item[field] !== undefined && item[field] !== null && item[field] !== "").map((item) => JSON.stringify(item[field])));
    return { field, present, missing: items.length - present, uniqueNonEmpty: values.size };
  });
}

function groupBy(items, getKey) {
  const map = new Map();
  for (const item of items) {
    const key = getKey(item);
    if (!key) continue;
    const group = map.get(key) ?? [];
    group.push(item);
    map.set(key, group);
  }
  return map;
}

function indexRelationships(items) {
  const songArt = items.filter((item) => item.game === "Arcaea" && ["曲绘", "曲绘（AI超分后）"].includes(item.category));
  const songArtGroups = groupBy(songArt, (item) => normalizeSongArtKey(item.filename));
  const pairGroups = [];
  const onlyOriginal = [];
  const onlyAi = [];
  for (const [key, group] of songArtGroups) {
    const original = group.filter((item) => item.category === "曲绘");
    const ai = group.filter((item) => item.category === "曲绘（AI超分后）");
    const entry = { key, originalCount: original.length, aiCount: ai.length, originalIds: original.map((item) => item.id), aiIds: ai.map((item) => item.id) };
    if (original.length > 0 && ai.length > 0) pairGroups.push(entry);
    if (original.length > 0 && ai.length === 0) onlyOriginal.push(entry);
    if (ai.length > 0 && original.length === 0) onlyAi.push(entry);
  }
  const multipleSongIds = [];
  for (const [songId, group] of groupBy(items, (item) => item.songId)) {
    if (group.length > 1) {
      multipleSongIds.push({ songId, count: group.length, categories: [...new Set(group.map((item) => item.category))], difficulties: [...new Set(group.map((item) => item.difficulty).filter(Boolean))], filenames: group.map((item) => item.filename).slice(0, 20) });
    }
  }
  return {
    songArt: {
      files: songArt.length,
      uniqueNormalizedKeys: songArtGroups.size,
      pairGroups: pairGroups.length,
      onlyOriginalGroups: onlyOriginal.length,
      onlyAiGroups: onlyAi.length,
      pairGroupExamples: pairGroups.slice(0, 20),
      onlyOriginalExamples: onlyOriginal.slice(0, 20),
      onlyAiExamples: onlyAi.slice(0, 20),
    },
    multipleSongIds: multipleSongIds.sort((a, b) => b.count - a.count || a.songId.localeCompare(b.songId)).slice(0, 200),
    difficultyCounts: Object.fromEntries([...new Set(songArt.map((item) => item.difficulty ?? "[none]") )].sort().map((value) => [value, songArt.filter((item) => (item.difficulty ?? "[none]") === value).length])),
  };
}

function analyzeLegacyIndexes() {
  const arcaeaPath = path.join(LEGACY_ROOT, "public", "data", "arcaea-index.json");
  const phigrosPath = path.join(LEGACY_ROOT, "public", "data", "phigros-index.json");
  const arcaea = readJson(arcaeaPath, []);
  const phigros = readJson(phigrosPath, []);
  const all = [...arcaea, ...phigros];
  const idGroups = groupBy(all, (item) => item.id);
  const collisions = [...idGroups.entries()].filter(([, group]) => group.length > 1).map(([id, group]) => ({ id, paths: group.map((item) => item.relativePath) }));
  const idMismatches = all.filter((item) => hashRelativePath(item.relativePath) !== item.id).map((item) => ({ id: item.id, relativePath: item.relativePath }));
  const mtimeValues = all.map((item) => item.mtimeMs).filter((value) => Number.isFinite(value));
  const apkMeta = readJson(path.join(LEGACY_ROOT, "public", "data", "arcaea-apk.json"), {});
  const publicEntry = (item) => item ? {
    version: item.version,
    filename: item.filename,
    sizeBytes: item.sizeBytes,
    scrapedAt: item.scrapedAt,
    hasSourceUrl: Boolean(item.sourceUrl || item.url),
    hasLocalPath: Boolean(item.filePath),
  } : null;
  const apkPublic = {
    latest: publicEntry(apkMeta.latest),
    history: Array.isArray(apkMeta.history) ? apkMeta.history.map(publicEntry) : [],
    downloadCount: apkMeta.downloadCount,
    lastChecked: apkMeta.lastChecked,
  };
  return {
    files: { arcaea: arcaea.length, phigros: phigros.length, total: all.length },
    categories: {
      arcaea: statsBy(arcaea, (item) => item.category),
      phigros: statsBy(phigros, (item) => item.category),
    },
    fields: { arcaea: fieldStats(arcaea), phigros: fieldStats(phigros) },
    ids: { collisions: collisions.slice(0, 100), collisionGroupCount: collisions.length, stablePathMismatches: idMismatches.slice(0, 100), stablePathMismatchCount: idMismatches.length },
    relationships: { arcaea: indexRelationships(arcaea), phigros: indexRelationships(phigros) },
    dimensions: {
      arcaea: [...groupBy(arcaea, (item) => `${item.width ?? "?"}x${item.height ?? "?"}`).entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 50).map(([key, group]) => ({ key, files: group.length })),
      phigros: [...groupBy(phigros, (item) => `${item.width ?? "?"}x${item.height ?? "?"}`).entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 50).map(([key, group]) => ({ key, files: group.length })),
    },
    mtime: { minMs: Math.min(...mtimeValues), maxMs: Math.max(...mtimeValues), min: new Date(Math.min(...mtimeValues)).toISOString(), max: new Date(Math.max(...mtimeValues)).toISOString() },
    apk: apkPublic,
    metadataFile: (() => {
      const metadata = readJson(path.join(LEGACY_ROOT, "scripts", "data", "arcaea-metadata.json"), {});
      return { source: metadata.source, generatedAt: metadata.generatedAt, songs: metadata.songs?.length ?? 0, packs: metadata.packs?.length ?? 0, characters: metadata.characters?.length ?? 0, storyNodes: metadata.storyNodes?.length ?? 0 };
    })(),
    sampleRecords: { arcaea: arcaea.slice(0, 8), phigros: phigros.slice(0, 8) },
  };
}

function analyzeArchive(items, imageDimensions) {
  const classified = items.map((item) => ({ ...item, ...archiveClassification(item.relativePath) }));
  const imageMetaByPath = new Map(imageDimensions.map((item) => [item.relativePath, item]));
  const roots = statsBy(classified, (item) => item.topLevel);
  const directoryMap = new Map();
  for (const item of classified) {
    const parts = item.relativePath.split("/");
    for (let index = 1; index <= parts.length; index += 1) {
      const key = parts.slice(0, index).join("/");
      addStat(directoryMap, key, item);
    }
  }
  const dirStats = [...directoryMap.values()].sort((a, b) => a.key.localeCompare(b.key, "zh-CN"));
  const byRoot = new Map();
  for (const item of classified.filter((entry) => entry.kind === "image")) {
    const rootItems = byRoot.get(item.topLevel) ?? [];
    rootItems.push(item);
    byRoot.set(item.topLevel, rootItems);
  }
  const pairByRoot = [];
  for (const [root, rootItems] of byRoot) {
    const art = rootItems.filter((item) => item.game === "Arcaea" && ["曲绘", "曲绘（AI超分后）"].includes(item.category));
    const groups = groupBy(art, (item) => normalizeSongArtKey(path.posix.basename(item.relativePath)));
    let originalFiles = 0;
    let aiFiles = 0;
    let pairedAiFiles = 0;
    let pairedOriginalFiles = 0;
    const onlyAi = [];
    const onlyOriginal = [];
    for (const [key, group] of groups) {
      const originals = group.filter((item) => item.category === "曲绘");
      const ais = group.filter((item) => item.category === "曲绘（AI超分后）");
      originalFiles += originals.length;
      aiFiles += ais.length;
      if (originals.length > 0) pairedOriginalFiles += originals.length;
      if (ais.length > 0 && originals.length > 0) pairedAiFiles += ais.length;
      if (ais.length > 0 && originals.length === 0) onlyAi.push({ key, files: ais.map((item) => item.relativePath) });
      if (originals.length > 0 && ais.length === 0) onlyOriginal.push({ key, files: originals.map((item) => item.relativePath) });
    }
    pairByRoot.push({ root, originalFiles, aiFiles, uniqueKeys: groups.size, pairedOriginalFiles, pairedAiFiles, aiPairRate: aiFiles ? pairedAiFiles / aiFiles : null, originalPairRate: originalFiles ? pairedOriginalFiles / originalFiles : null, onlyAiCount: onlyAi.length, onlyOriginalCount: onlyOriginal.length, onlyAiExamples: onlyAi.slice(0, 20), onlyOriginalExamples: onlyOriginal.slice(0, 20) });
  }
  const specialDifficulty = classified.filter((item) => item.game === "Arcaea" && item.category === "曲绘").map((item) => ({ relativePath: item.relativePath, difficulty: parseArcaeaDifficulty(path.posix.basename(item.relativePath)) })).filter((item) => item.difficulty);
  const difficultyCounts = {};
  for (const item of specialDifficulty) difficultyCounts[item.difficulty.label] = (difficultyCounts[item.difficulty.label] ?? 0) + 1;
  const apkFiles = classified.filter((item) => item.kind === "apk").map(({ relativePath, sizeBytes, mtimeMs, topLevel, game, category }) => ({ relativePath, sizeBytes, mtimeMs, topLevel, game, category }));
  const auxiliaryFiles = classified.filter((item) => item.kind !== "image").map(({ relativePath, sizeBytes, extension, kind, mtimeMs, topLevel, game, category }) => ({ relativePath, sizeBytes, extension, kind, mtimeMs, topLevel, game, category }));
  const imageDimensionStats = statsBy(classified.filter((item) => item.kind === "image"), (item) => {
    const meta = imageMetaByPath.get(item.relativePath);
    return `${meta?.width ?? "?"}x${meta?.height ?? "?"}`;
  }).slice(0, 100);
  const versionDirectories = [...new Set(classified.map((item) => item.topLevel))].map((topLevel) => ({ topLevel, version: topLevel.match(/(\d+(?:[._]\d+)+)/)?.[1]?.replaceAll("_", ".") ?? null })).sort((a, b) => a.topLevel.localeCompare(b.topLevel, "zh-CN"));
  return {
    totals: { files: classified.length, sizeBytes: classified.reduce((sum, item) => sum + item.sizeBytes, 0), images: classified.filter((item) => item.kind === "image").length, apks: apkFiles.length, auxiliary: auxiliaryFiles.length },
    topLevel: roots,
    extensions: statsBy(classified, (item) => item.extension),
    kinds: statsBy(classified, (item) => item.kind),
    games: statsBy(classified, (item) => item.game),
    categories: statsBy(classified.filter((item) => item.kind === "image"), (item) => `${item.game}/${item.category}`),
    directoryStats: dirStats,
    versionDirectories,
    apkFiles,
    auxiliaryFiles,
    pairByRoot,
    specialDifficulty: { counts: difficultyCounts, total: specialDifficulty.length, examples: specialDifficulty.slice(0, 40) },
    imageDimensionStats,
    imageDimensionsFile: "archive-image-metadata.json",
    samples: {
      arcaeaOriginal: classified.filter((item) => item.game === "Arcaea" && item.category === "曲绘").slice(0, 12).map((item) => item.relativePath),
      arcaeaAi: classified.filter((item) => item.game === "Arcaea" && item.category === "曲绘（AI超分后）").slice(0, 12).map((item) => item.relativePath),
      phigrosArt: classified.filter((item) => item.game === "Phigros" && item.category === "曲绘").slice(0, 12).map((item) => item.relativePath),
      phigrosAvatars: classified.filter((item) => item.game === "Phigros" && item.category === "头像").slice(0, 12).map((item) => item.relativePath),
    },
  };
}

function analyzePublishedAssets(items, indexes) {
  const classified = items.map((item) => ({ ...item, ...archiveClassification(item.relativePath) }));
  const imageItems = classified.filter((item) => item.kind === "image");
  const indexed = [...(indexes.arcaea ?? []), ...(indexes.phigros ?? [])];
  const actualPaths = new Set(imageItems.map((item) => item.relativePath));
  const indexedPaths = new Set(indexed.map((item) => item.relativePath));
  const missingFromIndex = imageItems.filter((item) => !indexedPaths.has(item.relativePath)).map((item) => item.relativePath);
  const missingFromAssets = indexed.filter((item) => !actualPaths.has(item.relativePath)).map((item) => item.relativePath);
  const stableMismatches = indexed.filter((item) => hashRelativePath(item.relativePath) !== item.id).map((item) => ({ id: item.id, relativePath: item.relativePath }));
  return {
    totals: { files: classified.length, images: imageItems.length, nonImages: classified.length - imageItems.length, sizeBytes: classified.reduce((sum, item) => sum + item.sizeBytes, 0) },
    categories: statsBy(imageItems, (item) => `${item.game}/${item.category}`),
    missingFromIndex: { count: missingFromIndex.length, examples: missingFromIndex.slice(0, 50) },
    missingFromAssets: { count: missingFromAssets.length, examples: missingFromAssets.slice(0, 50) },
    indexedStableIdMismatches: { count: stableMismatches.length, examples: stableMismatches.slice(0, 50) },
    duplicateRelativePathsInIndex: (() => {
      const groups = groupBy(indexed, (item) => item.relativePath);
      return [...groups.entries()].filter(([, group]) => group.length > 1).map(([relativePath, group]) => ({ relativePath, count: group.length }));
    })(),
  };
}

async function writeJson(name, value) {
  await fs.writeFile(path.join(OUTPUT_ROOT, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main() {
  await fs.mkdir(OUTPUT_ROOT, { recursive: true });
  const archiveItems = await walk(ARCHIVE_ROOT);
  console.log(`legacy-audit: archive files=${archiveItems.length}`);
  const imageDimensions = await inspectImageDimensions(archiveItems);
  console.log(`legacy-audit: image dimensions=${imageDimensions.length}`);
  console.log("legacy-audit: hashing archive images for exact-duplicate and rendition evidence...");
  const archiveHashes = await hashArchiveImages(archiveItems);
  console.log(`legacy-audit: hashed=${archiveHashes.filesHashed}, duplicate-groups=${archiveHashes.duplicateHashGroupCount}`);
  const publishedItems = await walk(PUBLIC_ASSET_ROOT);
  const indexes = {
    arcaea: readJson(path.join(LEGACY_ROOT, "public", "data", "arcaea-index.json"), []),
    phigros: readJson(path.join(LEGACY_ROOT, "public", "data", "phigros-index.json"), []),
  };
  await writeJson("archive-image-metadata.json", imageDimensions);
  await writeJson("archive-inventory.json", analyzeArchive(archiveItems, imageDimensions));
  await writeJson("archive-hashes.json", archiveHashes);
  await writeJson("legacy-index-analysis.json", analyzeLegacyIndexes());
  await writeJson("published-assets-analysis.json", analyzePublishedAssets(publishedItems, indexes));
  console.log(`legacy-audit: wrote JSON data to ${OUTPUT_ROOT}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

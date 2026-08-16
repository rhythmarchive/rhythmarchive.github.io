import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import sharp from "sharp";
import type { ExtractorSourceInventoryRecord } from "./extractors.js";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif"]);
const TARGETS: Array<{ resourceType: ExtractorSourceInventoryRecord["resourceType"]; test: (value: string) => boolean }> = [
  { resourceType: "jacket", test: (value) => /^songs\/(?!pack\/)[^/]+\/1080_base(?:_[0-4])?\.(?:jpg|jpeg|png|webp)$/iu.test(value) && !/_256\./iu.test(value) },
  { resourceType: "pack-cover", test: (value) => /^songs\/pack\/.+\.(?:jpg|jpeg|png|webp)$/iu.test(value) },
  { resourceType: "story-cg", test: (value) => /^app-data\/story\/cg\/.+\.(?:jpg|jpeg|png|webp)$/iu.test(value) },
  { resourceType: "story-texture", test: (value) => /^app-data\/story\/vn\/res\/.+\.(?:jpg|jpeg|png|webp)$/iu.test(value) || /^img\/story\/.+\.(?:jpg|jpeg|png|webp)$/iu.test(value) },
  { resourceType: "character-portrait", test: (value) => /^char\/1080\/.+\.(?:jpg|jpeg|png|webp)$/iu.test(value) },
  { resourceType: "character-avatar", test: (value) => /^char\/[^/]+_icon\.(?:jpg|jpeg|png|webp)$/iu.test(value) },
  { resourceType: "linkplay-preview", test: (value) => /^char\/[^/]+_mp\.(?:jpg|jpeg|png|webp)$/iu.test(value) },
  { resourceType: "background", test: (value) => /^img\/bg\/1080\/.+\.(?:jpg|jpeg|png|webp)$/iu.test(value) },
  { resourceType: "sticker", test: (value) => /^img\/multiplayer\/stickers\/.+\.(?:jpg|jpeg|png|webp)$/iu.test(value) },
  { resourceType: "world-mode", test: (value) => /^img\/world\/1080\/(?!act).+\.(?:jpg|jpeg|png|webp)$/iu.test(value) },
  { resourceType: "startup", test: (value) => /^startup\/1080\/.+\.(?:jpg|jpeg|png|webp)$/iu.test(value) },
];

function normalizedRelative(value: string): string {
  return value.replace(/\\/gu, "/").replace(/^assets\//iu, "");
}

function targetFor(relativePath: string) {
  return TARGETS.find((target) => target.test(relativePath));
}

function variantFor(relativePath: string): string | undefined {
  const match = relativePath.match(/^songs\/[^/]+\/1080_base_([0-4])\./iu);
  if (!match) return undefined;
  return ["PST", "PRS", "FTR", "BYD", "ETR"][Number.parseInt(match[1]!, 10)];
}

function sourceIdentity(relativePath: string): { sourceKey: string; sourceKeyType: string } {
  const song = relativePath.match(/^songs\/(?!pack\/)([^/]+)\//iu);
  if (song) return { sourceKey: song[1]!.replace(/^dl_/iu, ""), sourceKeyType: "songId" };
  const pack = relativePath.match(/^songs\/pack\/([^/]+)\//iu);
  if (pack) return { sourceKey: pack[1]!, sourceKeyType: "packId" };
  const character = path.posix.basename(relativePath).match(/(?:^|_)(-?\d+)(?:_icon|_mp)?\.[^.]+$/iu);
  if (character) return { sourceKey: character[1]!, sourceKeyType: "characterId" };
  return { sourceKey: relativePath, sourceKeyType: "path" };
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

function run(command: string, args: string[], cwd: string): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => resolve({ code: 1, stdout: Buffer.concat(stdout), stderr: `${Buffer.concat(stderr).toString("utf8")}\n${error.message}` }));
    child.once("close", (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString("utf8") }));
  });
}

async function collectDirectoryFiles(rootPath: string): Promise<string[]> {
  const entries = await readdir(rootPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) files.push(...await collectDirectoryFiles(absolutePath));
    else if (entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(absolutePath);
  }
  return files;
}

async function inventoryFromAssets(assetsRoot: string): Promise<ExtractorSourceInventoryRecord[]> {
  const files = await collectDirectoryFiles(assetsRoot);
  const records: ExtractorSourceInventoryRecord[] = [];
  for (const absolutePath of files) {
    const relativePath = path.relative(assetsRoot, absolutePath).split(path.sep).join("/");
    const target = targetFor(relativePath);
    if (!target) continue;
    const metadata = await sharp(absolutePath, { animated: false }).metadata();
    if (!metadata.width || !metadata.height) throw new Error(`Arcaea source inventory image has no dimensions: ${relativePath}`);
    const identity = sourceIdentity(relativePath);
    records.push({
      resourceType: target.resourceType,
      sourceKey: identity.sourceKey,
      sourceKeyType: identity.sourceKeyType,
      ...(variantFor(relativePath) ? { variantKey: variantFor(relativePath) } : {}),
      sourceRelativePath: relativePath,
      width: metadata.width,
      height: metadata.height,
      imageContentHash: await sha256File(absolutePath),
      metadata: {},
    });
  }
  return records.sort((left, right) => (left.sourceRelativePath ?? "").localeCompare(right.sourceRelativePath ?? ""));
}

async function inventoryFromApk(apkPath: string, runtimeRoot: string): Promise<ExtractorSourceInventoryRecord[]> {
  const listing = await run("tar", ["-tf", apkPath], runtimeRoot);
  if (listing.code !== 0) throw new Error(`cannot list Arcaea APK with tar: ${listing.stderr.trim()}`);
  const entries = listing.stdout.toString("utf8").split(/\r?\n/u).map((entry) => entry.trim()).filter((entry) => entry.startsWith("assets/") && targetFor(normalizedRelative(entry)));
  const extractionRoot = await mkdtemp(path.join(runtimeRoot, "arcaea-inventory-"));
  try {
    for (let index = 0; index < entries.length; index += 80) {
      const extraction = await run("tar", ["-xf", apkPath, "-C", extractionRoot, ...entries.slice(index, index + 80)], runtimeRoot);
      if (extraction.code !== 0) throw new Error(`cannot extract Arcaea APK inventory: ${extraction.stderr.trim()}`);
    }
    return inventoryFromAssets(path.join(extractionRoot, "assets"));
  } finally {
    await rm(extractionRoot, { recursive: true, force: true });
  }
}

export async function buildArcaeaSourceInventory(options: { sourcePath: string; runtimeRoot: string }): Promise<ExtractorSourceInventoryRecord[]> {
  const sourcePath = path.resolve(options.sourcePath);
  const sourceStats = await stat(sourcePath);
  await mkdir(options.runtimeRoot, { recursive: true });
  if (sourceStats.isDirectory()) {
    const assetsRoot = path.basename(sourcePath).toLowerCase() === "assets" ? sourcePath : path.join(sourcePath, "assets");
    if (!(await stat(assetsRoot).catch(() => undefined))?.isDirectory()) throw new Error(`Arcaea source directory has no assets folder: ${sourcePath}`);
    return inventoryFromAssets(assetsRoot);
  }
  return inventoryFromApk(sourcePath, path.resolve(options.runtimeRoot));
}

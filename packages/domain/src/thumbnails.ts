import { mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { sha256File } from "./workspace.js";

export const THUMBNAIL_WIDTHS = [320, 640, 1280] as const;
export type ThumbnailWidth = typeof THUMBNAIL_WIDTHS[number];

export type PreviewSourceCandidate = {
  renditionType: "original" | "upscaled" | "unresolved";
};

/** Select one visual source for a Resource/Variant preview set. */
export function selectPreviewSource<T extends PreviewSourceCandidate>(candidates: readonly T[]): T | undefined {
  return candidates.find((candidate) => candidate.renditionType === "upscaled")
    ?? candidates.find((candidate) => candidate.renditionType === "original");
}

export type ThumbnailResult = {
  width: ThumbnailWidth;
  pixelWidth: number;
  relativePath: string;
  absolutePath: string;
  height: number;
  sizeBytes: number;
  sha256: string;
  mime: "image/webp";
};

export async function generateThumbnailSet(inputPath: string, outputDirectory: string, baseName: string): Promise<ThumbnailResult[]> {
  await mkdir(outputDirectory, { recursive: true });
  const results: ThumbnailResult[] = [];
  for (const width of THUMBNAIL_WIDTHS) {
    const filename = `${baseName}_${width}.webp`;
    const absolutePath = path.join(outputDirectory, filename);
    const partialPath = `${absolutePath}.partial-${process.pid}-${Date.now()}`;
    const output = await sharp(inputPath).resize({ width, withoutEnlargement: true }).webp().toFile(partialPath);
    await rename(partialPath, absolutePath);
    const file = await stat(absolutePath);
    results.push({ width, pixelWidth: output.width, relativePath: filename, absolutePath, height: output.height, sizeBytes: file.size, sha256: await sha256File(absolutePath), mime: "image/webp" });
  }
  return results;
}

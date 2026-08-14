import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  DEFAULT_JPEG_CONVERSION,
  convertOptimizationPngToJpeg,
  inspectImageAlpha,
} from "../packages/domain/src/index.js";

const imageDir = path.resolve("fixtures/phase2a/images");
const outputDir = path.resolve(".runtime/phase2a-upscale-experiment/processed");
await mkdir(outputDir, { recursive: true });

const inputPath = path.join(imageDir, "Acid God_optimization.png");
const transparentPath = path.join(imageDir, "Transparent_optimization.png");
const inputBytes = (await readFile(inputPath)).byteLength;
const alpha = await inspectImageAlpha(transparentPath);
const qualities = [92, 95, 97];
const results = [];

async function basicPixelDiff(leftPath: string, rightPath: string) {
  const left = await sharp(leftPath, { animated: false }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const right = await sharp(rightPath, { animated: false }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (left.info.width !== right.info.width || left.info.height !== right.info.height || left.info.channels !== right.info.channels) {
    return { comparable: false, reason: "dimension-or-channel-mismatch" };
  }
  let total = 0;
  let max = 0;
  let pixelsAboveFive = 0;
  const channelCount = left.info.channels;
  const pixelCount = left.info.width * left.info.height;
  for (let offset = 0; offset < left.data.length; offset += 1) {
    const difference = Math.abs(left.data[offset]! - right.data[offset]!);
    total += difference;
    if (difference > max) max = difference;
    if (difference > 5 && offset % channelCount === 0) pixelsAboveFive += 1;
  }
  return {
    comparable: true,
    meanAbsoluteChannelDifference: total / left.data.length,
    maxAbsoluteChannelDifference: max,
    pixelsAboveFiveRatio: pixelsAboveFive / pixelCount,
    width: left.info.width,
    height: left.info.height,
  };
}

for (const quality of qualities) {
  const outputPath = path.join(outputDir, `acid-god-q${quality}.jpg`);
  const result = await convertOptimizationPngToJpeg({
    inputPath,
    outputPath,
    overwrite: true,
    conversion: { ...DEFAULT_JPEG_CONVERSION, quality },
  });
  const pixelDiff = result.status === "converted" ? await basicPixelDiff(inputPath, outputPath) : null;
  results.push({ quality, result, pixelDiff });
}

const transparentResult = await convertOptimizationPngToJpeg({
  inputPath: transparentPath,
  outputPath: path.join(outputDir, "transparent-blocked.jpg"),
});

const report = {
  generatedAt: new Date().toISOString(),
  input: { path: "fixtures/phase2a/images/Acid God_optimization.png", bytes: inputBytes },
  parameters: { ...DEFAULT_JPEG_CONVERSION },
  alphaProbe: { path: "fixtures/phase2a/images/Transparent_optimization.png", ...alpha },
  qualityResults: results.map(({ quality, result, pixelDiff }) => ({
    quality,
    status: result.status,
    outputBytes: result.outputBytes,
    savingsRatio: result.outputBytes ? 1 - result.outputBytes / inputBytes : null,
    width: result.width,
    height: result.height,
    inputSha256: result.inputSha256,
    outputSha256: result.outputSha256,
    sourcePngRetained: result.sourcePngRetained,
    pixelDiff,
    message: result.message,
  })),
  transparentResult,
  note: "The input PNG is a V2 fixture derived from a copied historical AI JPG; no source archive file was modified.",
};

const reportPath = path.resolve("docs/design/upscale-experiment-2026-08-14.json");
await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
console.log(`report=${reportPath}`);

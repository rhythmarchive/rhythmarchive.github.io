import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { convertOptimizationPngToJpeg, inspectImageAlpha } from "../packages/domain/src/index.js";

const projectRoot = path.resolve(".");
const sourceDir = path.join(projectRoot, "fixtures", "phase2b", "images");
const inputDir = path.join(projectRoot, ".runtime", "phase2b-upscale-experiment", "inputs");
const outputDir = path.join(projectRoot, ".runtime", "phase2b-upscale-experiment", "processed");
const reportPath = path.join(projectRoot, "docs", "design", "upscale-experiment-2026-08-14-phase2b.json");
const samples = [
  { id: "acid-god-fixture", filename: path.join(projectRoot, "fixtures", "phase2a", "images", "Acid God_optimization.png") },
  { id: "bright-world", filename: path.join(sourceDir, "bright-world.jpg") },
  { id: "detail-story", filename: path.join(sourceDir, "detail-story.jpg") },
  { id: "gradient-background", filename: path.join(sourceDir, "gradient-background.jpg") },
  { id: "fine-text-pack", filename: path.join(sourceDir, "fine-text-pack.png") },
  { id: "phigros-text", filename: path.join(sourceDir, "phigros-text.png") },
];
const qualities = [92, 95, 97];

async function pixelDiff(leftPath: string, rightPath: string) {
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

await mkdir(inputDir, { recursive: true });
await mkdir(outputDir, { recursive: true });
const results = [];
for (const sample of samples) {
  const inputFilename = `${sample.id}_optimization.png`;
  const inputPath = path.join(inputDir, inputFilename);
  await sharp(sample.filename, { animated: false }).png({ compressionLevel: 9 }).toFile(inputPath);
  const inputBytes = (await readFile(inputPath)).byteLength;
  const alpha = await inspectImageAlpha(inputPath);
  const qualityResults = [];
  for (const quality of qualities) {
    const outputPath = path.join(outputDir, `${sample.id}-q${quality}.jpg`);
    const conversion = await convertOptimizationPngToJpeg({ inputPath, outputPath, overwrite: true, conversion: { quality, chromaSubsampling: "4:4:4", progressive: true, mozjpeg: false, alphaPolicy: "block", flattenBackground: "#ffffff" } });
    const diff = conversion.status === "converted" ? await pixelDiff(inputPath, outputPath) : null;
    qualityResults.push({ quality, status: conversion.status, outputBytes: conversion.outputBytes, reduction: conversion.outputBytes ? 1 - conversion.outputBytes / inputBytes : null, inputSha256: conversion.inputSha256, outputSha256: conversion.outputSha256, pixelDiff: diff, message: conversion.message });
  }
  results.push({ id: sample.id, source: path.relative(projectRoot, sample.filename).split(path.sep).join("/"), inputBytes, alpha, qualityResults });
}
const report = {
  generatedAt: new Date().toISOString(),
  parameters: { qualities, chromaSubsampling: "4:4:4", progressive: true, mozjpeg: false, alphaPolicy: "block", note: "quality 95 is a provisional safe default, not a universal optimum" },
  samples: results,
  note: "Five representative read-only copies from E:\\曲绘 plus the Phase 2A fixture were copied into V2 fixtures. The source directory was not modified; this is an engineering comparison, not a paper-quality visual study.",
};
await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
console.log(`report=${reportPath}`);

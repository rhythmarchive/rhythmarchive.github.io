import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { candidateFilenameAliasGroups, normalizeFilenameStem } from "./identity.js";
import type { Candidate, CandidateFile } from "./schema.js";

export type JpegConversionOptions = {
  quality: number;
  chromaSubsampling: "4:2:0" | "4:4:4";
  progressive: boolean;
  mozjpeg: boolean;
  alphaPolicy: "block" | "flatten-white" | "flatten-explicit";
  flattenBackground: string;
};

export const DEFAULT_JPEG_CONVERSION: JpegConversionOptions = {
  quality: 95,
  chromaSubsampling: "4:4:4" as const,
  progressive: true,
  mozjpeg: false,
  alphaPolicy: "block",
  flattenBackground: "#ffffff",
};

export type OptimizationOutput = Pick<CandidateFile, "id" | "filename" | "relativePath"> & {
  /** Optional metadata/upscale-manifest sidecar binding; explicit mapping wins over filename matching. */
  manifestCandidateId?: string;
  /** Multiple active sidecar bindings are an ambiguity, never a first-entry winner. */
  manifestCandidateIds?: string[];
};

export type OptimizationMatchResult = {
  output: OptimizationOutput;
  normalizedStem: string;
  state: "matched" | "ambiguous" | "unmatched";
  matchedBy: "filename-alias" | "manifest" | "manual";
  candidateIds: string[];
};

export function isOptimizationFilename(filename: string): boolean {
  return /(?:_optimization|_opt)\.(?:png|jpg|jpeg)$/iu.test(filename) || /\.jpg_opt\.(?:png|jpg|jpeg)$/iu.test(filename);
}

export function matchOptimizationOutputs(candidates: Candidate[], outputs: OptimizationOutput[]): OptimizationMatchResult[] {
  const aliases = candidates.map((candidate) => ({ candidate, groups: candidateFilenameAliasGroups(candidate) }));
  return outputs.map((output) => {
    const normalizedStem = normalizeFilenameStem(output.filename);
    if (!isOptimizationFilename(output.filename)) {
      return {
        output,
        normalizedStem,
        state: "unmatched" as const,
        matchedBy: "filename-alias" as const,
        candidateIds: [],
      };
    }
    const explicitCandidateIds = [...new Set([
      ...(output.manifestCandidateIds ?? []),
      ...(output.manifestCandidateId ? [output.manifestCandidateId] : []),
    ])];
    if (explicitCandidateIds.length > 0) {
      const explicitCandidates = explicitCandidateIds.filter((candidateId) => candidates.some((candidate) => candidate.id === candidateId));
      if (explicitCandidateIds.length > 1) {
        return {
          output,
          normalizedStem,
          state: "ambiguous" as const,
          matchedBy: "manifest" as const,
          candidateIds: explicitCandidates,
        };
      }
      const explicitCandidate = candidates.find((candidate) => candidate.id === explicitCandidateIds[0]);
      return {
        output,
        normalizedStem,
        state: explicitCandidate ? "matched" as const : "unmatched" as const,
        matchedBy: "manifest" as const,
        candidateIds: explicitCandidate ? [explicitCandidate.id] : [],
      };
    }
    for (const level of ["current", "known", "suggested", "source"] as const) {
      const candidateIds = aliases.filter((entry) => entry.groups[level].includes(normalizedStem)).map((entry) => entry.candidate.id);
      if (candidateIds.length === 0) continue;
      return {
        output,
        normalizedStem,
        state: candidateIds.length === 1 ? "matched" : "ambiguous",
        matchedBy: "filename-alias",
        candidateIds,
      };
    }
    return { output, normalizedStem, state: "unmatched", matchedBy: "filename-alias", candidateIds: [] };
  });
}

export async function inspectImageAlpha(inputPath: string) {
  const image = sharp(inputPath, { animated: false });
  const metadata = await image.metadata();
  const stats = metadata.hasAlpha ? await sharp(inputPath, { animated: false }).stats() : undefined;
  const isOpaque = !metadata.hasAlpha || stats?.isOpaque === true;
  return {
    hasAlphaChannel: metadata.hasAlpha === true,
    isOpaque,
    hasActualTransparency: metadata.hasAlpha === true && !isOpaque,
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
    format: metadata.format,
  };
}

export type ConversionResult = {
  status: "converted" | "skipped" | "blocked" | "failed";
  inputPath: string;
  outputPath: string;
  inputBytes: number;
  outputBytes?: number;
  inputSha256?: string;
  outputSha256?: string;
  width?: number;
  height?: number;
  hasActualTransparency?: boolean;
  quality?: number;
  chromaSubsampling?: "4:2:0" | "4:4:4";
  progressive?: boolean;
  mozjpeg?: boolean;
  alphaPolicy?: "block" | "flatten-white" | "flatten-explicit";
  flattenBackground?: string;
  sizeReductionBytes?: number;
  sizeReductionRatio?: number;
  sourcePngRetained: true;
  renditionType: "upscaled";
  message?: string;
};

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve());
  });
  return hash.digest("hex");
}

export async function convertOptimizationPngToJpeg(options: {
  inputPath: string;
  outputPath: string;
  overwrite?: boolean;
  conversion?: Partial<JpegConversionOptions>;
}): Promise<ConversionResult> {
  const conversion = { ...DEFAULT_JPEG_CONVERSION, ...options.conversion };
  const inputPath = path.resolve(options.inputPath);
  const outputPath = path.resolve(options.outputPath);
  const inputStats = await stat(inputPath);
  const inputSha256 = await sha256File(inputPath);
  if (inputPath === outputPath) {
    return {
      status: "failed",
      inputPath,
      outputPath,
      inputBytes: inputStats.size,
      inputSha256,
      sourcePngRetained: true,
      renditionType: "upscaled",
      message: "inputPath and outputPath must differ; source PNG is never overwritten",
    };
  }
  if (!/\.jpe?g$/iu.test(outputPath)) {
    return {
      status: "failed",
      inputPath,
      outputPath,
      inputBytes: inputStats.size,
      inputSha256,
      sourcePngRetained: true,
      renditionType: "upscaled",
      message: "processed output must use a .jpg or .jpeg extension",
    };
  }
  if (path.basename(path.dirname(outputPath)).toLowerCase() !== "processed") {
    return {
      status: "failed",
      inputPath,
      outputPath,
      inputBytes: inputStats.size,
      inputSha256,
      sourcePngRetained: true,
      renditionType: "upscaled",
      message: "processed JPEG output must be placed directly in a processed staging directory",
    };
  }
  const alpha = await inspectImageAlpha(inputPath);
  if (alpha.format !== "png") {
    return {
      status: "failed",
      inputPath,
      outputPath,
      inputBytes: inputStats.size,
      inputSha256,
      width: alpha.width,
      height: alpha.height,
      sourcePngRetained: true,
      renditionType: "upscaled",
      message: "conversion input must be a PNG optimization output",
    };
  }
  if (alpha.hasActualTransparency && conversion.alphaPolicy === "block") {
    return {
      status: "blocked",
      inputPath,
      outputPath,
      inputBytes: inputStats.size,
      inputSha256,
      width: alpha.width,
      height: alpha.height,
      hasActualTransparency: true,
      sourcePngRetained: true,
      renditionType: "upscaled",
      message: "PNG has actual transparency; choose an explicit flatten policy before JPEG conversion",
    };
  }
  let tempOutput: string | undefined;
  let backupOutput: string | undefined;
  try {
    try {
      const existing = await stat(outputPath);
      if (existing.isFile() && !options.overwrite) {
        const existingMetadata = await sharp(outputPath, { animated: false }).metadata();
        if (existingMetadata.format !== "jpeg" || existingMetadata.width !== alpha.width || existingMetadata.height !== alpha.height) {
          return {
            status: "failed",
            inputPath,
            outputPath,
            inputBytes: inputStats.size,
            inputSha256,
            width: alpha.width,
            height: alpha.height,
            hasActualTransparency: alpha.hasActualTransparency,
            sourcePngRetained: true,
            renditionType: "upscaled",
            message: "existing processed output is not a valid JPEG with matching dimensions; use explicit overwrite after review",
          };
        }
        return {
          status: "skipped",
          inputPath,
          outputPath,
          inputBytes: inputStats.size,
          inputSha256,
          outputBytes: existing.size,
          width: existingMetadata.width,
          height: existingMetadata.height,
          hasActualTransparency: alpha.hasActualTransparency,
          quality: conversion.quality,
          chromaSubsampling: conversion.chromaSubsampling,
          progressive: conversion.progressive,
          mozjpeg: conversion.mozjpeg,
          alphaPolicy: conversion.alphaPolicy,
          flattenBackground: conversion.flattenBackground,
          sizeReductionBytes: inputStats.size - existing.size,
          sizeReductionRatio: 1 - existing.size / inputStats.size,
          sourcePngRetained: true,
          renditionType: "upscaled",
          message: "output exists; use overwrite only for staging output replacement",
        };
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
    }
    await mkdir(path.dirname(outputPath), { recursive: true });
    tempOutput = `${outputPath}.partial-${process.pid}-${Date.now()}`;
    let pipeline = sharp(inputPath, { animated: false }).toColorspace("srgb");
    if (alpha.hasActualTransparency || conversion.alphaPolicy !== "block") {
      pipeline = pipeline.flatten({ background: conversion.flattenBackground });
    }
    await pipeline.jpeg({
      quality: conversion.quality,
      chromaSubsampling: conversion.chromaSubsampling,
      progressive: conversion.progressive,
      mozjpeg: conversion.mozjpeg,
    }).toFile(tempOutput);
    const outputMetadata = await sharp(tempOutput, { animated: false }).metadata();
    if (outputMetadata.format !== "jpeg" || !outputMetadata.width || !outputMetadata.height) {
      throw new Error("conversion output did not validate as a JPEG with dimensions");
    }
    if (outputMetadata.width !== alpha.width || outputMetadata.height !== alpha.height) {
      throw new Error("conversion output dimensions do not match the source PNG");
    }
    if (options.overwrite) {
      try {
        await stat(outputPath);
        backupOutput = `${outputPath}.backup-${process.pid}-${Date.now()}`;
        await rename(outputPath, backupOutput);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
        backupOutput = undefined;
      }
    }
    await rename(tempOutput, outputPath);
    tempOutput = undefined;
    if (backupOutput) {
      await rm(backupOutput, { force: true }).catch(() => undefined);
      backupOutput = undefined;
    }
    const outputStats = await stat(outputPath);
    return {
      status: "converted",
      inputPath,
      outputPath,
      inputBytes: inputStats.size,
      outputBytes: outputStats.size,
      inputSha256,
      outputSha256: await sha256File(outputPath),
      width: outputMetadata.width,
      height: outputMetadata.height,
      hasActualTransparency: alpha.hasActualTransparency,
      quality: conversion.quality,
      chromaSubsampling: conversion.chromaSubsampling,
      progressive: conversion.progressive,
      mozjpeg: conversion.mozjpeg,
      alphaPolicy: conversion.alphaPolicy,
      flattenBackground: conversion.flattenBackground,
      sizeReductionBytes: inputStats.size - outputStats.size,
      sizeReductionRatio: 1 - outputStats.size / inputStats.size,
      sourcePngRetained: true,
      renditionType: "upscaled",
    };
  } catch (error) {
    if (tempOutput) await rm(tempOutput, { force: true });
    if (backupOutput) {
      await rm(outputPath, { force: true }).catch(() => undefined);
      await rename(backupOutput, outputPath).catch(() => undefined);
    }
    return {
      status: "failed",
      inputPath,
      outputPath,
      inputBytes: inputStats.size,
      inputSha256,
      width: alpha.width,
      height: alpha.height,
      hasActualTransparency: alpha.hasActualTransparency,
      sourcePngRetained: true,
      renditionType: "upscaled",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

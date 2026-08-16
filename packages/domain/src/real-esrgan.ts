import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const DEFAULT_EXECUTABLE = "D:\\Users\\30578\\AppData\\Local\\Programs\\ArSrNaUIESRGAN\\resources\\assets\\realsgan\\realesrgan-ncnn-vulkan.exe";
const DEFAULT_MODEL_DIR = "D:\\Users\\30578\\AppData\\Local\\Programs\\ArSrNaUIESRGAN\\resources\\assets\\realsgan\\models";
const DEFAULT_MODEL = "realesrgan-x4plus-anime";

export type RealEsrganConfig = {
  executable: string;
  modelDir: string;
  modelName: string;
  scale: 4;
  tile: 0;
  gpu: "auto";
  jobs: "1:2:2";
};

export type RealEsrganCommand = {
  command: string;
  args: string[];
  cwd: string;
};

export type RealEsrganVerification = {
  ok: boolean;
  message: string;
  inputWidth?: number;
  inputHeight?: number;
  outputWidth?: number;
  outputHeight?: number;
  outputFormat?: string;
  outputBytes?: number;
  outputHasAlpha?: boolean;
};

export type RealEsrganRunResult = {
  status: "completed" | "failed";
  command: RealEsrganCommand;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outputPath: string;
  verification: RealEsrganVerification;
  fingerprint: string;
};

function configured(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? path.resolve(normalized) : undefined;
}

async function existingFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function resolveFile(configuredPath: string | undefined, fallback: string, label: string): Promise<string> {
  const candidate = configuredPath ?? fallback;
  if (!(await existingFile(candidate))) throw new Error(`${label} not found: ${candidate}`);
  return candidate;
}

export async function resolveRealEsrganConfig(overrides: {
  executable?: string;
  modelDir?: string;
  modelName?: string;
} = {}): Promise<RealEsrganConfig> {
  const executable = await resolveFile(
    configured(overrides.executable) ?? configured(process.env.REAL_ESRGAN_EXECUTABLE),
    DEFAULT_EXECUTABLE,
    "Real-ESRGAN executable",
  );
  const modelDir = path.resolve(configured(overrides.modelDir) ?? configured(process.env.REAL_ESRGAN_MODEL_DIR) ?? DEFAULT_MODEL_DIR);
  const modelName = overrides.modelName?.trim() || process.env.REAL_ESRGAN_MODEL?.trim() || DEFAULT_MODEL;
  if (!(await existingFile(path.join(modelDir, `${modelName}.bin`))) || !(await existingFile(path.join(modelDir, `${modelName}.param`)))) {
    throw new Error(`Real-ESRGAN model not found: ${path.join(modelDir, modelName)}`);
  }
  return { executable, modelDir, modelName, scale: 4, tile: 0, gpu: "auto", jobs: "1:2:2" };
}

export function realEsrganFingerprint(config: RealEsrganConfig): string {
  return [config.executable, config.modelDir, config.modelName, `scale=${config.scale}`, `tile=${config.tile}`, `gpu=${config.gpu}`, `jobs=${config.jobs}`].join("|");
}

/**
 * The UI invokes the bundled CLI with only -i, -o and -n. Keep that call
 * shape when the configured model directory is the CLI's sibling models/
 * directory; explicit -m is only needed for a relocated installation.
 */
export function buildRealEsrganCommand(config: RealEsrganConfig, inputPath: string, outputPath: string): RealEsrganCommand {
  const cwd = path.dirname(config.executable);
  const siblingModels = path.resolve(cwd, "models").toLowerCase() === path.resolve(config.modelDir).toLowerCase();
  const args = ["-i", inputPath, "-o", outputPath, "-n", config.modelName];
  if (!siblingModels) args.push("-m", config.modelDir);
  return { command: config.executable, args, cwd };
}

export async function verifyRealEsrganOutput(inputPath: string, outputPath: string, scale = 4): Promise<RealEsrganVerification> {
  try {
    const [input, output, outputStats] = await Promise.all([
      sharp(inputPath).metadata(),
      sharp(outputPath).metadata(),
      stat(outputPath),
    ]);
    if (!input.width || !input.height || !output.width || !output.height) return { ok: false, message: "input or output has no readable dimensions" };
    const expectedWidth = input.width * scale;
    const expectedHeight = input.height * scale;
    if (output.width !== expectedWidth || output.height !== expectedHeight) {
      return { ok: false, message: `output dimensions ${output.width}x${output.height} do not equal ${expectedWidth}x${expectedHeight}`, inputWidth: input.width, inputHeight: input.height, outputWidth: output.width, outputHeight: output.height, outputFormat: output.format, outputBytes: outputStats.size, outputHasAlpha: output.hasAlpha };
    }
    if (output.hasAlpha && !input.hasAlpha) {
      const alphaStats = (await sharp(outputPath).stats()).channels.at(-1);
      if (alphaStats && alphaStats.min < 255) return { ok: false, message: "output introduced non-opaque alpha", inputWidth: input.width, inputHeight: input.height, outputWidth: output.width, outputHeight: output.height, outputFormat: output.format, outputBytes: outputStats.size, outputHasAlpha: true };
    }
    return { ok: true, message: "output dimensions and image metadata verified", inputWidth: input.width, inputHeight: input.height, outputWidth: output.width, outputHeight: output.height, outputFormat: output.format, outputBytes: outputStats.size, outputHasAlpha: output.hasAlpha };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function trimOutput(value: string): string {
  return value.length > 20000 ? value.slice(-20000) : value;
}

export async function runRealEsrgan(options: { config: RealEsrganConfig; inputPath: string; outputPath: string }): Promise<RealEsrganRunResult> {
  const command = buildRealEsrganCommand(options.config, options.inputPath, options.outputPath);
  const fingerprint = realEsrganFingerprint(options.config);
  const output = await new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command.command, command.args, { cwd: command.cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk: Buffer | string) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout: trimOutput(stdout), stderr: trimOutput(stderr) }));
  }).catch((error) => ({ exitCode: null, stdout: "", stderr: error instanceof Error ? error.message : String(error) }));
  const verification = output.exitCode === 0 ? await verifyRealEsrganOutput(options.inputPath, options.outputPath, options.config.scale) : { ok: false, message: `CLI exited with code ${output.exitCode}` };
  return {
    status: output.exitCode === 0 && verification.ok ? "completed" : "failed",
    command,
    exitCode: output.exitCode,
    stdout: output.stdout,
    stderr: output.stderr,
    outputPath: options.outputPath,
    verification,
    fingerprint,
  };
}

export const REAL_ESRGAN_DEFAULTS = { executable: DEFAULT_EXECUTABLE, modelDir: DEFAULT_MODEL_DIR, modelName: DEFAULT_MODEL } as const;

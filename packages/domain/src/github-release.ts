import { execFile as execFileCallback, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export const ARCAEA_GITHUB_REPOSITORY = "rhythmarchive/rhythmarchive.github.io";
export const MANAGED_ARCAEA_RELEASE_TAG_PREFIX = "arcaea-apk-";

export type GitHubReleaseAsset = {
  id: number;
  name: string;
  size: number;
  digest?: string | null;
  browserDownloadUrl?: string;
};

export type GitHubRelease = {
  id: number;
  tagName: string;
  name: string;
  assets: GitHubReleaseAsset[];
};

export type GitHubReleaseClient = {
  getRelease(tagName: string): Promise<GitHubRelease | null>;
  createRelease(input: { tagName: string; title: string }): Promise<GitHubRelease>;
  uploadAsset(input: { tagName: string; filePath: string; fileName: string }): Promise<GitHubReleaseAsset>;
  deleteAsset(input: { releaseId: number; assetId: number }): Promise<void>;
  deleteRelease(input: { releaseId: number; tagName: string }): Promise<void>;
};

type GhError = {
  stderr?: unknown;
  stdout?: unknown;
};

function ghEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  if (!environment.GH_TOKEN && environment.GITHUB_TOKEN) environment.GH_TOKEN = environment.GITHUB_TOKEN;
  return environment;
}

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as GhError;
  return /(?:HTTP\s+)?404(?:\b|:)/iu.test(`${String(value.stderr ?? "")} ${String(value.stdout ?? "")}`);
}

async function runGh(args: string[], options: { allowNotFound?: boolean } = {}): Promise<string | undefined> {
  try {
    const result = await execFile("gh", args, {
      env: ghEnvironment(),
      maxBuffer: 4 * 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    if (options.allowNotFound && isNotFoundError(error)) return undefined;
    throw new Error("GitHub CLI operation failed.");
  }
}

async function runGhWithInheritedOutput(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("gh", args, { env: ghEnvironment(), stdio: "inherit" });
    child.once("error", () => reject(new Error("GitHub CLI operation failed.")));
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error("GitHub CLI operation failed."));
    });
  });
}

function apiPath(repository: string, suffix: string): string {
  return `repos/${repository}/${suffix}`;
}

function mapAsset(value: unknown): GitHubReleaseAsset | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "number" || !Number.isSafeInteger(record.id) || typeof record.name !== "string" || typeof record.size !== "number" || !Number.isSafeInteger(record.size) || record.size < 0) return null;
  return {
    id: record.id,
    name: record.name,
    size: record.size,
    ...(typeof record.digest === "string" || record.digest === null ? { digest: record.digest } : {}),
    ...(typeof record.browser_download_url === "string" ? { browserDownloadUrl: record.browser_download_url } : {}),
  };
}

function mapRelease(value: unknown): GitHubRelease | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "number" || !Number.isSafeInteger(record.id) || typeof record.tag_name !== "string" || typeof record.name !== "string" || !Array.isArray(record.assets)) return null;
  const assets = record.assets.map(mapAsset);
  if (assets.some((asset) => !asset)) return null;
  return { id: record.id, tagName: record.tag_name, name: record.name, assets: assets as GitHubReleaseAsset[] };
}

function parseRelease(output: string | undefined): GitHubRelease {
  if (!output) throw new Error("GitHub Release response was empty.");
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error("GitHub Release response was invalid.");
  }
  const release = mapRelease(value);
  if (!release) throw new Error("GitHub Release response was invalid.");
  return release;
}

export function createGhGitHubReleaseClient(repository = ARCAEA_GITHUB_REPOSITORY): GitHubReleaseClient {
  return {
    async getRelease(tagName) {
      const output = await runGh(["api", apiPath(repository, `releases/tags/${encodeURIComponent(tagName)}`)], { allowNotFound: true });
      return output === undefined ? null : parseRelease(output);
    },

    async createRelease(input) {
      await runGh([
        "release",
        "create",
        input.tagName,
        "--repo",
        repository,
        "--title",
        input.title,
        "--notes",
        input.title,
      ]);
      const release = await this.getRelease(input.tagName);
      if (!release) throw new Error("GitHub Release was created but could not be read back.");
      return release;
    },

    async uploadAsset(input) {
      await runGhWithInheritedOutput(["release", "upload", input.tagName, input.filePath, "--repo", repository]);
      const release = await this.getRelease(input.tagName);
      const asset = release?.assets.find((candidate) => candidate.name === input.fileName);
      if (!asset) throw new Error("GitHub Release asset was uploaded but could not be read back.");
      return asset;
    },

    async deleteAsset(input) {
      await runGh(["api", "--method", "DELETE", apiPath(repository, `releases/assets/${input.assetId}`)]);
    },

    async deleteRelease(input) {
      if (!input.tagName.startsWith(MANAGED_ARCAEA_RELEASE_TAG_PREFIX)) throw new Error("Refusing to delete an unmanaged GitHub Release.");
      await runGh(["api", "--method", "DELETE", apiPath(repository, `releases/${input.releaseId}`)]);
      try {
        await runGh(["api", "--method", "DELETE", apiPath(repository, `git/refs/tags/${encodeURIComponent(input.tagName)}`)], { allowNotFound: true });
      } catch {
        // The release is already gone; a missing tag is safe to leave for a later manual cleanup.
      }
    },
  };
}

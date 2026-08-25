import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type LocalReleasePreflight = {
  ci: "PASS";
  gitDiffCheck: "PASS";
  gitStatus: string;
  commands: string[];
};

export async function runLocalReleasePreflight(repoRoot: string): Promise<LocalReleasePreflight> {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const npmExecutable = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : npm;
  const npmArguments = process.platform === "win32" ? ["/d", "/s", "/c", npm + " run ci:check"] : ["run", "ci:check"];
  const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ["ROS_ACCESS_KEY", "ROS_SECRET_KEY", "ROS_ENDPOINT", "ROS_BUCKET", "ROS_PUBLIC_BASE_URL"]) delete cleanEnv[key];

  try {
    await execFileAsync(npmExecutable, npmArguments, { cwd: repoRoot, env: cleanEnv, maxBuffer: 128 * 1024 * 1024 });
  } catch (error) {
    const detail = error as { message?: string; stderr?: string; stdout?: string };
    const output = [detail.message, detail.stderr?.slice(-2000), detail.stdout?.slice(-2000)].filter(Boolean).join("\n");
    throw new Error(output || "npm run ci:check failed");
  }
  await execFileAsync("git", ["diff", "--check"], { cwd: repoRoot, maxBuffer: 4 * 1024 * 1024 });
  const status = await execFileAsync("git", ["status", "--short", "--branch"], { cwd: repoRoot, maxBuffer: 4 * 1024 * 1024 });
  return {
    ci: "PASS",
    gitDiffCheck: "PASS",
    gitStatus: status.stdout.trim(),
    commands: ["npm run ci:check", "git diff --check", "git status --short --branch"],
  };
}

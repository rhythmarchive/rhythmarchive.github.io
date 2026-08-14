import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  computeUpdateBatchProgress,
  createVersionWorkspace,
  loadWorkspaceState,
  prepareUpscaleInputs,
  reconcileUpscaleOutputs,
  reconcileWorkspace,
  scanWorkspace,
} from "../packages/domain/src/index.js";
import type { CandidateManifestAdapterInput } from "../packages/domain/src/index.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function required(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

const command = process.argv[2];
const root = option("--root");
if (!command) throw new Error("usage: create|scan|reconcile|prepare-upscale|reconcile-upscale|progress");

if (command === "create") {
  const manifestPath = path.resolve(required("--manifest"));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as CandidateManifestAdapterInput;
  const workspace = await createVersionWorkspace({
    ...(root ? { rootPath: path.resolve(root) } : {}),
    game: manifest.game,
    baseVersion: required("--base"),
    targetVersion: required("--target"),
    sourceManifest: manifest,
  });
  console.log(JSON.stringify({ rootPath: workspace.rootPath, created: workspace.created, batchId: workspace.batch.id, candidateIds: workspace.batch.candidateIds }, null, 2));
} else if (command === "scan") {
  console.log(JSON.stringify(await scanWorkspace(path.resolve(required("--root"))), null, 2));
} else if (command === "reconcile") {
  console.log(JSON.stringify(await reconcileWorkspace(path.resolve(required("--root"))), null, 2));
} else if (command === "prepare-upscale") {
  console.log(JSON.stringify(await prepareUpscaleInputs(path.resolve(required("--root"))), null, 2));
} else if (command === "reconcile-upscale") {
  console.log(JSON.stringify(await reconcileUpscaleOutputs(path.resolve(required("--root"))), null, 2));
} else if (command === "progress") {
  const state = await loadWorkspaceState(path.resolve(required("--root")));
  console.log(JSON.stringify({ batch: state.batch, progress: computeUpdateBatchProgress(state.candidates) }, null, 2));
} else {
  throw new Error(`unknown command ${command}`);
}

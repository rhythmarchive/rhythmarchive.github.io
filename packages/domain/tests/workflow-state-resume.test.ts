import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  canTransitionWorkflow,
  createWorkflowState,
  loadWorkflowState,
  recordWorkflowArtifact,
  saveWorkflowState,
  transitionWorkflowState,
  workflowResumeInfo,
} from "../src/workflow-state.js";

test("WorkflowState persists artifacts and reports the next resumable step", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rhythm-state-"));
  try {
    const statePath = path.join(root, "state.json");
    const artifactPath = path.join(root, "candidate-manifest.json");
    const initial = createWorkflowState({ gameId: "arcaea", version: "status-test", sourcePath: "C:\\source.apk" });
    await saveWorkflowState(initial, statePath);
    const stored = await recordWorkflowArtifact(statePath, {
      name: "candidate-manifest",
      path: artifactPath,
      kind: "manifest",
      createdAt: "2026-08-25T00:00:00.000Z",
    });
    const loaded = await loadWorkflowState(statePath);
    assert.equal(stored.artifacts[0]?.path, artifactPath);
    assert.equal(loaded.artifacts[0]?.path, artifactPath);
    assert.equal(workflowResumeInfo(loaded).nextStep, "ingest");
    assert.equal(workflowResumeInfo(loaded).resumable, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("blocked workflows cannot complete or skip their saved resume phase", () => {
  const initial = createWorkflowState({ gameId: "arcaea", version: "blocked-test", sourcePath: "C:\\source.apk" });
  const blocked = transitionWorkflowState(transitionWorkflowState(initial, "ingest"), "blocked", { blockers: ["fixture blocker"] });
  assert.equal(canTransitionWorkflow("blocked", "complete"), false);
  assert.throws(() => transitionWorkflowState(blocked, "complete"), /invalid workflow transition|blocked workflow/u);
  assert.throws(() => transitionWorkflowState(blocked, "extract"), /blocked workflow must resume/u);
  const content = createWorkflowState({ gameId: "manual", version: "content-test", sourcePath: "C:\\content.json", workflowKind: "content-addition" });
  assert.equal(canTransitionWorkflow(content.phase, "normalize", content.workflowKind), true);
  const normalized = createWorkflowState({ gameId: "arcaea", version: "phase-boundary", sourcePath: "C:\\manifest.json", phase: "normalize" });
  assert.deepEqual(normalized.completedSteps, ["normalize"]);
});

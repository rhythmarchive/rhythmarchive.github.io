import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("Arcaea updater workflow uses the required schedule and serialized concurrency group", async () => {
  const workflow = await readFile(path.resolve(".github", "workflows", "arcaea-apk-update.yml"), "utf8");
  assert.match(workflow, /cron:\s*["']15 1,7,13,19 \* \* \*["']/u);
  assert.match(workflow, /concurrency:\s*\n\s+group:\s*arcaea-apk-update\s*\n\s+cancel-in-progress:\s*false/u);
  assert.match(workflow, /mode:\s*\n\s+description:/u);
  assert.match(workflow, /--with-deps chromium/u);
});

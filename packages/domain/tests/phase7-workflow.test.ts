import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("Arcaea updater workflow uses the required schedule and serialized concurrency group", async () => {
  const workflow = await readFile(path.resolve(".github", "workflows", "arcaea-apk-update.yml"), "utf8");
  const updaterPackage = await readFile(path.resolve("tools", "arcaea-apk-updater", "package.json"), "utf8");
  assert.match(workflow, /cron:\s*["']\*\/30 \* \* \* \*["']/u);
  assert.match(workflow, /concurrency:\s*\n\s+group:\s*arcaea-apk-update\s*\n\s+cancel-in-progress:\s*false/u);
  assert.match(workflow, /mode:\s*\n\s+description:/u);
  assert.match(workflow, /permissions:\s*\n\s+contents:\s*write/u);
  assert.match(workflow, /GITHUB_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/u);
  assert.match(workflow, /cache-dependency-path:\s*tools\/arcaea-apk-updater\/package-lock\.json/u);
  assert.match(workflow, /run:\s*npm --prefix tools\/arcaea-apk-updater ci --no-audit --no-fund/u);
  assert.match(workflow, /run:\s*ln -s tools\/arcaea-apk-updater\/node_modules node_modules/u);
  assert.match(workflow, /run:\s*npm --prefix tools\/arcaea-apk-updater run check/u);
  assert.doesNotMatch(workflow, /run:\s*npm ci\s*$/mu);
  assert.doesNotMatch(workflow, /playwright|chromium/iu);
  assert.match(updaterPackage, /"@aws-sdk\/client-s3"/u);
  assert.match(updaterPackage, /"@aws-sdk\/lib-storage"/u);
  assert.match(updaterPackage, /"tsx"/u);
  assert.doesNotMatch(updaterPackage, /astro|sharp|@astrojs\/check/iu);
});

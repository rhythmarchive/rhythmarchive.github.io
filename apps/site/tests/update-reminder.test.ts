import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  classifyUpdateReminderResponse,
  submitUpdateReminder,
} from "../src/lib/update-reminder-client";

const visitorId = "11111111-1111-7111-8111-111111111111";
const siteRoot = path.resolve(process.cwd(), "apps", "site");

test("update reminder posts the documented visitor/game payload to the future endpoint", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const result = await submitUpdateReminder({
    apiUrl: "https://stats.example.test///",
    visitorId,
    game: "arcaea",
    fetchImpl: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return new Response(JSON.stringify({ ok: true, status: "accepted" }), { status: 202 });
    },
  });

  assert.deepEqual(result, { status: "accepted" });
  assert.equal(requestUrl, "https://stats.example.test/v1/update-reminders");
  assert.equal(requestInit?.method, "POST");
  assert.deepEqual(requestInit?.headers, { "Content-Type": "application/json" });
  assert.equal(requestInit?.credentials, "omit");
  assert.deepEqual(JSON.parse(String(requestInit?.body)), { visitorId, game: "arcaea" });
});

test("update reminder response classification distinguishes accepted, duplicate, and failure", () => {
  assert.equal(classifyUpdateReminderResponse(202, { ok: true, status: "accepted" }), "accepted");
  assert.equal(classifyUpdateReminderResponse(409, { ok: false, status: "duplicate" }), "duplicate");
  assert.equal(classifyUpdateReminderResponse(200, { ok: false, code: "already_reminded" }), "duplicate");
  assert.equal(classifyUpdateReminderResponse(503, { ok: false, status: "error" }), "failed");
});

test("missing configuration and network failures resolve to safe UI errors without throwing", async () => {
  let fetchCalls = 0;
  const notConfigured = await submitUpdateReminder({
    visitorId,
    game: "arcaea",
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response("", { status: 500 });
    },
  });
  assert.deepEqual(notConfigured, { status: "failed", reason: "not-configured" });
  assert.equal(fetchCalls, 0);

  const unavailable = await submitUpdateReminder({
    apiUrl: "https://stats.example.test",
    visitorId,
    game: "arcaea",
    fetchImpl: async () => {
      throw new Error("network down");
    },
  });
  assert.deepEqual(unavailable, { status: "failed", reason: "network" });
});

test("update reminder keeps markup, public game data, and client state in their own boundaries", () => {
  const recent = fs.readFileSync(path.join(siteRoot, "src", "components", "RecentUpdates.astro"), "utf8");
  const component = fs.readFileSync(path.join(siteRoot, "src", "components", "UpdateReminder.astro"), "utf8");
  const client = fs.readFileSync(path.join(siteRoot, "src", "scripts", "update-reminder.ts"), "utf8");
  const config = fs.readFileSync(path.join(siteRoot, "src", "lib", "site-config.ts"), "utf8");
  const styles = fs.readFileSync(path.join(siteRoot, "src", "styles", "global.css"), "utf8");

  assert.match(recent, /getPublicNavigationGames/u);
  assert.match(recent, /<UpdateReminder games=\{updateReminderGames\} \/>/u);
  assert.doesNotMatch(recent, /data-update-reminder-form/u);
  assert.match(component, /games\.map/u);
  assert.match(component, /game\.displayName/u);
  assert.match(component, /data-update-reminder-form/u);
  assert.doesNotMatch(component, /Arcaea|Phigros|Rizline|Rotaeno/u);
  assert.match(client, /getBrowserStatsClient/u);
  assert.match(client, /submitting/u);
  assert.match(client, /已收到提醒/u);
  assert.match(client, /最近已经提醒过/u);
  assert.match(client, /暂时没能送出提醒/u);
  assert.match(config, /PUBLIC_UPDATE_REMINDERS_ENABLED/u);
  assert.match(styles, /\.update-reminder/u);
});

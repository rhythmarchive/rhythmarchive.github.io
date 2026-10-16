import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { ANNOUNCEMENT_READ_KEY, createAnnouncementReadState } from "../src/lib/announcement-read-state";
import { announcements } from "../src/data/announcements";

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

test("read announcements survive navigation and reload; new ids remain unread across tabs", () => {
  const local = storage();
  const first = createAnnouncementReadState([local]);
  assert.equal(first.has("release-one"), false);
  first.mark("release-one");
  assert.equal(first.has("release-one"), true);
  const anotherTab = createAnnouncementReadState([local]);
  assert.equal(anotherTab.has("release-one"), true);
  assert.equal(anotherTab.has("release-two"), false);
  anotherTab.mark("release-two");
  assert.equal(first.has("release-two"), true);
  first.mark("release-three");
  assert.equal(anotherTab.has("release-one"), true);
});

test("corrupt or blocked storage falls back without repeating a notice during navigation", () => {
  const local = storage();
  local.setItem(ANNOUNCEMENT_READ_KEY, "{broken");
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  const session = storage();
  const read = createAnnouncementReadState([blocked, local, session]);
  read.mark("new-notice");
  assert.equal(createAnnouncementReadState([blocked, session]).has("new-notice"), true);
  const memory = createAnnouncementReadState([blocked]);
  memory.mark("new-notice");
  assert.equal(memory.has("new-notice"), true);
});

test("automatic display requires an explicit notification flag and an unread stable id", () => {
  const local = storage();
  const read = createAnnouncementReadState([local]);
  assert.equal(read.shouldNotify(undefined), false);
  assert.equal(read.shouldNotify({ id: "history-only" }), false);
  assert.equal(read.shouldNotify({ id: "quiet-notice", notify: false }), false);
  const release = { id: "website-v4-0-0", notify: true, title: "v4.0.0", date: "2026-10-16" };
  assert.equal(read.shouldNotify(release), true);
  read.mark(release.id);
  const afterReload = createAnnouncementReadState([local]);
  const edited = { ...release, title: "Corrected title", date: "2026-10-17", changelog: "Updated history", commit: "another commit", deployment: "another deployment" };
  assert.equal(afterReload.shouldNotify(edited), false);
  assert.equal(afterReload.shouldNotify({ id: "next-important-notice", notify: true }), true);
});

test("the canonical changelog preserves sourced history separately from the formal v4 notice", () => {
  const changelog = fs.readFileSync("CHANGELOG.md", "utf8");
  const versions = [...changelog.matchAll(/^## (v[\d.]+)/gmu)].map((match) => match[1]);
  const historical = ["v3.2.0", "v3.1.0", "v3.0.0", "v2.1.0", "v2.0.0"];
  assert.ok(versions.includes("v4.0.0"));
  assert.deepEqual(versions.filter((version) => historical.includes(version!)), historical);
  assert.match(changelog, /https:\/\/www\.bilibili\.com\/opus\/1118059431208157203/u);
  assert.doesNotMatch(changelog, /^## v[23]\.[^\n]*\d{4}-\d{2}-\d{2}/mu);
  const release = announcements.find((notice) => notice.id === "website-v4-0-0");
  assert.match(release?.title ?? "", /v4\.0\.0/u);
  assert.equal(release?.notify, true);
});

test("published announcement ids are unique and dates are newest first", () => {
  assert.equal(new Set(announcements.map((entry) => entry.id)).size, announcements.length);
  assert.deepEqual(announcements.map((entry) => entry.date), announcements.map((entry) => entry.date).sort().reverse());
  for (const entry of announcements) {
    assert.match(entry.id, /^[a-z0-9-]+$/);
    assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(entry.title.trim() && entry.paragraphs.length && entry.paragraphs.every((paragraph) => paragraph.trim()));
  }
});

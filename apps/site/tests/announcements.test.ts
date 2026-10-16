import assert from "node:assert/strict";
import test from "node:test";
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

test("published announcement ids are unique and dates are newest first", () => {
  assert.equal(new Set(announcements.map((entry) => entry.id)).size, announcements.length);
  assert.deepEqual(announcements.map((entry) => entry.date), announcements.map((entry) => entry.date).sort().reverse());
  for (const entry of announcements) {
    assert.match(entry.id, /^[a-z0-9-]+$/);
    assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(entry.title.trim() && entry.paragraphs.length && entry.paragraphs.every((paragraph) => paragraph.trim()));
  }
});

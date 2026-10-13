import assert from "node:assert/strict";
import test from "node:test";
import { galleryInputUpdates } from "../src/scripts/gallery-input";

test("gallery text waits for IME completion and range bursts commit once per frame", (t) => {
  const timers = new Map<number, () => void>();
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  for (const key of ["window", "requestAnimationFrame", "cancelAnimationFrame"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    t.after(() => { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });
  }
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    setTimeout: (callback: () => void) => { timers.set(++id, callback); return id; },
    clearTimeout: (key: number) => timers.delete(key),
  } });
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; } });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: (key: number) => frames.delete(key) });
  let commits = 0;
  const updates = galleryInputUpdates(() => commits++);
  const input = new EventTarget();
  updates.text(input as unknown as HTMLInputElement);
  input.dispatchEvent(new Event("compositionstart"));
  for (let index = 0; index < 4; index++) input.dispatchEvent(new Event("input"));
  assert.equal(timers.size, 0);
  assert.equal(commits, 0);
  input.dispatchEvent(new Event("compositionend"));
  input.dispatchEvent(new Event("input"));
  assert.equal(timers.size, 1);
  [...timers.values()][0]!(); timers.clear();
  assert.equal(commits, 1);
  for (let index = 0; index < 10; index++) updates.range();
  assert.equal(frames.size, 1);
  [...frames.values()][0]!(0); frames.clear();
  assert.equal(commits, 2);
  updates.range(); updates.now();
  assert.equal(frames.size, 0);
  assert.equal(commits, 3);
  updates.flush();
  assert.equal(commits, 3);
  input.dispatchEvent(new Event("input"));
  updates.flush();
  assert.equal(timers.size, 0);
  assert.equal(commits, 4);
});

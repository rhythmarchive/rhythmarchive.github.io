import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { animateCards, animateLightboxImage, captureCards, finishMotion, revealContent, setSurfaceVisible } from "../src/scripts/motion";
import { normalizeMotion, resolveMotion } from "../src/scripts/motion-preference";

function fixture(t: TestContext, reduced = false, coarse = false) {
  for (const key of ["window", "document", "getComputedStyle"] as const) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    t.after(() => { if (original) Object.defineProperty(globalThis, key, original); else Reflect.deleteProperty(globalThis, key); });
  }
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    innerHeight: 800, matchMedia: (query: string) => ({ matches: query.includes("reduced-motion") ? reduced : coarse }),
  } });
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ opacity: ".45", transform: "translateY(3px)", getPropertyValue: (key: string) => key === "--motion-ease" ? "ease-out" : "" }) });
  const animations: Array<{ frames: Keyframe[]; resolve: () => void; reject: () => void; cancelled: boolean }> = [];
  const node = {
    hidden: true, inert: false, scrollHeight: 200,
    getBoundingClientRect: () => ({ x: 100, y: 100, width: 800, height: 400 }),
    animate: (frames: Keyframe[]) => {
      let resolve!: () => void, reject!: () => void;
      const finished = new Promise<void>((yes, no) => { resolve = yes; reject = () => no(new Error("cancelled")); });
      const state = { frames, resolve, reject, cancelled: false };
      animations.push(state);
      return { finished, playState: "running", finish: resolve, cancel: () => { state.cancelled = true; reject(); } };
    },
  } as unknown as HTMLElement;
  return { node, animations };
}

test("an interrupted surface exit cannot hide a reopened dialog", async (t) => {
  const { node, animations } = fixture(t);
  const opened = setSurfaceVisible(node, true);
  assert.equal(node.hidden, false);
  animations[0]!.resolve();
  assert.equal(await opened, true);
  const closed = setSurfaceVisible(node, false);
  assert.equal(node.inert, true);
  assert.equal(node.hidden, false);
  const reopened = setSurfaceVisible(node, true);
  assert.equal(animations[2]!.frames[0]!.opacity, ".45");
  assert.equal(animations[1]!.cancelled, true);
  animations[2]!.resolve();
  assert.equal(await closed, false);
  assert.equal(await reopened, true);
  assert.equal(node.hidden, false);
  assert.equal(node.inert, false);
});

test("rich sorting preserves retained cards, ignores offscreen cards and does not replay unchanged positions", (t) => {
  const { node, animations } = fixture(t);
  Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: { dataset: { motion: "rich" } } } });
  let top = 100;
  node.getBoundingClientRect = () => ({ left: 0, top, bottom: top + 200, width: 200, height: 200 }) as DOMRect;
  const offscreen = { ...node, getBoundingClientRect: () => ({ top: 1600, bottom: 1800 }) } as unknown as HTMLElement;
  const grid = { querySelectorAll: () => [node, offscreen] } as unknown as HTMLElement;
  const before = captureCards(grid);
  assert.equal(before.size, 1);
  top = 180;
  animateCards(grid, before, new Set());
  assert.equal(animations.length, 1);
  assert.match(String(animations[0]!.frames[0]!.transform), /-80px/);
  finishMotion();
  animateCards(grid, captureCards(grid), new Set());
  assert.equal(animations.length, 1);
});

test("list choreography is bounded even for a large rendered gallery", (t) => {
  const { node, animations } = fixture(t);
  Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: { dataset: { motion: "rich" } } } });
  const cards = Array.from({ length: 48 }, () => ({ ...node, getBoundingClientRect: () => ({ left: 0, top: 100, bottom: 300 }) } as unknown as HTMLElement));
  const grid = { querySelectorAll: () => cards } as unknown as HTMLElement;
  animateCards(grid, new Map(), new Set(cards));
  assert.equal(animations.length, 12);
  finishMotion();
});

test("repeated selection does not restart an already visible tray", async (t) => {
  const { node, animations } = fixture(t);
  const first = setSurfaceVisible(node, true);
  assert.equal(setSurfaceVisible(node, true), first);
  assert.equal(animations.length, 1);
  animations[0]!.resolve();
  await first;
  const closing = setSurfaceVisible(node, false);
  animations[1]!.resolve();
  await closing;
  assert.equal(node.hidden, true);
});

test("a breakpoint reset cancels a pending mobile exit and restores desktop navigation", async (t) => {
  const { node, animations } = fixture(t);
  const opened = setSurfaceVisible(node, true);
  animations[0]!.resolve();
  await opened;
  const closing = setSurfaceVisible(node, false);
  assert.equal(await setSurfaceVisible(node, true, "instant"), true);
  assert.equal(await closing, false);
  assert.equal(animations[1]!.cancelled, true);
  assert.equal(node.hidden, false);
  assert.equal(node.inert, false);
});

test("reduced motion keeps short fades without spatial travel; missing API settles immediately", async (t) => {
  const { node, animations } = fixture(t, true);
  const opened = setSurfaceVisible(node, true);
  assert.equal(animations[0]!.frames[0]!.transform, "none");
  finishMotion();
  await opened;
  revealContent(node);
  const closed = setSurfaceVisible(node, false);
  finishMotion();
  await closed;
  assert.equal(node.hidden, true);
  assert.equal(animations.length, 3);
  (node as unknown as { animate?: unknown }).animate = undefined;
  await setSurfaceVisible(node, true);
  assert.equal(node.hidden, false);
});

test("all explicit preferences override the system and invalid values fall back safely", () => {
  assert.equal(resolveMotion("system", true), "reduced");
  assert.equal(resolveMotion("system", false), "standard");
  assert.equal(resolveMotion("rich", true), "rich");
  assert.equal(resolveMotion("standard", true), "standard");
  assert.equal(resolveMotion("reduced", false), "reduced");
  assert.equal(normalizeMotion("invalid"), "system");
  assert.equal(resolveMotion(null, true), "reduced");
});

test("changing level during an exit settles its hidden and inert state", async (t) => {
  const { node, animations } = fixture(t);
  const opening = setSurfaceVisible(node, true);
  finishMotion();
  await opening;
  const closing = setSurfaceVisible(node, false);
  finishMotion();
  assert.equal(await closing, true);
  assert.equal(node.hidden, true);
  assert.equal(node.inert, true);
  assert.equal(animations.length, 2);
});

test("touch surfaces fade without translation and long lists do not animate", async (t) => {
  const { node, animations } = fixture(t, false, true);
  const opened = setSurfaceVisible(node, true);
  assert.equal(animations[0]!.frames[0]!.transform, "none");
  animations[0]!.resolve();
  await opened;
  Object.defineProperty(node, "scrollHeight", { value: 2400 });
  revealContent(node);
  assert.equal(animations.length, 1);
});

test("lightbox geometry preserves aspect ratio and never changes an image URL", (t) => {
  const { node, animations } = fixture(t);
  const image = Object.assign(node, { src: "existing-original" }) as HTMLImageElement;
  const trigger = { querySelector: () => ({ getBoundingClientRect: () => ({ x: 20, y: 20, width: 200, height: 200 }) }) } as unknown as HTMLElement;
  animateLightboxImage(image, trigger, true);
  assert.match(String(animations[0]!.frames[0]!.transform), /scale\(0\.25\)/);
  assert.equal(image.src, "existing-original");
  animations[0]!.resolve();
});

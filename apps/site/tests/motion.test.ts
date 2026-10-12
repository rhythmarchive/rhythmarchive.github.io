import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { animateLightboxImage, revealContent, setSurfaceVisible } from "../src/scripts/motion";

function fixture(t: TestContext, reduced = false, coarse = false) {
  for (const key of ["window", "getComputedStyle"] as const) {
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
      return { finished, playState: "running", cancel: () => { state.cancelled = true; reject(); } };
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

test("reduced motion and missing Web Animations settle immediately", async (t) => {
  const { node, animations } = fixture(t, true);
  await setSurfaceVisible(node, true);
  revealContent(node);
  await setSurfaceVisible(node, false);
  assert.equal(node.hidden, true);
  assert.equal(animations.length, 0);
  (node as unknown as { animate?: unknown }).animate = undefined;
  await setSurfaceVisible(node, true);
  assert.equal(node.hidden, false);
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

import { motionLevel } from "./motion-preference";

// Only active animations are retained; navigation and preference changes settle them.
const active = new Set<Animation>();
function track(animation: Animation): Animation {
  active.add(animation);
  void animation.finished.then(() => active.delete(animation), () => active.delete(animation));
  return animation;
}
export function finishMotion(): void {
  for (const animation of active) animation.finish();
  active.clear();
}

// Shared by real surfaces and client-rendered lists. No observers or image requests.
const surfaces = new WeakMap<HTMLElement, { visible: boolean; animation?: Animation; finished: Promise<boolean> }>();
const feedback = new WeakMap<HTMLElement, Animation>();

function currentFrame(node: HTMLElement, animation?: Animation): Keyframe | undefined {
  if (animation?.playState !== "running") return undefined;
  const style = getComputedStyle(node);
  return { opacity: style.opacity, transform: style.transform };
}

function duration(node: HTMLElement, token: string, fallback: number): number {
  const value = Number.parseFloat(getComputedStyle(node).getPropertyValue(token));
  return Number.isFinite(value) ? value : fallback;
}

function enabled(node: HTMLElement): boolean {
  return typeof window !== "undefined" && typeof node.animate === "function";
}

export function revealContent(node: HTMLElement): void {
  const current = currentFrame(node, feedback.get(node));
  feedback.get(node)?.cancel();
  if (!enabled(node) || node.hidden) return;
  // Avoid promoting a long image list to an animated surface on touch devices.
  if (window.matchMedia("(pointer: coarse)").matches && node.scrollHeight > window.innerHeight) return;
  const animation = track(node.animate([{ opacity: current?.opacity ?? .65 }, { opacity: 1 }], {
    duration: duration(node, "--motion-fast", 140),
    easing: getComputedStyle(node).getPropertyValue("--motion-ease").trim() || "ease-out",
  }));
  feedback.set(node, animation);
  void animation.finished.catch(() => undefined);
}

// Latest action wins: closing surfaces become inert immediately, but stay painted
// through the exit. Reopening cancels that exit without a stale hidden write.
export function setSurfaceVisible(node: HTMLElement, visible: boolean, mode: "surface" | "fade" | "instant" = "surface"): Promise<boolean> {
  const previous = surfaces.get(node);
  if (previous?.visible === visible && mode !== "instant") return previous.finished;
  const current = currentFrame(node, previous?.animation);
  previous?.animation?.cancel();
  const wasHidden = node.hidden;
  node.inert = !visible;
  if (visible) node.hidden = false;
  if (mode === "instant" || !enabled(node) || (!visible && wasHidden)) {
    node.hidden = !visible;
    const state = { visible, finished: Promise.resolve(true) };
    surfaces.set(node, state);
    return state.finished;
  }
  const level = motionLevel();
  const compact = (mode === "fade" && node.tagName !== "DIALOG") || level === "reduced" || (level !== "rich" && window.matchMedia("(pointer: coarse)").matches);
  const from = { opacity: 0, transform: compact ? "none" : level === "rich" ? "translateY(12px) scale(.97)" : "translateY(6px) scale(.985)" };
  const to = { opacity: 1, transform: "none" };
  const animation = track(node.animate([current ?? (visible ? from : to), visible ? to : from], {
    duration: duration(node, visible ? "--motion-surface" : "--motion-fast", visible ? 220 : 140),
    easing: getComputedStyle(node).getPropertyValue(visible ? "--motion-ease" : "--motion-exit-ease").trim() || "ease-out",
  }));
  const state = { visible, animation, finished: Promise.resolve(false) };
  state.finished = animation.finished.then(() => {
    if (surfaces.get(node) !== state) return false;
    node.hidden = !visible;
    return true;
  }, () => false);
  surfaces.set(node, state);
  return state.finished;
}

// Animate the image already displayed; the trigger is only a geometry reference.
export function animateLightboxImage(image: HTMLImageElement, trigger: HTMLElement, opening: boolean): void {
  const current = currentFrame(image, feedback.get(image));
  feedback.get(image)?.cancel();
  if (!enabled(image) || motionLevel() === "reduced") return;
  if (motionLevel() !== "rich" && window.matchMedia("(pointer: coarse)").matches) {
    return;
  }
  const source = trigger.querySelector("img")?.getBoundingClientRect();
  const target = image.getBoundingClientRect();
  if (!source?.width || !source.height || !target.width || !target.height) return;
  const x = source.x + source.width / 2 - target.x - target.width / 2;
  const y = source.y + source.height / 2 - target.y - target.height / 2;
  // Preserve aspect ratio; do not stretch an original to fit its card thumbnail.
  const scale = Math.min(source.width / target.width, source.height / target.height);
  // The viewer surface owns opacity. Geometry must not fade the image again.
  const from = { opacity: 1, transform: `translate(${x}px, ${y}px) scale(${scale})` };
  const to = { opacity: 1, transform: "none" };
  const animation = track(image.animate([current ?? (opening ? from : to), opening ? to : from], {
    duration: duration(image, opening ? "--motion-surface" : "--motion-fast", opening ? 220 : 140),
    easing: getComputedStyle(image).getPropertyValue("--motion-ease").trim() || "ease-out",
  }));
  feedback.set(image, animation);
  void animation.finished.catch(() => undefined);
}

// Called only for user-driven reconciliations, never initial SSR or restoration.
// Read geometry in batches and animate at most the on-screen cards. Existing
// image nodes/URLs survive sorting; no large list surface becomes a GPU layer.
export function captureCards(grid: HTMLElement): Map<HTMLElement, DOMRect> {
  const positions = new Map<HTMLElement, DOMRect>();
  if (typeof window === "undefined" || motionLevel() !== "rich") return positions;
  const nodes = [...grid.querySelectorAll<HTMLElement>(":scope > :is([data-resource-card], [data-game-card])")];
  for (const node of nodes) feedback.get(node)?.finish();
  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    if (rect.bottom > 0 && rect.top < window.innerHeight) positions.set(node, rect);
  }
  return positions;
}

export function animateCards(grid: HTMLElement, before: Map<HTMLElement, DOMRect>, added: Set<HTMLElement>): void {
  if (typeof window === "undefined" || motionLevel() === "reduced") return;
  const rich = motionLevel() === "rich";
  const changes: Array<{ node: HTMLElement; from: Keyframe }> = [];
  for (const node of grid.querySelectorAll<HTMLElement>(":scope > :is([data-resource-card], [data-game-card])")) {
    if (!enabled(node)) continue;
    const old = before.get(node);
    if (!added.has(node) && !old) continue;
    const rect = node.getBoundingClientRect();
    if (rect.bottom <= 0 || rect.top >= window.innerHeight) continue;
    const x = old ? old.left - rect.left : 0;
    const y = old ? old.top - rect.top : rich ? 12 : 0;
    if (old && (!rich || Math.abs(x) + Math.abs(y) < 1 || Math.abs(y) > window.innerHeight / 3)) continue;
    changes.push({ node, from: { opacity: old ? 1 : .35, transform: `translate(${x}px, ${y}px)` } });
    if (changes.length >= 12) break;
  }
  const timing = { duration: duration(grid, "--motion-surface", 260), easing: getComputedStyle(grid).getPropertyValue("--motion-ease").trim() || "ease-out" };
  changes.forEach(({ node, from }, index) => {
    feedback.get(node)?.cancel();
    const animation = track(node.animate([from, { opacity: 1, transform: "none" }], { ...timing, delay: rich && added.has(node) ? Math.min(index * 24, 144) : 0, fill: "backwards" }));
    feedback.set(node, animation);
  });
}

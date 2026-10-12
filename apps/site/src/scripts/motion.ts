// Shared by real surfaces and client-rendered lists. No observers or image requests.
const surfaces = new WeakMap<HTMLElement, { visible: boolean; animation?: Animation; finished: Promise<boolean> }>();
const feedback = new WeakMap<HTMLElement, Animation>();

function currentFrame(node: HTMLElement, animation?: Animation): Keyframe | undefined {
  if (animation?.playState !== "running") return undefined;
  const style = getComputedStyle(node);
  return { opacity: style.opacity, transform: style.transform };
}

function duration(node: HTMLElement, token: string, fallback: number): number {
  return Number.parseFloat(getComputedStyle(node).getPropertyValue(token)) || fallback;
}

function enabled(node: HTMLElement): boolean {
  return typeof window !== "undefined" && typeof node.animate === "function"
    && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function revealContent(node: HTMLElement): void {
  const current = currentFrame(node, feedback.get(node));
  feedback.get(node)?.cancel();
  if (!enabled(node) || node.hidden) return;
  // Avoid promoting a long image list to an animated surface on touch devices.
  if (window.matchMedia("(pointer: coarse)").matches && node.scrollHeight > window.innerHeight) return;
  const animation = node.animate([{ opacity: current?.opacity ?? .65 }, { opacity: 1 }], {
    duration: duration(node, "--motion-fast", 140),
    easing: getComputedStyle(node).getPropertyValue("--motion-ease").trim() || "ease-out",
  });
  feedback.set(node, animation);
  void animation.finished.catch(() => undefined);
}

// Latest action wins: closing surfaces become inert immediately, but stay painted
// through the exit. Reopening cancels that exit without a stale hidden write.
export function setSurfaceVisible(node: HTMLElement, visible: boolean, mode: "surface" | "fade" = "surface"): Promise<boolean> {
  const previous = surfaces.get(node);
  if (previous?.visible === visible) return previous.finished;
  const current = currentFrame(node, previous?.animation);
  previous?.animation?.cancel();
  const wasHidden = node.hidden;
  node.inert = !visible;
  if (visible) node.hidden = false;
  if (!enabled(node) || (!visible && wasHidden)) {
    node.hidden = !visible;
    const state = { visible, finished: Promise.resolve(true) };
    surfaces.set(node, state);
    return state.finished;
  }
  const compact = mode === "fade" || window.matchMedia("(pointer: coarse)").matches;
  const from = { opacity: 0, transform: compact ? "none" : "translateY(6px) scale(.985)" };
  const to = { opacity: 1, transform: "none" };
  const animation = node.animate([current ?? (visible ? from : to), visible ? to : from], {
    duration: duration(node, visible ? "--motion-surface" : "--motion-fast", visible ? 220 : 140),
    easing: getComputedStyle(node).getPropertyValue("--motion-ease").trim() || "ease-out",
  });
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
  if (!enabled(image)) return;
  if (window.matchMedia("(pointer: coarse)").matches) {
    if (opening) revealContent(image);
    return;
  }
  const source = trigger.querySelector("img")?.getBoundingClientRect();
  const target = image.getBoundingClientRect();
  if (!source?.width || !source.height || !target.width || !target.height) return;
  const x = source.x + source.width / 2 - target.x - target.width / 2;
  const y = source.y + source.height / 2 - target.y - target.height / 2;
  // Preserve aspect ratio; do not stretch an original to fit its card thumbnail.
  const scale = Math.min(source.width / target.width, source.height / target.height);
  const from = { opacity: .6, transform: `translate(${x}px, ${y}px) scale(${scale})` };
  const to = { opacity: 1, transform: "none" };
  const animation = image.animate([current ?? (opening ? from : to), opening ? to : from], {
    duration: duration(image, opening ? "--motion-surface" : "--motion-fast", opening ? 220 : 140),
    easing: getComputedStyle(image).getPropertyValue("--motion-ease").trim() || "ease-out",
  });
  feedback.set(image, animation);
  void animation.finished.catch(() => undefined);
}

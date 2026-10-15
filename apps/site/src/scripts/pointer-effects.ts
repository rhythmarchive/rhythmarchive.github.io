import { motionLevel } from "./motion-preference";
import { onPageCleanup, onPageLoad } from "./page-lifecycle";

// Site-wide pointer polish. Every listener is passive and document-level (bound
// once for the whole session); nothing here reads or loads images.

const TAP_TARGETS = [
  "button:not(:disabled)", ".button", "[role='tab']", ".segmented label", ".site-nav > a", ".category-nav a", ".resource-card-link",
  ".game-card", ".ranking-item", ".update-preview", ".nav-game-list a", ".home-quick-links a", ".search-quick-links a",
  ".search-browse-links a", ".range-histogram", ".download-button", ".header-icon-button", ".detail-artwork-entry",
].join(",");
const FILLED = ".button-primary, .search-box button, .apk-download-button, .resource-select[aria-pressed='true']";

let layer: HTMLElement | undefined;
const rings: HTMLElement[] = [];
let ringIndex = 0;

function tapLayer(): HTMLElement {
  if (!layer?.isConnected) {
    layer = document.createElement("div");
    layer.className = "tap-layer";
    layer.setAttribute("aria-hidden", "true");
    document.body.append(layer);
    rings.length = 0;
  }
  return layer;
}

function spawnTap(x: number, y: number, color: string | undefined, sparks: boolean): void {
  const host = tapLayer();
  if (rings.length < 3) {
    const ring = document.createElement("span");
    ring.className = "tap-ring";
    host.append(ring);
    rings.push(ring);
  }
  const ring = rings[ringIndex++ % rings.length]!;
  ring.style.setProperty("--tap-color", color ?? "");
  const at = `translate(${x}px, ${y}px)`;
  ring.getAnimations().forEach((animation) => animation.cancel());
  ring.animate([{ opacity: .9, transform: `${at} scale(.35)` }, { opacity: 0, transform: `${at} scale(1.7)` }], { duration: 440, easing: "cubic-bezier(.22, 1, .36, 1)" });
  if (!sparks) return;
  for (let index = 0; index < 4; index++) {
    const spark = document.createElement("span");
    spark.className = "tap-spark";
    spark.style.setProperty("--tap-color", color ?? "");
    host.append(spark);
    const angle = (index * 90 + 45) * Math.PI / 180;
    const dx = Math.cos(angle) * 26, dy = Math.sin(angle) * 26;
    const animation = spark.animate([
      { opacity: 1, transform: `${at} rotate(45deg) scale(1)` },
      { opacity: 0, transform: `translate(${x + dx}px, ${y + dy}px) rotate(45deg) scale(.3)` },
    ], { duration: 380, easing: "cubic-bezier(.22, 1, .36, 1)" });
    void animation.finished.finally(() => spark.remove()).catch(() => undefined);
  }
}

document.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || !(event.target instanceof Element)) return;
  const level = motionLevel();
  if (level === "reduced" || typeof HTMLElement.prototype.animate !== "function") return;
  const target = event.target.closest<HTMLElement>(TAP_TARGETS);
  if (!target || target.closest("[aria-disabled='true'], [inert]")) return;
  const filled = target.matches(FILLED);
  spawnTap(event.clientX, event.clientY, filled ? "#ffffff" : undefined, level === "rich" && event.pointerType !== "touch");
}, { capture: true, passive: true });

// Spotlight coordinates for the card under a mouse pointer, at most once per frame.
let spotlightFrame = 0;
let spotlightEvent: PointerEvent | undefined;
document.addEventListener("pointermove", (event) => {
  if (event.pointerType !== "mouse") return;
  spotlightEvent = event;
  if (spotlightFrame) return;
  spotlightFrame = requestAnimationFrame(() => {
    spotlightFrame = 0;
    const current = spotlightEvent;
    if (!current || !(current.target instanceof Element)) return;
    const card = current.target.closest<HTMLElement>(".resource-card-link, .game-card");
    if (!card) return;
    const rect = card.getBoundingClientRect();
    card.style.setProperty("--mx", `${current.clientX - rect.left}px`);
    card.style.setProperty("--my", `${current.clientY - rect.top}px`);
  });
}, { passive: true });

// "/" focuses the page's own search field (or opens the search page).
document.addEventListener("keydown", (event) => {
  if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
  const active = document.activeElement;
  if (active instanceof HTMLElement && (active.isContentEditable || active.matches("input, textarea, select"))) return;
  const field = [...document.querySelectorAll<HTMLInputElement>("main input[type='search']")].find((input) => input.offsetParent !== null);
  event.preventDefault();
  if (field) {
    field.focus();
    field.select();
  } else {
    document.querySelector<HTMLAnchorElement>(".nav-search")?.click();
  }
});

// Back to top for long pages; one button per document, toggled from a throttled scroll check.
let backToTop: HTMLButtonElement | undefined;
let scrollFrame = 0;
function ensureBackToTop(): HTMLButtonElement {
  if (!backToTop?.isConnected) {
    backToTop = document.createElement("button");
    backToTop.type = "button";
    backToTop.className = "back-to-top";
    backToTop.setAttribute("aria-label", "回到顶部");
    backToTop.title = "回到顶部";
    backToTop.tabIndex = -1;
    backToTop.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V6M6 11l6-6 6 6"/></svg>';
    backToTop.addEventListener("click", () => {
      window.scrollTo({ top: 0, behavior: motionLevel() === "reduced" ? "auto" : "smooth" });
      document.querySelector<HTMLElement>("#main-content")?.focus({ preventScroll: true });
    });
    document.body.append(backToTop);
  }
  return backToTop;
}
function syncBackToTop(): void {
  scrollFrame = 0;
  const visible = window.scrollY > window.innerHeight * 2;
  const button = visible || backToTop?.isConnected ? ensureBackToTop() : undefined;
  if (!button) return;
  button.toggleAttribute("data-visible", visible);
  button.tabIndex = visible ? 0 : -1;
}
window.addEventListener("scroll", () => { if (!scrollFrame) scrollFrame = requestAnimationFrame(syncBackToTop); }, { passive: true });

onPageLoad(() => {
  syncBackToTop();
  // The hero highway only animates while it is on screen.
  const stage = document.querySelector<HTMLElement>(".home-hero-stage");
  if (!stage || typeof IntersectionObserver !== "function") return;
  const observer = new IntersectionObserver(([entry]) => stage.toggleAttribute("data-paused", !entry?.isIntersecting));
  observer.observe(stage);
  onPageCleanup(() => observer.disconnect());
});

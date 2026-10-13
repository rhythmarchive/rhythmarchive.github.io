import type { TransitionBeforePreparationEvent, TransitionBeforeSwapEvent } from "astro:transitions/client";
import { onPageLoad } from "./page-lifecycle";
import { observeImages, resetImageObserver, settleImage } from "./viewport-images";

document.addEventListener("load", (event) => {
  if (event.target instanceof HTMLImageElement) settleImage(event.target, true);
}, true);
document.addEventListener("error", (event) => {
  if (event.target instanceof HTMLImageElement) settleImage(event.target, false);
}, true);

let loadingTimer: number | undefined;
let loadingSignal: AbortSignal | undefined;
const finishLoading = () => {
  window.clearTimeout(loadingTimer);
  document.documentElement.removeAttribute("data-navigating");
  document.querySelector("main")?.removeAttribute("aria-busy");
};
document.addEventListener("astro:before-preparation", (event) => {
  const navigation = event as TransitionBeforePreparationEvent;
  finishLoading();
  loadingSignal = navigation.signal;
  const finishCurrent = () => { if (loadingSignal === navigation.signal) finishLoading(); };
  loadingTimer = window.setTimeout(() => {
    document.documentElement.dataset.navigating = "true";
    document.querySelector("main")?.setAttribute("aria-busy", "true");
  }, 150);
  navigation.signal.addEventListener("abort", finishCurrent, { once: true });
  const loader = navigation.loader;
  navigation.loader = async () => {
    try { await loader(); }
    finally { finishCurrent(); }
  };
});
document.addEventListener("astro:before-swap", (event) => {
  const next = (event as TransitionBeforeSwapEvent).newDocument;
  // Keep the real header, updating route-dependent marks from Astro's HTML.
  const header = document.querySelector(".site-header");
  const incoming = next.querySelector(".site-header");
  if (header && incoming) {
    const targets = incoming.querySelectorAll(".site-nav a, .nav-game-library, .nav-library-trigger");
    header.querySelectorAll(".site-nav a, .nav-game-library, .nav-library-trigger").forEach((node, index) => {
      const target = targets[index];
      if (!target) return;
      node.className = target.className;
      if (target.hasAttribute("aria-current")) node.setAttribute("aria-current", target.getAttribute("aria-current")!);
      else node.removeAttribute("aria-current");
    });
  }
  next.documentElement.dataset.theme = document.documentElement.dataset.theme ?? "system";
  next.documentElement.classList.add("has-js");
  next.documentElement.dataset.clientNavigation = "true";
  for (const root of next.querySelectorAll<HTMLElement>('[data-browse-gallery-root], [data-gallery-root]:not([data-gallery-defer="true"])')) {
    root.inert = true;
    root.setAttribute("aria-busy", "true");
  }
  // Paint the viewer as part of the incoming page; avoid briefly exposing the
  // underlying detail between consecutive images or a history restoration.
  const transition = event as TransitionBeforeSwapEvent;
  const viewer = transition.navigationType === "traverse" ? history.state?.detailViewer : transition.info?.detailViewer;
  if (viewer) {
    next.documentElement.dataset.viewerNavigation = "true";
    const trigger = [...next.querySelectorAll<HTMLElement>("[data-lightbox-open]")].find((node) => !node.closest("[hidden]"));
    const lightbox = next.querySelector<HTMLElement>("[data-detail-lightbox]");
    const image = next.querySelector<HTMLImageElement>("[data-lightbox-image]");
    if (trigger?.dataset.lightboxPreviewUrl && lightbox && image) {
      lightbox.hidden = false;
      lightbox.inert = true;
      image.src = trigger.dataset.lightboxPreviewUrl;
      image.alt = trigger.dataset.lightboxPreviewAlt ?? "资源大图";
      next.body.classList.add("detail-lightbox-open");
    }
  }
  resetImageObserver();
});
onPageLoad(() => {
  finishLoading();
  observeImages(document);
  const active = document.querySelector<HTMLElement>(".category-nav [aria-current='page']");
  const nav = active?.closest<HTMLElement>(".category-nav");
  // Reveal the active category horizontally without moving a restored page.
  if (active && nav && nav.scrollWidth > nav.clientWidth) {
    const item = active.getBoundingClientRect(), strip = nav.getBoundingClientRect();
    const delta = item.left < strip.left ? item.left - strip.left : item.right > strip.right ? item.right - strip.right : 0;
    if (delta) nav.scrollBy({ left: delta, behavior: "instant" });
  }
});

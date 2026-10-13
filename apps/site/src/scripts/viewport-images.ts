// Keep URLs inert until the image is visible. Native lazy loading may fetch
// several screens ahead, including images the visitor never scrolls to.
let observer: IntersectionObserver | undefined;
const watched = new Set<HTMLImageElement>();
let cleanupQueued = false;

// The same image handles cached loads, responsive candidates and fallback retries.
// Loading decoration starts only after a real URL is assigned, never offscreen.
export function prepareImage(image: HTMLImageElement): void {
  image.dataset.imageState = "loading";
  if (image.complete && image.src && !image.dataset.viewportSrc && !image.dataset.detailSrc) settleImage(image, image.naturalWidth > 0);
}

export function settleImage(image: HTMLImageElement, loaded: boolean): void {
  if (loaded) {
    if (image.dataset.imageState) image.dataset.imageState = "ready";
    return;
  }
  const fallback = image.dataset.fallbackSrc;
  if (fallback && image.dataset.fallbackApplied !== "true") {
    image.dataset.fallbackApplied = "true";
    image.removeAttribute("srcset");
    image.dataset.imageState = "loading";
    image.src = fallback;
    const trigger = image.closest<HTMLElement>("[data-lightbox-open]");
    if (trigger) {
      trigger.dataset.lightboxPreviewUrl = fallback;
      trigger.setAttribute("aria-label", `查看${image.alt}大图预览`);
      if (image.dataset.fallbackWidth) trigger.dataset.lightboxPreviewWidth = image.dataset.fallbackWidth;
      if (image.dataset.fallbackHeight) trigger.dataset.lightboxPreviewHeight = image.dataset.fallbackHeight;
    }
  } else if (image.dataset.imageState) image.dataset.imageState = "error";
}

export function loadImage(image: HTMLImageElement): void {
  const src = image.dataset.viewportSrc;
  if (!src) return;
  const srcset = image.dataset.viewportSrcset;
  prepareImage(image);
  // Configure responsive candidates before src to avoid an intermediate fetch.
  if (srcset) image.srcset = srcset;
  image.src = src;
  delete image.dataset.viewportSrc;
  delete image.dataset.viewportSrcset;
}

export function observeImage(image: HTMLImageElement): void {
  if (!image.dataset.viewportSrc) return;
  if (typeof IntersectionObserver === "undefined") {
    loadImage(image);
    return;
  }
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const target = entry.target as HTMLImageElement;
      if (!target.isConnected) {
        observer!.unobserve(target);
        watched.delete(target);
        continue;
      }
      if (!entry.isIntersecting) continue;
      if (target.closest('[hidden], [data-gallery-root][aria-busy="true"], [data-browse-gallery-root][aria-busy="true"]')) continue;
      loadImage(target);
      observer!.unobserve(target);
      watched.delete(target);
    }
  });
  // A retained SSR node may have intersected while its gallery was busy. A
  // fresh observation after initialization lets it load without scrolling.
  if (watched.has(image)) observer.unobserve(image);
  observer.observe(image);
  watched.add(image);
  // Renderers register images before inserting them. Clean replaced nodes once
  // the synchronous render has finished, without retaining old search results.
  if (!cleanupQueued) {
    cleanupQueued = true;
    queueMicrotask(() => {
      cleanupQueued = false;
      for (const target of watched) {
        if (target.isConnected) continue;
        observer!.unobserve(target);
        watched.delete(target);
      }
    });
  }
}

export function observeImages(scope: ParentNode): void {
  for (const image of scope.querySelectorAll<HTMLImageElement>("img[data-viewport-src]")) observeImage(image);
  for (const image of scope.querySelectorAll<HTMLImageElement>("img[data-detail-image]:not([data-detail-src])")) prepareImage(image);
}

export function resetImageObserver(): void {
  observer?.disconnect();
  watched.clear();
}

export function loadSelectedDetailImages(scope: ParentNode): void {
  for (const image of scope.querySelectorAll<HTMLImageElement>("img[data-detail-src]")) {
    if (image.closest("[hidden]")) continue;
    prepareImage(image);
    if (image.dataset.detailSrcset) image.srcset = image.dataset.detailSrcset;
    image.src = image.dataset.detailSrc!;
    delete image.dataset.detailSrc;
    delete image.dataset.detailSrcset;
  }
}

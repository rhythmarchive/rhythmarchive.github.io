// Keep URLs inert until the image is visible. Native lazy loading may fetch
// several screens ahead, including images the visitor never scrolls to.
let observer: IntersectionObserver | undefined;
const watched = new Set<HTMLImageElement>();
let cleanupQueued = false;

export function loadImage(image: HTMLImageElement): void {
  const src = image.dataset.viewportSrc;
  if (!src) return;
  const srcset = image.dataset.viewportSrcset;
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
      if (target.closest("[hidden]")) continue;
      loadImage(target);
      observer!.unobserve(target);
      watched.delete(target);
    }
  });
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
}

export function loadSelectedDetailImages(scope: ParentNode): void {
  for (const image of scope.querySelectorAll<HTMLImageElement>("img[data-detail-src]")) {
    if (image.closest("[hidden]")) continue;
    if (image.dataset.detailSrcset) image.srcset = image.dataset.detailSrcset;
    image.src = image.dataset.detailSrc!;
    delete image.dataset.detailSrc;
    delete image.dataset.detailSrcset;
  }
}

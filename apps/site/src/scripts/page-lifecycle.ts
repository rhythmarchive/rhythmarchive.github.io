// Astro executes bundled modules once. DOM setup runs for each new document body;
// page-owned listeners and asynchronous work expire before that body is replaced.
let page = new AbortController();
if (typeof document !== "undefined") {
  document.addEventListener("astro:before-swap", () => {
    page.abort();
    page = new AbortController();
  });
}

export function pageSignal(): AbortSignal { return page.signal; }
export function onPageLoad(initialize: () => void): void {
  document.addEventListener("astro:page-load", initialize);
}
export function onPageCleanup(cleanup: () => void): void {
  page.signal.addEventListener("abort", cleanup, { once: true });
}

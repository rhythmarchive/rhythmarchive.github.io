import { onPageCleanup } from "./page-lifecycle";

// Text uses the search page's IME/debounce policy; range values stay immediate
// while expensive result work is coalesced into one update per frame.
export function galleryInputUpdates(commit: () => void) {
  let timer: number | undefined;
  let frame: number | undefined;
  const cancel = () => { window.clearTimeout(timer); timer = undefined; if (frame !== undefined) cancelAnimationFrame(frame); frame = undefined; };
  onPageCleanup(cancel);
  return {
    text(input: HTMLInputElement) {
      let composing = false;
      const schedule = () => { cancel(); if (!composing) timer = window.setTimeout(() => { timer = undefined; commit(); }, 150); };
      input.addEventListener("compositionstart", () => { composing = true; cancel(); });
      input.addEventListener("compositionend", () => { composing = false; schedule(); });
      input.addEventListener("input", schedule);
    },
    range() { window.clearTimeout(timer); if (frame === undefined) frame = requestAnimationFrame(() => { frame = undefined; commit(); }); },
    now() { cancel(); commit(); },
    flush() { if (timer !== undefined || frame !== undefined) { cancel(); commit(); } },
  };
}

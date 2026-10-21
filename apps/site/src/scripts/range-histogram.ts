import { pageSignal } from "./page-lifecycle";

// Tap a bar to pick that bucket, drag across bars to pick a span, tap the only
// selected bar again to clear. Values are written to the existing range sliders
// and announced with their own input event, so each gallery keeps one filter path.
export function enhanceRangeHistograms(root: HTMLElement): void {
  const signal = pageSignal();
  for (const histogram of root.querySelectorAll<HTMLElement>("[data-range-histogram]")) {
    const control = histogram.closest<HTMLElement>(".filter-range-control");
    const [minSlider, maxSlider] = control ? [...control.querySelectorAll<HTMLInputElement>('input[type="range"]')] : [];
    if (!control || !minSlider || !maxSlider) continue;
    const min = Number(control.dataset.rangeMin), max = Number(control.dataset.rangeMax), step = Number(control.dataset.rangeStep) || 1;
    const start = Number(histogram.dataset.start), size = Number(histogram.dataset.size);
    const bars = [...histogram.querySelectorAll<HTMLElement>("[data-index]")];
    const last = Math.max(...bars.map((bar) => Number(bar.dataset.index)));
    const tip = document.createElement("span");
    tip.className = "range-histogram-tip";
    histogram.append(tip);
    const snap = (value: number) => Number((Math.round(value / step) * step).toFixed(4));
    const low = (index: number) => Math.max(min, snap(start + index * size));
    const high = (index: number) => index >= last ? max : Math.min(max, snap(start + (index + 1) * size - step));
    const format = (value: number) => control.dataset.rangeLabel === "谱面定数" || !Number.isInteger(step) ? value.toFixed(1) : String(value);
    const bucketAt = (clientX: number) => {
      const rect = histogram.getBoundingClientRect();
      const value = min + Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * (max - min);
      return Math.min(last, Math.max(0, Math.floor((value - start) / size)));
    };
    const showTip = (from: number, to: number) => {
      const count = bars.filter((bar) => Number(bar.dataset.index) >= from && Number(bar.dataset.index) <= to).reduce((total, bar) => total + Number(bar.dataset.count), 0);
      tip.textContent = `${format(low(from))}–${format(high(to))}${from === to ? ` · ${count} 项` : ""}`;
      // Keep the whole label inside the (often narrow, scroll-clipped) filter column.
      const width = histogram.clientWidth, half = tip.offsetWidth / 2;
      const center = ((low(from) + high(to)) / 2 - min) / (max - min);
      tip.style.setProperty("--x", `${Math.min(width - half, Math.max(half, center * width))}px`);
      tip.dataset.visible = "true";
    };
    const sync = () => {
      const lo = Number(minSlider.value), hi = Number(maxSlider.value);
      const filtered = lo > min || hi < max;
      histogram.toggleAttribute("data-filtered", filtered);
      for (const bar of bars) {
        const index = Number(bar.dataset.index);
        bar.toggleAttribute("data-active", !filtered || (high(index) >= lo && low(index) <= hi));
      }
    };
    const apply = (from: number, to: number) => {
      minSlider.value = String(low(Math.min(from, to)));
      maxSlider.value = String(high(Math.max(from, to)));
      maxSlider.dispatchEvent(new Event("input", { bubbles: true }));
      sync();
    };
    let anchor: number | undefined, moved = false, wasOnly = false;
    histogram.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      anchor = bucketAt(event.clientX);
      moved = false;
      wasOnly = Number(minSlider.value) === low(anchor) && Number(maxSlider.value) === high(anchor);
      histogram.setPointerCapture(event.pointerId);
      histogram.dataset.dragging = "true";
      if (!wasOnly) apply(anchor, anchor);
      showTip(anchor, anchor);
    }, { signal });
    histogram.addEventListener("pointermove", (event) => {
      const bucket = bucketAt(event.clientX);
      if (anchor === undefined) { showTip(bucket, bucket); return; }
      if (bucket !== anchor) moved = true;
      if (!moved) return;
      apply(anchor, bucket);
      showTip(Math.min(anchor, bucket), Math.max(anchor, bucket));
    }, { signal });
    const end = (cancelled: boolean) => {
      if (anchor === undefined) return;
      if (!cancelled && !moved && wasOnly) {
        minSlider.value = String(min);
        maxSlider.value = String(max);
        maxSlider.dispatchEvent(new Event("input", { bubbles: true }));
        sync();
      }
      anchor = undefined;
      delete histogram.dataset.dragging;
      maxSlider.dispatchEvent(new Event("change", { bubbles: true }));
    };
    histogram.addEventListener("pointerup", () => end(false), { signal });
    histogram.addEventListener("pointercancel", () => end(true), { signal });
    histogram.addEventListener("pointerleave", () => { if (anchor === undefined) delete tip.dataset.visible; }, { signal });
    histogram.addEventListener("lostpointercapture", () => { delete tip.dataset.visible; }, { signal });
    // Reset, URL restore and slider/keyboard edits all rewrite the control's range variables.
    const observer = new MutationObserver(sync);
    observer.observe(control, { attributes: true, attributeFilter: ["style"] });
    signal.addEventListener("abort", () => observer.disconnect(), { once: true });
    sync();
  }
}

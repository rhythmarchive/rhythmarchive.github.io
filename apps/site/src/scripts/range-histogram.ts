import { pageSignal } from "./page-lifecycle";
import type { RangeHistogram } from "../lib/range-histogram";
import { reconcileList } from "./motion";

type HistogramRange = { root: HTMLElement; min: number; max: number; step: number };

export function resetHistogramRange(range: HistogramRange): void {
  range.min = Number(range.root.dataset.rangeFullMin ?? range.min);
  range.max = Number(range.root.dataset.rangeFullMax ?? range.max);
  setBounds(range);
}

function setBounds(range: HistogramRange): void {
  range.root.dataset.rangeMin = String(range.min);
  range.root.dataset.rangeMax = String(range.max);
  for (const input of range.root.querySelectorAll<HTMLInputElement>("input")) {
    input.min = String(range.min);
    input.max = String(range.max);
  }
}

export function adaptHistogramRange(range: HistogramRange, data: RangeHistogram | undefined): void {
  const { root } = range;
  root.dataset.rangeFullMin ??= String(range.min);
  root.dataset.rangeFullMax ??= String(range.max);
  const sliders = [...root.querySelectorAll<HTMLInputElement>('input[type="range"]')];
  const lo = Number(sliders[0]?.value), hi = Number(sliders[1]?.value);
  const full = lo <= range.min && hi >= range.max;
  range.min = data?.min ?? Number(root.dataset.rangeFullMin);
  range.max = data?.max ?? Number(root.dataset.rangeFullMax);
  const reset = full || hi < range.min || lo > range.max;
  setBounds(range);
  for (const input of root.querySelectorAll<HTMLInputElement>("input")) {
    const low = input === sliders[0] || input.type === "number" && input === root.querySelector('input[type="number"]');
    const value = low ? reset ? range.min : Math.max(range.min, lo) : reset ? range.max : Math.min(range.max, hi);
    input.value = input.type === "number" && root.dataset.rangeLabel === "谱面定数" ? value.toFixed(1) : String(value);
  }
  const ticks = root.querySelector(".filter-range-ticks");
  const tickValues = [...new Set(Array.from({ length: 5 }, (_, index) => Number((range.min + Math.round((range.max - range.min) * index / 4 / range.step) * range.step).toFixed(4))))];
  if (ticks) ticks.replaceChildren(...tickValues.map((value) => {
    const tick = document.createElement("span");
    tick.textContent = root.dataset.rangeLabel === "谱面定数" || range.step < 1 ? value.toFixed(1) : String(Math.round(value));
    return tick;
  }));
  updateRangeHistogram(root, data);
}

export function updateRangeHistogram(control: HTMLElement, data: RangeHistogram | undefined): void {
  const histogram = control.querySelector<HTMLElement>("[data-range-histogram]");
  if (!histogram) return;
  const layer = histogram.querySelector<HTMLElement>("[data-histogram-bars]");
  if (!layer) return;
  const min = Number(control.dataset.rangeMin), max = Number(control.dataset.rangeMax), span = max - min || 1;
  const peak = Math.max(...(data?.counts ?? []), 1);
  histogram.dataset.start = String(data?.start ?? min);
  histogram.dataset.size = String(data?.size ?? span);
  histogram.dataset.updated = "true";
  const bars = (data?.counts ?? []).flatMap((count, index) => {
    const low = Math.max(min, data!.start + index * data!.size);
    const high = Math.min(max, data!.start + (index + 1) * data!.size);
    if (high <= low) return [];
    const bar = document.createElement("span");
    bar.dataset.index = String(index);
    bar.dataset.count = String(count);
    bar.style.cssText = `--l:${(low - min) / span * 100}%;--w:${(high - low) / span * 100}%;--h:${Math.max(count / peak, count > 0 ? .08 : 0)}`;
    return [bar];
  });
  reconcileList(layer, bars, (bar) => bar.dataset.index, true);
  const tip = histogram.querySelector<HTMLElement>(".range-histogram-tip");
  if (tip) delete tip.dataset.visible;
}

// Tap a bar to pick that bucket, drag across bars to pick a span, tap the only
// selected bar again to clear. Values are written to the existing range sliders
// and announced with their own input event, so each gallery keeps one filter path.
export function enhanceRangeHistograms(root: HTMLElement): void {
  const signal = pageSignal();
  for (const histogram of root.querySelectorAll<HTMLElement>("[data-range-histogram]")) {
    const control = histogram.closest<HTMLElement>(".filter-range-control");
    const [minSlider, maxSlider] = control ? [...control.querySelectorAll<HTMLInputElement>('input[type="range"]')] : [];
    if (!control || !minSlider || !maxSlider) continue;
    let min: number, max: number, step: number, start: number, size: number, last: number;
    let bars: HTMLElement[] = [];
    const readAxis = () => {
      min = Number(control.dataset.rangeMin); max = Number(control.dataset.rangeMax); step = Number(control.dataset.rangeStep) || 1;
      start = Number(histogram.dataset.start); size = Number(histogram.dataset.size);
      bars = [...histogram.querySelectorAll<HTMLElement>("[data-index]:not([data-motion-ghost])")];
      last = Math.max(0, ...bars.map((bar) => Number(bar.dataset.index)));
    };
    readAxis();
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
      return Math.min(last, Math.max(0, Math.floor((value - start) / size + 1e-8)));
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
      readAxis();
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
    observer.observe(control, { attributes: true, attributeFilter: ["style", "data-range-min", "data-range-max"] });
    signal.addEventListener("abort", () => observer.disconnect(), { once: true });
    sync();
  }
}

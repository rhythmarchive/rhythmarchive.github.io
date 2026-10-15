import { loadStaticData } from "./static-data";
import { onPageLoad, pageSignal } from "./page-lifecycle";
import { createBatchTray, downloadSelectedBatchFromManifest } from "./batch-tray";
import { setupListNavigation } from "./list-navigation";
import { setupGalleryFilters } from "./gallery-filters";
import { galleryInputUpdates } from "./gallery-input";
import { observeImages } from "./viewport-images";
import { setupGalleryDownload } from "./gallery-download";
import { setupSearchableFilters } from "./searchable-filters";
import { showGalleryLoadError } from "./gallery-load-error";
import { createCardReconciler } from "./render-resource-card";
import { galleryCardView } from "../lib/card-view-model";
import type { GalleryCard } from "../lib/gallery-projection";
import { GALLERY_IMAGE_SIZES, SIDEBAR_IMAGE_SIZES } from "../lib/card-preview";
import { matchesChartFilters } from "../lib/chart-filters";
import { compareGalleryBpm, compareGalleryHighestConstant, compareNullableNumber, numericFacetValues } from "../lib/gallery-sort";
import { compareNaturalText, normalizeSearchText } from "../lib/search";
import { updateResourceStatsInDom } from "../lib/stats-client";
import { chipKey, reconcileList, setSurfaceVisible } from "./motion";
import { enhanceRangeHistograms } from "./range-histogram";

const PAGE_SIZE = 48;

type GalleryRange = {
  root: HTMLElement;
  key: string;
  min: number;
  max: number;
  step: number;
  minInput: HTMLInputElement;
  maxInput: HTMLInputElement;
  minSlider: HTMLInputElement;
  maxSlider: HTMLInputElement;
};

onPageLoad(() => {
  for (const root of document.querySelectorAll<HTMLElement>("[data-gallery-root]")) {
    if (root.dataset.galleryDefer === "true") {
      root.addEventListener("gallery:activate", () => {
        root.dataset.galleryDefer = "false";
        if (root.dataset.galleryInitialized !== "true") void initializeGallery(root);
      }, { once: true });
    } else {
      void initializeGallery(root);
    }
  }
});

async function initializeGallery(root: HTMLElement): Promise<void> {
  const signal = pageSignal();
  root.inert = true;
  root.setAttribute("aria-busy", "true");
  if (root.dataset.galleryInitialized === "true") return;
  root.dataset.galleryInitialized = "true";
  const grid = root.querySelector<HTMLElement>("[data-gallery-grid]");
  const loadMore = root.querySelector<HTMLButtonElement>("[data-load-more]");
  const count = root.querySelector<HTMLElement>("[data-gallery-count]");
  const search = root.querySelector<HTMLInputElement>("[data-gallery-search]");
  const sort = root.querySelector<HTMLSelectElement>("[data-gallery-sort]");
  const facets = [...root.querySelectorAll<HTMLSelectElement>("[data-gallery-facet]")];
  const ranges = [...root.querySelectorAll<HTMLElement>("[data-gallery-range]")]
    .map((rangeRoot): GalleryRange | undefined => {
      const minInput = rangeRoot.querySelector<HTMLInputElement>("[data-gallery-range-min-input]");
      const maxInput = rangeRoot.querySelector<HTMLInputElement>("[data-gallery-range-max-input]");
      const minSlider = rangeRoot.querySelector<HTMLInputElement>("[data-gallery-range-min-slider]");
      const maxSlider = rangeRoot.querySelector<HTMLInputElement>("[data-gallery-range-max-slider]");
      const min = Number(rangeRoot.dataset.rangeMin);
      const max = Number(rangeRoot.dataset.rangeMax);
      const step = Number(rangeRoot.dataset.rangeStep);
      if (!minInput || !maxInput || !minSlider || !maxSlider || !Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(step)) return undefined;
      return { root: rangeRoot, key: rangeRoot.dataset.galleryRange ?? "", min, max, step, minInput, maxInput, minSlider, maxSlider };
    })
    .filter((range): range is GalleryRange => Boolean(range));
  const reset = root.querySelector<HTMLButtonElement>("[data-gallery-reset]");
  const active = root.querySelector<HTMLElement>("[data-gallery-active]");
  const activeChips = root.querySelector<HTMLElement>("[data-gallery-active-chips]");
  if (!grid || !loadMore || !count) return;

  let resources: GalleryCard[] = [];
  const navigation = setupListNavigation(grid, root.dataset.galleryUrl ?? "gallery");
  let visibleCount = navigation.visibleCount(PAGE_SIZE);
  let batchTray: ReturnType<typeof createBatchTray> | undefined;
  let matchingResults: GalleryCard[] = [];
  let resultDownload: ReturnType<typeof setupGalleryDownload> | undefined;
  const reconcile = createCardReconciler(grid);
  const searchable = setupSearchableFilters(root);
  const filters = setupGalleryFilters(root, {
    apply: () => applyFilter("push"),
    reset: () => {
      for (const facet of facets) facet.value = "";
      for (const range of ranges) setRange(range, range.min, range.max);
      if (filters.draft()) filters.preview(); else applyFilter("push");
    },
    count: () => currentResources().length,
    restore: restoreControlsFromUrl,
    beforeOpen: () => updates.flush(),
  });
  const updates = galleryInputUpdates(() => applyFilter());

  try {
    resources = await loadStaticData<GalleryCard[]>(root.dataset.galleryUrl ?? "");
    if (signal.aborted) return;
    restoreControlsFromUrl();
    batchTray = createBatchTray({
      root,
      grid,
      onDetailLink: navigation.captureLink,
      selectionScope: location.pathname,
      getResource: (resourceId) => resources.find((resource) => resource.resourceId === resourceId),
      onDownload: (preferUpscaled, selectedIds, setStatus, taskSignal) => downloadSelectedBatchFromManifest({
        manifestUrl: root.dataset.batchUrl ?? "",
        selectedIds,
        getResource: (resourceId) => resources.find((resource) => resource.resourceId === resourceId),
        preferUpscaled,
        filename: "rhythm-archive-" + (root.dataset.game ?? "resources") + ".zip",
        setStatus,
        ...(taskSignal ? { signal: taskSignal } : {}),
      }),
    });
    resultDownload = setupGalleryDownload(root, () => matchingResults, batchTray, () => updates.flush());
    render();
    navigation.restore();
  } catch (error) {
    if (signal.aborted) return;
    console.error("Gallery data failed", error);
    root.inert = false;
    root.removeAttribute("aria-busy");
    showGalleryLoadError(root, count);
    return;
  }

  if (search) updates.text(search);
  sort?.addEventListener("change", () => applyFilter("push"));
  facets.forEach((facet) => facet.addEventListener("change", () => applyFilter("push")));
  for (const range of ranges) {
    range.minInput.addEventListener("change", () => updateRangeFromInput(range, "min"));
    range.maxInput.addEventListener("change", () => updateRangeFromInput(range, "max"));
    range.minSlider.addEventListener("input", () => updateRangeFromSlider(range, "min"));
    range.maxSlider.addEventListener("input", () => updateRangeFromSlider(range, "max"));
  }
  enhanceRangeHistograms(root);
  reset?.addEventListener("click", (event) => {
    event.preventDefault();
    if (search) search.value = "";
    if (sort) sort.value = sort.options[0]?.value ?? "default";
    for (const facet of facets) facet.value = "";
    for (const range of ranges) setRange(range, range.min, range.max);
    applyFilter("push");
  });
  loadMore.addEventListener("click", () => {
    visibleCount += PAGE_SIZE;
    render();
  });



  activeChips?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>("[data-remove-filter]");
    if (!button) return;
    const key = button.dataset.removeFilter ?? "";
    if (key === "q") {
      if (search) search.value = "";
    } else if (key.startsWith("range:")) {
      const range = ranges.find((candidate) => candidate.key === key.slice("range:".length));
      if (range) setRange(range, range.min, range.max);
    } else {
      const facet = facets.find((candidate) => candidate.dataset.galleryFacet === key);
      if (facet) facet.value = "";
    }
    applyFilter();
  });

  root.inert = false;
  root.removeAttribute("aria-busy");
  root.dataset.ready = "true";
  observeImages(grid);
  const pathname = location.pathname;
  window.addEventListener("popstate", () => {
    if (location.pathname !== pathname) return;
    restoreControlsFromUrl();
    visibleCount = history.state?.resourceListPosition?.url === location.pathname + location.search ? history.state.resourceListPosition.count : PAGE_SIZE;
    render();
  }, { signal });

  function restoreControlsFromUrl(): void {
    const params = new URLSearchParams(location.search);
    if (search) search.value = params.get("q") ?? "";
    if (sort) sort.value = params.get("sort") ?? sort.options[0]?.value ?? "default";
    for (const facet of facets) facet.value = params.get(`facet-${facet.dataset.galleryFacet}`) ?? "";
    for (const range of ranges) {
      const legacy = params.get(`facet-${range.key}`);
      setRange(range, parseRangeValue(params.get(`facet-${range.key}-min`) ?? legacy, range.min), parseRangeValue(params.get(`facet-${range.key}-max`) ?? legacy, range.max));
    }
    searchable.sync();
  }

  function currentResources(): GalleryCard[] {
    const query = normalizeSearchText(search?.value ?? "");
    const sortValue = sort?.value ?? "default";
    const chartDifficulty = facets.find((facet) => facet.dataset.galleryFacet === "chart")?.value;
    const chartLevel = facets.find((facet) => facet.dataset.galleryFacet === "level")?.value;
    const chartConstant = facets.find((facet) => facet.dataset.galleryFacet === "constant")?.value;
    const constantRange = ranges.find((range) => range.key === "constant");
    const selectedConstantRange = constantRange
      && (readRangeValue(constantRange, "min") > constantRange.min || readRangeValue(constantRange, "max") < constantRange.max)
      ? { min: readRangeValue(constantRange, "min"), max: readRangeValue(constantRange, "max") }
      : undefined;
    const chartCriteria = {
      ...(chartDifficulty ? { difficulties: [chartDifficulty] } : {}),
      ...(chartLevel ? { levels: [chartLevel] } : {}),
      ...(chartConstant ? { constants: [chartConstant] } : {}),
      ...(selectedConstantRange ? { constantRange: selectedConstantRange } : {}),
    };
    const filtered = resources.filter((resource) => {
      const text = [resource.displayTitle, resource.artist, resource.subtitle, ...(resource.badges ?? []), ...(resource.searchTerms ?? []), ...Object.values(resource.facets ?? {}).flat(), ...Object.values(resource.metadata).map(String)].filter(Boolean).join(" ");
      if (query && !normalizeSearchText(text).includes(query)) return false;
      const resourceFacetsMatch = facets
        .filter((facet) => !["chart", "level", "constant"].includes(facet.dataset.galleryFacet ?? ""))
        .every((facet) => {
          const value = facet.value;
          return !value || (resource.facets?.[facet.dataset.galleryFacet ?? ""] ?? []).includes(value);
        });
      return resourceFacetsMatch
        && matchesChartFilters(resource, chartCriteria)
        && ranges.filter((range) => range.key !== "constant").every((range) => matchesRange(resource, range));
    });
    if (sortValue === "default") return filtered;
    return [...filtered].sort((left, right) => {
      if (sortValue === "artist-asc" || sortValue === "artist-desc") {
        const artistCompared = compareNaturalText(left.artist ?? "", right.artist ?? "");
        return (sortValue === "artist-desc" ? -artistCompared : artistCompared) || compareNaturalText(left.displayTitle, right.displayTitle);
      }
      if (sortValue === "updated-desc" || sortValue === "updated-asc") {
        const compared = compareNullableNumber(resourceDateValue(left), resourceDateValue(right), sortValue === "updated-desc");
        return compared || compareNaturalText(left.displayTitle, right.displayTitle);
      }
      if (sortValue === "bpm-desc" || sortValue === "bpm-asc") {
        return compareGalleryBpm(left, right, sortValue === "bpm-desc");
      }
      if (sortValue === "level-desc" || sortValue === "level-asc") {
        return compareGalleryHighestConstant(left, right, sortValue === "level-desc");
      }
      const compared = compareNaturalText(left.displayTitle, right.displayTitle);
      return sortValue === "title-desc" ? -compared : compared;
    });
  }

  function applyFilter(historyMode: "push" | "replace" = "replace"): void {
    if (filters.draft()) { filters.preview(); return; }
    visibleCount = PAGE_SIZE;
    const url = new URL(window.location.href);
    if (search?.value) url.searchParams.set("q", search.value); else url.searchParams.delete("q");
    if (sort?.value && sort.value !== sort.options[0]?.value) url.searchParams.set("sort", sort.value); else url.searchParams.delete("sort");
    for (const facet of facets) {
      const key = `facet-${facet.dataset.galleryFacet ?? ""}`;
      if (facet.value) url.searchParams.set(key, facet.value); else url.searchParams.delete(key);
    }
    for (const range of ranges) {
      const min = readRangeValue(range, "min");
      const max = readRangeValue(range, "max");
      url.searchParams.delete(`facet-${range.key}`);
      if (min > range.min) url.searchParams.set(`facet-${range.key}-min`, formatRangeValue(min)); else url.searchParams.delete(`facet-${range.key}-min`);
      if (max < range.max) url.searchParams.set(`facet-${range.key}-max`, formatRangeValue(max)); else url.searchParams.delete(`facet-${range.key}-max`);
    }
    if (url.href !== location.href) {
      if (historyMode === "push") window.history.pushState({ ...history.state }, "", url);
      else window.history.replaceState({ ...history.state }, "", url);
    }
    render();
  }

  function render(): void {
    const filtered = currentResources();
    matchingResults = filtered;
    const visible = filtered.slice(0, visibleCount);
    reconcile(visible.map(galleryCardView), { basePath: root.dataset.basePath ?? "/", sizes: root.classList.contains("has-filters") ? SIDEBAR_IMAGE_SIZES : GALLERY_IMAGE_SIZES });
    navigation.remember(visibleCount);
    count!.textContent = `${filtered.length.toLocaleString("zh-CN")} 项资源`;
    root.querySelector<HTMLElement>("[data-gallery-result-count]")!.textContent = count!.textContent;
    resultDownload?.update();
    loadMore!.hidden = visible.length >= filtered.length;
    updateActiveFilters();
    searchable.sync();
    batchTray?.syncCards();
    void updateResourceStatsInDom(grid!);
  }

  function updateActiveFilters(): void {
    if (!active || !activeChips) return;
    const entries: Array<{ key: string; label: string }> = [];
    if (search?.value) entries.push({ key: "q", label: `搜索：${search.value}` });
    for (const facet of facets) {
      if (!facet.value) continue;
      entries.push({ key: facet.dataset.galleryFacet ?? "", label: facet.options[facet.selectedIndex]?.textContent ?? facet.value });
    }
    for (const range of ranges) {
      const min = readRangeValue(range, "min");
      const max = readRangeValue(range, "max");
      if (min > range.min || max < range.max) entries.push({ key: `range:${range.key}`, label: `${range.root.dataset.rangeLabel ?? range.key}：${formatRangeValue(min)}～${formatRangeValue(max)}` });
    }
    reconcileList(activeChips, entries.map(({ key, label }) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "active-filter-chip";
      chip.dataset.removeFilter = key;
      chip.textContent = `${label} ×`;
      return chip;
    }), chipKey);
    void setSurfaceVisible(active, entries.length > 0, "fade");
    const summary = root.querySelector<HTMLElement>("[data-filter-summary]");
    if (summary) summary.textContent = entries.length > 0 ? `（已选 ${entries.length}）` : "";
  }



  function updateRangeFromInput(range: GalleryRange, side: "min" | "max"): void {
    const input = side === "min" ? range.minInput : range.maxInput;
    const fallback = side === "min" ? readRangeValue(range, "min") : readRangeValue(range, "max");
    const value = parseRangeValue(input.value, fallback);
    const other = side === "min" ? readRangeValue(range, "max") : readRangeValue(range, "min");
    setRange(range, side === "min" ? Math.min(value, other) : other, side === "min" ? other : Math.max(value, other));
    applyFilter();
  }

  function updateRangeFromSlider(range: GalleryRange, side: "min" | "max"): void {
    const value = Number(side === "min" ? range.minSlider.value : range.maxSlider.value);
    const other = side === "min" ? readRangeValue(range, "max") : readRangeValue(range, "min");
    setRange(range, side === "min" ? Math.min(value, other) : other, side === "min" ? other : Math.max(value, other));
    updates.range();
  }

}

function parseRangeValue(value: string | null, fallback: number): number {
  const parsed = value === null || value.trim() === "" ? Number.NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatRangeValue(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

function readRangeValue(range: GalleryRange, side: "min" | "max"): number {
  return Number(side === "min" ? range.minSlider.value : range.maxSlider.value);
}

function snapRangeValue(value: number, range: GalleryRange): number {
  const snapped = range.min + Math.round((value - range.min) / range.step) * range.step;
  return Math.min(range.max, Math.max(range.min, Number(snapped.toFixed(4))));
}

function setRange(range: GalleryRange, minValue: number, maxValue: number): void {
  let min = snapRangeValue(minValue, range);
  let max = snapRangeValue(maxValue, range);
  if (min > max) [min, max] = [max, min];
  range.minInput.value = formatRangeValue(min);
  range.maxInput.value = formatRangeValue(max);
  range.minSlider.value = String(min);
  range.maxSlider.value = String(max);
  const span = range.max - range.min || 1;
  range.root.style.setProperty("--range-start", `${((min - range.min) / span) * 100}%`);
  range.root.style.setProperty("--range-end", `${((max - range.min) / span) * 100}%`);
}

function matchesRange(resource: GalleryCard, range: GalleryRange): boolean {
  const min = readRangeValue(range, "min");
  const max = readRangeValue(range, "max");
  if (min <= range.min && max >= range.max) return true;
  if (range.key === "bpm") {
    return (resource.facets?.bpm ?? []).some((value) => {
      const values = numericFacetValues(value);
      if (values.some((number) => number >= min && number <= max)) return true;
      return values.length > 1 && Math.min(...values) <= max && Math.max(...values) >= min;
    });
  }
  return (resource.charts ?? []).some((chart) => {
    const constant = Number(chart.constant);
    return Number.isFinite(constant) && constant >= min && constant <= max;
  });
}

function resourceDateValue(resource: GalleryCard): number | undefined {
  const value = resource.facets?.updateDate?.[0] ?? resource.metadata.updateDate;
  if (typeof value === "string") {
    const timestamp = Date.parse(value.replaceAll("/", "-"));
    if (Number.isFinite(timestamp)) return timestamp;
  }
  const version = resource.metadata.updateVersion;
  if (typeof version === "string") {
    const match = [...version.matchAll(/(20\d{2})[\/-](\d{1,2})[\/-](\d{1,2})/gu)].at(-1);
    if (match) return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }
  return undefined;
}

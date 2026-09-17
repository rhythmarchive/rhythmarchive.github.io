import { createBatchTray, downloadSelectedBatch } from "./batch-tray";
import { cardMediaFit, cardMediaRatio } from "../lib/media-config";
import { matchesChartFilters } from "../lib/chart-filters";
import { compareNaturalText, normalizeSearchText } from "../lib/search";
import { appendResourceViews, updateResourceStatsInDom } from "../lib/stats-client";
import type { PublicResource } from "../lib/types";

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

async function initializeGallery(root: HTMLElement): Promise<void> {
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

  let resources: PublicResource[] = [];
  let visibleCount = PAGE_SIZE;
  let batchTray: ReturnType<typeof createBatchTray> | undefined;

  try {
    const response = await fetch(root.dataset.galleryUrl ?? "", { credentials: "omit" });
    if (!response.ok) throw new Error(`gallery data failed with ${response.status}`);
    resources = await response.json() as PublicResource[];
    const params = new URLSearchParams(window.location.search);
    if (search) search.value = params.get("q") ?? "";
    if (sort) sort.value = params.get("sort") ?? sort.options[0]?.value ?? "default";
    for (const facet of facets) facet.value = params.get(`facet-${facet.dataset.galleryFacet ?? ""}`) ?? "";
    for (const range of ranges) {
      const legacyValue = params.get(`facet-${range.key}`);
      const minValue = params.get(`facet-${range.key}-min`) ?? legacyValue;
      const maxValue = params.get(`facet-${range.key}-max`) ?? legacyValue;
      setRange(range, parseRangeValue(minValue, range.min), parseRangeValue(maxValue, range.max));
    }
    batchTray = createBatchTray({
      root,
      grid,
      getResource: (resourceId) => resources.find((resource) => resource.resourceId === resourceId),
      onSelectionChange: () => render(),
      onDownload: (preferUpscaled, selectedIds, setStatus) => downloadSelectedBatch({
        selectedIds,
        getResource: (resourceId) => resources.find((resource) => resource.resourceId === resourceId),
        preferUpscaled,
        filename: "rhythm-archive-" + (root.dataset.game ?? "resources") + ".zip",
        setStatus,
      }),
    });
    render();
  } catch (error) {
    console.error("Gallery data failed", error);
    count.textContent = "图片加载失败";
    return;
  }

  search?.addEventListener("input", applyFilter);
  sort?.addEventListener("change", applyFilter);
  facets.forEach((facet) => facet.addEventListener("change", applyFilter));
  for (const range of ranges) {
    range.minInput.addEventListener("change", () => updateRangeFromInput(range, "min"));
    range.maxInput.addEventListener("change", () => updateRangeFromInput(range, "max"));
    range.minSlider.addEventListener("input", () => updateRangeFromSlider(range, "min"));
    range.maxSlider.addEventListener("input", () => updateRangeFromSlider(range, "max"));
  }
  reset?.addEventListener("click", (event) => {
    event.preventDefault();
    if (search) search.value = "";
    if (sort) sort.value = sort.options[0]?.value ?? "default";
    for (const facet of facets) facet.value = "";
    for (const range of ranges) setRange(range, range.min, range.max);
    applyFilter();
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

  function currentResources(): PublicResource[] {
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
        const compared = compareNullableNumber(numericFacetValue(left, "bpm"), numericFacetValue(right, "bpm"), sortValue === "bpm-desc");
        return compared || compareNaturalText(left.displayTitle, right.displayTitle);
      }
      if (sortValue === "level-desc" || sortValue === "level-asc") {
        const compared = compareNullableNumber(highestChartConstant(left), highestChartConstant(right), sortValue === "level-desc");
        return compared || compareNaturalText(left.displayTitle, right.displayTitle);
      }
      const compared = compareNaturalText(left.displayTitle, right.displayTitle);
      return sortValue === "title-desc" ? -compared : compared;
    });
  }

  function applyFilter(): void {
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
    window.history.replaceState({}, "", url);
    render();
  }

  function render(): void {
    const filtered = currentResources();
    const visible = filtered.slice(0, visibleCount);
    grid!.replaceChildren(...visible.map((resource, index) => createCard(resource, index, batchTray?.isSelected(resource.resourceId) ?? false)));
    count!.textContent = `${filtered.length.toLocaleString("zh-CN")} 项资源`;
    loadMore!.hidden = visible.length >= filtered.length;
    updateActiveFilters();
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
    activeChips.replaceChildren(...entries.map(({ key, label }) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "active-filter-chip";
      chip.dataset.removeFilter = key;
      chip.textContent = `${label} ×`;
      return chip;
    }));
    active.hidden = entries.length === 0;
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
    applyFilter();
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

function matchesRange(resource: PublicResource, range: GalleryRange): boolean {
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

function createCard(resource: PublicResource, index: number, isSelected: boolean): HTMLElement {
  const article = document.createElement("article");
  article.className = `resource-card${isSelected ? " is-selected" : ""}`;
  article.dataset.resourceCard = "";
  article.dataset.resourceId = resource.resourceId;
  article.dataset.game = resource.game;
  article.dataset.resourceType = resource.resourceType;
  article.dataset.mediaRatio = cardMediaRatio(resource.game, resource.resourceType);
  article.dataset.mediaFit = cardMediaFit(resource.game, resource.resourceType);
  const select = document.createElement("button");
  select.className = "resource-select";
  select.type = "button";
  select.dataset.selectResource = resource.resourceId;
  select.setAttribute("aria-pressed", String(isSelected));
  select.setAttribute("aria-label", `${isSelected ? "取消选择" : "选择"} ${resource.displayTitle}`);
  select.innerHTML = "<span aria-hidden=\"true\">✓</span>";
  article.append(select);

  const anchor = document.createElement("a");
  anchor.className = "resource-card-link";
  anchor.href = resolveSitePath(resource.route);
  const media = document.createElement("div");
  media.className = "resource-card-media";
  const useOriginalGallerySource = ["arcaea", "paradigm-reboot"].includes(resource.game) && resource.resourceType === "jacket" && Boolean(resource.original);
  const image = useOriginalGallerySource ? resource.original : resource.preview.small ?? resource.preview.medium ?? resource.preview.large;
  const fallbackImage = useOriginalGallerySource ? resource.preview.small ?? resource.preview.medium ?? resource.preview.large : resource.original;
  if (image) {
    const img = document.createElement("img");
    img.src = image.url;
    img.alt = resource.displayTitle;
    const imageWidth = image.width ?? fallbackImage?.width;
    const imageHeight = image.height ?? fallbackImage?.height;
    if (imageWidth) img.width = imageWidth;
    if (imageHeight) img.height = imageHeight;
    img.loading = index < 6 ? "eager" : "lazy";
    img.decoding = "async";
    const srcset = useOriginalGallerySource ? "" : [resource.preview.small ? resource.preview.small.url + " 320w" : "", resource.preview.medium ? resource.preview.medium.url + " 640w" : ""].filter(Boolean).join(", ");
    if (srcset) img.setAttribute("srcset", srcset);
    if (fallbackImage?.url) {
      img.dataset.fallbackSrc = fallbackImage.url;
      if (fallbackImage.width) img.dataset.fallbackWidth = String(fallbackImage.width);
      if (fallbackImage.height) img.dataset.fallbackHeight = String(fallbackImage.height);
    }
    img.sizes = "(max-width: 640px) 50vw, (max-width: 1280px) 20vw, 210px";
    media.append(img);
  } else {
    const placeholder = document.createElement("div");
    placeholder.className = "resource-card-placeholder";
    placeholder.textContent = "图片暂不可用";
    media.append(placeholder);
  }
  if (resource.upscaled) {
    const badge = document.createElement("span");
    badge.className = "resource-badge is-upscaled";
    badge.textContent = "含超分版";
    media.append(badge);
  }
  const body = document.createElement("div");
  body.className = "resource-card-body";
  const title = document.createElement("h3");
  title.textContent = resource.displayTitle;
  body.append(title);
  if (resource.artist) {
    const artist = document.createElement("p");
    artist.textContent = resource.artist;
    body.append(artist);
  }
  if (resource.subtitle) {
    const subtitle = document.createElement("p");
    subtitle.className = "resource-card-subtitle";
    subtitle.textContent = resource.subtitle;
    body.append(subtitle);
  }
  for (const badge of resource.badges ?? []) {
    const label = document.createElement("span");
    label.className = "resource-card-variant";
    label.textContent = badge;
    body.append(label);
  }
  const variant = resource.badges?.length ? undefined : resource.variants.find((item) => item.label !== "默认");
  if (variant) {
    const label = document.createElement("span");
    label.className = "resource-card-variant";
    label.textContent = variant.label;
    body.append(label);
  }
  appendResourceViews(body);
  anchor.append(media, body);
  article.append(anchor);
  return article;
}

function resolveSitePath(path: string): string {
  const base = document.querySelector<HTMLElement>("[data-gallery-root]")?.dataset.basePath ?? "/";
  const clean = path.startsWith("/") ? path : `/${path}`;
  return base === "/" ? clean : `${base.replace(/\/+$/u, "")}${clean}`;
}

function numericFacetValue(resource: PublicResource, key: string): number | undefined {
  const values = resource.facets?.[key] ?? (resource.metadata[key] === undefined ? [] : [String(resource.metadata[key])]);
  const numbers = values.flatMap((value) => numericFacetValues(value));
  return numbers.length > 0 ? Math.max(...numbers) : undefined;
}

function numericFacetValues(value: string): number[] {
  return [...value.matchAll(/\d+(?:\.\d+)?/gu)].map((match) => Number(match[0])).filter((number) => Number.isFinite(number));
}

function highestChartConstant(resource: PublicResource): number | undefined {
  const values = (resource.charts ?? [])
    .map((chart) => chart.constant === undefined ? Number.NaN : Number(chart.constant))
    .filter((value) => Number.isFinite(value));
  return values.length > 0 ? Math.max(...values) : undefined;
}

function resourceDateValue(resource: PublicResource): number | undefined {
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

function compareNullableNumber(left: number | undefined, right: number | undefined, descending: boolean): number {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return descending ? right - left : left - right;
}

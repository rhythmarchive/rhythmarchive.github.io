import { zipSync } from "fflate";
import { DOWNLOAD_CONCURRENCY, MAX_BATCH_BYTES, MAX_BATCH_FILES, uniqueZipFilename } from "../lib/batch";
import {
  BROWSE_PAGE_SIZE,
  type BrowseFacetOptions,
  type BrowseGame,
  type BrowseGalleryData,
  type BrowseGalleryItem,
  type BrowseResolvedResource,
  type BrowseUrlState,
  defaultBrowseUrlState,
  displayBrowseItem,
  filterBrowseItems,
  groupBrowseFacetOptions,
  getBrowseFacetOptions,
  parseBrowseUrlState,
  serializeBrowseUrlState,
} from "../lib/browse-gallery";
import { cardMediaFit, cardMediaRatio } from "../lib/media-config";
import { formatArcaeaAddedVersion } from "../lib/public-display";
import type { PublicDownload } from "../lib/types";

const root = document.querySelector<HTMLElement>("[data-browse-gallery-root]");
if (root) void initializeBrowseGallery(root);

async function initializeBrowseGallery(root: HTMLElement): Promise<void> {
  const grid = root.querySelector<HTMLElement>("[data-gallery-grid]");
  const loadMore = root.querySelector<HTMLButtonElement>("[data-load-more]");
  const count = root.querySelector<HTMLElement>("[data-gallery-count]");
  const empty = root.querySelector<HTMLElement>("[data-browse-empty]");
  const search = root.querySelector<HTMLInputElement>("[data-browse-search]");
  const sort = root.querySelector<HTMLSelectElement>("[data-browse-sort]");
  const ai = root.querySelector<HTMLInputElement>("[data-filter-ai]");
  const reset = root.querySelector<HTMLButtonElement>("[data-gallery-reset]");
  const emptyReset = root.querySelector<HTMLButtonElement>("[data-browse-empty-reset]");
  const activeChips = root.querySelector<HTMLElement>("[data-browse-active-chips]");
  if (!grid || !loadMore || !count || !search || !sort) return;

  const game: BrowseGame = root.dataset.game === "rizline" ? "rizline" : root.dataset.game === "phigros" ? "phigros" : "arcaea";
  let items: BrowseGalleryItem[] = [];
  let state: BrowseUrlState = defaultBrowseUrlState(game);
  let visibleCount = BROWSE_PAGE_SIZE;
  const selected = new Set<string>();

  try {
    const response = await fetch(root.dataset.galleryUrl ?? "", { credentials: "omit" });
    if (!response.ok) throw new Error("browse gallery data failed with " + response.status);
    const data = await response.json() as BrowseGalleryData;
    if (data.schemaVersion !== 1 || data.game !== game || data.category !== "jacket" || !Array.isArray(data.items)) throw new Error("browse gallery data has an invalid shape");
    items = data.items;
    populateFacetOptions(data, root);
    state = readState(game, items);
    applyStateToControls(state);
    render();
  } catch (error) {
    console.error("Browse gallery data failed", error);
    count.textContent = "图片加载失败";
    return;
  }

  search.addEventListener("input", () => commitState("replace"));
  sort.addEventListener("change", () => commitState("push"));
  root.querySelectorAll<HTMLInputElement>("[data-browse-filter-check]").forEach((input) => input.addEventListener("change", () => commitState("push")));
  root.querySelectorAll<HTMLButtonElement>("[data-browse-filter-toggle]").forEach((button) => button.addEventListener("click", () => {
    button.setAttribute("aria-pressed", String(button.getAttribute("aria-pressed") !== "true"));
    commitState("push");
  }));
  ai?.addEventListener("change", () => commitState("push"));
  root.querySelectorAll<HTMLInputElement>("[data-browse-option-search]").forEach((input) => input.addEventListener("input", () => filterPopoverOptions(input)));
  activeChips?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>("[data-remove-filter]");
    if (!button) return;
    const name = button.dataset.removeFilter;
    const value = button.dataset.removeValue;
    if (!name) return;
    if (name === "ai") {
      if (ai) ai.checked = false;
    } else if (name === "chart") {
      root.querySelector<HTMLButtonElement>(`[data-browse-filter-toggle="${name}"][data-value="${CSS.escape(value ?? "")}"]`)?.setAttribute("aria-pressed", "false");
    } else {
      const input = [...root.querySelectorAll<HTMLInputElement>(`[data-browse-filter-check="${name}"]`)].find((candidate) => checkboxValues(candidate).includes(value ?? ""));
      if (input) {
        input.checked = false;
        input.indeterminate = false;
      }
    }
    commitState("push");
  });
  reset?.addEventListener("click", (event) => {
    event.preventDefault();
    resetState();
  });
  emptyReset?.addEventListener("click", () => resetState());
  loadMore.addEventListener("click", () => {
    visibleCount += BROWSE_PAGE_SIZE;
    render();
  });
  window.addEventListener("popstate", () => {
    state = readState(game, items);
    applyStateToControls(state);
    visibleCount = BROWSE_PAGE_SIZE;
    render();
  });
  grid.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>("[data-select-resource]");
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const id = button.dataset.selectResource;
    if (!id) return;
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    updateBatchBar();
    render();
  });

  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-batch-download]")) button.addEventListener("click", () => void downloadBatch(button.dataset.batchDownload === "upscaled"));

  function readState(gameId: BrowseGame, browseItems: BrowseGalleryItem[]): BrowseUrlState {
    const parsed = parseBrowseUrlState(gameId, window.location.search, browseItems);
    return gameId === "phigros" ? { ...parsed, chart: [] } : parsed;
  }

  function currentStateFromControls(): BrowseUrlState {
    if (game === "arcaea") {
      return {
        game,
        q: search!.value,
        sort: sort!.value as Extract<BrowseUrlState, { game: "arcaea" }>["sort"],
        pack: selectedValues(root, "pack"),
        chart: selectedValues(root, "chart") as Extract<BrowseUrlState, { game: "arcaea" }>["chart"],
        level: selectedValues(root, "level"),
        version: selectedValues(root, "version"),
        ai: ai?.checked ?? false,
      };
    }
    if (game === "phigros") return { game, q: search!.value, sort: sort!.value as Extract<BrowseUrlState, { game: "phigros" }>["sort"], chart: [] };
    return {
      game,
      q: search!.value,
      sort: sort!.value as Extract<BrowseUrlState, { game: "rizline" }>["sort"],
      disc: selectedValues(root, "disc"),
      series: selectedValues(root, "series"),
      chart: [],
    };
  }

  function commitState(historyMode: "push" | "replace"): void {
    state = currentStateFromControls();
    const url = new URL(window.location.href);
    const serialized = serializeBrowseUrlState(state).toString();
    url.search = serialized ? "?" + serialized : "";
    if (historyMode === "push") window.history.pushState(null, "", url); else window.history.replaceState(null, "", url);
    visibleCount = BROWSE_PAGE_SIZE;
    render();
  }

  function resetState(): void {
    state = defaultBrowseUrlState(game);
    applyStateToControls(state);
    const url = new URL(window.location.href);
    url.search = "";
    window.history.pushState(null, "", url);
    visibleCount = BROWSE_PAGE_SIZE;
    render();
  }

  function applyStateToControls(nextState: BrowseUrlState): void {
    search!.value = nextState.q;
    sort!.value = nextState.sort;
    setSelectedValues(root, "chart", nextState.chart);
    if (nextState.game === "arcaea") {
      setSelectedValues(root, "pack", nextState.pack);
      setSelectedValues(root, "level", nextState.level);
      setSelectedValues(root, "version", nextState.version);
      if (ai) ai.checked = nextState.ai;
    } else if (nextState.game === "rizline") {
      setSelectedValues(root, "disc", nextState.disc);
      setSelectedValues(root, "series", nextState.series);
    }
    updatePopoverSummaries(root);
  }

  function render(): void {
    const filtered = filterBrowseItems(items, state);
    const visible = filtered.slice(0, visibleCount).map((item) => displayBrowseItem(item, state.chart));
    grid!.replaceChildren(...visible.map((item, index) => createCard(item, index, selected.has(item.resourceId))));
    count!.textContent = filtered.length.toLocaleString("zh-CN") + " 项资源";
    loadMore!.hidden = visible.length >= filtered.length;
    if (empty) empty.hidden = filtered.length !== 0;
    updateActiveFilters(root, state);
    updateBatchBar();
  }

  function updateBatchBar(): void {
    const bar = root.querySelector<HTMLElement>("[data-batch-bar]");
    const countNode = root.querySelector<HTMLElement>("[data-batch-count]");
    if (!bar || !countNode) return;
    bar.hidden = selected.size === 0;
    countNode.textContent = "已选择 " + selected.size.toLocaleString("zh-CN") + " 项";
  }

  async function downloadBatch(preferUpscaled: boolean): Promise<void> {
    const resources = new Map<string, BrowseResolvedResource>();
    for (const item of items) {
      resources.set(item.resourceId, item);
      for (const artwork of item.artworks) resources.set(artwork.resourceId, artwork);
    }
    const selectedResources = [...selected].map((resourceId) => resources.get(resourceId)).filter((resource): resource is BrowseResolvedResource => Boolean(resource));
    const status = root.querySelector<HTMLElement>("[data-batch-status]");
    if (selectedResources.length === 0) return;
    if (selectedResources.length > MAX_BATCH_FILES) {
      if (status) status.textContent = "一次选择的文件较多，请减少后再下载。";
      return;
    }
    const entriesToDownload = selectedResources.map((resource) => ({ resource, download: chooseDownload(resource, preferUpscaled) }));
    if (entriesToDownload.some((item) => !item.download)) {
      if (status) status.textContent = "下载失败，请重试";
      return;
    }
    const totalBytes = entriesToDownload.reduce((sum, item) => sum + (item.download?.sizeBytes ?? 0), 0);
    if (totalBytes > MAX_BATCH_BYTES) {
      if (status) status.textContent = "一次选择的文件较多，请减少后再下载。";
      return;
    }
    const entries: Record<string, Uint8Array> = {};
    const usedNames = new Set<string>();
    let completed = 0;
    if (status) status.textContent = "正在准备 0 / " + entriesToDownload.length;
    try {
      await runWithConcurrency(entriesToDownload, DOWNLOAD_CONCURRENCY, async ({ download }) => {
        const response = await fetch(download!.url, { credentials: "omit" });
        if (!response.ok) throw new Error("download failed with " + response.status);
        entries[uniqueZipFilename(usedNames, download!.downloadFilename)] = new Uint8Array(await response.arrayBuffer());
        completed += 1;
        if (status) status.textContent = "正在准备 " + completed + " / " + entriesToDownload.length;
      });
      const archive = zipSync(entries, { level: 0 });
      const url = URL.createObjectURL(new Blob([archive.buffer as ArrayBuffer], { type: "application/zip" }));
      triggerDownload(url, "rhythm-archive-" + game + ".zip");
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      if (status) status.textContent = "";
    } catch (error) {
      console.error("Browse batch download failed", error);
      if (status) status.textContent = "下载失败，请重试";
    }
  }
}

function populateFacetOptions(data: BrowseGalleryData, root: HTMLElement): void {
  const options = getBrowseFacetOptions(data);
  const setToggles = (name: string, values: string[]) => {
    const container = root.querySelector<HTMLElement>(`[data-browse-toggle-options="${name}"]`);
    if (!container) return;
    container.replaceChildren(...values.map((value) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "filter-toggle-chip";
      button.dataset.browseFilterToggle = name;
      button.dataset.value = value;
      button.setAttribute("aria-pressed", "false");
      button.textContent = value;
      return button;
    }));
  };
  const setCheckboxes = (name: string, values: string[], formatValue?: (value: string) => string) => {
    const container = root.querySelector<HTMLElement>(`[data-browse-options="${name}"]`);
    if (!container) return;
    container.replaceChildren(...groupBrowseFacetOptions(values, formatValue).map(({ label: displayValue, values: internalValues }) => {
      const label = document.createElement("label");
      label.className = "filter-option";
      label.dataset.filterText = displayValue.toLocaleLowerCase("zh-CN");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.dataset.browseFilterCheck = name;
      input.value = internalValues[0] ?? displayValue;
      input.dataset.browseFilterValues = internalValues.join(",");
      const text = document.createElement("span");
      text.textContent = displayValue;
      label.append(input, text);
      return label;
    }));
  };
  if (data.game === "arcaea") {
    const arcaeaOptions = options as Extract<BrowseFacetOptions, { packs: string[] }>;
    setToggles("chart", arcaeaOptions.charts);
    setCheckboxes("pack", arcaeaOptions.packs);
    setCheckboxes("level", arcaeaOptions.levels);
    setCheckboxes("version", arcaeaOptions.versions, formatArcaeaAddedVersion);
    return;
  }
  if (data.game === "rizline") {
    const rizlineOptions = options as Extract<BrowseFacetOptions, { discs: string[] }>;
    setCheckboxes("disc", rizlineOptions.discs);
    setCheckboxes("series", rizlineOptions.trackSeries);
  }
}

function selectedValues(root: HTMLElement, name: string): string[] {
  const checked = [...root.querySelectorAll<HTMLInputElement>(`[data-browse-filter-check="${name}"]:checked`)].flatMap((input) => checkboxValues(input));
  const toggled = [...root.querySelectorAll<HTMLButtonElement>(`[data-browse-filter-toggle="${name}"][aria-pressed="true"]`)].map((button) => button.dataset.value ?? "");
  return [...checked, ...toggled].filter(Boolean);
}

function setSelectedValues(root: HTMLElement, name: string, values: string[]): void {
  const selected = new Set(values);
  root.querySelectorAll<HTMLInputElement>(`[data-browse-filter-check="${name}"]`).forEach((input) => {
    const optionValues = checkboxValues(input);
    const selectedCount = optionValues.filter((value) => selected.has(value)).length;
    input.checked = selectedCount > 0;
    input.indeterminate = selectedCount > 0 && selectedCount < optionValues.length;
  });
  root.querySelectorAll<HTMLButtonElement>(`[data-browse-filter-toggle="${name}"]`).forEach((button) => { button.setAttribute("aria-pressed", String(selected.has(button.dataset.value ?? ""))); });
}

function checkboxValues(input: HTMLInputElement): string[] {
  return (input.dataset.browseFilterValues ?? input.value).split(",").filter(Boolean);
}

function updatePopoverSummaries(root: HTMLElement): void {
  for (const summary of root.querySelectorAll<HTMLElement>("[data-browse-summary]")) {
    const name = summary.dataset.browseSummary ?? "";
    const rawValues = selectedValues(root, name);
    const values = name === "version" ? [...new Set(rawValues.map(formatArcaeaAddedVersion))] : rawValues;
    const label = name === "pack" ? "曲包" : name === "level" ? "等级" : name === "disc" ? "Disc" : name === "series" ? "精选集" : "版本";
    summary.textContent = values.length === 0 ? label : values.length === 1 ? values[0]! : `${label} ${values.length}`;
  }
}

function updateActiveFilters(root: HTMLElement, state: BrowseUrlState): void {
  const row = root.querySelector<HTMLElement>("[data-browse-active]");
  const chips = root.querySelector<HTMLElement>("[data-browse-active-chips]");
  if (!row || !chips) return;
  const entries: Array<{ name: string; value: string; label: string }> = [];
  if (state.q) entries.push({ name: "q", value: state.q, label: `搜索：${state.q}` });
  if (state.game === "arcaea") {
    for (const value of state.pack) entries.push({ name: "pack", value, label: value });
    for (const value of state.chart) entries.push({ name: "chart", value, label: value });
    for (const value of state.level) entries.push({ name: "level", value, label: value });
    const versionEntries = new Map<string, string>();
    for (const value of state.version) versionEntries.set(formatArcaeaAddedVersion(value), value);
    for (const [label, value] of versionEntries) entries.push({ name: "version", value, label });
    if (state.ai) entries.push({ name: "ai", value: "1", label: "含超分版" });
  } else if (state.game === "rizline") {
    for (const value of state.disc) entries.push({ name: "disc", value, label: value });
    for (const value of state.series) entries.push({ name: "series", value, label: value });
  }
  chips.replaceChildren(...entries.map((entry) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "active-filter-chip";
    chip.dataset.removeFilter = entry.name;
    chip.dataset.removeValue = entry.value;
    chip.textContent = entry.name === "q" ? entry.label : `${entry.label} ×`;
    return chip;
  }));
  row.hidden = entries.length === 0;
  updatePopoverSummaries(root);
}

function filterPopoverOptions(input: HTMLInputElement): void {
  const name = input.dataset.browseOptionSearch ?? "";
  const query = input.value.toLocaleLowerCase("zh-CN");
  document.querySelectorAll<HTMLElement>(`[data-browse-options="${name}"] .filter-option`).forEach((option) => { option.hidden = Boolean(query) && !(option.dataset.filterText ?? "").includes(query); });
}

function createCard(item: BrowseGalleryItem, index: number, isSelected: boolean): HTMLElement {
  const article = document.createElement("article");
  article.className = "resource-card" + (isSelected ? " is-selected" : "");
  article.dataset.browseCard = "";
  article.dataset.resourceCard = "";
  article.dataset.resourceId = item.resourceId;
  article.dataset.game = item.game;
  article.dataset.resourceType = item.resourceType;
  article.dataset.mediaRatio = cardMediaRatio(item.game, item.resourceType);
  article.dataset.mediaFit = cardMediaFit(item.game, item.resourceType);

  const select = document.createElement("button");
  select.className = "resource-select";
  select.type = "button";
  select.dataset.selectResource = item.resourceId;
  select.setAttribute("aria-pressed", String(isSelected));
  select.setAttribute("aria-label", (isSelected ? "取消选择 " : "选择 ") + item.displayTitle);
  select.innerHTML = "<span aria-hidden=\"true\">✓</span>";
  article.append(select);

  const anchor = document.createElement("a");
  anchor.className = "resource-card-link";
  anchor.href = resolveSitePath(item.route);
  const media = document.createElement("div");
  media.className = "resource-card-media";
  const image = item.preview.small ?? item.preview.medium ?? item.preview.large;
  if (image) {
    const img = document.createElement("img");
    img.src = image.url;
    img.alt = item.displayTitle;
    img.width = image.width;
    img.height = image.height;
    img.loading = index < 6 ? "eager" : "lazy";
    img.decoding = "async";
    const srcset = [item.preview.small ? item.preview.small.url + " 320w" : "", item.preview.medium ? item.preview.medium.url + " 640w" : ""].filter(Boolean).join(", ");
    if (srcset) img.setAttribute("srcset", srcset);
    img.sizes = "(max-width: 640px) 50vw, (max-width: 1280px) 20vw, 210px";
    media.append(img);
  } else {
    const placeholder = document.createElement("div");
    placeholder.className = "resource-card-placeholder";
    placeholder.textContent = "图片暂不可用";
    media.append(placeholder);
  }
  if (item.hasUpscaled) {
    const badge = document.createElement("span");
    badge.className = "resource-badge is-upscaled";
    badge.textContent = "含超分版";
    media.append(badge);
  }
  const body = document.createElement("div");
  body.className = "resource-card-body";
  const title = document.createElement("h3");
  title.textContent = item.displayTitle;
  body.append(title);
  if (item.artist) {
    const artist = document.createElement("p");
    artist.textContent = item.artist;
    body.append(artist);
  }
  const metadata = [ ...(item.badges ?? []), item.badge, item.selectedArtworkDifficulty, item.game === "arcaea" ? item.pack : undefined ].filter((value): value is string => Boolean(value));
  for (const value of metadata) {
    const label = document.createElement("span");
    label.className = "resource-card-variant";
    label.textContent = value;
    body.append(label);
  }
  anchor.append(media, body);
  article.append(anchor);
  return article;
}

function chooseDownload(resource: BrowseResolvedResource, preferUpscaled: boolean): PublicDownload | undefined {
  return preferUpscaled ? resource.upscaled ?? resource.original : resource.original;
}

async function runWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      if (item !== undefined) await worker(item);
    }
  });
  await Promise.all(workers);
}

function triggerDownload(url: string, filename: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

function resolveSitePath(path: string): string {
  const base = document.querySelector<HTMLElement>("[data-browse-gallery-root]")?.dataset.basePath ?? "/";
  const clean = path.startsWith("/") ? path : "/" + path;
  return base === "/" ? clean : base.replace(/\/+$/u, "") + clean;
}

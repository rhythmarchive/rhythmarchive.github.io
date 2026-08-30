import type { ArcaeaStoryAtlasType } from "../../../../packages/domain/src/browse.js";

type CompactResource = {
  resourceId: string;
  route: string;
  title: string;
  subtitle?: string;
  thumb?: string;
  preview?: string;
  original?: string;
  download?: string;
  downloadFilename?: string;
  assetPaths: string[];
};
type CompactEntry = {
  id: string;
  pathId: number;
  key: string;
  pathTitle: string;
  sectionLabel: string;
  sectionAct: number;
  visualLabel: string;
  characterIds: number[];
  characterLabels: string[];
  relatedSongs: string[];
  unlockLabel?: string;
  staffRoll: boolean;
  storyType?: string;
  storyData?: string;
  sceneIds: string[];
  resourceIds: string[];
};
type CompactScene = {
  sceneId: string;
  pathId?: number;
  pathTitle: string;
  sectionLabel: string;
  sectionAct: number;
  kind: string;
  displayTitle: string;
  scriptStem?: string;
  resourceIds: string[];
};
type ClientPayload = { entries: CompactEntry[]; scenes: CompactScene[]; resources: Record<string, CompactResource> };
type Camera = { x: number; y: number; scale: number };
type Pointer = { x: number; y: number; startX: number; startY: number; interactive: boolean };
type Gesture = {
  pointers: Map<number, Pointer>;
  dragging: boolean;
  moved: boolean;
  pinchStart?: { distance: number; scale: number; worldX: number; worldY: number };
};
type StoryTextEntry = ArcaeaStoryAtlasType["text"]["entries"][number];
type StoryTextBlock = StoryTextEntry["texts"][string]["blocks"][number];
type StoryPage = { page: number; blocks: StoryTextBlock[] };
type ReaderState = {
  targetKey: string;
  locale?: string;
  page: number;
  activeVisualId?: string;
  visualManual?: boolean;
};

const root = document.querySelector<HTMLElement>("[data-story-atlas-root]");
if (root) void initialize(root);

async function initialize(root: HTMLElement): Promise<void> {
  const payloadNode = root.querySelector<HTMLScriptElement>("[data-story-atlas-client-index]");
  if (!payloadNode?.textContent) return;
  const payload = JSON.parse(payloadNode.textContent) as ClientPayload;
  const panels = [...root.querySelectorAll<HTMLElement>("[data-story-section-panel]")];
  const tabs = [...root.querySelectorAll<HTMLButtonElement>("[data-story-part-tabs] [data-story-section]")];
  const gallery = document.querySelector<HTMLElement>("[data-gallery-root]");
  const search = root.querySelector<HTMLInputElement>("[data-story-search]");
  const searchStatus = root.querySelector<HTMLElement>("[data-story-search-status]");
  const searchResults = root.querySelector<HTMLElement>("[data-story-search-results]");
  const detail = root.querySelector<HTMLElement>("[data-story-detail]");
  const detailContent = root.querySelector<HTMLElement>("[data-story-detail-content]");
  if (panels.length === 0 || !detail || !detailContent) return;
  const detailElement = detail;
  const detailContentElement = detailContent;

  const cameras = new Map<HTMLElement, Camera>();
  const gestures = new Map<HTMLElement, Gesture>();
  let activePanel = panels.find((panel) => !panel.hidden) ?? panels[0]!;
  let suppressClickUntil = 0;
  let atlasPromise: Promise<ArcaeaStoryAtlasType> | undefined;
  let selectedLocale: Record<string, string> = {};
  let selectedCgIndex = 0;
  let readerState: ReaderState | undefined;
  let lastFocusedElement: HTMLElement | null = null;

  const CAMERA_MIN = 0.42;
  const CAMERA_FIT_MIN = 0.16;
  const CAMERA_MAX = 1.65;
  const DRAG_THRESHOLD = 5;
  const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
  const panelViewport = (panel: HTMLElement): HTMLElement | null => panel.querySelector<HTMLElement>("[data-story-map-viewport]");
  const panelWorld = (panel: HTMLElement): HTMLElement | null => panel.querySelector<HTMLElement>("[data-story-map-world]");
  const gestureFor = (viewport: HTMLElement): Gesture => {
    const current = gestures.get(viewport);
    if (current) return current;
    const created: Gesture = { pointers: new Map(), dragging: false, moved: false };
    gestures.set(viewport, created);
    return created;
  };

  function cameraFor(panel: HTMLElement): Camera {
    const current = cameras.get(panel);
    if (current) return current;
    const viewport = panelViewport(panel);
    const world = panelWorld(panel);
    const initial = viewport && world ? fitCamera(viewport, world) : { x: 0, y: 0, scale: 0.82 };
    cameras.set(panel, initial);
    return initial;
  }

 function renderCamera(panel: HTMLElement): void {
    const viewport = panelViewport(panel);
    const world = panelWorld(panel);
    if (!viewport || !world) return;
    const camera = cameraFor(panel);
    clampCamera(viewport, world, camera, camera.scale < CAMERA_MIN ? CAMERA_FIT_MIN : CAMERA_MIN);
    world.style.transformOrigin = "0 0";
    world.style.transform = `translate3d(${camera.x}px,${camera.y}px,0) scale(${camera.scale})`;
    panel.dataset.storyCameraScale = camera.scale.toFixed(3);
 }

  function fitCamera(viewport: HTMLElement, world: HTMLElement): Camera {
    const width = Number(world.dataset.worldWidth ?? viewport.dataset.worldWidth ?? 1600);
    const height = Number(world.dataset.worldHeight ?? viewport.dataset.worldHeight ?? 900);
    const padding = cameraPadding(viewport);
    const scale = clamp(Math.min((viewport.clientWidth - padding * 2) / width, (viewport.clientHeight - padding * 2) / height), CAMERA_FIT_MIN, 1.05);
    const camera = { x: (viewport.clientWidth - width * scale) / 2, y: (viewport.clientHeight - height * scale) / 2, scale };
    clampCamera(viewport, world, camera, CAMERA_FIT_MIN);
    return camera;
  }

  function fitPanel(panel: HTMLElement): void {
    const viewport = panelViewport(panel);
    const world = panelWorld(panel);
    if (!viewport || !world) return;
    cameras.set(panel, fitCamera(viewport, world));
    renderCamera(panel);
  }

  function resetPanel(panel: HTMLElement): void {
    const viewport = panelViewport(panel);
    const world = panelWorld(panel);
    if (!viewport || !world) return;
    const width = Number(world.dataset.worldWidth ?? 1600);
    const height = Number(world.dataset.worldHeight ?? 900);
    const scale = clamp(0.82, CAMERA_MIN, CAMERA_MAX);
    const camera = { x: (viewport.clientWidth - width * scale) / 2, y: (viewport.clientHeight - height * scale) / 2, scale };
    clampCamera(viewport, world, camera);
    cameras.set(panel, camera);
    renderCamera(panel);
  }

  function focusPoint(panel: HTMLElement, x: number, y: number, requestedScale?: number): void {
    const viewport = panelViewport(panel);
    if (!viewport) return;
    const camera = cameraFor(panel);
    const scale = clamp(requestedScale ?? Math.max(camera.scale, 0.92), CAMERA_MIN, CAMERA_MAX);
    camera.scale = scale;
    camera.x = viewport.clientWidth / 2 - x * scale;
    camera.y = viewport.clientHeight / 2 - y * scale;
    renderCamera(panel);
  }

  function zoomAround(panel: HTMLElement, nextScale: number, clientX?: number, clientY?: number): void {
    const viewport = panelViewport(panel);
    if (!viewport) return;
    const camera = cameraFor(panel);
    const rect = viewport.getBoundingClientRect();
    const localX = clientX === undefined ? viewport.clientWidth / 2 : clientX - rect.left;
    const localY = clientY === undefined ? viewport.clientHeight / 2 : clientY - rect.top;
    const worldX = (localX - camera.x) / camera.scale;
    const worldY = (localY - camera.y) / camera.scale;
    camera.scale = clamp(nextScale, CAMERA_MIN, CAMERA_MAX);
    camera.x = localX - worldX * camera.scale;
    camera.y = localY - worldY * camera.scale;
    renderCamera(panel);
 }

  function cameraPadding(viewport: HTMLElement): number {
    return Math.max(24, Math.min(96, Math.max(viewport.clientWidth, viewport.clientHeight) * 0.12));
  }

  function clampCamera(viewport: HTMLElement, world: HTMLElement, camera: Camera, minimumScale = CAMERA_MIN): void {
    const width = Number(world.dataset.worldWidth ?? viewport.dataset.worldWidth ?? 1600);
    const height = Number(world.dataset.worldHeight ?? viewport.dataset.worldHeight ?? 900);
    const padding = cameraPadding(viewport);
    camera.scale = clamp(camera.scale, minimumScale, CAMERA_MAX);
    camera.x = clampAxis(camera.x, viewport.clientWidth, width * camera.scale, padding);
    camera.y = clampAxis(camera.y, viewport.clientHeight, height * camera.scale, padding);
  }

  function clampAxis(offset: number, viewportSize: number, scaledWorldSize: number, padding: number): number {
    if (scaledWorldSize <= viewportSize - padding * 2) return (viewportSize - scaledWorldSize) / 2;
    return clamp(offset, viewportSize - padding - scaledWorldSize, padding);
  }

  function activateSection(act: string): void {
    const panel = panels.find((candidate) => candidate.dataset.storySectionPanel === act) ?? panels[0]!;
    activePanel = panel;
    for (const candidate of panels) {
      const active = candidate === panel;
      candidate.hidden = !active;
      candidate.classList.toggle("is-active", active);
      if (active) activateLazyImages(candidate);
    }
    for (const tab of tabs) {
      const active = tab.dataset.storySection === act;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", String(active));
    }
    if (!cameras.has(panel)) fitPanel(panel); else renderCamera(panel);
  }

  function activateLazyImages(panel: HTMLElement): void {
    for (const image of panel.querySelectorAll<HTMLImageElement>("img[data-src]")) {
      const source = image.dataset.src;
      if (!source) continue;
      image.src = source;
      delete image.dataset.src;
    }
  }

  const interactiveSelector = "button, a, input, select, textarea, [data-story-map-entry], [data-story-avatar], [data-story-scene], [data-story-path]";
  const isInteractiveTarget = (target: EventTarget | null): boolean => target instanceof Element && Boolean(target.closest(interactiveSelector));

  for (const panel of panels) {
    const viewport = panelViewport(panel);
    if (!viewport) continue;
    const capturePointer = (pointerId: number): void => {
      try {
        viewport.setPointerCapture(pointerId);
      } catch {
        // Some synthetic events and embedded webviews expose the pointer
        // before it becomes capturable; the gesture can continue without it.
      }
    };
    const releasePointer = (pointerId: number): void => {
      try {
        if (viewport.hasPointerCapture(pointerId)) viewport.releasePointerCapture(pointerId);
      } catch {
        // The platform may already have released the pointer.
      }
    };
    viewport.addEventListener("wheel", (event) => {
      if (!event.ctrlKey && !event.metaKey && Math.abs(event.deltaY) < 2) return;
      event.preventDefault();
      zoomAround(panel, cameraFor(panel).scale * Math.pow(0.998, event.deltaY), event.clientX, event.clientY);
    }, { passive: false });
    viewport.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 && event.pointerType === "mouse") return;
      const gesture = gestureFor(viewport);
      const interactive = isInteractiveTarget(event.target);
      if (interactive) {
        // Interactive children keep their native click/tap lifecycle. A
        // second finger placed on a button must not turn the first touch
        // into a map gesture either.
        return;
      }
      gesture.pointers.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
        startX: event.clientX,
        startY: event.clientY,
        interactive,
      });
      if (gesture.pointers.size === 1) {
        gesture.dragging = true;
        gesture.moved = false;
        capturePointer(event.pointerId);
        viewport.dataset.storyPanning = "true";
      }
      if (gesture.pointers.size === 2) {
        const [first, second] = [...gesture.pointers.values()];
        if (first && second) {
          const midpoint = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
          const rect = viewport.getBoundingClientRect();
          const camera = cameraFor(panel);
          gesture.pinchStart = {
            distance: Math.hypot(first.x - second.x, first.y - second.y),
            scale: camera.scale,
            worldX: (midpoint.x - rect.left - camera.x) / camera.scale,
            worldY: (midpoint.y - rect.top - camera.y) / camera.scale,
          };
          for (const pointerId of gesture.pointers.keys()) capturePointer(pointerId);
          gesture.dragging = true;
          gesture.moved = false;
          viewport.dataset.storyPanning = "true";
        }
      }
    });
    viewport.addEventListener("pointermove", (event) => {
      const gesture = gestureFor(viewport);
      const pointer = gesture.pointers.get(event.pointerId);
      if (!pointer) return;
      const previous = { x: pointer.x, y: pointer.y };
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      const camera = cameraFor(panel);
      if (gesture.pointers.size >= 2 && gesture.pinchStart) {
        const values = [...gesture.pointers.values()];
        const first = values[0];
        const second = values[1];
        if (!first || !second) return;
        const midpoint = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
        const rect = viewport.getBoundingClientRect();
        const distance = Math.max(1, Math.hypot(first.x - second.x, first.y - second.y));
        camera.scale = clamp(gesture.pinchStart.scale * distance / Math.max(1, gesture.pinchStart.distance), CAMERA_MIN, CAMERA_MAX);
        camera.x = midpoint.x - rect.left - gesture.pinchStart.worldX * camera.scale;
        camera.y = midpoint.y - rect.top - gesture.pinchStart.worldY * camera.scale;
        gesture.moved = true;
        renderCamera(panel);
        event.preventDefault();
        return;
      }
      if (gesture.pointers.size !== 1 || !gesture.dragging || viewport.dataset.storyPanning !== "true") return;
      if (Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) < DRAG_THRESHOLD) return;
      const dx = event.clientX - previous.x;
      const dy = event.clientY - previous.y;
      gesture.moved = true;
      camera.x += dx;
      camera.y += dy;
      renderCamera(panel);
      event.preventDefault();
    }, { passive: false });
    const stopPointer = (event: PointerEvent) => {
      const gesture = gestureFor(viewport);
      const wasPinching = Boolean(gesture.pinchStart);
      gesture.pointers.delete(event.pointerId);
      if (gesture.moved) suppressClickUntil = Date.now() + 180;
      if (gesture.pointers.size < 2) delete gesture.pinchStart;
      if (wasPinching && gesture.pointers.size === 1) gesture.dragging = false;
      if (gesture.pointers.size === 0) {
        delete viewport.dataset.storyPanning;
        gesture.dragging = false;
        gesture.moved = false;
      }
      releasePointer(event.pointerId);
    };
    viewport.addEventListener("pointerup", stopPointer);
    viewport.addEventListener("pointercancel", stopPointer);
    viewport.addEventListener("pointerleave", (event) => {
      if (event.pointerType === "mouse" && gestureFor(viewport).pointers.has(event.pointerId) && !viewport.hasPointerCapture(event.pointerId)) stopPointer(event);
    });
  }

  function selectedFromUrl(): URLSearchParams {
    return new URL(window.location.href).searchParams;
  }

  function updateUrl(values: Record<string, string | undefined>): void {
    const url = new URL(window.location.href);
    for (const [key, value] of Object.entries(values)) {
      if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
    }
    window.history.replaceState({}, "", url);
  }

  function focusPath(pathId: number, sectionAct: string, update = true): void {
    activateSection(sectionAct);
    const button = root.querySelector<HTMLButtonElement>(`[data-story-path="${CSS.escape(String(pathId))}"][data-story-path-section="${CSS.escape(sectionAct)}"]`);
    if (!button) return;
    for (const path of root.querySelectorAll<HTMLElement>("[data-story-map-path]")) path.classList.toggle("is-focused", path.dataset.storyMapPath === String(pathId));
    for (const line of root.querySelectorAll<SVGLineElement>("[data-story-link-path-ids]")) {
      line.classList.toggle("is-related", line.dataset.storyLinkPathIds?.split(",").includes(String(pathId)) === true);
    }
    focusElement(activePanel, button, 0.86);
    if (update) updateUrl({ "story-view": "game", "story-path": String(pathId), "story-entry": undefined, "story-scene": undefined });
  }

  function focusElement(panel: HTMLElement, element: HTMLElement, scale?: number): void {
    const x = Number(element.dataset.storyX);
    const y = Number(element.dataset.storyY);
    if (Number.isFinite(x) && Number.isFinite(y)) focusPoint(panel, x, y, scale);
  }

  function setSelection(pathId: number, key: string): void {
    for (const entry of root.querySelectorAll<HTMLElement>("[data-story-map-entry]")) entry.classList.toggle("is-selected", entry.dataset.storyPathId === String(pathId) && entry.dataset.storyEntryKey === key);
    for (const path of root.querySelectorAll<HTMLElement>("[data-story-map-path]")) path.classList.toggle("is-focused", path.dataset.storyMapPath === String(pathId));
    for (const line of root.querySelectorAll<SVGLineElement>("[data-story-link-from], [data-story-link-to]")) {
      const related = line.dataset.storyLinkFrom === key || line.dataset.storyLinkTo === key || line.dataset.storyLinkPathIds?.split(",").includes(String(pathId)) === true;
      line.classList.toggle("is-related", related);
    }
  }

  function ensureAtlas(): Promise<ArcaeaStoryAtlasType> {
    atlasPromise ??= fetch(root.dataset.storyAtlasUrl ?? "", { credentials: "omit" }).then(async (response) => {
      if (!response.ok) throw new Error(`Story Atlas data failed with ${response.status}`);
      return await response.json() as ArcaeaStoryAtlasType;
    });
    return atlasPromise;
  }

  function element(tag: keyof HTMLElementTagNameMap, className?: string): HTMLElement {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function textNode(tag: keyof HTMLElementTagNameMap, value: string, className?: string): HTMLElement {
    const node = element(tag, className);
    node.textContent = value;
    return node;
  }

  function renderMetadata(entry: CompactEntry, textEntry: ArcaeaStoryAtlasType["text"]["entries"][number] | undefined, scenes: ArcaeaStoryAtlasType["scenes"]): HTMLElement {
    const metadata = element("div", "story-detail-pills");
    const pills = [
      textEntry?.storyType === "vn" ? "VN Scene" : entry.visualLabel,
      entry.characterLabels.length > 0 ? "Partner · " + entry.characterLabels.join(" · ") : "",
      ...entry.relatedSongs,
      entry.unlockLabel ?? "",
      entry.staffRoll ? "Staff roll" : "",
      scenes.length > 0 ? scenes.map((scene) => sceneKindLabel(scene.kind)).join(" · ") : "",
    ].filter(Boolean);
    for (const pill of pills) metadata.append(textNode("span", pill));
    return metadata;
  }

  function renderMoreInfo(entry: CompactEntry, textEntry: StoryTextEntry | undefined, scenes: ArcaeaStoryAtlasType["scenes"]): HTMLElement {
    const details = element("details", "story-detail-more");
    details.append(textNode("summary", "更多信息"));
    const metadata = element("dl", "story-detail-meta");
    const items: Array<[string, string]> = [
      ["Path", entry.pathTitle],
      ["Act / Part", entry.sectionLabel],
      ["Story type", textEntry?.storyType === "vn" ? "VN" : entry.visualLabel],
      ["Visual", entry.visualLabel],
    ];
    if (textEntry?.storyData) items.push(["Story data", textEntry.storyData]);
    if (scenes.length > 0) items.push(["Scene", scenes.map((scene) => scene.sceneId).join(" · ")]);
    for (const [label, value] of items) {
      const row = element("div");
      row.append(textNode("dt", label), textNode("dd", value));
      metadata.append(row);
    }
    details.append(metadata);
    return details;
  }

  function normalizeAssetPath(assetPath: string | undefined): string {
    let normalized = (assetPath ?? "").split(String.fromCharCode(92)).join("/");
    while (normalized.startsWith("/")) normalized = normalized.slice(1);
    return normalized;
  }

  function resourceForAsset(assetPath: string | undefined, resourceIds: string[]): CompactResource | undefined {
    const normalized = normalizeAssetPath(assetPath);
    if (!normalized || resourceIds.length === 0) return undefined;
    const allowed = new Set(resourceIds);
    return Object.values(payload.resources).find((resource) => allowed.has(resource.resourceId) && resource.assetPaths.some((path) => normalizeAssetPath(path) === normalized));
  }

  function pagesForText(locale: StoryTextEntry["texts"][string]): StoryPage[] {
    const grouped = new Map<number, StoryTextBlock[]>();
    for (const block of locale.blocks) {
      const blocks = grouped.get(block.page) ?? [];
      blocks.push(block);
      grouped.set(block.page, blocks);
    }
    return [...grouped.entries()].sort(([left], [right]) => left - right).map(([page, blocks]) => ({ page, blocks }));
  }

  function localeLabel(locale: string): string {
    return locale === "zh-Hans" ? "简中" : locale === "zh-Hant" ? "繁中" : locale === "ja" ? "日本語" : locale === "ko" ? "한국어" : "English";
  }

  function visualBeforePage(pages: StoryPage[], pageIndex: number, resourceIds: string[]): CompactResource | undefined {
    for (let index = pageIndex; index >= 0; index -= 1) {
      const page = pages[index];
      if (!page) continue;
      for (const block of [...page.blocks].reverse()) {
        const visual = block.kind === "display-event" ? resourceForAsset(block.assetPath, resourceIds) : undefined;
        if (visual) return visual;
      }
    }
    return undefined;
  }

  function renderStoryPreview(textEntry: StoryTextEntry | undefined, resourceIds: string[], targetKey: string): HTMLElement | undefined {
    if (!textEntry) return undefined;
    const locales = Object.keys(textEntry.texts);
    if (locales.length === 0) return undefined;
    const preferred = selectedLocale[targetKey];
    const localeCandidate = preferred && textEntry.texts[preferred]
      ? preferred
      : ["zh-Hans", "zh-Hant", "en", "ja", "ko"].find((candidate) => textEntry.texts[candidate]) ?? locales[0];
    if (!localeCandidate) return undefined;
    const locale = localeCandidate;
    const localized = textEntry.texts[locale];
    if (!localized) return undefined;
    const pages = pagesForText(localized);
    if (pages.length === 0) return undefined;

    const state = readerState?.targetKey === targetKey ? readerState : { targetKey, page: 0 };
    const pageIndex = clamp(state.page, 0, pages.length - 1);
    state.page = pageIndex;
    state.locale = locale;
    readerState = state;
    const page = pages[pageIndex]!;
    const pageEvent = [...page.blocks].reverse().find((block) => block.kind === "display-event");
    const manualVisual = state.visualManual && state.activeVisualId
      ? resourceIds.map((id) => payload.resources[id]).find((resource) => resource?.resourceId === state.activeVisualId)
      : undefined;
    const activeVisual = manualVisual ?? resourceForAsset(pageEvent?.assetPath, resourceIds) ?? visualBeforePage(pages, pageIndex, resourceIds) ?? resourceIds.map((id) => payload.resources[id]).find(Boolean);
    if (activeVisual?.resourceId) state.activeVisualId = activeVisual.resourceId;
    else delete state.activeVisualId;

    const section = element("section", "story-preview");
    const heading = element("div", "story-preview-heading");
    heading.append(textNode("div", "剧情预览", "story-detail-section-label"));
    const localeSwitch = element("div", "story-locale-switch");
    localeSwitch.setAttribute("role", "group");
    localeSwitch.setAttribute("aria-label", "剧情语言");
    for (const availableLocale of locales) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.storyLocale = availableLocale;
      button.classList.toggle("is-active", availableLocale === locale);
      button.textContent = localeLabel(availableLocale);
      localeSwitch.append(button);
    }
    heading.append(localeSwitch);
    section.append(heading);

    const stage = element("div", "story-preview-stage");
    if (activeVisual?.preview) {
      const visualIndex = resourceIds.indexOf(activeVisual.resourceId);
      const visualButton = document.createElement("button");
      visualButton.type = "button";
      visualButton.className = "story-preview-visual";
      visualButton.dataset.storyCgIndex = String(Math.max(0, visualIndex));
      visualButton.setAttribute("aria-label", "打开当前剧情视觉资源");
      const image = document.createElement("img");
      image.src = activeVisual.preview;
      image.alt = activeVisual.title;
      image.loading = "lazy";
      image.decoding = "async";
      visualButton.append(image);
      stage.append(visualButton, textNode("div", "当前视觉 · " + activeVisual.title, "story-preview-stage-caption"));
    } else {
      stage.append(textNode("div", "本页暂无公开视觉预览", "story-preview-stage-empty"));
    }
    section.append(stage);

    const pageBody = element("div", "story-preview-page");
    pageBody.append(textNode("div", "第 " + (pageIndex + 1) + " / " + pages.length + " 页", "story-preview-page-label"));
    for (const block of page.blocks) {
      if (block.kind === "paragraph" && block.text) {
        pageBody.append(textNode("p", block.text));
        continue;
      }
      if (block.kind !== "display-event") continue;
      const visual = resourceForAsset(block.assetPath, resourceIds);
      if (visual) {
        const event = document.createElement("button");
        event.type = "button";
        event.className = "story-preview-event";
        event.dataset.storyCgIndex = String(Math.max(0, resourceIds.indexOf(visual.resourceId)));
        event.textContent = "视觉演出 · " + visual.title;
        pageBody.append(event);
      } else {
        const filename = normalizeAssetPath(block.assetPath).split("/").at(-1) ?? "视觉演出";
        pageBody.append(textNode("div", "视觉演出 · " + filename, "story-preview-event is-unavailable"));
      }
    }
    if (pageBody.childElementCount === 1) pageBody.append(textNode("p", "这一页没有可显示的剧情正文。", "story-preview-page-empty"));
    section.append(pageBody);

    const footer = element("div", "story-preview-footer");
    const previous = document.createElement("button");
    previous.type = "button";
    previous.dataset.storyPreviewPrevious = "true";
    previous.textContent = "‹ 上一页";
    previous.disabled = pageIndex <= 0;
    const next = document.createElement("button");
    next.type = "button";
    next.dataset.storyPreviewNext = "true";
    next.textContent = "下一页 ›";
    next.disabled = pageIndex >= pages.length - 1;
    footer.append(previous, textNode("span", "Page " + (pageIndex + 1) + " / " + pages.length, "story-preview-counter"), next);
    section.append(footer);
    return section;
  }

  function renderVisuals(resourceIds: string[], compact = false): HTMLElement | undefined {
    const items = resourceIds.map((id) => payload.resources[id]).filter((resource): resource is CompactResource => Boolean(resource));
    if (items.length === 0) return undefined;
    const activeReaderVisual = readerState?.activeVisualId ? items.findIndex((item) => item.resourceId === readerState?.activeVisualId) : -1;
    if (activeReaderVisual >= 0) selectedCgIndex = activeReaderVisual;
    selectedCgIndex = clamp(selectedCgIndex, 0, items.length - 1);
    const section = element("section", compact ? "story-detail-visuals is-compact" : "story-detail-visuals");
    section.append(textNode("div", "CG / 视觉资源", "story-detail-section-label"));
    const active = items[selectedCgIndex];
    if (active && !compact) {
      const figure = element("figure", "story-detail-cg-feature");
      if (active.preview) {
        const image = document.createElement("img");
        image.src = active.preview;
        image.alt = active.title;
        image.loading = "lazy";
        image.decoding = "async";
        figure.append(image);
      }
      figure.append(textNode("figcaption", `${active.title} · ${selectedCgIndex + 1}/${items.length}`));
      section.append(figure);
    }
    if (items.length > 1) {
      const controls = element("div", "story-detail-cg-controls");
      const previous = document.createElement("button");
      previous.type = "button";
      previous.textContent = "上一张";
      previous.dataset.storyCgPrevious = "true";
      previous.disabled = selectedCgIndex <= 0;
      const next = document.createElement("button");
      next.type = "button";
      next.textContent = "下一张";
      next.dataset.storyCgNext = "true";
      next.disabled = selectedCgIndex >= items.length - 1;
      controls.append(previous, next);
      section.append(controls);
    }
    const strip = element("div", "story-detail-cg-strip");
    items.forEach((item, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.storyCgIndex = String(index);
      button.classList.toggle("is-active", index === selectedCgIndex);
      if (item.thumb) {
        const image = document.createElement("img");
        image.src = item.thumb;
        image.alt = `${item.title} 缩略图`;
        image.loading = "lazy";
        button.append(image);
      }
      button.append(textNode("span", String(index + 1)));
      strip.append(button);
    });
    section.append(strip);
    const actions = element("div", "story-detail-resource-actions");
    if (active?.route) {
      const resourceLink = textNode("a", "打开资源详情");
      resourceLink.setAttribute("href", active.route);
      actions.append(resourceLink);
    }
    if (active?.original) {
      const original = textNode("a", "查看高清");
      original.setAttribute("href", active.original);
      original.setAttribute("target", "_blank");
      original.setAttribute("rel", "noreferrer");
      actions.append(original);
    }
    if (active?.download) {
      const download = textNode("a", "下载原图");
      download.setAttribute("href", active.download);
      download.setAttribute("download", active.downloadFilename ?? "");
      actions.append(download);
    }
    if (actions.childElementCount > 0) section.append(actions);
    return section;
  }

  function renderSceneInfo(scenes: ArcaeaStoryAtlasType["scenes"]): HTMLElement | undefined {
    if (scenes.length === 0) return undefined;
    const section = element("section", "story-detail-scene");
    section.append(textNode("div", "场景", "story-detail-section-label"));
    for (const scene of scenes) {
      const title = textNode("p", (scene.displayTitle ?? scene.sceneId) + " · " + sceneKindLabel(scene.kind));
      section.append(title);
      const locales = Object.values(scene.locales);
      if (scene.scriptStem || locales.length > 0) {
        const more = element("details", "story-detail-more story-detail-scene-more");
        more.append(textNode("summary", "更多信息"));
        if (scene.scriptStem) more.append(textNode("p", "场景标识：" + scene.scriptStem, "story-detail-scene-note"));
        if (locales.length > 0) more.append(textNode("p", locales.length + " 个语言版本 · " + (locales[0]?.sayCount ?? 0) + " 段对白", "story-detail-scene-note"));
        section.append(more);
      }
    }
    return section;
  }

  function sceneKindLabel(kind: string): string {
    return kind === "epilogue" ? "Epilogue" : kind === "vn-scene" ? "VN Scene" : kind === "node-bound" ? "Node Scene" : "Path Scene";
  }

  async function renderEntryDetail(entry: CompactEntry): Promise<void> {
    const atlas = await ensureAtlas();
    if (openEntryId !== entry.id) return;
    const textEntry = atlas.text.entries.find((candidate) => candidate.nodeKey === entry.key);
    const scenes = atlas.scenes.filter((scene) => entry.sceneIds.includes(scene.sceneId));
    detailContentElement.replaceChildren();
    detailContentElement.append(textNode("div", `${entry.pathTitle} · ${entry.visualLabel}`, "story-detail-eyebrow"), textNode("h3", entry.key), textNode("p", `${entry.sectionLabel} · ${entry.pathTitle}`, "story-detail-path"), renderMetadata(entry, textEntry, scenes));
    const preview = renderStoryPreview(textEntry, entry.resourceIds, entry.id);
    if (preview) detailContentElement.append(preview);
    const visuals = renderVisuals(entry.resourceIds, Boolean(preview));
    if (visuals) detailContentElement.append(visuals);
    const sceneInfo = renderSceneInfo(scenes);
    if (sceneInfo) detailContentElement.append(sceneInfo);
    detailContentElement.append(renderMoreInfo(entry, textEntry, scenes));
  }

  async function renderSceneDetail(scene: CompactScene): Promise<void> {
    const atlas = await ensureAtlas();
    const definition = atlas.scenes.find((candidate) => candidate.sceneId === scene.sceneId);
    if (openSceneId !== scene.sceneId) return;
    const textEntry = definition
      ? atlas.text.entries.find((entry) => (definition.nodeKey && entry.nodeKey === definition.nodeKey) || (definition.storyData && entry.storyData === definition.storyData))
      : undefined;
    detailContentElement.replaceChildren();
    detailContentElement.append(textNode("div", `${scene.pathTitle} · ${sceneKindLabel(scene.kind)}`, "story-detail-eyebrow"), textNode("h3", scene.displayTitle), textNode("p", `${scene.sectionLabel} · ${scene.pathTitle}`, "story-detail-path"));
    const metadata = element("div", "story-detail-pills");
    metadata.append(textNode("span", "Scene · " + sceneKindLabel(scene.kind)));
    if (textEntry?.storyType === "vn") metadata.append(textNode("span", "VN"));
    detailContentElement.append(metadata);
    const preview = renderStoryPreview(textEntry, scene.resourceIds, scene.sceneId);
    if (preview) detailContentElement.append(preview);
    const visuals = renderVisuals(scene.resourceIds, Boolean(preview));
    if (visuals) detailContentElement.append(visuals);
    if (definition) {
      const sceneInfo = renderSceneInfo([definition]);
      if (sceneInfo) detailContentElement.append(sceneInfo);
    }
  }

  let openEntryId: string | undefined;
  let openSceneId: string | undefined;

  function resourceIdsForOpenDetail(): string[] {
    if (openEntryId) return payload.entries.find((entry) => entry.id === openEntryId)?.resourceIds ?? [];
    if (openSceneId) return payload.scenes.find((scene) => scene.sceneId === openSceneId)?.resourceIds ?? [];
    return [];
  }

  function rerenderOpenDetail(): void {
    if (openEntryId) {
      const entry = payload.entries.find((candidate) => candidate.id === openEntryId);
      if (entry) void renderEntryDetail(entry);
    } else if (openSceneId) {
      const scene = payload.scenes.find((candidate) => candidate.sceneId === openSceneId);
      if (scene) void renderSceneDetail(scene);
    }
  }

  function setSelectedVisual(index: number): void {
    const resourceIds = resourceIdsForOpenDetail();
    const items = resourceIds.map((id) => payload.resources[id]).filter((resource): resource is CompactResource => Boolean(resource));
    if (items.length === 0) return;
    selectedCgIndex = clamp(index, 0, items.length - 1);
    if (readerState) {
      const selectedVisual = items[selectedCgIndex];
      if (selectedVisual) readerState.activeVisualId = selectedVisual.resourceId;
      else delete readerState.activeVisualId;
      readerState.visualManual = true;
    }
    rerenderOpenDetail();
  }

  function changeReaderPage(delta: number): void {
    if (!readerState) return;
    readerState.page += delta;
    readerState.visualManual = false;
    rerenderOpenDetail();
  }

  async function openEntry(entry: CompactEntry): Promise<void> {
    lastFocusedElement = document.activeElement instanceof HTMLElement && !detailElement.contains(document.activeElement) ? document.activeElement : null;
    openEntryId = entry.id;
    openSceneId = undefined;
    selectedCgIndex = 0;
    readerState = { targetKey: entry.id, page: 0 };
    detailElement.hidden = false;
    root.classList.add("has-story-detail");
    await renderEntryDetail(entry);
    if (openEntryId === entry.id) root.querySelector<HTMLButtonElement>("[data-story-detail-close]")?.focus();
  }

  async function openScene(scene: CompactScene): Promise<void> {
    lastFocusedElement = document.activeElement instanceof HTMLElement && !detailElement.contains(document.activeElement) ? document.activeElement : null;
    openEntryId = undefined;
    openSceneId = scene.sceneId;
    selectedCgIndex = 0;
    readerState = { targetKey: scene.sceneId, page: 0 };
    detailElement.hidden = false;
    root.classList.add("has-story-detail");
    await renderSceneDetail(scene);
    if (openSceneId === scene.sceneId) root.querySelector<HTMLButtonElement>("[data-story-detail-close]")?.focus();
  }

  function closeDetail(): void {
    detailElement.hidden = true;
    root.classList.remove("has-story-detail");
    openEntryId = undefined;
    openSceneId = undefined;
    readerState = undefined;
    updateUrl({ "story-entry": undefined, "story-scene": undefined });
    const focusTarget = lastFocusedElement;
    lastFocusedElement = null;
    if (focusTarget && focusTarget.isConnected && !detailElement.contains(focusTarget)) focusTarget.focus();
  }

  function setMode(mode: "atlas" | "gallery", update = true): void {
    const atlasVisible = mode === "atlas";
    root.hidden = !atlasVisible;
    if (gallery) {
      gallery.hidden = atlasVisible;
      if (!atlasVisible) {
        gallery.dataset.galleryDefer = "false";
        gallery.dispatchEvent(new CustomEvent("gallery:activate"));
      }
    }
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-story-view-toggle]")) {
      const active = button.dataset.storyViewToggle === mode;
      button.classList.toggle("button-primary", active);
      button.classList.toggle("button-secondary", !active);
      button.setAttribute("aria-pressed", String(active));
    }
    if (update) updateUrl({ "story-view": atlasVisible ? "game" : "gallery" });
  }

  function selectEntry(pathId: number, key: string, sectionAct: string, open = true, update = true): void {
    activateSection(sectionAct);
    setSelection(pathId, key);
    const button = [...root.querySelectorAll<HTMLButtonElement>("[data-story-map-entry]")].find((candidate) => candidate.dataset.storyPathId === String(pathId) && candidate.dataset.storyEntryKey === key);
    if (button) focusElement(activePanel, button, 0.98);
    const entry = payload.entries.find((candidate) => candidate.pathId === pathId && candidate.key === key);
    if (!entry) return;
    if (update) updateUrl({ "story-view": "game", "story-path": String(pathId), "story-entry": key, "story-scene": undefined });
    if (open) void openEntry(entry);
  }

  function selectScene(sceneId: string, sectionAct: string, update = true): void {
    const scene = payload.scenes.find((candidate) => candidate.sceneId === sceneId);
    if (!scene) return;
    activateSection(sectionAct);
    const button = root.querySelector<HTMLButtonElement>(`[data-story-scene="${CSS.escape(sceneId)}"]`);
    if (button) focusElement(activePanel, button, 0.98);
    if (update) updateUrl({ "story-view": "game", "story-path": scene.pathId === undefined ? undefined : String(scene.pathId), "story-entry": undefined, "story-scene": sceneId });
    void openScene(scene);
  }

  function handleCamera(panel: HTMLElement, action: string): void {
    if (action === "zoom-in") zoomAround(panel, cameraFor(panel).scale * 1.16);
    else if (action === "zoom-out") zoomAround(panel, cameraFor(panel).scale / 1.16);
    else if (action === "fit") fitPanel(panel);
    else if (action === "reset") resetPanel(panel);
  }

  root.addEventListener("click", (event) => {
    if (Date.now() < suppressClickUntil) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const target = event.target;
    if (!(target instanceof Element)) return;
    const close = target.closest<HTMLElement>("[data-story-detail-close]");
    if (close) {
      event.preventDefault();
      closeDetail();
      return;
    }
    const view = target.closest<HTMLButtonElement>("[data-story-view-toggle]");
    if (view?.dataset.storyViewToggle === "atlas" || view?.dataset.storyViewToggle === "gallery") {
      event.preventDefault();
      setMode(view.dataset.storyViewToggle);
      return;
    }
    const cameraButton = target.closest<HTMLButtonElement>("[data-story-camera]");
    if (cameraButton) {
      event.preventDefault();
      const panel = cameraButton.closest<HTMLElement>("[data-story-section-panel]");
      if (panel) handleCamera(panel, cameraButton.dataset.storyCamera ?? "");
      return;
    }
    const tab = target.closest<HTMLButtonElement>("[data-story-part-tabs] [data-story-section]");
    if (tab?.dataset.storySection) {
      event.preventDefault();
      activateSection(tab.dataset.storySection);
      updateUrl({ "story-view": "game", "story-path": undefined, "story-entry": undefined, "story-scene": undefined });
      return;
    }
    const node = target.closest<HTMLButtonElement>("[data-story-map-entry]");
    if (node?.dataset.storyPathId && node.dataset.storyEntryKey) {
      event.preventDefault();
      const panel = node.closest<HTMLElement>("[data-story-section-panel]");
      selectEntry(Number(node.dataset.storyPathId), node.dataset.storyEntryKey, panel?.dataset.storySectionPanel ?? "0");
      return;
    }
    const avatar = target.closest<HTMLButtonElement>("[data-story-avatar]");
    if (avatar?.dataset.storyClusterPath && avatar.dataset.storySection) {
      event.preventDefault();
      for (const candidate of root.querySelectorAll<HTMLElement>("[data-story-avatar]")) candidate.classList.remove("is-cluster-focused");
      avatar.classList.add("is-cluster-focused");
      const panel = avatar.closest<HTMLElement>("[data-story-section-panel]");
      if (panel) focusElement(panel, avatar, 0.78);
      focusPath(Number(avatar.dataset.storyClusterPath), avatar.dataset.storySection);
      return;
    }
    const scene = target.closest<HTMLButtonElement>("[data-story-scene]");
    if (scene?.dataset.storyScene && scene.dataset.storySection) {
      event.preventDefault();
      selectScene(scene.dataset.storyScene, scene.dataset.storySection);
      return;
    }
    const pathButton = target.closest<HTMLButtonElement>("[data-story-path]");
    if (pathButton?.dataset.storyPath && pathButton.dataset.storyPathSection) {
      event.preventDefault();
      focusPath(Number(pathButton.dataset.storyPath), pathButton.dataset.storyPathSection);
      return;
    }
    const result = target.closest<HTMLButtonElement>("[data-story-search-result]");
    if (result?.dataset.storySearchResult) {
      event.preventDefault();
      const entry = payload.entries.find((candidate) => candidate.id === result.dataset.storySearchResult);
      const sceneResult = payload.scenes.find((candidate) => candidate.sceneId === result.dataset.storySearchResult);
      if (entry) selectEntry(entry.pathId, entry.key, String(entry.sectionAct), true);
      else if (sceneResult) selectScene(sceneResult.sceneId, String(sceneResult.sectionAct));
      if (searchResults) searchResults.hidden = true;
      return;
    }
    const locale = target.closest<HTMLElement>("[data-story-locale]");
    if (locale?.dataset.storyLocale) {
      const key = readerState?.targetKey ?? openEntryId ?? openSceneId ?? "";
      if (key) selectedLocale[key] = locale.dataset.storyLocale;
      rerenderOpenDetail();
      return;
    }
    const cgIndex = target.closest<HTMLElement>("[data-story-cg-index]");
    if (cgIndex?.dataset.storyCgIndex) {
      setSelectedVisual(Number(cgIndex.dataset.storyCgIndex));
      return;
    }
    if (target.closest("[data-story-preview-previous]")) {
      event.preventDefault();
      changeReaderPage(-1);
      return;
    }
    if (target.closest("[data-story-preview-next]")) {
      event.preventDefault();
      changeReaderPage(1);
      return;
    }
    if (target.closest("[data-story-cg-previous]")) {
      event.preventDefault();
      setSelectedVisual(selectedCgIndex - 1);
      return;
    }
    if (target.closest("[data-story-cg-next]")) {
      event.preventDefault();
      setSelectedVisual(selectedCgIndex + 1);
      return;
    }
  });

  async function runSearch(value: string): Promise<void> {
    const query = value.normalize("NFKC").toLocaleLowerCase("en").trim();
    if (!searchResults || !searchStatus) return;
    if (!query) {
      searchResults.hidden = true;
      searchStatus.textContent = "";
      return;
    }
    searchStatus.textContent = "搜索中…";
    const atlas = await ensureAtlas();
    const indexByNode = new Map(atlas.searchIndex.map((entry) => [entry.nodeKey, entry.terms.join(" ")]));
    const textByNode = new Map(atlas.text.entries.map((entry) => [entry.nodeKey, Object.values(entry.texts).flatMap((locale) => locale.blocks.map((block) => block.text ?? block.assetPath ?? "")).join(" ")]));
    const matches = payload.entries.filter((entry) => {
      const resources = entry.resourceIds.map((id) => payload.resources[id]).filter(Boolean).flatMap((resource) => [resource!.title, resource!.subtitle ?? "", resource!.resourceId]);
      const haystack = [entry.id, entry.key, entry.pathTitle, entry.sectionLabel, entry.visualLabel, ...entry.relatedSongs, entry.unlockLabel ?? "", indexByNode.get(entry.key) ?? "", textByNode.get(entry.key) ?? "", ...resources].join(" ").normalize("NFKC").toLocaleLowerCase("en");
      return haystack.includes(query);
    }).slice(0, 12);
    const sceneMatches = payload.scenes.filter((scene) => [scene.sceneId, scene.displayTitle, scene.pathTitle, scene.scriptStem ?? ""].join(" ").normalize("NFKC").toLocaleLowerCase("en").includes(query)).slice(0, 4);
    searchResults.replaceChildren();
    for (const entry of matches) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.storySearchResult = entry.id;
      button.append(textNode("strong", entry.key), textNode("span", `${entry.pathTitle} · ${entry.sectionLabel}`));
      searchResults.append(button);
    }
    for (const scene of sceneMatches) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.storySearchResult = scene.sceneId;
      button.append(textNode("strong", scene.displayTitle), textNode("span", `${scene.pathTitle} · ${scene.kind}`));
      searchResults.append(button);
    }
    searchResults.hidden = matches.length + sceneMatches.length === 0;
    searchStatus.textContent = `${matches.length + sceneMatches.length} 个匹配`;
    if (matches.length + sceneMatches.length === 0) searchResults.append(textNode("p", "没有匹配的 Story Entry 或 Scene。"));
  }

  let searchTimer: number | undefined;
  search?.addEventListener("input", () => {
    if (searchTimer !== undefined) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => void runSearch(search.value), 180);
  });

  function initializeFromUrl(): void {
    const params = selectedFromUrl();
    setMode(params.get("story-view") === "gallery" ? "gallery" : "atlas", false);
    if (params.get("story-view") === "gallery") return;
    const requestedPath = params.get("story-path");
    const requestedEntry = params.get("story-entry");
    const requestedScene = params.get("story-scene");
    if (requestedScene) {
      const scene = payload.scenes.find((candidate) => candidate.sceneId === requestedScene);
      if (scene) {
        selectScene(scene.sceneId, String(scene.sectionAct), false);
        return;
      }
    }
    if (requestedEntry && requestedPath) {
      const entry = payload.entries.find((candidate) => candidate.pathId === Number(requestedPath) && candidate.key === requestedEntry);
      if (entry) {
        selectEntry(entry.pathId, entry.key, String(entry.sectionAct), true, false);
        return;
      }
    }
    if (requestedPath) {
      const pathId = Number(requestedPath);
      const pathButton = root.querySelector<HTMLButtonElement>(`[data-story-path="${CSS.escape(String(pathId))}"]`);
      const panel = pathButton?.closest<HTMLElement>("[data-story-section-panel]");
      if (pathButton && panel?.dataset.storySectionPanel) {
        focusPath(pathId, panel.dataset.storySectionPanel, false);
        return;
      }
    }
    const firstAct = panels[0]?.dataset.storySectionPanel ?? "0";
    activateSection(firstAct);
  }

  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !detailElement.hidden) {
      event.preventDefault();
      closeDetail();
      return;
    }
    if (!detailElement.hidden && (event.key === "ArrowLeft" || event.key === "ArrowRight") && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) {
      event.preventDefault();
      changeReaderPage(event.key === "ArrowLeft" ? -1 : 1);
      return;
    }
    if ((event.key === "+" || event.key === "=" || event.key === "-" || event.key === "_") && event.target instanceof HTMLElement && event.target.closest("[data-story-map-viewport]")) {
      event.preventDefault();
      handleCamera(activePanel, event.key === "-" || event.key === "_" ? "zoom-out" : "zoom-in");
    }
  });
  window.addEventListener("popstate", initializeFromUrl);
  window.addEventListener("resize", () => renderCamera(activePanel));

  initializeFromUrl();
}

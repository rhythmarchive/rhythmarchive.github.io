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
  subworldId?: string;
  endingLabel?: string;
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
  isUnassignedCg?: boolean;
  scriptStem?: string;
  resourceIds: string[];
};
type ClientPayload = {
  entries: CompactEntry[];
  scenes: CompactScene[];
  resources: Record<string, CompactResource>;
  subworlds: Array<{ id: string; title: string; sectionAct: number; nodeKeys: string[]; continuationKeys: string[] }>;
};
type Camera = { x: number; y: number; scale: number };
type Pointer = { x: number; y: number; startX: number; startY: number };
type Gesture = {
  pointers: Map<number, Pointer>;
  dragging: boolean;
  moved: boolean;
  pinchStart?: { distance: number; scale: number; worldX: number; worldY: number };
};
type StoryTextEntry = ArcaeaStoryAtlasType["text"]["entries"][number];
type StoryLocale = StoryTextEntry["texts"][string];
type StoryTextBlock = StoryLocale["blocks"][number];
type StoryPage = { page: number; blocks: StoryTextBlock[] };
type StorySegment =
  | { kind: "text"; text: string; pageStart: number; pageEnd: number }
  | { kind: "visual"; resource?: CompactResource; assetPath?: string; page: number };

const root = document.querySelector<HTMLElement>("[data-story-atlas-root]");
if (root) void initialize(root);

async function initialize(root: HTMLElement): Promise<void> {
  const payloadNode = root.querySelector<HTMLScriptElement>("[data-story-atlas-client-index]");
  if (!payloadNode?.textContent) return;
  const payload = JSON.parse(payloadNode.textContent) as ClientPayload;
  const panels = [...root.querySelectorAll<HTMLElement>("[data-story-section-panel]")];
  const subworldPanels = [...root.querySelectorAll<HTMLElement>("[data-story-subworld-panel]")];
  const panelsContainer = root.querySelector<HTMLElement>("[data-story-panels]");
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
  const allViewPanels = [...panels, ...subworldPanels];
  const cameras = new Map<HTMLElement, Camera>();
  const gestures = new Map<HTMLElement, Gesture>();
  let activePanel = panels.find((panel) => !panel.hidden) ?? panels[0]!;
  let activeSubworldId: string | undefined;
  let subworldOriginAct: string | undefined;
  let subworldOriginScrollY: number | undefined;
  let suppressClickUntil = 0;
  let atlasPromise: Promise<ArcaeaStoryAtlasType> | undefined;
  const selectedLocale: Record<string, string> = {};
  let openEntryId: string | undefined;
  let openSceneId: string | undefined;
  let lastFocusedElement: HTMLElement | null = null;
  let modalLockCount = 0;
  let savedScrollY = 0;
  let savedBodyStyles: { position: string; top: string; width: string; overflow: string } | undefined;

  const CAMERA_MIN = 0.34;
  const CAMERA_FIT_MIN = 0.14;
  const CAMERA_MAX = 1.8;
  const DRAG_THRESHOLD = 5;
  const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
  const panelViewport = (panel: HTMLElement): HTMLElement | null => panel.querySelector<HTMLElement>("[data-story-map-viewport]");
  const panelWorld = (panel: HTMLElement): HTMLElement | null => panel.querySelector<HTMLElement>("[data-story-map-world]");
  const panelForViewport = (viewport: HTMLElement): HTMLElement | null => viewport.closest<HTMLElement>("[data-story-section-panel], [data-story-subworld-panel]");
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
    const initial = viewport && world ? initialCamera(viewport, world) : { x: 0, y: 0, scale: 0.78 };
    cameras.set(panel, initial);
    return initial;
  }

  function initialCamera(viewport: HTMLElement, world: HTMLElement): Camera {
    const width = Number(world.dataset.worldWidth ?? viewport.dataset.worldWidth ?? 1600);
    const height = Number(world.dataset.worldHeight ?? viewport.dataset.worldHeight ?? 900);
    const scale = clamp(Number(viewport.dataset.storyInitialScale ?? 0.78), CAMERA_MIN, CAMERA_MAX);
    const focusX = Number(viewport.dataset.storyInitialX ?? width / 2);
    const focusY = Number(viewport.dataset.storyInitialY ?? height / 2);
    const camera = {
      x: viewport.clientWidth / 2 - (Number.isFinite(focusX) ? focusX : width / 2) * scale,
      y: viewport.clientHeight / 2 - (Number.isFinite(focusY) ? focusY : height / 2) * scale,
      scale,
    };
    clampCamera(viewport, world, camera);
    return camera;
  }

  function renderCamera(panel: HTMLElement): void {
    const viewport = panelViewport(panel);
    const world = panelWorld(panel);
    if (!viewport || !world) return;
    const camera = cameraFor(panel);
    clampCamera(viewport, world, camera, camera.scale < CAMERA_MIN ? CAMERA_FIT_MIN : CAMERA_MIN);
    world.style.transformOrigin = "0 0";
    world.style.transform = "translate3d(" + camera.x + "px," + camera.y + "px,0) scale(" + camera.scale + ")";
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
    cameras.set(panel, initialCamera(viewport, world));
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

  function activateLazyImages(panel: HTMLElement): void {
    for (const image of panel.querySelectorAll<HTMLImageElement>("img[data-src]")) {
      const source = image.dataset.src;
      if (!source) continue;
      image.src = source;
      delete image.dataset.src;
    }
  }

  function activateSection(act: string): void {
    if (activeSubworldId) leaveSubworld(false);
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
    if (!cameras.has(panel)) resetPanel(panel); else renderCamera(panel);
  }

  const interactiveSelector = "button, a, input, select, textarea, [data-story-map-entry], [data-story-avatar], [data-story-scene], [data-story-path], [data-story-portal]";
  const isInteractiveTarget = (target: EventTarget | null): boolean => target instanceof Element && Boolean(target.closest(interactiveSelector));

  for (const viewport of root.querySelectorAll<HTMLElement>("[data-story-map-viewport]")) {
    const panel = panelForViewport(viewport);
    if (!panel) continue;
    const capturePointer = (pointerId: number): void => {
      try { viewport.setPointerCapture(pointerId); } catch { /* synthetic events may not be capturable */ }
    };
    const releasePointer = (pointerId: number): void => {
      try { if (viewport.hasPointerCapture(pointerId)) viewport.releasePointerCapture(pointerId); } catch { /* already released */ }
    };
    viewport.addEventListener("wheel", (event) => {
      if (!event.ctrlKey && !event.metaKey && Math.abs(event.deltaY) < 2) return;
      event.preventDefault();
      zoomAround(panel, cameraFor(panel).scale * Math.pow(0.998, event.deltaY), event.clientX, event.clientY);
    }, { passive: false });
    viewport.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 && event.pointerType === "mouse") return;
      if (isInteractiveTarget(event.target)) return;
      const gesture = gestureFor(viewport);
      gesture.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY });
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
      camera.x += event.clientX - previous.x;
      camera.y += event.clientY - previous.y;
      gesture.moved = true;
      renderCamera(panel);
      event.preventDefault();
    }, { passive: false });
    const stopPointer = (event: PointerEvent): void => {
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

  function focusElement(panel: HTMLElement, element: HTMLElement, scale?: number): void {
    const x = Number(element.dataset.storyX);
    const y = Number(element.dataset.storyY);
    if (Number.isFinite(x) && Number.isFinite(y)) focusPoint(panel, x, y, scale);
  }

  function setSelection(pathId: number, key: string): void {
    for (const entry of root.querySelectorAll<HTMLElement>("[data-story-map-entry]")) {
      entry.classList.toggle("is-selected", entry.dataset.storyPathId === String(pathId) && entry.dataset.storyEntryKey === key);
    }
    for (const path of root.querySelectorAll<HTMLElement>("[data-story-map-path]")) {
      path.classList.toggle("is-focused", path.dataset.storyMapPath === String(pathId));
    }
    for (const line of root.querySelectorAll<SVGLineElement>("[data-story-link-from], [data-story-link-to]")) {
      const related = line.dataset.storyLinkFrom === key || line.dataset.storyLinkTo === key || line.dataset.storyLinkPathIds?.split(",").includes(String(pathId)) === true;
      line.classList.toggle("is-related", related);
    }
  }

  function focusPath(pathId: number, sectionAct: string, update = true): void {
    activateSection(sectionAct);
    const button = root.querySelector<HTMLButtonElement>("[data-story-path='" + CSS.escape(String(pathId)) + "'][data-story-path-section='" + CSS.escape(sectionAct) + "']");
    if (!button) return;
    for (const path of root.querySelectorAll<HTMLElement>("[data-story-map-path]")) path.classList.toggle("is-focused", path.dataset.storyMapPath === String(pathId));
    for (const line of root.querySelectorAll<SVGLineElement>("[data-story-link-path-ids]")) line.classList.toggle("is-related", line.dataset.storyLinkPathIds?.split(",").includes(String(pathId)) === true);
    focusElement(activePanel, button, 0.86);
    if (update) updateUrl({ "story-view": "game", "story-path": String(pathId), "story-entry": undefined, "story-scene": undefined, "story-subworld": undefined });
  }

  function ensureAtlas(): Promise<ArcaeaStoryAtlasType> {
    atlasPromise ??= fetch(root.dataset.storyAtlasUrl ?? "", { credentials: "omit" }).then(async (response) => {
      if (!response.ok) throw new Error("Story Atlas data failed with " + response.status);
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

  function lockBody(): void {
    if (modalLockCount === 0) {
      savedScrollY = window.scrollY;
      savedBodyStyles = {
        position: document.body.style.position,
        top: document.body.style.top,
        width: document.body.style.width,
        overflow: document.body.style.overflow,
      };
      document.body.style.position = "fixed";
      document.body.style.top = "-" + savedScrollY + "px";
      document.body.style.width = "100%";
      document.body.style.overflow = "hidden";
      document.body.classList.add("story-modal-open");
      document.querySelector<HTMLElement>(".site-main")?.classList.add("story-modal-context");
    }
    modalLockCount += 1;
  }

  function unlockBody(): void {
    modalLockCount = Math.max(0, modalLockCount - 1);
    if (modalLockCount > 0) return;
    const styles = savedBodyStyles;
    document.body.style.position = styles?.position ?? "";
    document.body.style.top = styles?.top ?? "";
    document.body.style.width = styles?.width ?? "";
    document.body.style.overflow = styles?.overflow ?? "";
    document.body.classList.remove("story-modal-open");
    document.querySelector<HTMLElement>(".site-main")?.classList.remove("story-modal-context");
    window.scrollTo({ top: savedScrollY, behavior: "instant" as ScrollBehavior });
    savedBodyStyles = undefined;
  }

  function normalizeAssetPath(assetPath: string | undefined): string {
    let normalized = (assetPath ?? "").split(String.fromCharCode(92)).join("/");
    while (normalized.startsWith("/")) normalized = normalized.slice(1);
    return normalized;
  }

  function resourceForAsset(assetPath: string | undefined): CompactResource | undefined {
    const normalized = normalizeAssetPath(assetPath);
    if (!normalized) return undefined;
    return Object.values(payload.resources).find((resource) => resource.assetPaths.some((path) => normalizeAssetPath(path) === normalized));
  }

  function resourcesForIds(resourceIds: string[]): CompactResource[] {
    return resourceIds.map((id) => payload.resources[id]).filter((resource): resource is CompactResource => Boolean(resource));
  }

  function pagesForText(locale: StoryLocale): StoryPage[] {
    const grouped = new Map<number, StoryTextBlock[]>();
    for (const block of locale.blocks) {
      const blocks = grouped.get(block.page) ?? [];
      blocks.push(block);
      grouped.set(block.page, blocks);
    }
    return [...grouped.entries()].sort(([left], [right]) => left - right).map(([page, blocks]) => ({ page, blocks }));
  }

  function chooseLocale(textEntry: StoryTextEntry, targetKey: string): { locale: string; text: StoryLocale } | undefined {
    const available = Object.keys(textEntry.texts);
    if (available.length === 0) return undefined;
    const preferred = selectedLocale[targetKey];
    const locale = preferred && textEntry.texts[preferred]
      ? preferred
      : ["zh-Hans", "zh-Hant", "en", "ja", "ko"].find((candidate) => textEntry.texts[candidate]) ?? available[0];
    return locale && textEntry.texts[locale] ? { locale, text: textEntry.texts[locale] } : undefined;
  }

  function buildStorySegments(locale: StoryLocale): StorySegment[] {
    const segments: StorySegment[] = [];
    const pages = pagesForText(locale);
    let textParts: string[] = [];
    let textStart = 0;
    let textEnd = 0;
    const flushText = (): void => {
      const text = textParts.join("\n\n").replace(/\n{3,}/gu, "\n\n").trim();
      if (text) segments.push({ kind: "text", text, pageStart: textStart, pageEnd: textEnd });
      textParts = [];
      textStart = 0;
      textEnd = 0;
    };
    for (const page of pages) {
      for (const block of page.blocks) {
        const text = block.text?.trim();
        if (text) {
          if (textParts.length === 0) textStart = page.page;
          textEnd = page.page;
          textParts.push(text);
        }
        if (block.kind === "display-event") {
          flushText();
          const resource = resourceForAsset(block.assetPath);
          if (resource) {
            segments.push(block.assetPath
              ? { kind: "visual", resource, assetPath: block.assetPath, page: page.page }
              : { kind: "visual", resource, page: page.page });
          }
        }
      }
      if (textParts.join("\n\n").length >= 1100) flushText();
    }
    flushText();
    return segments;
  }

  function localeLabel(locale: string): string {
    return locale === "zh-Hans" ? "简中"
      : locale === "zh-Hant" ? "繁中"
        : locale === "ja" ? "日本語"
          : locale === "ko" ? "한국어"
            : "English";
  }

  function appendLocaleSwitch(parent: HTMLElement, textEntry: StoryTextEntry, targetKey: string, activeLocale: string): void {
    const switcher = element("div", "story-locale-switch");
    switcher.setAttribute("role", "group");
    switcher.setAttribute("aria-label", "剧情语言");
    const localeOrder = ["zh-Hans", "zh-Hant", "en", "ja", "ko"];
    const locales = [
      ...localeOrder.filter((locale) => textEntry.texts[locale]),
      ...Object.keys(textEntry.texts).filter((locale) => !localeOrder.includes(locale)),
    ];
    for (const locale of locales) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.storyLocale = locale;
      button.dataset.storyLocaleTarget = targetKey;
      button.classList.toggle("is-active", locale === activeLocale);
      button.textContent = localeLabel(locale);
      switcher.append(button);
    }
    parent.append(switcher);
  }

  function appendMetaRow(parent: HTMLElement, label: string, value: string): void {
    const row = element("div", "story-detail-meta-row");
    row.append(textNode("dt", label), textNode("dd", value));
    parent.append(row);
  }

  function renderResources(resourceIds: string[], compact: boolean): HTMLElement | undefined {
    const items = resourcesForIds([...new Set(resourceIds)]);
    if (items.length === 0) return undefined;
    const section = element("section", compact ? "story-dialog-resources is-compact" : "story-dialog-resources");
    section.append(textNode("div", compact ? "相关视觉资源" : "相关视觉", "story-detail-section-label"));
    const grid = element("div", compact ? "story-dialog-resource-strip" : "story-dialog-resource-grid");
    for (const resource of items) {
      const card = element("article", "story-dialog-resource-card");
      const link = document.createElement("a");
      link.href = resource.route;
      link.className = "story-dialog-resource-link";
      const imageSource = compact ? resource.thumb ?? resource.preview : resource.preview ?? resource.thumb;
      if (imageSource) {
        const image = document.createElement("img");
        image.src = imageSource;
        image.alt = resource.title;
        image.loading = "lazy";
        image.decoding = "async";
        link.append(image);
      }
      link.append(textNode("span", resource.title));
      card.append(link);
      if (resource.download) {
        const download = document.createElement("a");
        download.className = "story-dialog-download";
        download.dataset.statsDownload = "true";
        download.dataset.resourceId = resource.resourceId;
        download.href = resource.download;
        download.textContent = "下载原图";
        download.target = "_blank";
        download.rel = "noreferrer";
        if (resource.downloadFilename) download.download = resource.downloadFilename;
        card.append(download);
      }
      grid.append(card);
    }
    section.append(grid);
    return section;
  }

  function renderStoryFlow(textEntry: StoryTextEntry | undefined, resourceIds: string[], targetKey: string): HTMLElement {
    const section = element("section", "story-dialog-story");
    const choice = textEntry ? chooseLocale(textEntry, targetKey) : undefined;
    const segments = choice ? buildStorySegments(choice.text) : [];
    const hasInlineVisual = segments.some((segment) => segment.kind === "visual" && Boolean(segment.resource?.preview));
    const flowResourceIds = [...new Set([
      ...resourceIds,
      ...segments.flatMap((segment) => segment.kind === "visual" && segment.resource ? [segment.resource.resourceId] : []),
    ])];
    if (!hasInlineVisual) {
      const gallery = renderResources(resourceIds, false);
      if (gallery) section.append(gallery);
    }
    if (textEntry && choice) {
      const toolbar = element("div", "story-dialog-story-toolbar");
      toolbar.append(textNode("div", "完整剧情", "story-detail-section-label"));
      appendLocaleSwitch(toolbar, textEntry, targetKey, choice.locale);
      section.append(toolbar);
    }
    const flow = element("div", "story-dialog-story-flow");
    for (const segment of segments) {
      if (segment.kind === "visual") {
        if (!segment.resource?.preview) continue;
        const figure = element("figure", "story-dialog-inline-visual");
        const image = document.createElement("img");
        image.src = segment.resource.preview;
        image.alt = segment.resource.title;
        image.loading = "lazy";
        image.decoding = "async";
        figure.append(image, textNode("figcaption", segment.resource.title));
        flow.append(figure);
        continue;
      }
      const article = element("article", "story-dialog-text-segment");
      article.dataset.storyPages = segment.pageStart + "-" + segment.pageEnd;
      for (const paragraph of segment.text.split(/\n{2,}/u)) {
        if (paragraph.trim()) article.append(textNode("p", paragraph.trim()));
      }
      if (article.childElementCount > 0) flow.append(article);
    }
    if (flow.childElementCount === 0 && (!textEntry || !choice || segments.length === 0)) {
      flow.append(textNode("p", resourceIds.length > 0 ? "该节点仅包含游戏内插画，包体未提供对白正文。" : "这条剧情暂时没有可显示的正文。", "story-dialog-empty"));
    }
    if (flow.childElementCount > 0) section.append(flow);
    if (hasInlineVisual) {
      const related = renderResources(flowResourceIds, true);
      if (related) section.append(related);
    }
    return section;
  }

  function sceneKindLabel(kind: string): string {
    return kind === "path-scene" ? "相关场景" : "剧情场景";
  }

  function sceneDisplayTitle(scene: CompactScene): string {
    if (scene.isUnassignedCg) return "未归类 CG";
    if (scene.kind === "epilogue") return "One Last Dream";
    return scene.displayTitle.replace(/\s*·\s*VN scene$/u, "");
  }

  function renderDialogHeader(key: string, title: string, summary: string, metadata: Array<[string, string]>): void {
    const summaryNode = textNode("p", summary, "story-detail-path");
    summaryNode.id = "story-detail-summary";
    const heading = textNode("h3", title);
    heading.id = "story-detail-heading";
    detailContentElement.append(
      textNode("div", key, "story-detail-eyebrow"),
      heading,
      summaryNode,
    );
    if (metadata.length > 0) {
      const details = element("dl", "story-detail-meta");
      for (const [label, value] of metadata) appendMetaRow(details, label, value);
      detailContentElement.append(details);
    }
  }

  function renderDialogResources(resourceIds: string[]): void {
    const resource = resourcesForIds(resourceIds)[0];
    if (resource?.route) {
      const actions = element("div", "story-detail-actions");
      const link = document.createElement("a");
      link.className = "button button-secondary";
      link.href = resource.route;
      link.textContent = "打开资源页";
      actions.append(link);
      detailContentElement.append(actions);
    }
  }

  async function renderEntryDetail(entry: CompactEntry): Promise<void> {
    const atlas = await ensureAtlas();
    if (openEntryId !== entry.id) return;
    const textEntry = atlas.text.entries.find((candidate) => candidate.nodeKey === entry.key);
    const scenes = atlas.scenes.filter((scene) => entry.sceneIds.includes(scene.sceneId));
    const resourceIds = [...new Set([
      ...entry.resourceIds,
      ...scenes.flatMap((scene) => scene.resourceIds),
    ])];
    detailContentElement.replaceChildren();
    const metadata: Array<[string, string]> = [
      ["章节", entry.sectionLabel],
      ...(entry.characterLabels.length > 0 ? [["角色", entry.characterLabels.join(" / ")] as [string, string]] : []),
      ...(entry.relatedSongs.length > 0 ? [["相关歌曲", entry.relatedSongs.join(" / ")] as [string, string]] : []),
    ];
    const title = entry.endingLabel ?? entry.pathTitle;
    renderDialogHeader(entry.key, title, "路径：" + entry.pathTitle, metadata);
    detailContentElement.append(renderStoryFlow(textEntry, resourceIds, entry.id));
    renderDialogResources(resourceIds);
  }

  async function renderSceneDetail(scene: CompactScene): Promise<void> {
    if (scene.isUnassignedCg) {
      if (openSceneId !== scene.sceneId) return;
      detailContentElement.replaceChildren();
      renderDialogHeader("未归类 CG", "未归类 CG", "路径：" + scene.pathTitle, [["章节", scene.sectionLabel], ["资源数量", String(scene.resourceIds.length)]]);
      const gallery = renderResources(scene.resourceIds, false);
      if (gallery) detailContentElement.append(gallery);
      renderDialogResources(scene.resourceIds);
      return;
    }
    const atlas = await ensureAtlas();
    if (openSceneId !== scene.sceneId) return;
    const definition = atlas.scenes.find((candidate) => candidate.sceneId === scene.sceneId);
    const textEntry = definition?.nodeKey
      ? atlas.text.entries.find((entry) => entry.nodeKey === definition.nodeKey)
      : definition?.storyData
        ? atlas.text.entries.find((entry) => entry.storyData === definition.storyData)
        : undefined;
    detailContentElement.replaceChildren();
    const sceneTitle = sceneDisplayTitle(scene);
    const entry = textEntry ? payload.entries.find((candidate) => candidate.key === textEntry.nodeKey) : undefined;
    const resourceIds = [...new Set([
      ...scene.resourceIds,
      ...(entry?.resourceIds ?? []),
    ])];
    const metadata: Array<[string, string]> = [
      ["章节", scene.sectionLabel],
      ["路径", scene.pathTitle],
      ...(entry?.characterLabels.length ? [["角色", entry.characterLabels.join(" / ")] as [string, string]] : []),
      ...(entry?.relatedSongs.length ? [["相关歌曲", entry.relatedSongs.join(" / ")] as [string, string]] : []),
    ];
    detailContentElement.replaceChildren();
    renderDialogHeader(textEntry?.nodeKey ?? sceneKindLabel(scene.kind), sceneTitle, "路径：" + scene.pathTitle, metadata);
    detailContentElement.append(renderStoryFlow(textEntry, resourceIds, scene.sceneId));
    renderDialogResources(resourceIds);
  }

  function renderError(message: string): void {
    detailContentElement.replaceChildren(textNode("p", message, "story-detail-error"));
  }

  async function openEntry(entry: CompactEntry): Promise<void> {
    if (detailElement.hidden) lockBody();
    lastFocusedElement = document.activeElement instanceof HTMLElement && !detailElement.contains(document.activeElement) ? document.activeElement : null;
    openEntryId = entry.id;
    openSceneId = undefined;
    detailElement.hidden = false;
    root.classList.add("has-story-detail");
    try {
      await renderEntryDetail(entry);
    } catch {
      if (openEntryId === entry.id) renderError("剧情内容加载失败，请稍后再试。");
    }
    if (openEntryId === entry.id) root.querySelector<HTMLButtonElement>("button[data-story-detail-close]")?.focus();
  }

  async function openScene(scene: CompactScene): Promise<void> {
    if (detailElement.hidden) lockBody();
    lastFocusedElement = document.activeElement instanceof HTMLElement && !detailElement.contains(document.activeElement) ? document.activeElement : null;
    openEntryId = undefined;
    openSceneId = scene.sceneId;
    detailElement.hidden = false;
    root.classList.add("has-story-detail");
    try {
      await renderSceneDetail(scene);
    } catch {
      if (openSceneId === scene.sceneId) renderError("剧情场景加载失败，请稍后再试。");
    }
    if (openSceneId === scene.sceneId) root.querySelector<HTMLButtonElement>("button[data-story-detail-close]")?.focus();
  }

  function closeDetail(): void {
    if (detailElement.hidden) return;
    detailElement.hidden = true;
    root.classList.remove("has-story-detail");
    openEntryId = undefined;
    openSceneId = undefined;
    updateUrl({ "story-entry": undefined, "story-scene": undefined });
    const focusTarget = lastFocusedElement;
    lastFocusedElement = null;
    unlockBody();
    if (focusTarget?.isConnected && !detailElement.contains(focusTarget)) focusTarget.focus();
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

  function hideSubworldPanel(): void {
    for (const panel of subworldPanels) panel.hidden = true;
    if (panelsContainer) panelsContainer.hidden = false;
    root.classList.remove("is-in-subworld");
  }

  function leaveSubworld(update = true): void {
    if (!activeSubworldId) return;
    const origin = subworldOriginAct ?? "2";
    const restoreScrollY = subworldOriginScrollY;
    activeSubworldId = undefined;
    subworldOriginAct = undefined;
    subworldOriginScrollY = undefined;
    hideSubworldPanel();
    activateSection(origin);
    if (restoreScrollY !== undefined) window.scrollTo(0, restoreScrollY);
    if (update) updateUrl({ "story-subworld": undefined, "story-path": undefined, "story-entry": undefined, "story-scene": undefined });
  }

  function focusSubworldNode(nodeKey: string, scale = 0.96): void {
    const panel = subworldPanels.find((candidate) => candidate.dataset.storySubworldPanel === activeSubworldId);
    if (!panel) return;
    const button = [...panel.querySelectorAll<HTMLButtonElement>("[data-story-subworld-node]")].find((candidate) => candidate.dataset.storyEntryKey === nodeKey);
    if (!button) return;
    setSelection(19, nodeKey);
    focusElement(panel, button, scale);
  }

  function enterSubworld(subworldId: string, focusKey?: string, update = true): void {
    const source = payload.subworlds.find((subworld) => subworld.id === subworldId);
    const panel = subworldPanels.find((candidate) => candidate.dataset.storySubworldPanel === subworldId);
    if (!source || !panel) return;
    const origin = String(source.sectionAct);
    if (!activeSubworldId) subworldOriginScrollY = window.scrollY;
    if (activeSubworldId) {
      activeSubworldId = undefined;
      subworldOriginAct = undefined;
      hideSubworldPanel();
    }
    activateSection(origin);
    activeSubworldId = subworldId;
    subworldOriginAct = origin;
    if (panelsContainer) panelsContainer.hidden = true;
    for (const candidate of subworldPanels) candidate.hidden = candidate !== panel;
    panel.hidden = false;
    root.classList.add("is-in-subworld");
    activePanel = panel;
    activateLazyImages(panel);
    if (!cameras.has(panel)) resetPanel(panel); else renderCamera(panel);
    const panelTop = panel.getBoundingClientRect().top + window.scrollY;
    window.scrollTo(0, Math.max(0, panelTop - 24));
    if (focusKey) focusSubworldNode(focusKey);
    if (update) updateUrl({ "story-view": "game", "story-subworld": subworldId });
  }

  function focusEntryButton(pathId: number, key: string, panel: HTMLElement): HTMLButtonElement | undefined {
    return [...panel.querySelectorAll<HTMLButtonElement>("[data-story-map-entry]")].find((candidate) => candidate.dataset.storyPathId === String(pathId) && candidate.dataset.storyEntryKey === key);
  }

  function selectEntry(pathId: number, key: string, update = true, open = true): void {
    const entry = payload.entries.find((candidate) => candidate.pathId === pathId && candidate.key === key)
      ?? payload.entries.find((candidate) => candidate.key === key);
    if (!entry) return;
    if (entry.subworldId) {
      enterSubworld(entry.subworldId, key, update);
      setSelection(entry.pathId, key);
      if (open) void openEntry(entry);
      if (update) updateUrl({ "story-path": String(entry.pathId), "story-entry": entry.key, "story-scene": undefined, "story-subworld": entry.subworldId });
      return;
    }
    activateSection(String(entry.sectionAct));
    const button = focusEntryButton(entry.pathId, entry.key, activePanel);
    setSelection(entry.pathId, entry.key);
    if (button) focusElement(activePanel, button, 0.98);
    if (update) updateUrl({ "story-view": "game", "story-path": String(entry.pathId), "story-entry": entry.key, "story-scene": undefined, "story-subworld": undefined });
    if (open) void openEntry(entry);
  }

  function selectScene(sceneId: string, update = true): void {
    const scene = payload.scenes.find((candidate) => candidate.sceneId === sceneId);
    if (!scene) return;
    if (scene.pathId === 19 || scene.kind === "epilogue") enterSubworld("final-verdict", undefined, update);
    else activateSection(String(scene.sectionAct));
    const button = activePanel.querySelector<HTMLButtonElement>("[data-story-scene='" + CSS.escape(sceneId) + "']");
    if (button) focusElement(activePanel, button, 0.98);
    if (update) updateUrl({ "story-view": "game", "story-path": scene.pathId === undefined ? undefined : String(scene.pathId), "story-entry": undefined, "story-scene": sceneId, "story-subworld": scene.pathId === 19 ? "final-verdict" : undefined });
    void openScene(scene);
  }

  function handleCamera(panel: HTMLElement, action: string): void {
    if (action === "zoom-in") zoomAround(panel, cameraFor(panel).scale * 1.16);
    else if (action === "zoom-out") zoomAround(panel, cameraFor(panel).scale / 1.16);
    else if (action === "fit") fitPanel(panel);
    else if (action === "initial") resetPanel(panel);
  }

  function focusable(container: HTMLElement): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>("button:not([disabled]), a[href], input, select, textarea, [tabindex]:not([tabindex='-1'])")].filter((candidate) => !candidate.hidden && candidate.getClientRects().length > 0);
  }

  function activeModal(): HTMLElement | null {
    return detailElement.hidden ? null : detailElement;
  }

  root.addEventListener("click", (event) => {
    if (Date.now() < suppressClickUntil) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("[data-story-detail-close]")) {
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
      const panel = cameraButton.closest<HTMLElement>("[data-story-section-panel], [data-story-subworld-panel]");
      if (panel) handleCamera(panel, cameraButton.dataset.storyCamera ?? "");
      return;
    }
    if (target.closest("[data-story-subworld-back]")) {
      event.preventDefault();
      leaveSubworld();
      return;
    }
    const tab = target.closest<HTMLButtonElement>("[data-story-part-tabs] [data-story-section]");
    if (tab?.dataset.storySection) {
      event.preventDefault();
      activateSection(tab.dataset.storySection);
      updateUrl({ "story-view": "game", "story-path": undefined, "story-entry": undefined, "story-scene": undefined, "story-subworld": undefined });
      return;
    }
    const overview = target.closest<HTMLButtonElement>("[data-story-overview-path]");
    if (overview?.dataset.storyOverviewPath && overview.dataset.storyOverviewSection) {
      event.preventDefault();
      focusPath(Number(overview.dataset.storyOverviewPath), overview.dataset.storyOverviewSection);
      return;
    }
    const portal = target.closest<HTMLButtonElement>("[data-story-portal]");
    if (portal?.dataset.storySubworld) {
      event.preventDefault();
      enterSubworld(portal.dataset.storySubworld, undefined, true);
      return;
    }
    const node = target.closest<HTMLButtonElement>("[data-story-map-entry]");
    if (node?.dataset.storyPathId && node.dataset.storyEntryKey) {
      event.preventDefault();
      selectEntry(Number(node.dataset.storyPathId), node.dataset.storyEntryKey);
      return;
    }
    const avatar = target.closest<HTMLButtonElement>("[data-story-avatar]");
    if (avatar?.dataset.storyClusterPath && avatar.dataset.storySection) {
      event.preventDefault();
      for (const candidate of root.querySelectorAll<HTMLElement>("[data-story-avatar]")) candidate.classList.remove("is-cluster-focused");
      avatar.classList.add("is-cluster-focused");
      focusPath(Number(avatar.dataset.storyClusterPath), avatar.dataset.storySection);
      return;
    }
    const scene = target.closest<HTMLButtonElement>("[data-story-scene]");
    if (scene?.dataset.storyScene) {
      event.preventDefault();
      selectScene(scene.dataset.storyScene);
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
      if (entry) selectEntry(entry.pathId, entry.key);
      else if (sceneResult) selectScene(sceneResult.sceneId);
      if (searchResults) searchResults.hidden = true;
      return;
    }
    const locale = target.closest<HTMLElement>("[data-story-locale]");
    if (locale?.dataset.storyLocale) {
      const key = locale.dataset.storyLocaleTarget ?? openEntryId ?? openSceneId ?? "";
      if (key) selectedLocale[key] = locale.dataset.storyLocale;
      if (openEntryId || openSceneId) {
        const entry = openEntryId ? payload.entries.find((candidate) => candidate.id === openEntryId) : undefined;
        const sceneValue = openSceneId ? payload.scenes.find((candidate) => candidate.sceneId === openSceneId) : undefined;
        if (entry) void renderEntryDetail(entry);
        else if (sceneValue) void renderSceneDetail(sceneValue);
      }
    }
  });

  async function runSearch(value: string): Promise<void> {
    if (!searchResults || !searchStatus) return;
    const query = value.normalize("NFKC").toLocaleLowerCase("en").trim();
    if (!query) {
      searchResults.hidden = true;
      searchStatus.textContent = "";
      return;
    }
    searchStatus.textContent = "正在搜索…";
    try {
      const atlas = await ensureAtlas();
      const indexByNode = new Map(atlas.searchIndex.map((entry) => [entry.nodeKey, entry.terms.join(" ")]));
      const textByNode = new Map(atlas.text.entries.map((entry) => [
        entry.nodeKey,
        Object.values(entry.texts).flatMap((locale) => locale.blocks.map((block) => block.text ?? block.assetPath ?? "")).join(" "),
      ]));
      const matches = payload.entries.filter((entry) => {
        const resources = entry.resourceIds.map((id) => payload.resources[id]).filter(Boolean).flatMap((resource) => [resource!.title, resource!.subtitle ?? "", resource!.resourceId]);
        const haystack = [
          entry.id,
          entry.key,
          entry.pathTitle,
          entry.sectionLabel,
          entry.visualLabel,
          entry.endingLabel ?? "",
          ...entry.characterLabels,
          ...entry.relatedSongs,
          entry.unlockLabel ?? "",
          indexByNode.get(entry.key) ?? "",
          textByNode.get(entry.key) ?? "",
          ...resources,
        ].join(" ").normalize("NFKC").toLocaleLowerCase("en");
        return haystack.includes(query);
      }).slice(0, 12);
      const sceneMatches = payload.scenes.filter((scene) => [
        scene.sceneId,
        scene.displayTitle,
        scene.pathTitle,
        scene.scriptStem ?? "",
        scene.kind === "epilogue" ? "epilogue" : "story scene",
      ].join(" ").normalize("NFKC").toLocaleLowerCase("en").includes(query)).slice(0, 4);
      searchResults.replaceChildren();
      for (const entry of matches) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.storySearchResult = entry.id;
        button.append(
          textNode("strong", entry.endingLabel ?? entry.key),
          textNode("span", (entry.endingLabel ? entry.key + " · " : "") + entry.pathTitle + " / " + entry.sectionLabel),
        );
        searchResults.append(button);
      }
      for (const scene of sceneMatches) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.storySearchResult = scene.sceneId;
        button.append(textNode("strong", sceneDisplayTitle(scene)), textNode("span", scene.pathTitle + " / " + sceneKindLabel(scene.kind)));
        searchResults.append(button);
      }
      const count = matches.length + sceneMatches.length;
      searchResults.hidden = false;
      searchStatus.textContent = count + " 个结果";
      if (count === 0) searchResults.append(textNode("p", "没有找到匹配的剧情节点或场景。", "story-search-empty"));
    } catch {
      searchResults.hidden = false;
      searchResults.replaceChildren(textNode("p", "搜索暂时不可用。", "story-search-empty"));
      searchStatus.textContent = "搜索不可用";
    }
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
    const requestedEntry = params.get("story-entry") ?? params.get("story-node") ?? params.get("story");
    const requestedScene = params.get("story-scene");
    const requestedSubworld = params.get("story-subworld");
    if (requestedScene) {
      const scene = payload.scenes.find((candidate) => candidate.sceneId === requestedScene);
      if (scene) {
        selectScene(scene.sceneId, false);
        return;
      }
    }
    if (requestedEntry) {
      const entry = payload.entries.find((candidate) => candidate.key === requestedEntry && (requestedPath === null || candidate.pathId === Number(requestedPath)))
        ?? payload.entries.find((candidate) => candidate.key === requestedEntry);
      if (entry) {
        selectEntry(entry.pathId, entry.key, false);
        return;
      }
    }
    if (requestedSubworld) {
      enterSubworld(requestedSubworld, undefined, false);
      return;
    }
    if (requestedPath) {
      const pathId = Number(requestedPath);
      const pathButton = root.querySelector<HTMLButtonElement>("[data-story-path='" + CSS.escape(String(pathId)) + "']");
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
    const modal = activeModal();
    if (event.key === "Escape" && modal === detailElement) {
      event.preventDefault();
      closeDetail();
      return;
    }
    if (event.key === "Tab" && modal) {
      const elements = focusable(modal);
      if (elements.length === 0) return;
      const current = document.activeElement instanceof HTMLElement ? elements.indexOf(document.activeElement) : -1;
      const next = event.shiftKey
        ? elements[(current <= 0 ? elements.length : current) - 1]
        : elements[(current + 1) % elements.length];
      if (next) {
        event.preventDefault();
        next.focus();
      }
      return;
    }
    if ((event.key === "+" || event.key === "=" || event.key === "-" || event.key === "_") && event.target instanceof HTMLElement && event.target.closest("[data-story-map-viewport]")) {
      event.preventDefault();
      handleCamera(activePanel, event.key === "-" || event.key === "_" ? "zoom-out" : "zoom-in");
    }
  });

  window.addEventListener("popstate", initializeFromUrl);
  window.addEventListener("resize", () => {
    for (const panel of allViewPanels) if (!panel.hidden) renderCamera(panel);
  });

  initializeFromUrl();
}

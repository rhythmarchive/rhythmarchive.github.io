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
type Pointer = { x: number; y: number };

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
  const pointers = new Map<number, Pointer>();
  let activePanel = panels.find((panel) => !panel.hidden) ?? panels[0]!;
  let dragged = false;
  let suppressClickUntil = 0;
  let pinchStart: { distance: number; scale: number; worldX: number; worldY: number } | undefined;
  let atlasPromise: Promise<ArcaeaStoryAtlasType> | undefined;
  let selectedLocale: Record<string, string> = {};
  let selectedCgIndex = 0;

  const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
  const panelViewport = (panel: HTMLElement): HTMLElement | null => panel.querySelector<HTMLElement>("[data-story-map-viewport]");
  const panelWorld = (panel: HTMLElement): HTMLElement | null => panel.querySelector<HTMLElement>("[data-story-map-world]");

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
    const world = panelWorld(panel);
    if (!world) return;
    const camera = cameraFor(panel);
    world.style.transformOrigin = "0 0";
    world.style.transform = `translate3d(${camera.x}px,${camera.y}px,0) scale(${camera.scale})`;
    panel.dataset.storyCameraScale = camera.scale.toFixed(3);
  }

  function fitCamera(viewport: HTMLElement, world: HTMLElement): Camera {
    const width = Number(world.dataset.worldWidth ?? viewport.dataset.worldWidth ?? 1600);
    const height = Number(world.dataset.worldHeight ?? viewport.dataset.worldHeight ?? 900);
    const scale = clamp(Math.min((viewport.clientWidth - 36) / width, (viewport.clientHeight - 36) / height), 0.45, 1.05);
    return { x: (viewport.clientWidth - width * scale) / 2, y: (viewport.clientHeight - height * scale) / 2, scale };
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
    const scale = 0.82;
    cameras.set(panel, { x: (viewport.clientWidth - width * scale) / 2, y: (viewport.clientHeight - height * scale) / 2, scale });
    renderCamera(panel);
  }

  function focusPoint(panel: HTMLElement, x: number, y: number, requestedScale?: number): void {
    const viewport = panelViewport(panel);
    if (!viewport) return;
    const camera = cameraFor(panel);
    const scale = clamp(requestedScale ?? Math.max(camera.scale, 0.92), 0.45, 1.65);
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
    camera.scale = clamp(nextScale, 0.45, 1.65);
    camera.x = localX - worldX * camera.scale;
    camera.y = localY - worldY * camera.scale;
    renderCamera(panel);
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

  for (const panel of panels) {
    const viewport = panelViewport(panel);
    if (!viewport) continue;
    viewport.addEventListener("wheel", (event) => {
      if (!event.ctrlKey && !event.metaKey && Math.abs(event.deltaY) < 2) return;
      event.preventDefault();
      zoomAround(panel, cameraFor(panel).scale * Math.pow(0.998, event.deltaY), event.clientX, event.clientY);
    }, { passive: false });
    viewport.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 && event.pointerType === "mouse") return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      viewport.setPointerCapture(event.pointerId);
      dragged = false;
      if (pointers.size === 1 && !(event.target instanceof Element && event.target.closest("button,a"))) {
        viewport.dataset.storyPanning = "true";
      }
      if (pointers.size === 2) {
        const [first, second] = [...pointers.values()];
        if (first && second) {
          const midpoint = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
          const rect = viewport.getBoundingClientRect();
          const camera = cameraFor(panel);
          pinchStart = {
            distance: Math.hypot(first.x - second.x, first.y - second.y),
            scale: camera.scale,
            worldX: (midpoint.x - rect.left - camera.x) / camera.scale,
            worldY: (midpoint.y - rect.top - camera.y) / camera.scale,
          };
          viewport.dataset.storyPanning = "true";
        }
      }
    });
    viewport.addEventListener("pointermove", (event) => {
      if (!pointers.has(event.pointerId)) return;
      const previous = pointers.get(event.pointerId);
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const camera = cameraFor(panel);
      if (pointers.size >= 2 && pinchStart) {
        const values = [...pointers.values()];
        const first = values[0];
        const second = values[1];
        if (!first || !second) return;
        const midpoint = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
        const rect = viewport.getBoundingClientRect();
        const distance = Math.max(1, Math.hypot(first.x - second.x, first.y - second.y));
        camera.scale = clamp(pinchStart.scale * distance / Math.max(1, pinchStart.distance), 0.45, 1.65);
        camera.x = midpoint.x - rect.left - pinchStart.worldX * camera.scale;
        camera.y = midpoint.y - rect.top - pinchStart.worldY * camera.scale;
        dragged = true;
        renderCamera(panel);
        event.preventDefault();
        return;
      }
      if (pointers.size !== 1 || viewport.dataset.storyPanning !== "true") return;
      if (!previous) return;
      const dx = event.clientX - previous.x;
      const dy = event.clientY - previous.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) dragged = true;
      camera.x += dx;
      camera.y += dy;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      renderCamera(panel);
      event.preventDefault();
    }, { passive: false });
    const stopPointer = (event: PointerEvent) => {
      pointers.delete(event.pointerId);
      if (dragged) suppressClickUntil = Date.now() + 120;
      if (pointers.size < 2) pinchStart = undefined;
      if (pointers.size === 0) delete viewport.dataset.storyPanning;
      if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    };
    viewport.addEventListener("pointerup", stopPointer);
    viewport.addEventListener("pointercancel", stopPointer);
    viewport.addEventListener("pointerleave", (event) => { if (event.pointerType === "mouse" && pointers.has(event.pointerId)) stopPointer(event); });
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
    const metadata = element("dl", "story-detail-meta");
    const items: Array<[string, string]> = [
      ["Path", entry.pathTitle],
      ["Act / Part", entry.sectionLabel],
      ["Story type", textEntry?.storyType ?? entry.visualLabel],
      ["Partner", (entry.characterLabels.length > 0 ? entry.characterLabels : entry.characterIds.map((id) => `#${id}`)).join(" · ") || "未标注"],
      ["Visual kind", entry.visualLabel],
    ];
    if (entry.relatedSongs.length > 0) items.push(["Related song", entry.relatedSongs.join(" · ")]);
    if (entry.unlockLabel) items.push(["Unlock", entry.unlockLabel]);
    if (entry.staffRoll) items.push(["Credits", "Staff roll"]);
    if (scenes.length > 0) items.push(["Scene", scenes.map((scene) => scene.sceneId).join(" · ")]);
    for (const [label, value] of items) {
      const row = element("div");
      row.append(textNode("dt", label), textNode("dd", value));
      metadata.append(row);
    }
    return metadata;
  }

  function renderStoryText(textEntry: ArcaeaStoryAtlasType["text"]["entries"][number] | undefined): HTMLElement | undefined {
    if (!textEntry) return undefined;
    const section = element("section", "story-detail-text");
    section.append(textNode("div", "剧情正文", "story-detail-section-label"));
    const locales = Object.keys(textEntry.texts);
    const preferred = selectedLocale[textEntry.nodeKey] ?? (textEntry.storyData ? selectedLocale[textEntry.storyData] : undefined) ?? ["zh-Hans", "zh-Hant", "en", "ja", "ko"].find((locale) => locales.includes(locale)) ?? locales[0];
    if (preferred) selectedLocale[textEntry.nodeKey] = preferred;
    const localeSwitch = element("div", "story-locale-switch");
    for (const locale of locales) {
      const button = textNode("button", locale === "zh-Hans" ? "简中" : locale === "zh-Hant" ? "繁中" : locale === "ja" ? "日本語" : locale === "ko" ? "한국어" : "English");
      button.setAttribute("type", "button");
      button.dataset.storyLocale = locale;
      button.classList.toggle("is-active", locale === preferred);
      localeSwitch.append(button);
    }
    section.append(localeSwitch);
    const blocks = preferred ? textEntry.texts[preferred]?.blocks ?? [] : [];
    const body = element("div", "story-text-blocks");
    for (const block of blocks) {
      if (block.kind === "display-event") {
        const label = block.assetPath?.split("/").at(-1) ?? "CG";
        body.append(textNode("p", block.text ? `视觉演出 · ${label} · ${block.text}` : `视觉演出 · ${label}`, "story-text-display-event"));
      } else if (block.text) {
        body.append(textNode("p", block.text));
      }
    }
    if (body.childElementCount === 0) body.append(textNode("p", "当前语言没有可显示的正文。"));
    section.append(body);
    return section;
  }

  function renderVisuals(resourceIds: string[]): HTMLElement | undefined {
    const items = resourceIds.map((id) => payload.resources[id]).filter((resource): resource is CompactResource => Boolean(resource));
    if (items.length === 0) return undefined;
    selectedCgIndex = clamp(selectedCgIndex, 0, items.length - 1);
    const section = element("section", "story-detail-visuals");
    section.append(textNode("div", "Visual / CG", "story-detail-section-label"));
    const active = items[selectedCgIndex];
    if (active) {
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
      const original = textNode("a", "查看高清 / 下载原图");
      original.setAttribute("href", active.original);
      original.setAttribute("target", "_blank");
      original.setAttribute("rel", "noreferrer");
      actions.append(original);
    }
    if (actions.childElementCount > 0) section.append(actions);
    return section;
  }

  function renderSceneInfo(scenes: ArcaeaStoryAtlasType["scenes"]): HTMLElement | undefined {
    if (scenes.length === 0) return undefined;
    const section = element("section", "story-detail-scene");
    section.append(textNode("div", "Scene information", "story-detail-section-label"));
    for (const scene of scenes) {
      const title = textNode("p", `${scene.displayTitle ?? scene.sceneId} · ${scene.kind}`);
      section.append(title);
      if (scene.scriptStem) section.append(textNode("p", `Runtime identity · ${scene.scriptStem}`, "story-detail-scene-note"));
      const locales = Object.values(scene.locales);
      if (locales.length > 0) {
        const commandCount = Object.entries(locales[0]?.commandCounts ?? {}).map(([command, count]) => `${command} ${count}`).join(" · ");
        section.append(textNode("p", `${locales.length} locales · ${locales[0]?.sayCount ?? 0} say blocks${commandCount ? ` · controls: ${commandCount}` : ""}`, "story-detail-scene-note"));
      }
    }
    return section;
  }

  async function renderEntryDetail(entry: CompactEntry): Promise<void> {
    const atlas = await ensureAtlas();
    const textEntry = atlas.text.entries.find((candidate) => candidate.nodeKey === entry.key);
    const scenes = atlas.scenes.filter((scene) => entry.sceneIds.includes(scene.sceneId));
    detailContentElement.replaceChildren();
    detailContentElement.append(textNode("div", `${entry.pathTitle} · ${entry.visualLabel}`, "story-detail-eyebrow"), textNode("h3", entry.key), textNode("p", `${entry.sectionLabel} · ${entry.pathTitle}`, "story-detail-path"), renderMetadata(entry, textEntry, scenes));
    const text = renderStoryText(textEntry);
    if (text) detailContentElement.append(text);
    const visuals = renderVisuals(entry.resourceIds);
    if (visuals) detailContentElement.append(visuals);
    const sceneInfo = renderSceneInfo(scenes);
    if (sceneInfo) detailContentElement.append(sceneInfo);
  }

  async function renderSceneDetail(scene: CompactScene): Promise<void> {
    const atlas = await ensureAtlas();
    const definition = atlas.scenes.find((candidate) => candidate.sceneId === scene.sceneId);
    const textEntry = definition?.scriptStem ? atlas.text.entries.find((entry) => entry.storyData === definition.scriptStem) : undefined;
    detailContentElement.replaceChildren();
    detailContentElement.append(textNode("div", `${scene.pathTitle} · ${scene.kind}`, "story-detail-eyebrow"), textNode("h3", scene.displayTitle), textNode("p", `${scene.sectionLabel} · ${scene.pathTitle}`, "story-detail-path"));
    const metadata = element("dl", "story-detail-meta");
    const row = element("div");
    row.append(textNode("dt", "Scene"), textNode("dd", scene.sceneId));
    metadata.append(row);
    detailContentElement.append(metadata);
    const text = renderStoryText(textEntry);
    if (text) detailContentElement.append(text);
    const visuals = renderVisuals(scene.resourceIds);
    if (visuals) detailContentElement.append(visuals);
    if (definition) {
      const sceneInfo = renderSceneInfo([definition]);
      if (sceneInfo) detailContentElement.append(sceneInfo);
    }
  }

  let openEntryId: string | undefined;
  let openSceneId: string | undefined;

  async function openEntry(entry: CompactEntry): Promise<void> {
    openEntryId = entry.id;
    openSceneId = undefined;
    selectedCgIndex = 0;
    detailElement.hidden = false;
    root.classList.add("has-story-detail");
    await renderEntryDetail(entry);
    root.querySelector<HTMLButtonElement>("[data-story-detail-close]")?.focus();
  }

  async function openScene(scene: CompactScene): Promise<void> {
    openEntryId = undefined;
    openSceneId = scene.sceneId;
    selectedCgIndex = 0;
    detailElement.hidden = false;
    root.classList.add("has-story-detail");
    await renderSceneDetail(scene);
    root.querySelector<HTMLButtonElement>("[data-story-detail-close]")?.focus();
  }

  function closeDetail(): void {
    detailElement.hidden = true;
    root.classList.remove("has-story-detail");
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
      const key = openEntryId ? payload.entries.find((entry) => entry.id === openEntryId)?.key : payload.scenes.find((scene) => scene.sceneId === openSceneId)?.scriptStem ?? openSceneId ?? "";
      if (key) selectedLocale[key] = locale.dataset.storyLocale;
      if (openEntryId) {
        const entry = payload.entries.find((candidate) => candidate.id === openEntryId);
        if (entry) void renderEntryDetail(entry);
      } else if (openSceneId) {
        const scene = payload.scenes.find((candidate) => candidate.sceneId === openSceneId);
        if (scene) void renderSceneDetail(scene);
      }
      return;
    }
    const cgIndex = target.closest<HTMLElement>("[data-story-cg-index]");
    if (cgIndex?.dataset.storyCgIndex) {
      selectedCgIndex = Number(cgIndex.dataset.storyCgIndex);
      if (openEntryId) {
        const entry = payload.entries.find((candidate) => candidate.id === openEntryId);
        if (entry) void renderEntryDetail(entry);
      } else if (openSceneId) {
        const scene = payload.scenes.find((candidate) => candidate.sceneId === openSceneId);
        if (scene) void renderSceneDetail(scene);
      }
      return;
    }
    if (target.closest("[data-story-cg-previous]")) {
      selectedCgIndex = Math.max(0, selectedCgIndex - 1);
      if (openEntryId) {
        const entry = payload.entries.find((candidate) => candidate.id === openEntryId);
        if (entry) void renderEntryDetail(entry);
      }
      return;
    }
    if (target.closest("[data-story-cg-next]")) {
      selectedCgIndex += 1;
      if (openEntryId) {
        const entry = payload.entries.find((candidate) => candidate.id === openEntryId);
        if (entry) void renderEntryDetail(entry);
      }
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

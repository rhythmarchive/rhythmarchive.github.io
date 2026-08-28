const explorer = document.querySelector<HTMLElement>("[data-arcaea-story-explorer]");
const launcher = document.querySelector<HTMLElement>("[data-story-view-launcher]");
const classicGallery = document.querySelector<HTMLElement>("[data-gallery-root]");

if (explorer) initializeStoryExplorer(explorer);

function initializeStoryExplorer(root: HTMLElement): void {
  const toggles = [...document.querySelectorAll<HTMLButtonElement>("[data-story-view-toggle]")];
  const sectionButtons = [...root.querySelectorAll<HTMLButtonElement>("[data-story-section]")];
  const sectionPanels = [...root.querySelectorAll<HTMLElement>("[data-story-section-panel]")];
  const pathButtons = [...root.querySelectorAll<HTMLButtonElement>("[data-story-path]")];
  const pathDetails = [...root.querySelectorAll<HTMLElement>("[data-story-path-detail]")];
  const unassignedTrigger = root.querySelector<HTMLButtonElement>("[data-story-unassigned-trigger]");
  const unassignedPanel = root.querySelector<HTMLElement>("[data-story-unassigned-panel]");
  let selectionInitialized = false;

  for (const button of toggles) button.addEventListener("click", () => setMode(root.hidden));
  for (const button of sectionButtons) {
    button.addEventListener("click", () => {
      const sectionId = button.dataset.storySection;
      const pathButton = pathButtons.find((candidate) => candidate.dataset.storyPathSection === sectionId);
      if (pathButton?.dataset.storyPath) selectPath(pathButton.dataset.storyPath, undefined, true);
      else if (sectionId) setActiveSection(sectionId);
    });
  }
  for (const button of pathButtons) {
    button.addEventListener("click", () => {
      const pathId = button.dataset.storyPath;
      if (pathId) selectPath(pathId, undefined, true);
    });
  }
  for (const detail of pathDetails) {
    for (const button of detail.querySelectorAll<HTMLButtonElement>("[data-story-entry]")) {
      button.addEventListener("click", () => {
        const key = button.dataset.storyEntryKey;
        if (key) selectEntry(detail, key, true);
      });
    }
  }
  unassignedTrigger?.addEventListener("click", () => selectUnassigned(true));

  const initialMode = new URLSearchParams(window.location.search).get("story-view") === "game";
  setMode(initialMode, false);

  function setMode(gameMode: boolean, syncUrl = true): void {
    root.hidden = !gameMode;
    if (launcher) launcher.hidden = gameMode;
    if (classicGallery) classicGallery.hidden = gameMode;
    for (const button of toggles) {
      button.setAttribute("aria-pressed", String(gameMode));
      button.textContent = gameMode ? "返回标准图库" : "开启测试版";
    }
    if (gameMode && !selectionInitialized) {
      initializeSelection();
      selectionInitialized = true;
    }
    if (syncUrl) {
      const url = new URL(window.location.href);
      if (gameMode) url.searchParams.set("story-view", "game");
      else {
        url.searchParams.delete("story-view");
        url.searchParams.delete("story-path");
        url.searchParams.delete("story-entry");
      }
      window.history.replaceState({}, "", url);
    }
  }

  function initializeSelection(): void {
    const params = new URLSearchParams(window.location.search);
    if (params.get("story-path") === "unassigned" && unassignedPanel) {
      selectUnassigned(false);
      return;
    }
    const requestedPath = params.get("story-path");
    const pathButton = requestedPath ? pathButtons.find((candidate) => candidate.dataset.storyPath === requestedPath) : pathButtons[0];
    if (!pathButton?.dataset.storyPath) return;
    selectPath(pathButton.dataset.storyPath, params.get("story-entry") ?? undefined, false);
  }

  function setActiveSection(sectionId: string): void {
    for (const button of sectionButtons) {
      const active = button.dataset.storySection === sectionId;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
    }
    for (const panel of sectionPanels) panel.hidden = panel.dataset.storySectionPanel !== sectionId;
    if (unassignedTrigger) unassignedTrigger.setAttribute("aria-selected", "false");
    if (unassignedPanel) unassignedPanel.hidden = true;
  }

  function selectPath(pathId: string, requestedEntry: string | undefined, syncUrl: boolean): void {
    const pathButton = pathButtons.find((candidate) => candidate.dataset.storyPath === pathId);
    const detail = pathDetails.find((candidate) => candidate.dataset.storyPathDetail === pathId);
    if (!pathButton || !detail) return;
    const sectionId = pathButton.dataset.storyPathSection;
    if (sectionId) setActiveSection(sectionId);
    for (const button of pathButtons) {
      const active = button.dataset.storyPath === pathId;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
    }
    for (const candidate of pathDetails) candidate.hidden = candidate !== detail;
    const entryButtons = [...detail.querySelectorAll<HTMLButtonElement>("[data-story-entry]")];
    const entryKey = requestedEntry && entryButtons.some((button) => button.dataset.storyEntryKey === requestedEntry)
      ? requestedEntry
      : entryButtons[0]?.dataset.storyEntryKey;
    if (entryKey) selectEntry(detail, entryKey, false);
    if (syncUrl) {
      const url = new URL(window.location.href);
      url.searchParams.set("story-view", "game");
      url.searchParams.set("story-path", pathId);
      if (entryKey) url.searchParams.set("story-entry", entryKey); else url.searchParams.delete("story-entry");
      window.history.replaceState({}, "", url);
    }
  }

  function selectEntry(detail: HTMLElement, entryKey: string, syncUrl: boolean): void {
    const buttons = [...detail.querySelectorAll<HTMLButtonElement>("[data-story-entry]")];
    const panels = [...detail.querySelectorAll<HTMLElement>("[data-story-entry-panel]")];
    if (!buttons.some((button) => button.dataset.storyEntryKey === entryKey)) return;
    for (const button of buttons) {
      const active = button.dataset.storyEntryKey === entryKey;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
    }
    for (const panel of panels) panel.hidden = panel.dataset.storyEntryKey !== entryKey;
    if (syncUrl) {
      const pathId = detail.dataset.storyPathDetail;
      if (!pathId) return;
      const url = new URL(window.location.href);
      url.searchParams.set("story-view", "game");
      url.searchParams.set("story-path", pathId);
      url.searchParams.set("story-entry", entryKey);
      window.history.replaceState({}, "", url);
    }
  }

  function selectUnassigned(syncUrl: boolean): void {
    if (!unassignedPanel) return;
    for (const button of sectionButtons) {
      button.classList.remove("is-active");
      button.setAttribute("aria-selected", "false");
    }
    for (const panel of sectionPanels) panel.hidden = true;
    for (const button of pathButtons) {
      button.classList.remove("is-active");
      button.setAttribute("aria-selected", "false");
    }
    for (const detail of pathDetails) detail.hidden = true;
    unassignedTrigger?.setAttribute("aria-selected", "true");
    unassignedPanel.hidden = false;
    if (syncUrl) {
      const url = new URL(window.location.href);
      url.searchParams.set("story-view", "game");
      url.searchParams.set("story-path", "unassigned");
      url.searchParams.delete("story-entry");
      window.history.replaceState({}, "", url);
    }
  }
}

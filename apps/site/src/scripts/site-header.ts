import { finishMotion, setSurfaceVisible } from "./motion";
import { motionLevel, motionStorageKey, normalizeMotion, resolveMotion } from "./motion-preference";

const root = document.documentElement;
const motionQuery = matchMedia("(prefers-reduced-motion: reduce)");
const motionHints = {
  reduced: "只保留简短的淡入淡出与状态反馈。",
  standard: "自然的过渡与轻微位移。",
  rich: "更有层次的位移、列表编排与图片过渡。",
};
const motionNames = { reduced: "精简", standard: "标准", rich: "丰富" };
const applyMotion = (value: unknown) => {
  finishMotion();
  const preference = normalizeMotion(value);
  const level = resolveMotion(preference, motionQuery.matches);
  root.dataset.motion = preference;
  root.dataset.motionLevel = level;
  for (const input of document.querySelectorAll<HTMLInputElement>("[data-motion-option]")) input.checked = input.value === preference;
  const hint = document.querySelector<HTMLElement>("[data-motion-hint]");
  if (hint) hint.textContent = preference === "system" ? `跟随系统：当前为${motionNames[level]}。${motionHints[level]}` : motionHints[level];
};
motionQuery.addEventListener("change", () => applyMotion(root.dataset.motion));
window.addEventListener("storage", (event) => {
  if (event.key === motionStorageKey || event.key === null) applyMotion(event.newValue);
  if (event.key === themeKey || event.key === null) applyTheme(event.newValue ?? "system");
});

const themeKey = "rhythm-archive-theme";
type Theme = "system" | "light" | "dark";
const themeColor = { light: "#f3f7fb", dark: "#0d1725" };
const darkQuery = matchMedia("(prefers-color-scheme: dark)");
const applyTheme = (value: string) => {
  const theme: Theme = value === "light" || value === "dark" ? value : "system";
  root.dataset.theme = theme;
  root.style.colorScheme = theme === "system" ? "light dark" : theme;
  for (const input of document.querySelectorAll<HTMLInputElement>("[data-theme-option]")) input.checked = input.value === theme;
  const resolved = theme === "system" ? darkQuery.matches ? "dark" : "light" : theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", themeColor[resolved]);
  window.dispatchEvent(new CustomEvent("rhythm-theme-change", { detail: theme }));
};
darkQuery.addEventListener("change", () => applyTheme(root.dataset.theme ?? "system"));
// A theme change is one composited cross-fade, not a per-node color transition
// across thousands of gallery elements. Reduced motion swaps immediately.
const switchTheme = (theme: string) => {
  try { localStorage.setItem(themeKey, theme); } catch { /* Session theme still works. */ }
  if (motionLevel() === "reduced" || typeof document.startViewTransition !== "function" || root.dataset.navigating) {
    applyTheme(theme);
    return;
  }
  finishMotion();
  root.dataset.themeTransition = "true";
  const transition = document.startViewTransition(() => applyTheme(theme));
  void transition.finished.finally(() => { delete root.dataset.themeTransition; });
};

const nav = document.querySelector<HTMLElement>("#site-primary-nav")!;
const toggle = document.querySelector<HTMLButtonElement>("[data-menu-toggle]")!;
const settings = document.querySelector<HTMLElement>(".site-settings")!;
const settingsToggle = settings.querySelector<HTMLButtonElement>("[data-settings-toggle]")!;
const settingsPanel = settings.querySelector<HTMLElement>("[data-settings-panel]")!;
const mobile = matchMedia("(max-width: 760px)");
root.classList.add("has-js");
const library = nav.querySelector<HTMLDetailsElement>(".nav-game-library")!;
const libraryTrigger = library.querySelector<HTMLElement>("summary")!;
const libraryPanel = library.querySelector<HTMLElement>(".nav-library-popover")!;
let libraryOpen = false;
let settingsOpen = false;
libraryPanel.hidden = true;
libraryTrigger.setAttribute("aria-expanded", "false");
const setLibraryOpen = (open: boolean) => {
  if (open === libraryOpen) return;
  libraryOpen = open;
  libraryTrigger.setAttribute("aria-expanded", String(open));
  if (open) {
    library.open = true;
    setSettingsOpen(false);
  }
  void setSurfaceVisible(libraryPanel, open).then((settled) => {
    if (settled && !open) library.open = false;
  });
};
const setSettingsOpen = (open: boolean, returnFocus = false) => {
  if (open === settingsOpen) return;
  settingsOpen = open;
  settingsToggle.setAttribute("aria-expanded", String(open));
  if (open) {
    setLibraryOpen(false);
    if (mobile.matches) setOpen(false);
  }
  void setSurfaceVisible(settingsPanel, open);
  if (open) settingsPanel.querySelector<HTMLInputElement>("input:checked")?.focus({ preventScroll: true });
  else if (returnFocus) settingsToggle.focus({ preventScroll: true });
};
nav.hidden = mobile.matches;
nav.inert = mobile.matches;
const setOpen = (open: boolean) => {
  nav.dataset.mobileOpen = String(open);
  toggle.setAttribute("aria-expanded", String(open));
  toggle.setAttribute("aria-label", open ? "关闭导航菜单" : "打开导航菜单");
  if (open) setSettingsOpen(false);
  if (mobile.matches) {
    void setSurfaceVisible(nav, open).then((settled) => {
      if (settled && !open) setLibraryOpen(false);
    });
  } else {
    // Breakpoint changes cancel a pending mobile exit before restoring desktop nav.
    void setSurfaceVisible(nav, true, "instant");
    if (!open) setLibraryOpen(false);
  }
};
libraryTrigger.addEventListener("click", (event) => {
  event.preventDefault();
  setLibraryOpen(!libraryOpen);
});
settingsToggle.addEventListener("click", () => setSettingsOpen(!settingsOpen));
settingsPanel.addEventListener("change", (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  if (input.matches("[data-theme-option]")) switchTheme(input.value);
  if (input.matches("[data-motion-option]")) {
    applyMotion(input.value);
    try { localStorage.setItem(motionStorageKey, input.value); } catch { /* Session still works. */ }
  }
});
toggle.addEventListener("click", () => {
  const open = toggle.getAttribute("aria-expanded") !== "true";
  setOpen(open);
  if (open) nav.querySelector("a")?.focus();
});
nav.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest("a")) setOpen(false);
});
document.addEventListener("pointerdown", (event) => {
  if (!(event.target instanceof Node)) return;
  if (mobile.matches && !nav.contains(event.target) && !toggle.contains(event.target)) setOpen(false);
  if (!mobile.matches && !library.contains(event.target)) setLibraryOpen(false);
  if (!settings.contains(event.target)) setSettingsOpen(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (settingsOpen) {
    setSettingsOpen(false, true);
  } else if (libraryOpen) {
    setLibraryOpen(false);
    libraryTrigger.focus();
  } else if (toggle.getAttribute("aria-expanded") === "true") {
    setOpen(false);
    toggle.focus();
  }
});
settings.addEventListener("focusout", (event) => {
  if (settingsOpen && event.relatedTarget instanceof Node && !settings.contains(event.relatedTarget)) setSettingsOpen(false);
});
mobile.addEventListener("change", () => setOpen(false));
document.addEventListener("astro:after-swap", () => {
  applyMotion(root.dataset.motion);
  setOpen(false);
  setSettingsOpen(false);
  applyTheme(root.dataset.theme ?? "system");
});
applyMotion(root.dataset.motion);
applyTheme(root.dataset.theme ?? "system");

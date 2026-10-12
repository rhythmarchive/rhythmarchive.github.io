import { setSurfaceVisible } from "./motion";

const key = "rhythm-archive-theme";
const descriptions = { system: ["跟随系统", "浅色"], light: ["浅色", "深色"], dark: ["深色", "跟随系统"] };
type Theme = keyof typeof descriptions;
const applyTheme = (value: string) => {
  const theme: Theme = value === "light" || value === "dark" ? value : "system";
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme === "system" ? "light dark" : theme;
  const toggle = document.querySelector("[data-theme-toggle]");
  const [current, next] = descriptions[theme];
  toggle?.setAttribute("data-theme-value", theme);
  toggle?.setAttribute("aria-label", `当前为${current}主题，下次切换为${next}主题`);
  toggle?.setAttribute("title", `当前为${current}主题，点击切换为${next}主题`);
  window.dispatchEvent(new CustomEvent("rhythm-theme-change", { detail: theme }));
};
const nav = document.querySelector<HTMLElement>("#site-primary-nav")!;
const toggle = document.querySelector<HTMLButtonElement>("[data-menu-toggle]")!;
const mobile = matchMedia("(max-width: 760px)");
document.documentElement.classList.add("has-js");
const library = nav.querySelector<HTMLDetailsElement>(".nav-game-library")!;
const libraryTrigger = library.querySelector<HTMLElement>("summary")!;
const libraryPanel = library.querySelector<HTMLElement>(".nav-library-popover")!;
let libraryOpen = false;
libraryPanel.hidden = true;
libraryTrigger.setAttribute("aria-expanded", "false");
const setLibraryOpen = (open: boolean) => {
  libraryOpen = open;
  libraryTrigger.setAttribute("aria-expanded", String(open));
  if (open) library.open = true;
  void setSurfaceVisible(libraryPanel, open).then((settled) => {
    if (settled && !open) library.open = false;
  });
};
libraryTrigger.addEventListener("click", (event) => {
  event.preventDefault();
  setLibraryOpen(!libraryOpen);
});
nav.hidden = mobile.matches;
nav.inert = mobile.matches;
const setOpen = (open: boolean) => {
  nav.dataset.mobileOpen = String(open);
  toggle.setAttribute("aria-expanded", String(open));
  toggle.setAttribute("aria-label", open ? "关闭导航菜单" : "打开导航菜单");
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
document.querySelector("[data-theme-toggle]")?.addEventListener("click", () => {
  const current = document.documentElement.dataset.theme;
  const next = current === "system" ? "light" : current === "light" ? "dark" : "system";
  try { localStorage.setItem(key, next); } catch { /* Session theme still works. */ }
  applyTheme(next);
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
  if (mobile.matches && event.target instanceof Node && !nav.contains(event.target) && !toggle.contains(event.target)) setOpen(false);
  if (!mobile.matches && event.target instanceof Node && !library.contains(event.target)) setLibraryOpen(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (libraryOpen) {
    setLibraryOpen(false);
    libraryTrigger.focus();
  } else if (toggle.getAttribute("aria-expanded") === "true") {
    setOpen(false);
    toggle.focus();
  }
});
mobile.addEventListener("change", () => setOpen(false));
document.addEventListener("astro:after-swap", () => {
  setOpen(false);
  applyTheme(document.documentElement.dataset.theme ?? "system");
});
applyTheme(document.documentElement.dataset.theme ?? "system");

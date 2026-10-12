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
const setOpen = (open: boolean) => {
  nav.dataset.mobileOpen = String(open);
  toggle.setAttribute("aria-expanded", String(open));
  toggle.setAttribute("aria-label", open ? "关闭导航菜单" : "打开导航菜单");
  if (!open) nav.querySelector(".nav-game-library")?.removeAttribute("open");
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
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") {
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

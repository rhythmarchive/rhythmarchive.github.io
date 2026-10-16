import type { Announcement } from "../data/announcements";
import { ANNOUNCEMENT_READ_KEY, createAnnouncementReadState } from "../lib/announcement-read-state";
import { setSurfaceVisible, revealContent } from "./motion";
import { loadStaticData } from "./static-data";

// Owned by the persistent header, just like settings and the game menu.
export function setupAnnouncements(beforeOpen: () => void, canAutoOpen: () => boolean) {
  const root = document.querySelector<HTMLDetailsElement>("[data-announcements]")!;
  const trigger = root.querySelector<HTMLElement>("summary")!;
  const panel = root.querySelector<HTMLElement>("[data-announcements-panel]")!;
  const closeButton = root.querySelector<HTMLButtonElement>("[data-announcements-close]")!;
  const dot = root.querySelector<HTMLElement>(".announcement-unread")!;
  const latest = root.dataset.latestId;
  const notice = latest ? { id: latest, notify: root.dataset.notifyLatest === "true" } : undefined;
  const stores: Storage[] = [];
  for (const name of ["localStorage", "sessionStorage"] as const) {
    try { stores.push(window[name]); } catch { /* Storage can be disabled. */ }
  }
  const read = createAnnouncementReadState(stores);
  let opened = false;
  let autoTimer: number | undefined;
  panel.hidden = true;
  panel.inert = true;
  trigger.setAttribute("aria-expanded", "false");
  const syncUnread = () => { dot.hidden = !latest || read.has(latest); };
  const close = (returnFocus = false) => {
    if (!opened) return;
    opened = false;
    trigger.setAttribute("aria-expanded", "false");
    void setSurfaceVisible(panel, false).then((settled) => { if (settled) root.open = false; });
    if (returnFocus) trigger.focus({ preventScroll: true });
  };
  const open = (automatic = false) => {
    if (opened) return;
    beforeOpen();
    opened = true;
    root.open = true;
    trigger.setAttribute("aria-expanded", "true");
    void setSurfaceVisible(panel, true);
    if (latest) read.mark(latest);
    syncUnread();
    // An automatic notice never steals keyboard focus or blocks the page.
    if (!automatic) closeButton.focus({ preventScroll: true });
    else root.querySelector<HTMLElement>("[data-announcements-status]")!.textContent = `新公告：${panel.querySelector("h2")?.textContent ?? "站内公告"}`;
  };
  const schedule = () => {
    window.clearTimeout(autoTimer);
    if (!read.shouldNotify(notice)) return;
    autoTimer = window.setTimeout(() => {
      if (document.hidden || !read.shouldNotify(notice) || !canAutoOpen() || document.querySelector("dialog[open]")) return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && (active.isContentEditable || active.matches("input, textarea, select, button"))) return;
      open(true);
    }, 900);
  };
  trigger.addEventListener("click", (event) => { event.preventDefault(); if (opened) close(); else open(); });
  closeButton.addEventListener("click", () => close(true));
  document.addEventListener("pointerdown", (event) => {
    if (event.target instanceof Node && !root.contains(event.target)) close();
  });
  root.addEventListener("focusout", (event) => {
    if (event.relatedTarget instanceof Node && !root.contains(event.relatedTarget)) close();
  });
  window.addEventListener("storage", (event) => {
    if (event.key === ANNOUNCEMENT_READ_KEY || event.key === null) syncUnread();
  });
  document.addEventListener("astro:page-load", schedule);
  document.addEventListener("astro:before-preparation", () => window.clearTimeout(autoTimer));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) schedule(); });
  document.addEventListener("focusout", schedule);

  const history = root.querySelector<HTMLDetailsElement>("[data-announcements-history]")!;
  const content = history.querySelector<HTMLElement>("[data-announcements-history-content]")!;
  let loading = false, loaded = false;
  const loadHistory = async () => {
    if (loading || loaded) return;
    loading = true;
    content.textContent = "正在获取历史公告…";
    content.setAttribute("aria-busy", "true");
    try {
      const entries = await loadStaticData<Announcement[]>(history.dataset.url!);
      content.replaceChildren();
      for (const entry of entries) {
        const article = document.createElement("article");
        article.className = "announcement-entry";
        const date = document.createElement("time");
        date.dateTime = entry.date;
        date.textContent = entry.date.replaceAll("-", ".");
        const title = document.createElement("h3");
        title.textContent = entry.title;
        article.append(date, title);
        for (const text of entry.paragraphs) {
          const paragraph = document.createElement("p");
          paragraph.textContent = text;
          article.append(paragraph);
        }
        content.append(article);
      }
      if (!entries.length) content.textContent = "暂无更早的公告";
      loaded = true;
      revealContent(content);
    } catch {
      content.textContent = "历史公告加载失败。";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "text-link";
      retry.textContent = "重试";
      retry.addEventListener("click", () => void loadHistory());
      content.append(retry);
    } finally {
      loading = false;
      content.removeAttribute("aria-busy");
    }
  };
  history.addEventListener("toggle", () => { if (history.open) void loadHistory(); });
  syncUnread();
  return { close, isOpen: () => opened };
}

import { pageSignal, onPageCleanup } from "./page-lifecycle";

// Enhance only genuinely long desktop fields. The same native select remains
// the value source, and is restored on compact/touch layouts without new data.
export function setupSearchableFilters(root: HTMLElement) {
  const entries: Array<{ select: HTMLSelectElement; trigger: HTMLButtonElement; panel: HTMLElement; sync(): void }> = [];
  if (typeof HTMLElement.prototype.showPopover !== "function") return { sync: () => undefined };
  const wide = matchMedia("(min-width: 1200px) and (hover: hover) and (pointer: fine)");
  for (const select of root.querySelectorAll<HTMLSelectElement>("[data-filter-content] select")) {
    const key = select.dataset.browseFilterSelect ?? select.dataset.galleryFacet;
    if (!key || !["pack", "version"].includes(key) || select.options.length <= 12) continue;
    const label = select.getAttribute("aria-label") ?? "筛选";
    const parent = select.parentElement!;
    const group = document.createElement("div"); group.className = parent.className;
    group.append(...parent.childNodes); parent.replaceWith(group);
    const trigger = document.createElement("button"); trigger.type = "button"; trigger.className = "searchable-filter-trigger";
    const panel = document.createElement("div"); panel.className = "searchable-filter-panel"; panel.setAttribute("popover", "auto");
    panel.id = `filter-options-${root.dataset.game}-${root.dataset.category}-${key}`;
    trigger.setAttribute("aria-haspopup", "listbox"); trigger.setAttribute("aria-controls", panel.id); trigger.setAttribute("aria-expanded", "false");
    const search = document.createElement("input"); search.type = "search"; search.className = "popover-search"; search.placeholder = `查找${label}`; search.setAttribute("aria-label", `查找${label}`); search.autocomplete = "off";
    const list = document.createElement("div"); list.className = "searchable-filter-options"; list.setAttribute("role", "listbox"); list.setAttribute("aria-label", label);
    const empty = document.createElement("p"); empty.className = "detail-note"; empty.textContent = "没有匹配的选项"; empty.hidden = true;
    const close = () => { if (panel.matches(":popover-open")) panel.hidePopover(); };
    const buttons = [...select.options].map((option) => {
      const button = document.createElement("button"); button.type = "button"; button.textContent = option.textContent; button.dataset.value = option.value; button.setAttribute("role", "option"); button.tabIndex = -1;
      button.addEventListener("click", () => {
        const changed = select.value !== option.value; select.value = option.value;
        close(); trigger.focus({ preventScroll: true });
        if (changed) select.dispatchEvent(new Event("change", { bubbles: true }));
        sync();
      });
      return button;
    });
    list.append(...buttons); panel.append(search, list, empty); group.append(trigger, panel);
    const sync = () => {
      const text = select.selectedOptions[0]?.textContent ?? "全部";
      trigger.textContent = text; trigger.setAttribute("aria-label", `${label}：${text}`);
      for (const button of buttons) button.setAttribute("aria-selected", String(button.dataset.value === select.value));
    };
    const filter = () => {
      const query = search.value.trim().toLocaleLowerCase("zh-CN");
      for (const button of buttons) button.hidden = Boolean(query) && !button.textContent?.toLocaleLowerCase("zh-CN").includes(query);
      empty.hidden = buttons.some((button) => !button.hidden);
    };
    const open = () => {
      if (!wide.matches) return;
      search.value = ""; filter(); sync();
      const rect = trigger.getBoundingClientRect();
      const below = innerHeight - rect.bottom - 12, above = rect.top - 12;
      const useAbove = below < 250 && above > below;
      panel.style.width = `${Math.min(Math.max(rect.width, 260), innerWidth - 24)}px`;
      panel.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - 284))}px`;
      panel.style.maxHeight = `${Math.max(80, Math.min(360, useAbove ? above : below))}px`;
      panel.style.top = useAbove ? "auto" : `${rect.bottom + 6}px`;
      panel.style.bottom = useAbove ? `${innerHeight - rect.top + 6}px` : "auto";
      panel.showPopover(); search.focus({ preventScroll: true });
    };
    trigger.addEventListener("click", () => panel.matches(":popover-open") ? close() : open());
    trigger.addEventListener("keydown", (event) => { if (event.key === "ArrowDown") { event.preventDefault(); open(); buttons.find((button) => button.dataset.value === select.value)?.focus(); } });
    panel.addEventListener("toggle", () => trigger.setAttribute("aria-expanded", String(panel.matches(":popover-open"))));
    search.addEventListener("input", filter);
    panel.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); close(); trigger.focus({ preventScroll: true }); return; }
      const visible = buttons.filter((button) => !button.hidden);
      let index = visible.findIndex((button) => button === document.activeElement);
      if (event.key === "ArrowDown") index = Math.min(visible.length - 1, index + 1);
      else if (event.key === "ArrowUp") index = index < 0 ? visible.length - 1 : Math.max(0, index - 1);
      else if (event.key === "Home" && document.activeElement !== search) index = 0;
      else if (event.key === "End" && document.activeElement !== search) index = visible.length - 1;
      else return;
      event.preventDefault(); visible[index]?.focus();
    });
    panel.addEventListener("focusout", (event) => { if (event.relatedTarget instanceof Node && !panel.contains(event.relatedTarget) && event.relatedTarget !== trigger) close(); });
    entries.push({ select, trigger, panel, sync });
  }
  const place = () => {
    for (const entry of entries) {
      const focused = entry.panel.contains(document.activeElement) || document.activeElement === entry.trigger || document.activeElement === entry.select;
      if (entry.panel.matches(":popover-open")) entry.panel.hidePopover();
      entry.select.hidden = wide.matches; entry.trigger.hidden = !wide.matches; entry.sync();
      if (focused) (wide.matches ? entry.trigger : entry.select).focus({ preventScroll: true });
    }
  };
  place(); wide.addEventListener("change", place, { signal: pageSignal() });
  onPageCleanup(() => { for (const entry of entries) if (entry.panel.matches(":popover-open")) entry.panel.hidePopover(); });
  return { sync: () => { for (const entry of entries) entry.sync(); } };
}

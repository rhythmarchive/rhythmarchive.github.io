import { onPageCleanup, pageSignal } from "./page-lifecycle";
import { setSurfaceVisible } from "./motion";

// One set of controls moves between sidebar and native modal. Only applied
// conditions affect the list/URL; closing a compact panel discards its draft.
export function setupGalleryFilters(root: HTMLElement, options: { apply(): void; reset(): void; count(): number; restore(): void; beforeOpen?(): void }) {
  const content = root.querySelector<HTMLElement>("[data-filter-content]");
  const inline = root.querySelector<HTMLElement>("[data-filters-inline]");
  const dialog = root.querySelector<HTMLDialogElement>("[data-filters-dialog]");
  const mount = root.querySelector<HTMLElement>("[data-filter-mount]");
  const trigger = root.querySelector<HTMLButtonElement>("[data-filter-open]");
  const apply = root.querySelector<HTMLButtonElement>("[data-filter-apply]");
  if (!content || !inline || !dialog || !mount || !trigger || !apply) return { draft: () => false, preview: () => undefined };
  const wide = matchMedia("(min-width: 1200px)");
  const signal = pageSignal();
  let closing = false;
  let applying = false;
  let snapshot: Array<{ node: HTMLInputElement | HTMLSelectElement; value: string; checked: boolean }> = [];
  let overflow = "";
  const preview = () => { apply.textContent = `查看 ${options.count().toLocaleString("zh-CN")} 项结果`; };
  const restore = () => {
    for (const { node, value, checked } of snapshot) { node.value = value; if (node instanceof HTMLInputElement) node.checked = checked; }
    options.restore();
  };
  const close = async (committed = false) => {
    if (!dialog.open || closing) return;
    closing = true;
    if (!committed) restore();
    const settled = await setSurfaceVisible(dialog, false, "fade");
    if (!settled || signal.aborted) return;
    dialog.close(); dialog.hidden = false; closing = false;
    document.documentElement.style.overflow = overflow;
    if (wide.matches) content.querySelector<HTMLElement>("select, input, button")?.focus({ preventScroll: true });
    else trigger.focus({ preventScroll: true });
  };
  const place = () => {
    if (dialog.open) { if (!closing) restore(); void setSurfaceVisible(dialog, false, "instant"); dialog.close(); dialog.hidden = false; closing = false; document.documentElement.style.overflow = overflow; }
    (wide.matches ? inline : mount).append(content);
    if (root.contains(document.activeElement) && (document.activeElement === trigger || content.contains(document.activeElement))) {
      (wide.matches ? content.querySelector<HTMLElement>("select, input, button") : trigger)?.focus({ preventScroll: true });
    }
  };
  place();
  wide.addEventListener("change", place, { signal });
  trigger.addEventListener("click", () => {
    if (dialog.open || closing) return;
    options.beforeOpen?.();
    snapshot = [...content.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select")].map((node) => ({ node, value: node.value, checked: node instanceof HTMLInputElement && node.checked }));
    overflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    dialog.showModal(); void setSurfaceVisible(dialog, true, "fade");
    preview(); dialog.querySelector<HTMLButtonElement>("[data-filter-close]")?.focus({ preventScroll: true });
  });
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); void close(); });
  dialog.querySelector("[data-filter-close]")?.addEventListener("click", () => void close());
  let outsidePress = false;
  const outside = (event: MouseEvent) => { const r = dialog.getBoundingClientRect(); return event.target === dialog && (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom); };
  dialog.addEventListener("pointerdown", (event) => { outsidePress = outside(event); });
  dialog.addEventListener("click", (event) => { if (outsidePress && outside(event)) void close(); outsidePress = false; });
  apply.addEventListener("click", () => { applying = true; options.apply(); applying = false; void close(true); });
  root.querySelector("[data-filter-clear]")?.addEventListener("click", () => options.reset());
  root.querySelector("[data-filter-draft-clear]")?.addEventListener("click", () => options.reset());
  onPageCleanup(() => { if (dialog.open) document.documentElement.style.overflow = overflow; void setSurfaceVisible(dialog, false, "instant"); dialog.close(); });
  return { draft: () => dialog.open && !closing && !applying, preview };
}

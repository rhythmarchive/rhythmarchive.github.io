// Capture the rendered list, never reconstruct its order from catalog data.
const CONTEXT_KEY = "rhythm-archive-list-contexts";
const CONTEXT_PARAM = "list";
const RETURN_PARAM = "list-return";

type ListPosition = { url: string; key: string; count: number; scrollY: number };
type ListContext = { position: ListPosition; items: Array<{ id: string; href: string }> };

function readContexts(): Record<string, ListContext> {
  try {
    const value = JSON.parse(sessionStorage.getItem(CONTEXT_KEY) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }
  catch { return {}; }
}

function currentUrl(): string {
  const url = new URL(location.href);
  url.searchParams.delete(RETURN_PARAM);
  return url.pathname + url.search + url.hash;
}

export function renderedListItems(grid: HTMLElement): ListContext["items"] {
  return [...grid.querySelectorAll<HTMLAnchorElement>(".resource-card-link")]
    .filter((anchor) => !anchor.closest("[hidden]") && anchor.getClientRects().length > 0)
    .map((anchor) => ({ anchor, card: anchor.closest<HTMLElement>("[data-resource-card]")! }))
    // Layout offsets ignore the card's hover transform, which must not change
    // which item comes first within a row. CSS columns can differ from DOM order.
    .sort((left, right) => left.card.offsetTop - right.card.offsetTop || left.card.offsetLeft - right.card.offsetLeft)
    .map(({ anchor, card }) => {
      const href = new URL(anchor.href);
      href.searchParams.delete(CONTEXT_PARAM);
      return { id: card.dataset.resourceId ?? "", href: href.pathname + href.search + href.hash };
    });
}

export function setupListNavigation(grid: HTMLElement, key: string) {
  const url = new URL(location.href);
  const returnToken = url.searchParams.get(RETURN_PARAM);
  const saved = returnToken ? readContexts()[returnToken]?.position : history.state?.resourceListPosition as ListPosition | undefined;
  const position = saved?.url === currentUrl() && saved.key === key ? saved : undefined;
  if (returnToken) {
    url.searchParams.delete(RETURN_PARAM);
    history.replaceState({ ...history.state, resourceListPosition: position }, "", url);
  }
  const capture = (event: MouseEvent): void => {
    if (event.defaultPrevented || (event.button !== 0 && event.button !== 1)) return;
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>(".resource-card-link") : null;
    if (!link || !grid.contains(link)) return;
    const items = renderedListItems(grid);
    if (!items.length) return;
    const position: ListPosition = { url: currentUrl(), key, count: items.length, scrollY: window.scrollY };
    try {
      const contexts = readContexts();
      const token = crypto.randomUUID();
      // Bound per-tab snapshots while retaining earlier lists in browser history.
      const retained = Object.entries(contexts).slice(-19);
      sessionStorage.setItem(CONTEXT_KEY, JSON.stringify(Object.fromEntries([...retained, [token, { position, items }]])));
      history.replaceState({ ...history.state, resourceListPosition: position }, "");
      const href = new URL(link.href);
      href.searchParams.set(CONTEXT_PARAM, token);
      link.href = href.href;
    } catch { /* Navigation still works when browser storage is unavailable. */ }
  };
  grid.addEventListener("click", capture);
  grid.addEventListener("auxclick", capture);
  let restored = false;
  return {
    visibleCount: (fallback: number) => Math.max(fallback, position?.count ?? 0),
    restore: () => {
      if (!position || restored) return;
      restored = true;
      requestAnimationFrame(() => window.scrollTo(0, position.scrollY));
    },
  };
}

export function setupDetailNavigation(root: HTMLElement): void {
  const token = new URL(location.href).searchParams.get(CONTEXT_PARAM);
  const context = token ? readContexts()[token] : undefined;
  if (!Array.isArray(context?.items) || !context.position || typeof context.position.url !== "string") return;
  const index = context.items.findIndex((item) => item.id === root.dataset.resourceId);
  const nav = root.querySelector<HTMLElement>("[data-detail-navigation]");
  if (!context || index < 0 || !nav || !token) return;
  const links = [nav.querySelector<HTMLAnchorElement>("[data-detail-previous]"), nav.querySelector<HTMLAnchorElement>("[data-detail-next]")];
  for (const [offset, link] of links.entries()) {
    if (!link) continue;
    const item = context.items[index + (offset === 0 ? -1 : 1)];
    if (!item) {
      link.removeAttribute("href");
      link.setAttribute("aria-disabled", "true");
      continue;
    }
    const href = new URL(item.href, location.origin);
    if (href.origin !== location.origin) return;
    href.searchParams.set(CONTEXT_PARAM, token);
    link.href = href.href;
  }
  const back = nav.querySelector<HTMLAnchorElement>("[data-detail-return]");
  if (back) {
    const href = new URL(context.position.url, location.origin);
    if (href.origin !== location.origin) return;
    href.searchParams.set(RETURN_PARAM, token);
    back.href = href.href;
  }
  const count = nav.querySelector<HTMLElement>("[data-detail-position]");
  if (count) count.textContent = `${index + 1} / ${context.items.length}`;
  nav.hidden = false;
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat) return;
    if (event.target instanceof Element && event.target.closest('input, textarea, select, button, [role="tab"], [contenteditable]:not([contenteditable="false"])')) return;
    if (root.querySelector("[data-detail-lightbox]:not([hidden])")) return;
    const link = event.key === "ArrowLeft" ? links[0] : event.key === "ArrowRight" ? links[1] : null;
    if (!link?.hasAttribute("href")) return;
    event.preventDefault();
    // Replace consecutive detail entries so browser Back returns to the list.
    location.replace(link.href);
  });
  for (const link of links) link?.addEventListener("click", (event) => {
    if (!link.hasAttribute("href") || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    location.replace(link.href);
  });
}

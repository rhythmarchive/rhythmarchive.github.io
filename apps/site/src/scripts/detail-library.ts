import { createLocalLibrary, LIBRARY_KEY } from "../lib/local-library";

export function setupDetailLibrary(root: HTMLElement): void {
  const button = root.querySelector<HTMLButtonElement>("[data-favorite-toggle]");
  const status = root.querySelector<HTMLElement>("[data-library-status]");
  const { resourceId: id, game, category, resourceTitle: title } = root.dataset;
  if (!button || !status || !id || !game || !category || !title) return;
  const library = createLocalLibrary();
  const entry = { id, game, category, title: title.slice(0, 240) };
  const sync = (warning = "") => {
    const state = library.read();
    const favorite = state.data.favorites.some((item) => item.id === id);
    button.hidden = false;
    button.disabled = !state.writable;
    button.setAttribute("aria-pressed", String(favorite));
    button.textContent = favorite ? "已收藏" : "收藏";
    status.textContent = warning || state.warning;
  };
  sync(library.visit(entry));
  button.addEventListener("click", () => {
    const wasFavorite = button.getAttribute("aria-pressed") === "true";
    const warning = library.toggleFavorite(entry);
    sync(warning || (wasFavorite ? "已取消收藏" : "已收藏"));
  });
  window.addEventListener("storage", (event) => { if (event.key === LIBRARY_KEY || event.key === null) sync(); });
  window.addEventListener("pageshow", (event) => { if (event.persisted) sync(library.visit(entry)); });
}

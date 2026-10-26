import { loadStaticData } from "./static-data";
import { onPageLoad, onPageCleanup, pageSignal } from "./page-lifecycle";
import { sitePath } from "../lib/url";
import { GAME_CONFIG } from "../lib/game-config";
import { matchSearchSuggestions } from "../lib/search-suggestions";
import type { PublicSearchSuggestions } from "../lib/types";
import { setSurfaceVisible } from "./motion";

const searchDataUrl = "data/search-suggestions-v1.json";

onPageLoad(() => {
  for (const form of document.querySelectorAll<HTMLFormElement>("[data-search-entry]")) {
    setupSearchEntry(form);
  }
});

function setupSearchEntry(form: HTMLFormElement): void {
  const root = form.closest<HTMLElement>("[data-search-entry-root]")!;
  const input = form.querySelector<HTMLInputElement>("input[name=q]")!;
  const field = form.querySelector<HTMLInputElement>("[data-search-field]")!;
  const panel = root.querySelector<HTMLElement>("[data-search-suggestions]")!;
  const groups = root.querySelector<HTMLElement>("[data-search-suggestion-groups]")!;
  const status = root.querySelector<HTMLElement>("[data-search-suggestion-status]")!;
  const songList = root.querySelector<HTMLElement>("[data-search-songs]")!;
  const artistList = root.querySelector<HTMLElement>("[data-search-artists]")!;
  const identity = root.querySelector<HTMLElement>("[data-search-identity]")!;
  const identityLabel = root.querySelector<HTMLElement>("[data-search-identity-label]")!;
  const clear = root.querySelector<HTMLButtonElement>("[data-search-identity-clear]")!;
  const signal = pageSignal();
  let token = 0;
  let timer: number | undefined;
  let composing = false;
  let failed = false;
  let active = -1;
  let choices: Array<{ name: string; field?: "artist" }> = [];
  let selectedQuery: string | undefined;
  const params = new URLSearchParams(location.search);
  if (params.has("q")) input.value = params.get("q")!;
  field.disabled = params.get("field") !== "artist" || !input.value.trim();
  if (!field.disabled) selectedQuery = input.value;

  function syncIdentity(): void {
    identity.hidden = field.disabled;
    identityLabel.textContent = field.disabled ? "" : `曲师：${input.value}`;
  }
  function setActive(index: number): void {
    active = index;
    const options = [...panel.querySelectorAll<HTMLElement>('[role="option"]')];
    for (const [i, option] of options.entries()) option.setAttribute("aria-selected", String(i === active));
    if (active >= 0 && options[active]) {
      input.setAttribute("aria-activedescendant", options[active]!.id);
      options[active]!.scrollIntoView({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  }
  function close(): void {
    ++token;
    window.clearTimeout(timer);
    input.setAttribute("aria-expanded", "false");
    setActive(-1);
    void setSurfaceVisible(panel, false, "fade");
  }
  function choose(index: number): void {
    const choice = choices[index];
    if (!choice) return;
    input.value = choice.name;
    field.disabled = choice.field !== "artist";
    selectedQuery = field.disabled ? undefined : choice.name;
    syncIdentity();
    close();
    form.requestSubmit();
  }
  function fillList(target: HTMLElement, items: Array<{ name: string; context: string; field?: "artist" }>, emptyText: string): void {
    const nodes = items.map(item => {
      const index = choices.push({ name: item.name, ...(item.field ? { field: item.field } : {}) }) - 1;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "search-suggestion";
      button.id = `${input.id}-suggestion-${index}`;
      button.dataset.suggestionIndex = String(index);
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", "false");
      button.tabIndex = -1;
      const name = document.createElement("span");
      name.textContent = item.name;
      const context = document.createElement("small");
      context.textContent = item.context;
      button.append(name, context);
      return button;
    });
    if (nodes.length) target.replaceChildren(...nodes);
    else {
      const empty = document.createElement("p");
      empty.textContent = emptyText;
      target.replaceChildren(empty);
    }
  }
  async function update(): Promise<void> {
    const query = input.value.trim();
    if (!query || composing || signal.aborted || document.activeElement !== input) { close(); return; }
    const current = ++token;
    choices = [];
    setActive(-1);
    if (failed) return;
    status.hidden = false;
    status.textContent = "加载联想…";
    groups.hidden = true;
    input.setAttribute("aria-expanded", "true");
    void setSurfaceVisible(panel, true, "fade");
    try {
      const data = await loadStaticData<PublicSearchSuggestions>(resolveSitePath(searchDataUrl));
      if (signal.aborted || current !== token || document.activeElement !== input) return;
      if (data.schemaVersion !== 1 || !Array.isArray(data.songs) || !Array.isArray(data.artists)) throw new Error("Invalid suggestions");
      const game = document.querySelector<HTMLSelectElement>("[data-search-game]")?.value ?? "";
      const matches = matchSearchSuggestions(data, query, game);
      choices = [];
      fillList(songList, matches.songs.map(song => ({ name: song.title, context: [GAME_CONFIG[song.game].displayName, song.artist].filter(Boolean).join(" · ") })), "暂无匹配曲名");
      fillList(artistList, matches.artists.map(artist => ({ name: artist.name, context: artist.games.map(game => GAME_CONFIG[game].displayName).join(" · "), field: "artist" })), "暂无匹配曲师");
      status.hidden = true;
      groups.hidden = false;
    } catch {
      if (signal.aborted || current !== token) return;
      failed = true;
      status.textContent = "联想暂不可用，可直接搜索。";
    }
  }
  const schedule = (): void => {
    ++token;
    window.clearTimeout(timer);
    if (!composing) timer = window.setTimeout(() => void update(), 100);
  };
  input.addEventListener("focus", () => { failed = false; void update(); }, { signal });
  input.addEventListener("input", () => {
    setActive(-1);
    if (input.value !== selectedQuery) { field.disabled = true; selectedQuery = undefined; syncIdentity(); }
    if (!input.value.trim()) close(); else schedule();
  }, { signal });
  input.addEventListener("compositionstart", () => { composing = true; close(); }, { signal });
  input.addEventListener("compositionend", () => { composing = false; schedule(); }, { signal });
  input.addEventListener("keydown", event => {
    if (composing || event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") { event.preventDefault(); close(); return; }
    if (event.key === "Tab") { close(); return; }
    if (event.key === "Enter" && input.getAttribute("aria-expanded") === "true" && active >= 0) { event.preventDefault(); choose(active); return; }
    if (!["ArrowDown", "ArrowUp"].includes(event.key) || !input.value.trim()) return;
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    const move = () => { if (choices.length && input.getAttribute("aria-expanded") === "true") setActive(active < 0 ? step > 0 ? 0 : choices.length - 1 : (active + step + choices.length) % choices.length); };
    if (input.getAttribute("aria-expanded") !== "true") void update().then(move); else move();
  }, { signal });
  panel.addEventListener("pointerdown", event => event.preventDefault(), { signal });
  panel.addEventListener("click", event => {
    const option = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-suggestion-index]") : null;
    if (option) choose(Number(option.dataset.suggestionIndex));
  }, { signal });
  form.addEventListener("submit", event => { if (composing) event.preventDefault(); else close(); }, { signal });
  root.addEventListener("focusout", event => { if (!(event.relatedTarget instanceof Node) || !root.contains(event.relatedTarget)) close(); }, { signal });
  document.addEventListener("pointerdown", event => { if (event.target instanceof Node && !root.contains(event.target)) close(); }, { signal });
  clear.addEventListener("click", () => {
    field.disabled = true;
    selectedQuery = undefined;
    syncIdentity();
    form.requestSubmit();
  }, { signal });
  onPageCleanup(() => { ++token; window.clearTimeout(timer); });
  syncIdentity();
}

function resolveSitePath(path: string): string {
  const base = document.documentElement.dataset.basePath ?? document.querySelector<HTMLElement>("[data-site-base]")?.dataset.siteBaseValue ?? "/";
  return sitePath(path, base);
}

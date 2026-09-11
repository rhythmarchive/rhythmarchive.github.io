import { publicContentVersion } from "../lib/game-index";
import type { PublicUpdate, PublicUpdateItem } from "../lib/types";

const dataElement = document.querySelector<HTMLScriptElement>("#updates-data");
const list = document.querySelector<HTMLElement>("[data-updates-list]");
const gameSelect = document.querySelector<HTMLSelectElement>("[data-update-game]");
const typeSelect = document.querySelector<HTMLSelectElement>("[data-update-type]");
const clearButton = document.querySelector<HTMLButtonElement>("[data-update-clear]");
const emptyClearButton = document.querySelector<HTMLButtonElement>("[data-update-empty-clear]");
const noResults = document.querySelector<HTMLElement>("[data-update-no-results]");
const status = document.querySelector<HTMLElement>("[data-update-status]");
const moreButton = document.querySelector<HTMLButtonElement>("[data-update-more]");
if (!dataElement || !list || !gameSelect || !typeSelect || !clearButton || !emptyClearButton || !noResults || !status || !moreButton) throw new Error("Update page controls are missing.");

const updates = JSON.parse(dataElement.textContent || "[]") as PublicUpdate[];
let visibleLimit = 20;
const basePath = document.documentElement.dataset.basePath || "/";
const sitePath = (pathname: string): string => {
  const normalizedBase = basePath === "/" ? "" : basePath.replace(/\/+$/u, "");
  return (normalizedBase + pathname).replace(/\/{2,}/gu, "/") || "/";
};
const escapeHtml = (value: string): string => value.replace(/[&<>"']/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character] ?? character));
const imageHtml = (item: PublicUpdateItem): string => {
  if (!item.image) return "<span class=\"update-preview-placeholder\">图片暂不可用</span>";
  const fallback = item.fallback ? " data-fallback-src=\"" + escapeHtml(item.fallback.url) + "\"" : "";
  return "<img src=\"" + escapeHtml(item.image.url) + "\"" + fallback + " alt=\"" + escapeHtml(item.displayTitle) + "\" width=\"" + (item.image.width ?? "") + "\" height=\"" + (item.image.height ?? "") + "\" loading=\"lazy\" decoding=\"async\">";
};
const summaryText = (count: number): string => "更新 " + count + " 项";
const dateText = (value: string): string => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
const renderCard = (update: PublicUpdate, items: PublicUpdateItem[]): string => {
  const itemCount = items.length;
  const previews = items.slice(0, 4);
  const detailUrl = sitePath("/updates/" + encodeURIComponent(update.id) + "/");
  const contentVersion = publicContentVersion(update.contentVersion);
  const version = contentVersion ? "收录 " + escapeHtml(contentVersion) + " · " : "";
  const visibleSuffix = items.length < update.totalItemCount ? " · 当前可见 " + items.length + " 项" : "";
  const summaryHtml = "<span>更新 " + itemCount + " 项</span>";
  const previewHtml = previews.map((item) => {
    return "<a class=\"update-preview\" href=\"" + sitePath(item.route) + "\" title=\"" + escapeHtml(item.displayTitle) + "\">" + imageHtml(item) + "<span class=\"update-preview-caption\"><strong>" + escapeHtml(item.categoryLabel) + "</strong></span></a>";
  }).join("");
  return "<article class=\"update-card\" data-update-card data-update-id=\"" + escapeHtml(update.id) + "\" data-game=\"" + escapeHtml(update.game) + "\">"
    + "<div class=\"update-card-date\"><time datetime=\"" + escapeHtml(update.publishedAt) + "\">" + dateText(update.publishedAt) + "</time><span>" + escapeHtml(update.displayName) + "</span></div>"
    + "<div class=\"update-card-body\"><div class=\"update-card-heading\"><div><h3><a href=\"" + detailUrl + "\">" + escapeHtml(update.displayName) + " 更新</a></h3><p class=\"update-card-meta\">" + version + escapeHtml(summaryText(itemCount)) + visibleSuffix + "</p></div><a class=\"update-card-link\" href=\"" + detailUrl + "\">查看本次更新</a></div>"
    + "<div class=\"update-card-summary\" aria-label=\"更新类型\">" + summaryHtml + "</div><div class=\"update-card-previews\">" + previewHtml + "</div></div></article>";
};
const setTypeOptions = (game: string, selected: string): void => {
  const options = [...new Map(updates.filter((update) => !game || update.game === game).flatMap((update) => update.categories).map((category) => [category.slug, category])).values()].sort((left, right) => left.label.localeCompare(right.label, "zh-CN"));
  typeSelect.innerHTML = "<option value=\"\">全部类型</option>" + options.map((option) => "<option value=\"" + escapeHtml(option.slug) + "\">" + escapeHtml(option.label) + "</option>").join("");
  typeSelect.value = options.some((option) => option.slug === selected) ? selected : "";
};
const render = (syncUrl = true): void => {
  const game = gameSelect.value;
  const type = typeSelect.value;
  const filtered = updates.filter((update) => (!game || update.game === game) && update.items.some((item) => !type || item.category === type));
  list.innerHTML = filtered.slice(0, visibleLimit).map((update) => renderCard(update, update.items.filter((item) => !type || item.category === type))).join("");
  moreButton.hidden = filtered.length <= visibleLimit;
  noResults.hidden = filtered.length > 0;
  status.textContent = filtered.length > 0 ? "共 " + filtered.length + " 批更新" : "没有找到这类更新";
  clearButton.hidden = !game && !type;
  if (syncUrl) {
    const params = new URLSearchParams();
    if (game) params.set("game", game);
    if (type) params.set("type", type);
    const query = params.toString();
    history.replaceState(null, "", query ? location.pathname + "?" + query : location.pathname);
  }
};
const initialParams = new URLSearchParams(location.search);
const initialGame = initialParams.get("game") || "";
const initialType = initialParams.get("type") || "";
gameSelect.value = [...gameSelect.options].some((option) => option.value === initialGame) ? initialGame : "";
setTypeOptions(gameSelect.value, initialType);
gameSelect.addEventListener("change", () => { visibleLimit = 20; const currentType = typeSelect.value; setTypeOptions(gameSelect.value, currentType); render(); });
typeSelect.addEventListener("change", () => { visibleLimit = 20; render(); });
clearButton.addEventListener("click", () => { visibleLimit = 20; gameSelect.value = ""; setTypeOptions("", ""); render(); });
emptyClearButton.addEventListener("click", () => { visibleLimit = 20; gameSelect.value = ""; setTypeOptions("", ""); render(); });
moreButton.addEventListener("click", () => { visibleLimit += 20; render(false); });
render(false);

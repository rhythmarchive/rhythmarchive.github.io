export {};
const grid = document.querySelector<HTMLElement>("[data-update-detail-grid]");
const status = document.querySelector<HTMLElement>("[data-update-detail-status]");
if (grid && status) {
  const items = [...grid.querySelectorAll<HTMLElement>("[data-update-detail-item]")];
  const type = new URLSearchParams(location.search).get("type") || "";
  const valid = new Set(items.map((item) => item.dataset.updateDetailCategory || ""));
  const activeType = valid.has(type) ? type : "";
  const categoryLinks = [...document.querySelectorAll<HTMLAnchorElement>(".update-detail-categories a")];
  for (const link of categoryLinks) {
    const linkType = new URL(link.href).searchParams.get("type") || "";
    link.classList.toggle("is-active", linkType === activeType);
  }
  for (const item of items) item.hidden = Boolean(activeType && item.dataset.updateDetailCategory !== activeType);
  const visibleCount = items.filter((item) => !item.hidden).length;
  status.textContent = visibleCount + " 项资源";
}

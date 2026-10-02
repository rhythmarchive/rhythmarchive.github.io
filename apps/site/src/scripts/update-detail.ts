import { createBatchTray, downloadSelectedBatchFromManifest } from "./batch-tray";
import { setupListNavigation } from "./list-navigation";
import type { BatchResource } from "../lib/batch";
const root = document.querySelector<HTMLElement>("[data-update-detail-root]");
const grid = document.querySelector<HTMLElement>("[data-update-detail-grid]");
const status = document.querySelector<HTMLElement>("[data-update-detail-status]");
if (root && grid && status) {
  const navigation = setupListNavigation(grid, "update-" + root.dataset.updateId);
  const cards = JSON.parse(root.querySelector("[data-update-batch-cards]")?.textContent ?? "[]") as Array<BatchResource & { manifestUrl: string }>;
  const resources = new Map(cards.map((card) => [card.resourceId, card]));
  createBatchTray({
    root,
    grid,
    getResource: (id) => resources.get(id),
    onDownload: (preferUpscaled, selectedIds, setStatus) => downloadSelectedBatchFromManifest({
      manifestUrl: [...new Set(selectedIds.map((id) => resources.get(id)!.manifestUrl))],
      selectedIds,
      getResource: (id) => resources.get(id),
      preferUpscaled,
      filename: "rhythm-archive-update-" + root.dataset.updateId + ".zip",
      setStatus,
    }),
  });
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
  navigation.restore();
}

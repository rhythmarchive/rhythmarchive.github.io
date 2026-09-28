export function showGalleryLoadError(root: HTMLElement, count: HTMLElement): void {
  count.textContent = "完整列表加载失败";
  const notice = root.querySelector<HTMLElement>("[data-gallery-load-error]");
  if (!notice) return;
  notice.hidden = false;
  notice.querySelector<HTMLButtonElement>("[data-gallery-retry]")?.addEventListener("click", () => {
    window.location.reload();
  }, { once: true });
}

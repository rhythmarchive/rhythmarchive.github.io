const grid = document.querySelector<HTMLElement>("[data-games-grid]");
const controls = [...document.querySelectorAll<HTMLButtonElement>("[data-games-sort]")];

if (grid && controls.length > 0) {
  const gameGrid = grid;
  const cards = [...grid.querySelectorAll<HTMLElement>("[data-game-card]")];
  const requestedSort = new URL(window.location.href).searchParams.get("sort");
  applySort(requestedSort === "name" ? "name" : "updated");

  for (const control of controls) {
    control.addEventListener("click", () => {
      const sort = control.dataset.gamesSort === "name" ? "name" : "updated";
      applySort(sort);
      const url = new URL(window.location.href);
      if (sort === "name") url.searchParams.set("sort", "name");
      else url.searchParams.delete("sort");
      window.history.replaceState({}, "", url);
    });
  }

  function applySort(sort: "updated" | "name"): void {
    const ordered = [...cards].sort((left, right) => {
      if (sort === "name") return (left.dataset.gameName ?? "").localeCompare(right.dataset.gameName ?? "", "zh-CN");
      const rightUpdated = timestamp(right.dataset.gameUpdatedAt);
      const leftUpdated = timestamp(left.dataset.gameUpdatedAt);
      return rightUpdated - leftUpdated || (left.dataset.gameName ?? "").localeCompare(right.dataset.gameName ?? "", "zh-CN");
    });
    for (const card of ordered) gameGrid.append(card);
    for (const control of controls) control.setAttribute("aria-pressed", String(control.dataset.gamesSort === sort));
  }
}

function timestamp(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : -1;
}

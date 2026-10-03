import { PREVIEW_MEDIA_ORIGIN } from "../lib/phigros-media-preview";

const root = document.querySelector<HTMLElement>("[data-cg-viewer]");
if (root?.dataset.cgScene === "deduction") {
  const layer = root.querySelector<HTMLImageElement>("[data-cg-layer]")!;
  const base = root.querySelector<HTMLImageElement>("[data-cg-base]")!;
  const frames = root.querySelector<HTMLElement>("[data-cg-frames]")!;
  const background = root.querySelector<HTMLInputElement>("[data-cg-background]")!;
  const backgroundLabel = root.querySelector<HTMLElement>("[data-cg-background-label]")!;
  const download = root.querySelector<HTMLAnchorElement>("[data-cg-download]")!;
  const states = [["1", "站台"], ["2", "门"], ["3.1", "人物"], ["3.2", "光球"], ["3.3", "微光"], ["3.4", "扩散"], ["3.5", "消散 I"], ["3.6", "消散 II"], ["3bg", "背景"]] as const;
  let selected = 0;
  const buttons = states.map((state, index) => {
    const button = document.createElement("button");
    button.type = "button"; button.textContent = state[1];
    button.addEventListener("click", () => { selected = index; render(); });
    return button;
  });
  function render() {
    const state = states[selected]!;
    layer.src = `${PREVIEW_MEDIA_ORIGIN}/cg/${state[0]}.png`;
    layer.alt = `推演 · ${state[1]}`;
    const layered = state[0].startsWith("3.");
    backgroundLabel.hidden = !layered;
    base.hidden = !layered || !background.checked;
    if (!base.hidden) base.src = `${PREVIEW_MEDIA_ORIGIN}/cg/3bg.png`;
    else base.removeAttribute("src");
    download.href = `${PREVIEW_MEDIA_ORIGIN}/cg/${state[0]}.png?download=1`;
    buttons.forEach((button, index) => button.setAttribute("aria-pressed", String(index === selected)));
  }
  frames.append(...buttons);
  background.addEventListener("change", render);
  render();
}

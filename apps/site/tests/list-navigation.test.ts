import assert from "node:assert/strict";
import test from "node:test";
import { renderedListItems } from "../src/scripts/list-navigation";

function anchor(id: string, top: number, left: number, hidden = false, displayed = true) {
  const card = { dataset: { resourceId: id }, offsetTop: top, offsetLeft: left };
  return {
    href: `https://example.test/archive/r/${id}/?variant=cover&list=old`,
    closest: (selector: string) => selector === "[hidden]" ? hidden ? {} : null : card,
    getClientRects: () => displayed ? [{}] : [],
    // Hover shifts the visible rectangle; layout order must stay unchanged.
    getBoundingClientRect: () => ({ top: top - 2, left }),
  };
}

test("detail order follows rendered rows even when CSS columns differ from DOM order", () => {
  const anchors = [anchor("A", 0, 0), anchor("D", 200, 0), anchor("B", 0, 200), anchor("E", 200, 200), anchor("C", 0, 400), anchor("F", 200, 400)];
  const grid = { querySelectorAll: () => anchors } as unknown as HTMLElement;
  const items = renderedListItems(grid);
  assert.deepEqual(items.map((item) => item.id), ["A", "B", "C", "D", "E", "F"]);
  assert.equal(items[2]?.href, "/archive/r/C/?variant=cover");
  assert.equal(items[4]?.id, "E");
});

test("snapshot excludes hidden categories and contains only currently rendered items", () => {
  const grid = { querySelectorAll: () => [anchor("other-category", 0, 0, true), anchor("hidden-list", 0, 0, false, false), anchor("shown", 20, 20)] } as unknown as HTMLElement;
  assert.deepEqual(renderedListItems(grid).map((item) => item.id), ["shown"]);
  assert.deepEqual(renderedListItems({ querySelectorAll: () => [] } as unknown as HTMLElement), []);
});

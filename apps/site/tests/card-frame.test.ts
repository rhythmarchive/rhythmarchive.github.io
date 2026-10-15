import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { CARD_CROP_TOLERANCE, cardFrameFor, cardRatioStyle, frameFill } from "../src/lib/card-frame.js";

const siteRoot = path.resolve(process.cwd(), "apps", "site");
const size = (width: number, height: number) => ({ width, height });

test("card frames follow uniform lists and stay balanced for mixed ones", () => {
  assert.equal(cardFrameFor(Array.from({ length: 20 }, () => size(320, 320))), "square");
  assert.equal(cardFrameFor(Array.from({ length: 20 }, () => size(512, 270))), "wide");
  assert.equal(cardFrameFor(Array.from({ length: 20 }, () => size(300, 400))), "tall");
  // Square jackets mixed with wide jackets: 4:3 keeps both mostly filled instead of slivers.
  assert.equal(cardFrameFor([...Array.from({ length: 13 }, () => size(320, 320)), ...Array.from({ length: 7 }, () => size(512, 270))]), "landscape");
  assert.equal(cardFrameFor([]), "landscape");
  assert.equal(cardFrameFor([null, size(0, 10)], "square"), "square");
});

test("frame fill allows only the bounded crop", () => {
  assert.equal(frameFill(1, 1), 1);
  assert.equal(frameFill(1.1, 1), 1);
  assert.ok(Math.abs(frameFill(2, 1) - CARD_CROP_TOLERANCE / 2) < 1e-9);
  assert.equal(cardRatioStyle(size(512, 256)), "--r:2");
  assert.equal(cardRatioStyle(null), undefined);
  // CSS mirrors the tolerance; keep the two in step.
  const styles = fs.readFileSync(path.join(siteRoot, "src", "styles", "global.css"), "utf8");
  assert.equal(styles.split(`var(--card-frame-r)) * ${CARD_CROP_TOLERANCE})`).length - 1, 2);
});

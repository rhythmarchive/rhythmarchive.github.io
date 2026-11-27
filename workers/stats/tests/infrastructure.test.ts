import test from "node:test";
import assert from "node:assert/strict";
import { estimateStandardR2Cost, metric } from "../src/infrastructure.js";
const now = Date.parse("2026-11-30T23:55:00Z"),
  target = now + 300000;
test("thresholds and forecast are independent; null is not zero", () => {
  for (const [value, risk] of [
    [null, "未知"],
    [0, "正常"],
    [70, "关注"],
    [85, "警告"],
    [95, "严重警告"],
  ] as const)
    assert.equal(metric("", "", "", value, 100, now, target, null).risk, risk);
  assert.equal(
    metric("", "", "", 5, 100, now, now + 86400000, 200).early,
    true,
  );
});
test("a Standard cost estimate needs both inputs and uses published free allowances", () => {
  const ops = { a: 1_000_000, b: 10_000_000, all: 11_000_000, unclassified: 0 };
  assert.equal(estimateStandardR2Cost({ ops, gbMonth: null }), null);
  assert.equal(estimateStandardR2Cost({ ops, gbMonth: 10 }), 0);
  assert.equal(estimateStandardR2Cost({ ops: { ...ops, a: ops.a + 1, b: ops.b + 1 }, gbMonth: 10.01 }), 4.875);
});

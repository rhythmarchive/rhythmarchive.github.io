import test from "node:test";
import assert from "node:assert/strict";
import { grants, metric } from "../src/infrastructure.js";
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
test("fresh bounded evidence at UTC year/month/day transitions only", () => {
  const base = {
    day: "2026-11-30",
    observedAt: new Date(now).toISOString(),
    ops: { all: 100 },
    bucket: { bytes: 12345 },
  } as Parameters<typeof grants>[2];
  assert.deepEqual(grants(now, target, base, undefined), {
    month: "2026-12",
    day: "2026-12-01",
    reads: 20000,
    ros: 0,
  });
  assert.equal(grants(now + 86400000, target, base, undefined).reads, 0);
  assert.equal(grants(now, target, undefined, undefined).reads, 0);
});

import type { RosReport } from "../src/daily-operations.js";
test("ROS uses provider counter timestamp and refuses stale, expired or high-usage instances", () => {
  const sample = {
    state: "ok",
    data: {
      truncatedInstances: false,
      instances: [
        {
          status: "running",
          periodStart: String(now / 1000 - 86400),
          nextResetAt: String(now / 1000 + 86400),
          expiresAt: String(now / 1000 + 86400),
          definition: `更新时间原值：${now / 1000}`,
          transferUsedBytes: 1000,
          planBandwidth: 100,
        },
      ],
    },
  } as RosReport;
  assert.equal(grants(now, target, undefined, sample).ros, 8000000);
  assert.equal(grants(now + 7200000, target, undefined, sample).ros, 0);
  sample.data!.instances[0]!.transferUsedBytes = 99 * 2 ** 30;
  assert.equal(grants(now, target, undefined, sample).ros, 0);
});

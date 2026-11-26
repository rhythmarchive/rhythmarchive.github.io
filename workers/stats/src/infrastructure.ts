import type { D1Database } from "./core.js";
import type { OperationsEnv, RosReport } from "./daily-operations.js";
const DAY = 86400000,
  iso = (t: number) => new Date(t).toISOString(),
  valid = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0;
const stamp = (v: string | null | undefined) =>
  v && /^\d{10}$/.test(v) ? Number(v) * 1000 : Date.parse(v ?? "");
const nextMonth = (t: number) =>
  Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth() + 1, 1);
type Sample = {
  day: string;
  observedAt: string;
  workers: number | null;
  d1: { reads: number; writes: number } | null;
  d1Bytes: number | null;
  ops: { a: number; b: number; all: number; unclassified: number } | null;
  bucket: { bytes: number; at: string } | null;
  gbMonth: number | null;
  lastInvoice: { amount: number; currency: string; at: string } | null;
  errors: Record<string, string>;
};
async function samples(db?: D1Database): Promise<Sample[]> {
  try {
    return (
      (
        await db
          ?.prepare(
            "SELECT payload FROM infrastructure_samples ORDER BY day DESC LIMIT 2",
          )
          .all<{ payload: string }>()
      )?.results ?? []
    ).map((r) => JSON.parse(r.payload));
  } catch {
    return [];
  }
}
export function metric(
  label: string,
  unit: string,
  scope: string,
  value: unknown,
  total: number | null,
  at: number,
  reset: number | null,
  rate: number | null = null,
) {
  const used = valid(value) ? value : null,
    pct = used !== null && total ? (100 * used) / total : null,
    remaining =
      used !== null && total !== null ? Math.max(0, total - used) : null;
  const eta =
      remaining !== null && rate !== null && rate > 0
        ? at + (DAY * remaining) / rate
        : null,
    early = eta !== null && reset !== null && eta < reset;
  return {
    label,
    unit,
    scope,
    used,
    total,
    remaining,
    percent: pct,
    asOf: iso(at),
    resetAt: reset === null ? null : iso(reset),
    perDay: rate,
    estimatedExhaustionAt: eta !== null && eta < 8.64e15 ? iso(eta) : null,
    risk:
      pct === null
        ? "未知"
        : pct >= 95
          ? "严重警告"
          : pct >= 85 || early
            ? "警告"
            : pct >= 70
              ? "关注"
              : "正常",
    early,
  };
}
function rosData(r: RosReport | undefined) {
  const x = r?.data?.instances[0];
  if (
    !x ||
    r?.state !== "ok" ||
    r.data?.truncatedInstances ||
    r.data?.instances.length !== 1
  )
    return null;
  const at = stamp(x.definition?.match(/更新时间原值：(\d{10})(?!\d)/)?.[1]),
    start = stamp(x.periodStart),
    reset = stamp(x.nextResetAt),
    expires = stamp(x.expiresAt);
  if (
    x.status !== "running" ||
    !valid(x.planBandwidth) ||
    !x.planBandwidth ||
    !valid(x.transferUsedBytes) ||
    !(start <= at && at < reset)
  )
    return null;
  return {
    at,
    start,
    reset,
    expires,
    used: x.transferUsedBytes,
    total: x.planBandwidth * 2 ** 30,
  };
}
export function grants(
  now: number,
  target: number,
  s: Sample | undefined,
  r: RosReport | undefined,
) {
  const x = rosData(r),
    ops = s?.ops,
    age = now - Date.parse(s?.observedAt ?? ""),
    day = iso(target).slice(0, 10);
  // A missing/stale observation never authorizes a grant. Unknown action classes count against BOTH limits.
  const reads =
    ops &&
    valid(ops.all) &&
    age >= 0 &&
    age < 2 * 3600000 &&
    s?.day === s?.observedAt.slice(0, 10) &&
    ops.all < 700000 &&
    s?.bucket &&
    valid(s.bucket.bytes) &&
    s.bucket.bytes < 8e9
      ? 20000
      : 0;
  const ros =
    x &&
    now >= x.at &&
    now - x.at < 2 * 3600000 &&
    target < x.reset &&
    target < x.expires &&
    x.used < x.total * 0.85
      ? Math.floor(
          Math.min(
            8e6,
            (x.total * 0.85 - x.used) /
              Math.max(1, Math.ceil((x.reset - target) / DAY)),
          ),
        )
      : 0;
  return { reads, ros, day, month: day.slice(0, 7) };
}
export async function maintain(env: OperationsEnv, now: number) {
  const db = env.DOWNLOAD_BUDGET;
  if (!db) return;
  const d = new Date(now),
    m = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (m !== 1435 && m !== 5 && m !== 25) return;
  const target = m === 1435 ? now + 5 * 60000 : now,
    [ss, r] = await Promise.all([
      samples(db),
      env.OPERATOR_ROS?.snapshot().catch(() => undefined),
    ]);
  const g = grants(now, target, ss[0], r);
  for (const [amount, table, key, period] of [
    [g.ros, "ros_fallback_budget", "utc_day", g.day],
    [g.reads, "download_read_budget", "utc_month", g.month],
  ] as const) {
    if (amount > 0)
      await db
        .prepare(`INSERT OR IGNORE INTO ${table}(${key},remaining) VALUES(?,?)`)
        .bind(period, amount)
        .run();
  }
}
export async function infrastructure(
  db: D1Database | undefined,
  now: number,
  r: RosReport,
  reads: number | null,
) {
  const [s, prev] = await samples(db),
    t = Date.parse(s?.observedAt ?? "") || now,
    fresh = now - t >= 0 && now - t < 26 * 3600000,
    a = fresh ? s : undefined,
    utc = iso(now),
    end = Date.parse(iso(t).slice(0, 10) + "T00:00:00Z") + DAY,
    start = end - DAY;
  const trend = (v: unknown, p: unknown, same = true) =>
    valid(v) && valid(p) && prev && same && t > Date.parse(prev.observedAt)
      ? ((v - p) * DAY) / (t - Date.parse(prev.observedAt))
      : null;
  const monthly = a?.day.slice(0, 7) === prev?.day.slice(0, 7),
    x = rosData(r),
    live = x && now >= x.at && now - x.at < 2 * 3600000 ? x : null;
  const row = await db
    ?.prepare("SELECT remaining FROM ros_fallback_budget WHERE utc_day=?")
    .bind(utc.slice(0, 10))
    .first<{ remaining: number }>()
    .catch(() => null);
  // The rollover algorithm grants variable ROS headroom; record the exact immutable original allowance via trigger.
  async function allocation(kind: string, period: string) {
    return (
      (
        await db
          ?.prepare(
            "SELECT allocated FROM quota_grants WHERE kind=? AND period=?",
          )
          .bind(kind, period)
          .first<{ allocated: number }>()
          .catch(() => null)
      )?.allocated ?? null
    );
  }
  const [ra, fa] = await Promise.all([
    allocation("r2", utc.slice(0, 7)),
    allocation("ros", utc.slice(0, 10)),
  ]);
  const metrics = [
    metric(
      "Workers 请求",
      "次",
      "账户 Analytics 延迟",
      a?.workers,
      100000,
      t,
      end,
      valid(a?.workers) && t > start ? (a.workers * DAY) / (t - start) : null,
    ),
    ...(["reads", "writes"] as const).map((k) =>
      metric(
        k === "reads" ? "D1 读取" : "D1 写入",
        "行",
        "账户 Analytics 延迟",
        a?.d1?.[k],
        k === "reads" ? 5e6 : 1e5,
        t,
        end,
        a?.d1 && t > start ? (a.d1[k] * DAY) / (t - start) : null,
      ),
    ),
    metric(
      "D1 存储",
      "B",
      "账户数据库合计",
      a?.d1Bytes,
      5e9,
      t,
      null,
      trend(a?.d1Bytes, prev?.d1Bytes),
    ),
    ...(["a", "b"] as const).map((k) =>
      metric(
        "R2 Class " + k.toUpperCase(),
        "次",
        "账户 Analytics 已分类估算；未分类另列",
        a?.ops?.[k],
        k === "a" ? 1e6 : 10e6,
        t,
        nextMonth(t),
        trend(a?.ops?.[k], prev?.ops?.[k], monthly),
      ),
    ),
    metric(
      "R2 存储消耗",
      "GB-month",
      "账户每日分桶峰值估算，非账单",
      a?.gbMonth,
      10,
      t,
      nextMonth(t),
      trend(a?.gbMonth, prev?.gbMonth, monthly),
    ),
    metric(
      "R2 项目容量",
      "B",
      "单桶 Analytics 延迟，含元数据",
      a?.bucket?.bytes,
      8e9,
      Date.parse(a?.bucket?.at ?? "") || t,
      null,
      trend(a?.bucket?.bytes, prev?.bucket?.bytes),
    ),
    metric(
      "ROS 套餐流量",
      "B",
      "单实例官方累计（延迟）",
      live?.used,
      x?.total ?? null,
      x?.at ?? now,
      x?.reset ?? null,
      live && live.at > live.start
        ? (live.used * DAY) / (live.at - live.start)
        : null,
    ),
    metric(
      "R2 网关读取",
      "次",
      "应用月预算",
      reads !== null && ra !== null ? ra - reads : null,
      ra,
      now,
      nextMonth(now),
      ra !== null &&
        reads !== null &&
        now > Date.parse(utc.slice(0, 7) + "-01T00:00:00Z")
        ? ((ra - reads) * DAY) /
            (now - Date.parse(utc.slice(0, 7) + "-01T00:00:00Z"))
        : null,
    ),
    metric(
      "ROS 自动回退",
      "B",
      "应用日预算",
      row && fa !== null ? fa - row.remaining : null,
      fa,
      now,
      Math.floor(now / DAY) * DAY + DAY,
      row && fa !== null && now % DAY > 0
        ? ((fa - row.remaining) * DAY) / (now % DAY)
        : null,
    ),
  ];
  const advice = metrics
    .filter((v) => v.early || ["关注", "警告", "严重警告"].includes(v.risk))
    .map((v) => `${v.label}：${v.risk}${v.early ? "，预计重置前耗尽" : ""}`);
  if (
    metrics.some(
      (v) => v.label === "R2 网关读取" && (v.early || v.risk === "严重警告"),
    ) ||
    !reads ||
    reads < 1000
  )
    advice.push("Arcaea APK 可能无法下载：读取预算未确认或余量不足");
  if (!row?.remaining) advice.push("ROS 自动回退未获可用预算");
  if (!a?.ops) advice.push("账户 R2 操作用量未核实，不发放新月预算");
  return {
    metrics,
    advice,
    collectionErrors: s?.errors ?? { snapshot: "未采集" },
    unclassifiedR2Operations: a?.ops?.unclassified ?? null,
    confirmedInvoice: a?.lastInvoice ?? null,
    gatewayRemaining: reads,
    fallbackRemaining: row?.remaining ?? null,
  };
}
export function formatInfra(v: Awaited<ReturnType<typeof infrastructure>>) {
  const fmt = (n: number | null) =>
    n === null
      ? "未知"
      : n.toLocaleString("zh-CN", { maximumFractionDigits: 3 });
  return [
    "",
    "基础设施额度与费用（采样时刻与重置时间均为 UTC）",
    ...v.metrics.map(
      (m) =>
        `${m.label}：${fmt(m.used)} / ${fmt(m.total)} ${m.unit}（${fmt(m.percent)}%，${m.risk}）；剩余 ${fmt(m.remaining)}；采样 ${m.asOf}；重置 ${m.resetAt ?? "不适用或未知"}；日均变化 ${fmt(m.perDay)}；预计耗尽 ${m.estimatedExhaustionAt ?? "未知"}。${m.scope}`,
    ),
    ...v.advice,
    `最近已核实账项：${v.confirmedInvoice ? JSON.stringify(v.confirmedInvoice) : "未知"}。应用预算不是账户账单硬限制。`,
  ];
}

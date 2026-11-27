import type { D1Database } from "./core.js";
import type { RosReport } from "./daily-operations.js";
const DAY = 86400000,
  iso = (t: number) => new Date(t).toISOString(),
  valid = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0;
const nonNegativeInteger = (value: unknown): value is number => valid(value) && Number.isSafeInteger(value);
const stamp = (v: string | null | undefined) =>
  v && /^\d{10}$/.test(v) ? Number(v) * 1000 : Date.parse(v ?? "");
const nextMonth = (t: number) =>
  Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth() + 1, 1);
type GatewayRequests = { total: number; limited: number; clientErrors: number; serverErrors: number };
type Sample = {
  day: string;
  observedAt: string;
  workers: number | null;
  d1: { reads: number; writes: number } | null;
  d1Bytes: number | null;
  d1StorageBasis?: string;
  ops: { a: number; b: number; all: number; unclassified: number } | null;
  bucket: { bytes: number; at: string } | null;
  gbMonth: number | null;
  r2BucketOps?: { reads: number; writes: number; total: number; failed: number; unknown: number } | null;
  r2DownlinkBytes?: number | null;
  gatewayDownlinkBytes?: number | null;
  gatewayRequests?: GatewayRequests | null;
  lastInvoice: { amount: number; currency: string; at: string } | null;
  errors: Record<string, string>;
};
// Only the dedicated production collector can submit observations. This endpoint does not grant budget.
export async function saveSample(db: D1Database, body: string, now: number) {
  const s = JSON.parse(body) as Sample,
    age = now - Date.parse(s?.observedAt);
  if (
    !(age >= -60000 && age < 1800000) ||
    s.day !== s.observedAt.slice(0, 10) ||
    !s.errors ||
    typeof s.errors !== "object"
  )
    return false;
  if (
    s.ops !== null &&
    (!s.ops ||
      ![s.ops.all, s.ops.a, s.ops.b, s.ops.unclassified].every(
        (x) => valid(x) && Number.isSafeInteger(x),
      ) ||
      s.ops.a + s.ops.b + s.ops.unclassified !== s.ops.all)
  )
    return false;
  if (
    s.bucket !== null &&
    (!s.bucket ||
      !valid(s.bucket.bytes) ||
      !Number.isFinite(Date.parse(s.bucket.at)))
  )
    return false;
  if (s.r2BucketOps && (![s.r2BucketOps.reads, s.r2BucketOps.writes, s.r2BucketOps.total, s.r2BucketOps.failed, s.r2BucketOps.unknown].every(nonNegativeInteger) ||
    s.r2BucketOps.reads + s.r2BucketOps.writes > s.r2BucketOps.total ||
    s.r2BucketOps.failed + s.r2BucketOps.unknown > s.r2BucketOps.total)) return false;
  if ([s.r2DownlinkBytes, s.gatewayDownlinkBytes].some(value => value != null && !nonNegativeInteger(value))) return false;
  const gateway = s.gatewayRequests;
  if (gateway != null && (![gateway.total, gateway.limited, gateway.clientErrors, gateway.serverErrors].every(nonNegativeInteger) ||
    gateway.limited + gateway.clientErrors + gateway.serverErrors > gateway.total)) return false;
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS infrastructure_samples(day TEXT PRIMARY KEY,payload TEXT NOT NULL) WITHOUT ROWID",
  ).run();
  await db.batch([
    db
      .prepare(
        "INSERT INTO infrastructure_samples VALUES(?,?) ON CONFLICT(day) DO UPDATE SET payload=excluded.payload WHERE json_extract(excluded.payload,'$.observedAt')>json_extract(infrastructure_samples.payload,'$.observedAt')",
      )
      .bind(s.day, body),
    db.prepare(
      "DELETE FROM infrastructure_samples WHERE day < date('now','-35 days')",
    ),
  ]);
  return true;
}
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
    reset = stamp(x.nextResetAt);
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
    used: x.transferUsedBytes,
    total: x.planBandwidth * 2 ** 30,
  };
}
export function estimateStandardR2Cost(sample?: Pick<Sample, 'ops' | 'gbMonth'>): number | null {
  if (!sample?.ops || !valid(sample.gbMonth)) return null;
  const billed = (used: number, included: number, unit = 1) => Math.ceil(Math.max(0, used - included) / unit);
  const cents = 450 * billed(sample.ops.a, 1e6, 1e6) + 36 * billed(sample.ops.b, 1e7, 1e6) + 1.5 * billed(sample.gbMonth, 10);
  return cents / 100;
}

export async function infrastructure(
  db: D1Database | undefined,
  now: number,
  r: RosReport,
) {
  const [s, prev] = await samples(db),
    t = Date.parse(s?.observedAt ?? "") || now,
    fresh = now - t >= 0 && now - t < 26 * 3600000,
    a = fresh ? s : undefined,
    end = Date.parse(iso(t).slice(0, 10) + "T00:00:00Z") + DAY,
    start = end - DAY;
  const trend = (v: unknown, p: unknown, same = true) =>
    valid(v) && valid(p) && prev && same && t > Date.parse(prev.observedAt)
      ? ((v - p) * DAY) / (t - Date.parse(prev.observedAt))
      : null;
  const monthly = a?.day.slice(0, 7) === prev?.day.slice(0, 7),
    x = rosData(r),
    live = x && now + 60000 >= x.at && now - x.at < 2 * 3600000 ? x : null;
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
      a?.d1StorageBasis === "observed-peaks"
        ? "账户 Analytics 近24小时有采样的库峰值合计；估算，非完整清单"
        : "账户数据库清单合计",
      a?.d1Bytes,
      5e9,
      t,
      null,
      trend(
        a?.d1Bytes,
        prev?.d1Bytes,
        a?.d1StorageBasis === prev?.d1StorageBasis,
      ),
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
      null,
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
    metric("R2 桶读取操作", "次", "项目桶 Analytics，UTC 当日累计", a?.r2BucketOps?.reads, null, t, end),
    metric("R2 桶写入操作", "次", "项目桶 Analytics，UTC 当日累计", a?.r2BucketOps?.writes, null, t, end),
  ];
  const advice = metrics
    .filter((v) => v.early || ["关注", "警告", "严重警告"].includes(v.risk))
    .map((v) => `${v.label}：${v.risk}${v.early ? "，预计重置前耗尽" : ""}`);
  const gateway = a?.gatewayRequests;
  if (gateway?.limited) advice.push("下载网关出现 429 响应，请核对限速是否影响播放或续传。");
  if (gateway && gateway.serverErrors >= 20 && gateway.serverErrors / gateway.total >= 0.05) {
    advice.push("下载网关 5xx 响应比例偏高，请检查下载服务。");
  }
  const estimatedCostUsd = estimateStandardR2Cost(a);
  if (estimatedCostUsd !== null && estimatedCostUsd > 0) advice.push("按 Standard 费率估算，本月已有超出免费额度的用量，请核对账单。");
  const ops = a?.r2BucketOps;
  if (ops && ops.failed >= 20 && ops.failed / ops.total >= 0.05) {
    advice.push("R2 项目桶失败请求比例偏高，请核对网关日志与请求来源。");
  }
  return {
    metrics,
    advice,
    collectionErrors: s?.errors ?? { snapshot: "未采集" },
    unclassifiedR2Operations: a?.ops?.unclassified ?? null,
    confirmedInvoice: a?.lastInvoice ?? null,
    r2: { estimatedCostUsd, ops: ops ?? null, downlinkBytes: a?.r2DownlinkBytes ?? null,
      gatewayDownlinkBytes: a?.gatewayDownlinkBytes ?? null, gatewayRequests: gateway ?? null },
  };
}
export function formatInfra(v: Awaited<ReturnType<typeof infrastructure>>) {
  const fmt = (n: number | null | undefined) =>
    n == null
      ? "未知"
      : n.toLocaleString("zh-CN", { maximumFractionDigits: 3 });
  return [
    "",
    "基础设施用量与费用（UTC，额度仅供观察）",
    ...v.metrics.map(
      (m) =>
        `${m.label}：${fmt(m.used)} ${m.unit}${m.total === null ? "" : ` / ${fmt(m.total)}（${fmt(m.percent)}%，${m.risk}）`}。采样 ${m.asOf}。${m.scope}${m.resetAt ? `。重置 ${m.resetAt}` : ""}`,
    ),
    `R2 项目桶下行（Cloudflare 带宽采样）：${fmt(v.r2?.downlinkBytes)} B。下载网关下行（含边缘缓存）：${fmt(v.r2?.gatewayDownlinkBytes)} B。`,
    `R2 项目桶请求：${fmt(v.r2?.ops?.total)} 次，失败 ${fmt(v.r2?.ops?.failed)} 次，状态未分类 ${fmt(v.r2?.ops?.unknown)} 次。`,
    `下载网关请求：${fmt(v.r2?.gatewayRequests?.total)} 次，429 ${fmt(v.r2?.gatewayRequests?.limited)} 次，其他 4xx ${fmt(v.r2?.gatewayRequests?.clientErrors)} 次，5xx ${fmt(v.r2?.gatewayRequests?.serverErrors)} 次。`,
    `R2 直接下行费用：0 USD。`,
    `R2 月内已分类用量按 Standard 费率折算：${fmt(v.r2?.estimatedCostUsd)} USD。未分类操作：${fmt(v.unclassifiedR2Operations)} 次。估算不含税费及其他存储类型。`,
    `最近已核实账项：${v.confirmedInvoice ? JSON.stringify(v.confirmedInvoice) : "未知"}。`,
    ...Object.entries(v.collectionErrors ?? {}).map(([source, reason]) => `采集状态 ${source}：${reason}`),
    ...v.advice,
  ];
}

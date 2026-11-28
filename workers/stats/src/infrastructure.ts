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
type GatewayWindow = {
  day: string; start: string; endExclusive: string; source: "zone-graphql" | "account-sql" | null;
  statusCounts: Record<string, number> | null; hourlyServerErrors: Record<string, number> | null;
};
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
  gatewayWindow?: GatewayWindow;
  gatewayOutcomes?: Record<string, { requests: number; errors: number }> | null;
  gbMonthCoverage?: { observedDays: number; elapsedDays: number; observedGBMonth: number };
  lastInvoice: { amount: number; currency: string; at: string; scope?: "account" } | null;
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
  const window = s.gatewayWindow;
  if (window) {
    const start = Date.parse(window.day + "T00:00:00+08:00");
    if (!Number.isFinite(start) || window.start !== iso(start) || window.endExclusive !== iso(start + DAY) ||
      start + DAY > Date.parse(s.observedAt) || ![null, "zone-graphql", "account-sql"].includes(window.source) ||
      Boolean(window.statusCounts) !== Boolean(gateway)) return false;
    const statuses = Object.entries(window.statusCounts ?? {});
    if (statuses.some(([code, count]) => !/^(?:0|[1-5]\d{2})$/.test(code) || !nonNegativeInteger(count)) ||
      (gateway && statuses.reduce((sum, [, count]) => sum + count, 0) !== gateway.total)) return false;
    if (Object.entries(window.hourlyServerErrors ?? {}).some(([hour, count]) =>
      !(Date.parse(hour) >= start && Date.parse(hour) < start + DAY) || !nonNegativeInteger(count))) return false;
  }
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
type RosPoint = NonNullable<ReturnType<typeof rosData>>;
// First production R2/ROS rollout without the read budget (Pages run 45970363210).
const R2_ROLLOUT = Date.parse("2026-11-27T09:08:16Z");

export function rosForecast(current: RosPoint, history: RosPoint[]) {
  const { at, start, reset, used, total } = current;
  const cyclePerDay = at > start ? (used * DAY) / (at - start) : null;
  const remaining = Math.max(0, total - used);
  const allowedPerDay = (remaining * DAY) / (reset - at);
  const candidates = history.filter(p => p.start === start && p.reset === reset && p.total === total &&
    p.at >= R2_ROLLOUT && p.at >= at - 7 * DAY && p.at < at).sort((a, b) => b.at - a.at);
  let oldest = current, intervals = 0;
  for (const point of candidates) {
    const duration = oldest.at - point.at;
    if (duration < DAY / 2) continue;
    if (duration > DAY * 2 || point.used > oldest.used) break;
    oldest = point;
    intervals++;
  }
  const spanDays = (at - oldest.at) / DAY;
  const recentPerDay = intervals ? (used - oldest.used) / spanDays : null;
  const confidence = intervals >= 2 && spanDays >= 2 ? "recent" : "insufficient";
  return { confidence, intervals, spanDays, cyclePerDay, allowedPerDay, recentPerDay,
    selectedPerDay: confidence === "recent" ? recentPerDay : cyclePerDay };
}

async function readRosHistory(db: D1Database | undefined, reportDay: string | undefined): Promise<RosPoint[]> {
  if (!db || !reportDay) return [];
  try {
    const rows = await db.prepare(`SELECT json_extract(snapshot_json,'$.ros') AS ros FROM daily_operations_reports
      WHERE report_date>=date(?,'-7 days') AND report_date<? AND snapshot_json<>''
      ORDER BY report_date DESC LIMIT 7`).bind(reportDay, reportDay).all<{ ros: string | null }>();
    return (rows.results ?? []).flatMap(row => {
      try { const point = rosData(row.ros ? JSON.parse(row.ros) : undefined); return point ? [point] : []; }
      catch { return []; }
    });
  } catch { return []; }
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
  reportDay?: string,
  statsDb?: D1Database,
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
  const forecast = live ? rosForecast(live, await readRosHistory(statsDb, reportDay)) : null;
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
      forecast?.selectedPerDay ?? null,
    ),
    metric("R2 桶读取操作", "次", "项目桶 Analytics，UTC 当日累计", a?.r2BucketOps?.reads, null, t, end),
    metric("R2 桶写入操作", "次", "项目桶 Analytics，UTC 当日累计", a?.r2BucketOps?.writes, null, t, end),
  ];
  const advice = metrics
    .filter((v) => v.early || ["关注", "警告", "严重警告"].includes(v.risk))
    .map((v) => `${v.label}：${v.risk}${v.early ? "，预计重置前耗尽" : ""}`);
  const gatewaySample = [s, prev].find(sample => sample?.gatewayWindow?.day === reportDay && sample?.gatewayWindow);
  const gateway = gatewaySample?.gatewayRequests ?? (!s?.gatewayWindow ? a?.gatewayRequests : null);
  const collectionErrors = { ...(s?.errors ?? { snapshot: "未采集" }) };
  if (s?.gatewayWindow && s !== gatewaySample) {
    for (const key of ["gateway", "gatewayHourly", "gatewayOutcomes"]) {
      delete collectionErrors[key];
      if (gatewaySample?.errors[key]) collectionErrors[key] = gatewaySample.errors[key];
    }
  }
  if (forecast?.confidence === "insufficient") advice.push("ROS 迁移后有效样本不足，暂按本周期均速提示风险。");
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
    collectionErrors,
    unclassifiedR2Operations: a?.ops?.unclassified ?? null,
    confirmedInvoice: a?.lastInvoice ?? null,
    rosForecast: forecast,
    collection: { observedAt: s?.observedAt ?? null, state: !s ? "missing" : fresh ? "fresh" : "stale",
      utcDay: s?.day ?? null },
    r2: { estimatedCostUsd, ops: ops ?? null, downlinkBytes: a?.r2DownlinkBytes ?? null,
      gbMonthCoverage: a?.gbMonthCoverage ?? null,
      gatewayDownlinkBytes: gatewaySample?.gatewayDownlinkBytes ?? (!s?.gatewayWindow ? a?.gatewayDownlinkBytes ?? null : null),
      gatewayRequests: gateway ?? null,
      gatewayWindow: gatewaySample?.gatewayWindow ?? null, gatewayObservedAt: gatewaySample?.observedAt ?? null,
      gatewayOutcomes: gatewaySample?.gatewayOutcomes ?? null },
  };
}
export function formatInfra(v: Awaited<ReturnType<typeof infrastructure>>) {
  const fmt = (n: number | null | undefined) =>
    n == null
      ? "未知"
      : n.toLocaleString("zh-CN", { maximumFractionDigits: 3 });
  const gib = (bytes: number | null) => bytes === null ? "未知" : fmt(bytes / 2 ** 30);
  return [
    "",
    "基础设施用量与费用",
    `Cloudflare 额度按 UTC 统计。采集时间 ${v.collection?.observedAt ?? "未知"}，状态 ${v.collection?.state === "fresh" ? "近期采集" : v.collection?.state === "stale" ? "采集过期" : "未采集"}。上游指标可能有延迟。`,
    ...v.metrics.map(
      (m) =>
        `${m.label}：${fmt(m.used)} ${m.unit}${m.total === null ? "" : ` / ${fmt(m.total)}（${fmt(m.percent)}%，${m.risk}）`}。采样 ${m.asOf}。${m.scope}${m.resetAt ? `。重置 ${m.resetAt}` : ""}`,
    ),
    `R2 项目桶下行（Cloudflare 带宽采样）：${fmt(v.r2?.downlinkBytes)} B。下载网关下行（含边缘缓存）：${fmt(v.r2?.gatewayDownlinkBytes)} B。`,
    `R2 项目桶请求：${fmt(v.r2?.ops?.total)} 次，失败 ${fmt(v.r2?.ops?.failed)} 次，状态未分类 ${fmt(v.r2?.ops?.unknown)} 次。`,
    `下载网关请求：${fmt(v.r2?.gatewayRequests?.total)} 次，429 ${fmt(v.r2?.gatewayRequests?.limited)} 次，其他 4xx ${fmt(v.r2?.gatewayRequests?.clientErrors)} 次，5xx ${fmt(v.r2?.gatewayRequests?.serverErrors)} 次。`,
    ...(v.r2?.gatewayWindow ? [
      `下载网关统计区间：${v.r2.gatewayWindow.start} 至 ${v.r2.gatewayWindow.endExclusive}（对应北京时间运营日，左闭右开）。采集 ${v.r2.gatewayObservedAt}，来源 ${v.r2.gatewayWindow.source ?? "未知"}。`,
      `分状态码：${v.r2.gatewayWindow.statusCounts ? JSON.stringify(v.r2.gatewayWindow.statusCounts) : "未知"}。分小时 5xx（UTC）：${v.r2.gatewayWindow.hourlyServerErrors ? JSON.stringify(v.r2.gatewayWindow.hourlyServerErrors) : "未知"}。`,
      `Worker 执行结果（与边缘 HTTP 状态分别统计）：${v.r2.gatewayOutcomes ? JSON.stringify(v.r2.gatewayOutcomes) : "未知"}。`,
    ] : [v.r2?.gatewayRequests ? "旧版网关快照使用采集日 UTC 零点至查询时刻，无法按北京时间运营日对齐。" : "当前运营日的网关采样不可用。"]),
    ...(v.rosForecast ? [`ROS 速率（GiB/日）：周期 ${gib(v.rosForecast.cyclePerDay)}，迁移后 ${gib(v.rosForecast.recentPerDay)}，剩余周期可用日均 ${gib(v.rosForecast.allowedPerDay)}。有效间隔 ${v.rosForecast.intervals}，覆盖 ${fmt(v.rosForecast.spanDays)} 天。`] : []),
    `R2 直接下行费用：0 USD。`,
    `R2 月内已分类用量按 Standard 费率折算：${fmt(v.r2?.estimatedCostUsd)} USD。未分类操作：${fmt(v.unclassifiedR2Operations)} 次。估算不含税费及其他存储类型。`,
    ...(v.r2?.gbMonthCoverage ? [`R2 月内日峰值覆盖 ${v.r2.gbMonthCoverage.observedDays}/${v.r2.gbMonthCoverage.elapsedDays} 天，已有样本折算 ${fmt(v.r2.gbMonthCoverage.observedGBMonth)} GB-month。`] : []),
    `最近已核实账项${v.confirmedInvoice?.scope === "account" ? "（Cloudflare 账户，含其他服务）" : ""}：${v.confirmedInvoice ? JSON.stringify(v.confirmedInvoice) : "未知"}。`,
    ...Object.entries(v.collectionErrors ?? {}).map(([source, reason]) => `采集状态 ${source}：${reason}`),
    ...v.advice,
  ];
}

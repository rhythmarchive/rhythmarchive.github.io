import { D1StatsStore, isPublicResourceId, verifyTurnstileToken, type Env, type NotificationFetch } from './core.js';

const HOUR = 3_600_000;
const RETENTION = 7 * 24 * HOUR;
const MANUAL_TYPES = new Set(['download', 'wrong-resource', 'metadata', 'other']);
export function validateResourceReport(value: unknown, manual: boolean): value is {
  resourceId: string; kind: string; name?: string; description?: string; turnstileToken?: string;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (!isPublicResourceId(v.resourceId) || typeof v.kind !== 'string') return false;
  if (!manual) return v.kind === 'network' || /^http_[45]\d{2}$/u.test(v.kind);
  return MANUAL_TYPES.has(v.kind) && typeof v.name === 'string' && v.name.trim().length > 0 && v.name.length <= 200
    && typeof v.description === 'string' && v.description.trim().length >= 5 && v.description.length <= 2000
    && typeof v.turnstileToken === 'string' && v.turnstileToken.length > 0 && v.turnstileToken.length <= 2048;
}

export async function acceptResourceReport(value: unknown, manual: boolean, env: Env, clientKey: string,
  now: number, fetchImpl?: NotificationFetch): Promise<{ status: number; body: Record<string, unknown> }> {
  if (env.RESOURCE_REPORTS_ENABLED !== 'true' || !env.DB || !env.RESEND_API_KEY?.trim()
    || !env.RESOURCE_REPORT_EMAIL_TO?.trim()) return { status: 503, body: { error: 'not_configured' } };
  if (!validateResourceReport(value, manual)) return { status: 400, body: { error: 'invalid_report' } };
  if (manual) {
    const hostname = env.TURNSTILE_EXPECTED_HOSTNAME?.trim();
    if (!env.TURNSTILE_SECRET_KEY?.trim() || !hostname) return { status: 503, body: { error: 'verification_unavailable' } };
    if (!await verifyTurnstileToken(env.TURNSTILE_SECRET_KEY, value.turnstileToken!,
      { hostname, action: 'resource-feedback' }, fetchImpl)) return { status: 403, body: { error: 'turnstile_failed' } };
  }
  // Automatic counts are distinct daily salted IP claims per resource/error/hour,
  // not client-supplied counts or visitor IDs. Neither IP nor download URL is retained.
  const bucket = Math.floor(now / HOUR);
  const dedupe = `${manual ? 'manual' : 'auto'}:${clientKey}:${value.resourceId}:${manual ? '' : value.kind + ':' + bucket}`;
  const id = manual ? crypto.randomUUID() : `${value.resourceId}:${value.kind}:${bucket}`;
  // D1 batch is transactional: a failed report write cannot consume its dedupe claim.
  const results = await env.DB.batch([env.DB.prepare(`INSERT INTO resource_report_dedupe (key, expires_at) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET expires_at = excluded.expires_at WHERE expires_at <= ?`)
    .bind(dedupe, manual ? now + 600_000 : (bucket + 1) * HOUR, now), env.DB.prepare(`INSERT INTO resource_reports
    (id, resource_id, kind, name, description, created_at, due_at, expires_at) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() > 0
    ON CONFLICT(id) DO UPDATE SET count = count + 1`)
    .bind(id, value.resourceId, (manual ? 'manual:' : '') + value.kind,
      manual ? value.name!.trim() : '', manual ? value.description!.trim() : '', now,
      manual ? now : (bucket + 1) * HOUR, now + RETENTION)]);
  if (!results[0]?.meta?.changes) return { status: 200, body: { ok: true, status: 'duplicate' } };
  return { status: 202, body: { ok: true, status: 'accepted' } };
}

type Report = { id: string; resource_id: string; kind: string; name: string; description: string; count: number; created_at: number };
export async function processResourceReports(env: Env, now = Date.now(), fetchImpl: NotificationFetch = fetch): Promise<void> {
  if (env.RESOURCE_REPORTS_ENABLED !== 'true' || !env.DB) return;
  const db = env.DB;
  // Two indexed retention statements per Cron; no per-download cleanup.
  await db.batch([db.prepare('DELETE FROM resource_report_dedupe WHERE expires_at <= ?').bind(now),
    db.prepare('DELETE FROM resource_reports WHERE expires_at <= ?').bind(now)]);
  if (!env.RESEND_API_KEY?.trim() || !env.RESOURCE_REPORT_EMAIL_TO?.trim()) return;
  const rows = await db.prepare(`SELECT * FROM resource_reports WHERE delivery = 'pending' AND due_at <= ?
    AND (kind GLOB 'manual:*' OR count >= 3) ORDER BY due_at LIMIT 10`).bind(now).all<Report>();
  for (const row of rows.results ?? []) {
    // Claim before contacting Resend. At most one attempt: failures/uncertain sends
    // remain inspectable for seven days, never replayed automatically.
    const claim = await db.prepare(`UPDATE resource_reports SET delivery = 'attempted'
      WHERE id = ? AND delivery = 'pending' RETURNING id`).bind(row.id).first();
    if (!claim) continue;
    if (!await new D1StatsStore(db).consumeUpdateReminderEmailBudget(now)) {
      await db.prepare("UPDATE resource_reports SET delivery = 'daily_limit_reached' WHERE id = ?").bind(row.id).run();
      continue;
    }
    let delivery = 'failed';
    try {
      const response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST', signal: AbortSignal.timeout(5000), headers: { 'Content-Type': 'application/json',
          Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Idempotency-Key': `resource-report-${row.id}` },
        body: JSON.stringify({ from: env.RESOURCE_REPORT_EMAIL_FROM?.trim() || 'Rhythm Archive <onboarding@resend.dev>',
          to: [env.RESOURCE_REPORT_EMAIL_TO], subject: `[Rhythm Archive] ${row.kind.startsWith('manual:') ? '资源反馈' : '下载异常汇总'}`,
          text: [`类型：${row.kind}`, `资源 ID：${row.resource_id}`, `名称（用户提供）：${row.name || '见详情页'}`,
            `详情：https://rhythmarchive.github.io/r/${row.resource_id}/`, `报告数量：${row.count}`,
            `开始时间：${new Date(row.created_at).toISOString()}`, row.description,
            '自动报告来自客户端观察，可能包含 CORS 或用户网络故障，不能视为服务端故障确认。'].join('\n') }) });
      delivery = response.ok ? 'sent' : `http_${response.status}`;
    } catch { delivery = 'uncertain'; }
    await db.prepare('UPDATE resource_reports SET delivery = ? WHERE id = ?').bind(delivery, row.id).run();
  }
}

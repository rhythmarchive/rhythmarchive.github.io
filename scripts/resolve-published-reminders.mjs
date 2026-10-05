import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const games = new Set(['arcaea', 'phigros', 'orzmic', 'rotaeno', 'rizline', 'infalsus', 'paradigm-reboot']);

// New formal timeline batches are the existing publication intent marker.
// Editing old records, baselines, or backfilling older history is not a release.
export function publishedUpdateGames(before, after) {
  if (before?.schemaVersion !== 1 || after?.schemaVersion !== 1
    || !Array.isArray(before.records) || !Array.isArray(after.records)) throw new Error('Invalid update timeline');
  const previousIds = new Set(before.records.map(record => record.id));
  const latest = new Map();
  for (const record of [...(before.baselines ?? []), ...before.records]) {
    const at = Date.parse(record.publishedAt);
    if (!Number.isFinite(at)) throw new Error('Invalid previous update timestamp');
    latest.set(record.game, Math.max(latest.get(record.game) ?? 0, at));
  }
  const result = new Set();
  for (const record of after.records) {
    if (previousIds.has(record.id) || record.kind !== 'update' || !record.items?.length) continue;
    if (!games.has(record.game) || !record.id || !Number.isFinite(Date.parse(record.publishedAt))) throw new Error('Invalid new update');
    if (Date.parse(record.publishedAt) <= (latest.get(record.game) ?? 0)) continue;
    result.add(record.game);
  }
  return [...result].sort();
}

export async function resolvePublishedReminders({ gameSlugs, apiUrl, token, createdBefore, fetchImpl = fetch }) {
  if (!gameSlugs.length) return [];
  if (!token?.trim()) throw new Error('Set UPDATE_REMINDER_ADMIN_TOKEN in the stats-production Environment and the Stats Worker');
  const api = new URL(apiUrl);
  if (api.protocol !== 'https:' || api.username || api.password) throw new Error('Invalid Stats API URL');
  if (!Number.isFinite(Date.parse(createdBefore))) throw new Error('Invalid publication cutoff');
  const outcomes = [];
  for (const game of gameSlugs) {
    if (!games.has(game)) throw new Error('Invalid game');
    const response = await fetchImpl(new URL(`/v1/admin/update-reminders/${game}/resolve`, api), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.trim()}`, Origin: 'https://rhythmarchive.github.io', 'Content-Type': 'application/json' },
      body: JSON.stringify({ createdBefore }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => undefined);
    if (response.status === 404 && body?.error === 'pending_not_found') outcomes.push({ game, status: 'no_eligible_cycle' });
    else if (response.ok && body?.ok === true && body?.status === 'resolved') outcomes.push({ game, status: 'resolved' });
    else throw new Error(`Reminder resolve failed for ${game}: HTTP ${response.status}`);
  }
  return outcomes;
}

export function firstSuccessfulPublication(jobs) {
  const completed = jobs.filter(job => job.name === 'deploy' && job.conclusion === 'success')
    .map(job => Date.parse(job.completed_at));
  if (!completed.length || completed.some(at => !Number.isFinite(at))) throw new Error('No successful Pages deployment found');
  return new Date(Math.min(...completed)).toISOString();
}

async function main() {
  const before = process.env.REMINDER_BASE;
  if (!before || /^0+$/u.test(before)) {
    console.log('Reminder cycles unchanged: no push baseline.');
    return;
  }
  if (!/^[a-f0-9]{40}$/u.test(before)) throw new Error('Invalid push baseline');
  const read = ref => JSON.parse(execFileSync('git', ['show', `${ref}:catalog/updates/index.json`], { encoding: 'utf8', windowsHide: true }));
  const gameSlugs = publishedUpdateGames(read(before), read('HEAD'));
  if (!gameSlugs.length) {
    console.log('Reminder cycles unchanged: no new formal game update.');
    return;
  }
  // Read all attempts: the first successful Pages publish is the stable boundary.
  const runResponse = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`, {
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!runResponse.ok) throw new Error(`Cannot read publication run: HTTP ${runResponse.status}`);
  const run = await runResponse.json();
  if (run.head_sha !== process.env.GITHUB_SHA || run.event !== 'push') throw new Error('Publication run does not match this push');
  const jobs = [];
  for (let page = 1; ; page++) {
    const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}/jobs?filter=all&per_page=100&page=${page}`, {
      headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Cannot read publication jobs: HTTP ${response.status}`);
    const result = await response.json();
    if (!Array.isArray(result.jobs)) throw new Error('Invalid publication jobs');
    jobs.push(...result.jobs);
    if (result.jobs.length < 100) break;
  }
  const outcomes = await resolvePublishedReminders({ gameSlugs, apiUrl: process.env.PUBLIC_STATS_API_URL,
    token: process.env.UPDATE_REMINDER_ADMIN_TOKEN, createdBefore: firstSuccessfulPublication(jobs) });
  for (const outcome of outcomes) console.log(`Reminder cycle ${outcome.game}: ${outcome.status}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

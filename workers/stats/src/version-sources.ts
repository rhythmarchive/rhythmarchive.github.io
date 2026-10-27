import type { PublicGameSlug } from './public-resource-registry.js';
import type { NotificationFetch } from './core.js';

export type Source = {
  id: string; game: PublicGameSlug; channel: string;
  adapter: 'apple' | 'taptap' | 'steam' | 'mirror616' | 'google' | 'milthm' | 'hykb';
  url: string; identity: string; authority: 'official' | 'publisher' | 'mirror';
  variant?: string;
};
export type Observation = {
  sourceId: string; game: PublicGameSlug; channel: string; authority: Source['authority'];
  url: string; checkedAt: number; status: 'ok' | 'unavailable'; error: string | null;
  version: string | null; publishedAt: string | null;
  dateMeaning: 'release' | 'announcement' | 'mirror-indexed' | 'not-provided';
  notes: string; releaseId: string | null;
};

const apple = (game: PublicGameSlug, id: number, bundle: string, country = 'us'): Source => ({
  id: `${game}:apple:${country}`, game, channel: `ios-${country}`, adapter: 'apple',
  url: `https://itunes.apple.com/lookup?id=${id}&country=${country}`, identity: bundle, authority: 'official',
});
const tap = (game: PublicGameSlug, id: number, bundle: string): Source => ({
  id: `${game}:taptap`, game, channel: 'android-taptap-cn', adapter: 'taptap',
  url: `https://www.taptap.cn/app/${id}`, identity: bundle, authority: 'publisher',
});
const play = (game: PublicGameSlug, bundle: string): Source => ({
  id: `${game}:google`, game, channel: 'android-google-us', adapter: 'google',
  url: `https://play.google.com/store/apps/details?id=${bundle}&hl=en_US&gl=US`, identity: bundle, authority: 'official',
});
const mirror = (game: PublicGameSlug, bundle: string, variant = 'google-play', channel = 'android-google-us'): Source => ({
  id: `${game}:616:${variant}`, game, channel, adapter: 'mirror616',
  url: 'https://api.616.sb/api/public/apps', identity: bundle, variant, authority: 'mirror',
});

// Store IDs/package names were checked against live public pages, not fuzzy search at runtime.
export const VERSION_SOURCES: readonly Source[] = [
  apple('arcaea', 1205999125, 'moe.low.arc'),
  apple('berrymelody', 6469706092, 'com.skywaystudio.BerryMelody'),
  apple('dynamix', 945955095, 'com.c4cat.dynamix'),
  apple('milthm', 6451048899, 'com.Morizero.Milthm'),
  apple('orzmic', 1522206073, 'com.Big-True.Orzmic'),
  apple('paradigm-reboot', 1499645558, 'com.tunergames.paradigm'),
  apple('paradigm-reboot', 6474954939, 'com.tunergames.paradigmchina', 'cn'),
  apple('phigros', 1454809109, 'games.Pigeon.Phigros'),
  apple('rizline', 1558094248, 'com.PigeonGames.Rizline'),
  apple('rotaeno', 1614771445, 'com.xd.rotaeno'),
  tap('berrymelody', 242115, 'com.skywaystudio.BerryMelody'),
  tap('dynamix', 7082, 'com.c4cat.dynamix'),
  tap('milthm', 301888, 'game.taptap.morizero.milthm'),
  tap('orzmic', 194778, 'com.BigTrue.Orzmic'),
  tap('phigros', 165287, 'com.PigeonGames.Phigros'),
  tap('rizline', 201173, 'com.leiting.ldgj'),
  tap('rotaeno', 166257, 'com.xd.rotaeno.tapcn'),
  { id: 'phigros:hykb', game: 'phigros', channel: 'android-hykb-cn', adapter: 'hykb', authority: 'publisher',
    url: 'https://www.3839.com/a/112696.htm', identity: 'Phigros' },
  { id: 'paradigm-reboot:hykb', game: 'paradigm-reboot', channel: 'android-hykb-cn', adapter: 'hykb', authority: 'publisher',
    url: 'https://www.3839.com/a/128686.htm', identity: '范式：起源' },
  play('arcaea', 'moe.low.arc'), play('berrymelody', 'com.SkyWayStudio.BerryMelody'),
  play('dynamix', 'com.c4cat.dynamix'), play('milthm', 'com.morizero.milthm'),
  play('paradigm-reboot', 'com.tunergames.paradigm'), play('rizline', 'com.PigeonGames.Rizline'),
  mirror('arcaea', 'moe.low.arc'), mirror('arcaea', 'moe.low.arc', 'arcaea-c', 'android-direct-c'),
  mirror('berrymelody', 'com.SkyWayStudio.BerryMelody'), mirror('dynamix', 'com.c4cat.dynamix'),
  mirror('milthm', 'com.morizero.milthm'), mirror('paradigm-reboot', 'com.tunergames.paradigm'),
  // 616 groups two distinct packages under this catalogue identity. Keep the variants separate.
  mirror('rizline', 'com.leiting.RizlineHk.android', 'google-play-intl'),
  mirror('rizline', 'com.leiting.RizlineHk.android', 'google-play-hk', 'android-google-hk'),
  { id: 'infalsus:steam', game: 'infalsus', channel: 'steam', adapter: 'steam', authority: 'official', identity: '3971950',
    url: 'https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=3971950&count=10&maxlength=6000&feeds=steam_community_announcements' },
  { id: 'milthm:website', game: 'milthm', channel: 'publisher-notes', adapter: 'milthm', authority: 'official', identity: 'Milthm',
    url: 'https://milthm.com/wiki/hans/changelog/' },
];

export const UNSUPPORTED_SOURCES = [
  { source: '好游快爆其他游戏', reason: '已核实 Phigros 和范式：起源的公开版本日志，其他游戏尚未验证详情页身份。' },
  { source: 'TapTap 范式：起源', reason: '公开页未提供可校验的 APK 版本记录，暂不接入。' },
  { source: 'TapTap 韵律源点', reason: '国内发行与国际 Arcaea 不同，未验证当前正式版本，暂不接入。' },
  { source: 'Google Play Phigros / Orzmic / Rotaeno', reason: '未验证当前对应公开发行页，不进行猜测查询。' },
  { source: '其他游戏官网', reason: '除 Milthm 外暂未验证稳定版本日志；Arcaea 官网为动态页面，不推测其内部接口。' },
];

export function plainText(value: unknown, limit = 6000): string {
  return String(value ?? '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]*>/g, ' ')
    .replace(/\[(?:\/?(?:url|img|b|i|u|h\d|list|olist|\*))(?:=[^\]]*)?\]/gi, ' ')
    .replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim().slice(0, limit);
}
function date(value: unknown): string | null {
  const n = typeof value === 'number' ? value * 1000 : Date.parse(String(value));
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
}
function version(value: unknown): string {
  if (typeof value !== 'string' || !/^\d[\w.+-]*(?:\.[\w+-]+)*$/.test(value) || value.length > 80) throw new Error('version_missing');
  return value;
}

export function parseSource(source: Source, body: string, now: number): Observation {
  const out: Observation = { sourceId: source.id, game: source.game, channel: source.channel, authority: source.authority,
    url: source.url, checkedAt: now, status: 'ok', error: null, version: null, publishedAt: null,
    dateMeaning: 'not-provided', notes: '', releaseId: null };
  if (source.adapter === 'apple') {
    const app = JSON.parse(body).results?.find((x: Record<string, unknown>) => x.bundleId === source.identity);
    if (!app) throw new Error('app_identity_missing');
    out.version = version(app.version); out.publishedAt = date(app.currentVersionReleaseDate);
    out.dateMeaning = out.publishedAt ? 'release' : 'not-provided'; out.notes = plainText(app.releaseNotes);
    if (/^https:\/\/apps\.apple\.com\//.test(app.trackViewUrl)) out.url = app.trackViewUrl;
  } else if (source.adapter === 'taptap') {
    const raw = body.match(/<script\b[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)?.[1];
    if (!raw) throw new Error('page_structure_changed');
    const values = JSON.parse(raw) as unknown[];
    // Read only the observed Nuxt reference table; never eval page scripts.
    const objects = values.filter((v): v is Record<string, number> => !!v && typeof v === 'object' && !Array.isArray(v));
    const app = objects.find(x => values[x.identifier!] === source.identity && 'apk_whats_new' in x);
    if (!app) throw new Error('app_identity_missing');
    const news = values[app.apk_whats_new!] as Record<string, number> | undefined;
    if (!news) throw new Error('version_missing');
    const label = String(values[news.version_label!] ?? '');
    out.version = version(label.split(' (')[0]); out.publishedAt = date(values[news.update_date!]);
    out.dateMeaning = out.publishedAt ? 'release' : 'not-provided';
    const notes = values[news.whatsnew!] as Record<string, number> | undefined;
    out.notes = plainText(notes ? values[notes.text!] : '');
  } else if (source.adapter === 'mirror616') {
    const app = JSON.parse(body).find((x: {packageName: string}) => x.packageName === source.identity);
    const release = app?.variants?.find((x: {slug: string}) => x.slug === source.variant)?.release;
    if (!release) throw new Error('variant_missing');
    out.version = version(release.version); out.publishedAt = date(release.publishedAt);
    out.dateMeaning = 'mirror-indexed'; out.url = 'https://616.sb/';
    out.notes = '第三方镜像收录，未提供更新日志；收录时间不是官方发布日期。';
  } else if (source.adapter === 'steam') {
    const news = JSON.parse(body).appnews;
    if (String(news?.appid) !== source.identity || !Array.isArray(news.newsitems)) throw new Error('app_identity_missing');
    const item = news.newsitems.filter((x: {feedname: string; is_external_url: boolean}) =>
      x.feedname === 'steam_community_announcements' && x.is_external_url === false)
      .sort((a: {date: number}, b: {date: number}) => b.date - a.date)[0];
    if (!item || !/^\d+$/.test(String(item.gid))) throw new Error('official_news_missing');
    out.releaseId = String(item.gid); out.publishedAt = date(item.date); out.dateMeaning = 'announcement';
    out.version = String(item.title).match(/(?:v(?:ersion)?\s*|版本\s*)(\d+\.\d+(?:\.[\w+-]+)*)/i)?.[1] ?? null;
    out.notes = plainText(`${item.title}\n${item.contents}`);
    if (/^https:\/\/(?:store\.steampowered\.com|steamcommunity\.com)\//.test(item.url)) out.url = item.url;
    // A news GID is an announcement identity, never a fabricated Steam build/version.
  } else if (source.adapter === 'hykb') {
    const title = plainText(body.match(/<title>([\s\S]*?)<\/title>/)?.[1]);
    if (!title.startsWith(source.identity)) throw new Error('app_identity_missing');
    const log = body.match(/class="game-log js_text"[\s\S]*?class="sp-head">\s*版本\s+([\w.]+)\s+(\d{4}-\d{2}-\d{2})<\/div>([\s\S]*?)<\/div>/);
    if (!log) throw new Error('page_structure_changed');
    out.version = version(log[1]); out.publishedAt = date(`${log[2]}T00:00:00+08:00`);
    out.dateMeaning = 'release'; out.notes = plainText(log[3]);
  } else if (source.adapter === 'milthm') {
    const m = body.match(/<h2\b[^>]*>\s*Milthm v([\d.]+)[\s\S]*?<\/h2>([\s\S]*?)(?=<h2\b|$)/);
    if (!m) throw new Error('page_structure_changed');
    out.version = version(m[1]); out.notes = plainText(m[2]);
  } else {
    // Google does not provide a public unauthenticated version API. Only accept an explicit
    // SoftwareApplication softwareVersion, never a random number in its private page arrays.
    const apps = [...body.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)]
      .map(m => JSON.parse(m[1]!));
    const app = apps.find(x => x['@type'] === 'SoftwareApplication' &&
      typeof x.url === 'string' && new URL(x.url, source.url).searchParams.get('id') === source.identity);
    if (!app) throw new Error('public_version_unavailable');
    out.version = version(app.softwareVersion); out.publishedAt = date(app.dateModified);
    out.dateMeaning = out.publishedAt ? 'release' : 'not-provided'; out.notes = plainText(app.releaseNotes);
  }
  return out;
}

async function boundedBody(response: Response): Promise<string> {
  const reader = response.body?.getReader(); if (!reader) throw new Error('empty_body');
  const parts: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) { const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.length; if (bytes > 768 * 1024) throw new Error('body_too_large'); parts.push(chunk.value); }
  } finally { await reader.cancel().catch(() => {}); }
  const result = new Uint8Array(bytes); let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return new TextDecoder().decode(result);
}

export async function queryVersions(now: number, fetchImpl: NotificationFetch = fetch, sources = VERSION_SOURCES): Promise<Observation[]> {
  // Shared 616 response: one request for all variants. No retries or historical object requests.
  const urls = [...new Set(sources.map(x => x.url))]; const bodies = new Map<string, string | Error>();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, urls.length) }, async () => {
    while (next < urls.length) {
      const url = urls[next++]!;
      try {
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(8000), redirect: 'manual',
          headers: { Accept: 'application/json,text/html', 'User-Agent': 'RhythmArchive-VersionMonitor/1.0 (+https://rhythmarchive.github.io/)' } });
        if (!response.ok) { await response.body?.cancel(); throw new Error(`http_${response.status}`); }
        bodies.set(url, await boundedBody(response));
      } catch (error) { bodies.set(url, error instanceof Error ? error : new Error('query_failed')); }
    }
  }));
  return sources.map(source => {
    try { const body = bodies.get(source.url); if (body instanceof Error) throw body;
      if (!body) throw new Error('empty_body'); return parseSource(source, body, now);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      // Only bounded error codes persist; never save response bodies or request headers.
      return { sourceId: source.id, game: source.game, channel: source.channel, authority: source.authority,
        url: source.url, checkedAt: now, status: 'unavailable', error: /^[a-z_]+(?:_\d{3})?$/.test(message) ? message : 'query_failed',
        version: null, publishedAt: null, dateMeaning: 'not-provided', notes: '', releaseId: null };
    }
  });
}

export function normalizedVersion(value: string): string { return value.toLowerCase().replace(/(?:\.0)+$/, ''); }
export function verification(current: Observation, observations: Observation[]): { status: string; sources: string[]; note: string } {
  const peers = observations.filter(x => x.game === current.game && x.channel === current.channel && x.status === 'ok');
  const same = peers.filter(x => x.version && current.version && normalizedVersion(x.version) === normalizedVersion(current.version));
  const conflict = peers.some(x => x.version && current.version && normalizedVersion(x.version) !== normalizedVersion(current.version));
  return { status: current.status !== 'ok' ? 'unverified' : conflict ? 'conflict' : same.length > 1 && same.some(x => x.authority !== 'mirror') ? 'multi-source' : current.authority === 'mirror' ? 'unverified' : 'single-source',
    sources: same.map(x => x.sourceId), note: '仅比较同一发行渠道；跨渠道版本相同不证明各平台同步发布。镜像不能独立确认官方更新。' };
}

export function changeKind(previous: Observation, current: Observation): string | null {
  if (current.status !== 'ok') return null;
  if (current.releaseId !== previous.releaseId) return 'announcement';
  if (current.version !== previous.version) {
    if (current.version && previous.version && normalizedVersion(current.version) === normalizedVersion(previous.version)) return 'metadata';
    if (current.version && previous.version && compareNumericVersion(current.version, previous.version) === -1) return 'regression';
    return 'version';
  }
  if (current.notes !== previous.notes || current.publishedAt !== previous.publishedAt) return 'metadata';
  return null;
}

function compareNumericVersion(left: string, right: string): number | null {
  if (!/^\d+(?:\.\d+)*$/.test(left) || !/^\d+(?:\.\d+)*$/.test(right)) return null;
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0); if (delta) return Math.sign(delta);
  }
  return 0;
}

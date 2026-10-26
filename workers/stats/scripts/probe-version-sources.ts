import { queryVersions, verification, VERSION_SOURCES } from '../src/version-sources.js';

// Read-only real-source probe. Does not connect to D1, Resend, or generate events.
const now = Date.now();
const observations = await queryVersions(now);
for (const o of observations) console.log(JSON.stringify({ source: o.sourceId, channel: o.channel, status: o.status,
  version: o.version, publishedAt: o.publishedAt, dateMeaning: o.dateMeaning,
  verification: verification(o, observations).status, error: o.error,
  notes: o.notes.slice(0, 120), url: o.url }));
console.log(JSON.stringify({ checkedAt: new Date(now).toISOString(), sources: VERSION_SOURCES.length,
  requests: new Set(VERSION_SOURCES.map(x => x.url)).size,
  successful: observations.filter(x=>x.status==='ok').length, failed: observations.filter(x=>x.status!=='ok').length }));

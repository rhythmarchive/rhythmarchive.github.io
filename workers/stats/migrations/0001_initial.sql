CREATE TABLE IF NOT EXISTS site_totals (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  total_visits INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO site_totals (id, total_visits, updated_at) VALUES (1, 0, 0);

CREATE TABLE IF NOT EXISTS site_daily (
  visit_date TEXT PRIMARY KEY,
  total_visits INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS resource_stats (
  resource_id TEXT PRIMARY KEY,
  total_views INTEGER NOT NULL DEFAULT 0,
  total_downloads INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS event_dedupe (
  visitor_id TEXT NOT NULL,
  dedupe_kind TEXT NOT NULL,
  resource_id TEXT NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (visitor_id, dedupe_kind, resource_id)
);

CREATE INDEX IF NOT EXISTS event_dedupe_expires_idx ON event_dedupe (expires_at);

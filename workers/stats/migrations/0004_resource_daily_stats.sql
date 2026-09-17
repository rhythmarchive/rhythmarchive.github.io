CREATE TABLE IF NOT EXISTS resource_daily_stats (
  resource_id TEXT NOT NULL,
  stat_date TEXT NOT NULL,
  daily_views INTEGER NOT NULL DEFAULT 0,
  daily_downloads INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (resource_id, stat_date)
);

CREATE INDEX IF NOT EXISTS resource_daily_stats_date_rank_idx
  ON resource_daily_stats (stat_date, daily_views DESC, daily_downloads DESC, resource_id);
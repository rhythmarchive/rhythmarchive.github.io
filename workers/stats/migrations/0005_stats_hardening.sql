CREATE TABLE IF NOT EXISTS request_rate_limits (
  rate_key TEXT NOT NULL,
  scope TEXT NOT NULL,
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (rate_key, scope)
);

CREATE INDEX IF NOT EXISTS request_rate_limits_window_idx
  ON request_rate_limits (window_started_at);

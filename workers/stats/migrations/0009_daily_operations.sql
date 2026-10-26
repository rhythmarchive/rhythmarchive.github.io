-- Private operational data. No public route exposes these tables.
CREATE TABLE version_monitor_runs (
  run_date TEXT PRIMARY KEY, started_at INTEGER NOT NULL, completed_at INTEGER,
  lease_until INTEGER NOT NULL, owner TEXT NOT NULL, status TEXT NOT NULL,
  error TEXT
);
CREATE TABLE version_source_state (
  source_id TEXT PRIMARY KEY, observation_json TEXT NOT NULL,
  checked_at INTEGER NOT NULL
);
CREATE TABLE version_checks (
  run_date TEXT NOT NULL, source_id TEXT NOT NULL, checked_at INTEGER NOT NULL,
  result_json TEXT NOT NULL, PRIMARY KEY(run_date, source_id)
);
CREATE TABLE version_changes (
  run_date TEXT NOT NULL, source_id TEXT NOT NULL, game TEXT NOT NULL,
  channel TEXT NOT NULL, kind TEXT NOT NULL, previous_json TEXT NOT NULL,
  current_json TEXT NOT NULL, PRIMARY KEY(run_date, source_id)
);
CREATE TABLE daily_operations_reports (
  report_date TEXT PRIMARY KEY, created_at INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL, email_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  first_attempt_at INTEGER, next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0, owner TEXT,
  sent_at INTEGER, provider_id TEXT, last_error TEXT
);
CREATE INDEX daily_operations_due ON daily_operations_reports(status, next_attempt_at);
CREATE TABLE daily_operations_email_daily (
  send_date TEXT PRIMARY KEY, attempts INTEGER NOT NULL CHECK(attempts BETWEEN 0 AND 3)
);
CREATE INDEX reminder_notifications_report_time ON update_reminder_notifications(reminded_at, cycle_id);
CREATE INDEX resource_reports_report_time ON resource_reports(created_at);

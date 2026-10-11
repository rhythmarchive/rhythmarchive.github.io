CREATE TABLE resource_report_dedupe (
  key TEXT PRIMARY KEY, expires_at INTEGER NOT NULL
);
CREATE INDEX resource_report_dedupe_expiry ON resource_report_dedupe(expires_at);
CREATE TABLE resource_reports (
  id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, kind TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
  count INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
  due_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  delivery TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX resource_reports_due ON resource_reports(delivery, due_at) WHERE kind GLOB 'manual:*' OR count >= 3;
CREATE INDEX resource_reports_expiry ON resource_reports(expires_at);

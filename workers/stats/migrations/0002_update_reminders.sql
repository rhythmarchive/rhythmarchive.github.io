CREATE TABLE IF NOT EXISTS update_reminder_games (
  game TEXT PRIMARY KEY,
  pending INTEGER NOT NULL DEFAULT 0 CHECK (pending IN (0, 1)),
  first_reminded_at INTEGER,
  last_reminded_at INTEGER,
  effective_reminder_count INTEGER NOT NULL DEFAULT 0,
  last_notified_at INTEGER
);

CREATE TABLE IF NOT EXISTS update_reminders (
  visitor_id TEXT NOT NULL,
  game TEXT NOT NULL,
  first_reminded_at INTEGER NOT NULL,
  last_reminded_at INTEGER NOT NULL,
  PRIMARY KEY (visitor_id, game)
);

CREATE INDEX IF NOT EXISTS update_reminders_game_last_idx
  ON update_reminders (game, last_reminded_at);

CREATE INDEX IF NOT EXISTS update_reminders_visitor_last_idx
  ON update_reminders (visitor_id, last_reminded_at);

CREATE TABLE IF NOT EXISTS update_reminder_rate_limits (
  visitor_id TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS update_reminder_rate_limits_window_idx
  ON update_reminder_rate_limits (window_started_at);

INSERT OR IGNORE INTO update_reminder_games
  (game, pending, first_reminded_at, last_reminded_at, effective_reminder_count, last_notified_at)
VALUES
  ("arcaea", 0, NULL, NULL, 0, NULL),
  ("phigros", 0, NULL, NULL, 0, NULL),
  ("rizline", 0, NULL, NULL, 0, NULL),
  ("infalsus", 0, NULL, NULL, 0, NULL),
  ("rotaeno", 0, NULL, NULL, 0, NULL),
  ("paradigm-reboot", 0, NULL, NULL, 0, NULL);
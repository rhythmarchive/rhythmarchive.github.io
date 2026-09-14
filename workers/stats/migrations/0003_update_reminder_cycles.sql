CREATE TABLE IF NOT EXISTS update_reminder_cycles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game TEXT NOT NULL,
  cycle_number INTEGER NOT NULL,
  pending INTEGER NOT NULL DEFAULT 1 CHECK (pending IN (0, 1)),
  first_reminded_at INTEGER NOT NULL,
  last_reminded_at INTEGER NOT NULL,
  effective_reminder_count INTEGER NOT NULL DEFAULT 0,
  last_notified_at INTEGER,
  notification_status TEXT NOT NULL DEFAULT 'pending' CHECK (notification_status IN ('pending', 'sent', 'failed')),
  notification_attempts INTEGER NOT NULL DEFAULT 0,
  last_notification_attempt_at INTEGER,
  next_notification_at INTEGER,
  last_notification_error TEXT,
  resolved_at INTEGER,
  UNIQUE(game, cycle_number)
);

CREATE UNIQUE INDEX IF NOT EXISTS update_reminder_cycles_pending_idx
  ON update_reminder_cycles (game)
  WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS update_reminder_cycle_visitors (
  cycle_id INTEGER NOT NULL,
  visitor_id TEXT NOT NULL,
  game TEXT NOT NULL,
  first_reminded_at INTEGER NOT NULL,
  last_reminded_at INTEGER NOT NULL,
  PRIMARY KEY (cycle_id, visitor_id, game)
);

CREATE INDEX IF NOT EXISTS update_reminder_cycle_visitors_visitor_idx
  ON update_reminder_cycle_visitors (visitor_id, game, last_reminded_at);

INSERT OR IGNORE INTO update_reminder_cycles
  (game, cycle_number, pending, first_reminded_at, last_reminded_at, effective_reminder_count, last_notified_at, notification_status)
SELECT
  game,
  1,
  pending,
  first_reminded_at,
  last_reminded_at,
  effective_reminder_count,
  last_notified_at,
  CASE WHEN last_notified_at IS NULL THEN 'pending' ELSE 'sent' END
FROM update_reminder_games
WHERE effective_reminder_count > 0;

INSERT OR IGNORE INTO update_reminder_cycle_visitors
  (cycle_id, visitor_id, game, first_reminded_at, last_reminded_at)
SELECT
  cycles.id,
  reminders.visitor_id,
  reminders.game,
  reminders.first_reminded_at,
  reminders.last_reminded_at
FROM update_reminders AS reminders
JOIN update_reminder_cycles AS cycles
  ON cycles.game = reminders.game
 AND cycles.cycle_number = 1
WHERE cycles.resolved_at IS NULL;
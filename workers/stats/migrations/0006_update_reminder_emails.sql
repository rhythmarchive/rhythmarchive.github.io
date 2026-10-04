-- Delivery state belongs to each counted reminder, not to the pending cycle.
CREATE TABLE update_reminder_notifications (
  id TEXT PRIMARY KEY,
  cycle_id INTEGER NOT NULL REFERENCES update_reminder_cycles(id),
  reminder_count INTEGER NOT NULL,
  reminded_at INTEGER NOT NULL,
  notification_status TEXT NOT NULL DEFAULT 'pending' CHECK (notification_status IN ('pending', 'sent', 'failed')),
  notification_attempts INTEGER NOT NULL DEFAULT 0,
  last_notification_attempt_at INTEGER,
  next_notification_at INTEGER,
  last_notification_error TEXT,
  last_notified_at INTEGER,
  UNIQUE(cycle_id, reminder_count)
);
CREATE INDEX update_reminder_notifications_due_idx
  ON update_reminder_notifications(notification_status, next_notification_at);

CREATE TABLE update_reminder_email_daily (
  send_date TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 80)
);

-- Preserve one outstanding legacy delivery; never replay sent history.
INSERT INTO update_reminder_notifications
  (id, cycle_id, reminder_count, reminded_at, notification_status, notification_attempts,
   last_notification_attempt_at, next_notification_at, last_notification_error, last_notified_at)
SELECT 'legacy-' || id, id, effective_reminder_count, last_reminded_at,
       notification_status, notification_attempts, last_notification_attempt_at,
       next_notification_at, last_notification_error, last_notified_at
FROM update_reminder_cycles
WHERE pending = 1 AND resolved_at IS NULL AND notification_status <> 'sent';

-- Include today's legacy attempts when rolling out mid-day (UTC).
INSERT INTO update_reminder_email_daily (send_date, attempts)
SELECT date('now'), MIN(80, COALESCE(SUM(notification_attempts), 0)) FROM update_reminder_cycles
WHERE date(last_notification_attempt_at / 1000, 'unixepoch') = date('now');

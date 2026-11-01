-- Each delivery owns its immutable note; old notifications remain blank.
ALTER TABLE update_reminder_notifications ADD COLUMN note TEXT NOT NULL DEFAULT '';

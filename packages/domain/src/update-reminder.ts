export const UPDATE_REMINDER_NOTE_MAX_LENGTH = 160;

/** A single plain-text line, measured in the same UTF-16 units as maxlength. */
export function normalizeUpdateReminderNote(value: unknown): { note: string } | { error: "invalid_note" } {
  if (value === undefined) return { note: "" };
  if (typeof value !== "string") return { error: "invalid_note" };
  const note = value.trim();
  if (note.length > UPDATE_REMINDER_NOTE_MAX_LENGTH || /[\u0000-\u001f\u007f\u2028\u2029]/u.test(note)) return { error: "invalid_note" };
  return { note };
}

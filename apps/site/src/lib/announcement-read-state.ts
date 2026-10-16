export const ANNOUNCEMENT_READ_KEY = "rhythm-archive-read-announcements";
type ReadStorage = Pick<Storage, "getItem" | "setItem">;

// Memory keeps navigation quiet even when both browser stores are unavailable.
// Merge rather than replace so another tab cannot forget notices already seen.
export function createAnnouncementReadState(stores: ReadStorage[]) {
  const seen = new Set<string>();
  const sync = () => {
    for (const storage of stores) {
      try {
        const values: unknown = JSON.parse(storage.getItem(ANNOUNCEMENT_READ_KEY) ?? "[]");
        if (Array.isArray(values)) for (const id of values.slice(-100)) if (typeof id === "string") seen.add(id);
      } catch { /* Corrupt or blocked storage does not prevent opening notices. */ }
    }
  };
  return {
    has(id: string) { sync(); return seen.has(id); },
    shouldNotify(notice: { id: string; notify?: boolean } | undefined) {
      sync();
      return notice?.notify === true && !seen.has(notice.id);
    },
    mark(id: string) {
      sync();
      seen.add(id);
      const value = JSON.stringify([...seen].slice(-100));
      for (const storage of stores) {
        try { storage.setItem(ANNOUNCEMENT_READ_KEY, value); } catch { /* Try the other store; memory remains usable. */ }
      }
    },
  };
}

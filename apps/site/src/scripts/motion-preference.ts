export type MotionPreference = "system" | "reduced" | "standard" | "rich";
export type MotionLevel = Exclude<MotionPreference, "system">;
export const motionStorageKey = "rhythm-archive-motion";

export function normalizeMotion(value: unknown): MotionPreference {
  return value === "reduced" || value === "standard" || value === "rich" ? value : "system";
}

export function resolveMotion(value: unknown, reduced: boolean): MotionLevel {
  const preference = normalizeMotion(value);
  return preference === "system" ? reduced ? "reduced" : "standard" : preference;
}

export function motionLevel(): MotionLevel {
  const preference = typeof document === "undefined" ? "system" : document.documentElement.dataset.motion;
  return resolveMotion(preference, window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

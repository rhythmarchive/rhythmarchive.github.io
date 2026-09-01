import type { PublicGameIndex } from "./types";
import { compareNaturalText } from "./search";

export type PublicGameSort = "updated" | "name";

export function sortPublicGames(games: readonly PublicGameIndex[], sort: PublicGameSort = "updated"): PublicGameIndex[] {
  return [...games].sort((left, right) => {
    if (sort === "name") {
      return compareNaturalText(left.displayName, right.displayName) || left.slug.localeCompare(right.slug, "en");
    }

    const updatedDifference = timestamp(right.lastUpdatedAt) - timestamp(left.lastUpdatedAt);
    return updatedDifference || compareNaturalText(left.displayName, right.displayName) || left.slug.localeCompare(right.slug, "en");
  });
}

export function formatGameUpdatedAt(value?: string): string {
  const date = parseDate(value);
  if (!date) return "";
  const parts = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", timeZone: "Asia/Shanghai" }).formatToParts(date);
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return month && day ? `${month}-${day} 更新` : "";
}

export function formatContentVersion(value?: string): string {
  const version = value?.trim();
  if (!version) return "";
  return /^v/iu.test(version) || /^\D/iu.test(version) ? version : `v${version}`;
}

export function isRecentlyUpdated(value?: string, now = Date.now(), windowDays = 7): boolean {
  const updatedAt = timestamp(value);
  if (updatedAt < 0) return false;
  const age = now - updatedAt;
  return age >= 0 && age <= windowDays * 24 * 60 * 60 * 1000;
}

function parseDate(value?: string): Date | undefined {
  if (!value) return undefined;
  const timestampValue = Date.parse(value);
  return Number.isFinite(timestampValue) ? new Date(timestampValue) : undefined;
}

function timestamp(value?: string): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : -1;
}

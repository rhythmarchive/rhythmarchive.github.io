import type { PublicSearchEntry } from "./types";

const naturalTextCollators = new Map<string, Intl.Collator>([
  ["zh-CN", new Intl.Collator("zh-CN", { numeric: true, sensitivity: "variant" })],
]);

export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .trim()
    .replace(/[\u2010-\u2015\u2212]/gu, "-")
    .replace(/[\u3001\u3002，。！？；：、“”‘’（）【】《》]/gu, " ")
    .replace(/[\s_-]+/gu, " ")
    .trim();
}

export function compareNaturalText(left: string, right: string, locale = "zh-CN"): number {
  let collator = naturalTextCollators.get(locale);
  if (!collator) {
    collator = new Intl.Collator(locale, { numeric: true, sensitivity: "variant" });
    naturalTextCollators.set(locale, collator);
  }
  return collator.compare(normalizeSearchText(left), normalizeSearchText(right));
}

export function splitSearchQuery(value: string): string[] {
  return normalizeSearchText(value).split(" ").filter(Boolean);
}

export function rankSearchEntries(entries: PublicSearchEntry[], query: string): PublicSearchEntry[] {
  const terms = splitSearchQuery(query);
  if (terms.length === 0) return [];

  const scored = entries.flatMap((entry) => {
    const title = normalizeSearchText(entry.title);
    const artist = normalizeSearchText(entry.artist ?? "");
    const keywords = entry.keywords.map(normalizeSearchText);
    const score = scoreEntry(title, artist, keywords, terms);
    return score === 0 ? [] : [{ entry, score }];
  });

  return scored
    .sort((a, b) => b.score - a.score || compareNaturalText(a.entry.title, b.entry.title) || a.entry.resourceId.localeCompare(b.entry.resourceId))
    .map(({ entry }) => entry);
}

function scoreEntry(title: string, artist: string, keywords: string[], terms: string[]): number {
  let total = 0;
  for (const term of terms) {
    if (title === term) total += 1000;
    else if (title.startsWith(term)) total += 700;
    else if (title.includes(term)) total += 500;
    else if (artist.includes(term)) total += 300;
    else if (keywords.some((keyword) => keyword.includes(term))) total += 100;
    else return 0;
  }
  return total;
}

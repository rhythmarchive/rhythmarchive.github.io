import type { PublicResource } from "./types";

/**
 * The single source of searchable text for a public Resource: its display title, artist,
 * every metadata value, variant label and chart field the public card and detail expose.
 *
 * Rotaeno keeps internal identifiers out of search; other games have no such metadata.
 * Catalog source filenames and working titles are deliberately not searchable here; the
 * public title, artist and semantic search terms carry the user-facing names instead.
 */
const ROTAENO_INTERNAL_METADATA_KEYS = ["songId", "packId", "relatedSongId"];

export function resourceSearchTerms(resource: PublicResource): string[] {
  const terms: string[] = [];
  const add = (value: string | undefined): void => {
    if (value !== undefined && value.trim().length > 0) terms.push(value);
  };
  add(resource.displayTitle);
  add(resource.artist);
  for (const [key, value] of Object.entries(resource.metadata)) {
    if (resource.game === "rotaeno" && ROTAENO_INTERNAL_METADATA_KEYS.includes(key)) continue;
    add(String(value));
  }
  for (const variant of resource.variants) add(variant.label);
  for (const chart of [...(resource.charts ?? []), ...(resource.specialCharts ?? [])]) {
    add(chart.difficulty);
    add(chart.level);
    if (chart.notes !== undefined) add(String(chart.notes));
    add(chart.constant);
    add(chart.title);
    add(chart.artist);
    add(chart.noter);
  }
  return terms;
}

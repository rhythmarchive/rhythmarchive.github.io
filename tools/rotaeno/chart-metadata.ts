export const ROTAENO_CHART_DIFFICULTIES = ["I", "II", "III", "IV", "IV_Alpha"] as const;

export type RotaenoChartDifficulty = (typeof ROTAENO_CHART_DIFFICULTIES)[number];
export type RotaenoPublicChart = {
  difficulty: RotaenoChartDifficulty;
  level?: string;
  artist?: string;
  available: boolean;
  status: "available" | "unavailable";
};

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function isDifficulty(value: string): value is RotaenoChartDifficulty {
  return (ROTAENO_CHART_DIFFICULTIES as readonly string[]).includes(value);
}

/**
 * Rebuild the public-safe chart shape instead of forwarding arbitrary metadata.
 * Unknown keys are rejected so an encrypted chart body or Unity path cannot
 * silently cross into Catalog.
 */
export function sanitizeRotaenoCharts(value: unknown, context = "Rotaeno charts"): RotaenoPublicChart[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${context} must be an array`);
  return value.map((candidate, index) => {
    const chart = object(candidate);
    const keys = Object.keys(chart);
    const allowed = new Set(["difficulty", "level", "artist", "available", "status"]);
    const unknown = keys.filter((key) => !allowed.has(key));
    if (unknown.length > 0) throw new Error(`${context}[${index}] contains unsupported keys: ${unknown.join(", ")}`);
    const difficulty = stringValue(chart.difficulty);
    if (!difficulty || !isDifficulty(difficulty)) throw new Error(`${context}[${index}] has an unsupported difficulty`);
    if (typeof chart.available !== "boolean") throw new Error(`${context}[${index}] must declare boolean available`);
    if (chart.status !== "available" && chart.status !== "unavailable") throw new Error(`${context}[${index}] has an unsupported status`);
    if ((chart.available && chart.status !== "available") || (!chart.available && chart.status !== "unavailable")) {
      throw new Error(`${context}[${index}] has inconsistent availability status`);
    }
    const level = chart.level === undefined ? undefined : stringValue(chart.level);
    if (chart.level !== undefined && !level) throw new Error(`${context}[${index}] has an invalid level`);
    const artist = chart.artist === undefined ? undefined : stringValue(chart.artist);
    if (chart.artist !== undefined && !artist) throw new Error(`${context}[${index}] has an invalid artist`);
    return {
      difficulty,
      ...(level ? { level } : {}),
      ...(artist ? { artist } : {}),
      available: chart.available,
      status: chart.status,
    };
  });
}

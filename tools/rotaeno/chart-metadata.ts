export const ROTAENO_CHART_DIFFICULTIES = ["I", "II", "III", "IV", "IV_Alpha"] as const;
export const ROTAENO_CHART_SOURCES = ["apk", "wiki", "merged"] as const;

export type RotaenoChartDifficulty = (typeof ROTAENO_CHART_DIFFICULTIES)[number];
export type RotaenoChartSource = (typeof ROTAENO_CHART_SOURCES)[number];
export type RotaenoPublicChart = {
  difficulty: RotaenoChartDifficulty;
  level?: string;
  notes?: number;
  constant?: string;
  artist?: string;
  source?: RotaenoChartSource;
  available: boolean;
  status: "available" | "unavailable";
};
export type RotaenoPublicSpecialChart = {
  difficulty: string;
  level?: string;
  notes?: number;
  constant?: string;
  artist?: string;
  source?: RotaenoChartSource;
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

function isSource(value: string): value is RotaenoChartSource {
  return (ROTAENO_CHART_SOURCES as readonly string[]).includes(value);
}

function isConstant(value: string): boolean {
  return /^\d+(?:\.\d+)?$/u.test(value);
}

function integerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function sanitizeChart(candidate: unknown, index: number, context: string, difficultyValidator: (value: string) => boolean): RotaenoPublicSpecialChart {
  const chart = object(candidate);
  const keys = Object.keys(chart);
  const allowed = new Set(["difficulty", "level", "notes", "constant", "artist", "source", "available", "status"]);
  const unknown = keys.filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${context}[${index}] contains unsupported keys: ${unknown.join(", ")}`);
  const difficulty = stringValue(chart.difficulty);
  if (!difficulty || !difficultyValidator(difficulty)) throw new Error(`${context}[${index}] has an unsupported difficulty`);
  if (typeof chart.available !== "boolean") throw new Error(`${context}[${index}] must declare boolean available`);
  if (chart.status !== "available" && chart.status !== "unavailable") throw new Error(`${context}[${index}] has an unsupported status`);
  if ((chart.available && chart.status !== "available") || (!chart.available && chart.status !== "unavailable")) {
    throw new Error(`${context}[${index}] has inconsistent availability status`);
  }
  const level = chart.level === undefined ? undefined : stringValue(chart.level);
  if (chart.level !== undefined && !level) throw new Error(`${context}[${index}] has an invalid level`);
  const notes = chart.notes === undefined ? undefined : integerValue(chart.notes);
  if (chart.notes !== undefined && notes === undefined) throw new Error(`${context}[${index}] has an invalid notes count`);
  const constant = chart.constant === undefined ? undefined : stringValue(chart.constant);
  const sourceValue = chart.source === undefined ? undefined : stringValue(chart.source);
  const source = sourceValue && isSource(sourceValue) ? sourceValue : undefined;
  const artist = chart.artist === undefined ? undefined : stringValue(chart.artist);
  if (chart.artist !== undefined && !artist) throw new Error(`${context}[${index}] has an invalid artist`);
  if (chart.constant !== undefined && (!constant || !isConstant(constant))) throw new Error(context + "[" + index + "] has an invalid constant");
  if (chart.source !== undefined && !source) throw new Error(context + "[" + index + "] has an unsupported source");
  return {
    difficulty,
    ...(level ? { level } : {}),
    ...(notes !== undefined ? { notes } : {}),
    ...(constant ? { constant } : {}),
    ...(artist ? { artist } : {}),
    ...(source ? { source } : {}),
    available: chart.available,
    status: chart.status,
  };
}

/**
 * Rebuild the public-safe chart shape instead of forwarding arbitrary metadata.
 * Unknown keys are rejected so an encrypted chart body or Unity path cannot
 * silently cross into Catalog.
 */
export function sanitizeRotaenoCharts(value: unknown, context = "Rotaeno charts"): RotaenoPublicChart[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${context} must be an array`);
  return value.map((candidate, index) => sanitizeChart(candidate, index, context, isDifficulty)) as RotaenoPublicChart[];
}

export function sanitizeRotaenoSpecialCharts(value: unknown, context = "Rotaeno special charts"): RotaenoPublicSpecialChart[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${context} must be an array`);
  return value.map((candidate, index) => sanitizeChart(candidate, index, context, (difficulty) => difficulty.length > 0));
}

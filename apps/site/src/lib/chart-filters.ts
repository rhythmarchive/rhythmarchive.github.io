import type { PublicResource } from "./types";

export type ChartFilterCriteria = {
  difficulties?: readonly string[];
  levels?: readonly string[];
  constants?: readonly string[];
  constantRange?: { min: number; max: number };
  levelRange?: { min: number; max: number };
};

/** Match chart facets against one chart row, preserving chart relationships. */
export function matchesChartFilters(resource: Pick<PublicResource, "charts" | "specialCharts">, criteria: ChartFilterCriteria): boolean {
  const difficulties = criteria.difficulties ?? [];
  const levels = criteria.levels ?? [];
  const constants = criteria.constants ?? [];
  const hasCriteria = difficulties.length > 0 || levels.length > 0 || constants.length > 0 || criteria.constantRange !== undefined || criteria.levelRange !== undefined;
  if (!hasCriteria) return true;

  return [...(resource.charts ?? []), ...(resource.specialCharts ?? [])].some((chart) => {
    if (chart.available === false || chart.status === "error" || chart.status === "legacy") return false;
    if (difficulties.length > 0 && !difficulties.includes(chart.difficulty)) return false;
    if (levels.length > 0 && (!chart.level || !levels.includes(chart.level))) return false;
    if (constants.length > 0 && (!chart.constant || !constants.includes(chart.constant))) return false;
    if (criteria.constantRange) {
      if (!chart.constant) return false;
      const constant = Number(chart.constant);
      if (!Number.isFinite(constant) || constant < criteria.constantRange.min || constant > criteria.constantRange.max) return false;
    }
    if (criteria.levelRange) {
      const level = chart.level && /^\d+(?:\.\d+)?$/u.test(chart.level) ? Number(chart.level) : Number.NaN;
      if (!Number.isFinite(level) || level < criteria.levelRange.min || level > criteria.levelRange.max) return false;
    }
    return true;
  });
}

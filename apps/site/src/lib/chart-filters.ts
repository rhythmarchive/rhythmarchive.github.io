import type { PublicResource } from "./types";

export type ChartFilterCriteria = {
  difficulties?: readonly string[];
  levels?: readonly string[];
  constants?: readonly string[];
  constantRange?: { min: number; max: number };
};

/** Match chart facets against one chart row, preserving chart relationships. */
export function matchesChartFilters(resource: PublicResource, criteria: ChartFilterCriteria): boolean {
  const difficulties = criteria.difficulties ?? [];
  const levels = criteria.levels ?? [];
  const constants = criteria.constants ?? [];
  const hasCriteria = difficulties.length > 0 || levels.length > 0 || constants.length > 0 || criteria.constantRange !== undefined;
  if (!hasCriteria) return true;

  return [...(resource.charts ?? []), ...(resource.specialCharts ?? [])].some((chart) => {
    if (difficulties.length > 0 && !difficulties.includes(chart.difficulty)) return false;
    if (levels.length > 0 && (!chart.level || !levels.includes(chart.level))) return false;
    if (constants.length > 0 && (!chart.constant || !constants.includes(chart.constant))) return false;
    if (criteria.constantRange) {
      const constant = Number(chart.constant);
      if (!Number.isFinite(constant) || constant < criteria.constantRange.min || constant > criteria.constantRange.max) return false;
    }
    return true;
  });
}

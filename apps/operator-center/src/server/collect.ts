import type { DashboardSnapshot, OperatorSources, SourceFailure, SourceResult } from "../contracts.js";

export function unavailable<T>(reason: SourceFailure, now = new Date()): SourceResult<T> {
  return { state: "unavailable", observedAt: now.toISOString(), reason };
}

/** Provider failures stay isolated; responses contain stable codes, not upstream bodies. */
export async function collectDashboard(sources: OperatorSources, now = new Date()): Promise<DashboardSnapshot> {
  const safe = async <T>(call: () => Promise<SourceResult<T>>): Promise<SourceResult<T>> => {
    try { return await call(); } catch { return unavailable<T>("upstream-error", now); }
  };
  const [stats, analytics, ros, pages] = await Promise.all([
    safe(() => sources.stats()), safe(() => sources.analytics()), safe(() => sources.ros()), safe(() => sources.pages()),
  ]);
  return { schemaVersion: 1, generatedAt: now.toISOString(), sources: { stats, analytics, ros, pages } };
}

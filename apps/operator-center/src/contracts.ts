import type { ResourceRankingEntry, SiteStats } from "../../../workers/stats/src/core.js";

export type SourceName = "stats-d1" | "cloudflare-analytics" | "rainyun-ros" | "github-pages";
export type SourceFailure = "not-configured" | "unauthorized" | "rate-limited" | "upstream-error" | "invalid-response";
export type SourceResult<T> =
  | { state: "ok"; observedAt: string; data: T }
  | { state: "unavailable"; observedAt: string; reason: SourceFailure };

export type StatsSnapshot = {
  site: SiteStats;
  ranking7d: ResourceRankingEntry[];
  dailyVisits: Array<{ date: string; visits: number }>;
  dailyResourceTotals: Array<{ date: string; views: number; downloads: number }>;
};

export type AnalyticsSnapshot = {
  periodStart: string;
  periodEnd: string;
  pageViews: number | null;
  visits: number | null;
  transferBytes: number | null;
  definition: string;
};

export type RosSnapshot = {
  bucket: string;
  periodStart: string;
  periodEnd: string;
  storedBytes: number | null;
  egressBytes: number | null;
  requests: number | null;
  definition: string;
};

export type DeploymentSnapshot = {
  repository: string;
  headSha: string;
  workflow: "pages.yml";
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "cancelled" | "skipped" | null;
  htmlUrl: string;
  updatedAt: string;
};

export type DashboardSnapshot = {
  schemaVersion: 1;
  generatedAt: string;
  sources: {
    stats: SourceResult<StatsSnapshot>;
    analytics: SourceResult<AnalyticsSnapshot>;
    ros: SourceResult<RosSnapshot>;
    pages: SourceResult<DeploymentSnapshot>;
  };
};

export interface OperatorSources {
  stats(): Promise<SourceResult<StatsSnapshot>>;
  analytics(): Promise<SourceResult<AnalyticsSnapshot>>;
  ros(): Promise<SourceResult<RosSnapshot>>;
  pages(): Promise<SourceResult<DeploymentSnapshot>>;
}

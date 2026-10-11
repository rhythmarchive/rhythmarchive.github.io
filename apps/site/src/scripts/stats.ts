import { getBrowserStatsClient, renderSiteStats, updateResourceStatsInDom } from "../lib/stats-client";

const client = getBrowserStatsClient();
void client.trackSiteVisit().then((stats) => renderSiteStats(stats));
void updateResourceStatsInDom(document);

// Direct navigation cannot confirm a completed transfer or browser save.

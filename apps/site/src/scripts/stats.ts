import { getBrowserStatsClient, renderSiteStats, updateResourceStatsInDom } from "../lib/stats-client";

const client = getBrowserStatsClient();
void client.trackSiteVisit().then((stats) => renderSiteStats(stats));
void updateResourceStatsInDom(document);

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const link = target.closest<HTMLElement>("[data-stats-download]");
  const resourceId = link?.dataset.resourceId;
  if (resourceId) void client.trackResourceDownload(resourceId);
});

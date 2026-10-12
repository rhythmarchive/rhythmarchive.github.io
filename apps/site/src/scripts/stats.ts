import { getBrowserStatsClient, renderSiteStats, updateResourceStatsInDom } from "../lib/stats-client";
import { onPageLoad } from "./page-lifecycle";

const client = getBrowserStatsClient();
const visit = client.trackSiteVisit();
onPageLoad(() => {
  void visit.then((stats) => renderSiteStats(stats));
  // Dynamic lists request their own stats after hydration, avoiding a request
  // for unrelated initial cards when restoring a filtered list.
  if (!document.querySelector("[data-gallery-root], [data-browse-gallery-root], [data-search-page], [data-detail-root]")) void updateResourceStatsInDom(document);
});

// Direct navigation cannot confirm a completed transfer or browser save.

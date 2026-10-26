import { getBrowserStatsClient, renderSiteStats, updateResourceStatsInDom } from "../lib/stats-client";
import { onPageLoad, pageSignal } from "./page-lifecycle";

const client = getBrowserStatsClient();
const visitIncludesDownloads = Boolean(document.querySelector("[data-site-total-downloads]"));
const visit = client.trackSiteVisit(visitIncludesDownloads);
let initialPage = true;
onPageLoad(() => {
  const initial = initialPage;
  initialPage = false;
  const signal = pageSignal();
  const wantsDownloads = Boolean(document.querySelector("[data-site-total-downloads]"));
  void visit.then(async stats => {
    if (signal.aborted) return;
    if (wantsDownloads && (!initial || !visitIncludesDownloads)) stats = await client.getSiteStats(true) ?? stats;
    if (!signal.aborted) renderSiteStats(stats);
  });
  // Dynamic lists request their own stats after hydration, avoiding a request
  // for unrelated initial cards when restoring a filtered list.
  if (!document.querySelector("[data-gallery-root], [data-browse-gallery-root], [data-search-page], [data-detail-root]")) void updateResourceStatsInDom(document);
});

// Direct navigation cannot confirm a completed transfer or browser save.

import { BASE_PATH, SITE_ORIGIN } from "../lib/site-config";
import { createUrlHelpers } from "../lib/url";

export function GET(): Response {
  const urls = createUrlHelpers({ basePath: BASE_PATH, origin: SITE_ORIGIN, rosBaseUrl: "https://rhythm-assets.cn-nb1.rains3.com" });
  return new Response(`User-agent: *\nAllow: /\nSitemap: ${urls.absoluteUrl("/sitemap.xml")}\n`, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}


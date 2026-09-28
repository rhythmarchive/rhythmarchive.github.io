import { urls } from "../lib/site-urls";

export function GET(): Response {

  return new Response(`User-agent: *\nAllow: /\nSitemap: ${urls.absoluteUrl("/sitemap.xml")}\n`, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

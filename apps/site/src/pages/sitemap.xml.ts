import { getSiteData } from "../lib/site-data";

import { urls } from "../lib/site-urls";

export function GET(): Response {
  const data = getSiteData();

  const paths = ["/", "/games/", "/search/", "/ranking/", "/updates/", "/feedback/", ...data.games.flatMap((game) => game.categories.map((category) => `/${game.slug}/${category.slug}/`)), ...data.resources.map((resource) => resource.route), ...data.updates.map((update) => `/updates/${update.id}/`)];
  const body = paths.map((pathname) => `<url><loc>${escapeXml(urls.absoluteUrl(pathname))}</loc></url>`).join("");
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</urlset>`, { headers: { "Content-Type": "application/xml; charset=utf-8" } });
}

function escapeXml(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&apos;");
}

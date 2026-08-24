import { BASE_PATH, ROS_BASE_URL, SITE_ORIGIN } from "../lib/site-config";
import { createUrlHelpers } from "../lib/url";

export function GET(): Response {
  const urls = createUrlHelpers({ basePath: BASE_PATH, origin: SITE_ORIGIN, rosBaseUrl: ROS_BASE_URL });
  const manifest = {
    name: "Rhythm Archive",
    short_name: "Rhythm Archive",
    description: "Arcaea、Phigros、Rizline 图片资源下载站",
    start_url: urls.sitePath("/"),
    scope: urls.sitePath("/"),
    display: "standalone",
    background_color: "#f5f8fc",
    theme_color: "#2d77d9",
    icons: [{ src: urls.sitePath("/favicon.svg"), sizes: "any", type: "image/svg+xml" }],
  };

  return new Response(JSON.stringify(manifest), {
    headers: {
      "Content-Type": "application/manifest+json; charset=utf-8",
    },
  });
}

import { getPublicNavigationGames } from "../lib/site-data";
import { urls } from "../lib/site-urls";

export function GET(): Response {

  const gameNames = getPublicNavigationGames().map((game) => game.displayName).join("、");
  const manifest = {
    name: "Rhythm Archive",
    short_name: "Rhythm Archive",
    description: `${gameNames} 图片资源下载站`,
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

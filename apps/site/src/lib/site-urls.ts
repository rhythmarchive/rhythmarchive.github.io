import { BASE_PATH, ROS_BASE_URL, SITE_ORIGIN } from "./site-config";
import { createUrlHelpers } from "./url";

// Build-time URL configuration for Astro pages and endpoint handlers.
// Browser scripts import only the pure helpers from url.ts and receive basePath from the page.
export const urls = createUrlHelpers({ basePath: BASE_PATH, origin: SITE_ORIGIN, rosBaseUrl: ROS_BASE_URL });

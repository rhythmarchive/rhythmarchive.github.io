import type { APIRoute } from "astro";
import { urls } from "../../../../lib/site-urls";
export const GET: APIRoute = () => Response.redirect(urls.absoluteUrl("/data/batch/phigros/story-cg.json"), 301);

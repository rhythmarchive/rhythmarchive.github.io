import type { APIRoute } from "astro";
import { getSiteData } from "../../../../lib/site-data";
import { batchDownloads } from "../../../../lib/gallery-projection";
import { phigrosCgPreviewResources } from "../../../../lib/phigros-cg-preview";

export const GET: APIRoute = () => new Response(JSON.stringify(batchDownloads([
  ...(import.meta.env.DEV ? phigrosCgPreviewResources() : []),
  ...(getSiteData().galleries["phigros/story-cg"] ?? []),
])), { headers: { "Content-Type": "application/json" } });

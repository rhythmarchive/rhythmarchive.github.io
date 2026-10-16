import { announcements } from "../../data/announcements";

// History is requested only when the visitor expands it, never on page load.
export function GET(): Response {
  return Response.json(announcements.slice(1));
}

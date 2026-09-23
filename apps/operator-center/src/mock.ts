import type { OperatorSources } from "./contracts.js";
import { unavailable } from "./server/collect.js";

/** Local development only. No production provider silently falls back to mock values. */
export const mockSources: OperatorSources = {
  stats: async () => unavailable("not-configured"),
  analytics: async () => unavailable("not-configured"),
  ros: async () => unavailable("not-configured"),
  pages: async () => unavailable("not-configured"),
};

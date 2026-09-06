import { handleRequest } from "./core.js";
import type { Env } from "./core.js";

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};

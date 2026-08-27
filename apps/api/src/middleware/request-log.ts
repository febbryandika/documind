import { createMiddleware } from "hono/factory";
import type { SessionEnv } from "./session";

/**
 * One JSON line per request. No logging dependency: Fly collects stdout, and a
 * structured line is the whole requirement.
 *
 * What is deliberately absent is as load-bearing as what is here. No query
 * string, no headers and no body — /api/auth/* carries credentials on all
 * three, and a log that quietly accumulates them is worse than no log.
 */
export const requestLog = createMiddleware<SessionEnv>(async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set("requestId", requestId);
  // Echoed back so a user who hits the generic 500 from app.onError has
  // something to quote, and so that line can actually be found again.
  c.header("x-request-id", requestId);

  const start = performance.now();
  await next();

  console.log(
    JSON.stringify({
      level: "info",
      requestId,
      method: c.req.method,
      // routePath, not the URL: /documents/:id/chat keeps one log line per
      // route instead of one per document.
      route: c.req.routePath,
      status: c.res.status,
      ms: Math.round(performance.now() - start),
      // SessionEnv types this as always present, but it is only set on routes
      // that mount sessionMiddleware — everywhere else it is genuinely absent.
      userId: (c.get("user") as SessionEnv["Variables"]["user"] | undefined)
        ?.id,
    }),
  );
});

import { Hono } from "hono";
import { cors } from "hono/cors";
import { auth, webOrigin } from "./auth";
import { sessionMiddleware, type SessionEnv } from "./middleware/session";

// Routes must be chained, not registered as separate `app.get(...)` statements:
// Hono RPC only infers `AppType` from the chained builder.
//
// SessionEnv is declared on the app so `c.get("user")` is typed; it is only
// actually populated on routes that mount sessionMiddleware.
const app = new Hono<SessionEnv>()
  // Sessions are httpOnly cookies, so the browser only sends them when the exact
  // web origin is allowed with credentials (SPEC §14). Never a wildcard.
  .use("*", cors({ origin: webOrigin, credentials: true }))
  .all("/api/auth/*", (c) => auth.handler(c.req.raw))
  .get("/health", (c) => c.json({ status: "ok" }))
  .get("/me", sessionMiddleware, (c) => {
    const user = c.get("user");
    return c.json({ id: user.id, email: user.email, name: user.name });
  });

export { app };

// SPEC §5 — apps/web imports this *type only* to build the hc<AppType> client.
export type AppType = typeof app;

export default {
  port: Number(process.env.PORT ?? 3001),
  fetch: app.fetch,
};

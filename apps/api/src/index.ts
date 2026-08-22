import { Hono } from "hono";

// Routes must be chained, not registered as separate `app.get(...)` statements:
// Hono RPC only infers `AppType` from the chained builder.
const app = new Hono().get("/health", (c) => c.json({ status: "ok" }));

export { app };

// SPEC §5 — apps/web imports this *type only* to build the hc<AppType> client.
export type AppType = typeof app;

export default {
  port: Number(process.env.PORT ?? 3001),
  fetch: app.fetch,
};

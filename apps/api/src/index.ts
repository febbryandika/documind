import { Hono } from "hono";
import { cors } from "hono/cors";
import { auth, webOrigin } from "./auth";
import { sessionMiddleware, type SessionEnv } from "./middleware/session";
import { failStaleIngests } from "./rag/ingest";
import { chatRoutes } from "./routes/chat";
import { documentsRoutes } from "./routes/documents";

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
  })
  .route("/documents", documentsRoutes)
  // Mounted at the same prefix on purpose: /:id/chat and /:id/messages belong
  // to the document they hang off, but they are a different concern from CRUD.
  // Hono merges the two schemas, so AppType still carries both.
  .route("/documents", chatRoutes);

export { app };

// SPEC §5 — apps/web imports this *type only* to build the hc<AppType> client.
export type AppType = typeof app;

// The one other type apps/web imports. It describes the shape of the chat
// stream's data-sources part, which no route signature can express.
export type { DocumentUIMessage, Source } from "./routes/chat";

// SPEC §3.2 — a process that died mid-ingest leaves rows stuck in 'processing'
// with no worker behind them, and the detail page polls such a row forever.
// Guarded on import.meta.main so it fires for `bun run src/index.ts` but not
// under vitest, where the test file is the entrypoint and node leaves
// import.meta.main undefined. Read through a cast rather than directly: that
// flag is Bun's, and apps/web typechecks this file via its type-only AppType
// import (SPEC §5) without bun types on its side.
if ((import.meta as { main?: boolean }).main) {
  void failStaleIngests().then((swept) => {
    if (swept > 0) console.log(`Failed ${swept} document(s) left by a restart`);
  });
}

export default {
  port: Number(process.env.PORT ?? 3001),
  fetch: app.fetch,
};

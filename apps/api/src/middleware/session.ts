import { createMiddleware } from "hono/factory";
import { auth } from "../auth";

// SPEC §3.1 / §14: every document and chat route resolves the session here and
// scopes its queries by this userId. Ownership is never inferred from the client.
// Exported so routes/documents.ts and routes/chat.ts share one Env.
export type SessionEnv = {
  Variables: {
    user: typeof auth.$Infer.Session.user;
    session: typeof auth.$Infer.Session.session;
    // Set by requestLog before anything else runs, so it is available on every
    // route including the ones with no session. It lives here because SessionEnv
    // is the single Env all three routers are generic over.
    requestId: string;
  };
};

export const sessionMiddleware = createMiddleware<SessionEnv>(
  async (c, next) => {
    const data = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!data) return c.json({ error: "Unauthorized" }, 401);

    c.set("user", data.user);
    c.set("session", data.session);
    await next();
  },
);

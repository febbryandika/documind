import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

// Importing the real ../auth would construct Better Auth and, through ../db,
// open a Postgres pool (and throw outright when DATABASE_URL is unset). vi.mock
// is hoisted above the imports, so the spy has to come from vi.hoisted or it
// would still be in its temporal dead zone when the factory runs.
const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("../auth", () => ({ auth: { api: { getSession } } }));

import { sessionMiddleware, type SessionEnv } from "./session";

const app = new Hono<SessionEnv>().get("/protected", sessionMiddleware, (c) =>
  c.json({ id: c.get("user").id }),
);

describe("sessionMiddleware", () => {
  it("rejects a request with no session", async () => {
    getSession.mockResolvedValue(null);

    const res = await app.request("/protected");

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("puts the user on context for an authenticated request", async () => {
    getSession.mockResolvedValue({
      user: { id: "user_1", email: "demo@documind.app", name: "Demo" },
      session: { id: "session_1", userId: "user_1" },
    });

    const res = await app.request("/protected", {
      headers: { cookie: "better-auth.session_token=stub" },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ id: "user_1" });
  });
});

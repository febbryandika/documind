import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import { blockDemoUser, DEMO_BLOCKED_ERROR } from "./demo-user";
import type { SessionEnv } from "./session";

// Like rate-limit.test.ts: no ../auth mock, because this middleware only reads
// what sessionMiddleware already put on the context.
const app = new Hono<SessionEnv>()
  .use("*", async (c, next) => {
    c.set("user", {
      id: "user_1",
      email: c.req.header("x-test-email") ?? "someone@example.com",
    } as SessionEnv["Variables"]["user"]);
    await next();
  })
  .post("/documents", blockDemoUser, (c) => c.json({ ok: true }))
  .delete("/documents/:id", blockDemoUser, (c) => c.json({ ok: true }))
  .get("/documents", (c) => c.json({ ok: true }));

const as = (email: string, path = "/documents", method = "POST") =>
  app.request(path, { method, headers: { "x-test-email": email } });

describe("blockDemoUser", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("blocks the demo account from uploading", async () => {
    vi.stubEnv("DEMO_USER_EMAIL", "demo@documind.app");

    const res = await as("demo@documind.app");

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: DEMO_BLOCKED_ERROR });
  });

  it("blocks the demo account from deleting", async () => {
    vi.stubEnv("DEMO_USER_EMAIL", "demo@documind.app");

    const res = await as("demo@documind.app", "/documents/doc_1", "DELETE");

    expect(res.status).toBe(403);
  });

  it("lets every other account through", async () => {
    vi.stubEnv("DEMO_USER_EMAIL", "demo@documind.app");

    expect((await as("owner@example.com")).status).toBe(200);
  });

  it("leaves reading open to the demo account", async () => {
    vi.stubEnv("DEMO_USER_EMAIL", "demo@documind.app");

    // SPEC §11 blocks upload and delete only — a reviewer still lists, opens
    // and asks questions, which is the entire point of the demo.
    const res = await as("demo@documind.app", "/documents", "GET");

    expect(res.status).toBe(200);
  });

  // The regression this middleware was shaped around: demo@documind.app is the
  // throwaway mock session email in four other suites. With DEMO_USER_EMAIL
  // unset the guard has to be inert, or those suites start 403ing.
  it("is inert when DEMO_USER_EMAIL is unset", async () => {
    delete process.env.DEMO_USER_EMAIL;

    expect((await as("demo@documind.app")).status).toBe(200);
  });
});

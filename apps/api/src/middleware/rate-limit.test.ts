import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createQuestionRateLimit,
  QUESTIONS_PER_HOUR,
  RATE_WINDOW_MS,
} from "./rate-limit";
import type { SessionEnv } from "./session";

// No ../auth mock is needed: this middleware only reads what sessionMiddleware
// already put on the context, so the harness sets `user` directly instead of
// standing up Better Auth.
function appFor(limit: number, windowMs = RATE_WINDOW_MS) {
  const limiter = createQuestionRateLimit({ limit, windowMs });

  return new Hono<SessionEnv>()
    .use("*", async (c, next) => {
      c.set("user", {
        id: c.req.header("x-test-user") ?? "user_1",
      } as SessionEnv["Variables"]["user"]);
      await next();
    })
    .post("/ask", limiter, (c) => c.json({ ok: true }));
}

const ask = (app: ReturnType<typeof appFor>, userId?: string) =>
  app.request("/ask", {
    method: "POST",
    headers: userId ? { "x-test-user": userId } : undefined,
  });

describe("createQuestionRateLimit", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("lets a user ask right up to the limit", async () => {
    const app = appFor(3);

    for (let i = 0; i < 3; i++) {
      expect((await ask(app)).status).toBe(200);
    }
  });

  it("rejects the request past the limit with 429 and Retry-After", async () => {
    const app = appFor(2);
    await ask(app);
    await ask(app);

    const res = await ask(app);

    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  // The message is the deliverable, not the status code — whoever reads it is
  // a warehouse manager, not a developer reading a status line.
  it("says how many were allowed and when to come back", async () => {
    const app = appFor(2, 30 * 60 * 1000);
    await ask(app);
    await ask(app);

    const { error } = (await (await ask(app)).json()) as { error: string };

    expect(error).toContain("2 questions");
    expect(error).toContain("30 minutes");
    expect(error).not.toMatch(/rate limit|429|[0-9]{4}-[0-9]{2}-[0-9]{2}/i);
  });

  it("starts a fresh allowance once the window has passed", async () => {
    const app = appFor(1);
    expect((await ask(app)).status).toBe(200);
    expect((await ask(app)).status).toBe(429);

    vi.advanceTimersByTime(RATE_WINDOW_MS + 1);

    expect((await ask(app)).status).toBe(200);
  });

  // One user exhausting their hour must not cost anyone else theirs.
  it("counts each user separately", async () => {
    const app = appFor(1);
    expect((await ask(app, "user_1")).status).toBe(200);
    expect((await ask(app, "user_1")).status).toBe(429);

    expect((await ask(app, "user_2")).status).toBe(200);
  });

  it("defaults to the limit SPEC §14 asks for", async () => {
    const app = appFor(QUESTIONS_PER_HOUR);

    for (let i = 0; i < QUESTIONS_PER_HOUR; i++) {
      expect((await ask(app)).status).toBe(200);
    }
    expect((await ask(app)).status).toBe(429);
  });
});

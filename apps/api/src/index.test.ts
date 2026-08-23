import { describe, expect, it, vi } from "vitest";

// index.ts imports ./auth, which reaches ./db and throws without DATABASE_URL.
// `bun run test` executes vitest under node, which does not auto-load .env the
// way Bun does, so the module is mocked to keep these tests hermetic and free of
// a real database. vi.hoisted is needed because vi.mock is hoisted above imports.
const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("./auth", () => ({
  auth: { api: { getSession }, handler: vi.fn() },
  webOrigin: "http://localhost:3000",
}));

import { app } from "./index";

describe("GET /health", () => {
  it("returns ok", async () => {
    const res = await app.request("/health");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "ok" });
  });
});

describe("GET /me", () => {
  it("is guarded by the session middleware", async () => {
    getSession.mockResolvedValue(null);

    const res = await app.request("/me");

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("returns the signed-in user", async () => {
    getSession.mockResolvedValue({
      user: { id: "user_1", email: "demo@documind.app", name: "Demo" },
      session: { id: "session_1", userId: "user_1" },
    });

    const res = await app.request("/me");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      id: "user_1",
      email: "demo@documind.app",
      name: "Demo",
    });
  });
});

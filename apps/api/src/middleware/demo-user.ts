import { createMiddleware } from "hono/factory";
import type { SessionEnv } from "./session";

/** Surfaced to the user by apps/web's errorMessage(), so it reads as a sentence. */
export const DEMO_BLOCKED_ERROR =
  "The demo account is read-only — sign up to upload your own documents.";

/**
 * SPEC §11 — upload and delete are blocked for the demo account so the public
 * demo cannot be wrecked. Everything else stays open: a reviewer still lists,
 * reads and asks questions.
 *
 * Keyed on DEMO_USER_EMAIL rather than a hardcoded "demo@documind.app" for a
 * concrete reason: that address is already the throwaway mock session email in
 * four existing suites (routes/documents.test.ts, routes/chat.test.ts,
 * middleware/session.test.ts, index.test.ts). Hardcoding it would 403 the
 * upload and delete tests. Unset — locally and under vitest — this middleware
 * is inert; set on Fly, it blocks. src/db/seed.ts reads the same variable, so
 * the account it creates and the account this blocks cannot drift apart.
 *
 * Read per request rather than at module eval so a test can stub the variable
 * without controlling import order.
 */
export const blockDemoUser = createMiddleware<SessionEnv>(async (c, next) => {
  const demoEmail = process.env.DEMO_USER_EMAIL;

  if (demoEmail && c.get("user").email === demoEmail) {
    return c.json({ error: DEMO_BLOCKED_ERROR }, 403);
  }

  await next();
});

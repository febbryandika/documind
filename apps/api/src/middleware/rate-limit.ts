import { createMiddleware } from "hono/factory";
import type { SessionEnv } from "./session";

/** SPEC §14. */
export const QUESTIONS_PER_HOUR = 20;
export const RATE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Distinct users tracked before expired windows are swept. Nothing here expires
 * on a timer — a setInterval would keep the process alive and give the tests
 * something to fight — so the map is pruned opportunistically on write.
 */
const SWEEP_ABOVE = 1000;

type Window = { count: number; resetAt: number };

/**
 * SPEC §14 — 20 questions per hour per user, enforced in Hono middleware.
 *
 * The counter is an in-memory Map and therefore **per process**. SPEC §1 rules
 * out Redis, and the API runs as one Fly machine with min_machines_running = 1
 * (SPEC §11), so today that is the whole system. A second instance would give
 * each its own allowance; that limitation is documented in the README rather
 * than engineered around.
 *
 * A factory rather than a module-level singleton so the tests can build a small
 * limiter with its own state, instead of firing 20 requests or reaching into a
 * reset() back door that exists only for them.
 */
export function createQuestionRateLimit({
  limit = QUESTIONS_PER_HOUR,
  windowMs = RATE_WINDOW_MS,
}: { limit?: number; windowMs?: number } = {}) {
  const windows = new Map<string, Window>();

  return createMiddleware<SessionEnv>(async (c, next) => {
    const userId = c.get("user").id;
    const now = Date.now();

    const previous = windows.get(userId);
    // An expired window is replaced rather than mutated, which is also what
    // keeps a long-idle user from carrying an old count into a new hour.
    const window =
      previous && previous.resetAt > now
        ? previous
        : { count: 0, resetAt: now + windowMs };

    if (window.count >= limit) {
      const remainingMs = window.resetAt - now;
      c.header("Retry-After", String(Math.ceil(remainingMs / 1000)));
      return c.json({ error: overLimitMessage(limit, remainingMs) }, 429);
    }

    // Counted on the attempt, before the handler runs: the point is to bound
    // what can be spent at OpenAI, and by the time the handler has an answer
    // the money is gone.
    window.count += 1;
    windows.set(userId, window);
    if (windows.size > SWEEP_ABOVE) sweep(windows, now);

    await next();
  });
}

/**
 * Whoever reads this is not a developer — no timestamps, no timezones, and no
 * "rate limit exceeded". Just how many, and when they can carry on.
 */
function overLimitMessage(limit: number, remainingMs: number) {
  const minutes = Math.ceil(remainingMs / 60_000);
  const when = minutes <= 1 ? "in less than a minute" : `in ${minutes} minutes`;
  return `You've asked ${limit} questions in the last hour, which is the limit. You can ask again ${when}.`;
}

function sweep(windows: Map<string, Window>, now: number) {
  for (const [userId, window] of windows) {
    if (window.resetAt <= now) windows.delete(userId);
  }
}

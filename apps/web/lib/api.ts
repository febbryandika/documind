import { hc } from "hono/client";
// SPEC §5 — type-only. A value import from apps/api would break the two-deploy
// split, since the web bundle would then pull in the API's server dependencies.
import type { AppType } from "@api/index";

// credentials: 'include' is what actually sends the httpOnly Better Auth session
// cookie across the origin boundary to the Hono API (SPEC §14).
export const api = hc<AppType>(process.env.NEXT_PUBLIC_API_URL!, {
  init: { credentials: "include" },
});

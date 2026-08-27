import { createAuthClient } from "better-auth/react";

// Better Auth runs on the Hono API, not on Next (SPEC §3.1), so the client
// points at the API.
//
// /api/auth is spelled out rather than left to the client to append. Better
// Auth only appends its base path when baseURL is a bare origin: given a URL
// that already carries a path — which is exactly what the production
// NEXT_PUBLIC_API_URL is, since it ends in the /api-proxy rewrite prefix from
// next.config.ts — it treats that path as the complete auth base and silently
// drops /api/auth, sending sign-in to /api-proxy/sign-in/email. Passing the
// suffix explicitly produces the same URL in both environments.
export const authClient = createAuthClient({
  baseURL: `${process.env.NEXT_PUBLIC_API_URL}/api/auth`,
  fetchOptions: { credentials: "include" },
});

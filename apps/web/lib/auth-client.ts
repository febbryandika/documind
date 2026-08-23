import { createAuthClient } from "better-auth/react";

// Better Auth runs on the Hono API, not on Next (SPEC §3.1), so the client points
// at the API origin and appends its own /api/auth base path.
export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_API_URL,
  fetchOptions: { credentials: "include" },
});

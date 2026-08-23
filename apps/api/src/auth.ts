import { betterAuth } from "better-auth";

// Phase 2 needs only enough config for `auth generate` to emit the database
// schema. SPEC §3.1 / build-order step 2 owns the real wiring: the Drizzle
// adapter, CORS, trustedOrigins, and mounting the handler at /api/auth/*.
export const auth = betterAuth({ emailAndPassword: { enabled: true } });

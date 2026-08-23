import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "./db";
import { account, session, user, verification } from "./db/schema";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — see apps/api/.env.example`);
  return value;
};

const baseURL = required("BETTER_AUTH_URL");

// Exported because CORS and trustedOrigins are one policy, not two (SPEC §14).
export const webOrigin = required("WEB_ORIGIN");

// Vercel and Fly are different sites, so the default SameSite=Lax cookie would be
// dropped on every cross-origin request in production. Locally both apps sit on
// localhost — cookies ignore port, so Lax is correct there, and SameSite=None
// would need a Secure cookie we cannot set over http.
const crossSite = baseURL.startsWith("https://");

export const auth = betterAuth({
  baseURL,
  secret: required("BETTER_AUTH_SECRET"),
  trustedOrigins: [webOrigin],
  // db is drizzle(client) without { schema } by design — see the note in
  // db/schema.ts — so the four auth tables are handed over explicitly. Names are
  // singular and snake_case, which are the adapter defaults: no usePlural,
  // no camelCase.
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: { user, session, account, verification },
  }),
  emailAndPassword: { enabled: true },
  ...(crossSite && {
    advanced: { defaultCookieAttributes: { sameSite: "none", secure: true } },
  }),
});

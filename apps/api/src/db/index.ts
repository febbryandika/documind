import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

// Bun loads apps/api/.env automatically — no dotenv package.
const url = process.env.DATABASE_URL;
if (!url)
  throw new Error("DATABASE_URL is not set — see apps/api/.env.example");

// `bun run --hot` re-evaluates this module on every save without restarting the
// process, so a bare postgres(url) would open a fresh pool per save and leak its
// sockets across a dev session. globalThis survives a hot reload.
const cache = globalThis as unknown as {
  __documindClient?: ReturnType<typeof postgres>;
};

// Exported so one-shot scripts (src/db/seed.ts, eval/run.ts) can await
// client.end() — without it a Bun script that queries the DB never exits.
export const client =
  cache.__documindClient ??
  postgres(url, {
    // Neon's -pooler host is PgBouncer in transaction mode. Drizzle only ever
    // issues unnamed statements, so this guards any raw client`...` added later.
    prepare: false,
    // Neon suspends idle computes and drops the socket; retire connections
    // ourselves rather than discovering it on the next query.
    idle_timeout: 20,
  });

if (process.env.NODE_ENV !== "production") cache.__documindClient = client;

// SPEC §6 needs db.transaction(), which is why this is postgres-js and not the
// @neondatabase/serverless HTTP driver — that one cannot run multi-statement
// transactions.
export const db = drizzle(client);

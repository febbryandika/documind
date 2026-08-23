import { defineConfig } from "drizzle-kit";

// Bun loads apps/api/.env and spawned children inherit process.env — no dotenv needed.
const url = process.env.DATABASE_URL;
if (!url)
  throw new Error("DATABASE_URL is not set — see apps/api/.env.example");

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url },
});

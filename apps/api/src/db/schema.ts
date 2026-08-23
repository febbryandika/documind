import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from "drizzle-orm/pg-core";
import { createId } from "@paralleldrive/cuid2";

// ---------------------------------------------------------------------------
// Better Auth (SPEC §4). Generated with:
//   bunx auth@1.7.1 generate --config src/auth.ts --adapter drizzle \
//     --dialect postgresql --output ./auth-schema.ts --yes
//
// Regenerate with that exact command on a Better Auth upgrade and re-merge —
// the CLI is the package `auth`, NOT `@better-auth/cli` (frozen at 1.4.21,
// which omits the required `account.issuer` column).
//
// Two things are kept verbatim from the generator so this block stays
// regenerable: timestamps are `timestamp`, not the `timestamptz` used by our
// own tables below, and index names are camelCase inside snake_case.
// The generator's relations() helpers are dropped: drizzle-kit ignores them
// for migrations and we do not pass { schema } to drizzle().
// ---------------------------------------------------------------------------

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    issuer: text("issuer").notNull(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("account_issuer_accountId_uidx").on(
      table.issuer,
      table.accountId,
    ),
    index("account_userId_idx").on(table.userId),
  ],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

// ---------------------------------------------------------------------------
// Application tables (SPEC §4).
//
// The `enum` option on text() is TYPE-LEVEL ONLY — it emits plain `text` with
// no CHECK constraint. That is deliberate and matches SPEC §4; runtime
// enforcement is @hono/zod-validator on the routes (SPEC §5).
// ---------------------------------------------------------------------------

export const documents = pgTable(
  "documents",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    category: text("category", {
      enum: ["contract", "manual", "procedure", "other"],
    })
      .notNull()
      .default("other"),
    language: text("language", { enum: ["en", "ja", "mixed"] }), // detected at ingest
    status: text("status", { enum: ["processing", "ready", "failed"] })
      .notNull()
      .default("processing"),
    error: text("error"),
    pageCount: integer("page_count"),
    chunkCount: integer("chunk_count"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("documents_user_created_idx").on(t.userId, t.createdAt),
    index("documents_category_idx").on(t.userId, t.category),
  ],
);

export const chunks = pgTable(
  "chunks",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    pageNumber: integer("page_number").notNull(),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: 1536 }).notNull(),
  },
  (t) => [
    index("chunks_embedding_idx").using(
      "hnsw",
      t.embedding.op("vector_cosine_ops"),
    ),
    index("chunks_document_idx").on(t.documentId),
  ],
);

export const messages = pgTable("messages", {
  id: text("id").primaryKey().$defaultFn(createId),
  documentId: text("document_id")
    .notNull()
    .references(() => documents.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["user", "assistant"] }).notNull(),
  content: text("content").notNull(),
  sources:
    jsonb("sources").$type<
      { chunkId: string; pageNumber: number; excerpt: string }[]
    >(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

import { zValidator } from "@hono/zod-validator";
import { and, count, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import * as z from "zod";
import { db } from "../db";
import { documents } from "../db/schema";
import { sessionMiddleware, type SessionEnv } from "../middleware/session";

export const CATEGORIES = ["contract", "manual", "procedure", "other"] as const;
export const STATUSES = ["processing", "ready", "failed"] as const;

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // SPEC §14
// Every PDF starts with this five-byte header. The declared Content-Type is
// attacker-controlled — and Bun derives file.type from the filename extension
// rather than the part header anyway — so the type check is a cheap first pass
// and these bytes are what actually decide.
const PDF_MAGIC = "%PDF-";

// `text({ enum })` in the schema is type-level only — no DB CHECK constraint —
// so these zod enums are the actual runtime enforcement (SPEC §5).
const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  category: z.enum(CATEGORIES).optional(),
  status: z.enum(STATUSES).optional(),
});

const uploadForm = z.object({
  file: z.instanceof(File, { error: "A PDF file is required" }),
  category: z.enum(CATEGORIES).default("other"),
});

// The response shape for all four routes. userId is deliberately absent: the
// caller is the owner by construction, so echoing it back adds nothing.
const documentColumns = {
  id: documents.id,
  filename: documents.filename,
  category: documents.category,
  language: documents.language,
  status: documents.status,
  error: documents.error,
  pageCount: documents.pageCount,
  chunkCount: documents.chunkCount,
  createdAt: documents.createdAt,
};

/**
 * Filters for the list query. userId is always the first condition and always
 * comes from the session — ownership is never inferred from the client
 * (SPEC §14). Exported because it is the unit under test for the combined
 * category + status case.
 */
export function documentFilters(
  userId: string,
  filters: {
    category?: (typeof CATEGORIES)[number];
    status?: (typeof STATUSES)[number];
  },
) {
  const conditions = [eq(documents.userId, userId)];
  if (filters.category)
    conditions.push(eq(documents.category, filters.category));
  if (filters.status) conditions.push(eq(documents.status, filters.status));
  return conditions;
}

// zValidator("form") calls parseBody(), which buffers the whole body — so a cap
// enforced on file.size afterwards has already paid the memory cost. Rejecting
// on Content-Length first is what actually bounds an upload.
const limitBodySize = createMiddleware(async (c, next) => {
  const declared = Number(c.req.header("content-length"));
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    return c.json({ error: "File must be 10MB or smaller" }, 413);
  }
  await next();
});

export const documentsRoutes = new Hono<SessionEnv>()
  .use("*", sessionMiddleware)

  // SPEC §3.3 — offset pagination, optional filters, newest first.
  .get("/", zValidator("query", listQuery), async (c) => {
    const { page, limit, category, status } = c.req.valid("query");
    const where = and(
      ...documentFilters(c.get("user").id, { category, status }),
    );

    // `total` is a real count over the same filters, not items.length — the
    // page size would otherwise cap it at `limit`.
    const [items, totals] = await Promise.all([
      db
        .select(documentColumns)
        .from(documents)
        .where(where)
        .orderBy(desc(documents.createdAt))
        .limit(limit)
        .offset((page - 1) * limit),
      db.select({ value: count() }).from(documents).where(where),
    ]);

    return c.json({ items, total: totals[0]?.value ?? 0, page, limit });
  })

  // SPEC §3.2 steps 1-2. Ingest lands in build-order step 5; until then the row
  // stays 'processing' forever, which is the expected end state for this phase.
  .post("/", limitBodySize, zValidator("form", uploadForm), async (c) => {
    const { file, category } = c.req.valid("form");

    if (file.type !== "application/pdf") {
      return c.json({ error: "Only PDF files are accepted" }, 415);
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return c.json({ error: "File must be 10MB or smaller" }, 413);
    }

    // Not file.slice(): bun-types omits slice() from its Blob interface. Reading
    // the whole buffer costs nothing extra here — parseBody has already
    // materialised it, and limitBodySize bounds it to 10MB.
    const header = new Uint8Array(await file.arrayBuffer()).subarray(
      0,
      PDF_MAGIC.length,
    );
    if (new TextDecoder().decode(header) !== PDF_MAGIC) {
      return c.json({ error: "That file is not a PDF" }, 415);
    }

    const [row] = await db
      .insert(documents)
      .values({
        userId: c.get("user").id,
        filename: file.name,
        category,
      })
      .returning(documentColumns);

    if (!row) return c.json({ error: "Could not create the document" }, 500);

    // The buffer is intentionally dropped here — there is no blob storage
    // (SPEC §1), and nothing reads the PDF until ingest exists.
    return c.json(row, 202);
  })

  // A document owned by someone else must be indistinguishable from one that
  // does not exist, so both of these 404 rather than 403.
  .get("/:id", async (c) => {
    const [row] = await db
      .select(documentColumns)
      .from(documents)
      .where(
        and(
          eq(documents.id, c.req.param("id")),
          eq(documents.userId, c.get("user").id),
        ),
      )
      .limit(1);

    if (!row) return c.json({ error: "Not found" }, 404);
    return c.json(row);
  })

  // chunks and messages cascade at the DB level (SPEC §4) — no manual cleanup.
  .delete("/:id", async (c) => {
    const [row] = await db
      .delete(documents)
      .where(
        and(
          eq(documents.id, c.req.param("id")),
          eq(documents.userId, c.get("user").id),
        ),
      )
      .returning({ id: documents.id });

    if (!row) return c.json({ error: "Not found" }, 404);
    return c.json({ id: row.id });
  });

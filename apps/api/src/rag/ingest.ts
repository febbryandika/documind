// SPEC §6 — extract → chunk → embed → store, plus the in-process worker that
// owns it. There is no queue (SPEC §1): the Hono API is a long-lived Bun
// process, which is the entire reason it is not serverless.
import { openai } from "@ai-sdk/openai";
import { embedMany } from "ai";
import { and, eq, lt } from "drizzle-orm";
import { db } from "../db";
import { chunks, documents } from "../db/schema";
import { chunkPage, detectLanguage } from "./chunk";
import { extractPdfText, NO_TEXT_ERROR } from "./extract";

/** SPEC §14 — bounds embedding cost per document. */
export const MAX_PAGES = 200;

/**
 * SPEC §6. Not redundant with the SDK, which only splits at the model's
 * maxEmbeddingsPerCall (2048 for OpenAI): at 100 this loop is what batches, and
 * it is what bounds how many vectors are held in memory at once.
 */
const EMBED_BATCH = 100;

/**
 * Chunk rows bind 5 parameters each — drizzle serialises a vector(1536) to one
 * JSON text parameter, not 1536 — so Postgres's 65,535-parameter ceiling only
 * bites at ~13,000 rows, far past what 200 pages can produce. Slicing is about
 * memory: at the page cap one statement is ~34MB of bind payload, doubled by
 * the two concurrent ingests, on one shared-cpu machine (SPEC §11). Atomicity
 * is a property of the transaction, not the statement count, so SPEC §6's
 * invariant is untouched.
 */
const INSERT_BATCH = 500;

/** SPEC §3.2 — the cap on concurrent ingests; the rest wait in `waiting`. */
const MAX_CONCURRENT_INGESTS = 2;

/** SPEC §3.2 — how long a 'processing' row may live before a boot sweep fails it. */
export const STALE_INGEST_MS = 10 * 60 * 1000;

/**
 * These are UI copy, not log lines: documents.error is rendered verbatim to the
 * user (apps/web/components/document-detail.tsx), directly under "This document
 * could not be processed" and directly above "Delete it and upload the file
 * again." — so each states a cause and nothing else.
 */
export const PAGE_LIMIT_ERROR = `This PDF has more than ${MAX_PAGES} pages — split it into smaller files`;

export const EMBED_ERROR =
  "Could not generate embeddings — the OpenAI request failed";

export const INGEST_ERROR =
  "Could not process this PDF — it may be damaged or password-protected";

export const STALE_INGEST_ERROR =
  "Processing was interrupted by a server restart";

/**
 * Only messages this module chose reach documents.error. A missing key produces
 * a message naming the env var, an OpenAI 401 body echoes a key prefix, and
 * pdf.js says "Invalid PDF structure." — none of that is copy, and the first
 * two would render a fragment of a secret into the browser.
 */
const USER_FACING: string[] = [NO_TEXT_ERROR, PAGE_LIMIT_ERROR, EMBED_ERROR];

const userMessage = (error: unknown) =>
  error instanceof Error && USER_FACING.includes(error.message)
    ? error.message
    : INGEST_ERROR;

/**
 * SPEC §6. Never throws: the caller already has its 202 (SPEC §3.2), so the row
 * is the only channel a failure can be reported through.
 */
export async function ingest(documentId: string, data: Uint8Array) {
  try {
    const { totalPages, pages } = await extractPdfText(data);

    // Before chunking and before the first embedMany, which is what makes this
    // a cost guard. It cannot live in the upload route: totalPages is not
    // knowable without parsing, and parsing on the request path is the exact
    // work the second server exists to keep off it.
    if (totalPages > MAX_PAGES) throw new Error(PAGE_LIMIT_ERROR);

    const pieces = pages.flatMap((page, i) => chunkPage(page, i + 1));
    if (pieces.length === 0) throw new Error(NO_TEXT_ERROR);

    // Embed everything first. Holding a Postgres transaction open across calls
    // to OpenAI would pin a connection for minutes (SPEC §6).
    const rows: (typeof chunks.$inferInsert)[] = [];
    for (let i = 0; i < pieces.length; i += EMBED_BATCH) {
      const batch = pieces.slice(i, i + EMBED_BATCH);
      const { embeddings } = await embedMany({
        model: openai.textEmbeddingModel("text-embedding-3-small"),
        values: batch.map((piece) => piece.content),
      }).catch(() => {
        throw new Error(EMBED_ERROR);
      });

      rows.push(
        ...batch.map((piece, j) => {
          const embedding = embeddings[j];
          if (!embedding) throw new Error(EMBED_ERROR);
          return {
            documentId,
            pageNumber: piece.pageNumber,
            content: piece.content,
            embedding,
          };
        }),
      );
    }

    // One transaction: a document is never 'ready' with partial chunks, and a
    // crash mid-insert leaves no orphans (SPEC §6).
    await db.transaction(async (tx) => {
      for (let i = 0; i < rows.length; i += INSERT_BATCH) {
        await tx.insert(chunks).values(rows.slice(i, i + INSERT_BATCH));
      }

      // Scoped by id alone, deliberately. A rolling deploy can boot the sweep
      // while the old machine is still finishing this job; re-asserting
      // status = 'processing' here would leave that document 'failed' on top of
      // a complete set of chunks.
      await tx
        .update(documents)
        .set({
          status: "ready",
          pageCount: totalPages,
          chunkCount: rows.length,
          language: detectLanguage(pages.join("")),
        })
        .where(eq(documents.id, documentId));
    });
  } catch (error) {
    await db
      .update(documents)
      .set({ status: "failed", error: userMessage(error) })
      .where(eq(documents.id, documentId));
  }
}

let active = 0;
const waiting: (() => void)[] = [];

/**
 * Hands a finished ingest's slot straight to the head of the queue instead of
 * freeing it and letting the next arrival re-take it.
 *
 * The naive form — `active--; waiting.shift()?.()` — leaves the slot unowned
 * across a microtask, because resolving a waiter only *schedules* its
 * continuation. That gap is reachable in production, not just in theory: the
 * upload route calls enqueueIngest from the continuation of `await
 * db.insert(...)`, so a second upload finishing its insert inside that window
 * sees `active === 1`, starts, and then the resumed waiter starts too — three
 * concurrent ingests, and the FIFO overtaken. `active` is only decremented when
 * there is genuinely nobody to hand the slot to.
 *
 * Handing the slot over rather than freeing it also means `active` sits at the
 * cap for as long as anyone is waiting, which is what lets acquire() decide on
 * the count alone and still never overtake the queue.
 */
function release() {
  const next = waiting.shift();
  if (next) next();
  else active--;
}

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT_INGESTS) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

/**
 * SPEC §3.2 step 3 — the upload route's only entry point. Resolves once the
 * ingest it dispatched has finished, which is what the tests await; the route
 * discards it, because it has already sent its 202.
 *
 * Never rejects. `ingest` writes its own failures to documents.error, so
 * reaching this catch means even that write failed and the database is
 * unreachable — the row stays 'processing' and the next boot sweep fails it.
 * Swallowing here is what stops an unhandled rejection from taking the whole
 * Bun process down, since nothing awaits this promise in production.
 */
export function enqueueIngest(documentId: string, data: Uint8Array) {
  return acquire()
    .then(() => ingest(documentId, data))
    .catch(() => {})
    .finally(release);
}

/**
 * SPEC §3.2 — a restart mid-ingest must not strand a row in 'processing'
 * forever, because the detail page polls it every 2s until it leaves that
 * state. Returns how many rows were swept.
 *
 * The window is measured from createdAt: there is no updatedAt column (SPEC §4)
 * and none is needed, because the route inserts the row and dispatches to the
 * worker in the same handler, so createdAt is the ingest start time to within
 * the queue wait.
 *
 * At boot every 'processing' row is in fact stranded, so the age test can never
 * be what saves a live document here. The window earns its place where this
 * runs while an ingest is live elsewhere: `bun run --hot` re-evaluates this
 * module on every save without restarting, and a rolling deploy boots a new
 * machine while the old one drains a job it will finish. The largest document
 * the page cap allows finishes well inside ten minutes.
 */
export async function failStaleIngests() {
  const cutoff = new Date(Date.now() - STALE_INGEST_MS);

  const swept = await db
    .update(documents)
    .set({ status: "failed", error: STALE_INGEST_ERROR })
    .where(
      and(eq(documents.status, "processing"), lt(documents.createdAt, cutoff)),
    )
    .returning({ id: documents.id });

  return swept.length;
}

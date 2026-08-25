// SPEC §8 — cosine top-k retrieval within a single document.
//
// Deliberately plain: no reranker, no hybrid search, no query rewriting, and no
// cross-document search (SPEC §1). Those are the non-goals that keep this
// honest — the way to improve retrieval here is to change chunking, k or the
// threshold and watch the eval number move (SPEC §9), not to add a stage.
import { openai } from "@ai-sdk/openai";
import { embed } from "ai";
import { and, cosineDistance, desc, eq, gt, sql } from "drizzle-orm";
import { db } from "../db";
import { chunks } from "../db/schema";

/**
 * SPEC §8 — top 5. Named because Phase 8 tunes it against hit-rate@5; a literal
 * buried in a call site is one nobody dares to move.
 */
export const RETRIEVAL_K = 5;

/**
 * SPEC §8 — cosine similarity floor. Below this a chunk is noise, and handing
 * noise to the model is how a grounded answer turns into a guess. A question
 * the document cannot answer should return zero rows, not five bad ones.
 */
export const SIMILARITY_THRESHOLD = 0.2;

export type Hit = {
  id: string;
  pageNumber: number;
  content: string;
  similarity: number;
};

/**
 * `chunks` has no userId column — it is scoped by documentId alone. Ownership
 * is therefore the caller's job: every route must resolve the document by
 * (id, userId) from the session before calling this (SPEC §14). Nothing here
 * can tell whose document it is being asked about.
 */
export async function retrieve(
  documentId: string,
  question: string,
  k = RETRIEVAL_K,
): Promise<Hit[]> {
  // Must stay the model ingest embedded with (src/rag/ingest.ts). Both sides of
  // a cosine comparison have to come out of the same vector space; a mismatch
  // at the same dimension count degrades recall silently rather than erroring.
  const { embedding } = await embed({
    model: openai.textEmbeddingModel("text-embedding-3-small"),
    value: question,
  });

  const similarity = sql<number>`1 - (${cosineDistance(chunks.embedding, embedding)})`;

  return (
    db
      .select({
        id: chunks.id,
        pageNumber: chunks.pageNumber,
        content: chunks.content,
        similarity,
      })
      .from(chunks)
      // The threshold goes in WHERE as the expression, not the alias: Postgres
      // cannot reference a SELECT alias there, so drizzle inlines it twice.
      .where(
        and(
          eq(chunks.documentId, documentId),
          gt(similarity, SIMILARITY_THRESHOLD),
        ),
      )
      .orderBy((t) => desc(t.similarity))
      .limit(k)
  );
}

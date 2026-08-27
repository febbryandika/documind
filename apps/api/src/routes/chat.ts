// SPEC §3.4 / §8 — ask one document a question and stream back an answer that
// is grounded in that document and nothing else.
//
// The safety argument for the whole feature lives here: these are contracts and
// safety procedures, so a confident wrong answer is worse than no answer. Two
// things enforce that — the similarity threshold in retrieve(), which returns
// nothing rather than five weak passages, and the system prompt below, which
// tells the model to say so plainly when the context does not cover the
// question. Neither is decorative.
import { propagateAttributes, startActiveObservation } from "@langfuse/tracing";
import { openai } from "@ai-sdk/openai";
import { zValidator } from "@hono/zod-validator";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  streamText,
  toUIMessageStream,
  type ModelMessage,
  type UIMessage,
} from "ai";
import { and, asc, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import * as z from "zod";
import { db } from "../db";
import { documents, messages } from "../db/schema";
import { createQuestionRateLimit } from "../middleware/rate-limit";
import { sessionMiddleware, type SessionEnv } from "../middleware/session";
import { retrieve, RETRIEVAL_K, type Hit } from "../rag/retrieve";

/** The citation payload, taken from the column so the two cannot drift. */
export type Source = NonNullable<
  (typeof messages.$inferSelect)["sources"]
>[number];

/**
 * The message shape this route streams. apps/web imports this type — and only
 * this type — to type its useChat call, which is what makes `data-sources` a
 * checked contract across the two deployments rather than a shared convention.
 */
export type DocumentUIMessage = UIMessage<never, { sources: Source[] }>;

/** Enough of a chunk to recognise the passage in a popover, not to replace it. */
export const EXCERPT_CHARS = 200;

/**
 * SPEC §3.5 / §8 (`history.slice(-6)`) — six *messages*, i.e. three exchanges.
 * History is context only: it is never embedded and never retrieved over, so
 * this bounds prompt cost without touching retrieval quality.
 */
export const HISTORY_MESSAGES = 6;

const askBody = z.object({
  question: z
    .string()
    .trim()
    .min(1, { error: "Ask a question first" })
    .max(1000),
});

/** Shown to the user when an answer dies part way through (SPEC §14). */
const ANSWER_FAILED = "The answer stopped part way through. Please ask again.";

// SPEC §8, verbatim. The four clauses are a contract the tests and the eval
// both lean on: answer only from context, cite inline, match the question's
// language, refuse rather than guess.
const SYSTEM_PROMPT =
  "You answer questions about an internal business document using ONLY the numbered " +
  "context below. Cite the sources you used inline as [1], [2]. Reply in the same " +
  "language as the question. If the context does not contain the answer, say so " +
  "plainly — never guess. These documents cover contracts and safety procedures, " +
  "where a confident wrong answer is worse than no answer.\n\n";

/** Chunks carry hard line-wrap newlines from the PDF text layer; a popover wants one run. */
function excerpt(content: string) {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT_CHARS
    ? `${flat.slice(0, EXCERPT_CHARS)}…`
    : flat;
}

/**
 * Builds the numbered context block and the sources array in ONE pass, so the
 * [n] the model is told to cite and the chip the user clicks cannot disagree.
 *
 * `push` returns the new length, which is exactly the 1-based index of the
 * source just added — the marker is therefore derived from the array position
 * itself. Splitting this into two `.map()` calls restores the possibility of
 * drift, which is the bug the numbering test exists to catch.
 */
export function buildContext(hits: Hit[]) {
  const sources: Source[] = [];
  const blocks: string[] = [];

  for (const hit of hits) {
    const n = sources.push({
      chunkId: hit.id,
      pageNumber: hit.pageNumber,
      excerpt: excerpt(hit.content),
    });
    blocks.push(`[${n}] (page ${hit.pageNumber})\n${hit.content}`);
  }

  return { context: blocks.join("\n\n"), sources };
}

/**
 * Rows arrive newest-first, because that is the only way to LIMIT to the most
 * recent ones; the model wants them oldest-first. The cap is re-applied here so
 * the function tells the truth on its own, whatever the query did.
 */
export function toHistory(
  rows: { role: "user" | "assistant"; content: string }[],
): ModelMessage[] {
  return rows
    .slice(0, HISTORY_MESSAGES)
    .reverse()
    .map((row) =>
      row.role === "user"
        ? { role: "user", content: row.content }
        : { role: "assistant", content: row.content },
    );
}

/**
 * Two separate inserts, deliberately — NOT one transaction and NOT one
 * multi-row insert. `created_at` defaults to `now()`, which in Postgres is
 * `transaction_timestamp()` and is therefore identical for every row in a
 * transaction. Batching these would stamp the question and its own answer with
 * the same instant and leave GET /messages with no deterministic order between
 * them. This is the exact opposite of the ingest invariant (SPEC §6) and is not
 * an oversight.
 */
async function persist(
  documentId: string,
  question: string,
  answer: string,
  sources: Source[],
) {
  await db
    .insert(messages)
    .values({ documentId, role: "user", content: question });
  await db
    .insert(messages)
    .values({ documentId, role: "assistant", content: answer, sources });
}

/** Ownership is resolved server-side on every chat route (SPEC §14). */
function ownedDocument(id: string, userId: string) {
  return db
    .select({ id: documents.id, status: documents.status })
    .from(documents)
    .where(and(eq(documents.id, id), eq(documents.userId, userId)))
    .limit(1);
}

// SPEC §14. Built once at module scope so every request shares one set of
// counters; a limiter constructed per request would count to one forever.
const questionRateLimit = createQuestionRateLimit();

export const chatRoutes = new Hono<SessionEnv>()
  .use("*", sessionMiddleware)

  // SPEC §3.4 — embed the question, cosine top-5 within this document, numbered
  // context, streamed answer. Sources go out before the first token.
  //
  // The limiter sits after sessionMiddleware because it keys on the user, and
  // before the validator because a rejected question should not reach OpenAI.
  .post(
    "/:id/chat",
    questionRateLimit,
    zValidator("json", askBody),
    async (c) => {
      const { question } = c.req.valid("json");

      const [doc] = await ownedDocument(c.req.param("id"), c.get("user").id);
      // Someone else's document must be indistinguishable from a missing one.
      if (!doc) return c.json({ error: "Not found" }, 404);
      if (doc.status !== "ready") {
        return c.json({ error: "This document is not ready yet" }, 409);
      }

      // SPEC §13 — one trace per question, so the embed and the generation are two
      // children of one thing rather than two unrelated roots.
      //
      // endOnExit: false because this handler returns as soon as the stream is
      // *constructed*; the tokens are still arriving afterwards. The span is
      // closed from the UI message stream's own onEnd below, which is the one hook
      // that fires whether the answer completed or failed.
      return startActiveObservation(
        "ask-question",
        (span) =>
          propagateAttributes(
            {
              traceName: "ask-question",
              userId: c.get("user").id,
              // A chat thread is per-document, so the document *is* the session.
              sessionId: doc.id,
            },
            async () => {
              let hits: Hit[];
              try {
                hits = await retrieve(doc.id, question, RETRIEVAL_K, {
                  functionId: "embed-question",
                });
              } catch (error) {
                // Previously this escaped the handler into Hono's default empty
                // 500. OpenAI being unreachable is temporary and specific, and
                // saying so is more use than "something went wrong".
                console.error(
                  JSON.stringify({
                    level: "error",
                    requestId: c.get("requestId"),
                    message: "retrieve failed",
                    documentId: doc.id,
                    cause:
                      error instanceof Error ? error.message : String(error),
                  }),
                );
                span.end();
                return c.json(
                  {
                    error:
                      "Search is temporarily unavailable. Please try again in a moment.",
                  },
                  503,
                );
              }

              const { context, sources } = buildContext(hits);

              // SPEC §13's second reason for tracing at all: a bad answer is
              // diagnosed by what retrieval handed the model, so the top hit's
              // score has to be on the trace next to the answer itself.
              span.update({
                input: question,
                metadata: {
                  hitCount: String(hits.length),
                  topSimilarity: hits[0]
                    ? hits[0].similarity.toFixed(3)
                    : "no-hits",
                },
              });

              const history = toHistory(
                await db
                  .select({ role: messages.role, content: messages.content })
                  .from(messages)
                  .where(eq(messages.documentId, doc.id))
                  .orderBy(desc(messages.createdAt))
                  .limit(HISTORY_MESSAGES),
              );

              // A fixed sentence, never the underlying message: an OpenAI error
              // body can echo a key prefix, which is the same reason
              // src/rag/ingest.ts keeps an allow-list of what may be shown.
              const streamFailed = (error: unknown) => {
                const cause =
                  error instanceof Error ? error.message : String(error);

                // Both streams get this handler, and a model failure reaches
                // both: toUIMessageStream sees the real error and turns it into
                // the sentence, then createUIMessageStream sees that sentence as
                // its own error. Logging it twice would read as two failures.
                if (cause !== ANSWER_FAILED) {
                  console.error(
                    JSON.stringify({
                      level: "error",
                      requestId: c.get("requestId"),
                      message: "answer stream failed",
                      documentId: doc.id,
                      cause,
                    }),
                  );
                }

                return ANSWER_FAILED;
              };

              // No early return when hits is empty. An empty context plus the
              // system prompt is what produces a refusal *in the question's
              // language*; a hard-coded "not found" string here would always be
              // English.
              return createUIMessageStreamResponse({
                stream: createUIMessageStream<DocumentUIMessage>({
                  execute: ({ writer }) => {
                    writer.write({ type: "start" });
                    // SPEC §8 — the sources part precedes the text, so citation
                    // chips render immediately instead of after the answer
                    // completes.
                    writer.write({ type: "data-sources", data: sources });

                    const result = streamText({
                      // .chat() rather than SPEC §8's bare openai(...): the bare
                      // callable now resolves to the Responses API and an
                      // experimental model type, while gpt-4o-mini here only needs
                      // plain chat completions.
                      model: openai.chat("gpt-4o-mini"),
                      system: SYSTEM_PROMPT + context,
                      messages: [
                        ...history,
                        { role: "user", content: question },
                      ],
                      telemetry: { functionId: "answer-question" },
                      // v7 renamed onFinish to onEnd; onFinish is a deprecated
                      // alias.
                      onEnd: ({ text }) => {
                        // Recorded, not ended — the span is closed by the stream's
                        // own onEnd below, which also covers the failure path.
                        span.update({ output: text });

                        // The user is already reading this answer. A failed write
                        // must never propagate into the stream and truncate it.
                        void persist(doc.id, question, text, sources).catch(
                          (error) => {
                            console.error(
                              "Could not persist chat messages",
                              error,
                            );
                          },
                        );
                      },
                    });

                    // sendStart: false — `start` was already written above, and a
                    // second one would open a second message on the client.
                    //
                    // onError has to be *here*, not only on createUIMessageStream
                    // below: this is where a failed model call is turned into an
                    // error chunk, and the default masks it to "An error
                    // occurred." before the outer handler ever sees it. Verified
                    // against a stub that 500s on chat completions — with the
                    // handler only on the outer stream, the client got the masked
                    // string and so did the log.
                    writer.merge(
                      toUIMessageStream({
                        stream: result.stream,
                        sendStart: false,
                        onError: streamFailed,
                      }),
                    );
                  },
                  // The outer stream's own failures — anything thrown by execute
                  // itself rather than by the model call.
                  onError: streamFailed,
                  // The one terminal hook for the streaming path — it runs whether
                  // the answer finished, errored or was aborted, so the span
                  // cannot leak.
                  onEnd: () => span.end(),
                }),
              });
            },
          ),
        { endOnExit: false },
      );
    },
  )

  // SPEC §3.5 — oldest first, so the UI renders it in order as it arrives.
  .get("/:id/messages", async (c) => {
    const [doc] = await ownedDocument(c.req.param("id"), c.get("user").id);
    if (!doc) return c.json({ error: "Not found" }, 404);

    const rows = await db
      .select({
        id: messages.id,
        role: messages.role,
        content: messages.content,
        sources: messages.sources,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(eq(messages.documentId, doc.id))
      .orderBy(asc(messages.createdAt));

    return c.json(rows);
  });

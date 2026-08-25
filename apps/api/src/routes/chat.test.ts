import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

// Same reasoning as documents.test.ts: ../auth reaches ../db and throws without
// DATABASE_URL under vitest, and ../db is stubbed because the point of the
// suite is the guards and the two pure helpers, not Postgres. ../rag/retrieve
// is mocked so no test can reach a real embedding call — none of these cases
// should get that far, and this is what makes that assertable.
const { getSession, db, retrieve } = vi.hoisted(() => ({
  getSession: vi.fn(),
  db: { select: vi.fn(), insert: vi.fn() },
  retrieve: vi.fn(),
}));
vi.mock("../auth", () => ({ auth: { api: { getSession } } }));
vi.mock("../db", () => ({ db }));
vi.mock("../rag/retrieve", () => ({ retrieve, RETRIEVAL_K: 5 }));

import {
  buildContext,
  chatRoutes,
  toHistory,
  EXCERPT_CHARS,
  HISTORY_MESSAGES,
} from "./chat";
import { documents } from "../db/schema";
import type { Hit } from "../rag/retrieve";

const app = new Hono().route("/documents", chatRoutes);

const SESSION = {
  user: { id: "user_1", email: "demo@documind.app", name: "Demo" },
  session: { id: "session_1", userId: "user_1" },
};

const CHAIN_METHODS = ["from", "where", "orderBy", "limit"] as const;
type Chain = Promise<unknown> & Record<(typeof CHAIN_METHODS)[number], Mock>;

/** Drizzle's fluent builder, stubbed: a thenable whose methods return itself. */
function chain(result: unknown): Chain {
  const self = Promise.resolve(result) as Chain;
  for (const method of CHAIN_METHODS) self[method] = vi.fn(() => self);
  return self;
}

const hit = (n: number, page: number): Hit => ({
  id: `chunk_${n}`,
  pageNumber: page,
  content: `content of chunk ${n}`,
  similarity: 1 - n / 10,
});

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue(SESSION);
});

describe("buildContext", () => {
  // SPEC §8 — the [n] the model is told to cite and the chip the user clicks
  // must be the same source. This is the contract the whole citation UI rests
  // on: a misaligned marker sends a supervisor to the wrong page.
  it("numbers context blocks in the same order as the sources array", () => {
    const hits = [hit(1, 7), hit(2, 3), hit(3, 7), hit(4, 11), hit(5, 2)];

    const { context, sources } = buildContext(hits);

    expect(sources).toHaveLength(hits.length);
    for (const [index, source] of sources.entries()) {
      const marker = index + 1;
      const block = context.split("\n\n")[index];

      expect(source.chunkId).toBe(hits[index]!.id);
      expect(source.pageNumber).toBe(hits[index]!.pageNumber);
      // The block carrying [n] is the one describing sources[n - 1].
      expect(block).toContain(`[${marker}] (page ${source.pageNumber})`);
      expect(block).toContain(hits[index]!.content);
    }
  });

  it("starts numbering at 1, not 0", () => {
    const { context, sources } = buildContext([hit(1, 4)]);

    expect(context.startsWith("[1] (page 4)")).toBe(true);
    expect(context).not.toContain("[0]");
    expect(sources).toEqual([
      { chunkId: "chunk_1", pageNumber: 4, excerpt: "content of chunk 1" },
    ]);
  });

  // A question the document cannot answer clears no hits, and that empty
  // context is exactly what makes the model refuse rather than guess.
  it("returns an empty context and no sources for no hits", () => {
    expect(buildContext([])).toEqual({ context: "", sources: [] });
  });

  it("flattens and truncates the excerpt but leaves the context intact", () => {
    const long = `${"a".repeat(EXCERPT_CHARS)}\nbb  cc`;
    const { context, sources } = buildContext([
      { id: "chunk_1", pageNumber: 1, content: long, similarity: 0.9 },
    ]);

    expect(sources[0]!.excerpt).toHaveLength(EXCERPT_CHARS + 1); // + the ellipsis
    expect(sources[0]!.excerpt.endsWith("…")).toBe(true);
    expect(sources[0]!.excerpt).not.toContain("\n");
    // The model still sees the whole chunk — only the chip preview is clipped.
    expect(context).toContain(long);
  });
});

describe("toHistory", () => {
  // Rows come out of the query newest-first so the LIMIT takes the most recent.
  const newestFirst = Array.from({ length: 8 }, (_, i) => ({
    role: (i % 2 === 0 ? "assistant" : "user") as "assistant" | "user",
    content: `message ${8 - i}`, // message 8 is newest, message 1 oldest
  }));

  it("keeps exactly the last 6 messages", () => {
    const history = toHistory(newestFirst);

    expect(history).toHaveLength(HISTORY_MESSAGES);
    // The two oldest are dropped, not the two newest.
    expect(history.map((m) => m.content)).toEqual([
      "message 3",
      "message 4",
      "message 5",
      "message 6",
      "message 7",
      "message 8",
    ]);
  });

  it("returns them oldest-first for the model", () => {
    const history = toHistory(newestFirst.slice(0, 2));

    expect(history).toEqual([
      { role: "user", content: "message 7" },
      { role: "assistant", content: "message 8" },
    ]);
  });

  it("does not mutate its input", () => {
    const rows = newestFirst.slice(0, 3);
    const before = rows.map((row) => row.content);

    toHistory(rows);

    expect(rows.map((row) => row.content)).toEqual(before);
  });

  it("handles a first question, with no history at all", () => {
    expect(toHistory([])).toEqual([]);
  });
});

describe("session guard", () => {
  // SPEC §14 — no chat route may be reachable without a server-resolved session.
  const routes = [
    ["POST", "/documents/doc_1/chat"],
    ["GET", "/documents/doc_1/messages"],
  ] as const;

  it.each(routes)(
    "%s %s rejects a request with no session",
    async (method, path) => {
      getSession.mockResolvedValue(null);

      const res = await app.request(path, {
        method,
        headers: { "content-type": "application/json" },
        body:
          method === "POST" ? JSON.stringify({ question: "hi" }) : undefined,
      });

      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
      expect(db.select).not.toHaveBeenCalled();
      expect(retrieve).not.toHaveBeenCalled();
    },
  );
});

describe("ownership", () => {
  const routes = [
    ["POST", "/documents/doc_1/chat"],
    ["GET", "/documents/doc_1/messages"],
  ] as const;

  it.each(routes)(
    "%s %s scopes the lookup to the session user",
    async (method, path) => {
      const query = chain([]);
      db.select.mockReturnValue(query);

      const res = await app.request(path, {
        method,
        headers: { "content-type": "application/json" },
        body:
          method === "POST" ? JSON.stringify({ question: "hi" }) : undefined,
      });

      // A document owned by someone else is indistinguishable from a missing
      // one — 404, never 403.
      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({ error: "Not found" });
      expect(query.where).toHaveBeenCalledWith(
        and(eq(documents.id, "doc_1"), eq(documents.userId, "user_1")),
      );
      expect(retrieve).not.toHaveBeenCalled();
    },
  );
});

describe("POST /:id/chat readiness", () => {
  it.each(["processing", "failed"] as const)(
    "refuses to answer a '%s' document",
    async (status) => {
      db.select.mockReturnValue(chain([{ id: "doc_1", status }]));

      const res = await app.request("/documents/doc_1/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "What PPE is required?" }),
      });

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toEqual({
        error: "This document is not ready yet",
      });
      // Nothing was embedded: there are no chunks to search yet.
      expect(retrieve).not.toHaveBeenCalled();
    },
  );

  it("rejects an empty question before touching the database", async () => {
    const res = await app.request("/documents/doc_1/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "   " }),
    });

    expect(res.status).toBe(400);
    expect(retrieve).not.toHaveBeenCalled();
  });
});

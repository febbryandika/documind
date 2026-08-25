import { readFile } from "node:fs/promises";
import { and, eq, lt } from "drizzle-orm";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

// ../db is mocked because vitest runs under node, which does not auto-load .env
// the way Bun does, so importing it throws on a missing DATABASE_URL — and
// because what this suite is about is the pipeline's ordering and failure
// handling, not Postgres. `ai` and @ai-sdk/openai are mocked so no test needs
// OPENAI_API_KEY or makes a network call. vi.hoisted is required because
// vi.mock is hoisted above the imports.
const { extractPdfText, embedMany, db } = vi.hoisted(() => ({
  extractPdfText: vi.fn(),
  embedMany: vi.fn(),
  db: { update: vi.fn(), transaction: vi.fn() },
}));

// Spread over the real module rather than replacing it: NO_TEXT_ERROR is
// imported below and has to stay the real constant, or the sanitiser test would
// pass against a string the extractor never actually throws.
vi.mock("./extract", async () => ({
  ...(await vi.importActual<typeof import("./extract")>("./extract")),
  extractPdfText,
}));
vi.mock("@ai-sdk/openai", () => ({
  openai: { textEmbeddingModel: (id: string) => id },
}));
vi.mock("ai", () => ({ embedMany }));
vi.mock("../db", () => ({ db }));

import { documents } from "../db/schema";
import { NO_TEXT_ERROR } from "./extract";
import {
  EMBED_ERROR,
  INGEST_ERROR,
  ingest,
  failStaleIngests,
  MAX_PAGES,
  PAGE_LIMIT_ERROR,
  STALE_INGEST_ERROR,
  STALE_INGEST_MS,
} from "./ingest";

const CHAIN_METHODS = ["set", "where", "values", "returning"] as const;

// A mapped type over the literal method names rather than Record<string, …>:
// noUncheckedIndexedAccess only widens index signatures, so this keeps
// `query.where` non-optional at the call sites below.
type Chain = Promise<unknown> & Record<(typeof CHAIN_METHODS)[number], Mock>;

/**
 * Stands in for drizzle's fluent builder: a thenable whose chain methods each
 * return itself, so `await db.update(x).set(y).where(z)` resolves to `result`
 * while every call stays assertable.
 */
function chain(result: unknown = []): Chain {
  const self = Promise.resolve(result) as Chain;
  for (const method of CHAIN_METHODS) self[method] = vi.fn(() => self);
  return self;
}

/**
 * db.transaction(cb) invokes cb with a tx exposing the same fluent builder, so
 * a test can assert both what the transaction did and that it did it *inside*
 * one — a chunk insert or a status flip that escaped the transaction shows up
 * on `db` rather than on the handles returned here.
 */
function mockTransaction() {
  const insert = vi.fn(() => chain());
  const update = vi.fn(() => chain());
  db.transaction.mockImplementation(
    async (run: (tx: { insert: Mock; update: Mock }) => Promise<void>) =>
      run({ insert, update }),
  );
  return { insert, update };
}

type ChunkRow = { pageNumber: number; content: string; embedding: number[] };

/** Every chunk row a run handed to `tx.insert(...).values(...)`, in order. */
function insertedRows(insert: Mock): ChunkRow[] {
  return insert.mock.results.flatMap((result) =>
    (result.value as Chain).values.mock.calls.flatMap(
      (call) => call[0] as ChunkRow[],
    ),
  );
}

/** The `.values(...)` batch sizes, one entry per insert statement. */
function insertBatchSizes(insert: Mock) {
  return insert.mock.results.map(
    (result) =>
      ((result.value as Chain).values.mock.calls[0]?.[0] as ChunkRow[]).length,
  );
}

const extracted = (pages: string[], totalPages = pages.length) => ({
  totalPages,
  pages,
});

/** One page that yields exactly one chunk, distinct per index. */
const page = (i: number) => `Clause ${i} of the agreement applies here.`;

/**
 * One page of four near-budget sentences, which `chunkPage` splits into exactly
 * four chunks — the density needed to get past 500 chunks while staying inside
 * the 200-page cap, as a real contract page would.
 */
const densePage = (i: number) =>
  Array.from({ length: 4 }, (_, j) => {
    const word = ` p${i}s${j}word`;
    return `Clause ${i}.${j}:${word.repeat(Math.ceil((290 * 4) / word.length))}.`;
  }).join(" ");

const EN_PAGE = "The supplier shall deliver all goods on time.";
const JA_PAGE = "乙は甲に対し代金を支払うものとする。";
const DATA = Uint8Array.of(1, 2, 3);

/** A macrotask, so every pending microtask has drained by the time it settles. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// One distinct vector per value, numbered globally across the whole run, so row
// i must carry embedding [i]. A batching bug that restarts the numbering per
// batch produces [0..99, 0..99] and fails loudly here rather than silently
// pairing each chunk with another chunk's vector for the document's life.
let issued = 0;

beforeEach(() => {
  vi.clearAllMocks();
  issued = 0;
  embedMany.mockImplementation(({ values }: { values: string[] }) =>
    Promise.resolve({ embeddings: values.map(() => [issued++]) }),
  );
  db.update.mockImplementation(() => chain());
  mockTransaction();
});

describe("ingest", () => {
  it("ingests a fixture end to end", async () => {
    // The only test that runs the real extract → chunk seam. Everything below
    // stubs pages to reach cases the fixtures cannot express, and a suite that
    // only ever saw stubbed pages would pass with the seam wired backwards.
    const actual =
      await vi.importActual<typeof import("./extract")>("./extract");
    const pdf = await readFile(
      new URL("../../fixtures/warehouse-safety.pdf", import.meta.url),
    );
    extractPdfText.mockResolvedValue(await actual.extractPdfText(pdf));
    const tx = mockTransaction();

    await ingest("doc_1", pdf);

    // The counts fixtures/README.md pins, so a reflow that moved a page
    // boundary fails here rather than quietly changing what gets cited.
    expect(insertedRows(tx.insert)).toHaveLength(20);
    const updated = tx.update.mock.results[0]?.value as Chain;
    expect(updated.set).toHaveBeenCalledWith({
      status: "ready",
      pageCount: 10,
      chunkCount: 20,
      language: "en",
    });
  });

  it("embeds in batches of 100", async () => {
    extractPdfText.mockResolvedValue(
      extracted(Array.from({ length: 120 }, (_, i) => page(i))),
    );

    await ingest("doc_1", DATA);

    expect(embedMany).toHaveBeenCalledTimes(2);
    expect(embedMany.mock.calls[0]?.[0].values).toHaveLength(100);
    expect(embedMany.mock.calls[1]?.[0].values).toHaveLength(20);
    // SPEC §1 pins the model; multilingual support is entirely this choice.
    expect(embedMany.mock.calls[0]?.[0].model).toBe("text-embedding-3-small");
  });

  it("embeds every batch before opening the transaction", async () => {
    // SPEC §6 invariant 1 — holding a transaction open across OpenAI calls pins
    // a Postgres connection for minutes. This is what catches someone folding
    // the embed loop and the insert loop together.
    const order: string[] = [];
    extractPdfText.mockResolvedValue(
      extracted(Array.from({ length: 120 }, (_, i) => page(i))),
    );
    embedMany.mockImplementation(({ values }: { values: string[] }) => {
      order.push("embed");
      return Promise.resolve({ embeddings: values.map(() => [issued++]) });
    });
    db.transaction.mockImplementation(
      async (run: (tx: { insert: Mock; update: Mock }) => Promise<void>) => {
        order.push("transaction");
        return run({
          insert: vi.fn(() => chain()),
          update: vi.fn(() => chain()),
        });
      },
    );

    await ingest("doc_1", DATA);

    expect(order).toEqual(["embed", "embed", "transaction"]);
  });

  it("keeps every chunk paired with its own vector across a batch boundary", async () => {
    extractPdfText.mockResolvedValue(
      extracted(Array.from({ length: 120 }, (_, i) => page(i))),
    );
    const tx = mockTransaction();

    await ingest("doc_1", DATA);

    const rows = insertedRows(tx.insert);
    expect(rows).toHaveLength(120);
    expect(rows.map((row) => row.embedding)).toEqual(
      Array.from({ length: 120 }, (_, i) => [i]),
    );
    expect(rows.map((row) => row.pageNumber)).toEqual(
      Array.from({ length: 120 }, (_, i) => i + 1),
    );
  });

  it("inserts the chunks and flips the status inside one transaction", async () => {
    // SPEC §6 invariant 2. db.update carrying the flip instead would mean a
    // document could go 'ready' while the chunk insert rolled back.
    extractPdfText.mockResolvedValue(extracted([EN_PAGE]));
    const tx = mockTransaction();

    await ingest("doc_1", DATA);

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(tx.insert).toHaveBeenCalledTimes(1);
    expect(tx.update).toHaveBeenCalledTimes(1);
    expect(db.update).not.toHaveBeenCalled();
    const updated = tx.update.mock.results[0]?.value as Chain;
    expect(updated.where).toHaveBeenCalledWith(eq(documents.id, "doc_1"));
  });

  it("slices a large chunk set across statements inside the same transaction", async () => {
    // 150 dense pages — inside the page cap, but 600 chunks, which is where a
    // single bind message would get large enough to matter.
    extractPdfText.mockResolvedValue(
      extracted(Array.from({ length: 150 }, (_, i) => densePage(i))),
    );
    const tx = mockTransaction();

    await ingest("doc_1", DATA);

    expect(insertBatchSizes(tx.insert)).toEqual([500, 100]);
    // Still one transaction — slicing bounds bind payload, not atomicity.
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it("records the extractor's page count, not the pages that produced chunks", async () => {
    const pages = Array.from({ length: 12 }, (_, i) => (i < 3 ? page(i) : ""));
    extractPdfText.mockResolvedValue(extracted(pages));
    const tx = mockTransaction();

    await ingest("doc_1", DATA);

    const updated = tx.update.mock.results[0]?.value as Chain;
    expect(updated.set).toHaveBeenCalledWith(
      expect.objectContaining({ pageCount: 12, chunkCount: 3 }),
    );
  });

  it.each([
    ["English", [EN_PAGE], "en"],
    ["Japanese", [JA_PAGE], "ja"],
    ["mixed", [`${"a".repeat(90)}日本語の文です`], "mixed"],
  ] as const)(
    "detects a %s document as %s",
    async (_label, pages, expected) => {
      extractPdfText.mockResolvedValue(extracted([...pages]));
      const tx = mockTransaction();

      await ingest("doc_1", DATA);

      const updated = tx.update.mock.results[0]?.value as Chain;
      expect(updated.set).toHaveBeenCalledWith(
        expect.objectContaining({ language: expected }),
      );
    },
  );

  it("detects the language from every page, not just the first", async () => {
    // Reading pages[0] alone would call this document English.
    extractPdfText.mockResolvedValue(
      extracted([
        "Introduction.",
        ...Array.from({ length: 10 }, () => JA_PAGE),
      ]),
    );
    const tx = mockTransaction();

    await ingest("doc_1", DATA);

    const updated = tx.update.mock.results[0]?.value as Chain;
    expect(updated.set).toHaveBeenCalledWith(
      expect.objectContaining({ language: "ja" }),
    );
  });
});

describe("ingest failures", () => {
  /** The `.set(...)` payload of the failure write on the mocked db. */
  function failure() {
    const query = db.update.mock.results[0]?.value as Chain;
    return query.set.mock.calls[0]?.[0] as { status: string; error: string };
  }

  it.each([
    [MAX_PAGES, "ready"],
    [MAX_PAGES + 1, "failed"],
  ] as const)("a %i-page document is %s", async (totalPages, expected) => {
    extractPdfText.mockResolvedValue(extracted([EN_PAGE], totalPages));

    await ingest("doc_1", DATA);

    if (expected === "ready") {
      expect(embedMany).toHaveBeenCalledTimes(1);
      expect(db.update).not.toHaveBeenCalled();
    } else {
      // The cap is a cost guard, not a message — this is the assertion that
      // makes it one. Checking only the error would still pass if the cap ran
      // after the document had already been embedded.
      expect(embedMany).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
      expect(failure()).toEqual({ status: "failed", error: PAGE_LIMIT_ERROR });
    }
  });

  it("writes the extractor's own message for a PDF with no text layer", async () => {
    extractPdfText.mockRejectedValue(new Error(NO_TEXT_ERROR));

    await ingest("doc_1", DATA);

    expect(failure()).toEqual({ status: "failed", error: NO_TEXT_ERROR });
    expect(embedMany).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    const query = db.update.mock.results[0]?.value as Chain;
    expect(query.where).toHaveBeenCalledWith(eq(documents.id, "doc_1"));
  });

  it("never lets an OpenAI error reach the column the UI renders", async () => {
    // documents.error is shown to the user verbatim, and a 401 body echoes the
    // key that was used. Passing the provider's message through would print a
    // fragment of the secret into the browser.
    extractPdfText.mockResolvedValue(extracted([EN_PAGE]));
    embedMany.mockRejectedValue(
      new Error("401 Incorrect API key provided: sk-proj-abc123"),
    );

    await ingest("doc_1", DATA);

    expect(failure().error).toBe(EMBED_ERROR);
    expect(failure().error).not.toContain("sk-");
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it.each([
    ["an opaque library error", new Error("Invalid PDF structure.")],
    ["a non-Error throw", "boom"],
  ] as const)("falls back to generic copy for %s", async (_label, thrown) => {
    extractPdfText.mockRejectedValue(thrown);

    await ingest("doc_1", DATA);

    expect(failure()).toEqual({ status: "failed", error: INGEST_ERROR });
  });

  it("marks the document failed when the transaction rolls back", async () => {
    extractPdfText.mockResolvedValue(extracted([EN_PAGE]));
    db.transaction.mockRejectedValue(new Error("deadlock detected"));

    await ingest("doc_1", DATA);

    expect(failure()).toEqual({ status: "failed", error: INGEST_ERROR });
  });

  it("never throws back to the caller", async () => {
    // The upload route already sent its 202, so there is nobody to throw to.
    extractPdfText.mockRejectedValue(new Error("boom"));

    await expect(ingest("doc_1", DATA)).resolves.toBeUndefined();
  });
});

describe("enqueueIngest", () => {
  let enqueueIngest: typeof import("./ingest").enqueueIngest;
  let release: (() => void)[];
  let started: number[];

  beforeEach(async () => {
    // `active` and `waiting` are module state, and clearAllMocks does not touch
    // them — a test that leaves a run parked would poison the next one.
    // Resetting the registry gives every test an empty FIFO; the vi.mock
    // factories above survive it.
    vi.resetModules();
    ({ enqueueIngest } = await import("./ingest"));

    release = [];
    started = [];
    // Each run parks at extraction until its release is called. The document is
    // identified by its first byte, because that is what the worker forwards.
    extractPdfText.mockImplementation((data: Uint8Array) => {
      started.push(data[0] ?? -1);
      return new Promise((resolve) => {
        release.push(() => resolve(extracted([EN_PAGE])));
      });
    });
  });

  /** Release every parked run, letting queued ones start and park in turn. */
  async function drain(runs: Promise<void>[]) {
    while (release.length > 0) {
      const next = release.shift();
      if (next) next();
      await flush();
    }
    await Promise.all(runs);
  }

  it("never runs more than two ingests at once", async () => {
    let live = 0;
    let peak = 0;
    extractPdfText.mockImplementation((data: Uint8Array) => {
      started.push(data[0] ?? -1);
      live++;
      peak = Math.max(peak, live);
      return new Promise((resolve) => {
        release.push(() => {
          live--;
          resolve(extracted([EN_PAGE]));
        });
      });
    });

    const runs = Array.from({ length: 6 }, (_, i) =>
      enqueueIngest(`doc_${i}`, Uint8Array.of(i)),
    );
    await flush();
    await drain(runs);

    // toBe, not toBeLessThanOrEqual: a gate that accidentally serialised every
    // ingest would satisfy the cap and still be wrong.
    expect(peak).toBe(2);
  });

  it("never lets a later arrival take a slot the queue was promised", async () => {
    // Reachable in production, not only in theory: the upload route calls
    // enqueueIngest from the continuation of `await db.insert(...)`, so an
    // upload can land in the microtask window between one ingest finishing and
    // the queued document resuming. Freeing the counter and waking a waiter as
    // two separate steps lets that arrival claim the slot, and concurrency goes
    // to three. Swept across arrival depths because the number of microtasks
    // between the two is an implementation detail: the naive form peaks at 3
    // from depth 2 onwards, this one stays at 2 everywhere.
    for (let depth = 0; depth <= 8; depth++) {
      vi.resetModules();
      const { enqueueIngest: enqueue } = await import("./ingest");

      let live = 0;
      let peak = 0;
      const park: (() => void)[] = [];
      extractPdfText.mockImplementation(() => {
        live++;
        peak = Math.max(peak, live);
        return Promise.resolve(extracted([EN_PAGE]));
      });
      // Park at the transaction — the last await in the pipeline, so a run
      // finishes close enough to the slot being released to reach the window.
      db.transaction.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            park.push(() => {
              live--;
              resolve();
            });
          }),
      );

      const runs = [
        enqueue("doc_0", Uint8Array.of(0)),
        enqueue("doc_1", Uint8Array.of(1)),
      ];
      await flush();
      runs.push(enqueue("doc_2", Uint8Array.of(2)));
      await flush();

      const finished = park.shift();
      if (finished) finished();
      let tick = Promise.resolve();
      for (let i = 0; i < depth; i++) tick = tick.then(() => undefined);
      runs.push(tick.then(() => enqueue("doc_3", Uint8Array.of(3))));
      await flush();

      while (park.length > 0) {
        const next = park.shift();
        if (next) next();
        await flush();
      }
      await Promise.all(runs);

      expect({ depth, peak }).toEqual({ depth, peak: 2 });
    }
  });

  it("runs queued ingests in the order they arrived", async () => {
    const runs = Array.from({ length: 5 }, (_, i) =>
      enqueueIngest(`doc_${i}`, Uint8Array.of(i)),
    );
    await flush();
    await drain(runs);

    expect(started).toEqual([0, 1, 2, 3, 4]);
  });

  it("resolves only once the ingest it dispatched has finished", async () => {
    let settled = false;
    const run = enqueueIngest("doc_0", Uint8Array.of(0)).then(() => {
      settled = true;
    });
    await flush();

    expect(settled).toBe(false);

    const first = release.shift();
    if (first) first();
    await run;

    expect(settled).toBe(true);
  });

  it("releases the slot after a failed ingest", async () => {
    // Otherwise one unreadable PDF permanently burns a slot and the worker
    // degrades to a single lane, then to none.
    extractPdfText.mockRejectedValueOnce(new Error(NO_TEXT_ERROR));

    const runs = Array.from({ length: 3 }, (_, i) =>
      enqueueIngest(`doc_${i}`, Uint8Array.of(i)),
    );
    await flush();

    expect(extractPdfText).toHaveBeenCalledTimes(3);
    await drain(runs);
  });

  it("does not reject even when the failure write itself fails", async () => {
    // The route calls this with `void`; a rejection here is an unhandled
    // rejection, which takes the whole Bun process down.
    extractPdfText.mockRejectedValue(new Error("boom"));
    db.update.mockImplementation(() => {
      throw new Error("database is unreachable");
    });

    await expect(enqueueIngest("doc_1", DATA)).resolves.toBeUndefined();
  });
});

describe("failStaleIngests", () => {
  const NOW = new Date("2026-08-25T12:00:00.000Z").getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("targets only documents left processing past the window", async () => {
    // Both halves matter: without the status condition this fails every old
    // document in the table, and without the age condition a rolling deploy
    // fails a row the draining machine is about to finish.
    const query = chain([]);
    db.update.mockReturnValueOnce(query);

    await failStaleIngests();

    expect(query.where).toHaveBeenCalledWith(
      and(
        eq(documents.status, "processing"),
        lt(documents.createdAt, new Date(NOW - STALE_INGEST_MS)),
      ),
    );
  });

  it("writes the restart message", async () => {
    const query = chain([]);
    db.update.mockReturnValueOnce(query);

    await failStaleIngests();

    expect(query.set).toHaveBeenCalledWith({
      status: "failed",
      error: STALE_INGEST_ERROR,
    });
  });

  it("reports how many rows it swept", async () => {
    db.update.mockReturnValueOnce(chain([{ id: "doc_1" }, { id: "doc_2" }]));

    await expect(failStaleIngests()).resolves.toBe(2);
  });
});

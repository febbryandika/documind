// SPEC §9 — retrieval evaluation. Ingests the committed fixtures into a scratch
// database, runs every question in golden.json through retrieve(), and reports
// hit-rate@5, MRR and mean top-hit similarity.
//
//   docker compose --profile eval up -d postgres-eval
//   bun run eval
//
// It exists to answer one question honestly — does changing chunk size or k
// actually help? — and to put a real number in the README instead of an
// adjective. No eval framework: this is plain TypeScript and no dependency.
//
// THIS DOES NOT RUN IN CI, and not only because there is no CI on this repo
// (GitHub Actions minutes are exhausted — see CLAUDE.md). It costs OpenAI calls:
// ~73 chunk embeddings across the three fixtures plus one per question, every
// run, because it re-ingests from scratch each time. That is fractions of a cent
// at text-embedding-3-small rates, but it is not free and it is not idempotent,
// so it belongs on demand — when chunking, k or the threshold has moved — and
// never in a watch loop or a pre-commit hook.
//
// Scoring is a strict page match: a hit is the tagged page appearing among the
// top k. Chunk overlap means an answer can legitimately surface from a
// neighbouring page's chunk and still score as a miss. That is left alone
// deliberately — an honest ruler that occasionally under-reports is worth more
// than a lenient one nobody trusts.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// The guard runs before anything imports ../src/db (SPEC §9). This is a guard
// rather than a convention because the failure mode is destroying local work:
// the run below deletes every document in whatever database it is pointed at.
// ---------------------------------------------------------------------------
const url = process.env.EVAL_DATABASE_URL;
if (!url)
  throw new Error("EVAL_DATABASE_URL is not set — see apps/api/.env.example");
if (url === process.env.DATABASE_URL)
  throw new Error("refusing to run against DATABASE_URL");
process.env.DATABASE_URL = url;

// Dynamic, and this is load-bearing. src/db/index.ts resolves DATABASE_URL at
// module-eval time and exports a singleton that ingest() and retrieve() both
// import, so a static import would be hoisted above the assignment above and
// bind the development database before the first line ran. No change to
// src/db/index.ts is needed: its globalThis cache exists for `bun run --hot`
// and is per-process, so a one-shot script never sees it.
const { db, client } = await import("../src/db");
const { documents, user } = await import("../src/db/schema");
const { ingest } = await import("../src/rag/ingest");
const { retrieve, RETRIEVAL_K, SIMILARITY_THRESHOLD } = await import(
  "../src/rag/retrieve"
);
const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { eq } = await import("drizzle-orm");

type Question = {
  doc: string;
  q: string;
  page: number;
  anchor: string;
  note?: string;
};

/** Retrieve deeper than the app serves, so one run also answers "would a larger k help?" */
const MAX_K = Math.max(10, RETRIEVAL_K);
const CUTOFFS = [...new Set([1, 3, 5, RETRIEVAL_K, MAX_K])].sort((a, b) => a - b);

const path = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const golden: Question[] = JSON.parse(await readFile(path("./golden.json"), "utf8"));

// ---------------------------------------------------------------------------
// Validate the ruler before spending anything on it. A golden set tagged with
// the wrong page scores correct retrieval as a miss, and the natural response to
// a bad number is to start tuning k against a broken ruler — which is exactly
// what happened once already (CLAUDE.md). Every entry carries the anchor phrase
// its page was read off; this re-reads all of them out of the fixtures.
//
// Compared with all whitespace removed because Chrome's text layer wraps hard
// mid-sentence, so a phrase that is one run in the HTML arrives split by a
// newline (fixtures/README.md).
// ---------------------------------------------------------------------------
const { extractPdfText } = await import("../src/rag/extract");
const squash = (s: string) => s.replace(/\s+/g, "");

const fixtures = new Map<string, { bytes: Uint8Array; pages: string[] }>();
for (const doc of new Set(golden.map((g) => g.doc))) {
  const bytes = await readFile(path(`../fixtures/${doc}`));
  fixtures.set(doc, { bytes, pages: (await extractPdfText(bytes)).pages });
}

const mistagged = golden.filter((g) => {
  const pages = fixtures.get(g.doc)!.pages;
  const on = pages.flatMap((p, i) => (squash(p).includes(squash(g.anchor)) ? [i + 1] : []));
  return on.length !== 1 || on[0] !== g.page;
});
if (mistagged.length > 0) {
  for (const g of mistagged) console.error(`  ${g.doc} page ${g.page} — ${g.anchor}`);
  throw new Error(
    `${mistagged.length} golden entries are mistagged — the anchor is missing, ` +
      "ambiguous, or on another page. Fix golden.json before running the eval.",
  );
}

// ---------------------------------------------------------------------------
// Set up the scratch database. Migrating here rather than leaning on
// `bun run db:migrate` keeps this one command on a fresh container: drizzle.config.ts
// reads DATABASE_URL for the CLI and has no notion of the eval's database.
// ---------------------------------------------------------------------------
console.log(`eval database: ${url.replace(/:\/\/[^@]*@/, "://***@")}\n`);
await migrate(db, { migrationsFolder: path("../drizzle") });

// Cascades to chunks and messages (SPEC §4).
await db.delete(documents);

const EVAL_USER = "eval-user";
await db
  .insert(user)
  .values({
    id: EVAL_USER,
    name: "Retrieval eval",
    email: "eval@documind.local",
    emailVerified: true,
  })
  .onConflictDoNothing();

const documentIds = new Map<string, string>();
for (const [doc, { bytes }] of fixtures) {
  const [row] = await db
    .insert(documents)
    .values({ userId: EVAL_USER, filename: doc, category: "other" })
    .returning({ id: documents.id });

  // ingest() directly rather than enqueueIngest(): the FIFO is production
  // behaviour and would only add nondeterministic ordering here.
  await ingest(row!.id, bytes);

  // ingest() never throws — it writes its failures to documents.error (SPEC §6)
  // — so the row is the only place a failure shows up. Left unchecked, a failed
  // ingest scores every question for that document as a miss and reads as a
  // retrieval problem.
  const [after] = await db
    .select({
      status: documents.status,
      error: documents.error,
      pageCount: documents.pageCount,
      chunkCount: documents.chunkCount,
      language: documents.language,
    })
    .from(documents)
    .where(eq(documents.id, row!.id));

  if (after?.status !== "ready") {
    throw new Error(`${doc} failed to ingest: ${after?.error ?? "unknown"}`);
  }
  console.log(
    `ingested ${doc.padEnd(22)} ${after.language} · ${after.pageCount} pages · ${after.chunkCount} chunks`,
  );
  documentIds.set(doc, row!.id);
}

// ---------------------------------------------------------------------------
// Score.
// ---------------------------------------------------------------------------
type Result = Question & { rank: number | null; topSimilarity: number };

const results: Result[] = [];
for (const question of golden) {
  const hits = await retrieve(documentIds.get(question.doc)!, question.q, MAX_K);
  const index = hits.findIndex((h) => h.pageNumber === question.page);

  results.push({
    ...question,
    rank: index === -1 ? null : index + 1,
    topSimilarity: hits[0]?.similarity ?? 0,
  });
}

const hitRate = (k: number) =>
  results.filter((r) => r.rank !== null && r.rank <= k).length / results.length;
const mrr =
  results.reduce((sum, r) => sum + (r.rank ? 1 / r.rank : 0), 0) / results.length;
const meanTop =
  results.reduce((sum, r) => sum + r.topSimilarity, 0) / results.length;

// ---------------------------------------------------------------------------
// Report. Printed in golden.json order so the per-document grouping survives,
// then the misses again on their own so the failures are what is left on screen.
// ---------------------------------------------------------------------------
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

console.log(`\n  hit  rank  top-sim  page  question`);
console.log(`  ${"-".repeat(72)}`);
for (const r of results) {
  const hit = r.rank !== null && r.rank <= RETRIEVAL_K;
  console.log(
    `  ${hit ? " ✓ " : " ✗ "}  ${String(r.rank ?? "—").padStart(4)}` +
      `  ${r.topSimilarity.toFixed(3).padStart(7)}  ${String(r.page).padStart(4)}  ${r.q}`,
  );
}

console.log(`\n  ${golden.length} questions · ${fixtures.size} documents · k=${RETRIEVAL_K} · threshold ${SIMILARITY_THRESHOLD}`);
console.log(`  hit-rate@${RETRIEVAL_K}   ${pct(hitRate(RETRIEVAL_K))}`);
console.log(`  MRR            ${mrr.toFixed(3)}`);
console.log(`  mean top-sim   ${meanTop.toFixed(3)}`);
console.log(
  `\n  by cutoff:  ${CUTOFFS.map((k) => `@${k} ${pct(hitRate(k))}`).join("   ")}`,
);
console.log(
  "  (retrieved at k=" +
    MAX_K +
    " so the cutoffs above answer 'would a larger k help?' without a second run)",
);

const misses = results.filter((r) => !(r.rank !== null && r.rank <= RETRIEVAL_K));
if (misses.length > 0) {
  console.log(`\n  ${misses.length} miss(es):`);
  for (const m of misses) {
    console.log(`    ${m.doc} page ${m.page} — ${m.q}`);
    console.log(`      rank ${m.rank ?? "not retrieved"} · anchor: ${m.anchor}`);
  }
}

// Without this a Bun script that queried Postgres never exits.
await client.end();

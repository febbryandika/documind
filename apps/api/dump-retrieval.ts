// Local inspection tool for SPEC §15 step 6 — not part of the served app.
// Prints the chunks retrieve() ranks for a hand-written question so the result
// can be judged by eye. Step 6 is literally "verify top-5 by hand against a
// document you know", and it comes before any generation code on purpose: if
// the wrong passages come back, a good answer was never possible.
//
//   bun run dump-retrieval.ts
//   bun run dump-retrieval.ts <documentId> "What PPE is required in cold storage?"
//   bun run dump-retrieval.ts <documentId> "支払い条件は何日ですか？"
//
// Quote the question — both ? and ？ are glob characters in zsh. With no
// arguments it lists the documents that are ready to query. Costs one embedding
// call per run, against whatever DATABASE_URL points at.
import { desc, eq } from "drizzle-orm";
import { client, db } from "./src/db";
import { documents } from "./src/db/schema";
import {
  RETRIEVAL_K,
  SIMILARITY_THRESHOLD,
  retrieve,
} from "./src/rag/retrieve";

const [documentId, ...words] = Bun.argv.slice(2);
// Joined rather than read as argv[1], so an unquoted question still works when
// it happens to contain no glob characters.
const question = words.join(" ").trim();

async function listReady() {
  const ready = await db
    .select({
      id: documents.id,
      filename: documents.filename,
      language: documents.language,
      pageCount: documents.pageCount,
      chunkCount: documents.chunkCount,
    })
    .from(documents)
    .where(eq(documents.status, "ready"))
    .orderBy(desc(documents.createdAt));

  if (ready.length === 0) {
    console.error(
      "No documents are ready. Upload a fixture and wait for ingest to finish.",
    );
    return;
  }

  console.error("ready documents:\n");
  for (const row of ready) {
    console.error(
      `  ${row.id}  ${row.filename} — ${row.language ?? "?"} · ` +
        `${row.pageCount ?? "?"} pages · ${row.chunkCount ?? "?"} chunks`,
    );
  }
}

if (!documentId || !question) {
  console.error("usage: bun run dump-retrieval.ts <documentId> <question…>\n");
  await listReady();
  await client.end();
  process.exit(1);
}

const hits = await retrieve(documentId, question);

console.log(
  `${question}\n\ndocument ${documentId} — ${hits.length}/${RETRIEVAL_K} hits ` +
    `above similarity ${SIMILARITY_THRESHOLD}`,
);

if (hits.length === 0) {
  console.log(
    "\nNothing cleared the threshold. Either the document genuinely does not " +
      "answer this, or the chunking split the answer badly — check with " +
      "dump-chunks.ts before touching the threshold.",
  );
}

for (const [index, hit] of hits.entries()) {
  console.log(
    `\n--- #${index + 1} · page ${hit.pageNumber} · ` +
      `similarity ${hit.similarity.toFixed(3)} ---`,
  );
  console.log(hit.content);
}

await client.end();
process.exit(0);

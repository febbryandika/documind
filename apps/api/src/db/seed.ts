import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";

import { auth } from "../auth";
import { client, db } from "../db";
import { documents, user } from "../db/schema";
import { ingest } from "../rag/ingest";

/**
 * SPEC §11 — the demo account. A reviewer signs in with the credentials at the
 * top of the README and gets three documents that are already `ready`, so they
 * never wait on an embed job.
 *
 * Unlike eval/run.ts this needs no dynamic-import dance: the eval reassigns
 * DATABASE_URL to a scratch database and must defer `../db` past that
 * assignment, whereas the seed targets DATABASE_URL itself. Static imports are
 * correct here.
 *
 * Costs real OpenAI calls — 73 chunk embeddings, roughly $0.001 — so it is a
 * manual command, not something to put in a boot path.
 */

const DEMO_EMAIL = process.env.DEMO_USER_EMAIL ?? "demo@documind.app";
const DEMO_PASSWORD = process.env.DEMO_USER_PASSWORD ?? "documind-demo";
const DEMO_NAME = "Demo";

// SPEC §11 wants one of each: a warehouse safety procedure in English, a
// supplier contract in Japanese, and an equipment manual that mixes the two.
// scanned-no-text.pdf is the negative fixture for the failure path and is
// deliberately not seeded.
const FIXTURES = [
  { file: "warehouse-safety.pdf", category: "procedure" },
  { file: "supplier-contract.pdf", category: "contract" },
  { file: "equipment-manual.pdf", category: "manual" },
] as const;

const fixturePath = (name: string) =>
  fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url));

async function seed() {
  const url = process.env.DATABASE_URL ?? "";
  console.log(`database: ${url.replace(/:\/\/[^@]*@/, "://***@")}`);
  console.log(`demo user: ${DEMO_EMAIL}\n`);

  // Read every fixture before touching the database or spending anything, so a
  // typo in a filename fails in a second rather than half way through.
  const files = await Promise.all(
    FIXTURES.map(async (fixture) => ({
      ...fixture,
      bytes: new Uint8Array(await readFile(fixturePath(fixture.file))),
    })),
  );

  // Idempotency (SPEC §11): drop the demo user and rebuild it, rather than
  // keeping the row and deleting only its documents. Better Auth has no
  // server-side "set this user's password" call that does not already need
  // their session, so reusing the row would leave the password at whatever an
  // earlier run set — and the README would promise credentials that no longer
  // work. Deleting cascades through account, session, documents, chunks and
  // messages (SPEC §4), which puts the database back to a known state in one
  // statement.
  const [existing] = await db
    .delete(user)
    .where(eq(user.email, DEMO_EMAIL))
    .returning({ id: user.id });

  if (existing) console.log("removed the previous demo account");

  // Through the API, never a raw insert. `account` needs an issuer, a
  // providerId, a correctly hashed password and a NOT NULL updatedAt with no
  // default; hand-rolling that produces a user who cannot sign in.
  const created = await auth.api.signUpEmail({
    body: { email: DEMO_EMAIL, password: DEMO_PASSWORD, name: DEMO_NAME },
  });

  const userId = created.user.id;
  console.log(`created ${DEMO_EMAIL}\n`);

  for (const { file, category, bytes } of files) {
    const [row] = await db
      .insert(documents)
      .values({ userId, filename: file, category })
      .returning({ id: documents.id });

    if (!row) throw new Error(`could not insert a row for ${file}`);

    // ingest() directly rather than enqueueIngest(): the FIFO is production
    // behaviour and would only make the ordering here nondeterministic.
    await ingest(row.id, bytes, userId);

    // ingest() never throws — it writes its failures to documents.error
    // (SPEC §6) — so the row is the only place a failure shows up. Left
    // unchecked, the seed would report success and the reviewer would land on
    // a document stuck in `failed`.
    const [after] = await db
      .select({
        status: documents.status,
        error: documents.error,
        pageCount: documents.pageCount,
        chunkCount: documents.chunkCount,
        language: documents.language,
      })
      .from(documents)
      .where(eq(documents.id, row.id));

    if (after?.status !== "ready") {
      throw new Error(`${file} failed to ingest: ${after?.error ?? "unknown"}`);
    }

    console.log(
      `ingested ${file.padEnd(22)} ${after.language} · ${after.pageCount} pages · ${after.chunkCount} chunks`,
    );
  }

  console.log(`\nseeded ${files.length} documents for ${DEMO_EMAIL}`);

  // The account this just created is only safe to publish because upload and
  // delete are blocked for it, and that guard keys on DEMO_USER_EMAIL
  // (middleware/demo-user.ts). Unset, the demo is wide open.
  if (!process.env.DEMO_USER_EMAIL) {
    console.warn(
      "\nwarning: DEMO_USER_EMAIL is not set, so upload and delete are NOT blocked\n" +
        "         for this account. Set it wherever the API runs (SPEC §11).",
    );
  }
}

try {
  await seed();
} finally {
  // Without this a Bun script that queried Postgres never exits.
  await client.end();
}

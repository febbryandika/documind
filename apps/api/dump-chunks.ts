// Local inspection tool for SPEC §15 step 4 — not part of the served app.
// Prints the chunks a fixture produces so the split can be eyeballed by hand,
// which is the only way to judge whether a boundary landed somewhere sensible.
//
//   bun run dump-chunks.ts fixtures/supplier-contract.pdf
//   bun run dump-chunks.ts fixtures/supplier-contract.pdf --raw
//
// --raw additionally prints the untouched per-page text from unpdf. Worth
// looking at: Chrome-printed PDFs contain hard line-wrap newlines mid-sentence
// and no blank lines at all, so the paragraph tier of chunkPage never fires on
// them and everything is packed at sentence granularity.
import {
  chunkPage,
  detectLanguage,
  estimateTokens,
  MAX_TOKENS,
} from "./src/rag/chunk";
import { extractPdfText } from "./src/rag/extract";

const [path] = Bun.argv.slice(2);
if (!path) {
  console.error("usage: bun run dump-chunks.ts <file.pdf> [--raw]");
  process.exit(1);
}
const raw = Bun.argv.includes("--raw");

const { totalPages, pages } = await extractPdfText(
  new Uint8Array(await Bun.file(path).arrayBuffer()),
);

const chunks = pages.flatMap((page, i) => chunkPage(page, i + 1));
const tokens = chunks.map((chunk) => estimateTokens(chunk.content));

console.log(
  `${path} — ${totalPages} pages — ${detectLanguage(pages.join(""))} — ` +
    `${chunks.length} chunks`,
);

for (const [index, page] of pages.entries()) {
  if (raw) {
    console.log(`\n=== page ${index + 1} raw ===\n${JSON.stringify(page)}`);
  }
}

for (const [index, chunk] of chunks.entries()) {
  const estimate = tokens[index] ?? 0;
  const over = estimate > MAX_TOKENS ? "  ** OVER BUDGET **" : "";
  console.log(
    `\n--- chunk ${index + 1}/${chunks.length} · page ${chunk.pageNumber} · ` +
      `${estimate} tok · ${chunk.content.length} chars${over} ---`,
  );
  console.log(chunk.content);
}

if (tokens.length > 0) {
  const total = tokens.reduce((sum, n) => sum + n, 0);
  console.log(
    `\nsummary: ${tokens.length} chunks · ` +
      `min ${Math.min(...tokens)} · mean ${Math.round(total / tokens.length)} · ` +
      `max ${Math.max(...tokens)} estimated tokens`,
  );
}

process.exit(0);

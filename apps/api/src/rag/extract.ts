import { extractText, getDocumentProxy } from "unpdf";

/**
 * SPEC §3.2 — this message is written to `documents.error` and shown to the
 * user, who is expected to delete the document and retry. It lives here rather
 * than in ingest because "there is no text layer" is a fact about extraction,
 * and this module is the one that can be tested against a fixture without
 * reaching for the database.
 */
export const NO_TEXT_ERROR = "No extractable text — is this a scanned PDF?";

export type ExtractedPdf = { totalPages: number; pages: string[] };

// Chrome's PDF export maps a number of common kanji onto Kangxi radical code
// points — 支 (U+652F) is written as ⽀ (U+2F40), 日 as ⽇, 金 as ⾦. They render
// identically and compare unequal, so a question asking about 支払い would never
// match a chunk containing ⽀払い, and the radicals also fall outside the CJK
// class in chunk.ts and get costed as Latin. NFKC is applied to these two blocks
// only: run over the whole string it would also rewrite ．！？ into .!?, which
// are the Japanese sentence boundaries the chunker splits on.
const CJK_RADICALS = /[⺀-⻿⼀-⿟]/g;

const normalizeRadicals = (s: string) =>
  s.replace(CJK_RADICALS, (ch) => ch.normalize("NFKC"));

/**
 * unpdf narrowed to what ingest needs: one string per page, plus the count for
 * `documents.pageCount`.
 *
 * `mergePages` is pinned false at this single site — flipping it collapses the
 * whole document to one string and every citation to page 1, which is the worst
 * silent failure available in this product. Throws rather than returning an
 * empty result so ingest's catch writes the message straight into
 * `documents.error` (SPEC §6).
 */
export async function extractPdfText(data: Uint8Array): Promise<ExtractedPdf> {
  // Copied rather than passed through: a Node Buffer is a view into a pooled
  // arena, so handing pdf.js the underlying ArrayBuffer risks unrelated bytes.
  const pdf = await getDocumentProxy(new Uint8Array(data));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });

  const pages = text.map(normalizeRadicals);
  if (pages.every((page) => page.trim().length === 0)) {
    throw new Error(NO_TEXT_ERROR);
  }

  return { totalPages, pages };
}

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

// Chrome's PDF export maps a number of common kanji onto CJK radical code
// points — 支 (U+652F) is written as ⽀ (U+2F40), 日 as ⽇, 民 as ⺠. They render
// identically and compare unequal, so a question asking about 支払い would never
// match a chunk containing ⽀払い, and the radicals also fall outside the CJK
// class in chunk.ts and get costed as Latin.
const CJK_RADICALS = /[⺀-⻿⼀-⿟]/g;

// Kangxi Radicals (U+2F00-2FDF) carry a compatibility decomposition to the
// unified ideograph in 214 of 224 cases, so NFKC handles that block. It is
// applied per matched character rather than to the whole string: run over
// everything, NFKC would also rewrite ．！？ into .!?, which are the Japanese
// sentence boundaries chunk.ts splits on.
//
// CJK Radicals Supplement (U+2E80-2EFF) is the awkward one — only 2 of its 128
// characters decompose, so NFKC leaves the rest untouched and the standard
// library offers no general mapping. Those are listed here explicitly, and only
// where the substitution has actually been seen in a document: guessing at a
// radical's ideograph would corrupt text that is currently correct.
// extract.test.ts asserts that no radical survives in the Japanese fixture, so
// a new one surfaces as a failing test rather than as silently broken retrieval.
const RADICAL_EXCEPTIONS = new Map([["⺠", "民"]]);

const normalizeRadicals = (s: string) =>
  s.replace(
    CJK_RADICALS,
    (ch) => RADICAL_EXCEPTIONS.get(ch) ?? ch.normalize("NFKC"),
  );

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

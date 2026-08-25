// SPEC §7 — chunking for English *and* Japanese documents.
//
// The naive approach (split on spaces, budget by character count) breaks on
// Japanese twice over: Japanese has no spaces between words, and a Japanese
// character carries far more information per character than a Latin one. A
// 1000-character chunk is ~250 tokens of English but ~800 tokens of Japanese,
// so the same setting produces wildly different chunk sizes across languages.
// Everything here budgets by estimated tokens instead, and every piece carries
// the page number the citations resolve against (SPEC §3.4).
//
// No dependency: this is ~60 lines of our own code, and it is the piece most
// worth unit-testing in the project.

// kana + kanji + half-width katakana (SPEC §7). Deliberately excludes CJK
// punctuation — `。` `、` `！` `？` `．` and the ideographic space all fall
// outside it and score as Latin. That under-counts a Japanese page by well
// under a token per sentence, which an estimator can absorb.
const CJK = /[぀-ヿ㐀-鿿ｦ-ﾟ]/;

/** SPEC §7 — the chunk size everything is packed towards. */
export const MAX_TOKENS = 300;

/** SPEC §7 — how much of a chunk is carried into the next one as context. */
export const OVERLAP_TOKENS = 50;

// Sentence enders for both scripts (SPEC §7). `。．！？` split immediately after
// the ender because Japanese has no trailing space; `.!?` additionally require
// whitespace ahead, which is what keeps "2.5%" and "Section 3.1" intact. It does
// NOT keep "Mr. Smith" intact and cannot without an abbreviation dictionary —
// an abbreviation is indistinguishable from a sentence end. That is acceptable
// because the packer rejoins adjacent units with their original separators, so
// a spurious split is invisible unless it lands exactly on a chunk boundary.
const SENTENCE_BREAK = /(?<=[。．！？])|(?<=[.!?])(?=\s)/;

export type Chunk = { content: string; pageNumber: number };

const countCjk = (s: string) => {
  let cjk = 0;
  for (const ch of s) if (CJK.test(ch)) cjk++;
  return cjk;
};

// cl100k: CJK ≈ 1 token/char, Latin ≈ 0.25 token/char. Good enough to size a
// chunk, which is all it is ever used for.
export const estimateTokens = (s: string) => {
  const cjk = countCjk(s);
  return Math.ceil(cjk + (s.length - cjk) * 0.25);
};

// SPEC §7. A counting loop rather than SPEC's `[...s].filter(…)`: ingest calls
// this on every page of a document joined together, and materialising a
// code-point array of a 200-page PDF allocates a great deal for one ratio.
// Identical result — everything the CJK class can match is in the BMP.
export const detectLanguage = (s: string) => {
  const ratio = countCjk(s) / Math.max(s.length, 1);
  return ratio > 0.3 ? "ja" : ratio > 0.05 ? "mixed" : "en";
};

/**
 * A page split into the units the packer fills chunks with: paragraphs on blank
 * lines, then sentences (SPEC §7 steps 1-2). Whitespace-only pieces are dropped
 * here, which is what stops a blank PDF page — common as a chapter separator —
 * from reaching `embedMany` as an empty string and failing the whole document.
 *
 * A paragraph break rides on the sentence that follows it rather than living in
 * a separate field. That is what lets the packer rejoin units with "" and
 * reproduce the original spacing exactly in both scripts: English sentence
 * pieces keep their own leading space because the lookahead splits *before* it,
 * and Japanese pieces have none to keep.
 */
export function splitUnits(page: string): string[] {
  const units: string[] = [];

  for (const paragraph of page.split(/\n\s*\n/)) {
    if (!paragraph.trim()) continue;

    let first = true;
    for (const sentence of paragraph.split(SENTENCE_BREAK)) {
      if (!sentence.trim()) continue;

      units.push(first && units.length > 0 ? `\n\n${sentence}` : sentence);
      first = false;
    }
  }

  return units;
}

/**
 * The tail of a chunk to carry into the next one (SPEC §7 step 3): the longest
 * suffix fitting the overlap budget, falling back to the final sentence alone
 * when no suffix fits.
 *
 * The fallback is load-bearing, not defensive. 50 estimated tokens is about 50
 * Japanese characters or 33 English words — less than one clause of the
 * contract and procedure prose this project targets, so "longest suffix under
 * 50" measured on real fixtures carries *nothing at all* on every boundary. The
 * half-budget cap keeps a carried sentence from crowding out new content, and
 * still returns nothing for a sentence too long to be context.
 */
const overlapTail = (units: string[]) => {
  let start = units.length;
  while (
    start > 0 &&
    estimateTokens(units.slice(start - 1).join("")) <= OVERLAP_TOKENS
  ) {
    start--;
  }
  if (start < units.length) return units.slice(start);

  const last = units.slice(-1);
  return estimateTokens(last.join("")) <= MAX_TOKENS / 2 ? last : [];
};

/**
 * SPEC §7 steps 3-4 — one greedy pass that fills chunks towards MAX_TOKENS and
 * tags every piece with its page number.
 *
 * Packing deliberately crosses paragraph boundaries: six 40-token paragraphs
 * are one 240-token chunk, not six runts too small to answer from. The budget
 * is a target rather than a cap — a single sentence longer than MAX_TOKENS is
 * emitted whole, because cutting it would split mid-word and mid-kanji and
 * text-embedding-3-small accepts 8191 tokens regardless.
 */
export function chunkPage(page: string, pageNumber: number): Chunk[] {
  const chunks: Chunk[] = [];
  let current: string[] = [];

  // Measured on the joined string, never as a sum of per-unit estimates:
  // estimateTokens rounds up, so twenty short units sum to far more than the
  // text they actually form.
  const exceeds = (units: string[], unit: string) =>
    estimateTokens([...units, unit].join("")) > MAX_TOKENS;

  // A carried unit may lead with the "\n\n" of its paragraph; trim removes it.
  // Guarding on the trimmed content is also what keeps a whitespace-only page
  // from emitting a chunk with empty content.
  const emit = () => {
    const content = current.join("").trim();
    if (content) chunks.push({ content, pageNumber });
  };

  for (const unit of splitUnits(page)) {
    if (current.length > 0 && exceeds(current, unit)) {
      emit();
      // Drop the carry when the incoming unit cannot share a chunk with it.
      // Otherwise an over-budget sentence drags the overlap along, producing a
      // chunk that is over budget *and* opens with the whole of the chunk
      // before it — the same text embedded twice, competing for the top-5.
      const carry = overlapTail(current);
      current = exceeds(carry, unit) ? [] : carry;
    }
    current.push(unit);
  }
  emit();

  return chunks;
}

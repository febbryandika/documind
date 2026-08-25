import { describe, expect, it } from "vitest";
import {
  chunkPage,
  detectLanguage,
  estimateTokens,
  MAX_TOKENS,
  OVERLAP_TOKENS,
  splitUnits,
} from "./chunk";

/**
 * An English sentence of roughly `tokens` estimated tokens. Latin scores ~0.25
 * tokens per character, so ~4 characters buy a token. `label` is woven through
 * the filler to keep every sentence distinct — the overlap assertions compare
 * sentences for equality, and repeated boilerplate would match spuriously.
 */
function enSentence(label: string, tokens: number) {
  const word = ` ${label}word`;
  const repeats = Math.max(1, Math.ceil((tokens * 4) / word.length));
  return `Clause ${label}:${word.repeat(repeats)}.`;
}

/**
 * A Japanese sentence of roughly `chars` characters. CJK scores ~1 token per
 * character, so characters and estimated tokens are near enough the same here.
 */
function jaSentence(label: string, chars: number) {
  const body = `${label}項の定めにより甲乙協議のうえ決定する`;
  const repeats = Math.max(1, Math.ceil(chars / body.length));
  return `第${label}条${body.repeat(repeats)}。`;
}

/** Chunk content re-parsed into its sentences, with paragraph markers stripped. */
function sentencesOf(content: string) {
  return splitUnits(content).map((unit) => unit.trim());
}

/**
 * The sentences appearing at the end of `prev` and again at the start of `next`.
 * Compared sentence-by-sentence rather than as a raw common substring: a raw
 * suffix/prefix search over-matches on repeated boilerplate and reports overlap
 * that was never carried.
 */
function carriedSentences(prev: string, next: string) {
  const before = sentencesOf(prev);
  const after = sentencesOf(next);

  for (let n = Math.min(before.length, after.length); n > 0; n--) {
    const tail = before.slice(before.length - n);
    if (tail.every((sentence, i) => sentence === after[i])) return tail;
  }
  return [];
}

/** Consecutive chunk pairs, without indexing past the start of the array. */
function consecutivePairs(chunks: { content: string }[]) {
  return chunks.flatMap((next, i) => {
    const prev = chunks[i - 1];
    return prev ? [{ prev: prev.content, next: next.content }] : [];
  });
}

describe("estimateTokens", () => {
  it("returns zero for an empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it.each([
    ["100 kanji as ~100 tokens", "漢".repeat(100), 100],
    ["100 hiragana as ~100 tokens", "あ".repeat(100), 100],
    ["100 half-width katakana as ~100 tokens", "ｱ".repeat(100), 100],
    ["100 latin characters as ~25 tokens", "a".repeat(100), 25],
  ] as const)("scores %s", (_label, input, expected) => {
    expect(estimateTokens(input)).toBe(expected);
  });

  // The entire reason this function exists instead of a character count
  // (SPEC §7): the same character budget yields ~250-token chunks in English
  // and ~800-token chunks in Japanese.
  it("costs about four times as much for Japanese as for English (SPEC §7)", () => {
    const en = estimateTokens("a".repeat(200));
    const ja = estimateTokens("漢".repeat(200));

    expect(ja).toBeGreaterThan(en * 3);
  });

  // Pins SPEC §7's CJK class, which spans U+3040-30FF, U+3400-9FFF and
  // U+FF66-FF9F. `。` is U+3002 and falls outside it, so it scores as Latin.
  // Widening the class would be more accurate but is a deliberate change, not
  // a silent one — this test is what makes it deliberate.
  it("scores the ideographic full stop as Latin, not CJK", () => {
    expect(estimateTokens("。。。。")).toBe(1);
  });
});

describe("detectLanguage", () => {
  it.each([
    ["pure English", "The supplier shall deliver all goods on time.", "en"],
    ["pure Japanese", "乙は甲に対し代金を支払うものとする。", "ja"],
    [
      "English with a Japanese clause",
      `${"a".repeat(90)}日本語の文です`,
      "mixed",
    ],
    ["English with a single kanji", `${"a".repeat(200)}漢`, "en"],
  ] as const)("classifies %s as %s", (_label, input, expected) => {
    expect(detectLanguage(input)).toBe(expected);
  });

  // Guards the `Math.max(s.length, 1)` divisor — without it the ratio is NaN
  // and every comparison is false, so an empty document would be "en" by
  // accident rather than by design.
  it("classifies an empty string as English rather than crashing", () => {
    expect(detectLanguage("")).toBe("en");
  });
});

describe("splitUnits", () => {
  it.each([
    [
      "an English sentence pair",
      "Pay within 30 days. Late fees apply.",
      ["Pay within 30 days.", " Late fees apply."],
    ],
    [
      "a Japanese run separated only by 。",
      "支払いは30日以内。遅延損害金が発生します。",
      ["支払いは30日以内。", "遅延損害金が発生します。"],
    ],
    ["a decimal", "A rate of 2.5% applies.", ["A rate of 2.5% applies."]],
    [
      "a section number",
      "Section 3.1 covers PPE.",
      ["Section 3.1 covers PPE."],
    ],
    ["stacked enders", "A!? B.", ["A!?", " B."]],
    ["no ender at all", "No ender at all", ["No ender at all"]],
  ] as const)("splits %s", (_label, input, expected) => {
    expect(splitUnits(input)).toEqual(expected);
  });

  // The paragraph break rides on the first sentence of the paragraph rather
  // than living in a separate field, which is what lets the packer rejoin units
  // with "" and reproduce the original spacing exactly in both scripts.
  it("carries a paragraph break on the sentence that follows it", () => {
    expect(splitUnits("A.\n\nB.")).toEqual(["A.", "\n\nB."]);
  });

  it("does not emit an empty unit for a leading blank line", () => {
    expect(splitUnits("\n\nHello.")).toEqual(["Hello."]);
  });

  it.each([
    ["an empty page", ""],
    ["a whitespace-only page", "  \n\n \t\n"],
  ] as const)("drops %s entirely", (_label, input) => {
    expect(splitUnits(input)).toEqual([]);
  });

  // A known and accepted limitation. The Latin lookahead requires whitespace
  // after the ender, which keeps "2.5%" and "Section 3.1" intact, but an
  // abbreviation is indistinguishable from a sentence end without a dictionary.
  // A spurious split is invisible unless it lands exactly on a chunk boundary,
  // so it is not worth the weight — but it is worth pinning.
  it("splits after an abbreviation period (known limitation)", () => {
    expect(splitUnits("Mr. Smith signed it.")).toEqual([
      "Mr.",
      " Smith signed it.",
    ]);
  });
});

describe("chunkPage", () => {
  it("packs a multi-paragraph English page across paragraph boundaries", () => {
    const page = Array.from({ length: 6 }, (_, i) =>
      enSentence(`p${i}`, 40),
    ).join("\n\n");

    const chunks = chunkPage(page, 1);

    expect(chunks).toHaveLength(1);
    expect(estimateTokens(chunks[0]?.content ?? "")).toBeLessThanOrEqual(
      MAX_TOKENS,
    );
    expect(chunks[0]?.content.match(/\n\n/g)).toHaveLength(5);
  });

  // The case SPEC §7 singles out: Japanese paragraphs are frequently one
  // unbroken run, so the blank-line tier finds nothing and `。` is the only
  // boundary available.
  it("chunks a Japanese page that is one unbroken run split only by 。", () => {
    const page = Array.from({ length: 30 }, (_, i) =>
      jaSentence(String(i), 60),
    ).join("");

    const chunks = chunkPage(page, 1);

    expect(page).not.toContain("\n");
    expect(chunks.length).toBeGreaterThan(1);
    // No whitespace may be injected between Japanese sentences.
    expect(chunks.every((c) => !c.content.includes("\n"))).toBe(true);
  });

  it("keeps English and Japanese together in one mixed chunk", () => {
    const page = `${enSentence("a", 30)}\n\n${jaSentence("1", 60)}`;

    const chunks = chunkPage(page, 1);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toContain("Clause a:");
    expect(chunks[0]?.content).toContain("第1条");
    expect(chunks[0]?.content).toContain("\n\n");
  });

  it.each([
    ["an empty page", ""],
    ["a whitespace-only page", "  \n\n \t\n"],
  ] as const)("returns nothing for %s", (_label, input) => {
    expect(chunkPage(input, 1)).toEqual([]);
  });

  // A blank page in the middle of a PDF is common (chapter separators). If it
  // produced a chunk with empty content, embedMany would reject the batch and
  // the whole document would go to 'failed'.
  it("never emits an empty or untrimmed chunk", () => {
    const page = `\n\n${enSentence("a", 200)}\n\n\n\n${jaSentence("1", 400)}\n\n`;

    const chunks = chunkPage(page, 1);

    expect(chunks.length).toBeGreaterThan(0);
    expect(
      chunks.every((c) => c.content !== "" && c.content === c.content.trim()),
    ).toBe(true);
  });

  // Decision: the budget is a target, not a cap. Cutting a sentence at a
  // character offset would split mid-word and mid-kanji, and
  // text-embedding-3-small accepts 8191 tokens anyway.
  it("emits a sentence longer than the budget whole rather than cutting it", () => {
    const oversized = jaSentence("x", 900);

    const chunks = chunkPage(oversized, 1);

    expect(chunks).toHaveLength(1);
    expect(estimateTokens(chunks[0]?.content ?? "")).toBeGreaterThan(
      MAX_TOKENS,
    );
    expect(sentencesOf(chunks[0]?.content ?? "")).toHaveLength(1);
  });

  // The invariant that makes the exception above precise: a chunk may exceed
  // the budget only when it is a single sentence that could not be split.
  it("never exceeds the budget with a chunk it could have split", () => {
    const page = [
      enSentence("a", 120),
      jaSentence("1", 900),
      enSentence("b", 120),
      jaSentence("2", 80),
    ].join(" ");

    const chunks = chunkPage(page, 1);

    for (const chunk of chunks) {
      const withinBudget = estimateTokens(chunk.content) <= MAX_TOKENS;
      expect(withinBudget || sentencesOf(chunk.content).length === 1).toBe(
        true,
      );
    }
  });

  // An oversized sentence must not drag the overlap carry along with it: that
  // produces an over-budget chunk whose opening is byte-identical to the whole
  // of the chunk before it, so the same text is embedded twice and can occupy
  // two of the five retrieval slots.
  it("never emits a chunk wholly contained in another", () => {
    const page = [
      enSentence("a", 60),
      enSentence("b", 60),
      enSentence("c", 60),
      jaSentence("1", 900),
      enSentence("d", 60),
    ].join(" ");

    const chunks = chunkPage(page, 1);
    const contained = chunks.filter((a, i) =>
      chunks.some((b, j) => i !== j && b.content.includes(a.content)),
    );

    expect(contained).toEqual([]);
  });

  // SPEC §7 step 3. Sized against real contract prose deliberately: a 68-token
  // Japanese clause and a 55-token English one both exceed OVERLAP_TOKENS, so a
  // rule that only ever carries a suffix fitting inside 50 tokens carries
  // nothing at all on exactly the documents this project targets.
  it.each([
    // Joined the way each script actually writes prose: English puts a space
    // after the full stop, Japanese puts nothing after 。
    [
      "English",
      Array.from({ length: 24 }, (_, i) => enSentence(`s${i}`, 55)).join(" "),
    ],
    [
      "Japanese",
      Array.from({ length: 24 }, (_, i) => jaSentence(String(i), 68)).join(""),
    ],
  ] as const)(
    "carries overlap between consecutive %s chunks",
    (_label, page) => {
      const chunks = chunkPage(page, 1);
      const pairs = consecutivePairs(chunks);

      expect(pairs.length).toBeGreaterThan(0);
      for (const { prev, next } of pairs) {
        const carried = carriedSentences(prev, next);

        expect(carried).not.toEqual([]);
        // Overlap is context, not content — it must never eat half the chunk.
        expect(estimateTokens(carried.join(""))).toBeLessThanOrEqual(
          MAX_TOKENS / 2,
        );
      }
    },
  );

  it("carries no more than the overlap budget when a suffix fits inside it", () => {
    const chunks = chunkPage(
      Array.from({ length: 60 }, (_, i) => enSentence(`s${i}`, 20)).join(" "),
      1,
    );

    for (const { prev, next } of consecutivePairs(chunks)) {
      const carried = carriedSentences(prev, next);

      expect(estimateTokens(carried.join(""))).toBeLessThanOrEqual(
        OVERLAP_TOKENS,
      );
    }
  });

  // Page numbers are what the citations resolve against (SPEC §3.4), so this is
  // the one piece of metadata that cannot be wrong.
  it("tags every chunk with the page it was given", () => {
    const page = Array.from({ length: 24 }, (_, i) =>
      jaSentence(String(i), 68),
    ).join("");

    const chunks = chunkPage(page, 7);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.pageNumber === 7)).toBe(true);
  });

  // Pins the call shape SPEC §6 actually uses: text.flatMap((page, i) =>
  // chunkPage(page, i + 1)).
  it("keeps pages distinct when a document is chunked page by page", () => {
    const pages = ["First page.", "Second page.", "Third page."];

    const chunks = pages.flatMap((page, i) => chunkPage(page, i + 1));

    expect(chunks.map((c) => c.pageNumber)).toEqual([1, 2, 3]);
  });
});

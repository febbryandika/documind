import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractPdfText, NO_TEXT_ERROR } from "./extract";

/**
 * The committed fixtures under apps/api/fixtures. Read from disk rather than
 * mocked: the point of this suite is that a real PDF text layer comes back the
 * way the chunker expects, which a stub could never show.
 */
function fixture(name: string) {
  return readFile(new URL(`../../fixtures/${name}`, import.meta.url));
}

describe("extractPdfText", () => {
  it.each([
    ["warehouse-safety.pdf", 10],
    ["supplier-contract.pdf", 12],
  ] as const)("returns one string per page of %s", async (name, expected) => {
    const { totalPages, pages } = await extractPdfText(await fixture(name));

    expect(totalPages).toBe(expected);
    expect(pages).toHaveLength(expected);
    expect(pages.every((page) => page.trim().length > 0)).toBe(true);
  });

  // Page numbers are what citations resolve against (SPEC §3.4), so the mapping
  // from array position to printed page has to be exact — not merely present.
  // Each phrase below sits on exactly one page of its fixture, deep enough into
  // the document that an off-by-one or a collapsed page would be obvious.
  it.each([
    ["warehouse-safety.pdf", "insulated freezer jacket", 6],
    ["supplier-contract.pdf", "支払いサイトは30日", 5],
  ] as const)(
    "keeps %s's text on the page it was printed on",
    async (name, phrase, page) => {
      const { pages } = await extractPdfText(await fixture(name));

      const found = pages.flatMap((text, i) =>
        text.includes(phrase) ? [i + 1] : [],
      );

      expect(found).toEqual([page]);
    },
  );

  // Chrome's PDF export writes 支 as the Kangxi radical ⽀ (U+2F40) and 日 as ⽇.
  // They render identically and compare unequal, so without normalisation a
  // question about 支払い could never retrieve a chunk containing ⽀払い.
  //
  // This also guards the exception table: 民 comes back as ⺠ (U+2EA0), which is
  // in the CJK Radicals Supplement and has no NFKC decomposition, so NFKC alone
  // leaves it in place. If a future fixture edit introduces another supplement
  // radical, this test is what reports it.
  it("normalises CJK radicals back to ideographs", async () => {
    const { pages } = await extractPdfText(
      await fixture("supplier-contract.pdf"),
    );
    const text = pages.join("");

    const radicals = [...text].filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code >= 0x2e80 && code <= 0x2fdf;
    });

    expect(radicals).toEqual([]);
    expect(text).toContain("支払い");
    expect(text).toContain("民事再生手続開始");
  });

  // SPEC §3.2 — the failure the user is expected to recognise and act on. The
  // fixture is drawn entirely with CSS, so it has no text layer at all.
  it("rejects a PDF with no text layer", async () => {
    const scanned = await fixture("scanned-no-text.pdf");

    await expect(extractPdfText(scanned)).rejects.toThrow(NO_TEXT_ERROR);
  });
});

# Fixture documents

Sample operational documents used by the chunking and extraction tests, and by
the retrieval eval (SPEC §9). Both the `.html` source and the generated `.pdf`
are committed — the PDFs are binaries a reviewer cannot diff, so the text they
were made from lives next to them.

| File | Language | Pages | Chunks | Anchor phrase |
|---|---|---|---|---|
| `warehouse-safety.pdf` | English | 10 | 20 | "insulated freezer jacket", page 6 |
| `supplier-contract.pdf` | Japanese | 12 | 26 | 「支払いサイトは30日」, page 5 |
| `scanned-no-text.pdf` | — | 1 | — | drawn in CSS, so it has no text layer |

`src/rag/extract.test.ts` asserts those page numbers, which is what proves the
array position unpdf returns maps to the printed page a citation refers to. Each
anchor phrase occurs exactly once in its document.

Pages carry two to three chunks each, so a top-5 retrieval is a real filter
rather than a pass-through, and consecutive chunks within a page genuinely
overlap — 14 of 14 same-page pairs in the Japanese document do. Both properties
matter for the eval to mean anything.

## Regenerating

Rendered with headless Chrome, so no PDF-authoring dependency is needed. Run
from this directory:

```bash
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
for f in warehouse-safety supplier-contract scanned-no-text; do
  "$CHROME" --headless --disable-gpu --no-pdf-header-footer \
    --print-to-pdf="$f.pdf" "file://$PWD/$f.html"
done
```

`--no-pdf-header-footer` is not optional. Without it Chrome stamps the source
`file://` path and today's date into the text layer of every page, and those
strings end up inside the chunks and their embeddings.

Page counts are asserted by the tests, so if an edit reflows the content past a
page boundary the suite will say so. Check `.page` divs still fit one physical
page each after any substantial edit.

## What the text layer actually looks like

Both visible via `bun run dump-chunks fixtures/<file>.pdf --raw`:

- **Kanji arrive as radical code points.** 支 is written as ⽀ (U+2F40), 日 as ⽇,
  民 as ⺠. They render identically and compare unequal, so `extract.ts`
  normalises them — without it a question about 支払い could never match a chunk
  containing ⽀払い. Kangxi Radicals (U+2F00–2FDF) decompose under NFKC in 214 of
  224 cases; the CJK Radicals Supplement (U+2E80–2EFF) decomposes in only 2 of
  128, so those are handled by an explicit table in `extract.ts` covering the
  substitutions actually observed. The extraction test asserts no radical
  survives, so a new one fails the suite rather than corrupting retrieval.
- **Hard line-wrap newlines land mid-sentence and there are no blank lines at
  all**, so the paragraph tier of `chunkPage` never fires on these files and
  everything is packed at sentence granularity. Left as-is deliberately:
  rejoining wrapped lines cannot distinguish a heading break from a wrap break,
  so headings would be glued onto the paragraph that follows them.

# Fixture documents

Sample operational documents used by the chunking and extraction tests, and by
the retrieval eval (SPEC §9). Both the `.html` source and the generated `.pdf`
are committed — the PDFs are binaries a reviewer cannot diff, so the text they
were made from lives next to them.

| File | Language | Pages | Chunks | Anchor phrase |
|---|---|---|---|---|
| `warehouse-safety.pdf` | English | 10 | 20 | "insulated freezer jacket", page 6 |
| `supplier-contract.pdf` | Japanese | 12 | 26 | 「支払いサイトは30日」, page 5 |
| `equipment-manual.pdf` | mixed | 13 | 27 | 「最大処理能力は毎分12箱」, page 12 |
| `scanned-no-text.pdf` | — | 1 | — | drawn in CSS, so it has no text layer |

`src/rag/extract.test.ts` asserts those page numbers, which is what proves the
array position unpdf returns maps to the printed page a citation refers to. Each
anchor phrase occurs exactly once in its document.

It also asserts the detected language of each file. That matters most for the
equipment manual: it is an English manual for a machine built in Japan, so the
Japanese is confined to the panel legends, the fault messages, the untranslated
safety notice on page 3 and the quick reference on page 12. That puts its CJK
ratio at ~0.07 against `detectLanguage`'s 0.05 threshold — enough to classify as
`mixed`, but close enough that trimming any of those sections would silently
reclassify it as `en` and stop the fixture exercising the branch it exists for.

The manual deliberately says several things twice, once in each language — the
800 mm clearance, the 60 second bleed-down, the 25 kg case limit. That is what a
real bilingual manual does, and it is why the golden set (`eval/golden.json`)
tags only facts that appear on exactly one page. Each entry there carries the
`anchor` phrase its page was read off, and `eval/run.ts` re-checks all fifteen
against the fixtures before it spends anything on embeddings.

Pages carry two to three chunks each, so a top-5 retrieval is a real filter
rather than a pass-through, and consecutive chunks within a page genuinely
overlap — 14 of 14 same-page pairs in the Japanese document do. Both properties
matter for the eval to mean anything.

## Regenerating

Rendered with headless Chrome, so no PDF-authoring dependency is needed. Run
from this directory:

```bash
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
for f in warehouse-safety supplier-contract equipment-manual scanned-no-text; do
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

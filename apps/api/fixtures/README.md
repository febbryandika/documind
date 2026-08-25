# Fixture documents

Sample operational documents used by the chunking and extraction tests, and
later by the retrieval eval (SPEC §9). Both the `.html` source and the generated
`.pdf` are committed — the PDFs are binaries a reviewer cannot diff, so the text
they were made from lives next to them.

| File | Language | Pages | Notes |
|---|---|---|---|
| `warehouse-safety.pdf` | English | 4 | Cold-storage PPE is on page 3 |
| `supplier-contract.pdf` | Japanese | 4 | Payment terms (30 日) are on page 3 |
| `scanned-no-text.pdf` | — | 1 | Drawn entirely in CSS, so it has no text layer |

`src/rag/extract.test.ts` asserts those page numbers, which is what proves the
array position unpdf returns maps to the printed page a citation refers to.

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

Two things to know about the text layer Chrome produces, both visible via
`bun run dump-chunks fixtures/<file>.pdf --raw`:

- Some kanji are written as Kangxi radical code points (支 as ⽀, 日 as ⽇). They
  render identically but compare unequal, so `extract.ts` normalises those two
  Unicode blocks back to ideographs. Without it a question about 支払い could
  never match a chunk containing ⽀払い.
- Hard line-wrap newlines land mid-sentence and there are no blank lines at all,
  so the paragraph tier of `chunkPage` never fires on these files and everything
  is packed at sentence granularity. Left as-is deliberately: rejoining wrapped
  lines cannot distinguish a heading break from a wrap break.

## Size

These are deliberately short. Each page currently fits inside one chunk, so the
whole of each document is 4 chunks. That is fine for the unit tests, but **the
retrieval eval (SPEC §9, build-order step 8) needs longer documents to mean
anything** — with 4 chunks in a document, a top-5 search returns all of them and
hit-rate@5 is 100% by construction. Grow these before writing `golden.json`.

# DocuMind

Operations document Q&A for small businesses — ask a question, get an answer cited to the page.

> **Status: scaffolding.** This README is a placeholder. The real one is written in build-order
> step 12 and is the actual deliverable (SPEC §12).

## Retrieval quality

Measured, not asserted. `bun run eval` re-ingests the three fixture documents into a
scratch database and runs 15 hand-written questions through the same `retrieve()` the
app uses.

**hit-rate@5 100%  ·  MRR 0.967  ·  mean top-hit similarity 0.519**

```bash
docker compose --profile eval up -d postgres-eval   # scratch database, port 5433
cd apps/api && bun run eval
```

It runs on demand only. It re-ingests from scratch on every run, so it costs OpenAI calls
(~73 chunk embeddings plus one per question) and it reads its own `EVAL_DATABASE_URL` —
refusing to start if that is unset or equal to `DATABASE_URL`, because the run begins by
deleting every document in whatever it is pointed at. It is not wired into CI.

### Method

15 questions over three committed fixtures — a warehouse safety procedure (English, 10
pages), a supplier contract (Japanese, 12 pages) and an equipment manual (mixed EN/JA, 13
pages). Five questions per document, five of the fifteen asked in Japanese, and two
deliberately cross-language: an English question whose answer is a Japanese clause, and a
Japanese question whose answer is English prose.

Each question is tagged with the page that actually contains its answer, plus the anchor
phrase that page number was read off. The eval re-checks all fifteen anchors against the
fixtures before it spends anything on embeddings, because a golden set tagged with the
wrong page scores correct retrieval as a miss — and the natural response to a bad number
is to start tuning against a broken ruler.

A hit means the tagged page appears in the top 5. Scoring is a strict page match: chunk
overlap means an answer can legitimately surface from a neighbouring page's chunk and
still score as a miss. That is left alone — an honest ruler that occasionally
under-reports is worth more than a lenient one nobody trusts.

### Tuning

Every setting was measured, not guessed. Chunk size and overlap were each moved in both
directions from the starting values and the eval re-run:

| chunk / overlap / k | hit-rate@1 | hit-rate@5 | MRR | mean top-sim |
|---|---|---|---|---|
| **300 / 50 / 5  (kept)** | **93.3%** | **100%** | **0.967** | **0.519** |
| 150 / 50 / 5 | 86.7% | 100% | 0.922 | 0.570 |
| 600 / 50 / 5 | 66.7% | 100% | 0.811 | 0.461 |
| 300 / 0 / 5 | 93.3% | 100% | 0.967 | 0.520 |
| 300 / 100 / 5 | 93.3% | 100% | 0.967 | 0.510 |

Nothing beat the starting configuration, so nothing changed. Three things the table says
that the headline number does not:

- **hit-rate@5 is saturated.** It reads 100% under every setting tried, including ones
  that are clearly worse. Fixtures of 20–27 chunks mean a top-5 already covers a fifth of
  each document, so at this scale the metric cannot separate good retrieval from adequate
  retrieval. hit-rate@**1** and MRR are the signals that actually move, and they are what
  the chunk size was chosen on: 600-token chunks bury the answer below the top hit in a
  third of cases.
- **Mean top-hit similarity is a diagnostic, not a quality score.** 150-token chunks score
  the *highest* similarity of any setting (0.570) while ranking *worse* than the baseline.
  Shorter chunks dilute less, so the cosine goes up whether or not the right passage won.
- **Overlap is untested, not disproven.** Moving it from 50 to 0 and to 100 changed
  nothing, because none of the fifteen answers happens to straddle a chunk boundary. That
  is a gap in the golden set, not evidence about overlap.

There is deliberately **no reranker, no hybrid search and no query rewriting** — see the
non-goals. At 100%/0.967 there is nothing for one to fix, and adding a stage that cannot
be shown to help is how a retrieval pipeline gets expensive without getting better.

### What this number does not cover

hit-rate@5 measures **retrieval**. It is blind to what the model then does with the
passages it was handed. The golden set keeps one standing example: asked
`遅延損害金の年率は？` the answer is retrieved correctly and `gpt-4o-mini` states the
correct 14.6% — while sometimes citing a different `[n]` than the block it drew from. The
eval scores that as a pass. It is a generation failure, and catching it needs a different
instrument.

## Local setup

```bash
docker compose up -d          # postgres + pgvector on :5432
                              # port taken? POSTGRES_PORT=5438 docker compose up -d
                              # (then match DATABASE_URL in apps/api/.env)

cd apps/api                   # Bun
bun install
cp .env.example .env
bun run dev                   # http://localhost:3001

cd ../web                     # pnpm — a separate install, not a workspace
pnpm install
cp .env.example .env.local
pnpm dev                      # http://localhost:3000
```

End-to-end tests need browsers once: `pnpm exec playwright install chromium`.

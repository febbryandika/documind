# DocuMind

Operations document Q&A for small businesses — ask a question, get an answer cited to the page.

## Try it

The full flow runs locally in three commands — see [Local setup](#local-setup) — against a
seeded demo account:

```
demo@documind.app
documind-demo
```

Three operational documents are already ingested and `ready`, so nothing waits on an embed
job. Upload and delete are blocked for this account (SPEC §11) — everything else works.

| Document | Language | Try asking |
|---|---|---|
| `warehouse-safety.pdf` | English | What PPE is required in the cold storage area? |
| `supplier-contract.pdf` | Japanese | 支払い条件は何日ですか？ |
| `equipment-manual.pdf` | Mixed EN/JA | What is the maximum throughput of the machine? |

The third is the interesting one: an English question against a document whose safety
notice and quick reference are in Japanese.

### Hosted status

The Next.js app is deployed at **https://REPLACE-ME.vercel.app**, but **the API is not hosted
yet**, so signing in there will not work — the UI is a shell over a backend that is not running.

That is a deliberate hold rather than an oversight. SPEC §11 requires `min_machines_running = 1`
because ingest is an in-process background job (SPEC §6), and no free host provides it: Fly ended
free allowances for new accounts, Render's free tier sleeps after 15 minutes with a ~1 minute
spin-up, Koyeb's free instance is 0.1 vCPU and scales to zero after an hour, and Cloudflare
Workers caps free requests at 10 ms of CPU — less than this app's auth check alone, never mind
parsing a PDF. Cloudflare Containers would fit but starts at $5/month.

`docs/DEPLOYMENT.md` has the comparison and the steps for each option.

> **Status: scaffolding.** This README is a placeholder. The real one is written in build-order
> step 12 and is the actual deliverable (SPEC §12).

## Retrieval quality

Measured, not asserted. `bun run eval` re-ingests the three fixture documents into a
scratch database and runs 15 hand-written questions through the same `retrieve()` the
app uses.

**hit-rate@5 100%  ·  MRR 0.967  ·  mean top-hit similarity 0.519**

```bash
docker compose --profile eval up -d postgres-eval   # scratch database, port 5433
                                                    # port taken? POSTGRES_EVAL_PORT=5440 ...
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

## Running it in anger

What the app does when things go wrong, and what any of it costs.

### Cost

Read off Langfuse after ingesting the three fixtures through the running API, not
estimated. `text-embedding-3-small` for ingest, `gpt-4o-mini` for answers.

| | pages | chunks | tokens | cost |
|---|---|---|---|---|
| Warehouse safety procedure (EN) | 10 | 20 | 4,027 | **$0.000081** |
| Supplier contract (JA) | 12 | 26 | 7,811 | **$0.000156** |
| Equipment manual (mixed) | 13 | 27 | 5,694 | **$0.000114** |

So a 10–13 page operational PDF costs **about a hundredth of a cent** to ingest —
roughly **$0.01 per hundred documents**. A question costs **$0.00021**, of which the
question's own embedding is $0.0000002: **generation is 99.9% of it**, so `k` and chunk
size move retrieval quality (above) far more than they move the bill.

One number here is worth more than the others. The Japanese contract costs **651 tokens
per page against the English procedure's 403** — a page of Japanese is simply more tokens,
because a CJK character is about one token where a Latin one is about a quarter. It is the
same fact the chunker is built around, showing up in the invoice: budgeting chunks
by character count would have produced Japanese chunks roughly three times the size of the
English ones, and this is the scale of the difference that would have been hiding in.

Only the API holds `OPENAI_API_KEY`; the web app never calls OpenAI. Verified rather
than asserted — `apps/web` imports exactly two things from `apps/api`, both `import
type`, and a production build's client bundle contains no reference to the key or to
`OPENAI` at all.

### Rate limit

**20 questions per hour per user**, in Hono middleware, answered with `429` and a
sentence saying when to come back.

The counter is an in-memory `Map`, so it is **per process**. A second API instance would
hand each its own allowance. That is a real limitation and it is left in: a job queue and
Redis are non-goals (see below), the API runs as one Fly machine with
`min_machines_running = 1`, and reaching for Redis to bound a demo's spend would cost more
in infrastructure than the problem is worth. If this ever ran on two machines, this is the
line that would need rewriting.

### Tracing

Langfuse collects the AI SDK's telemetry over OpenTelemetry. Asking a question produces
**one trace** — the question's embedding and the generation as two children of it —
tagged with the user and, as the session, the document being asked about. Ingesting a
document produces one trace covering every embedding batch, which is where the figure
above comes from.

Two things are worth watching, and they are the reason tracing is in scope at all:
cost per ingested document, and **the top hit's similarity on a question that produced a
bad answer**. The second is recorded on every question trace next to the answer itself,
because a bad answer is diagnosed by what retrieval handed the model — and once
diagnosed, it becomes a new case in the golden set above.

Tracing is off unless `LANGFUSE_*` is set. A fresh clone boots and answers without it.

### When something goes wrong

A failed upload or a failed answer says what happened in a sentence someone can act on.
Errors are never echoed verbatim from the server: a missing-key error names the
environment variable and an OpenAI `401` body echoes a key prefix, so the API keeps an
allow-list of messages that may be shown and answers everything else generically, with a
request id to quote. Every response carries that id in `x-request-id`, and every request
is one structured JSON log line.

| What happened | What you see |
|---|---|
| PDF is a scan with no text layer | It has no selectable text, and only a text PDF can be searched |
| Over 10MB, or not a PDF | Rejected on the way in — content type, magic bytes, and a streamed body cap |
| Over 200 pages | Rejected before the first embedding, which is what makes it a cost guard |
| Ingest failed | The reason, on the document, with "delete it and upload again" |
| Out of questions | How many, and when you can ask again |
| Asked while still processing | Said plainly, rather than a raw JSON error body |
| Search or the model is down | Temporary and specific, and the question stays in the box |

## Local setup

```bash
docker compose up -d          # postgres + pgvector on :5432
                              # port taken? POSTGRES_PORT=5438 docker compose up -d
                              # (then match DATABASE_URL in apps/api/.env)

cd apps/api                   # Bun
bun install
cp .env.example .env
bun run db:migrate
bun run db:seed               # demo@documind.app + 3 ready documents
                              # costs ~73 embeddings (~$0.001); safe to re-run
bun run dev                   # http://localhost:3001

cd ../web                     # pnpm — a separate install, not a workspace
pnpm install
cp .env.example .env.local
pnpm dev                      # http://localhost:3000
```

End-to-end tests need browsers once: `pnpm exec playwright install chromium`.

## Deploying

Vercel (web) · Neon (Postgres + pgvector) · **API host still open**.

The web app deploys from Vercel's dashboard, connected to this repo — no CLI, nothing installed
locally, no GitHub Actions. `Dockerfile` and `.dockerignore` at the repo root build the API from
`apps/api` and are verified working; `fly.toml` is written for Fly.io, the intended target in
SPEC §11. What is missing is a host willing to keep a process alive for free.

[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) has the Vercel steps, a comparison of every host
considered with the reason each was or was not taken, and why the web app proxies API traffic
through its own origin instead of calling the API directly.

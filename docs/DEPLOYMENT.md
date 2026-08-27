# Deployment

```
Next.js (Vercel) ──rewrite──> Hono on Bun (Fly.io) ──> Neon Postgres + pgvector
```

Three hosts, and one ordering problem: the API needs the web origin for CORS, and the web
app needs the API origin for its rewrite. Both names are yours to choose, so pick them
first and the circular dependency disappears.

| | Name you pick | Origin |
|---|---|---|
| API | `documind-api` (must be unique across all of Fly) | `https://documind-api.fly.dev` |
| Web | `documind` | `https://documind.vercel.app` |

If either is taken, substitute throughout — nothing below hardcodes them except the `app`
line in `apps/api/fly.toml`.

## Prerequisites

```bash
brew install flyctl          # not installed on this machine
pnpm add -g vercel           # or npm i -g vercel
fly auth signup              # Fly requires a card: free allowances ended for new
                             # accounts, and min_machines_running = 1 is always-on
vercel login
```

## 0. Neon — already done

The `documind` project exists (`bold-sunset-99227002`), single branch `production`, all
seven tables migrated and `CREATE EXTENSION vector` applied. Nothing to create.

Verify, and grab the **pooled** connection string:

```bash
psql "$DATABASE_URL" -c '\dt'          # 7 tables
psql "$DATABASE_URL" -c 'SELECT extname FROM pg_extension'
```

> Strip `&channel_binding=require` from whatever the Neon console gives you. It is a
> libpq-only setting; postgres.js forwards it as a Postgres *startup* parameter instead.

`drizzle-kit` is a devDependency and is not in the image, so migrations always run from
your machine (`bun run db:migrate`), never inside the container.

## 1. Fly — the API

```bash
cd apps/api
fly apps create documind-api          # match `app` in fly.toml

fly secrets set \
  DATABASE_URL='postgresql://...neon.tech/neondb?sslmode=require' \
  BETTER_AUTH_SECRET="$(openssl rand -base64 32)" \
  BETTER_AUTH_URL='https://documind-api.fly.dev' \
  WEB_ORIGIN='https://documind.vercel.app' \
  OPENAI_API_KEY='sk-...' \
  DEMO_USER_EMAIL='demo@documind.app' \
  DEMO_USER_PASSWORD='documind-demo'

fly deploy
fly status                            # expect exactly one machine, started
curl https://documind-api.fly.dev/health
```

`src/auth.ts` throws at boot if `BETTER_AUTH_URL`, `WEB_ORIGIN` or `BETTER_AUTH_SECRET` is
missing, so a forgotten secret is a crash loop rather than a silent degrade — `fly logs`
will say which one.

Langfuse is optional: set `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and
`LANGFUSE_BASE_URL` (not `BASEURL`) to turn tracing on, leave them unset and the API still
boots and answers.

**Do not enable auto-stop.** `fly.toml` sets `auto_stop_machines = 'off'` and
`min_machines_running = 1` because ingest is an in-process background job — a machine that
stops between requests drops work that already returned `202`. The 20-questions/hour rate
limit is also an in-memory `Map`, so it is only correct while there is exactly one machine.

## 2. Vercel — the web app

Create the project from the repo, then set three things that are **not** defaults:

| Setting | Value |
|---|---|
| Root Directory | `apps/web` |
| Install Command | `bun install --cwd ../api && pnpm install` |
| Framework | Next.js (auto-detected) |

The install override is not optional. `apps/web/lib/api.ts` type-imports `AppType` from
`apps/api/src/index.ts`, which drags the whole server graph into the type program —
`next build` resolves `hono`, `drizzle-orm`, `postgres`, `unpdf` and `@langfuse/*` out of
`apps/api/node_modules`. With only `apps/web` installed the build fails type-checking.
It respects the split: Bun for `apps/api`, pnpm for `apps/web`, never crossed.

Environment variables (Production):

```
API_ORIGIN          = https://documind-api.fly.dev
NEXT_PUBLIC_API_URL = https://documind.vercel.app/api-proxy
```

`NEXT_PUBLIC_*` is inlined at **build** time, so changing it later needs a redeploy, not
just a save. If the production domain turned out different from what you picked, fix both
`NEXT_PUBLIC_API_URL` here and `WEB_ORIGIN` on Fly, then redeploy both.

Deploy, then sanity-check the proxy before touching the browser:

```bash
curl https://documind.vercel.app/api-proxy/health          # {"status":"ok"}
```

## 3. Seed the demo account

Run it **inside the machine**, so the production `DATABASE_URL` and `OPENAI_API_KEY` never
land on your laptop:

```bash
fly ssh console --app documind-api
cd /app && bun run src/db/seed.ts
```

Expect:

```
ingested warehouse-safety.pdf   en · 10 pages · 20 chunks
ingested supplier-contract.pdf  ja · 12 pages · 26 chunks
ingested equipment-manual.pdf   mixed · 13 pages · 27 chunks
```

It is safe to re-run — it drops the demo user first, which cascades to its documents,
chunks and messages — but it re-embeds all 73 chunks each time (~$0.001).

## 4. Verify

1. Open the site signed out → redirected to `/sign-in`.
2. Sign in as `demo@documind.app` / `documind-demo`.
3. Open `warehouse-safety.pdf`, ask *What PPE is required in the cold storage area?* →
   a streamed answer citing page 6.
4. Ask `支払い条件は何日ですか？` against `supplier-contract.pdf` → an answer **in
   Japanese** citing page 5.
5. Click a citation chip.
6. Try to delete a document → `403`, "The demo account is read-only".
7. `fly status` still shows one machine.

Finally, replace `https://REPLACE-ME.vercel.app` at the top of `README.md`.

## Environment reference

| Variable | Where | Notes |
|---|---|---|
| `DATABASE_URL` | Fly | Neon pooled URL, `channel_binding` stripped |
| `BETTER_AUTH_SECRET` | Fly | `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | Fly | The Fly origin. `https://` here is what switches cookies to `SameSite=None; Secure` |
| `WEB_ORIGIN` | Fly | Exact Vercel production origin — CORS *and* `trustedOrigins`. Preview URLs are rejected, deliberately |
| `OPENAI_API_KEY` | Fly | Never on the web app (SPEC §14) |
| `DEMO_USER_EMAIL` | Fly | Arms the upload/delete guard. Unset = demo is wide open |
| `DEMO_USER_PASSWORD` | Fly | Published in the README by design |
| `LANGFUSE_*` | Fly | Optional; tracing stays off without them |
| `API_ORIGIN` | Vercel | Server-side. Feeds the rewrite in `next.config.ts` |
| `NEXT_PUBLIC_API_URL` | Vercel | The Vercel origin **plus `/api-proxy`**, not the Fly origin |

## Why the `/api-proxy` rewrite exists

Better Auth sets the session cookie from the API, which scopes it to `*.fly.dev`. But
`apps/web/proxy.ts` reads that cookie on the Vercel origin, where it can never exist — so
sign-in would succeed and then every protected page would bounce back to `/sign-in`. It
works locally only because both apps sit on `localhost`, and cookies ignore the port.

Routing API traffic through `/api-proxy` on the Vercel origin puts the `Set-Cookie` where
the guard can read it. Three consequences worth knowing:

- The prefix is `/api-proxy`, not `/api`, because `/documents` and `/documents/:id` are
  real page routes and a rewrite would shadow them.
- `proxy.ts` needs no change: its `api` exclusion already covers anything starting with
  `api`. Were those requests gated, sign-in itself could never complete.
- `apps/web/lib/auth-client.ts` spells out `/api/auth`. Better Auth only appends its base
  path when `baseURL` is a bare origin; given one that already has a path it treats that
  as the complete auth base and silently drops `/api/auth`.

The alternative is a custom domain with the web and API on sibling subdomains plus
`crossSubDomainCookies`. That is tidier and costs a domain.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Sign-in succeeds, then bounces to `/sign-in` | `NEXT_PUBLIC_API_URL` points at the Fly origin instead of `<vercel>/api-proxy` — the cookie is landing on the wrong domain |
| `404` on `/api-proxy/...` | `API_ORIGIN` unset at build time; `next.config.ts` registers no rewrite without it |
| Vercel build fails on `Cannot find module 'hono'` | Install Command override missing |
| API crash-loops on boot | A required secret is unset — `fly logs` names it |
| `unrecognized configuration parameter "channel_binding"` | Strip it from `DATABASE_URL` |
| Upload succeeds as the demo user | `DEMO_USER_EMAIL` not set on Fly |
| A document sits in `processing` forever | The machine restarted mid-ingest; the boot sweep marks anything older than 10 minutes `failed` |

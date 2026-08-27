# Deployment

```
Next.js (Vercel) ──/api-proxy rewrite──> Hono on Bun (not hosted yet) ──> Neon Postgres + pgvector
```

**Current state:** the web app deploys to Vercel and the database is live on Neon, already
migrated and seeded. **The API is not hosted.** Part 2 explains why and what the options cost.

Nothing here needs a terminal or a local install — Vercel is driven entirely from its dashboard.
GitHub Actions is deliberately unused; this account's minutes are exhausted.

---

## Part 1 — Vercel (the web app)

### 1.1 Import the repo

1. **[vercel.com/new](https://vercel.com/new)** → import `febbryandika/documind`.
2. Name the project **`documind`**. Vercel picks the production domain itself, and
   `documind.vercel.app` was already taken — this project landed on
   **`documind-gules-two.vercel.app`**. Read the assigned domain off the project Overview
   before setting the env var below; it is not predictable.

### 1.2 Two settings that are not defaults

| Setting | Value |
|---|---|
| Root Directory | `apps/web` (expand `apps` in the picker and choose `web`) |
| Install Command (override) | `bun install --cwd ../api && pnpm install` |

Setting the Root Directory also flips the Application Preset from `Other` to `Next.js`, which
is how you know it took. There is no "include files outside the root directory" toggle in the
current import flow — Vercel checks out the whole repo regardless, which the successful
`bun install --cwd ../api` proves.

The Install Command override is the one people miss, and the build fails without it.
`apps/web/lib/api.ts` type-imports `AppType` from `apps/api/src/index.ts`, which pulls the whole
server graph into the type check — `next build` resolves `hono`, `drizzle-orm`, `postgres` and
`unpdf` out of `apps/api/node_modules`. The two apps are separate installs with no workspace, so
Vercel won't install them unless told to. The override keeps the split intact: Bun for `apps/api`,
pnpm for `apps/web`, never crossed.

### 1.3 Environment variables

Set one, for **Production**:

```
NEXT_PUBLIC_API_URL = https://documind-gules-two.vercel.app/api-proxy
```

**Set Type to `Config`, not `Secret`.** Vercel defaults new variables to Secret and then refuses
to save a `NEXT_PUBLIC_*` one that way — "Public prefixes expose values to the browser" — and a
variable already saved as a Secret **cannot be converted**, so the only fix is to delete it and
add it again. Getting the domain wrong here is worse than a broken link: the sign-in form would
POST credentials to a domain you do not own.

Leave `API_ORIGIN` **unset** for now. `next.config.ts` registers no rewrite without it, which is
correct while there is no API — and when you do host one, adding it is the only change needed.

`NEXT_PUBLIC_*` is baked in at build time, so changing it later needs a redeploy, not just a save.

### 1.4 Deploy

The site will render, `/` will redirect to `/sign-in`, and signing in will fail — there is no API
behind `/api-proxy` yet. That is expected until Part 2. Nothing crashes: `apps/web/lib/api.ts`
translates transport failures into a sentence rather than a stack trace.

**Done** — live at **https://documind-gules-two.vercel.app**, deployed from `main`, with the
URL recorded in `README.md`.

---

## Part 2 — The API host (not done yet)

The API is a long-lived Bun process on purpose. SPEC §6 runs ingest **in-process** — a capped FIFO
holding module-level state — which is why SPEC §1 can rule out a job queue and SPEC §11 requires
`min_machines_running = 1`. A host that stops the process between requests breaks that guarantee,
and one without a persistent process breaks the design outright.

That is the whole difficulty: no free host provides it.

| Host | Cost | Verdict |
|---|---|---|
| **Fly.io** | ~$2–6/mo, card required | The intended target. `fly.toml` in this repo is written for it, `auto_stop_machines = 'off'` and all. Free allowances ended for new accounts. |
| **Google Cloud Run** | $0 within a generous free tier, **card required** | Best technical fit after Fly — `asia-southeast1` sits next to Neon, and cold starts are 1–2s. Billing account is mandatory even at $0. |
| **Koyeb** | Free, no card | 512 MB / **0.1 vCPU**, Frankfurt or Washington only, scales to zero after 1 h idle (wake 1–5 s) and that cannot be disabled. Workable — the demo's hot path is nearly all network wait — but `min_machines_running` is gone. A free uptime pinger on `/health` closes most of the gap. |
| **Render** | Free | Same 512 MB / 0.1 vCPU, but sleeps after **15 minutes** with a **~1 minute** spin-up. That alone breaks the under-30-seconds demo target. |
| **Cloudflare Workers** | Free | **Not viable.** 10 ms CPU per request on the free plan — Cloudflare's own docs put auth-handling workloads at 10–20 ms, and pdf.js parsing is seconds. Worse, Workers are ephemeral isolates with no home for the ingest FIFO, so porting means adding Queues or Durable Objects — the exact non-goal SPEC §1 is built around. |
| **Cloudflare Containers** | $5/mo minimum | Right shape, wrong price. Listed as `N/A` on the free plan. |

Whichever you pick, the artefacts are ready: `Dockerfile` and `.dockerignore` at the repo root
build the API from `apps/api`, verified at 392 MB and serving against Neon.

### When you host it

1. Deploy the container, and set these as secrets on that host:

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | Neon **pooled** URL, `&channel_binding=require` stripped |
   | `BETTER_AUTH_SECRET` | 32 random bytes |
   | `BETTER_AUTH_URL` | The API's own origin |
   | `WEB_ORIGIN` | `https://documind-gules-two.vercel.app` — exact production origin |
   | `OPENAI_API_KEY` | `sk-...` |
   | `DEMO_USER_EMAIL` | `demo@documind.app` |
   | `DEMO_USER_PASSWORD` | `documind-demo` |
   | `LANGFUSE_*` | Optional; tracing stays off without them |

   `src/auth.ts` throws at boot if `BETTER_AUTH_URL`, `WEB_ORIGIN` or `BETTER_AUTH_SECRET` is
   missing, so a typo is a crash loop, not a silent failure — the host's logs will name it.

2. On Vercel, add `API_ORIGIN` = the API's origin, and **redeploy**.
3. Check `https://documind-gules-two.vercel.app/api-proxy/health` → `{"status":"ok"}`.
4. Run through [Part 4](#part-4--verify).

If the host is far from Neon's `ap-southeast-1` (Koyeb's free regions are Frankfurt and
Washington), consider creating a Neon project in a matching region and re-running
`bun run db:migrate` and `bun run db:seed` against it. Every question makes several round trips.

---

## Part 3 — The demo data

**Already done.** The three documents were seeded into the Neon branch any API host will point at,
so `demo@documind.app` and its 73 chunks are live already.

You only need this if you reset the branch. Your local `DATABASE_URL` points at that same
database, so re-seeding is a local command:

```bash
cd apps/api && bun run db:seed
```

It drops the demo user first (cascading to its documents, chunks and messages) and re-embeds all
73 chunks, ~$0.001 a run.

---

## Part 4 — Verify

Once an API is hosted:

1. Open the site signed out → redirected to `/sign-in`.
2. Sign in with `demo@documind.app` / `documind-demo`.
3. Open **warehouse-safety.pdf**, ask *What PPE is required in the cold storage area?* → a
   streamed answer citing page 6.
4. Open **supplier-contract.pdf**, ask `支払い条件は何日ですか？` → an answer **in Japanese**
   citing page 5.
5. Click a citation chip.
6. Try to delete a document → `403`, "The demo account is read-only".
7. Time a cold visit from step 1 to step 3's answer — the target is under 30 seconds.

---

## Environment reference

| Variable | Where | Notes |
|---|---|---|
| `DATABASE_URL` | API host | Neon **pooled** URL, `channel_binding` stripped |
| `BETTER_AUTH_SECRET` | API host | 32 random bytes |
| `BETTER_AUTH_URL` | API host | The API origin. `https://` here is what switches cookies to `SameSite=None; Secure` |
| `WEB_ORIGIN` | API host | Exact Vercel production origin — CORS *and* `trustedOrigins`. Preview URLs are rejected, deliberately |
| `OPENAI_API_KEY` | API host | Never on the web app (SPEC §14) |
| `DEMO_USER_EMAIL` | API host | Arms the upload/delete guard. Unset = the demo is wide open |
| `DEMO_USER_PASSWORD` | API host | Published in the README by design |
| `LANGFUSE_*` | API host | Optional. `LANGFUSE_BASE_URL`, not `BASEURL` |
| `API_ORIGIN` | Vercel | Server-side. Feeds the rewrite in `next.config.ts`. **Unset until an API exists** |
| `NEXT_PUBLIC_API_URL` | Vercel | Vercel origin **plus `/api-proxy`**, not the API origin |

## Why the `/api-proxy` rewrite exists

Better Auth sets the session cookie from the API, which scopes it to the API's domain. But
`apps/web/proxy.ts` reads that cookie on the Vercel origin, where it can never exist — so sign-in
would succeed and then every protected page would bounce back to `/sign-in`. It works locally only
because both apps sit on `localhost`, and cookies ignore the port.

Routing API traffic through `/api-proxy` on the Vercel origin puts the `Set-Cookie` where the
guard can read it. Three consequences worth knowing:

- The prefix is `/api-proxy`, not `/api`, because `/documents` and `/documents/:id` are real page
  routes and a rewrite would shadow them.
- `proxy.ts` needs no change: its `api` exclusion already covers anything starting with `api`.
  Were those requests gated, sign-in itself could never complete.
- `apps/web/lib/auth-client.ts` spells out `/api/auth`. Better Auth only appends its base path
  when `baseURL` is a bare origin; given one that already has a path it treats that as the
  complete auth base and silently drops `/api/auth`.

The tidier alternative is a custom domain with web and API on sibling subdomains plus
`crossSubDomainCookies` — rejected here because it costs a domain.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Sign-in fails on the deployed site | Expected while no API is hosted — see Part 2 |
| Sign-in succeeds, then bounces to `/sign-in` | `NEXT_PUBLIC_API_URL` points at the API origin instead of `<vercel>/api-proxy` — the cookie is landing on the wrong domain |
| `404` on `/api-proxy/...` | `API_ORIGIN` wasn't set at build time; `next.config.ts` registers no rewrite without it |
| Vercel build: `Cannot find module 'hono'` | Install Command override missing, so `apps/api/node_modules` was never installed |
| `NEXT_PUBLIC_*` variable won't save | Its Type is Secret. Vercel blocks public-prefixed secrets, and a saved secret can't be converted — delete it and re-add as Config |
| Vercel build: `bun: command not found` | Bun isn't on that build image. Fall back to `typescript: { ignoreBuildErrors: true }` in `next.config.ts` — acceptable here because this repo has no CI and typechecks locally before pushing |
| API crash-loops on boot | A required secret is unset — the logs name it |
| `unrecognized configuration parameter "channel_binding"` | Strip it from `DATABASE_URL` |
| Upload succeeds as the demo user | `DEMO_USER_EMAIL` not set on the API host |
| A document sits in `processing` forever | The process restarted mid-ingest; the boot sweep marks anything older than 10 minutes `failed` |

# Deployment — from the browser

```
Next.js (Vercel) ──/api-proxy rewrite──> Hono on Bun (Fly.io) ──> Neon Postgres + pgvector
```

Nothing here needs a terminal or a local install. Everything is done on
[fly.io](https://fly.io) and [vercel.com](https://vercel.com), both connected to the
GitHub repo. If the Fly dashboard can't do it, [Appendix A](#appendix-a--if-the-fly-dashboard-wont-cooperate)
has a browser-terminal fallback that still installs nothing on your machine.

GitHub Actions is deliberately not used — this account's minutes are exhausted, and there
is no `.github/workflows/`.

## Before you start

| | Account | Cost |
|---|---|---|
| API | fly.io | Card required. No free tier for new accounts, and the API is always-on (~$5–6/mo at 1GB) |
| Web | vercel.com | Hobby tier is free |
| DB | Neon | Already set up — nothing to do |

**Pick both names now.** The API needs the web origin and the web app needs the API
origin, so choosing up front turns a circular dependency into one pass each.

| | Name | Origin it produces |
|---|---|---|
| Fly app | `documind-api` | `https://documind-api.fly.dev` |
| Vercel project | `documind` | `https://documind.vercel.app` |

Fly app names are unique across all of Fly, so `documind-api` may be taken. If you change
either name, substitute it everywhere below **and** in the `app =` line of `fly.toml`.

Have these three values ready — copy them somewhere before you begin:

- The Neon connection string (Neon console → Project → Connection string → **pooled**).
  Delete `&channel_binding=require` from the end if it's there.
- Your OpenAI API key.
- A fresh auth secret. Generate one at [generate-secret.vercel.app/32](https://generate-secret.vercel.app/32),
  or any 32-byte random string.

---

## Part 1 — Fly (the API)

### 1.1 Create the app from GitHub

1. Go to **[fly.io/dashboard](https://fly.io/dashboard)** and sign in.
2. Click **Launch an app** (or go to [fly.io/launch](https://fly.io/launch)).
3. Choose **Deploy from GitHub** and authorise Fly to read your GitHub account.
4. Pick **`febbryandika/documind`**. It's a public repo, which this flow supports.
5. Fly reads `fly.toml` and `Dockerfile` from the repo root — that's why they live there
   rather than in `apps/api`.
6. Set the app name to **`documind-api`** and the region to **Singapore (`sin`)**. The
   region matters: Neon is in `ap-southeast-1`, and retrieval makes several round trips
   per question.
7. **Do not deploy yet** if it offers you the choice — set secrets first (1.2), otherwise
   the first boot crash-loops. If it deploys immediately, that's fine; it will recover
   once the secrets are set and you redeploy.

### 1.2 Set the secrets

In the app → **Secrets** → **New secret**. Add each of these:

| Name | Value |
|---|---|
| `DATABASE_URL` | Your Neon pooled connection string |
| `BETTER_AUTH_SECRET` | The 32-byte random string |
| `BETTER_AUTH_URL` | `https://documind-api.fly.dev` |
| `WEB_ORIGIN` | `https://documind.vercel.app` |
| `OPENAI_API_KEY` | `sk-...` |
| `DEMO_USER_EMAIL` | `demo@documind.app` |
| `DEMO_USER_PASSWORD` | `documind-demo` |

`src/auth.ts` throws at boot if `BETTER_AUTH_URL`, `WEB_ORIGIN` or `BETTER_AUTH_SECRET` is
missing, so a typo here is a crash loop rather than a silent failure — the **Live Logs**
tab will name the missing one.

Langfuse is optional. Add `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and
`LANGFUSE_BASE_URL` (note: `BASE_URL`, not `BASEURL`) to turn tracing on; leave them out
and the API still boots and answers.

### 1.3 Deploy and check it

Use the **Deploy** button on the app's Deployments page. Then:

1. **Machines** tab → exactly **one** machine, state `started`.
2. Open `https://documind-api.fly.dev/health` → `{"status":"ok"}`.

### 1.4 Confirm it never scales to zero

This one is not optional. Ingest is an in-process background job, so a machine that stops
between requests drops work that already answered `202`. The rate limiter also counts in
an in-memory `Map`, so its 20-questions/hour is only correct with exactly one machine.

`fly.toml` already sets `auto_stop_machines = 'off'` and `min_machines_running = 1`. If the
Launch UI generated its own config instead of using the committed one, go to the app's
**Scaling** settings and confirm auto-stop / scale-to-zero is **off** and the machine count
floor is **1**.

---

## Part 2 — Vercel (the web app)

### 2.1 Import the repo

1. **[vercel.com/new](https://vercel.com/new)** → import `febbryandika/documind`.
2. Name the project **`documind`** so the production URL is `documind.vercel.app`.

### 2.2 Three settings that are not defaults

Under **Build and Output Settings** / **Root Directory**:

| Setting | Value |
|---|---|
| Root Directory | `apps/web` |
| Include files outside the Root Directory | **On** |
| Install Command (override) | `bun install --cwd ../api && pnpm install` |

The last two are the ones people miss, and the build fails without them.
`apps/web/lib/api.ts` type-imports `AppType` from `apps/api/src/index.ts`, which pulls the
whole server graph into the type check — `next build` resolves `hono`, `drizzle-orm`,
`postgres` and `unpdf` out of `apps/api/node_modules`. The two apps are separate installs
with no workspace, so Vercel won't install them unless told to. The override keeps the
split intact: Bun for `apps/api`, pnpm for `apps/web`, never crossed.

### 2.3 Environment variables

Add both, for **Production**:

| Name | Value |
|---|---|
| `API_ORIGIN` | `https://documind-api.fly.dev` |
| `NEXT_PUBLIC_API_URL` | `https://documind.vercel.app/api-proxy` |

`NEXT_PUBLIC_API_URL` is **your Vercel origin plus `/api-proxy`** — not the Fly origin.
Pointing it at Fly is the single most likely way to break sign-in; see
[why the rewrite exists](#why-the-api-proxy-rewrite-exists).

`NEXT_PUBLIC_*` values are baked in at build time, so changing one later needs a redeploy,
not just a save.

### 2.4 Deploy and check it

Click **Deploy**, then open:

```
https://documind.vercel.app/api-proxy/health
```

`{"status":"ok"}` means the rewrite is reaching Fly. If you get a 404, `API_ORIGIN` wasn't
set at build time — set it and redeploy.

---

## Part 3 — Only if a name changed

If either production URL differs from what you picked:

- Fly → Secrets → update `WEB_ORIGIN` to the real Vercel origin.
- Vercel → Settings → Environment Variables → update `NEXT_PUBLIC_API_URL`, then
  **Redeploy** (a save alone won't do it).

`WEB_ORIGIN` must be the exact production origin. Vercel *preview* URLs are rejected by
CORS and `trustedOrigins` on purpose.

---

## Part 4 — The demo data

**Already done.** The three documents were seeded into the same Neon branch the Fly app
uses, so `demo@documind.app` and its 73 chunks are live before you deploy anything.

You only need this if you reset the branch. Since your local `DATABASE_URL` points at that
same database, re-seeding is a local command, not a Fly one:

```bash
cd apps/api && bun run db:seed
```

It drops the demo user first (cascading to its documents, chunks and messages) and
re-embeds all 73 chunks, ~$0.001 a run.

---

## Part 5 — Verify the demo

1. Open `https://documind.vercel.app` signed out → redirected to `/sign-in`.
2. Sign in with `demo@documind.app` / `documind-demo`.
3. Open **warehouse-safety.pdf**, ask *What PPE is required in the cold storage area?* →
   a streamed answer citing page 6.
4. Open **supplier-contract.pdf**, ask `支払い条件は何日ですか？` → an answer **in
   Japanese** citing page 5.
5. Click a citation chip.
6. Try to delete a document → `403`, "The demo account is read-only".
7. Time a cold visit from step 1 to step 3's answer — the target is under 30 seconds.

Then replace `https://REPLACE-ME.vercel.app` at the top of `README.md` with the real URL.

---

## Environment reference

| Variable | Where | Notes |
|---|---|---|
| `DATABASE_URL` | Fly | Neon **pooled** URL, `channel_binding` stripped |
| `BETTER_AUTH_SECRET` | Fly | 32 random bytes |
| `BETTER_AUTH_URL` | Fly | The Fly origin. `https://` here is what switches cookies to `SameSite=None; Secure` |
| `WEB_ORIGIN` | Fly | Exact Vercel production origin — CORS *and* `trustedOrigins` |
| `OPENAI_API_KEY` | Fly | Never on the web app (SPEC §14) |
| `DEMO_USER_EMAIL` | Fly | Arms the upload/delete guard. Unset = the demo is wide open |
| `DEMO_USER_PASSWORD` | Fly | Published in the README by design |
| `LANGFUSE_*` | Fly | Optional; tracing stays off without them |
| `API_ORIGIN` | Vercel | Server-side. Feeds the rewrite in `next.config.ts` |
| `NEXT_PUBLIC_API_URL` | Vercel | Vercel origin **plus `/api-proxy`**, not the Fly origin |

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

The tidier alternative is a custom domain with web and API on sibling subdomains plus
`crossSubDomainCookies` — rejected here because it costs a domain.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Sign-in succeeds, then bounces to `/sign-in` | `NEXT_PUBLIC_API_URL` points at the Fly origin instead of `<vercel>/api-proxy` — the cookie is landing on the wrong domain |
| `404` on `/api-proxy/...` | `API_ORIGIN` wasn't set at build time; `next.config.ts` registers no rewrite without it |
| Vercel build: `Cannot find module 'hono'` | Install Command override missing, or "include files outside the Root Directory" is off |
| Vercel build: `bun: command not found` | Bun isn't on that build image. Fall back to adding `typescript: { ignoreBuildErrors: true }` to `next.config.ts` — acceptable here because this repo has no CI and typechecks locally before pushing |
| Fly app crash-loops on boot | A required secret is unset — Live Logs names it |
| `unrecognized configuration parameter "channel_binding"` | Strip it from `DATABASE_URL` |
| Upload succeeds as the demo user | `DEMO_USER_EMAIL` not set on Fly |
| A document sits in `processing` forever | The machine restarted mid-ingest; the boot sweep marks anything older than 10 minutes `failed` |

---

## Appendix A — if the Fly dashboard won't cooperate

Fly's browser deploy is newer and less documented than Vercel's, so it may not handle this
repo. If it refuses, use a **GitHub Codespace**: a throwaway Linux container with a
terminal in your browser. Nothing is installed on your machine, and it doesn't consume
GitHub Actions minutes (separate quota, 60 free core-hours a month).

1. On the repo, **Code** → **Codespaces** → **Create codespace on main**.
2. In its terminal:

```bash
curl -L https://fly.io/install.sh | sh
export FLYCTL_INSTALL="/home/codespace/.fly"
export PATH="$FLYCTL_INSTALL/bin:$PATH"

fly auth login            # prints a URL to open and approve
fly apps create documind-api

fly secrets set \
  DATABASE_URL='postgresql://...' \
  BETTER_AUTH_SECRET='...' \
  BETTER_AUTH_URL='https://documind-api.fly.dev' \
  WEB_ORIGIN='https://documind.vercel.app' \
  OPENAI_API_KEY='sk-...' \
  DEMO_USER_EMAIL='demo@documind.app' \
  DEMO_USER_PASSWORD='documind-demo'

fly deploy                # from the repo root — fly.toml and Dockerfile are here
fly status                # expect one machine, started
```

3. Delete the codespace afterwards.

Vercel needs no fallback — its dashboard covers the whole flow.

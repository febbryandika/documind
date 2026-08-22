# DocuMind

Operations document Q&A for small businesses — ask a question, get an answer cited to the page.

> **Status: scaffolding.** This README is a placeholder. The real one is written in build-order
> step 12 and is the actual deliverable (SPEC §12).

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

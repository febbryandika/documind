# Builds apps/api — the Hono/Bun API. It lives at the repo root, with the whole
# repo as its build context, because Fly's GitHub-connected deploys look for
# Dockerfile and fly.toml here and do not take a subdirectory. apps/web is
# excluded in .dockerignore, so the context stays small.
#
# The API is a long-lived Bun process, not a serverless function — that is the
# whole reason ingest can run in-process rather than behind a queue (SPEC §1,
# §6). So this image runs Bun directly: apps/api has no build and no start
# script, and src/index.ts guards its boot side effects (Langfuse registration,
# the stale-ingest sweep) on `import.meta.main`, which only Bun sets.

FROM oven/bun:1.3-slim AS deps
WORKDIR /app
# Manifest and lockfile only, so this layer stays cached until a dependency
# actually moves. --production drops drizzle-kit, vitest and eslint.
COPY apps/api/package.json apps/api/bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3-slim AS release
WORKDIR /app

# src/db/index.ts skips its globalThis pool cache when NODE_ENV is production —
# that cache exists for `bun run --hot`, and a long-lived server does not want it.
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY apps/api/package.json apps/api/bun.lock ./
COPY apps/api/src ./src
COPY apps/api/drizzle ./drizzle
# The seed reads these, so the three demo PDFs ship with the image. ~1MB;
# .dockerignore drops the .html sources they were printed from.
COPY apps/api/fixtures ./fixtures

# Fly injects PORT itself; src/index.ts falls back to 3001 (SPEC §11).
EXPOSE 3001

USER bun
CMD ["bun", "run", "src/index.ts"]

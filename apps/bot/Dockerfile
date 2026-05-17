# syntax=docker/dockerfile:1.7
#
# Multi-stage build for the lead-engine bot. Build context is the MONOREPO
# ROOT (see docker-compose.yml / `docker build -f apps/bot/Dockerfile .`).
# Three stages:
#   1. ui-build — compiles the React admin SPA via Vite into admin-ui/dist.
#   2. deps     — installs deps from the root workspace lockfile.
#   3. runtime  — final image. Pulls in deps + bot source + the prebuilt UI,
#                 and `bun run`s src/index.ts directly (Bun runs TS natively).

ARG BUN_VERSION=1.3.8

# ─── Stage 1: build admin UI ──────────────────────────────────────────
# admin-ui has no @chatman-media/* deps, so it builds standalone — no need
# to hydrate the whole workspace just for the frontend bundle.
FROM oven/bun:${BUN_VERSION}-slim AS ui-build
WORKDIR /app/admin-ui

COPY apps/admin-ui/package.json ./
RUN bun install

COPY apps/admin-ui/. ./
RUN bun run build

# ─── Stage 2: backend deps ────────────────────────────────────────────
FROM oven/bun:${BUN_VERSION}-slim AS deps
WORKDIR /app

# Root manifest + lockfile, plus every workspace package.json so bun can
# resolve the workspace graph. Lockfile-first → install layer reuses on
# source-only edits.
COPY package.json bun.lock ./
COPY apps/bot/package.json ./apps/bot/
COPY apps/admin-ui/package.json ./apps/admin-ui/
COPY packages/rag/package.json ./packages/rag/
COPY packages/sales/package.json ./packages/sales/
COPY packages/storage/package.json ./packages/storage/
# postinstall runs apps/bot/scripts/install-hooks.ts — copy it so the
# script resolves even in this isolated stage (no git, but || true exits ok).
COPY apps/bot/scripts/install-hooks.ts ./apps/bot/scripts/
# No --frozen-lockfile so bun can re-resolve platform-specific optional
# deps (e.g. sqlite-vec-linux-x64) on the build host.
RUN bun install --ignore-scripts

# ─── Stage 3: runtime ─────────────────────────────────────────────────
FROM oven/bun:${BUN_VERSION}-slim AS runtime
WORKDIR /app/apps/bot

# Minimal OS deps — curl for the HEALTHCHECK; ca-certificates for outbound
# HTTPS to OpenAI / OpenRouter / Telegram.
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

# Hoisted workspace deps live in the monorepo-root node_modules.
COPY --from=deps /app/node_modules /app/node_modules
COPY package.json bun.lock /app/
COPY apps/bot/package.json ./
COPY apps/bot/migrations ./migrations
COPY apps/bot/src ./src
COPY apps/bot/scripts ./scripts
COPY apps/bot/kb ./kb

# Prebuilt admin UI — server.ts resolves it at ../../admin-ui/dist relative
# to src/, i.e. /app/apps/admin-ui/dist.
COPY --from=ui-build /app/admin-ui/dist /app/apps/admin-ui/dist

# The DB lives in /app/data — attach a Volume there so it survives deploys.
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/bot.db
ENV SERVE_UI=1
EXPOSE 3000

# Health endpoint defined in src/app.ts. Generous start period — first boot
# may include Ollama warm-up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS http://localhost:${PORT}/health || exit 1

# Run as non-root for defense-in-depth.
RUN chown -R bun:bun /app
USER bun

CMD ["bun", "run", "src/index.ts"]

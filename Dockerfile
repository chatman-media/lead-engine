# syntax=docker/dockerfile:1.7
#
# Multi-stage build for tg-chatbot. Three stages:
#   1. ui-build — compiles the React admin SPA via Vite into admin-ui/dist.
#                 Lives separately so a backend-only edit doesn't have to
#                 re-run the frontend toolchain.
#   2. deps     — installs production deps with bun.lock for reproducibility.
#   3. runtime  — final image. Pulls in deps + source + the prebuilt UI,
#                 and `bun run`s src/index.ts directly (no compile step —
#                 Bun executes TypeScript natively).
#
# The Bun-bundled SQLite on Linux supports extension loading natively, so
# `sqlite-vec` and FTS5 work without any apt-installed sqlite gymnastics
# (unlike macOS dev, where src/db/sqlite.ts has to point at Homebrew's libsqlite).

ARG BUN_VERSION=1.3.8

# ─── Stage 1: build admin UI ──────────────────────────────────────────
FROM oven/bun:${BUN_VERSION}-slim AS ui-build
WORKDIR /app/admin-ui

# UI has its own bun.lock — copy first to maximise Docker layer cache.
COPY admin-ui/package.json admin-ui/bun.lock* ./
RUN bun install --frozen-lockfile

# Vite reads from the rest of admin-ui/.
COPY admin-ui/. ./
RUN bun run build

# ─── Stage 2: backend deps ────────────────────────────────────────────
FROM oven/bun:${BUN_VERSION}-slim AS deps
WORKDIR /app

# Lockfile-first → install layer reuses on source-only edits.
COPY package.json bun.lock ./
# admin-ui/package.json needed so bun can resolve the workspace declaration.
COPY admin-ui/package.json ./admin-ui/
# postinstall runs scripts/install-hooks.ts — copy it so the script
# resolves even in the isolated deps stage (no git, but || true exits ok).
COPY scripts/install-hooks.ts ./scripts/
# --production omits devDeps; no --frozen-lockfile so bun can re-resolve
# platform-specific optional deps (e.g. sqlite-vec-linux-x64) on the
# build host without a lockfile mismatch.
RUN bun install --ignore-scripts

# ─── Stage 3: runtime ─────────────────────────────────────────────────
FROM oven/bun:${BUN_VERSION}-slim AS runtime
WORKDIR /app

# Minimal OS deps — curl for the HEALTHCHECK below; ca-certificates for
# outbound HTTPS to OpenAI / OpenRouter / Telegram. Everything else
# Bun's runtime brings.
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

# Copy the production deps and source. Skip dev-only files via .dockerignore.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock ./
COPY migrations ./migrations
COPY src ./src
COPY scripts ./scripts

# Prebuilt admin UI (served at /admin/* when SERVE_UI=1).
COPY --from=ui-build /app/admin-ui/dist ./admin-ui/dist

# The DB lives in /app/data — on Railway attach a Volume to /app/data
# so it survives deploys. VOLUME instruction not supported on Railway.
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/bot.db
ENV SERVE_UI=1
EXPOSE 3000

# Health endpoint defined in src/app.ts. The webhook timeout is 60s so
# we use a generous start period — first boot may include Ollama warm-up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS http://localhost:${PORT}/health || exit 1

# Run as non-root for defense-in-depth. The oven/bun image already has a
# `bun` user; chown the app dir + the data volume mount point to it.
RUN chown -R bun:bun /app
USER bun

CMD ["bun", "run", "src/index.ts"]

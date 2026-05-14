# Deploy

Production-style deployment via Docker. The bot is a long-running Bun
process serving HTTP on a single port — straightforward to run on any
VPS / Hetzner / DigitalOcean / etc.

## TL;DR

```bash
git clone <repo> && cd tg-chatbot
cp .env.example .env
# edit .env — at minimum:
#   TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET
#   one of: OPENAI_API_KEY / OPENROUTER_API_KEY / (Ollama via compose profile)
#   LEADS_CHAT_ID, VISA_CHAT_ID  (after adding the bot to those groups)
docker compose up -d
docker compose logs -f app
```

The container listens on `${HOST_PORT:-3000}`. Telegram's Bot API
requires the webhook URL to be HTTPS — point a reverse proxy
(nginx / Caddy / Cloudflare Tunnel) at the container, then:

```bash
docker compose exec app bun scripts/set-webhook.ts set https://your-domain.com
```

## Choosing an LLM provider

Three viable shapes:

| Setup | Pros | Cons |
|---|---|---|
| **OpenAI / compatible** | Cheapest entry, no GPU | Token cost; data leaves your perimeter |
| **OpenRouter** | One key for Claude / GPT / Gemini; easy A/B | Same data-leaves-perimeter trade-off |
| **Local Ollama** | Zero per-token cost; full control | Needs 8 GB+ RAM (CPU) or a GPU for usable latency |

Embeddings are configured separately — OpenRouter has no `/embeddings`
endpoint, so when chat is OpenRouter you still pick OpenAI or Ollama
for the embedder.

### Local-only stack (Ollama in Docker)

```bash
docker compose --profile ollama up -d
docker compose --profile ollama exec ollama ollama pull qwen3
docker compose --profile ollama exec ollama ollama pull bge-m3
```

Then in `.env`:

```
LLM_PROVIDER=ollama
EMBEDDING_PROVIDER=ollama
OLLAMA_CHAT_MODEL=qwen3
OLLAMA_EMBEDDING_MODEL=bge-m3
OLLAMA_EMBEDDING_DIM=1024
# OLLAMA_HOST is set by docker-compose to http://ollama:11434 automatically
```

The Ollama service uses CPU by default. For NVIDIA GPU pass-through,
uncomment the `deploy.resources` block in `docker-compose.yml`.

## Reverse proxy & HTTPS

Telegram requires HTTPS for the webhook URL. Three common patterns:

### Option A — Cloudflare Tunnel (zero firewall changes)

```bash
cloudflared tunnel create tg-chatbot
cloudflared tunnel route dns tg-chatbot bot.your-domain.com
cloudflared tunnel run --url http://localhost:3000 tg-chatbot
```

Then set the webhook to `https://bot.your-domain.com/telegram/<secret>`.

### Option B — nginx + Let's Encrypt (when you own the VPS public IP)

```nginx
server {
  listen 443 ssl http2;
  server_name bot.your-domain.com;
  ssl_certificate     /etc/letsencrypt/live/bot.your-domain.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/bot.your-domain.com/privkey.pem;

  # Telegram retries the webhook within ~60s — keep this generous.
  proxy_read_timeout 75s;
  client_max_body_size 25m;  # for photo uploads going through the bot

  location / {
    proxy_pass         http://127.0.0.1:3000;
    proxy_set_header   Host $host;
    proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
  }

  # Admin UI websocket.
  location /admin/api/ws {
    proxy_pass         http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header   Upgrade $http_upgrade;
    proxy_set_header   Connection "Upgrade";
  }
}
```

### Option C — Caddy (one-line auto-TLS)

```caddyfile
bot.your-domain.com {
  reverse_proxy 127.0.0.1:3000
}
```

## Webhook setup

After the proxy is live and the container is healthy:

```bash
docker compose exec app bun scripts/set-webhook.ts set https://bot.your-domain.com
docker compose exec app bun scripts/set-webhook.ts info  # verify
```

The script reads `TELEGRAM_BOT_TOKEN` + `TELEGRAM_WEBHOOK_SECRET` from
the env file and registers `https://.../telegram/<secret>` with
Telegram. The `secret` lives in the path; Telegram also sends it in
the `X-Telegram-Bot-Api-Secret-Token` header — both must match what
the bot expects (see `src/telegram/webhook.ts`).

## Persistent data

All state is stored in PostgreSQL (configured via `DATABASE_URL` in `.env`).
The bot has no local data volume — a container restart or replacement
leaves all data intact in the database.

Back up the database using `pg_dump`:

```bash
pg_dump $DATABASE_URL -Fc -f tg-chatbot-$(date +%Y%m%d).dump
```

Restore:

```bash
pg_restore -d $DATABASE_URL tg-chatbot-XXXX.dump
```

When using Supabase, point-in-time recovery and daily backups are
available in the dashboard.

## Ingesting the KB inside the container

Two ways:

**A. Copy the corpus into the volume and ingest:**

```bash
# Mount the kb dir read-only; uncomment the volume in docker-compose.yml
docker compose exec app bun scripts/ingest.ts /app/kb/curated
```

**B. From the host, into a one-shot run:**

```bash
docker compose run --rm -v $PWD/kb:/app/kb:ro app \
  bun scripts/ingest.ts /app/kb/curated
```

Topic-routed retrieval picks up the immediate sub-directory name as
the topic (`/app/kb/curated/visa/*.md` → topic=visa). See
[docs/RAG_LAYERS.md](RAG_LAYERS.md#6-topic-routed-retrieval--rag_topic_routingtrue).

## Userbot (MTProto) in production

If you're running the bot from a personal Telegram account, the session
must be authorised before starting the server.

**One-time auth (run on the server, not inside Docker):**

```bash
# .env must have TELEGRAM_USERBOT=1, TELEGRAM_API_ID, TELEGRAM_API_HASH
bun scripts/userbot-auth.ts
# Follow prompts: phone → OTP → 2FA password
# Session is saved to PostgreSQL → persists across restarts
```

The session string lives in the `userbot_session` table in PostgreSQL.

**In docker-compose**, the auth script needs the same volume:

```bash
docker compose run --rm app bun scripts/userbot-auth.ts
```

After auth the server picks up the session automatically on next start:

```bash
docker compose up -d
```

Full userbot docs: [USERBOT.md](USERBOT.md).

## Operations checklist

- [ ] **Rotate `TELEGRAM_WEBHOOK_SECRET`** if it ever leaks — call
      `set-webhook.ts set` again with the new value, the in-flight
      retries will start failing 403 and Telegram drops them.
- [ ] **`ADMIN_SESSION_TTL_DAYS`** controls admin login lifetime
      (default 14). Reduce in shared-host environments.
- [ ] **Watch `/admin/status`** — the Status dashboard reports active
      flags, KB doc counts, lead pipeline state. First place to look
      when something feels off.
- [ ] **Logs**: `docker compose logs -f app`. The bot is verbose by
      design — every RAG turn emits provider / latency / hit count.

## Updating

```bash
git pull
docker compose build app          # rebuild image with the new code
docker compose up -d app          # restart with zero data loss
```

All state lives in PostgreSQL, independent of the container image, so
`docker compose down && up` is safe — no local volume to worry about.

## Resource sizing

Tested baselines:

- **Backend only** (OpenAI / OpenRouter): ~150 MB RAM idle, ~250 MB
  active. Single CPU core is plenty.
- **+ Ollama (CPU)**: add 6-12 GB RAM depending on model
  (qwen3:8b q4_K_M ≈ 5 GB, bge-m3 ≈ 1 GB). Latency on CPU is
  10-60s per turn — acceptable for low-volume but use a smaller
  model (qwen3:4b / llama3.2:3b) if more.
- **+ Ollama (GPU)**: a 12 GB consumer GPU (3060 / 4060 Ti) handles
  qwen3:8b at sub-second per turn. Uncomment the `deploy.resources`
  block in `docker-compose.yml`.

## Troubleshooting

- **`Webhook info shows pending_update_count growing`**: the bot is
  not ack'ing fast enough. Check container logs for slow LLM calls;
  raise `proxy_read_timeout` in nginx.
- **`connect ECONNREFUSED` on first boot**: `DATABASE_URL` is not
  reachable from inside the container. Verify the connection string
  in `.env` and that your PostgreSQL / Supabase instance is accessible.
- **`relation "users" does not exist`**: migrations haven't run yet or
  `DATABASE_URL` points to the wrong database. Check the boot logs for
  `runMigrations()` output.

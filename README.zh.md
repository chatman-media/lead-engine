<div align="center">

<a name="top"></a>

# lead-engine

**面向 Telegram 招聘机构的 AI 销售成交助手**

[![CI](https://github.com/chatman-media/lead-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/chatman-media/lead-engine/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-1.3-fbf0df?logo=bun&logoColor=black)](https://bun.sh/)
[![PostgreSQL + RLS](https://img.shields.io/badge/PostgreSQL-RLS%20%2B%20pgvector-336791?logo=postgresql&logoColor=white)](https://github.com/pgvector/pgvector)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Telegram](https://img.shields.io/badge/Telegram-bot%20%2B%20userbot-26A5E4?logo=telegram&logoColor=white)](https://core.telegram.org/bots/api)
[![WhatsApp](https://img.shields.io/badge/WhatsApp-Cloud%20API-25D366?logo=whatsapp&logoColor=white)](https://developers.facebook.com/docs/whatsapp)
[![Stripe](https://img.shields.io/badge/Stripe-billing-635BFF?logo=stripe&logoColor=white)](https://stripe.com/)

多租户 SaaS · BYOK LLM · 按租户隔离的 RAG · 销售方法论（SPIN / NEPQ / AIDA）· 人工接管

---

🌐 **Language / Язык / 语言**

[🇬🇧 English](README.md) &nbsp;·&nbsp; [🇷🇺 Русский](README.ru.md) &nbsp;·&nbsp; 🇨🇳 **中文**

</div>

---

**面向 Telegram 招聘机构的 AI 销售成交助手。**
一个多租户 SaaS 平台。30 秒内回复入站线索，把候选人从"只是了解一下"
一路推进到提交申请，并将高意向线索（hot lead）转交给招聘专员。
由销售方法论（SPIN、NEPQ、AIDA）驱动——而不是一个 FAQ 机器人。

**Phase 1 ICP：** RU/CIS/MENA 地区、以 Telegram 为主的招聘机构，
ARPU 99–199 美元/月。[Phase 2：房地产。Phase 3：横向扩展。]

**工作方式：** 商家注册 → 接入自己的 Telegram 机器人
（60 秒内自动 `setWebhook`）→ 配置自己的 OpenAI / Anthropic 密钥
（BYOK）→ 向知识库（KB）上传文档 → AI 回复并推进漏斗。
人工坐席可随时从收件箱接管任意对话。

每个客户都是一个独立的 `tenant`，拥有各自的渠道、LLM 配置、知识库，
数据隔离在 Postgres RLS 层面强制实施。

> 本产品在技术上可通用于任何带有消息漏斗的客户型业务。Phase 1
> 聚焦招聘行业，以实现精准的市场切入。详见
> [`docs/COMPETITORS.md §0`](docs/COMPETITORS.md)。

通过一系列架构性 PR 从遗留的 Telegram 机器人中抽取而成
（见 `docs/ROADMAP.md` 和 git log）。

📖 **另见：**
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — 数据流、RLS、热重载细节
- [`docs/ONBOARDING.md`](docs/ONBOARDING.md) — 新租户的接入路径（UI + curl）
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — 已完成、进行中、下一步
- [`docs/COMPETITORS.md`](docs/COMPETITORS.md) — 竞品分析与定位

---

## 自助式租户接入流程

完整接入流程——**无需 env 变量，无需重启**：

```
1. /signup       → email + password → JWT + 创建 tenant（free 套餐）
2. /channels     → Telegram 标签页：粘贴 @BotFather token → 自动 setWebhook + 加密 + reload
                   WhatsApp 标签页：粘贴 { phoneNumberId, accessToken } → Meta Graph
                   校验 → 加密 + Meta dashboard 的 webhook 设置提示
                   ✓ 渠道立即接收入站消息（Worker reload ≤30s）
3. /settings     → 保存 OpenAI / Anthropic / Ollama 密钥 → AES-256-GCM 加密，
                   InMemoryLlmRouter 热重载 → ✓ AI 已就绪
4. /dashboard    → 上传 .txt / .md / .json → ingest + embed → kb_chunks
                   ✓ 基于业务知识的 RAG 回复
5. /conversations → 收件箱，5s 自动轮询。"接管" → mode='human' →
                   AI 在该对话中静默。"交还 AI" → 恢复
6. /audit        → 哪个管理员改了什么（所有 PUT/POST/DELETE）
7. /diagnostics  → 一键对整套配置做健康检查
8. /dashboard    → PlanWidget：用量条 + "Upgrade Starter $99 / Pro $199"
                   → Stripe Checkout（14 天试用）→ webhook 提升套餐 →
                   配额即时增加
```

**各套餐配额**（见 `apps/api/src/lib/plans.ts`）：

| 套餐 | 渠道数 | KB 文档 | 速率/分钟 | 价格 |
|---|---|---|---|---|
| `free` | 1 | 50 | 30 | $0 |
| `starter` | 3 | 500 | 60 | $99/月 |
| `pro` | 10 | 10000 | 120 | $199/月 |
| `enterprise` | 100 | 100000 | 600 | 定制（自托管） |

超出 channel/KB 的 POST 限制 → `402 Payment Required`，返回结构化响应
（`{ reason, limit, current, plan, upgradeHint }`）——UI 显示
"Upgrade" CTA。

变更通过进程内总线（`apps/api`）加 30 秒轮询重载（`apps/worker`）
**实时**生效。详见
[`docs/ARCHITECTURE.md#hot-reload`](docs/ARCHITECTURE.md)。

---

## 架构

### Apps（可部署进程）

| App | 是什么 | 部署 |
|---|---|---|
| `apps/api` | HTTP 服务器：webhook 处理器（telegram/whatsapp/stripe）、`/ws/:slug`（web）、admin API（auth + KB + LLM 配置 + 渠道 + 对话 + 审计 + 诊断 + 租户暂停）、`/metrics`、`/healthz` | Fly app / Node 托管 |
| `apps/worker` | 出站调度器（`SKIP LOCKED` 队列）、轮询渠道重载、定时任务 | Fly app 进程组 |
| `apps/admin-ui` | React 19 + Vite SPA——完整 SaaS UI（signup → channels → settings → conversations → audit → diagnostics） | 静态 / CDN |
| `apps/vertical-recruitment-uae` | 垂直模板（KB 种子 + 漏斗阶段 + 风格提示）——不部署，通过 `packages/verticals` 加载 | — |

### Packages（领域模块）

```
@chatman-media/storage             — Drizzle schema + 迁移、集成 helper
@chatman-media/observability       — JsonLogger、Counter/Histogram、PlatformMetrics
@chatman-media/channel-core        — ChannelAdapter 契约、Inbound、OutboundEnvelope
@chatman-media/channel-telegram    — BotAPI + MTProto userbot
@chatman-media/channel-whatsapp    — Meta Graph API
@chatman-media/channel-web         — 基于 WebSocket 的聊天挂件渠道
@chatman-media/llm-router          — LLM I/O（chat/embed/providers/router）。按租户配置
@chatman-media/kb                  — RAG（ingest、answer、混合检索、ABRouter）
@chatman-media/sales               — 销售领域（CoachAnalyzer、StageClassifier、ELO）
@chatman-media/conversation-engine — pipeline 契约 + DAL + 持久化
@chatman-media/verticals           — VerticalTemplate 注册表（recruitment_uae_v1）
```

所有 `packages/*` 都以 `@chatman-media` scope 发布到 npm。见
[发布软件包](#发布软件包)。

**依赖方向**（无环）：

```
conversation-engine ── llm-router
                  ├── kb ── llm-router
                  ├── sales ── kb, llm-router
                  └── storage
channel-* ── channel-core
apps/api ── conversation-engine, channel-*, sales, kb, llm-router
apps/worker ── conversation-engine, channel-telegram
```

---

## 快速开始（本地开发）

### 依赖

- [Bun](https://bun.sh) 1.3.14+
- Docker（用于带 pgvector 的 Postgres）

### 安装

```bash
git clone git@github.com:chatman-media/lead-engine.git
cd lead-engine
bun install

cp .env.example .env
# 最少需要：PLATFORM_MASTER_KEY (openssl rand -hex 32)、
#          TELEGRAM_WEBHOOK_SECRET（任意字符串）、
#          PLATFORM_PUBLIC_URL=http://localhost:3000（用于 auto-setWebhook）

bun db:up                                                    # postgres@5434
bun run apps/api/scripts/reset-and-migrate.ts                # 应用迁移

bun run dev          # apps/api 监听 PORT 3000
bun run dev:worker   # apps/worker（出站 + 重载轮询）
cd apps/admin-ui && bun run dev   # admin-ui 在 http://localhost:5173
```

打开 `http://localhost:5173/signup` → 创建 tenant → 走完 5 步接入清单。

### Bun 快捷命令

```bash
bun db:up          # 启动 Postgres 容器
bun db:down        # 停止
bun db:reset       # 删除 + 重新迁移（干净 DB）
bun db:psql        # 容器内的 psql shell
bun run typecheck  # 对全部 15 个包跑 tsc
bun run test       # 对整个 monorepo 跑 bun test（700+ 测试）
```

---

## 多租户模型

每个客户是一行 `tenant`，带唯一的 `slug`。所有领域数据按 `tenant_id`
隔离：

```
tenants ─┬─ admins（每租户多管理员——invite 流程 TODO）
         ├─ channels（telegram_bot / telegram_userbot / whatsapp / web）
         ├─ contacts ─ channel_identities（渠道无关的 人 ↔ 消息账号）
         ├─ conversations ─ messages
         ├─ leads ─ lead_events ─ lead_notes
         ├─ kb_documents ─ kb_chunks（按租户的 RAG）
         ├─ styles, experiments, skills, ...
         ├─ outbound_queue（SKIP LOCKED）
         ├─ tenant_secrets（AES-256-GCM 加密）
         ├─ llm_provider_configs（按用途：chat | embed | vision | judge）
         └─ audit_log
```

### RLS——行级安全

在 34 张按租户隔离的表上启用 `FORCE ROW LEVEL SECURITY`，策略为：

```sql
USING (tenant_id = current_setting('app.tenant_id', true)::int)
WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::int)
```

所有生产代码路径都把 repo 调用包在 `withTenant(db, tenantId, fn)` 中
——它会开启事务并执行 `SET LOCAL app.tenant_id = X`。

**生产关键：** `apps/api` / `apps/worker` 必须以
`NOSUPERUSER NOBYPASSRLS` 的 Postgres 角色连接，否则 RLS 会被绕过。
两个进程在启动时会记录 `info "RLS enforced"` 或
`warn "RLS not enforced"` 并附带修复提示。

已在 `packages/storage/src/rls.integration.test.ts`（8 个测试）和
`apps/api/src/multi-tenant.integration.test.ts`（10 个 E2E 测试）中验证。

---

## 渠道

| 渠道 | 入站 | 出站 | adapter 位置 |
|---|---|---|---|
| `telegram_bot` | webhook `POST /webhook/telegram/:slug`（X-Telegram-Bot-Api-Secret-Token） | `apps/worker` → BotAPI HTTPS | apps/api + apps/worker |
| `telegram_userbot` | `apps/worker` MTProto 接收循环 | `apps/worker` → MTProto | apps/worker |
| `whatsapp` | webhook `POST /webhook/whatsapp/:slug`（X-Hub-Signature-256） | `apps/worker` → Meta Graph | apps/api + apps/worker |
| `web` | WebSocket `/ws/:slug?user=X&auth=Y` | `apps/api` 进程内通过 `WebOutboundDispatcher`（pinned WS） | 仅 apps/api |

**Auto-setWebhook**：插入后，`POST /api/admin/channels/telegram`
会自动调用 Telegram `setWebhook(url=<PLATFORM_PUBLIC_URL>/webhook/telegram/<slug>,
secret_token=<TELEGRAM_WEBHOOK_SECRET>)`。渠道立即可用，无需手动 curl。

### 签名校验

- **Telegram**：`X-Telegram-Bot-Api-Secret-Token` = `TELEGRAM_WEBHOOK_SECRET`
- **WhatsApp**：用 `WHATSAPP_APP_SECRET` 对原始 body 做 `X-Hub-Signature-256` HMAC-SHA256。在 tenant 查找**之前**校验（防枚举）。
- **Web**：通过 `WEB_WS_AUTH_SECRET` 的可选共享密钥。JWT 是下一次迭代。
- **Stripe**：用 `STRIPE_WEBHOOK_SECRET` 做 HMAC-SHA256。

---

## Pipeline（入站 → 出站）

```
1. Webhook 处理器接收 HTTP POST                                 (apps/api)
2. 校验签名 → 失败则 401
3. 通过 ChannelRegistry（内存）查找 tenant + channel
4. 按租户做限流检查（默认 60/分钟、600/小时）→ 超限则 429
5. adapter.pushUpdate(payload) → adapter 收件箱
6. ┌─ Phase 1（tx1，withTenant）：在 Postgres 内持久化 ──────┐
   │  - resolveContact（查找或创建 Contact + ChannelIdentity）
   │  - resolveConversation（按渠道）
   │  - persist Message（按 external_message_id 唯一去重）
   │  - vertical-template extractFields 钩子
   │  - stageClassifier（~300ms LLM）→ applyClassifiedStage
   │  - memoryExtractor（~500ms LLM）→ mergeAttributes
   └────────────────────────────────────────────────────────────┘
7. Phase 2（不在 tx 内）：reply.generate(...) — ~1-2s LLM。连接池连接
   已释放。
8. Phase 3（tx2，withTenant）：将 OutboundEnvelope[] 入队 outbound_queue。
9. Webhook → 200 ack（通常 < 100ms）。
10. apps/worker（TG/WA/userbot）或 apps/api（web）通过 SKIP LOCKED
    抽干 outbound_queue → adapter.send → 标记已发送。
```

---

## 热重载（无需重启 app）

| 变更 | 效果 | 延迟 |
|---|---|---|
| `PUT /api/admin/llm-configs/:purpose` | `InMemoryLlmRouter.invalidate(tenantId)` + setConfig + 修改 `LoadedRef.current` | 即时 |
| `POST /api/admin/channels/telegram` | `apps/api` 中 `ChannelRegistry.reloadTenant(tenantId)` 即时；`apps/worker` 通过轮询拾取 | api 即时，worker ≤30s |
| `POST /api/admin/channels/whatsapp` | 同上；Meta dashboard 中的 Meta webhook 设置需手动 | api 即时，worker ≤30s |
| `PUT /api/admin/tenant/status`（暂停/恢复） | reloadChannels——暂停时驱逐，恢复时还原 | api 即时 |
| `PUT /api/admin/conversations/:id/mode` | 修改 `conversations.mode`，pipeline 立即遵循 | 即时 |
| Stripe webhook `customer.subscription.*` | 根据 priceId 映射修改 `tenants.plan` | 即时（Stripe 投递后） |
| KB 上传 | DrizzleKbStore 实时从 DB 读取 | 即时 |

详见 [`docs/ARCHITECTURE.md#hot-reload`](docs/ARCHITECTURE.md)。

---

## Admin API 端点（SaaS 流程）

全部在 `/api/admin/*` 下，需要 `Authorization: Bearer <jwt>`（来自 `/api/auth/signup` 或 `/login`）。

```
GET    /api/auth/me                              — admin + tenant 信息
POST   /api/auth/signup                          — 创建 tenant + admin
POST   /api/auth/login                           — 签发 JWT
POST   /api/auth/logout                          — 失效（客户端侧）

GET    /api/admin/onboarding-status              — 清单（channel/llm/kb）
GET    /api/admin/tenant                         — { id, slug, plan, status, ... }
PUT    /api/admin/tenant/status                  — { paused: boolean } → 暂停/恢复
GET    /api/admin/diagnostics                    — 健康检查（channel + LLM + KB）

POST   /api/admin/channels/telegram              — { botToken } → auto-setWebhook
POST   /api/admin/channels/whatsapp              — { phoneNumberId, accessToken } → Meta Graph 校验 + webhook 设置提示
GET    /api/admin/channels                       — 列表（不含凭据）
DELETE /api/admin/channels/:id

PUT    /api/admin/llm-configs/:purpose           — { provider, model, apiKey?, ... }
GET    /api/admin/llm-configs                    — 列表（不含密钥值）
DELETE /api/admin/llm-configs/:purpose

POST   /api/admin/kb/documents                   — multipart 文件 或 { title, body, topic? }
GET    /api/admin/kb/documents                   — 列表
DELETE /api/admin/kb/documents/:id

GET    /api/admin/conversations                  — 分页列表（cursor）
GET    /api/admin/conversations/:id              — 线程 + 消息
POST   /api/admin/conversations/:id/reply        — 坐席回复（mode=human）
PUT    /api/admin/conversations/:id/mode         — { mode: 'ai'|'human' } 切换接管

GET    /api/admin/audit-log                      — cursor 分页的审计历史

GET    /api/admin/billing/plan                   — 当前套餐 + 用量 + 状态
GET    /api/admin/billing/plans                  — 列出 4 个档位 + stripeEnabled 布尔
POST   /api/admin/billing/checkout               — { plan: 'starter'|'pro' } → Stripe Checkout URL
POST   /api/admin/billing/portal                 — Stripe Customer Portal URL
```

---

## 测试

```bash
DATABASE_URL=postgres://lead:lead@localhost:5434/lead_engine bun test
```

**741 个测试**，分布在 13 个包中（apps/api: 305；kb: 156；sales: 116；conversation-engine: 59；
worker: 15；storage: 15；channel-whatsapp: 17；observability: 16；channel-telegram: 11；
channel-web: 11；llm-router: 9；verticals: 6；vertical-recruitment-uae: 5）。重点：

- **多租户 E2E**（`apps/api/src/multi-tenant.integration.test.ts`）：通过真实 webhook 处理器 + admin API 的租户隔离
- **RLS 契约**（`packages/storage/src/rls.integration.test.ts`）：非绕过角色校验
- **withTenant 接线**：apps/api + apps/worker 中的回归 oracle
- **拆分 processInbound 不变式**：`events.indexOf("llm-call") < events.indexOf("tx-open")`
- **SaaS 路由**（auth、KB、LLM 配置、channels、conversations、onboarding、audit、diagnostics、租户暂停）：约 250 个集成测试
- **限流器**：6 个单元 + 3 个 webhook 集成测试
- **热重载**：6 个 tenant-reloader 测试（LLM + channels）

带覆盖率运行：

```bash
bun test --coverage
```

---

## 发布软件包

`packages/*` 中的 `@chatman-media/*` 包在每次推送到 `main` 时通过
[semantic-release](https://semantic-release.gitbook.io/) 发布到 npm。
版本按每个包独立计算，依据
[Conventional Commits](https://www.conventionalcommits.org/) 并按包目录
进行 scope（[semantic-release-monorepo](https://github.com/pmowrer/semantic-release-monorepo)）。

- 触及 `packages/kb` 的 `feat:` 提交会为 `@chatman-media/kb` 切出 `minor`。
- `fix:` → `patch`；`feat!:` / `BREAKING CHANGE:` → `major`。
- 每次发布都会打标签 `@chatman-media/<pkg>-vX.Y.Z`，更新包的
  `CHANGELOG.md`，发布到 npm，并创建 GitHub Release。
- Workspace 依赖（`workspace:*`）在发布时通过 `bun publish` 解析为具体版本。

CI 按依赖顺序发布各包，使相互依赖的包总能正确解析。需要在仓库
secret 中配置具有 `@chatman-media` scope 发布权限的 `NPM_TOKEN`。

---

## 部署

### 环境变量（见 `.env.example`）

| 变量 | 必需 | 说明 |
|---|---|---|
| `DATABASE_URL` | ✅ | Postgres 连接。**生产中使用 NOSUPERUSER NOBYPASSRLS 角色** |
| `PLATFORM_MASTER_KEY` | ✅ | AES-256-GCM 用的 32 字节 hex（tenant_secrets） |
| `PLATFORM_AUTH_SECRET` | 可选 | JWT 式 auth token 的 HMAC 密钥（回退到 MASTER_KEY） |
| `TELEGRAM_WEBHOOK_SECRET` | ✅ | X-Telegram-Bot-Api-Secret-Token 头 |
| `PLATFORM_PUBLIC_URL` | 可选 | apps/api 的基础 URL，用于 auto-setWebhook（`https://api.example.com`） |
| `WHATSAPP_VERIFY_TOKEN` / `WHATSAPP_APP_SECRET` | 可选 | Meta webhook 设置 |
| `WEB_WS_AUTH_SECRET` | 可选 | `/ws/:slug?auth=...` 的共享密钥 |
| `STRIPE_SECRET_KEY` | 可选 | `sk_test_xxx` / `sk_live_xxx`。为空 → `/checkout` 与 `/portal` 返回 503 |
| `STRIPE_PRICE_STARTER` / `STRIPE_PRICE_PRO` | 可选 | Stripe dashboard 的 Price ID。webhook 处理器将 priceId 映射到 plan |
| `STRIPE_CHECKOUT_SUCCESS_URL` / `STRIPE_CHECKOUT_CANCEL_URL` | 可选 | 重定向 URL（支持 `{TENANT}` 占位符） |
| `STRIPE_WEBHOOK_SECRET` | 可选 | Stripe webhook HMAC |
| `LLM_*` / `LLM_EMBED_*` | 可选 | 当租户没有 DB 配置时的 env 回退 |
| `RATE_LIMIT_PER_MIN` / `RATE_LIMIT_PER_HOUR` | 可选 | 默认 60 / 600。`0` = 禁用 |
| `WORKER_CHANNEL_RELOAD_MS` | 可选 | Worker 轮询间隔。默认 30000。`0` = 禁用 |

### 生产检查清单

- [ ] apps 使用 `NOSUPERUSER NOBYPASSRLS` 的 Postgres 角色（非 owner / 非 superuser）
- [ ] 迁移在单独的 BYPASSRLS 角色（owner / superuser）下运行
- [ ] 若启用 WhatsApp，则设置 `WHATSAPP_APP_SECRET`
- [ ] 若启用 web 渠道，则设置 `WEB_WS_AUTH_SECRET`（或 JWT auth）
- [ ] 通过 `rotate-master-key.ts` 脚本轮换 `PLATFORM_MASTER_KEY`
- [ ] 为 auto-setWebhook 体验设置 `PLATFORM_PUBLIC_URL`（Telegram 渠道接入）
- [ ] 设置 `RATE_LIMIT_*`（生产中不要禁用——失控成本保护）
- [ ] Stripe：`STRIPE_SECRET_KEY` + `STRIPE_PRICE_STARTER` + `STRIPE_PRICE_PRO` +
      `STRIPE_WEBHOOK_SECRET` + 成功/取消 URL。在 Stripe dashboard 中
      把 webhook 注册到 `<PLATFORM_PUBLIC_URL>/webhook/stripe`
- [ ] 启动日志检查：info 中出现 `"RLS enforced"`；`"RLS not enforced"` warn = 配置有误

---

## 路线图与竞品

- **已完成 / 进行中 / 下一步** — 见 [`docs/ROADMAP.md`](docs/ROADMAP.md)
- **市场分析与定位** — 见 [`docs/COMPETITORS.md`](docs/COMPETITORS.md)

TL;DR 产品定位：**面向以消息为中心的市场（Telegram / WhatsApp）的
AI 优先客户服务**。像 Intercom Fin / Sierra / Decagon 这类竞品偏企业级
且以 web 聊天为主。Chatbase / CustomGPT 是简单的知识机器人，没有人工
接管，也没有 channels-as-a-service。我们的定位：开放架构 + BYOK +
Telegram 优先 + 完整的坐席工作流（收件箱 + 回复 + 审计 + 诊断）。

---

## 许可证

[MIT](LICENSE) — Alexander Kireev / [chatman-media](https://github.com/chatman-media)

---

<div align="center">

[🇬🇧 English](README.md) &nbsp;·&nbsp; [🇷🇺 Русский](README.ru.md) &nbsp;·&nbsp; 🇨🇳 **中文**

</div>

<div align="center">

<a name="top"></a>

# Lead Engine

**多渠道 AI 销售成交助手 — Telegram · WhatsApp · 网页挂件**

[![CI](https://github.com/chatman-media/lead-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/chatman-media/lead-engine/actions/workflows/ci.yml)
[![CodeQL](https://github.com/chatman-media/lead-engine/actions/workflows/codeql.yml/badge.svg)](https://github.com/chatman-media/lead-engine/actions/workflows/codeql.yml)
[![codecov](https://codecov.io/gh/chatman-media/lead-engine/graph/badge.svg)](https://codecov.io/gh/chatman-media/lead-engine)
[![Security](https://github.com/chatman-media/lead-engine/actions/workflows/security.yml/badge.svg)](https://github.com/chatman-media/lead-engine/actions/workflows/security.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-1.3-fbf0df?logo=bun&logoColor=black)](https://bun.sh/)
[![PostgreSQL + RLS](https://img.shields.io/badge/PostgreSQL-RLS%20%2B%20pgvector-336791?logo=postgresql&logoColor=white)](https://github.com/pgvector/pgvector)
[![License: PolyForm NC 1.0.0](https://img.shields.io/badge/License-PolyForm%20Noncommercial%201.0.0-orange.svg)](LICENSE)
[![Telegram](https://img.shields.io/badge/Telegram-bot%20%2B%20userbot-26A5E4?logo=telegram&logoColor=white)](https://core.telegram.org/bots/api)
[![WhatsApp](https://img.shields.io/badge/WhatsApp-Cloud%20API-25D366?logo=whatsapp&logoColor=white)](https://developers.facebook.com/docs/whatsapp)
[![Stripe](https://img.shields.io/badge/Stripe-billing-635BFF?logo=stripe&logoColor=white)](https://stripe.com/)

多租户 SaaS · BYOK LLM · 按租户隔离的 RAG · 销售方法论（SPIN / NEPQ / AIDA）· 人工接管

🌐 [🇬🇧 English](README.md) &nbsp;·&nbsp; [🇷🇺 Русский](README.ru.md) &nbsp;·&nbsp; 🇨🇳 **中文**

</div>

---

一个**多租户 SaaS**：在 Telegram、WhatsApp 和网页挂件上约 30 秒内回复进线，
将客户从「随便看看」推进到提交申请 / 下单，并把高意向线索移交给人工坐席。
由销售方法论（SPIN、NEPQ、AIDA）驱动，而非 FAQ 机器人。

每个客户都是隔离的 `tenant`，拥有各自的渠道、LLM 配置和知识库——数据隔离
在 **Postgres RLS** 层强制执行。**BYOK**：使用你自己的 OpenAI / Anthropic 密钥。

**第一阶段 ICP：** 招聘机构（RU / 独联体 / 中东，Telegram 优先，ARPU
$99–199/月）。引擎本身与垂类无关——已提供多垂类模板，`exchange`（兑换）已上线。
*（第二阶段：房产 · 第三阶段：横向通用。）*

📖 **文档：** [索引](docs/README.md) · [Architecture](docs/engineering/ARCHITECTURE.md) · [Onboarding](docs/engineering/ONBOARDING.md) · [Exchange](docs/engineering/EXCHANGE.md) · [Configuration](docs/engineering/CONFIGURATION.md) · [Roadmap](docs/strategy/ROADMAP.md) · [Competitors](docs/strategy/COMPETITORS.md)

---

## 功能速览

| 渠道 | AI 引擎 | 坐席工具 |
|---|---|---|
| Telegram Bot + Userbot | RAG：pgvector + BM25 + RRF 融合 | 收件箱 + 会话接管 |
| WhatsApp Cloud API | 多查询扩展 + MMR + 重排序 | 线索流水线（看板） |
| 网页挂件（WebSocket） | BYOK LLM（OpenAI / Anthropic / Ollama） | 拖拽式漏斗构建器 |
| 自动 setWebhook（60 秒） | SPIN / NEPQ / AIDA 方法论 | A/B 实验 + ELO 排名 |
| 按租户 RLS 隔离 | 护照 OCR + 图片视觉识别 | 群发触达 + 消息模板 |
| 通用漏斗 phase 主干 | 幻觉防护 + 语义缓存 | 超管面板 · 邀请 · 审计 |
| 多垂类模板（exchange 已上线） | 按用途的 LLM 路由 | 管理副驾（页面感知，BYOK） |

---

## 引导与配额

自助式——**无需环境变量、无需重启**。公开注册默认关闭（设 `ALLOW_PUBLIC_SIGNUP=1`
开启）；首位管理员为 `superadmin`。一个强制的、垂类感知的向导会拦截后台入口：

```
/onboarding → 垂类 → 渠道 → LLM →（兑换：汇率 → 收付款信息）→ 知识库 → 完成
```

接入 Telegram bot（60 秒自动 `setWebhook`）、WhatsApp 或网页挂件；保存 BYOK
LLM 密钥（AES-256-GCM 加密）；上传知识库文档。渠道立即开始接收进线，坐席可
从收件箱接管任意会话。所有变更通过进程内总线 + ≤30 秒的 worker 轮询**实时生效**。
完整流程见 [docs/engineering/ONBOARDING.md](docs/engineering/ONBOARDING.md)。

**各档配额**（`apps/api/src/lib/plans.ts`）：

| 套餐 | 渠道 | 知识库文档 | 速率/分钟 | 价格 |
|---|---|---|---|---|
| `free` | 100 | 100000 | 120 | $0 |
| `starter` | 3 | 500 | 60 | $99/月 |
| `pro` | 10 | 10000 | 120 | $199/月 |
| `enterprise` | 100 | 100000 | 600 | 定制 |

> 在当前以兑换为主 / 自托管的配置下，`free` 实际上**不限量**（无 SaaS 计费）；
> `starter`/`pro` 仍保留在代码中以支持 Stripe 计费路径。超过限额 → `402`，
> 返回 `{ reason, limit, current, plan, upgradeHint }`。

---

## 架构

| 应用 | 说明 |
|---|---|
| `apps/api` | HTTP 服务：webhook 处理（telegram / whatsapp / stripe）、`/ws/:slug`（网页）、完整 admin API、`/metrics`、`/healthz` |
| `apps/worker` | 出站派发（`SKIP LOCKED` 队列）、渠道重载轮询、定时任务 |
| `apps/admin-ui` | React 19 + Vite SPA（Tailwind v4 + shadcn/ui）——引导向导、仪表盘、渠道、会话、线索、漏斗构建器、审计等 |
| `apps/vertical-*` | 垂类模板（`exchange` 已上线，另有 real-estate / recruitment / saas / video）——经 `packages/verticals` 加载，不单独部署 |

领域逻辑位于 `packages/*`（以 `@chatman-media` 域发布到 npm）：`storage`
（Drizzle schema + 迁移）、`channel-{core,telegram,whatsapp,facebook,web}`、`llm-router`、
`kb`（RAG）、`sales`、`conversation-engine`、`verticals`、`observability`。
依赖图与拆分事务（split-tx）管线详见 [docs/engineering/ARCHITECTURE.md](docs/engineering/ARCHITECTURE.md)。

---

## 快速开始（本地开发）

需要 [Bun](https://bun.sh) 1.3.14+ 和 Docker（Postgres + pgvector）。

```bash
git clone git@github.com:chatman-media/lead-engine.git
cd lead-engine && bun install

cp .env.example .env
# 最少：PLATFORM_MASTER_KEY (openssl rand -hex 32)、
#       TELEGRAM_WEBHOOK_SECRET（任意字符串）、
#       PLATFORM_PUBLIC_URL=http://localhost:3000（用于自动 setWebhook）

bun db:up                                       # postgres @ 5434
bun run apps/api/scripts/reset-and-migrate.ts   # 执行迁移

bun run dev          # apps/api  → PORT 3000
bun run dev:worker   # apps/worker（出站 + 重载轮询）
cd apps/admin-ui && bun run dev   # admin-ui → http://localhost:5173
```

本地开发请设置 `ALLOW_PUBLIC_SIGNUP=1`，打开 admin UI，创建租户并完成向导。

```bash
bun db:up / db:down / db:reset / db:psql   # Postgres 容器辅助命令
bun run typecheck                          # 对所有包执行 tsc
bun run test                               # 对整个 monorepo 执行 bun test
```

---

## 多租户与安全

每个客户是一行 `tenant`；所有领域数据按 `tenant_id` 隔离。租户相关表启用
`FORCE ROW LEVEL SECURITY`，所有生产代码路径都用 `withTenant(db, tenantId, fn)`
包裹仓储调用（在每个事务内设置 `app.tenant_id`）。机密（LLM 密钥、userbot
会话）以 AES-256-GCM 加密存放在 `tenant_secrets`。

> **生产环境：** `apps/api` / `apps/worker` 必须以 `NOSUPERUSER NOBYPASSRLS`
> 的 Postgres 角色连接，否则 RLS 会被绕过。两者启动时都会记录
> `"RLS enforced"` / `"RLS not enforced"`。迁移使用单独的 owner 角色运行。
> 由 RLS 与多租户集成测试覆盖验证。

---

## 渠道与管线

| 渠道 | 进站 | 出站 |
|---|---|---|
| `telegram_bot` | webhook + secret-token 头 | `apps/worker` → Bot API |
| `telegram_userbot` | MTProto 接收循环（apps/api） | 进程内 |
| `whatsapp` | webhook + `X-Hub-Signature-256` | `apps/worker` → Meta Graph |
| `web` | WebSocket `/ws/:slug` | 进程内 |

进站消息先校验（按渠道验签 → 限流），在 tx1 持久化，经分类与 RAG 生成回复，
随后在 tx2 入队出站消息，webhook 在 <100ms 内确认；`apps/worker` 通过
`SKIP LOCKED` 消费 `outbound_queue`。流程图与分步细节见
[docs/engineering/ARCHITECTURE.md](docs/engineering/ARCHITECTURE.md)。

---

## Admin API

`/api/admin/*` 下约 120 个 REST 端点（Bearer JWT，来自 `/api/auth/login`）：
认证与邀请、引导状态、渠道、LLM 配置、知识库、会话、线索 + 漏斗构建器、
风格、实验、计费（Stripe）、群发触达及超管。可浏览
[`apps/api/src/routes/`](apps/api/src/routes)；端到端租户流程见
[docs/engineering/ONBOARDING.md](docs/engineering/ONBOARDING.md)。

---

## 测试

```bash
DATABASE_URL=postgres://lead:lead@localhost:5434/lead_engine bun test
```

15 个包中 950+ 个测试——经真实 webhook 处理的多租户 E2E、RLS 非绕过契约、
RAG 管线（约 180）、SaaS 路由集成，以及兑换工作流 mock。覆盖率：
`bun test --coverage`。更多见 [docs/engineering/TESTING.md](docs/engineering/TESTING.md)。

---

## 部署

关键环境变量（完整参考见 [docs/engineering/CONFIGURATION.md](docs/engineering/CONFIGURATION.md)；
运维见 [docs/operations/SERVER_RUNBOOK.md](docs/operations/SERVER_RUNBOOK.md)）：

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` ✅ | Postgres——**生产用 NOSUPERUSER NOBYPASSRLS 角色** |
| `PLATFORM_MASTER_KEY` ✅ | 32 字节十六进制，用于 AES-256-GCM（`tenant_secrets`） |
| `TELEGRAM_WEBHOOK_SECRET` ✅ | `X-Telegram-Bot-Api-Secret-Token` 头 |
| `PLATFORM_PUBLIC_URL` | apps/api 的基础 URL，用于自动 `setWebhook` |
| `STRIPE_*` | secret key + price ID + webhook secret（留空 → 关闭计费） |
| `RATE_LIMIT_PER_MIN` / `_PER_HOUR` | 默认 60 / 600（`0` = 关闭——生产勿关） |

迁移用 owner / BYPASSRLS 角色运行，应用用受限角色。完整生产清单见
[docs/operations/SERVER_RUNBOOK.md](docs/operations/SERVER_RUNBOOK.md)。

---

## 定位

| | **Lead Engine** | Intercom Fin | Chatbase | Decagon |
|---|:---:|:---:|:---:|:---:|
| 原生 Telegram | ✅ | ❌ | ❌ | ❌ |
| WhatsApp / 网页 | ✅ | ✅ | 网页 | 网页 |
| BYOK LLM | ✅ | ❌ | 部分 | ❌ |
| 人工接管 | ✅ | ✅ | ❌ | ✅ |
| 线索流水线 + 漏斗构建器 | ✅ | ❌ | ❌ | ❌ |
| 自托管 / 源码公开 | ✅ | ❌ | ❌ | ❌ |

定位：面向以即时通讯为中心的市场（Telegram / WhatsApp）、AI 优先、支持 BYOK
且具备完整坐席工作流的客户服务。完整分析与路线图：
[docs/strategy/COMPETITORS.md](docs/strategy/COMPETITORS.md) · [docs/strategy/ROADMAP.md](docs/strategy/ROADMAP.md)。

---

## 贡献与许可

欢迎 PR。请使用 [Conventional Commits](https://www.conventionalcommits.org/)
（`feat:` / `fix:` / …）——semantic-release 据此推导版本并在推送到 `main` 时
将 `@chatman-media/*` 发布到 npm。提交前请运行 `bun run typecheck && bun test`，
并在改动 `apps/api` 或各包前阅读 [docs/engineering/ARCHITECTURE.md](docs/engineering/ARCHITECTURE.md)
（RLS / `withTenant` 与 split-tx 契约是关键不变量）。

**许可：** 产品采用 [PolyForm Noncommercial 1.0.0](LICENSE)——任何非商业用途免费；**商业用途需付费许可**（联系 [chatman-media](https://github.com/chatman-media)）。`packages/*` 中的可复用库仍为 **MIT**。© Alexander Kireev / chatman-media。

<div align="center">

[🇬🇧 English](README.md) &nbsp;·&nbsp; [🇷🇺 Русский](README.ru.md) &nbsp;·&nbsp; [⬆ 顶部](#top)

</div>

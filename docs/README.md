# Документация Lead Engine

Индекс всех доков по аудитории. Высокоуровневое введение в продукт —
[`../README.md`](../README.md); правила для разработчиков/AI-агентов —
[`../AGENTS.md`](../AGENTS.md).

## 🛠 Engineering

| Док | О чём |
|---|---|
| [engineering/ARCHITECTURE.md](engineering/ARCHITECTURE.md) | Топология, multi-tenant изоляция (RLS + `withTenant`), pipeline, hot-reload, секреты, костяк воронки (`phase`), exchange/copilot/onboarding |
| [engineering/AI_FUNNEL_BUILDER.md](engineering/AI_FUNNEL_BUILDER.md) | AI-сборка воронки по описанию бизнеса: `ai-chat → normalize → validateBackbone → apply`; линейные И мульти-запросные воронки + поведенческий слой (стиль/навыки/пер-стадийное поведение/оператор-handoff) |
| [engineering/CONCIERGE_FUNNEL_CONVERGENCE.md](engineering/CONCIERGE_FUNNEL_CONVERGENCE.md) | Как срастаются концерж (#207) и универсальная воронка (#208): «общий хребет, разъединённые концы» — 3 шва + продуктовый разбор + дорожная карта конвергенции (R1–R6) |
| [engineering/ONBOARDING.md](engineering/ONBOARDING.md) | Путь тенанта: закрытая регистрация → обязательный визард → каналы/LLM/KB/обменник (UI + curl) |
| [engineering/CONFIGURATION.md](engineering/CONFIGURATION.md) | Полный референс env-переменных (all vars, required/optional, fallback/per-tenant) |
| [engineering/EXCHANGE.md](engineering/EXCHANGE.md) | Обменная вертикаль: воронка, курсы/тиры + предложения курса, guardrails, ops-watch, реквизиты, orders CRM, точки выдачи + ATM-карта, покрытие операторов, per-currency округление, мультиязык (PH), симулятор + scripted-диалоги |
| [engineering/SERVICE_CATALOG.md](engineering/SERVICE_CATALOG.md) | Каталог услуг + marketplace провайдеров: curated/custom providers, routes (`funnel`/`partner_service`/`webhook`/`manual`), partners/deals |
| [engineering/NOTIFICATIONS.md](engineering/NOTIFICATIONS.md) | Stage webhooks + правила/шаблоны уведомлений + operator settings + Telegram-группы + ops-алерты |
| [engineering/AGENTIC_TOOLS.md](engineering/AGENTIC_TOOLS.md) | Tool-loop: контракт инструмента, встроенные (booking), подключение в pipeline, кастомный инструмент |
| [engineering/COPILOT.md](engineering/COPILOT.md) | Page-aware AI-ассистент кабинета: эндпоинт, action-allowlist, advice+confirm, BYOK |
| [engineering/WEB_WIDGET.md](engineering/WEB_WIDGET.md) | Веб-виджет: бандл, embed-сниппет, WebSocket lifecycle, протокол, доставка |
| [engineering/TESTING.md](engineering/TESTING.md) | Тест-харнесс: изоляция БД, паттерн интеграционного теста, моки LLM/каналов, фикстуры |

## ⚙️ Operations

| Док | О чём |
|---|---|
| [operations/SERVER_RUNBOOK.md](operations/SERVER_RUNBOOK.md) | Ручной апдейт prod/dev сервера: env → migrate → build → restart → health; текущие URL `exchanges.agency`, `client.exchanges.agency`, `dev.exchanges.agency` |
| [operations/CD_SETUP.md](operations/CD_SETUP.md) | CD: push в `main` → prod, push в `dev` → dev; SSH-деплой `./deploy.sh` → health-check |

## 📈 Product & Strategy

| Док | О чём |
|---|---|
| [strategy/VERTICALS.md](strategy/VERTICALS.md) | 9 реализованных vertical templates + маппинг стадий на фазы + карта ниш (Пхукет/Таиланд) |
| [strategy/ROADMAP.md](strategy/ROADMAP.md) | Канон позиционирования (универсальная платформа), что в работе / дальше, метрики, $1M ARR план |
| [strategy/POSITIONING.md](strategy/POSITIONING.md) | Позиционирование (универсал + GTM-wedge'ы), ICP, ценность, цена, elevator pitch |
| [strategy/GTM_STRATEGY.md](strategy/GTM_STRATEGY.md) | Go-to-market: каналы, партнёры, питч инвесторам |
| [strategy/COMPETITORS.md](strategy/COMPETITORS.md) | Анализ конкурентов и pricing benchmarks |
| [strategy/PROVIDER_RELAY_EPIC.md](strategy/PROVIDER_RELAY_EPIC.md) | Эпик: кросс-канальный брокер заказов — клиент в одном канале, провайдер в другом, платформа владеет заказом/оплатой/комиссией |
| [strategy/REAL_ESTATE_TRAINING_FUNNEL_NOTES.md](strategy/REAL_ESTATE_TRAINING_FUNNEL_NOTES.md) | Конспект RE-тренинга → универсальные правила воронок (stage goal/CTA/SLA) + RE-воронка |

## 🎯 GTM / Demo

| Док | О чём |
|---|---|
| [gtm/sales-bot/SETUP.md](gtm/sales-bot/SETUP.md) | Мета-демо: бот, продающий Lead Engine рекрутёрам (setup + KB + system prompt) |
| [gtm/exchange/README.md](gtm/exchange/README.md) | Exchange GTM pack: one-pager, demo script, screen sequence, objections, alpha trial flow и live-demo runbook |

Кодовые demo-витрины:

| Путь | О чём |
|---|---|
| [`../apps/landing`](../apps/landing) | Public demos: exchange, concierge/service desk, provider marketplace, visa, vertical library |
| [`../apps/api/demo/web-chat.html`](../apps/api/demo/web-chat.html) | Standalone HTML-клиент для web-channel `/ws/:slug` |
| [`../apps/api/scripts/seed-exchange-demo.ts`](../apps/api/scripts/seed-exchange-demo.ts) | Демо-tenant обменки: exchange_v1 funnel, fixtures, KB, лиды/диалоги/orders |
| [`../apps/api/scripts/rehearse-exchange-demo.ts`](../apps/api/scripts/rehearse-exchange-demo.ts) | Rehearsal runner для exchange demo через `/api/admin/sim/exchange-eval` |
| [`../apps/api/scripts/seed-modeling-demo.ts`](../apps/api/scripts/seed-modeling-demo.ts) | Демо-данные для modeling vertical |

## 🗄 Archive

Завершённые/исторические рабочие заметки (для контекста, не reference):

| Док | Статус |
|---|---|
| [archive/ROADMAP_HISTORY.md](archive/ROADMAP_HISTORY.md) | PR-летопись сделанного (до июня 2026) + история позиционирования — вынесена из ROADMAP |
| [archive/CONCIERGE_VERTICAL.md](archive/CONCIERGE_VERTICAL.md) | Дизайн-док концерж-вертикали (фаза 0 эпика #175) — реализовано; канон теперь [CONCIERGE_FUNNEL_CONVERGENCE.md](engineering/CONCIERGE_FUNNEL_CONVERGENCE.md) |
| [archive/WORKFLOW_ANALYSIS_GAPS.md](archive/WORKFLOW_ANALYSIS_GAPS.md) | Анализ разрывов воронки — закрыт костяком фаз (PR #160) |
| [archive/bot-package-migration.md](archive/bot-package-migration.md) | Миграция `apps/bot` → пакеты — завершена (`apps/bot` удалён) |

---

Пакеты публикуются в npm с собственными README: см. `packages/*/README.md`
(подробные — [`../packages/kb/README.md`](../packages/kb/README.md),
[`../packages/sales/README.md`](../packages/sales/README.md)).

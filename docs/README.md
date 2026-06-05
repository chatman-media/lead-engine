# Документация Lead Engine

Индекс всех доков по аудитории. Высокоуровневое введение в продукт —
[`../README.md`](../README.md); правила для разработчиков/AI-агентов —
[`../AGENTS.md`](../AGENTS.md).

## 🛠 Engineering

| Док | О чём |
|---|---|
| [engineering/ARCHITECTURE.md](engineering/ARCHITECTURE.md) | Топология, multi-tenant изоляция (RLS + `withTenant`), pipeline, hot-reload, секреты, костяк воронки (`phase`), exchange/copilot/onboarding |
| [engineering/ONBOARDING.md](engineering/ONBOARDING.md) | Путь тенанта: закрытая регистрация → обязательный визард → каналы/LLM/KB/обменник (UI + curl) |
| [engineering/CONFIGURATION.md](engineering/CONFIGURATION.md) | Полный референс env-переменных (all vars, required/optional, fallback/per-tenant) |
| [engineering/EXCHANGE.md](engineering/EXCHANGE.md) | Обменная вертикаль: воронка, курсы/тиры, guardrails, ops-watch, реквизиты, orders CRM |
| [engineering/NOTIFICATIONS.md](engineering/NOTIFICATIONS.md) | Stage webhooks + правила/шаблоны уведомлений + operator settings + Telegram-группы + ops-алерты |

## ⚙️ Operations

| Док | О чём |
|---|---|
| [operations/SERVER_RUNBOOK.md](operations/SERVER_RUNBOOK.md) | Ручной апдейт прод-сервера: env → migrate → build → restart → health → re-seed |
| [operations/CD_SETUP.md](operations/CD_SETUP.md) | CD: push в `main` → CI → SSH-деплой `./deploy.sh` → health-check |

## 📈 Product & Strategy

| Док | О чём |
|---|---|
| [strategy/VERTICALS.md](strategy/VERTICALS.md) | 5 реализованных vertical templates + маппинг стадий на фазы + карта ниш (Пхукет/Таиланд) |
| [strategy/ROADMAP.md](strategy/ROADMAP.md) | Что сделано / в работе / дальше; GTM-треки, метрики, $1M ARR план |
| [strategy/POSITIONING.md](strategy/POSITIONING.md) | Позиционирование, ICP, ценность, цена, elevator pitch |
| [strategy/GTM_STRATEGY.md](strategy/GTM_STRATEGY.md) | Go-to-market: каналы, партнёры, питч инвесторам |
| [strategy/COMPETITORS.md](strategy/COMPETITORS.md) | Анализ конкурентов и pricing benchmarks |

## 🎯 GTM / Demo

| Док | О чём |
|---|---|
| [gtm/sales-bot/SETUP.md](gtm/sales-bot/SETUP.md) | Мета-демо: бот, продающий Lead Engine рекрутёрам (setup + KB + system prompt) |

## 🗄 Archive

Завершённые/исторические рабочие заметки (для контекста, не reference):

| Док | Статус |
|---|---|
| [archive/WORKFLOW_ANALYSIS_GAPS.md](archive/WORKFLOW_ANALYSIS_GAPS.md) | Анализ разрывов воронки — закрыт костяком фаз (PR #160) |
| [archive/bot-package-migration.md](archive/bot-package-migration.md) | Миграция `apps/bot` → пакеты — завершена (`apps/bot` удалён) |

---

Пакеты публикуются в npm с собственными README: см. `packages/*/README.md`
(подробные — [`../packages/kb/README.md`](../packages/kb/README.md),
[`../packages/sales/README.md`](../packages/sales/README.md)).

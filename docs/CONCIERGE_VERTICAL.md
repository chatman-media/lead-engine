# Lead Engine: Вертикаль «Консьерж-сервис» + воронка как набор воркфлоу

_Создано: 2026-06-05. Внутренний дизайн-документ. Фаза 0 эпика [#175](https://github.com/chatman-media/lead-engine/issues/175)._

Цель документа — **снять архитектурную развилку** и зафиксировать контракт до написания кода. Всё ниже заземлено на реальные места в коде (`file:line`), проверенные при аудите.

> **⚠️ Обновление (Фаза 1, реализация — 2026-06-05).** При реализации модель **упрощена**: вместо «N воронок на тенанта» выбрана **одна воронка с ветвлением по `request_type`** — общий intake → ветки `{exchange|transfer|food}` (`qualify→offer→fulfill`) → общие `completed`/`cancelled`. Это валидная воронка костяка (1 intake, монотонные фазы, 1 won + 1 lost), поэтому она **не требует** правок `applyFunnelStages` / boot-резолвинга / install и не конфликтует с «одной активной воронкой на тенанта». Реализовано: slice 1 (migration `0032`, `leads.request_type`), slice 2 (`@chatman-media/vertical-concierge`, `SEED_TEMPLATES['concierge']`). Секции 1 и 3 обновлены под это решение; формулировки про «N funnels» ниже — отвергнутая ранняя версия.

---

## 1. TL;DR — принятые решения

1. **Модель воронок: одна воронка с ветвлением по `request_type`.** Общий intake `request_received` ветвится по типу (обмен / трансфер / еда / …) в короткие ветки `qualify → offer → fulfill`, сходящиеся в общие терминалы `completed`/`cancelled`. Это **одна** валидная воронка костяка (ровно 1 intake, монотонные фазы по `position`, 1 won + 1 lost) → проходит `validateBackbone()` и операторский борд (колонки = фазы, бейдж = `request_type`) **без правок**. _(Ранняя версия «N воронок на тенанта» отвергнута: ветвление в одной воронке проще и не конфликтует с «одной активной воронкой на тенанта».)_
2. **Один гость = N параллельных `leads`** (по одному на активный запрос), но **один `conversation`-тред** на канал. Реестр шаблонов и резолвинг шаблона остаются **1:1** (тенант → `concierge_v1`); ветку лида помечает `leads.request_type`.
3. **Главная новая работа — две точки**: (а) снять `UNIQUE(leads.user_id)` + миграция (✅ slice 1, `0032`); (б) маршрутизация входящего: на intake классифицировать `request_type` → проставить `leads.request_type` и перейти в `<type>_request` (slice 3). `validateBackbone`, RLS, реестр вертикалей, `applyFunnelStages`/boot/install — **не трогаем**.

---

## 2. Текущая модель (как есть) — что предполагает «одно»

| Допущение | Где зашито | Ссылка |
|---|---|---|
| 1 lead на контакт | `UNIQUE` на `leads.user_id` | `packages/storage/src/schema.ts:435` |
| резолвинг лида 1:1 | `findByContactId` берёт единственную строку; `ensureLead` = get-or-create по контакту | `packages/conversation-engine/src/dal/leads.ts:41`, `lead-lifecycle.ts:12` |
| 1 активная воронка на тенанта | boot-маппинг `funnels WHERE is_active=true` → один template на tenant-slug | `apps/api/src/index.ts:139-161` |
| seed в одну воронку | `applyFunnelStages` берёт `funnels … is_active LIMIT 1` (или создаёт одну) | `apps/api/src/routes/admin-funnel.ts` (`applyFunnelStages`) |
| 1 conversation на (контакт, source) | `uniqueIndex uniq_conversations_user_source` | `packages/storage/src/schema.ts` (conversations) |
| lead ↔ conversation | **FK нет**, связь рыхлая через `contact.id` | — |

Важная деталь: входящий пайплайн `processInbound` (`packages/conversation-engine/src/process-inbound.ts:166`) резолвит **контакт и conversation, но не лид** — привязка лида происходит выше. Это нам на руку: conversation-слой почти не меняется.

---

## 3. Целевая модель

```
tenant (concierge)
  └── vertical template: concierge_v1            (1 шт., реестр без изменений)
        └── funnel: concierge   (ОДНА воронка с ветвлением)
              request_received (intake / capture)
                 ├─ exchange_request → exchange_offer → exchange_fulfill ┐
                 ├─ transfer_request → transfer_offer → transfer_fulfill ┼─→ completed (won)
                 └─ food_request     → food_offer     → food_fulfill     ┘   cancelled (lost)
              фазы по position: capture → qualify×3 → offer×3 → fulfill×3 → won / lost

guest (contact)
  └── conversation (1 на канал)                  ← единый чат-тред
        ├── lead #A  request_type=exchange   (open)
        ├── lead #B  request_type=transfer   (open)
        └── lead #C  request_type=food       (done)   ← завершённые не мешают
```

- **`request_type`** — ось (`exchange | transfer | food | housekeeping | tour | …`) на `leads.request_type` (migration `0032`). На intake задаётся и выбирает ветку (переход в `<type>_request`).
- **Одна воронка**: общий intake + общие терминалы, ветки разложены по фазам костяка → `validateBackbone()` проходит без правок (проверено `funnel-backbone.test.ts`).
- **Лид знает свою стадию** через `stage_definition_id`; операторский борд группирует по фазе, `request_type` — бейджем.

---

## 4. Контракт короткого воркфлоу

- Каждая **ветка** `request_type` — короткий путь `<type>_request (qualify) → <type>_offer (offer) → <type>_fulfill (fulfill)`, сходящийся в общие `completed`/`cancelled`. Все ветки разложены по фазам костяка (qualify-блок → offer-блок → fulfill-блок), что сохраняет монотонность `position`. Для `exchange` при необходимости добавляется `clear`/KYC — фаза опциональна.
- `qualify`/`offer` могут быть «тонкими» (одно поле): `REQUIRED_ACTIVE_PHASES` — это **warnings**, не errors (`phases.ts:181`), так что короткие цепочки легальны.
- Инвариант на воронку остаётся жёстким и **желанным**: ровно 1 intake, ≥1 won, ≥1 lost (`phases.ts:147-153`). Поскольку воронок несколько, каждая выполняет его сама по себе.

---

## 5. Резолвинг входящего сообщения (ядро дизайна)

Гость пишет в один тред — нужно решить, **к какому запросу** относится сообщение. Алгоритм на каждый inbound:

1. Резолвим контакт + conversation как сейчас (`process-inbound.ts:166`) — без изменений.
2. Грузим **открытые лиды** контакта: `findOpenByContact(contactId)` (новый метод, возвращает N).
3. Классификация (AI-intent, переиспользуем существующий слой):
   - **«про существующий запрос»** → берём открытый лид нужного `request_type` (если он один — однозначно; если несколько того же типа — самый свежий) → продолжаем его воронку.
   - **«новый запрос»** → классифицируем в `request_type` → `ensureRequestLead(contactId, requestType)` создаёт новый лид в стартовой стадии соответствующей воронки.
   - **неоднозначно** → лёгкий уточняющий вопрос гостю (или операторский `supportMode`).
4. Дальше — обычная FSM-логика выбранного лида (`funnel-machine.validateTransition` против шаблона этой воронки).

**MVP-правило детерминизма:** не более **одного открытого (не-терминального) лида на `(contact, request_type)`**. Новый запрос того же типа, пока старый открыт → дополняем открытый. После закрытия → новый лид. Уникальность **на уровне приложения** (терминальность определяется `kind` стадии, не выразить partial-index по `leads.state`), не в БД.

---

## 6. Изменения по слоям

| Слой | Файл | Изменение |
|---|---|---|
| **Schema** | `packages/storage/src/schema.ts:435` | снять `.unique()` с `user_id`; добавить `requestType: text("request_type")`; индекс `(tenant_id, user_id, state)` для выборки открытых |
| **Migration** | `packages/storage/migrations/00XX_*.sql` | `DROP CONSTRAINT … user_id_unique`; `ADD COLUMN request_type`; бэкфилл существующих лидов в `request_type` их вертикали (для совместимости 5 вертикалей — одно значение на тенанта) |
| **DAL** | `packages/conversation-engine/src/dal/leads.ts:41` | `findByContactId` → дополнить/заменить на `findOpenByContact(contactId)` (N строк) и `findOpenByContactAndType(contactId, type)`; `create` принимает `requestType` |
| **Lifecycle** | `packages/conversation-engine/src/lead-lifecycle.ts:12` | `ensureLead` → `ensureRequestLead(contactId, requestType)`: резолв открытого того же типа, иначе create в стартовой стадии воронки этого типа |
| **Routing** | `packages/conversation-engine/src/process-inbound.ts` (+ intent-слой) | шаг классификации new-vs-existing + выбор `request_type` (см. §5) |
| **Install/seed** | `apps/api/src/routes/admin-verticals.ts:75`, `admin-funnel.ts` `applyFunnelStages` | сидить **N воронок** на install (цикл по каталогу `request_type` шаблона); `applyFunnelStages` ключевать по `funnelSlug`, не `LIMIT 1` |
| **Boot resolve** | `apps/api/src/index.ts:139-161` | допустить несколько активных `funnels` на тенанта (маппинг tenant→template остаётся 1:1, цикл уже идемпотентен — проверить, что не падает) |
| **Template** | `apps/vertical-concierge/src/template.ts` (новый) | `concierge_v1`: вместо одного `funnelStages` — **каталог** коротких воркфлоу (по одному скелету на `request_type`); регистрация в `defaultRegistry` (`packages/verticals/src/registry.ts`) |
| **Operator UI** | `apps/api/src/routes/admin-dashboard.ts` + admin-ui | борд группирует лиды по **воронке/`request_type`** (колонки = фазы внутри типа), бейдж = тип; дашборд-запрос фильтрует/группирует по `funnel_id` |
| **Guest UI** | widget / bot | меню-витрина «Чем помочь?» (Обмен · Трансфер · Еда · …) как быстрый вход в `request_type`; статус своих запросов |

---

## 7. Что осознанно НЕ меняем

- **`validateBackbone()`** — остаётся как есть; каждая воронка-тип проходит его сама. Никаких послаблений `intakeCount !== 1`.
- **Реестр вертикалей и резолвинг шаблона** — 1:1 (тенант → `concierge_v1`). Мультипликатор — в данных, не в реестре.
- **`conversations`** — по-прежнему 1 на (контакт, source). Несколько лидов висят на одном треде.
- **RLS / tenant-изоляция** — без изменений (миграции 0004–0022), новый режим не создаёт shared-query протечек.
- **5 существующих вертикалей** — регресса нет: они сидятся одной воронкой, `request_type` бэкфиллится одним значением, резолвинг открытых вернёт тот же единственный лид.

---

## 8. Открытые вопросы / решения по умолчанию

1. **`request_type`: поле или таблица-справочник?** → По умолчанию **поле** `leads.request_type` + `funnels.slug`. Таблицу `request_types`/`workflow_templates` вводим, только когда понадобится UI-билдер каталога (Фаза 3+).
2. **Несколько открытых лидов одного типа** (два трансфера сразу)? → MVP: запрещаем (дополняем открытый). Снять ограничение позже, когда роутинг научится различать инстансы.
3. **Привязка conversation↔lead**: добавлять `conversations.active_lead_id` или резолвить каждый раз? → MVP: **резолвить каждый раз** через классификацию (без новой FK), чтобы не усложнять. FK добавим, если классификация окажется дорогой/шумной.
4. **Каталог `request_type` — захардкожен в шаблоне или редактируется из UI?** → MVP: захардкожен в `concierge_v1` (3 типа: exchange/transfer/food). UI-редактирование — Фаза 2/3.

---

## 9. Definition of Done для Фазы 0

- [x] Развилка снята: «воронка-на-`request_type`».
- [x] Контракт короткого воркфлоу зафиксирован (через `buildSkeletonFunnel` + жёсткий backbone на воронку).
- [x] Алгоритм резолвинга входящего описан (§5).
- [x] Список изменений по слоям с конкретными файлами (§6) — готов как план Фазы 1.
- [ ] Ревью этого документа владельцем продукта → апдейт чек-листа фаз в #175.

**Переход к Фазе 1** (после ревью): миграция (снять `UNIQUE` + `request_type`) → `ensureRequestLead`/`findOpenByContact` → скелет `concierge_v1` на 3 типа → роутинг new-vs-existing → борд с группировкой по типу.

---

## 10. Slice 3 — дизайн живого роутинга (заземлён на реальный lead-lifecycle)

**Корректировка ранней гипотезы (по итогам разбора кода).** Slice 3 — НЕ про `process-inbound`/`ensureLead`:
- `ensureLead` (`packages/conversation-engine/src/lead-lifecycle.ts:12`) — **мёртвый код**, нигде в рантайме не вызывается.
- `process-inbound` лиды не создаёт и не двигает вообще.
- Реальный авто-лайфцикл лида в клиентском потоке — **field-extractor** (`apps/api/src/lib/field-extractor.ts`), запускается async после inbound (вшит в webhook-роуты, напр. `webhook-telegram.ts:260`): авто-создаёт лид в первой по `position` стадии активной воронки (для concierge — `request_received`), LLM-ом извлекает поля в `lead_field_values` и по `autoAdvanceCondition: all_required_fields_filled` двигает лид дальше.

**Ключевой гэп для ветвления.** Авто-advance жёстко берёт `nextStages[0]` (`field-extractor.ts:245`). Для ветвящегося intake `request_received` (`nextStages: [exchange_request, transfer_request, food_request, cancelled]`) это всегда уведёт в `exchange_request`, игнорируя реальный тип запроса. Это — основное, что чинит slice 3.

**Минимальное изменение (ADDITIVE, gated) — всё в `field-extractor.ts`:**
1. **Классификатор не нужен.** `request_type` — это `aiExtractable` select-поле intake; существующий field-extractor уже извлекает его в `lead_field_values`. (Отдельный `RequestClassifier` + хук в `process-inbound` — избыточно.)
2. **Branch-aware advance.** Если у стадии >1 не-терминального `nextStages` **и** среди её полей есть `request_type` → выбирать переход по значению (`transfer` → `transfer_request`), а не `nextStages[0]`. Линейные воронки 5 вертикалей (один forward-next, нет поля `request_type`) не меняются.
3. **Писать `leads.request_type`.** При определении типа проставлять колонку (для борда и резолвинга лида).

**Сложная часть — N одновременных запросов на гостя.** Field-extractor сейчас «один лид на контакт»: lookup `leads WHERE tenant AND user` берёт первый (`field-extractor.ts:54-61`), а `.onConflictDoNothing()` (`:90`) после снятия `UNIQUE` (migration 0032) **больше не защищает** от дублей (нет conflict-target). Развилка:
- ✅ **MVP (slice 3):** один активный запрос на гостя за раз — таргетим самый свежий **не-терминальный** лид; новый запрос — после закрытия предыдущего. Реализовано.
- ✅ **Полный (slice 3b):** распознавание «НОВЫЙ запрос vs продолжение» в одном треде — сигнал `_new_request` встроен в **тот же** LLM-вызов извлечения (без доп. стоимости); другой тип в треде → отдельный лид сразу в его ветке. Реализовано + integration-verified.

**Не трогаем:** `process-inbound`, reply-strategy, 5 вертикалей (gating по наличию ветвления + поля `request_type`), `validateBackbone`, install/seed.

**План slice 3 — выполнено:** (1) ✅ branch-aware advance + запись `leads.request_type` в field-extractor (gated, `selectNextStage`); (2) ✅ multi-request lookup (самый свежий не-терминальный лид, иначе создаём новый); (3) ✅ integration-тесты (`field-extractor.integration.test.ts`); (4) ✅ параллельные запросы через `_new_request` в том же LLM-вызове. Всё на живом Postgres: field-extractor 14 pass / 26 expect.

---

## Ссылки на код

- Резолвинг лида: `packages/conversation-engine/src/dal/leads.ts:41`, `lead-lifecycle.ts:12`
- Входящий пайплайн: `packages/conversation-engine/src/process-inbound.ts:166`
- Костяк/скелет/валидатор: `packages/verticals/src/phases.ts` (`buildSkeletonFunnel:246`, `validateBackbone:137`)
- Схема: `packages/storage/src/schema.ts:432` (`leads`, `UNIQUE user_id` на :435), `conversations`
- Boot-резолвинг шаблона: `apps/api/src/index.ts:139-161`
- Install/seed: `apps/api/src/routes/admin-verticals.ts:75`, `admin-funnel.ts` (`applyFunnelStages`)
- Дашборд: `apps/api/src/routes/admin-dashboard.ts`
- Реестр вертикалей: `packages/verticals/src/registry.ts`
- Эпик: [#175](https://github.com/chatman-media/lead-engine/issues/175) · Гэп-анализ: `docs/WORKFLOW_ANALYSIS_GAPS.md` · Карта вертикалей: `docs/VERTICALS.md`

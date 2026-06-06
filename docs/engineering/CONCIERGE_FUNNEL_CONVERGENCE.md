# Концерж × Универсальная воронка — конвергенция

_Создано: 2026-06-06._

**Зачем этот документ.** Две крупные фичи приехали почти одновременно: **универсальная
воронка** (AI-сборка по описанию бизнеса + behavior-слой `goal`/`guidance`, #208 и ранее) и
**концерж** (мульти-реквест сервис-деск, #207). По отдельности обе зелёные и
задокументированы — [`AI_FUNNEL_BUILDER.md`](AI_FUNNEL_BUILDER.md) и
[`../CONCIERGE_VERTICAL.md`](../CONCIERGE_VERTICAL.md). Этот док — про то, **как они
срастаются**, где **швы**, и **дорожная карта**, которая сводит концерж в единую модель
универсальной воронки (принятое решение — «свести в одну модель», а не держать спец-случаем).

Вывод одной фразой: **общий хребет данных, но разъединённые концы.** Хранилище и
стейт-машина универсальны и концерж в них влезает; а оба конца — **генерация** (AI-билдер)
и **runtime-поведение** (reply-промпт) — концерж не охватывают и трактуют его как остров.

---

## A. Анализ

### A.0 Что уже универсально (и работает)

Концерж — это **одна** валидная воронка костяка: общий intake → ветки
`<type>_request/offer/fulfill` → общие `completed`/`cancelled`. Она хранится в тех же
`funnels → stage_definitions → stage_fields`, размечена фазами и проходит `validateBackbone`
(каждая ветка фаза-монотонна по `position`) — без правок apply/boot/install (см.
[`../CONCIERGE_VERTICAL.md`](../CONCIERGE_VERTICAL.md) §3).

Ключевое и неочевидное: **сам движок ветвления тоже универсален.** `selectNextStage`
([`field-extractor.ts:51`](../../apps/api/src/lib/field-extractor.ts)) и детект multi-request
([`field-extractor.ts:102`](../../apps/api/src/lib/field-extractor.ts)) срабатывают для
**любой** воронки, у которой на intake-стадии есть поле со слагом `request_type`. Линейные 5
вертикалей не затронуты (нет поля → прежнее `nextStages[0]`). То есть «контакт ↔ N
параллельных заявок» — это **общая способность платформы**, которой просто никто, кроме
концержа, не пользуется.

### A.1 Три шва (разъединённые концы)

| # | Шов | Где видно | Следствие |
|---|---|---|---|
| 1 | **Генерация слепа к multi-request** | `SYSTEM_PROMPT` в [`admin-workflow.ts`](../../apps/api/src/routes/admin-workflow.ts) учит только линейный хребет capture→qualify→offer→…→won/lost | Промис «опиши → AI построит» **не строит** концерж; его написали руками как `SEED_TEMPLATES['concierge']` |
| 2 | **Runtime-промпт слеп к `request_type` и к stage `goal`/`guidance`** | `requestType` есть только в DAL ([`leads.ts:70`](../../packages/conversation-engine/src/dal/leads.ts)), в композицию промпта не попадает. `goal`/`guidance` билдер пишет ([`admin-workflow.ts:204`](../../apps/api/src/routes/admin-workflow.ts)) и сохраняет в `stage_definitions` ([`admin-funnel.ts:1540`](../../apps/api/src/routes/admin-funnel.ts)), но `composeSystemPrompt` читает их из персоны-стиля ([`prompt.ts:173`](../../packages/sales/src/prompt.ts)), **не** из колонок стадии | Behavior-слой #208 — на этой ветке пока **мёртвые данные** (фикс в работе — PR **#211**, slice C-2); ветку бот «знает» лишь неявно (по тому, в какой стадии лежит лид) |
| 3 | **«Концерж-ность» гейтится хрупкой строкой** | `verticalTemplateId === 'concierge_v1'` в `isConciergeTenant` ([`concierge-tools.ts:31`](../../apps/api/src/lib/concierge-tools.ts)) — ~4 места (инструменты, витрина, callback) | Общую способность (multi-request) заперли на один template id; AI-собранная мульти-реквест-воронка не получит ни `list_my_requests`, ни витрину |

> Итог: **хребет и стейт-машина универсальны; голова (генерация) и руки (runtime-поведение)
> — ещё нет.** Концерж работает за счёт ручного seed-шаблона + гейтнутых инструментов +
> `systemPromptFragment` шаблона, а не потому, что универсальный движок его естественно
> производит и ведёт.

### A.2 Продуктовый разбор

- **P1. Концерж — другая ФОРМА продукта.** Пять исходных вертикалей — **линейные
  deal-пайплайны** (один лид = одна сделка, цель — довести до won). Концерж — **рекуррентный
  сервис-деск**: один контакт = поток мелких параллельных заявок, бот-диспетчер, fulfillment
  делает человек-оператор. Это ближе к helpdesk/тикетам. Метрики другие (пропускная
  способность/SLA заявок vs конверсия сделки) → влияет на позиционирование и прайсинг.
- **P2. Self-serve промис подорван.** Северная звезда — «опиши бизнес → AI строит». Концерж
  AI **не собирает** → доказано обобщение **хранилища**, не **продукта**. А самый сочный
  рынок концержа (управление виллами, property-концерж, expat-сервисы, клиники) онбордился бы
  именно через билдер — и тот его не вытянет.
- **P3. Оператор-фулфилмент — верный инстинкт, мимо модели.** `/send-offer`
  ([`admin-leads.ts:949`](../../apps/api/src/routes/admin-leads.ts)) — оператор инжектит
  сообщение как `role=human`, AI продолжает вести, «да» гостя → авто-переход offer→fulfill.
  Правильное разделение труда, но реализовано ad-hoc, **не как стадия**. При этом в схеме уже
  есть неиспользуемый `stageType: 'awaiting_operator'`
  ([`schema.ts:399`](../../packages/storage/src/schema.ts)) — словарь human-in-the-loop есть,
  фича к нему не подключилась.
- **P4. `list_my_requests` просит первый класс.** «Какой статус моих заказов» — мульти-реквест
  по природе. Bolt-on инструмент отвечает, но сам факт показывает: «контакт ↔ N заявок» — это
  **сущность** (заявка/тикет), а не nullable-колонка `leads.request_type`
  ([`schema.ts:446`](../../packages/storage/src/schema.ts)).
- **P5. Риск «выглядит готовым, но не сшито».** #207 и #208 по отдельности зелёные → читается
  как «готово». Но интеграция (AI строит мульти-реквест → её цели рулят ботом → оператор-handoff
  как стадия) не доделана. Опасно позиционировать «универсальная воронка строит концерж» как
  работающее, когда это два параллельных трека, делящих БД.

---

## B. Дорожная карта конвергенции

Усилия: S / M / L. Порядок учитывает рычаг и зависимости.

| ID | Что | Шов | Усилие | Когда |
|---|---|---|---|---|
| **R1** | stage `goal`/`guidance` → reply-промпт (slice C-2) | 2 | M | ✅ #211 merged |
| **R2** | дегейтинг multi-request: capability-флаг вместо `concierge_v1` | 3 | S–M | ✅ сделано |
| **R3** | AI-билдер учится multi-request-ветвлению | 1 | M | ✅ сделано |
| **R4** | `request_type` + cross-request awareness в промпте | 2 | S–M | ✅ сделано (+ почин #211) |
| **R5** | оператор-handoff как стадия `awaiting_operator` | P3 | M–L | ✅ готово |
| **R6** | _(опц., позже)_ первоклассная сущность «заявка/тикет» | P4 | L | будущее |

### R1 — stage `goal`/`guidance` → reply-промпт · M · **первым**
Наибольший рычаг: оживляет behavior-слой #208 для **всех** вертикалей, не только концержа.
> ✅ **Сделано (с оговоркой):** слайс C-2 смёржен в main как PR **#211** (06.06), НО резолвер
> `makeStageGuidanceResolver` оказался **определён, но не подключён** к `RagReplyStrategy` — в
> рантайме per-stage goal/guidance не доходил до промпта. Провод вшит здесь вместе с R4.
- Добавить в `composeSystemPrompt` опцию `stageOverride {goal, guidance}`
  ([`kb/prompt.ts:126`](../../packages/kb/src/prompt.ts),
  [`sales/prompt.ts:173`](../../packages/sales/src/prompt.ts)): при наличии — брать
  goal/guidance стадии воронки вместо коарс-карты персоны (opener/qualify/pitch/objection/close).
- Резолвер: зеркалить `makeSupportModeResolver` — по `leads.stageDefinitionId` тянуть
  `stage_definitions.goal/guidance`; протянуть через `RagReplyStrategy` (conversation-engine)
  и `answer.ts` из `llm-bootstrap`. Затрагивает 3 пакета (kb/sales, conversation-engine, apps/api).
- **Переиспользовать, не писать заново:** колонки уже есть (миграция `0034`), билдер уже
  эмитит и persist'ит — не хватает только чтения на reply-пути.
- **Тест:** лид на стадии с заданным `goal` → системный промпт содержит этот goal (а не
  коарс-стадию персоны).

### R2 — дегейтинг multi-request: capability-флаг · S–M · ✅ **сделано (эта ветка)**
Превращает концерж-only возможности (`list_my_requests`, ветвление) в универсальную способность.
- ✅ Добавлен `tenantSupportsMultiRequest(db, tenantId)`
  ([`concierge-tools.ts`](../../apps/api/src/lib/concierge-tools.ts)) — производный предикат
  «активная воронка → intake-стадия имеет поле `request_type`», зеркалит детект multiRequest в
  field-extractor. Без миграции/новой колонки.
- ✅ Гейт `list_my_requests` в [`llm-bootstrap.ts`](../../apps/api/src/llm-bootstrap.ts) переключён
  с template-специфичного `isConciergeTenant` на capability (кэш `multiRequestToolCache`);
  `isConciergeTenant` удалён.
- ✅ **Тест:** концерж-воронка **без** маркировки `concierge_v1` → tool включён; линейная `saas` →
  выключен. 5/5 concierge + 37/37 связанных (llm-bootstrap/reloader/field-extractor) зелёные, tsc чистый.
> Реальность main: концерж-гейт был ровно один (`list_my_requests`). Витрина/callback из анализа —
> на несмёрженной ветке `concierge-phase2-tails`; когда приедут, их гейт тоже = capability.

### R3 — AI-билдер учится multi-request · M · ✅ **сделано (эта ветка)**
Флагман: self-serve строит концерж-образные воронки.
- ✅ `SYSTEM_PROMPT` ([`admin-workflow.ts`](../../apps/api/src/routes/admin-workflow.ts)) обучён
  паттерну МУЛЬТИ-ЗАПРОС: intake с select-полем `request_type` (латинские `value` = префиксы веток),
  ветки `<X>_request/offer/fulfill`, схождение в общий won/lost, монотонный порядок фаз; диалог
  **спрашивает** «несколько ли параллельных типов запросов?».
- ✅ `normalizeStages` теперь сохраняет опции select как `{value,label}` и **пробрасывает**
  `optionsJson` при re-apply — иначе `value`-ключи `request_type` терялись и ветвление ломалось.
- ✅ Контракт ветвления валидируется `multiRequestBranchErrors` (в `admin-workflow.ts`, **не** в
  `validateBackbone` — тот не видит поля стадий): каждое значение `request_type` обязано иметь ветку
  `<value>_*` в `nextStages` intake; гейтит `/ai-chat` и `/apply` (400 на разрыв).
- ✅ **Тест:** ветвистая воронка применяется, латинские `value` опций сохранены; тип без ветки → 400.
  17/17 admin-workflow + 56/56 (copilot/backbone/admin-funnel) зелёные, tsc чист.
> Нюанс: качество ЖИВОЙ генерации LLM не проверено (в воркти нет LLM-ключа) — фейковый клиент
> покрывает логику нормализации/валидации/persist, не саму модель.

### R4 — `request_type` + cross-request awareness в промпте · S–M · ✅ **сделано (эта ветка)**
- ✅ Отдельное поле `requestContext` проброшено через 3 пакета (kb `composeSystemPrompt`/`answer`
  → conversation-engine `rag-reply` `resolveRequestContext` → apps/api `makeRequestContextResolver`):
  резолвер грузит `request_type` текущего открытого лида + число открытых заявок, инжектит блок
  «ЗАПРОС ГОСТЯ» в системный промпт. Линейные вертикали (нет `request_type`) не затронуты (null).
- ✅ **Попутно закрыт латентный баг #211 (R1):** `makeStageGuidanceResolver` был определён, но НЕ
  вшит в `RagReplyStrategy` → goal/guidance в рантайме не работал. Теперь оба резолвера
  (`resolveStageGuidance` + `resolveRequestContext`) подключены к strategy.
- ✅ **Тесты:** kb unit (блок «ЗАПРОС ГОСТЯ»), integration (`makeRequestContextResolver`: 1 открытый →
  тип; 2 → счётчик; терминальный → null). 42/42 apps/api + 5/5 kb + 189/189 conversation-engine, tsc чист.

### R5 — оператор-handoff как стадия `awaiting_operator` · M–L · ✅ **готово**
Сделано (эта ветка) — рантайм-семантика + билдер:
- ✅ Бот **придерживает гостя** на `awaiting_operator`-стадии: резолвер `makeAwaitingOperatorResolver`
  (llm-bootstrap) → флаг `awaitingOperator` проброшен через kb/conversation-engine (по паттерну R4) →
  блок «ОЖИДАНИЕ ОПЕРАТОРА» в промпте («цену/решение даёт человек, не выдумывай, скажи что уточнишь»).
  Гейтится на текущий открытый лид; линейные вертикали не затронуты.
- ✅ AI-билдер обучён ставить `stageType: awaiting_operator`, когда условия/цену/решение даёт
  человек-оператор (`awaiting_operator` уже в `STAGE_TYPES` — нормализация/apply работают).
- ✅ **Тесты:** kb unit (блок «ОЖИДАНИЕ ОПЕРАТОРА»), integration (резолвер: обычная стадия → false,
  awaiting_operator → true). 44/44 apps/api + 7/7 kb + 189/189 conversation-engine, tsc чист.

Доделано (R5-tail, эта ветка):
- ✅ **`/send-offer` завершает `awaiting_operator`-стадию** ([`admin-leads.ts`](../../apps/api/src/routes/admin-leads.ts)):
  если лид на awaiting_operator — отправка оффера двигает его по `nextStages[0]` (offer→fulfill) +
  fires stage-change нотификации (webhooks / adminEventBus / informer-оператор). Прочие стадии — только отправка.
- ✅ **Миграция SEED-концержа:** все 5 offer-стадий (`<X>_offer`) → `stageType: awaiting_operator` —
  концерж реально придерживает гостя и ждёт оператора на оффере.
- ✅ **Тесты:** integration (лид на awaiting_operator → /send-offer двигает в fulfill + advancedTo;
  обычная стадия → не двигает). 80/80 apps/api (admin-leads/funnel/concierge) + 31/31 (field-extractor/
  llm-bootstrap), tsc чист.

- ✅ **Проактивный пинг оператору при ВХОДЕ в `awaiting_operator`** — `notificationService` протянут
  в `makeFieldExtractor` (`index.ts`); при авто-продвижении лида В awaiting_operator-стадию шлётся
  `notify(stage_changed, awaitingOperator:true)` (fire-and-forget, вне tx). (`/send-offer` шлёт на ВЫХОДЕ.)
  Тест: advance в awaiting_operator → notify; в qualify → нет. 6/6 field-extractor + 36/36 смежных.

**R5 закрыт полностью** — конвергенция R1–R5 завершена.

### R6 — _(опц., позже)_ первоклассная сущность «заявка/тикет» · L
- Заменить nullable `leads.request_type` на реальную модель заявок (тикет с FK на контакт) —
  «правильная» модель P4. Только если multi-request станет ядром продукта; до тех пор
  capability-флаг (R2) — прагматичный интерим.

**Последовательность:** R1 + R2 (фундамент и дегейтинг) → R3 (флагман) → R4 (полировка) → R5
(глубина) → R6 (будущее).

---

## Связанные доки и заметка по сопровождению

- [`AI_FUNNEL_BUILDER.md`](AI_FUNNEL_BUILDER.md) — нарратив билдера и его собственный roadmap
  (behavior-слой, унификация входов). R1/R3/R4 здесь — конкретизация его «Дальше».
- [`../CONCIERGE_VERTICAL.md`](../CONCIERGE_VERTICAL.md) — дизайн концержа (ветвящаяся воронка,
  мульти-лид, резолвинг входящего §5).
- [`ARCHITECTURE.md`](ARCHITECTURE.md#funnel-phase-backbone-костяк) — костяк фаз.

> ⚠️ **Стало неактуально после #208:** в [`AI_FUNNEL_BUILDER.md`](AI_FUNNEL_BUILDER.md) строки
> ~61–63 утверждают «пер-стадийных `goal`/`guidance` колонок ещё нет; нужна миграция». Колонки
> **уже есть** (миграция `0034`), билдер их эмитит и persist'ит — остаётся только R1
> (чтение на reply-пути). Поправить при ближайшем редактировании.

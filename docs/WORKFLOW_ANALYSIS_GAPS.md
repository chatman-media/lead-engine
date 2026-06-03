# Анализ workflow: recruitment China, exchange, Philippines exchange

_Дата обновления: 2026-05-29_
_Статус: переоценка после universal pipeline; exchange action layer подтянут из PR #140_

Документ фиксирует не маркетинговое описание, а операционные разрывы между
реальным процессом клиента, текущим `main` и концепцией универсальных стадий.

## 0. Главный вывод

Система уже умеет базовую универсальную CRM-воронку:

- стадии и поля в БД: `stage_definitions`, `stage_fields`, `lead_field_values`;
- типы стадий: `form_fill`, `document_upload`, `external_approval`, `waiting`,
  `assessment`, `milestone` и т.д.;
- auto-extract текстовых полей через LLM;
- photo/passport OCR в `contact.attributes_json`;
- support mode, когда бот перестаёт продавать и ждёт оператора;
- stage webhooks, notifications, audit log, KB upload, admin UI для лида.

Но для денежных и документных процессов этого недостаточно. Сейчас universal
pipeline описывает "этапы и поля", но почти не описывает доменные действия:
расчёт курса, risk check, выдачу реквизитов, проверку платежа, внешний KYC,
партнёрское одобрение, TTL, напоминания, документ-пакеты и права внешнего
партнёра. Именно это надо добавить как слой `actions/tools` поверх стадий.

## 1. Архитектурные расхождения

### 1.0 Найденный план universal steps из Claude worktrees

План универсальных шагов лежит не отдельным документом, а в старых ветках:

- `feat/ai-workflow-exchange:docs/ARCHITECTURE.md` — раздел
  `Universal lead pipeline`;
- `feat/ai-workflow-exchange:docs/ONBOARDING.md` — шаг настройки воронки;
- `claude/exchange-bot` — реализация exchange action layer поверх этих шагов.

Исходный каталог stage types из того плана:

- `form_fill` — бот/оператор собирает данные через поля;
- `document_upload` — клиент присылает документы/файлы;
- `document_signature` — подписание договора;
- `rate_confirmation` — бот показывает курс/цену и ждёт подтверждения;
- `external_approval` — ждём решение третьей стороны или webhook;
- `payment` — оплата;
- `waiting` — ожидание по таймауту;
- `awaiting_operator` — бот замолкает, оператор действует вручную;
- `interaction` — встреча/звонок/просмотр;
- `assessment` — оценка/квалификация;
- `milestone` — контрольная точка.

Важно: это было расхождение между документами и `main`. Исправлено:
`rate_confirmation`, `payment`, `awaiting_operator` добавлены в единый каталог
stage types, а `video` добавлен в field types. Режим оператора по-прежнему
может дополнительно выражаться флагом `supportMode`.

### 1.1 Два слоя воронки расходятся

В `packages/verticals` template всё ещё описывается старой FSM-моделью:
`intake | lead | terminal`. В БД и admin funnel уже живёт новая модель:
`kind=intake|active|terminal_won|terminal_lost` плюс `stageType`.

Риск: новый вертикальный пакет может выглядеть корректным в registry, но не
выражать поведение универсальной стадии: TTL, support mode, auto-advance,
field validation, external approval.

Нужно: считать `stage_definitions/stage_fields` единственным источником
поведения. `VerticalTemplate.funnelStages` оставить только как legacy/preview
или расширить до нового формата.

### 1.2 Универсальные шаги есть, универсальных действий нет

Для Philippines flow шаги "посчитать курс", "получить реквизиты по API",
"проверить квитанцию", "проверить риск" нельзя надёжно делать через обычные
поля стадии. Это должны быть детерминированные tools/actions:

- `compute_quote`;
- `create_order`;
- `fetch_requisites`;
- `verify_payment`;
- `screen_risk`;
- `link_external_identity`;
- `issue_payout`;
- `schedule_reminder`.

PR #140 подтянут в рабочее дерево: отдельные `exchange_rates`,
`exchange_orders`, tool-loop, TTL sweeper, admin `/exchange`.
Это не просто "ещё одна воронка", а доменный слой над universal pipeline.

### 1.3 Файлы и документы пока не являются полноценными сущностями

В `stage_fields` есть `file/photo`, но значение поля не равно документу:
нет нормальной таблицы `lead_files/documents`, статуса проверки, OCR-результата,
версий, источника, mime/size, связи с сообщением, кем проверено.

Риск: паспорт, чек, фото, видео, CV, анкета и payout QR будут храниться как
разрозненные строки/Telegram file_id, а не как управляемые артефакты сделки.

## 2. Recruitment China: разбор по шагам

Текущая recruitment-воронка в `main`:

`intake_pending -> intake_complete -> partner_review -> approved -> docs_pending -> docs_complete -> visa_form -> visa_filing -> visa_waiting -> ready_to_work -> closed/rejected`

### 2.1 Intake кандидата

Что есть: большая анкета, auto-extract текстовых полей, фото/паспорт OCR.

Проблемы:

- слишком много обязательных данных на первом контакте;
- media-поля в старой `RECRUITMENT_INTAKE` обязательны сразу, а в DB seed часть
  медиа уже перенесена в `docs_pending`; это лучше, но два описания могут
  расходиться;
- нет branch logic по роли: танцовщица, хостес, певица, модель, staff;
- нет мягкого partial-intake: кандидат может прислать 30% данных, но воронка
  воспринимает это как незавершённость, а не как следующий nurturing step.

Отклонения:

- `dance_video` не должен быть универсальным обязательным требованием;
- `dance_styles` не подходит для non-dance вакансий;
- возраст 18+ должен быть validation/risk rule, а не просто поле.

Нужно:

- role-based intake preset;
- optional media checklist по роли;
- validation rules для возраста, паспорта, готовности выезда;
- напоминания по недостающим документам на уровне полей.

### 2.2 Assessment / intake_complete

Что есть: стадия `assessment`, но без полей и автоматической оценки.

Проблемы:

- нет scoring модели: fit score, visa risk, appearance/media completeness,
  urgency, language fit;
- нет объяснимого решения, почему кандидат ушёл в `approved/rejected`;
- нет отдельного статуса `needs_more_info`.

Нужно:

- `assessment_result` как структурированный объект;
- risk/fit критерии в `stage_fields` или отдельной таблице score events;
- audit trail: кто и почему одобрил/отклонил.

### 2.3 Partner review China

Что есть: стадия `external_approval`.

Проблемы:

- нет внешнего кабинета партнёра/работодателя;
- нет отправки кандидатского профиля пакетом;
- нет статусов "отправлено партнёру", "просмотрено", "комментарий",
  "запрошены доп. материалы";
- нет защиты PII при шаринге паспорта и фото.

Нужно:

- partner portal или signed review links;
- PDF/CV generator из данных кандидата;
- пакет документов с expiry link;
- webhook/API для результата партнёра;
- отдельные права доступа партнёра.

### 2.4 Approval и offer

Что есть: `approved` как milestone.

Проблемы:

- не хранится offer/contract terms: роль, город, зарплатная формула,
  комиссия, длительность, жильё, правила, дата старта;
- бот может "обещать" условия текстом без подтверждённого offer object;
- нет согласия кандидата с условиями.

Нужно:

- `offer_terms` как структурированный объект;
- document_signature для договора/согласия;
- шаблон сообщения "условия подтверждены" из approved offer, а не из LLM.

### 2.5 Сбор документов

Что есть: `docs_pending` с `file` полями.

Проблемы:

- `file` поле в UI сейчас не редактируется как нормальный upload;
- нет checklist статусов по каждому документу: uploaded/ocr_ok/rejected/expired;
- passport OCR пишет в `contact.attributes_json`, но не привязывает результат к
  конкретному файлу и стадии;
- нет проверки паспорта: срок действия, MRZ consistency, возраст, совпадение
  имени с intake.

Нужно:

- таблица документов лида;
- OCR result per document;
- document validation rules;
- операторская кнопка "принять/отклонить документ".

### 2.6 Visa form

Что есть: 33 поля в `visa_form`, auto-extract из текста.

Проблемы:

- чат плохо подходит для 33 чувствительных полей;
- высок риск ошибок транслитерации, дат, родителей, адресов;
- нет preview/export в формат, который реально нужен консульству/агенту;
- нет блокировки отправки при пустых/сомнительных полях.

Нужно:

- отдельная web-form ссылка для кандидата;
- валидация латиницы/дат/обязательности;
- autosave + progress;
- export PDF/CSV/JSON для визового партнёра;
- operator review before `visa_filing`.

### 2.7 Visa filing / waiting / ready

Что есть: `external_approval`, `waiting`, `milestone`.

Проблемы:

- нет интеграции со слотами подачи/статусом визы;
- `staleTimeoutDays=90` есть, но нет полноценного workflow check-in по событиям;
- нет travel logistics: билеты, дата прилёта, трансфер, встречающий, accommodation.

Нужно:

- calendar/deadline tasks;
- reminders для оператора и кандидата;
- travel stage после visa approved;
- внешние webhooks от визового/тревел-партнёра.

## 3. Exchange Phuket/main: разбор текущего состояния

Текущая exchange-воронка в `main`:

`intent_detected -> exchange_request -> quote_calculated -> verification_check -> kyc_collection -> risk_review -> order_created -> requisites_sent -> payment_proof_waiting -> payment_verified -> payout_or_completion/cancelled`

Важно: 7 значений `exchange_orders.status` — это короткий денежный lifecycle
заявки (`quote`, `awaiting_payment`, `paid`, `payout`, `completed`,
`cancelled`, `expired`), а не полная бизнес-воронка. В exchange CRM нужно
показывать оба слоя: технический статус заявки и универсальный шаг процесса.

### 3.1 Quote request

Что есть: asset, payment method, network, amount.

Проблемы:

- нет `asset_to`, флоу зашит в THB;
- network optional, но для USDT должен быть conditionally required;
- нет payout method: office cash / cardless ATM / bank transfer / delivery;
- нет country/city контекста, что важно для Philippines.

Нужно:

- conditional required fields;
- direction model: `asset_from`, `asset_to`, `country`, `payout_method`;
- нормализация валют и сетей через enum.

### 3.2 Rate confirmation

Что есть: поля `exchange_rate`, `thb_amount`, `rate_confirmed`, оператор вручную.

Проблемы:

- LLM может ошибиться в математике, если не вынести расчёт в tool;
- нет quote snapshot и TTL;
- нет формулы `base_rate +/- margin/fee`;
- нет audit курса, который был показан клиенту;
- нет защиты от повторного использования старого курса.

Нужно:

- `exchange_rates`;
- `exchange_quote` или `exchange_orders.quote_snapshot`;
- `expires_at`;
- deterministic `compute_quote`.

### 3.3 KYC / verification

Что есть: `customer_name`, `passport_photo`, `passport_number`.

Проблемы:

- нет связи с внешней CRM верификации;
- нет статуса KYC: unknown/pending/verified/rejected/expired;
- нет KYC threshold по сумме/валюте/стране;
- нет повторного использования уже верифицированного клиента.

Нужно:

- `external_verification_id`;
- KYC provider connector;
- отдельный `verification` stage или action;
- policy: когда KYC обязателен.

### 3.4 Awaiting payment

Что есть: tx hash или скрин, `payment_confirmed` вручную, support mode.

Проблемы:

- фиатный чек можно подделать;
- фото/чек не парсится в структурированные поля;
- нет сверки суммы, отправителя, получателя, времени;
- нет idempotency по tx hash/receipt id;
- нет partial/over/under payment статусов.

Нужно:

- payment provider API;
- on-chain verification для crypto;
- receipt OCR только как assistive сигнал, не как финальное подтверждение;
- статусы payment: pending/seen/matched/mismatch/confirmed/rejected.

### 3.5 Payout / QR delivery

Что есть: send-photo endpoint из карточки лида.

Проблемы:

- QR передаётся как произвольное фото без lifecycle;
- нет пула QR/кодов, TTL, кто выдал, кто открыл;
- нет двухфакторного подтверждения клиента перед выдачей;
- нет разделения office payout и ATM/cardless payout.

Нужно:

- `payout_method`;
- `payout_code/qr` как секретный документ с TTL;
- audit: кто выдал, когда, кому, по какой заявке;
- confirmation phrase/OTP перед выдачей.

## 4. Exchange action layer из PR #140

Exchange layer подтянут из ветки `claude/exchange-bot`. Он добавляет:

- `exchange_rates` и `exchange_orders`;
- deterministic tools: quote/order/requisites/verify/payout;
- market rate feed;
- TTL sweeper в worker;
- admin `/exchange`;
- TRC20 verification по tx hash;
- `video_note` для optional verification.

Это правильная архитектурная линия: деньги считает сервис, LLM только ведёт
диалог. Перед merge всё ещё надо проверить:

- schema соответствует RLS-инвариантам и не дублирует tenant scope;
- tools вызываются только в безопасных стадиях и не обходят `withTenant`;
- exchange order связан с `lead_id`, `conversation_id`, `contact_id`;
- quote snapshot неизменяем после показа клиенту;
- idempotency не даёт создать две активные заявки из одного подтверждения;
- rate feed имеет sanity guard и manual override;
- worker TTL не шлёт повторные напоминания бесконечно;
- admin `/exchange` не показывает/не логирует секретные реквизиты в audit.

## 5. Philippines exchange: универсальная воронка

Требование клиента: Telegram userbot, intent routing: exchange / rate /
transfer / green corridor, verification, partner requisites API, receipt,
CRM оборотов, reminders, admin rates/formulas.

Ниже воронка, которая вписывается в universal stages, но требует actions/tools.

### 5.1 Proposed stages

1. `intent_detected`
   - kind: `intake`
   - type: `form_fill`
   - fields: `intent`, `arrival_date`, `country`, `city`
   - auto: route to exchange/transfer/green_corridor

2. `exchange_request`
   - kind: `active`
   - type: `form_fill`
   - fields: `asset_from`, `asset_to`, `direction`, `network`,
     `amount_from`, `payout_method`
   - action: validate direction and conditionally require network

3. `quote_calculated`
   - kind: `active`
   - type: `rate_confirmation`
   - fields: `quote_id`, `base_rate`, `formula_id`, `final_rate`,
     `fee`, `amount_to`, `expires_at`, `client_confirmed`
   - action: `compute_quote`

4. `verification_check`
   - kind: `active`
   - type: `external_approval`
   - fields: `external_verification_id`, `verification_status`,
     `verification_provider`, `verified_at`
   - action: `check_verification` / `start_verification`

5. `risk_review`
   - kind: `active`
   - type: `assessment`
   - fields: `risk_score`, `risk_flags`, `risk_decision`
   - action: `screen_risk`

6. `order_created`
   - kind: `active`
   - type: `milestone`
   - fields: `exchange_order_id`, `partner_order_id`, `quote_snapshot`
   - action: `create_order`

7. `requisites_sent`
   - kind: `active`
   - type: `external_approval`
   - fields: `provider`, `requisites_ref`, `requisites_expires_at`,
     `sent_at`
   - action: `fetch_requisites` and send to client

8. `payment_proof_waiting`
   - kind: `active`
   - type: `payment`
   - supportMode: false for crypto auto, true for fiat manual fallback
   - fields: `receipt_file`, `tx_hash`, `receipt_sender`, `receipt_bank`,
     `receipt_amount`, `receipt_time`
   - action: reminder if incomplete

9. `payment_verified`
   - kind: `active`
   - type: `assessment`
   - fields: `payment_status`, `matched_amount`, `sender_account`,
     `from_address`, `verified_by`
   - action: `verify_payment`

10. `payout_or_completion`
    - kind: `terminal_won`
    - type: `milestone`
    - fields: `final_amount_paid`, `completed_at`, `receipt_archive_ref`

11. `cancelled`
    - kind: `terminal_lost`
    - type: `milestone`
    - fields: `cancel_reason`

### 5.2 Mapping of 22 client steps

| Client step | Universal stage/action | Gap in current main |
|---|---|---|
| 1. Userbot replies from manager account | channel `telegram_userbot` | mostly exists |
| 2. Intent: exchange/rate/transfer/green corridor | `intent_detected` + classifier | no per-funnel intent router |
| 3. Exchange direction | `exchange_request.direction` | current exchange assumes THB payout |
| 4. Amount | `amount_from` | exists |
| 5. Formula from base rate | `compute_quote` | exchange tools added, adapt formulas per Philippines |
| 6. Show final quote | `quote_calculated` | quote/order snapshot exists, add per-direction Philippines copy |
| 7. Check verification | `check_verification` | missing external KYC link |
| 8. Send to verification | `start_verification` | missing provider/deeplink action |
| 9. Return after verification | webhook/callback to stage | missing inbound external callback |
| 10. Risk check | `screen_risk` | missing domain risk layer |
| 11. Create exchange order | `create_order` | exchange order exists, extend schema if partner fields differ |
| 12. Get requisites by API | `fetch_requisites` | provider abstraction exists, connect Philippines partner API |
| 13. Send requisites | outbound from action | missing controlled secret delivery |
| 14. Ask receipt | `payment_proof_waiting` | partially via fields |
| 15. Verify receipt | `verify_payment` | missing for fiat receipts |
| 16. Detect sender/source | receipt OCR/provider data | missing document/receipt parser |
| 17. CRM turnover | exchange dashboard aggregate | exists for THB, extend for Philippines currencies if needed |
| 18. CRM per exchange | `exchange_orders` | exists |
| 19. Store telegram id/KYC id/time/etc. | order + contact + identity | needs explicit schema |
| 20. Arrival date offer transfer/green corridor | intent/action cross-sell | missing lifecycle trigger |
| 21. Admin rates/formulas | `/exchange` rates | exists, extend directions/countries |
| 22. Remind unfinished exchange | TTL/reminder worker | exists |

### 5.3 What Philippines adds beyond Phuket

- multi-intent routing, not only exchange;
- external verification CRM identity is mandatory;
- partner requisites API is mandatory;
- receipt sender/source extraction is mandatory;
- turnover CRM is a core requirement, not nice-to-have;
- transfer/green corridor are cross-sell flows triggered by travel date;
- formulas and rates must be admin-managed per direction/currency/country.

## 6. Missing platform capabilities

### 6.1 Admin

- exchange-specific dashboard: rates, formulas, orders, turnover, risk flags;
- upload/attach files directly to lead/order fields;
- document review UI with accept/reject/reason;
- partner/KYC identity field visible and searchable;
- manual override with reason for quote/payment/risk decisions;
- reminders/tasks view for abandoned exchanges and document gaps.

### 6.2 External services

- KYC/verification CRM connector;
- payment provider connector for requisites;
- blockchain/fiat verification connector;
- AML/risk connector;
- partner/employer approval connector;
- webhook retries + dead-letter for outbound stage/order events.

### 6.3 Data model

- `exchange_rates`, `exchange_orders`, `exchange_payments`, `exchange_requisites`
  or equivalent domain tables;
- `lead_documents` / `order_documents`;
- `external_identities` for KYC/partner/CRM ids;
- immutable quote snapshots;
- idempotency keys for order/payment actions;
- audit fields for all manual financial overrides.

### 6.4 Bot behavior

- tool-first rule for money: LLM never calculates rates, fees, payouts;
- no invented requisites, rates, verification status or partner decision;
- stage-aware prompts should know what actions are available;
- incomplete transaction reminders must be scheduled, not improvised by chat.

## 7. Recommended implementation order

1. Review and harden the imported exchange domain layer.
2. Add Philippines exchange seed using the stages above, but keep all money
   operations as tools/actions, not fields.
3. Add external verification identity model and admin field.
4. Add receipt/document entity with OCR metadata and review status.
5. Add intent routing stage for exchange/rate/transfer/green corridor.
6. Add partner API connector for requisites and KYC callbacks.
7. Extend operator/admin dashboards for multi-country order CRM and turnover.

## 8. Short answer

Recruitment China needs better document lifecycle, partner review, role-based
intake and visa-form UX. Exchange needs a domain financial layer, not only a
CRM funnel. Philippines should reuse universal stages for visibility, but all
critical operations must be deterministic actions/tools with their own tables,
idempotency, TTL, audit and external API connectors.

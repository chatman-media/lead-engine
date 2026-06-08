# Lead Engine: Вертикали и ниши

_Обновлено: 2026-06-07 (2). Внутренний документ._

Сводная карта всех вертикалей — от уже реализованных до перспективных ниш (Пхукет / Таиланд и универсальные).

> **Универсальная модель.** Все вертикали ниже — инстансы **одного** универсального
> костяка воронки `capture → qualify → offer → [clear] → [fulfill] → won/lost`
> (`packages/verticals/src/phases.ts`). Шаблоны (`SEED_TEMPLATES`) — лишь стартовые
> заготовки; новую вертикаль можно собрать **AI по описанию бизнеса** без кода —
> см. [`../engineering/AI_FUNNEL_BUILDER.md`](../engineering/AI_FUNNEL_BUILDER.md).

---

## Статусы

- **Implemented** — есть vertical template в коде (`apps/vertical-*`), сидится из UI
- **Phase 1** — реализовано, текущий GTM-ICP
- **Phase 2** — запланировано в роадмапе
- **Prospect** — перспективная ниша, не начата

---

## Реализованные вертикали (vertical templates)

В коде есть **9 vertical templates** (`apps/vertical-*`, зарегистрированы в
`apps/api`), каждый сеет воронку + intake-анкету + стили из UI:

| Template slug | Ниша | Seed key | Статус |
|---|---|---|---|
| `exchange_v1` | Обменник (крипта/RUB → THB наличные) | `exchange` | ✅ **live, самая активная** |
| `recruitment_v1` | Найм (UAE/виза) | `recruitment` | ✅ прод (GTM-ICP) |
| `modeling_v1` | Модельное агентство (Дубай, Стамбул, Европа) | `modeling` | ✅ |
| `real_estate_v1` | Недвижимость (Dubai) | `real_estate` | ✅ |
| `saas_v1` | SaaS-продукт | `saas` | ✅ |
| `video_v1` | Видеопродакшн | `video` | ✅ |
| `concierge_v1` | Консьерж / сервис-деск (вилла, expat) | `concierge` | ✅ **мульти-запрос** |
| `visa_v1` | Визовое агентство (UAE/Thailand/Schengen) | `visa` | ✅ |
| `scooter_v1` | Аренда байков / скутеров (Пхукет, Бали) | `scooter` | ✅ |

(Плюс seed-шаблон `recruitment_generic` — упрощённая HR-воронка без UAE-специфики.)

> **Концерж = доказательство универсальности.** В отличие от 5 линейных вертикалей,
> концерж — **мульти-запросный** сервис-деск: один клиент ↔ N параллельных заявок
> (ось `request_type`), ветвящаяся воронка, оператор-handoff. AI-билдер умеет такие
> собирать по описанию бизнеса — см.
> [`../engineering/CONCIERGE_FUNNEL_CONVERGENCE.md`](../engineering/CONCIERGE_FUNNEL_CONVERGENCE.md).

### Универсальный костяк воронки (`phase`)

Поверх произвольных стадий у всех вертикалей лежит общая ось фаз
(`packages/verticals/src/phases.ts`, миграция `0031_stage_phase.sql`):

```
capture → qualify → offer → [clear] → [fulfill] → won / lost
```

`qualify`/`offer` обязательны; `clear` (KYC/комплаенс/документы) и `fulfill`
(доставка/оплата) опциональны; `capture`/`won`/`lost` выводятся из `kind`.
Маппинг стадий каждой вертикали на фазы:

| Вертикаль | capture | qualify | offer | clear | fulfill | won / lost |
|---|---|---|---|---|---|---|
| **exchange** | exchange_request | — | quote_calculated | verification_check, kyc_collection, risk_review | order_created, requisites_sent, payment_proof_waiting, payment_verified | payout_or_completion / cancelled |
| **real_estate** | qualification | viewings | offer_negotiation, mou_signed | noc_application, mortgage_approval | — | dld_transfer / deal_lost |
| **modeling** | intake_pending | intake_complete, casting_review, city | casting_approved, offer_sent | — | contract_signed, show_confirmed | closed / not_suitable, rejected |
| **visa** | qualification | documents_collection, financial_verification | application_submission | processing | — | visa_issued / rejected |
| **scooter** | inquiry | booking_confirmed | — | payment_pending | active_rental | returned / cancelled |
| **recruitment** | intake_pending | intake_complete, partner_review | approved | docs_pending, docs_complete, visa_* | ready_to_work | closed / rejected |
| **saas** | discovery | qualified, demo_scheduled | demo_done, proposal_sent, negotiation | — | — | signed / lost |
| **video** | inquiry | brief_call | quote_sent, quote_approved | — | shoot_scheduled, editing, delivery | invoiced / declined |

Костяк валидируется (`validateBackbone`) при AI-сборке и `apply`; cross-vertical
метрика — `GET /api/admin/funnel/phase-stats`. Технические детали —
[`ARCHITECTURE.md#funnel-phase-backbone`](../engineering/ARCHITECTURE.md).

---

## Таблица всех вертикалей

| # | Вертикаль | Template | Объём | LTV | Fit | Статус |
|---|-----------|----------|-------|-----|-----|--------|
| 1 | Рекрутинговые агентства | `recruitment_v1` ✅ | Высокий | Средний | ★★★★★ | ✅ **Implemented · GTM-ICP** |
| 2 | Обменник (крипта → наличные) | `exchange_v1` ✅ | Высокий | Средний | ★★★★★ | ✅ **Implemented · Live** |
| 3 | Консьерж / сервис-деск | `concierge_v1` ✅ | Средний | Средний | ★★★★★ | ✅ **Implemented · мульти-запрос** |
| 4 | Модельное агентство | `modeling_v1` ✅ | Средний | Средний | ★★★★★ | ✅ **Implemented** |
| 5 | Недвижимость (продажа) | `real_estate_v1` ✅ | Средний | Очень высокий | ★★★★★ | ✅ **Implemented** |
| 6 | SaaS-продукт | `saas_v1` ✅ | Средний | Высокий | ★★★★★ | ✅ **Implemented** |
| 7 | Видеопродакшн | `video_v1` ✅ | Низкий | Высокий | ★★★★★ | ✅ **Implemented** |
| 8 | Visa & Immigration Services | `visa_v1` ✅ | Высокий | Высокий | ★★★★★ | ✅ **Implemented** |
| 9 | Аренда байков / Scooter Rental | `scooter_v1` ✅ | Очень высокий | Низкий | ★★★★☆ | ✅ **Implemented** |
| 10 | Медицинский туризм / Стоматология | — | Высокий | Высокий | ★★★★★ | Prospect |
| 11 | Expat Health Insurance | — | Средний | Очень высокий | ★★★★★ | Prospect |
| 12 | Дайвинг / PADI Certification | — | Высокий | Средний | ★★★★★ | Prospect |
| 13 | Долгосрочная аренда жилья | — | Средний | Высокий | ★★★★☆ | Prospect |
| 14 | Свадьбы в Таиланде | — | Средний | Очень высокий | ★★★★☆ | Prospect |
| 15 | Регистрация компании / BOI / Work Permit | — | Низкий | Очень высокий | ★★★★☆ | Prospect |
| 16 | Перевозка домашних животных | — | Низкий | Высокий | ★★★★☆ | Prospect |
| 17 | Аэропортные трансферы / VIP Meet & Greet | — | Высокий | Низкий | ★★★☆☆ | Prospect |
| 18 | Морские прогулки / Boat Tours | — | Средний | Средний | ★★★☆☆ | Prospect |
| 19 | Private Chef / Кейтеринг на виллах | — | Высокий | Низкий | ★★★☆☆ | Prospect |
| 20 | Condo-for-Visa (покупка ради визы) | — | Низкий | Очень высокий | ★★★☆☆ | Prospect |

---

## Детали по каждой вертикали

### 1. Рекрутинговые агентства ★★★★★ — ✅ Implemented · GTM-ICP · `recruitment_v1`

**Почему выбрана первой:** Telegram-first рынок, понятный ICP, быстрые продажи, ARPU $99–199/мес.

Workflow:
- Входящий кандидат → квалификация по вакансии (SPIN/NEPQ)
- Сбор анкеты: опыт, зарплата, локация, документы
- Скоринг по критериям клиента
- Handover рекрутёру только горячих

**Реализовано:** воронка (intake → partner_review → approved → docs → visa → ready_to_work), 3 стиля-персоны (SPIN/NEPQ/Straight Line), seed-шаблон `recruitment`, demo-тенант `bob@demo.io`.

---

### 2. Обменник (крипта → наличные) ★★★★★ — ✅ Implemented · Live · `exchange_v1`

Workflow:
- Запрос курса → квалификация суммы → расчёт котировки → KYC (для крупных сумм) → реквизиты → подтверждение оплаты → выдача

**Реализовано:** воронка exchange, rate-guardrails, подтверждение оплаты, self-play eval harness. Самая активная вертикаль.

---

### 3. Консьерж / сервис-деск ★★★★★ — ✅ Implemented · `concierge_v1`

Пример: вилла, expat-сервисы, гостиничный консьерж.

Workflow:
- Кнопочная витрина (трансфер / еда / уборка / экскурсия / обмен)
- Мульти-запрос: один клиент ↔ N параллельных заявок
- Domain action tools: get/confirm для каждого типа услуги
- Оператор-handoff на сложных кейсах

**Реализовано:** inline-кнопки TG (клик-витрина), 8 domain action tools, concierge catalog (AES-шифрование), multi-request engine.

---

### 4. Модельное агентство ★★★★★ — ✅ Implemented · `modeling_v1`

Рынки: Дубай, Стамбул, Европа (показы, съёмки, промо).

Workflow:
- Входящий → intake (анкета + фото + видео) → кастинг-ревью → [уточнение города] → кастинг одобрен → оффер → контракт → показ/съёмка

**Реализовано:** воронка (11 стадий), intake с фото+видео, 3 стиля (warmScout SPIN/Лена, proDirector PAS/Максим, friendRecruiter NEPQ/Катя), demo-тенант `lena@demo.io`.

---

### 5. Недвижимость (продажа) ★★★★★ — ✅ Implemented · `real_estate_v1`

Workflow:
- Входящий → квалификация (тип объекта, бюджет, цель — инвест/проживание)
- Подбор через RAG по базе объектов
- Запись на просмотр + напоминания
- Сбор документов (паспорт, подтверждение дохода)
- Handover риэлтору с готовым брифом

**Реализовано:** воронка (qualification → viewings → offer → NOC/mortgage → DLD transfer), seed-шаблон `real_estate`.

---

### 6. SaaS-продукт ★★★★★ — ✅ Implemented · `saas_v1`

Workflow:
- Discovery → квалификация → демо → proposal → negotiation → signed

**Реализовано:** воронка saas, intake, seed-шаблон `saas`.

---

### 7. Видеопродакшн ★★★★★ — ✅ Implemented · `video_v1`

Workflow:
- Запрос → бриф-звонок → смета → съёмка → монтаж → сдача

**Реализовано:** воронка video (inquiry → brief_call → quote → shoot → editing → delivery), seed-шаблон `video`.

---

### 8. Visa & Immigration Services ★★★★★ — ✅ Implemented · `visa_v1`

Пример: Thailand Privilege, Elite Visa, Retirement Visa, продление, BOI.

Workflow:
- Квалификация: тип визы, срок пребывания, гражданство, бюджет
- RAG по актуальным требованиям и срокам
- Сбор документов: фото паспорта (OCR), выписки, фото
- Генерация чек-листа + timeline
- Оплата услуг агентства через QR
- Handover иммиграционному юристу

Почему Lead Engine: очень сложно для rule-based ботов, документооборот идеален для stage_fields + Passport OCR.

**Реализовано:** воронка (qualification → documents_collection → financial_verification → application_submission → processing → visa_issued / rejected), 3 стиля (PAS/NEPQ/SPIN), seed-шаблон `visa`. PR #293.

---

### 9. Аренда байков / Scooter Rental ★★★★☆ — ✅ Implemented · `scooter_v1`

Workflow:
- Квалификация: даты, класс байка, нужна ли доставка, страховка
- Проверка наличия водительских прав (обязательно)
- Бронирование + депозит через QR
- Уведомление о доставке
- Авторемайндер о возврате за день

Простая воронка, но очень высокий объём — сотни запросов в день на Пхукете.

**Реализовано:** воронка (inquiry → booking_confirmed → payment_pending → active_rental → returned / cancelled), 3 стиля (NEPQ/SPIN/AIDA), seed-шаблон `scooter`. PR #293.

---

### 10. Медицинский туризм / Стоматология ★★★★★ — Prospect

Workflow:
- Запрос услуги (импланты, check-up, пластика, лазер)
- Квалификация: симптомы/жалобы, возраст, бюджет, даты
- Загрузка медицинских документов и фото (vision)
- AI-предварительная оценка + ответы на типовые вопросы из RAG
- Бронирование слота + оплата депозита через QR
- Авторемайндеры до приёма

---

### 11. Expat Health Insurance ★★★★★ — Prospect

Поставщики: AXA, BUPA, Pacific Cross, Cigna.

Workflow:
- Квалификация: возраст, гражданство, страна пребывания
- Медицинский анамнез (pre-existing conditions)
- Выбор типа покрытия: inpatient / outpatient / dental / maternity
- RAG по планам и ценам с реальным сравнением
- Генерация персонального предложения
- Handover к страховому агенту с готовой анкетой

Почему сильная ниша: LTV $1k–5k/год на клиента, NEPQ работает отлично ("что тебя останавливает от нормального покрытия?"), почти нет конкурентов в мессенджерах.

---

### 12. Дайвинг / PADI Certification ★★★★★ — Prospect

Рынок: Пхукет, Ко Тао, Ко Самуи. Тысячи запросов ежедневно.

Workflow:
- Квалификация: уровень (beginner / advanced / rescue), даты, группа
- Медицинский опросник (10+ вопросов) — идеальный multi-stage funnel
- Safety waiver через stage_fields
- Фото паспорта через Passport OCR
- Оплата депозита через QR
- Авторемайндеры за день до курса

Почему Lead Engine: медопросник — слишком сложен для rule-based, safety waiver требует структурированного сбора данных.

---

### 13. Долгосрочная аренда жилья ★★★★☆ — Prospect

Для digital nomads и экспатов (6–12+ мес).

Workflow:
- Поиск по критериям: локация, бюджет, бассейн, WiFi, парковка
- RAG по базе объектов
- Сбор документов для договора
- Оплата депозита + первого месяца через QR
- Check-in / Check-out flow
- Maintenance requests через бот

---

### 14. Свадьбы в Таиланде ★★★★☆ — Prospect

Пхукет — топ-3 свадебных направлений для русских и европейцев.

Workflow:
- Квалификация: даты, кол-во гостей, бюджет, стиль (пляж / вилла / отель)
- RAG по доступным площадкам, ценам, пакетам
- Документы: паспорта, свидетельства о рождении, апостиль
- Бронирование и поэтапные платежи через QR
- Подключение субподрядчиков (декор, фото, кейтеринг) — handover

LTV: $5k–50k на одну свадьбу.

---

### 15. Регистрация компании / BOI / Work Permit ★★★★☆ — Prospect

Workflow:
- Квалификация: тип бизнеса, объём инвестиций, % иностранного владения, нужен ли BOI
- RAG по актуальным требованиям Department of Business Development
- Сбор документов: паспорта директоров, устав, адрес
- Оплата госпошлин через QR
- Handover корпоративному юристу с готовым брифом

LTV: $500–2000+ за регистрацию + ongoing (отчётность, продление).

---

### 16. Перевозка домашних животных ★★★★☆ — Prospect

Нишевая, но исключительно document-heavy.

Workflow:
- Квалификация: страна отправки/назначения, порода, дата вылета
- RAG по актуальным требованиям (часто меняются — killer feature)
- Чек-лист: микрочип → ветпаспорт → справка о здоровье → CITES/разрешение → карантин
- Appointment reminders (ветклиника, оформление)
- Оплата услуг агента через QR

Клиент в панике → готов платить $500–2000 за сопровождение.

---

### 17. Аэропортные трансферы / VIP Meet & Greet ★★★☆☆ — Prospect

Workflow:
- Дата/рейс → кол-во пассажиров → тип авто
- Предоплата через QR
- Авторемайндер водителю и клиенту за 2 ч
- Follow-up для следующей поездки

Простая воронка, высокий объём, но низкий LTV. Имеет смысл как дополнение к другой вертикали (например, к Rental или Wedding).

---

### 18. Морские прогулки / Boat Tours ★★★☆☆ — Prospect

Workflow:
- Квалификация: даты, маршрут (Phi Phi / James Bond Island / закат), группа, бюджет
- RAG по доступным турам и ценам
- Safety waiver
- Оплата депозита через QR
- Авторемайндер за день

---

### 19. Private Chef / Кейтеринг на виллах ★★★☆☆ — Prospect

Workflow:
- Кол-во гостей, диетические ограничения, кухня, бюджет на ужин
- RAG по меню шефов с ценами
- Оплата депозита через QR
- Recurring: авто-предложение на следующий вечер
- Upsell: завтрак → обед → полный день

---

### 20. Condo-for-Visa ★★★☆☆ — Prospect

Покупка кондо от 3 млн бат для получения Thailand Privilege / LTR Visa.

Комбинирует вертикали **Real Estate** + **Visa & Immigration**. Высокий LTV, но низкий объём запросов. Имеет смысл как специализация для агентов, работающих с обеими темами одновременно.

---

## Приоритет освоения новых вертикалей

**Реализовано (9/20):** exchange · recruitment · concierge · modeling · real_estate · saas · video · visa · scooter

**Следующие в очереди (Prospect → Implemented):**

1. **Медицинский туризм / Стоматология** — высокий объём + vision + OCR = максимальный технический дифференциатор
2. **Expat Health Insurance** — высокий LTV, NEPQ-perfect, рынок не автоматизирован
3. **Дайвинг / PADI** — специфика Таиланда, медопросник = сильный дифференциатор
4. **Свадьбы** — долгий цикл = высокий LTV, но дольше закрывается
5. **Регистрация компании** — нишевой, но высокий LTV + recurring

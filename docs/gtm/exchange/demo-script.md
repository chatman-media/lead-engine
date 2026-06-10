# Exchange demo script

Цель: показать не “бот отвечает в Telegram”, а операционный контур обменника:
курс берётся из approved rate-card, заявка живёт в CRM, реквизиты и выдача
контролируются стадиями, а оператор включается только в точках риска.

Длительность: 15-20 минут.

## Before the call

Поднять демо-тенант:

```sh
DATABASE_URL=postgres://lead:lead@localhost:5434/lead_engine \
PLATFORM_MASTER_KEY=<64hex> \
bun run --cwd apps/api seed:exchange-demo
```

Для simulator/rehearsal нужен tenant-scoped chat LLM key. Его можно зашить в
tenant secrets при seed:

```sh
EXCHANGE_DEMO_LLM_PROVIDER=openrouter \
EXCHANGE_DEMO_LLM_MODEL=openai/gpt-4o-mini \
EXCHANGE_DEMO_LLM_API_KEY=<key> \
DATABASE_URL=postgres://lead:lead@localhost:5434/lead_engine \
PLATFORM_MASTER_KEY=<64hex> \
bun run --cwd apps/api seed:exchange-demo
```

Для OpenAI вместо этого:

```sh
EXCHANGE_DEMO_LLM_PROVIDER=openai \
EXCHANGE_DEMO_LLM_MODEL=gpt-4o-mini \
EXCHANGE_DEMO_LLM_API_KEY=<key> \
DATABASE_URL=postgres://lead:lead@localhost:5434/lead_engine \
PLATFORM_MASTER_KEY=<64hex> \
bun run --cwd apps/api seed:exchange-demo
```

Если показываем живой Telegram:

```sh
EXCHANGE_DEMO_TELEGRAM_BOT_TOKEN=123:ABC... \
EXCHANGE_DEMO_TELEGRAM_BOT_USERNAME=my_demo_bot \
PLATFORM_PUBLIC_URL=https://api.example.com \
TELEGRAM_WEBHOOK_SECRET=<secret> \
DATABASE_URL=postgres://lead:lead@localhost:5434/lead_engine \
PLATFORM_MASTER_KEY=<64hex> \
bun run --cwd apps/api seed:exchange-demo -- --set-telegram-webhook
```

Проверить кабинет:

- login: `owner@exchange.demo`
- password: значение `EXCHANGE_DEMO_PASSWORD`, по умолчанию `test1234`
- открыть `/conversations`, `/exchange`, `/dashboard`, lead detail с блоком
  “Отправить QR / фото клиенту”.

Прогнать simulator два раза:

```sh
EXCHANGE_DEMO_PASSWORD=<password> \
bun run --cwd apps/api rehearse:exchange-demo -- --runs=2
```

Runner логинится в API и дважды вызывает `/api/admin/sim/exchange-eval` для
golden-path персон: RUB, USDT, cardless ATM, Thai bank payout. Он должен вернуть
`passed/total` без провалов. KYC и операторские фоллбеки показываются руками на
seeded conversations, потому что там важно увидеть human-in-the-loop, а не
только автооценку.

Если runner возвращает `chat LLM not configured`, пересеять tenant с
`EXCHANGE_DEMO_LLM_API_KEY` и перезапустить `apps/api`, чтобы router перечитал
секреты.

## Opening

Фраза:

> Здесь не автоответчик. Бот только интерфейс. Внутри у обменника есть rate-card,
> стадии, поля, заявки, платежные реквизиты, проверка риска, операторский
> handoff и база знаний. Клиент пишет как обычно, но деньги больше не тонут в
> переписке.

Сразу открыть `/exchange` и показать:

- активные курсы и approved tiers;
- заявки по статусам `awaiting_payment`, `paid`, `payout`, `completed`;
- seeded заявки: KYC, реквизиты отправлены, proof waiting, completed.

## Beat 1 - Golden Path: RUB -> THB through QR/SBP

Client message:

```text
Хочу получить 50 000 бат. Оплачу рублями через СБП/QR. Сколько нужно перевести?
```

What to show:

- bot asks for missing payout method if needed;
- bot computes quote from approved RUB rate, not from free text;
- lead card gets amount, source asset, payout method;
- exchange order appears in `/exchange`.

Say:

> Ключевой момент: он не “примерно отвечает курс”. Он создаёт денежную заявку.
> Дальше любой шаг привязан к статусу заявки.

Next client messages:

```text
Подтверждаю. Получение через банкомат без карты.
```

```text
Оплатил, вот чек.
```

Operator action:

- in `/exchange`, mark payment as paid or open order and verify proof;
- issue payout code with method `cardless_atm`;
- show that payout code is delivered through the channel without reopening the
  whole dialog manually.

Close the beat:

> Менеджер не ведёт весь чат. Он подтверждает только рискованный факт:
> деньги пришли, можно выдавать THB.

## Beat 2 - Second Path: USDT TRC20 -> Office Cash

Client message:

```text
Поменяйте 1000 USDT TRC20 на баты. Заберу наличными в Phuket Central.
```

What to show:

- quote uses USDT TRC20 rate/tier;
- network and office pickup are structured fields, not buried in chat text;
- requisites are issued only after order creation;
- order route differs from RUB: wallet/crypto proof instead of QR/SBP.

Use seeded conversation “Елена Ким” if live bot is slow:

- stage `requisites_sent`;
- order `USDT->THB`;
- payout location `phuket_central`;
- wallet requisites in `requisites_json`.

Say:

> Один интерфейс, но разные rails: RUB QR, card transfer, USDT TRC20, Binance ID,
> office cash, cardless ATM, Thai bank transfer. Это workflow engine, не один
> Telegram script.

## Beat 3 - KYC Gate

Client message:

```text
Нужно 180 000 бат, рублями с карты. Могу сейчас оплатить?
```

Expected behavior:

- bot does not issue requisites immediately;
- it asks for document/video verification;
- operator sees that the customer must be verified;
- conversation can be taken over, then returned to AI.

Open seeded conversation “Андрей Морозов”:

- stage `kyc_collection`;
- conversation mode `human`;
- order risk `manual`;
- message from operator: “Проверяю данные и после подтверждения выдам реквизиты.”

Say:

> Большие суммы и документы не должны проверяться в голове менеджера по памяти.
> Система сама ставит барьер: сначала KYC, потом реквизиты.

## Beat 4 - Rate Guardrail

Client message:

```text
У другого обменника 1 USDT = 40 бат. Дайте такой курс, я сразу переведу.
```

Expected behavior:

- bot refuses to invent or manually promise a better rate;
- it quotes only approved rate-card or says operator can approve exception;
- no requisites are issued before a valid quote/order state.

Open `/exchange` rate-card and show:

- current approved display rates;
- tiers;
- stale/guardrail signals if present.

Say:

> Продажная ценность тут не в том, что AI красиво разговаривает. Он не может
> самовольно продать курс, которого нет в approved таблице.

## Beat 5 - Operator Takeover and Return to AI

Open `/conversations` on any active exchange dialog.

Actions:

- switch mode to operator/human;
- send one operator message;
- return mode to AI;
- show audit event if available.

Talk track:

> Оператор не живёт в каждом чате. Он входит на один decision point: KYC,
> спорный чек, нестандартный курс, QR, бронь наличных в офисе. Потом AI снова
> ведёт клиента по workflow.

## Beat 6 - QR / Photo Without Taking Over

Open a lead detail page with active channel identity and use “Отправить QR /
фото клиенту”.

Input:

```text
https://mock.local/sbp/qr-demo.png
```

Caption:

```text
QR для оплаты заявки. После оплаты отправьте чек сюда.
```

Expected behavior:

- platform sends photo into the customer channel;
- conversation gets assistant-side message context;
- operator does not need to take over the whole chat.

Say:

> Это важный pattern для обменки: оператор может отправить QR или cardless
> withdrawal картинку как действие системы, не превращая весь чат в ручной.

## Beat 7 - Orders CRM and Dashboard

Open `/exchange`, then `/dashboard`.

Show:

- open orders;
- paid/payout/completed statuses;
- completed seeded order “Наталья Орлова”;
- “closed by bot” / automation signal if dashboard build exposes it.

Closing line:

> После демо клиент должен запомнить не “бот ответил 24/7”, а “каждый входящий
> обмен стал заявкой с курсом, статусом, риском, реквизитами и точкой решения
> оператора”.

## Rehearsal checklist

- [ ] `seed:exchange-demo` completed and readiness counts are non-zero.
- [ ] `/api/admin/diagnostics` is green for channel, chat LLM and KB.
- [ ] `rehearse:exchange-demo -- --runs=2` passed.
- [ ] RUB QR/SBP path rehearsed once from a fresh dialog.
- [ ] USDT TRC20 office path rehearsed once.
- [ ] KYC seeded conversation opened and operator handoff explained.
- [ ] Rate guardrail objection rehearsed.
- [ ] Operator takeover and return to AI clicked once.
- [ ] QR/photo send action tested or clearly marked as channel-dependent.
- [ ] Orders CRM and dashboard closing screen ready.

## Follow-up if a run fails

Use the failed persona id from `rehearse:exchange-demo`:

- if no quote: inspect rates and chat LLM config;
- if no requisites: inspect order stage and tenant secrets/requisites;
- if premature operator: add a case to the exchange self-play corpus and adjust
  prompt/tool policy;
- if KYC/proof path is unclear: turn it into a QA case under #484/#487.

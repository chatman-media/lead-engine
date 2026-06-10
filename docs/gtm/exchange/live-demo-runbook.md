# Exchange live demo runbook

Purpose: close the final manual loop for #495: run two live demos with real
exchange owners, record the outcome, and move each qualified prospect into the
alpha trial path.

This is not a product QA checklist. Technical readiness is already covered by
the exchange demo script, fixture seed, rehearsal runner, and completed QA epic
#483. This file is the operating checklist for the sales call itself.

## Done definition

Close #495 only when both rows in this table have a real outcome.

| Slot | Customer | Scheduled | Demo done | Outcome | Next step | Owner |
|---|---|---:|---:|---|---|---|
| Demo 1 | TBD | TBD | No | TBD | trial_tenant / decision_date / no_fit | Lead Engine |
| Demo 2 | TBD | TBD | No | TBD | trial_tenant / decision_date / no_fit | Lead Engine |

Allowed outcomes:

- `trial_tenant`: customer wants same-day alpha setup.
- `decision_date`: customer needs a decision call or internal approval.
- `no_fit`: customer is not a fit; write the reason.

## Inputs needed before scheduling

For each customer, capture this before offering a demo slot:

| Field | Why it matters |
|---|---|
| Owner/operator name | Address the real decision maker, not a generic shop. |
| Telegram handle or contact channel | Send invite/follow-up without losing context. |
| Main rails | RUB, USDT, Binance ID, Thai bank, cash, office, ATM. |
| Main pain | Missed chats, manual rates, proof review, KYC, operator load. |
| Current volume | Approximate daily orders or inbound chats. |
| Preferred demo angle | Golden path, KYC/risk, operator handoff, or trial setup. |
| Trial readiness | Bot token, BYOK key, rates, requisites, office/ATM rules. |

Do not schedule a “generic AI bot” call. The hook is exchange workflow control:
rate-card, order status, proof, KYC, payout, and operator decisions.

## Scheduling message

```text
Привет. У нас готов живой демо-контур Lead Engine для обменника: клиент пишет в
Telegram, система собирает направление/сумму, считает quote из approved
rate-card, создаёт заявку, ведёт KYC/proof и отдаёт оператору только рискованные
точки.

Хочу показать 15-20 минут на вашем типовом сценарии: RUB/USDT, реквизиты,
проверка оплаты, выдача и handoff оператору.

Удобно сегодня/завтра на 20 минут? Если после демо будет интерес, в тот же день
можем поднять alpha tenant на ваших курсах и реквизитах.
```

## T-30 minutes checklist

Run this before every customer call.

1. Open the customer-specific notes and choose the primary demo angle.
2. Open `docs/gtm/exchange/demo-script.md`.
3. Open `docs/gtm/exchange/screen-sequence.md`.
4. Open `docs/gtm/exchange/trial-flow.md`.
5. Confirm the demo tenant is seeded and login works:

```sh
bun db:up

DATABASE_URL=postgres://lead:lead@localhost:5434/lead_engine \
PLATFORM_MASTER_KEY=<64hex> \
bun run --cwd apps/api seed:exchange-demo
```

6. Start API/UI if using a local screen-share environment:

```sh
DATABASE_URL=postgres://lead:lead@localhost:5434/lead_engine \
PLATFORM_MASTER_KEY=<64hex> \
bun run dev

bun run dev:ui
```

If using a deployed stand instead, verify the exact admin URL and API base from
`AGENTS.md` / `docs/operations/CD_SETUP.md` before the call.

7. Run the rehearsal runner against the active API:

```sh
EXCHANGE_DEMO_PASSWORD=<password> \
bun run --cwd apps/api rehearse:exchange-demo -- --runs=2
```

8. Prepare browser tabs:
   - Admin UI: `/conversations`
   - Admin UI: `/exchange`
   - Admin UI: `/dashboard`
   - Public demo: `/demo/workflows/exchange`
   - Public demo scenario: `/demo/workflows/exchange/kyc-review`
   - One-pager: `docs/gtm/exchange/one-pager.md`
   - Trial flow: `docs/gtm/exchange/trial-flow.md`

9. Prepare the live customer messages from `demo-script.md`:
   - RUB -> THB through QR/SBP.
   - USDT TRC20 -> office cash.
   - Large amount -> KYC gate.
   - Better-rate demand -> guardrail.
   - Receipt/photo -> operator proof review.

10. Decide the fallback if live Telegram is slow:
    - Use seeded conversations and orders.
    - Use public workflow demo tags.
    - Do not debug infrastructure during the customer call.

## Call structure

### 0-2 minutes: frame

Say:

```text
Это не демо чат-бота. Я покажу денежный workflow обменника: курс из approved
таблицы, заявка, реквизиты, proof, KYC, выдача и операторские решения.
```

Ask one qualifier:

```text
Что у вас сейчас больше болит: входящие теряются, курс/реквизиты вручную,
проверка чеков, KYC или нагрузка на операторов?
```

Use the answer to choose which beat gets the most time.

### 2-7 minutes: golden path

Show RUB -> THB or USDT -> THB from `demo-script.md`.

Must show:

- AI asks for missing fields instead of guessing.
- Quote comes from approved rate-card.
- An exchange order exists outside the chat.
- Requisites appear only after the right state.

Do not over-explain the UI. Keep the owner focused on money state.

### 7-12 minutes: risk path

Show one risk branch:

- KYC for a large amount.
- Receipt/photo proof review.
- Better-rate request blocked by guardrails.
- Operator takeover and return to AI.

Say:

```text
Оператор нужен не в каждом чате, а в decision point: подтвердить оплату,
проверить документ, утвердить нестандартный курс или выдать наличные.
```

### 12-16 minutes: owner controls

Show:

- where rates/tier data live;
- where orders live;
- where operator work appears;
- where trial setup starts if the customer says yes.

Tie every screen to one owner question: “Где деньги?”, “Что ждёт оператора?”,
“Какой следующий шаг?”, “Где риск?”.

### 16-20 minutes: close

Ask directly:

```text
Хотите проверить это на ваших курсах и реквизитах в alpha trial на 1 день?
```

If yes, switch to `trial-flow.md` and collect:

- owner email for invite;
- Telegram bot token readiness;
- BYOK provider preference;
- one real rate;
- one real requisite;
- one operator/risk rule;
- preferred alpha slot.

If not yes, ask for a decision date:

```text
Что должно быть понятно, чтобы принять решение? Когда вернуться с этим вопросом?
```

## Outcome comment template for #495

Add one comment per live demo.

```md
## Live demo outcome - <customer name>

- Date/time:
- Attendees:
- Customer segment:
- Main rails:
- Main pain:
- Demo path shown:
- Rehearsal status before call:
- Customer reaction:
- Outcome: trial_tenant / decision_date / no_fit
- Next step:
- Owner:
- Follow-up sent: yes/no

Notes:
- ...
```

After the second outcome is recorded:

1. If both demos have outcomes, move #495 to `Done`.
2. Close #495 as completed.
3. If either customer wants alpha, create or reuse the operational follow-up
   item for the trial setup. Do not keep #495 open for implementation work that
   belongs to the alpha trial.

## Follow-up messages

### Trial tenant

```text
Спасибо за демо. Следующий шаг: alpha tenant на ваших курсах и реквизитах.

Нужно подготовить:
1. email владельца/оператора для invite;
2. Telegram bot token из @BotFather;
3. OpenRouter/OpenAI BYOK key с лимитом бюджета;
4. один RUB/USDT курс и правила tier/округления;
5. один реквизит для теста;
6. KYC/операторское правило для крупной суммы или спорного proof.

Дальше за 60 минут доводим до первого живого ответа бота.
```

### Decision date

```text
Спасибо за демо. Зафиксировал главный вопрос: <question>.

Коротко: Lead Engine закрывает не автоответы, а workflow обменника: quote,
order, requisites, proof, KYC, payout и operator handoff. Ниже отправляю
one-pager и порядок экранов.

Вернусь <date> с ответом/следующим шагом.
```

### No fit

```text
Спасибо за время. Похоже, сейчас не лучший момент: <reason>.

Оставлю короткий one-pager. Если появится боль по входящим, proof/KYC или
операторской нагрузке, можно вернуться к alpha trial.
```

## What not to do

- Do not promise that AI verifies payment or KYC automatically.
- Do not promise arbitrary better rates.
- Do not show raw secrets, channel tokens, LLM keys, or real customer data.
- Do not debug broken local infra during the call.
- Do not close #495 until two real customer outcomes are recorded.

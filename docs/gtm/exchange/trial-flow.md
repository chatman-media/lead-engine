# Exchange alpha trial flow

Цель: если владелец обменника сказал "да" на демо, в тот же день довести его
до tenant-а, подключенного канала, BYOK-ключа, курсов, реквизитов и первого
живого ответа бота. Не через неделю, не "пришлите нам потом данные".

Целевой SLA: новый tenant с нуля до отвечающего бота за 60 минут. Минимальный
setup, который клиент может пройти сам по этому чек-листу: 15 минут, если все
данные подготовлены заранее.

## Решение по alpha terms

Для первых exchange alpha используем **ручной free-period через superadmin**.

- Superadmin approve создаёт `starter` tenant, `active` status, BYOK billing и
  invite link на создание пароля.
- Клиент не вводит карту на первом alpha-дне.
- Срок alpha фиксируем операционно: 14 календарных дней от выдачи invite.
- За 2 дня до конца принимаем решение: Stripe checkout, продление вручную,
  downgrade/cancel через superadmin.

Stripe 14-day trial уже есть как normal self-service billing path, но для
пост-демо alpha он хуже: карта, Stripe availability и billing friction могут
сорвать запуск "сегодня". Поэтому alpha default — ручной старт, Stripe — после
подтверждения ценности.

## Кто что делает

Lead Engine owner:

- approves early-access request в superadmin;
- отправляет invite link клиенту;
- остаётся на созвоне первые 60 минут;
- проверяет `/diagnostics`, `/conversations`, `/exchange` и operator handoff;
- ставит reminder на конец 14-day alpha.

Клиент:

- принимает invite и задаёт пароль;
- создаёт/даёт Telegram bot token;
- создаёт BYOK LLM key;
- вводит курсы, реквизиты, офисы, способы выдачи и KYC правила;
- сам отправляет тестовые сообщения боту.

Оператор обменника:

- подтверждает proof оплаты;
- проверяет KYC;
- утверждает нестандартный курс;
- проверяет, что handoff понятен без разработчика рядом.

## До созвона: собрать за 15 минут

Попросить клиента подготовить это заранее. Без этих данных trial превращается в
"давайте завтра".

| Блок | Что нужно | Кто вводит |
|---|---|---|
| Доступ | Email владельца или оператора для invite | Lead Engine |
| Канал | Telegram bot token из `@BotFather` | Клиент |
| LLM | OpenRouter/OpenAI key с лимитом бюджета | Клиент |
| Курсы | RUB->THB, USDT->THB, min/max tiers, правило округления | Клиент + Lead Engine |
| Реквизиты | RUB карта/СБП/QR, USDT wallet, Binance/Bybit UID, если есть | Клиент |
| Выдача | Office cash, cardless ATM, Thai bank, courier, адреса офисов | Клиент |
| Риски | KYC threshold, AML policy, когда нужен оператор | Клиент |
| FAQ | Часы работы, комиссии, сроки, что делать с ошибочной оплатой | Клиент |
| Тесты | 3-5 реальных сценариев из последней недели | Клиент |

Минимум для старта: bot token, chat LLM key, один active rate, один реквизит.
Без KB и business data onboarding откроет кабинет, но качество ответов будет
хуже, поэтому для обменника лучше заполнить хотя бы офисы, выдачу и KYC.

## Invite-flow глазами клиента

Public signup закрыт. Клиент не ищет `/signup`.

1. Клиент оставляет early access request или мы заводим request вручную.
2. Superadmin открывает `/superadmin`, нажимает `Approve`.
3. Система создаёт tenant и invite link вида `/accept-invite?token=...`.
4. Superadmin копирует link и отправляет клиенту.
5. Клиент открывает link, задаёт пароль, нажимает "Принять и войти".
6. После входа `OnboardingGate` ведёт клиента в `/onboarding`.
7. Пока mandatory setup не готов, кабинет закрыт и возвращает в wizard.

Проверка: если клиент видит login без onboarding, значит invite уже принят или
он вошёл старым аккаунтом. Если видит `signup_disabled`, значит ему дали не
invite link.

## Чистый путь exchange wizard

Путь для alpha обменника:

1. **Бизнес**: выбрать готовую вертикаль `Exchange`.
2. **Канал**: для alpha выбирать `Telegram-бот`, не личный аккаунт. Личный
   userbot требует MTProto API ID/API Hash и чаще стопорит нетехнического
   владельца.
3. **LLM**: настроить `Chat` через BYOK. Для первого дня достаточно chat; vision
   включаем, если сразу тестируем чеки/документы; embeddings включаем, если
   загружаем KB.
4. **Курсы**: получить рынок, поправить display rates и tiers, сохранить.
   Rate-card заводит Lead Engine вместе с клиентом, потому что это денежное
   правило, а не текстовая настройка.
5. **Реквизиты**: добавить минимум один real payment rail. Для чистого demo:
   RUB card/QR и USDT TRC20 wallet.
6. **База знаний**: загрузить хотя бы короткий FAQ: офисы, банкоматы, сроки,
   комиссии, KYC.
7. **Данные**: оператор, часы работы, адрес офиса, методы выдачи.
8. **Готово**: открыть dashboard, затем `/conversations` и `/exchange`.

Что нельзя пропускать на alpha: live bot token, real BYOK key, approved rate,
хотя бы один реквизит, хотя бы один операторский handoff scenario.

## BYOK для владельца обменника

Не просим клиента присылать ключ в Telegram. Он сам вставляет key в кабинет.

### OpenRouter, самый простой alpha path

1. Открыть `https://openrouter.ai`.
2. Зарегистрироваться и добавить оплату/кредит.
3. Открыть `Keys`.
4. Нажать `Create key`.
5. Поставить лимит на trial: например $10-20.
6. Скопировать ключ один раз. Формат обычно начинается с `sk-or-v1-`.
7. В Lead Engine открыть step `LLM`.
8. В `Chat` выбрать `OpenRouter`.
9. В модель поставить `google/gemini-2.5-flash` или модель, согласованную на
   демо.
10. Вставить API key и сохранить.

Для vision можно использовать тот же OpenRouter key, но выбрать vision-capable
model. Для embeddings лучше заводить отдельный purpose только когда реально
загружаем KB.

### OpenAI alternative

1. Открыть `https://platform.openai.com/api-keys`.
2. Создать project key.
3. Поставить usage limit в billing.
4. В Lead Engine выбрать `OpenAI`.
5. Для `Chat` использовать `gpt-4o-mini`.
6. Для `Embeddings` использовать `text-embedding-3-small`, dimension `1536`.
7. Для `Vision` использовать `gpt-4o`, если тестируем документы/чеки.

Security rules:

- separate key only for Lead Engine alpha;
- budget limit обязателен;
- не отправлять key в чатах;
- после alpha можно rotate/revoke key у провайдера;
- в Lead Engine показывается только `hasSecret`, сам ключ не раскрывается.

## 60-minute dry run

0-5 минут:

- открыть invite link;
- задать пароль;
- попасть в `/onboarding`;
- подтвердить, что public signup не нужен.

5-15 минут:

- выбрать `Exchange`;
- создать Telegram bot в `@BotFather`;
- вставить token;
- настроить chat LLM через OpenRouter/OpenAI.

15-30 минут:

- открыть `Курсы`;
- получить рынок;
- согласовать display rate и tiers;
- сохранить rate-card.

30-40 минут:

- добавить RUB payment rail;
- добавить USDT TRC20 wallet или Binance/Bybit UID;
- добавить operator contact.

40-50 минут:

- загрузить короткий FAQ по офисам, выдаче, комиссиям и KYC;
- заполнить часы работы и офис;
- открыть dashboard.

50-60 минут:

- клиент сам пишет в Telegram bot;
- оператор смотрит `/conversations` и `/exchange`;
- проверяем, что handoff понятен и order создаётся.

## Acceptance scenarios

Прогнать минимум эти сценарии:

1. `Хочу получить 50 000 бат, оплачу рублями через СБП/QR`.
   - Bot собирает недостающие поля.
   - Quote берётся из approved rate-card.
   - В `/exchange` создаётся order.

2. `Поменяйте 1000 USDT TRC20 на баты, заберу в офисе`.
   - Network и payout location становятся структурными полями.
   - Wallet/requisite выдаётся только после валидного order state.

3. `Нужно 180 000 бат, могу сейчас оплатить?`.
   - Включается KYC/handoff.
   - Оператор видит, что надо верифицировать клиента до реквизитов.

4. `Вот чек` с фото или документом.
   - Proof привязан к заявке.
   - Оператор видит action: проверить оплату/документ.

5. `У другого обменника курс лучше, дайте 1 USDT = 40 THB`.
   - Bot не обещает неутверждённый курс.
   - Если нужна скидка, сценарий уходит оператору.

Done: владелец обменника сам понимает, где меняются курсы, где заявки, где
оператор подтверждает риск и как бот отвечает клиенту.

## Если что-то ломается

| Симптом | Что проверить |
|---|---|
| Клиент попал на `/login`, а пароля нет | Он не открыл invite link или invite уже used |
| Видит `signup_disabled` | Ему дали signup path, нужен `/accept-invite?...` |
| Telegram token rejected | Скопирован не token из `@BotFather`, есть пробелы или bot удалён |
| Chat LLM не сохраняется | Нет API key, неверный provider/model, исчерпан budget |
| Кабинет не открывается | Onboarding mandatory: канал + chat LLM + exchange rate + requisite |
| Bot отвечает, но плохо | Нет KB/business data или слишком пустые KYC/office/payment rules |
| Реквизиты не выдаются | Нет requisite или сценарий ушёл в risk/handoff |
| Курс не тот | Проверить approved tiers в `/exchange`, не prompt |


import { useState } from "react";
import {
  DEMO_URL,
  Footer,
  type Lang,
  Nav,
  SIGNUP_URL,
  TelegramMockup,
  type TgMessage,
} from "./shared.tsx";

type L = { ru: string; en: string };
const t = (value: L, lang: Lang) => value[lang];

const COPY = {
  ru: {
    bannerTag: "Exchange workflow demo",
    banner:
      "Отдельная демо-страница по exchange_v1: котировка, KYC/risk, TTL-реквизиты, proof и payout.",
    title: ["Exchange desk, где деньги проходят через ", "workflow, а не переписку"],
    sub: "Клиент пишет как в обычный Telegram: рубли, USDT, наличные, банкомат, курьер, срочно, две операции подряд. Lead Engine превращает это в денежную заявку с quote snapshot, статусами, инструментами и handoff оператору только там, где нужен человек.",
    ctaPrimary: "Собрать exchange workflow",
    ctaSecondary: "Обсудить в Telegram",
    kpiLabel: "Live money desk",
    opsTitle: "Операционный слой обменника",
    opsSub:
      "В демо видно два слоя сразу: бизнес-воронка клиента и технический статус exchange order. Это не чат с курсом, а контроль денег от первого сообщения до выдачи.",
    casesLabel: "Сценарии из workflow-документов",
    casesTitle: "Реальные exchange-ветки, которые ломают обычного бота",
    casesSub:
      "Сценарии взяты из описанных exchange workflows: RUB/QR/KYC, USDT TRC20, cardless ATM, курьер, частичная выдача и две операции подряд.",
    stageLabel: "Stage machine",
    stageTitle: "Воронка не прячет деньги внутри диалога",
    stageSub:
      "Каждый шаг имеет поля, action/tool и понятный статус для менеджера. LLM ведёт разговор, но курс, реквизиты, проверка и payout живут в deterministic tools.",
    toolsLabel: "Money tools",
    toolsTitle: "Модель не считает деньги и не выдумывает реквизиты",
    toolsSub:
      "Все критичные действия идут через сервисный слой: quote, order, requisites, payment verification, payout. Оператор видит, что было показано клиенту, когда истекает TTL и где нужен ручной контроль.",
    handoffLabel: "Human-in-the-loop",
    handoffTitle: "Оператор получает исключение, а не всю кашу из чата",
    handoffSub:
      "Крупная сумма, KYC, mismatch в чеке, риск, QR/код банкомата или частичная выдача попадают в короткую handoff-карточку. После решения AI продолжает сделку.",
    dialogLabel: "Telegram side",
    dialogTitle: "Клиенту это выглядит как нормальный диалог",
    dialogSub:
      "Внутри уже созданы order, quote snapshot, TTL-реквизиты и задачи оператору. Клиент не видит сложность системы.",
    ctaTitle: "Такой exchange demo продаёт продукт, а не идею бота",
    ctaSub:
      "Покажи владельцу обменника: где деньги, где риск, кто держит следующий шаг, какой курс был зафиксирован и почему менеджер больше не теряет заявки в переписках.",
    notify: "Operator handoff: KYC approved, issue payout code",
    ctaBubble: "Открыть exchange order →",
    footer: {
      privacy: "Политика конфиденциальности",
      terms: "Условия использования",
      copy: "© 2026 Lead Engine",
    },
  },
  en: {
    bannerTag: "Exchange workflow demo",
    banner: "A dedicated exchange_v1 demo: quote, KYC/risk, TTL requisites, proof and payout.",
    title: ["An exchange desk where money moves through ", "workflow, not chat"],
    sub: "The client writes naturally in Telegram: RUB, USDT, cash, ATM, courier, urgent, two operations in a row. Lead Engine turns it into a money order with a quote snapshot, statuses, tools and operator handoff only where judgment is needed.",
    ctaPrimary: "Build exchange workflow",
    ctaSecondary: "Discuss in Telegram",
    kpiLabel: "Live money desk",
    opsTitle: "Exchange operations layer",
    opsSub:
      "The demo shows two layers at once: the customer funnel and the technical exchange order status. It is not a rate chatbot; it controls money from first message to payout.",
    casesLabel: "Workflow document scenarios",
    casesTitle: "Real exchange branches that break a regular bot",
    casesSub:
      "Scenarios are based on the exchange workflows: RUB/QR/KYC, USDT TRC20, cardless ATM, courier, partial payout and two operations in a row.",
    stageLabel: "Stage machine",
    stageTitle: "The funnel does not hide money inside the conversation",
    stageSub:
      "Every step has fields, an action/tool and a clear manager status. The LLM drives the conversation, but rate, requisites, verification and payout live in deterministic tools.",
    toolsLabel: "Money tools",
    toolsTitle: "The model does not calculate money or invent requisites",
    toolsSub:
      "Critical actions go through a service layer: quote, order, requisites, payment verification, payout. The operator sees what was shown to the client, when TTL expires and where manual control is required.",
    handoffLabel: "Human-in-the-loop",
    handoffTitle: "The operator receives an exception, not the whole chat",
    handoffSub:
      "Large amount, KYC, receipt mismatch, risk, ATM QR/code or partial payout become a compact handoff card. After the decision, AI continues the order.",
    dialogLabel: "Telegram side",
    dialogTitle: "For the client it still feels like a normal dialog",
    dialogSub:
      "Inside, the system already created the order, quote snapshot, TTL requisites and operator tasks. The client does not see the system complexity.",
    ctaTitle: "This exchange demo sells the product, not a chatbot idea",
    ctaSub:
      "Show an exchange owner where the money is, where risk sits, who owns the next step, which rate was locked and why managers stop losing requests in chats.",
    notify: "Operator handoff: KYC approved, issue payout code",
    ctaBubble: "Open exchange order →",
    footer: {
      privacy: "Privacy Policy",
      terms: "Terms of Use",
      copy: "© 2026 Lead Engine",
    },
  },
};

type ExchangeWorkflowScenarioKey =
  | "rub-office-pickup"
  | "usdt-bank-transfer"
  | "kyc-review"
  | "payment-proof"
  | "rate-change"
  | "operator-handoff";

type ExchangeWorkflowScenario = {
  key: ExchangeWorkflowScenarioKey;
  corpusId: string;
  fixture: string;
  tag: L;
  title: L;
  summary: L;
  result: L;
  tone: "blue" | "green" | "amber";
  fields: string[];
  stages: string[];
  orderRows: { label: L; value: string }[];
  handoffs: string[];
  toolEvents: { tool: string; status: string; desc: L }[];
  boardTags: string[];
  messages: Record<Lang, TgMessage[]>;
};

const EXCHANGE_WORKFLOW_SCENARIOS: ExchangeWorkflowScenario[] = [
  {
    key: "rub-office-pickup",
    corpusId: "rub-office-pickup-payment-proof",
    fixture: "rub-qr-atm-first-time-faq",
    tag: { ru: "RUB -> office pickup", en: "RUB -> office pickup" },
    title: {
      ru: "RUB -> THB: оплата рублями и выдача в офисе",
      en: "RUB -> THB: bank payment and office pickup",
    },
    summary: {
      ru: "Клиент платит со Сбера, выбирает Bangkok Asok и присылает чек. AI не подтверждает оплату сам: создаёт payment_review и office_payout handoff.",
      en: "The client pays from Sber, chooses Bangkok Asok and sends a receipt. AI does not confirm payment itself: it creates payment_review and office_payout handoffs.",
    },
    result: {
      ru: "Стадии, поля, order status и handoff совпадают с live-eval corpus.",
      en: "Stages, fields, order status and handoff match the live-eval corpus.",
    },
    tone: "amber",
    fields: [
      "asset=RUB",
      "amount_from=100000",
      "payment_rail=sber",
      "payout_method=office_cash",
      "payout_location=Bangkok Asok",
      "pickup_window=15:00-16:00",
      "payment_proof",
    ],
    stages: [
      "exchange_request",
      "quote_calculated",
      "order_created",
      "requisites_sent",
      "payment_proof_waiting",
      "payment_review",
      "payout",
    ],
    orderRows: [
      {
        label: { ru: "scenario", en: "scenario" },
        value: "rub-office-pickup-payment-proof",
      },
      { label: { ru: "status", en: "status" }, value: "payout" },
      {
        label: { ru: "payment", en: "payment" },
        value: "bank_transfer / sber",
      },
      { label: { ru: "payout", en: "payout" }, value: "office_cash" },
      { label: { ru: "location", en: "location" }, value: "Bangkok Asok" },
    ],
    handoffs: ["payment_review", "office_payout"],
    toolEvents: [
      {
        tool: "compute_quote",
        status: "ok",
        desc: { ru: "quote snapshot created", en: "quote snapshot created" },
      },
      {
        tool: "fetch_requisites",
        status: "TTL",
        desc: {
          ru: "Sber/card route selected",
          en: "Sber/card route selected",
        },
      },
      {
        tool: "payment_proof",
        status: "review",
        desc: {
          ru: "receipt waits for operator",
          en: "receipt waits for operator",
        },
      },
      {
        tool: "operator_handoff",
        status: "2 tasks",
        desc: { ru: "payment + office payout", en: "payment + office payout" },
      },
    ],
    boardTags: ["quote", "receipt", "payout"],
    messages: {
      ru: [
        {
          from: "user",
          text: "Хочу поменять 100000 рублей на баты, оплатить со Сбера.",
        },
        {
          from: "bot",
          text: "Принял RUB -> THB. Считаю курс и подготовлю реквизиты только после подтверждения условий.",
        },
        {
          from: "user",
          text: "Получение хочу в офисе Bangkok Asok сегодня с 15:00 до 16:00.",
        },
        {
          from: "bot",
          text: "Офис Bangkok Asok и окно 15:00-16:00 записал. Курс подходит, выдам реквизиты с TTL.",
        },
        { from: "user", text: "[PHOTO: payment receipt]" },
        {
          from: "bot",
          text: "Чек получил, передаю оператору на проверку. Выдача в офисе будет только после payment review.",
          cta: true,
        },
      ],
      en: [
        {
          from: "user",
          text: "I want to exchange 100,000 RUB to baht, paying from Sber.",
        },
        {
          from: "bot",
          text: "Got RUB -> THB. I will calculate the quote and issue requisites only after terms are confirmed.",
        },
        {
          from: "user",
          text: "Pickup at Bangkok Asok office today from 15:00 to 16:00.",
        },
        {
          from: "bot",
          text: "Bangkok Asok and 15:00-16:00 are recorded. If the rate works, I will issue TTL requisites.",
        },
        { from: "user", text: "[PHOTO: payment receipt]" },
        {
          from: "bot",
          text: "Receipt received. I am sending it to operator review. Office payout happens only after payment review.",
          cta: true,
        },
      ],
    },
  },
  {
    key: "usdt-bank-transfer",
    corpusId: "usdt-to-thai-bank-transfer",
    fixture: "fixture-backed deterministic branch",
    tag: { ru: "USDT -> bank transfer", en: "USDT -> bank transfer" },
    title: {
      ru: "USDT TRC20 -> Bangkok Bank",
      en: "USDT TRC20 -> Bangkok Bank",
    },
    summary: {
      ru: "Клиент хочет получить THB на тайский банк. Workflow собирает сеть, сумму, банк и только потом даёт адрес оплаты.",
      en: "The client wants THB to a Thai bank. The workflow collects network, amount and bank details before issuing payment address.",
    },
    result: {
      ru: "Нет лишнего handoff: сценарий проходит через quote, order_created и requisites_sent.",
      en: "No unnecessary handoff: the scenario moves through quote, order_created and requisites_sent.",
    },
    tone: "blue",
    fields: [
      "asset=USDT",
      "network=trc20",
      "amount_from=1500",
      "payout_method=thai_bank_transfer",
      "thai_bank_name=Bangkok Bank",
    ],
    stages: ["exchange_request", "quote_calculated", "order_created", "requisites_sent"],
    orderRows: [
      {
        label: { ru: "scenario", en: "scenario" },
        value: "usdt-to-thai-bank-transfer",
      },
      { label: { ru: "status", en: "status" }, value: "awaiting_payment" },
      {
        label: { ru: "payment", en: "payment" },
        value: "crypto_transfer / trc20",
      },
      { label: { ru: "payout", en: "payout" }, value: "thai_bank_transfer" },
      { label: { ru: "bank", en: "bank" }, value: "Bangkok Bank" },
    ],
    handoffs: [],
    toolEvents: [
      {
        tool: "compute_quote",
        status: "ok",
        desc: { ru: "1500 USDT priced", en: "1500 USDT priced" },
      },
      {
        tool: "create_order",
        status: "linked",
        desc: {
          ru: "lead + conversation + contact",
          en: "lead + conversation + contact",
        },
      },
      {
        tool: "fetch_requisites",
        status: "wallet",
        desc: {
          ru: "TRC20 address from config",
          en: "TRC20 address from config",
        },
      },
    ],
    boardTags: ["fields", "quote"],
    messages: {
      ru: [
        {
          from: "user",
          text: "Меняю 1500 USDT TRC20, получить хочу на Bangkok Bank.",
        },
        {
          from: "bot",
          text: "Сеть TRC20 и Bangkok Bank записал. Нужен номер счёта и имя получателя.",
        },
        { from: "user", text: "Счёт 123-4-56789-0, имя Alexander K." },
        {
          from: "bot",
          text: "Реквизиты получателя есть. Считаю quote и создам order перед выдачей адреса оплаты.",
          cta: true,
        },
      ],
      en: [
        {
          from: "user",
          text: "Exchange 1500 USDT TRC20, payout to Bangkok Bank.",
        },
        {
          from: "bot",
          text: "TRC20 and Bangkok Bank are recorded. I need account number and recipient name.",
        },
        { from: "user", text: "Account 123-4-56789-0, name Alexander K." },
        {
          from: "bot",
          text: "Recipient details are present. I will calculate a quote and create the order before issuing payment address.",
          cta: true,
        },
      ],
    },
  },
  {
    key: "kyc-review",
    corpusId: "kyc-media-verification",
    fixture: "rub-qr-kyc-cardless-atm-12900-thb",
    tag: { ru: "KYC review", en: "KYC review" },
    title: {
      ru: "KYC: паспорт, видео и cardless ATM",
      en: "KYC: passport, video and cardless ATM",
    },
    summary: {
      ru: "Фото и видео не считаются автоматическим approval. Они становятся kyc_review handoff с собранным контекстом.",
      en: "Photo and video are not automatic approval. They become a kyc_review handoff with collected context.",
    },
    result: {
      ru: "Guard ловит опасный путь: нельзя писать, что KYC пройден, без решения оператора или внешнего сервиса.",
      en: "The guard catches the unsafe path: never claim KYC passed without operator or external provider decision.",
    },
    tone: "amber",
    fields: [
      "asset=RUB",
      "payment_method=sbp_qr",
      "kyc_document",
      "kyc_video",
      "payout_method=cardless_atm",
    ],
    stages: ["exchange_request", "verification_check", "kyc_collection", "risk_review"],
    orderRows: [
      {
        label: { ru: "scenario", en: "scenario" },
        value: "kyc-media-verification",
      },
      { label: { ru: "status", en: "status" }, value: "quote" },
      { label: { ru: "payment", en: "payment" }, value: "sbp_qr" },
      { label: { ru: "payout", en: "payout" }, value: "cardless_atm" },
      { label: { ru: "handoff", en: "handoff" }, value: "kyc_review" },
    ],
    handoffs: ["kyc_review"],
    toolEvents: [
      {
        tool: "check_verification",
        status: "needs KYC",
        desc: {
          ru: "first-time client branch",
          en: "first-time client branch",
        },
      },
      {
        tool: "media_intake",
        status: "stored",
        desc: { ru: "passport + video note", en: "passport + video note" },
      },
      {
        tool: "operator_handoff",
        status: "kyc_review",
        desc: { ru: "no auto-approval", en: "no auto-approval" },
      },
    ],
    boardTags: ["operator", "risk"],
    messages: {
      ru: [
        {
          from: "user",
          text: "Хочу оплатить через QR 35000 рублей, получить в зеленом банкомате.",
        },
        {
          from: "bot",
          text: "Принял QR и cardless ATM. Для этой операции нужна верификация.",
        },
        {
          from: "user",
          text: "Я первый раз, вот фото паспорта и короткое видео.",
        },
        {
          from: "bot",
          text: "Материалы получил. Передаю оператору на KYC review, без автоматического подтверждения.",
          cta: true,
        },
      ],
      en: [
        {
          from: "user",
          text: "I want to pay by QR, 35,000 RUB, receive via green ATM.",
        },
        {
          from: "bot",
          text: "QR and cardless ATM are recorded. This operation requires verification.",
        },
        {
          from: "user",
          text: "First time here, sending passport photo and short video.",
        },
        {
          from: "bot",
          text: "Materials received. Sending to operator KYC review, with no automatic approval.",
          cta: true,
        },
      ],
    },
  },
  {
    key: "payment-proof",
    corpusId: "fiat-payment-proof-review",
    fixture: "rub-qr-bank-transfer-to-bangkok-bank",
    tag: { ru: "Payment proof", en: "Payment proof" },
    title: {
      ru: "RUB receipt -> payment_review",
      en: "RUB receipt -> payment_review",
    },
    summary: {
      ru: "Клиент присылает чек и просит отправить баты на Bangkok Bank. AI признаёт чек, но не переводит order в paid.",
      en: "The client sends a receipt and asks to send baht to Bangkok Bank. AI acknowledges the receipt but does not move order to paid.",
    },
    result: {
      ru: "Фиксируем главный риск обменки: чек не равен подтверждённой оплате.",
      en: "This pins the core exchange risk: a receipt is not verified payment.",
    },
    tone: "amber",
    fields: ["payment_proof", "source_bank=Sber/T-Bank", "thai_bank_name=Bangkok Bank"],
    stages: ["payment_proof_waiting", "payment_review"],
    orderRows: [
      {
        label: { ru: "scenario", en: "scenario" },
        value: "fiat-payment-proof-review",
      },
      { label: { ru: "status", en: "status" }, value: "awaiting_payment" },
      { label: { ru: "payment", en: "payment" }, value: "sbp_qr" },
      { label: { ru: "payout", en: "payout" }, value: "thai_bank_transfer" },
      { label: { ru: "bank", en: "bank" }, value: "Bangkok Bank" },
    ],
    handoffs: ["payment_review"],
    toolEvents: [
      {
        tool: "receipt_upload",
        status: "received",
        desc: { ru: "file attached to order", en: "file attached to order" },
      },
      {
        tool: "exchange_guard",
        status: "armed",
        desc: {
          ru: "blocks paid/transfer claims",
          en: "blocks paid/transfer claims",
        },
      },
      {
        tool: "operator_handoff",
        status: "payment_review",
        desc: {
          ru: "operator verifies receipt",
          en: "operator verifies receipt",
        },
      },
    ],
    boardTags: ["proof", "receipt"],
    messages: {
      ru: [
        { from: "user", text: "Оплатил по QR, вот чек." },
        {
          from: "bot",
          text: "Чек получил и прикрепил к заявке. Передаю на payment_review.",
        },
        { from: "user", text: "Можно отправлять баты на Bangkok Bank?" },
        {
          from: "bot",
          text: "После проверки оператором продолжим перевод на Bangkok Bank. Сейчас оплату не подтверждаю автоматически.",
          cta: true,
        },
      ],
      en: [
        { from: "user", text: "Paid by QR, here is the receipt." },
        {
          from: "bot",
          text: "Receipt received and attached to the order. Sending to payment_review.",
        },
        { from: "user", text: "Can you send baht to Bangkok Bank?" },
        {
          from: "bot",
          text: "After operator review we will continue the Bangkok Bank payout. I am not auto-confirming payment now.",
          cta: true,
        },
      ],
    },
  },
  {
    key: "rate-change",
    corpusId: "rate-first-then-amount-network-change",
    fixture: "fixture-backed deterministic branch",
    tag: { ru: "Rate change", en: "Rate change" },
    title: {
      ru: "Курс сначала, потом новая сумма и Binance ID",
      en: "Rate first, then new amount and Binance ID",
    },
    summary: {
      ru: "Клиент меняет условия после первой котировки. Workflow обязан пересчитать, а не переиспользовать старый quote.",
      en: "The client changes terms after the first quote. The workflow must recompute, not reuse stale quote.",
    },
    result: {
      ru: "Reply assertion требует fresh quote для 2500 USDT и Binance ID.",
      en: "Reply assertion requires a fresh quote for 2500 USDT and Binance ID.",
    },
    tone: "blue",
    fields: ["asset=USDT", "amount_from=2500", "payment_rail=binance_id"],
    stages: ["exchange_request", "quote_calculated", "order_created"],
    orderRows: [
      {
        label: { ru: "scenario", en: "scenario" },
        value: "rate-first-then-amount-network-change",
      },
      { label: { ru: "status", en: "status" }, value: "awaiting_payment" },
      { label: { ru: "payment", en: "payment" }, value: "crypto_transfer" },
      { label: { ru: "rail", en: "rail" }, value: "binance_id" },
      { label: { ru: "amount", en: "amount" }, value: "2500 USDT" },
    ],
    handoffs: [],
    toolEvents: [
      {
        tool: "compute_quote",
        status: "recomputed",
        desc: {
          ru: "old 1000 USDT quote dropped",
          en: "old 1000 USDT quote dropped",
        },
      },
      {
        tool: "create_order",
        status: "fresh",
        desc: { ru: "2500 USDT + Binance ID", en: "2500 USDT + Binance ID" },
      },
    ],
    boardTags: ["quote", "fields"],
    messages: {
      ru: [
        { from: "user", text: "Какой сейчас курс USDT к батам?" },
        {
          from: "bot",
          text: "Могу посчитать. Уточните сумму и способ перевода, чтобы quote был корректным.",
        },
        {
          from: "user",
          text: "Сначала думал 1000 USDT TRC20. Нет, сделаем 2500 USDT, можно через Binance ID?",
        },
        {
          from: "bot",
          text: "Пересчитываю на 2500 USDT и Binance ID. Старую котировку не использую.",
          cta: true,
        },
      ],
      en: [
        { from: "user", text: "What is the current USDT to baht rate?" },
        {
          from: "bot",
          text: "I can calculate it. Tell me amount and payment rail so the quote is valid.",
        },
        {
          from: "user",
          text: "I first thought 1000 USDT TRC20. No, make it 2500 USDT, can I use Binance ID?",
        },
        {
          from: "bot",
          text: "Recomputing for 2500 USDT and Binance ID. I am not reusing the old quote.",
          cta: true,
        },
      ],
    },
  },
  {
    key: "operator-handoff",
    corpusId: "unsupported-city-out-of-hours",
    fixture: "exception branch",
    tag: { ru: "Operator handoff", en: "Operator handoff" },
    title: {
      ru: "Unsupported city + out-of-hours",
      en: "Unsupported city + out-of-hours",
    },
    summary: {
      ru: "Чианграй, 02:30, наличные и просьба назвать точное ETA. AI не выдумывает доступность курьера и отдаёт оператору.",
      en: "Chiang Rai, 02:30, cash and request for exact ETA. AI does not invent courier availability and escalates to operator.",
    },
    result: {
      ru: "Сценарий проверяет no-fake-ETA и запрет на оплату до решения оператора.",
      en: "The scenario checks no-fake-ETA and blocks payment before operator decision.",
    },
    tone: "green",
    fields: ["city=Chiang Rai", "amount_to_thb=30000", "requested_time=02:30"],
    stages: ["exchange_request", "risk_review"],
    orderRows: [
      {
        label: { ru: "scenario", en: "scenario" },
        value: "unsupported-city-out-of-hours",
      },
      { label: { ru: "status", en: "status" }, value: "operator_required" },
      { label: { ru: "city", en: "city" }, value: "Chiang Rai" },
      { label: { ru: "time", en: "time" }, value: "02:30" },
      { label: { ru: "handoff", en: "handoff" }, value: "operator_request" },
    ],
    handoffs: ["operator_request"],
    toolEvents: [
      {
        tool: "coverage_check",
        status: "exception",
        desc: { ru: "unsupported city/time", en: "unsupported city/time" },
      },
      {
        tool: "exchange_guard",
        status: "no ETA",
        desc: {
          ru: "blocks fabricated courier time",
          en: "blocks fabricated courier time",
        },
      },
      {
        tool: "operator_handoff",
        status: "required",
        desc: {
          ru: "operator decides coverage",
          en: "operator decides coverage",
        },
      },
    ],
    boardTags: ["operator", "risk", "payout"],
    messages: {
      ru: [
        {
          from: "user",
          text: "Я в Чианграе, сейчас 02:30 ночи. Нужно срочно 30000 бат наличными.",
        },
        {
          from: "bot",
          text: "Город, время и сумму записал. Эта зона и время требуют проверки оператором.",
        },
        {
          from: "user",
          text: "Можете сказать точное время курьера и сразу принять оплату?",
        },
        {
          from: "bot",
          text: "Точное ETA и оплату сейчас не подтверждаю. Передаю оператору, он проверит доступность и вернёт решение.",
          cta: true,
        },
      ],
      en: [
        {
          from: "user",
          text: "I am in Chiang Rai, it is 02:30. Need urgent 30,000 baht cash.",
        },
        {
          from: "bot",
          text: "City, time and amount are recorded. This zone and hour require operator check.",
        },
        {
          from: "user",
          text: "Can you give exact courier time and take payment now?",
        },
        {
          from: "bot",
          text: "I cannot confirm exact ETA or payment now. Sending to operator to verify coverage and return a decision.",
          cta: true,
        },
      ],
    },
  },
];

const DEFAULT_SCENARIO_KEY: ExchangeWorkflowScenarioKey = "rub-office-pickup";

function scenarioHref(key: ExchangeWorkflowScenarioKey): string {
  return key === DEFAULT_SCENARIO_KEY
    ? "/demo/workflows/exchange"
    : `/demo/workflows/exchange/${key}`;
}

function getScenario(key?: ExchangeWorkflowScenarioKey): ExchangeWorkflowScenario {
  const fallback = EXCHANGE_WORKFLOW_SCENARIOS[0];
  if (!fallback) throw new Error("Exchange workflow scenarios are empty");
  return EXCHANGE_WORKFLOW_SCENARIOS.find((scenario) => scenario.key === key) ?? fallback;
}

function stagePhase(stage: string): string {
  if (stage.includes("request")) return "qualify";
  if (stage.includes("quote") || stage.includes("order_created")) return "offer";
  if (
    stage.includes("verification") ||
    stage.includes("risk") ||
    stage.includes("proof") ||
    stage.includes("review") ||
    stage.includes("requisites")
  ) {
    return "clear";
  }
  if (stage.includes("payout") || stage.includes("verified")) return "fulfill";
  if (stage.includes("terminal")) return "terminal";
  return "workflow";
}

const KPIS: { value: string; label: L; tone: "blue" | "green" | "amber" }[] = [
  {
    value: "38",
    label: { ru: "exchange orders today", en: "exchange orders today" },
    tone: "blue",
  },
  {
    value: "฿2.8M",
    label: { ru: "THB payout pipeline", en: "THB payout pipeline" },
    tone: "green",
  },
  {
    value: "9",
    label: { ru: "ждут proof / KYC", en: "awaiting proof / KYC" },
    tone: "amber",
  },
  {
    value: "14 мин",
    label: { ru: "средний TTL quote", en: "average quote TTL" },
    tone: "blue",
  },
];

const OPS_COLUMNS: {
  key: string;
  title: L;
  accent: string;
  cards: { who: string; amount: string; dir: string; note: L; tag: string }[];
}[] = [
  {
    key: "quote",
    title: { ru: "Quote", en: "Quote" },
    accent: "#6aa6ff",
    cards: [
      {
        who: "@rub_qr",
        amount: "฿35 000",
        dir: "RUB QR -> THB",
        note: {
          ru: "compute_quote, TTL 14:32",
          en: "compute_quote, TTL 14:32",
        },
        tag: "quote",
      },
      {
        who: "@wallet_500",
        amount: "500 USDT",
        dir: "USDT TRC20 -> THB",
        note: { ru: "network collected", en: "network collected" },
        tag: "fields",
      },
    ],
  },
  {
    key: "clear",
    title: { ru: "KYC / risk", en: "KYC / risk" },
    accent: "#fbbf77",
    cards: [
      {
        who: "@pattaya_kyc",
        amount: "฿87 400",
        dir: "RUB split -> ATM",
        note: { ru: "video note + card check", en: "video note + card check" },
        tag: "operator",
      },
      {
        who: "@third_party",
        amount: "฿45 000",
        dir: "RUB -> Bangkok Bank",
        note: { ru: "third-party payer flag", en: "third-party payer flag" },
        tag: "risk",
      },
    ],
  },
  {
    key: "payment",
    title: { ru: "Payment proof", en: "Payment proof" },
    accent: "#c4b5fd",
    cards: [
      {
        who: "@trust_fast",
        amount: "1 558 USDT",
        dir: "Trust -> THB cash",
        note: {
          ru: "tx hash seen, verify_payment",
          en: "tx hash seen, verify_payment",
        },
        tag: "proof",
      },
      {
        who: "@sber_atm",
        amount: "฿10 000",
        dir: "Sber QR -> cardless",
        note: {
          ru: "receipt OCR mismatch check",
          en: "receipt OCR mismatch check",
        },
        tag: "receipt",
      },
    ],
  },
  {
    key: "payout",
    title: { ru: "Payout", en: "Payout" },
    accent: "#91d990",
    cards: [
      {
        who: "@atm_blue",
        amount: "฿25 000 + ฿25 000",
        dir: "partial ATM payout",
        note: {
          ru: "issue_payout, code expires",
          en: "issue_payout, code expires",
        },
        tag: "payout",
      },
      {
        who: "@courier",
        amount: "฿60 000",
        dir: "USDT -> courier cash",
        note: { ru: "courier ETA confirmed", en: "courier ETA confirmed" },
        tag: "won",
      },
    ],
  },
];

const STAGES: {
  slug: string;
  title: L;
  phase: L;
  fields: string;
  action: string;
}[] = [
  {
    slug: "exchange_request",
    title: { ru: "Параметры обмена", en: "Exchange parameters" },
    phase: { ru: "qualify", en: "qualify" },
    fields: "asset_from, network, amount_from, payout_method",
    action: "validate direction",
  },
  {
    slug: "quote_calculated",
    title: { ru: "Курс рассчитан", en: "Quote calculated" },
    phase: { ru: "offer", en: "offer" },
    fields: "quote_id, final_rate, fee, amount_to, expires_at",
    action: "compute_quote",
  },
  {
    slug: "verification_check",
    title: { ru: "Проверка верификации", en: "Verification check" },
    phase: { ru: "clear", en: "clear" },
    fields: "verification_status, provider, verified_at",
    action: "check_verification",
  },
  {
    slug: "risk_review",
    title: { ru: "Проверка риска", en: "Risk review" },
    phase: { ru: "clear", en: "clear" },
    fields: "risk_score, risk_flags, risk_decision",
    action: "screen_risk",
  },
  {
    slug: "order_created",
    title: { ru: "Заявка создана", en: "Order created" },
    phase: { ru: "offer", en: "offer" },
    fields: "exchange_order_id, quote_snapshot",
    action: "create_order",
  },
  {
    slug: "requisites_sent",
    title: { ru: "Реквизиты отправлены", en: "Requisites sent" },
    phase: { ru: "clear", en: "clear" },
    fields: "provider, requisites_ref, requisites_expires_at",
    action: "fetch_requisites",
  },
  {
    slug: "payment_proof_waiting",
    title: { ru: "Ожидание оплаты", en: "Awaiting payment" },
    phase: { ru: "clear", en: "clear" },
    fields: "receipt_file, tx_hash, sender, amount, time",
    action: "reminder / OCR assist",
  },
  {
    slug: "payment_verified",
    title: { ru: "Оплата подтверждена", en: "Payment verified" },
    phase: { ru: "fulfill", en: "fulfill" },
    fields: "payment_status, matched_amount, verified_by",
    action: "verify_payment",
  },
  {
    slug: "payout_or_completion",
    title: { ru: "Выдача / завершено", en: "Payout / completed" },
    phase: { ru: "won", en: "won" },
    fields: "payout_method, code_ref, issued_by, completed_at",
    action: "issue_payout",
  },
];

const TOOLS: {
  name: string;
  desc: L;
  output: string;
  tone: "blue" | "green" | "amber";
}[] = [
  {
    name: "compute_quote",
    desc: {
      ru: "Считает курс, комиссию, сумму к получению и TTL. LLM не делает арифметику.",
      en: "Calculates rate, fee, payout amount and TTL. The LLM does not do arithmetic.",
    },
    output: "quote_snapshot",
    tone: "blue",
  },
  {
    name: "create_order",
    desc: {
      ru: "Создаёт exchange order, привязанный к lead, conversation и contact.",
      en: "Creates an exchange order linked to lead, conversation and contact.",
    },
    output: "exchange_order_id",
    tone: "green",
  },
  {
    name: "fetch_requisites",
    desc: {
      ru: "Выдаёт только разрешённые реквизиты: wallet, QR, карта, провайдер. Всё с TTL.",
      en: "Returns only allowed requisites: wallet, QR, card, provider. Everything has TTL.",
    },
    output: "requisites_ref",
    tone: "amber",
  },
  {
    name: "verify_payment",
    desc: {
      ru: "Проверяет tx hash / receipt match. Фото чека только помогает, но не решает само.",
      en: "Verifies tx hash / receipt match. Receipt image assists, but does not decide alone.",
    },
    output: "payment_status",
    tone: "blue",
  },
  {
    name: "issue_payout",
    desc: {
      ru: "Выдаёт payout code, QR или операторский action. Код не появляется из текста модели.",
      en: "Issues payout code, QR or operator action. The code never comes from model text.",
    },
    output: "payout_code_ref",
    tone: "green",
  },
];

type QaDisplay = {
  source: string;
  run: string;
  result: string;
  score: string;
  fields: string;
  stages: string;
  handoffs: string;
  guard: string;
};

type StoredQaReport = {
  generatedAt?: string;
  mode?: string;
  total?: number;
  passed?: number;
  results?: {
    scenarioId?: string;
    passed?: boolean;
    metrics?: {
      score?: number;
      fieldAccuracy?: number;
      stageCoverage?: number;
      handoffCorrect?: boolean;
      guardViolationCount?: number;
    };
  }[];
};

function pct(value: number | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) return "100%";
  return `${((value <= 1 ? value : value / 100) * 100).toFixed(0)}%`;
}

function readStoredQa(scenario: ExchangeWorkflowScenario): QaDisplay | null {
  if (typeof window === "undefined") return null;
  const raw =
    window.localStorage.getItem("exchangeLiveEvalReport") ??
    window.localStorage.getItem("exchange-live-eval-report");
  if (!raw) return null;
  try {
    const report = JSON.parse(raw) as StoredQaReport;
    const result = report.results?.find((item) => item.scenarioId === scenario.corpusId);
    if (!result) return null;
    return {
      source: "local live-eval report",
      run: report.generatedAt ?? report.mode ?? "latest",
      result: result.passed ? "passed" : "failed",
      score: pct(result.metrics?.score),
      fields: pct(result.metrics?.fieldAccuracy),
      stages: pct(result.metrics?.stageCoverage),
      handoffs: result.metrics?.handoffCorrect === false ? "fail" : "ok",
      guard: String(result.metrics?.guardViolationCount ?? 0),
    };
  } catch {
    return null;
  }
}

function deterministicQa(scenario: ExchangeWorkflowScenario): QaDisplay {
  return {
    source: "deterministic fixture-backed example",
    run: "eval:exchange-live · deterministic_mock",
    result: "passed",
    score: "100%",
    fields: "100%",
    stages: "100%",
    handoffs: scenario.handoffs.length > 0 ? scenario.handoffs.join(", ") : "none",
    guard: "0",
  };
}

function scenarioHandoffText(scenario: ExchangeWorkflowScenario): string {
  return scenario.handoffs.length > 0 ? scenario.handoffs.join(", ") : "no handoff";
}

function ExchangeOpsConsole({
  lang,
  scenario,
}: {
  lang: Lang;
  scenario: ExchangeWorkflowScenario;
}) {
  return (
    <div className="exchange-console">
      <div className="exchange-console-head">
        <div>
          <div className="exchange-console-kicker">EXCHANGE QA STATE</div>
          <strong>{t(scenario.tag, lang)}</strong>
        </div>
        <span>live</span>
      </div>
      <div className="exchange-kpis">
        {KPIS.map((kpi) => (
          <div key={kpi.value} className={`exchange-kpi tone-${kpi.tone}`}>
            <strong>{kpi.value}</strong>
            <span>{t(kpi.label, lang)}</span>
          </div>
        ))}
      </div>
      <div className="exchange-console-grid">
        <div className="exchange-mini-board">
          {OPS_COLUMNS.map((column) => (
            <div key={column.key} className="exchange-mini-col">
              <div className="exchange-mini-col-head">
                <span style={{ background: column.accent }} />
                {t(column.title, lang)}
              </div>
              {column.cards.map((card) => (
                <div
                  key={`${column.key}-${card.who}-${card.tag}`}
                  className={`exchange-mini-card ${
                    scenario.boardTags.includes(card.tag) ? "is-active" : ""
                  }`}
                  style={{ borderLeftColor: column.accent }}
                >
                  <div>
                    <strong>{card.who}</strong>
                    <em>{card.tag}</em>
                  </div>
                  <p>{card.dir}</p>
                  <b>{card.amount}</b>
                  <span>{t(card.note, lang)}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="exchange-order-panel">
          <div className="exchange-order-title">Expected state</div>
          {scenario.orderRows.map((row) => (
            <div key={row.value} className="exchange-order-row">
              <span>{t(row.label, lang)}</span>
              <strong>{row.value}</strong>
            </div>
          ))}
          <div className="exchange-tool-feed">
            {scenario.toolEvents.map((event) => (
              <div key={event.tool} className="exchange-tool-event">
                <div>
                  <strong>{event.tool}</strong>
                  <span>{t(event.desc, lang)}</span>
                </div>
                <em>{event.status}</em>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function DemoExchangeWorkflow({
  scenarioKey = DEFAULT_SCENARIO_KEY,
}: {
  scenarioKey?: ExchangeWorkflowScenarioKey;
}) {
  const [lang, setLang] = useState<Lang>("ru");
  const c = COPY[lang];
  const scenario = getScenario(scenarioKey);
  const qa = readStoredQa(scenario) ?? deterministicQa(scenario);

  return (
    <>
      <Nav cta={c.ctaPrimary} lang={lang} setLang={setLang} />

      <div className="demo-banner">
        <div className="container demo-banner-inner">
          <span className="demo-banner-tag">{c.bannerTag}</span>
          <span>{c.banner}</span>
        </div>
      </div>

      <section className="hero exchange-workflow-hero">
        <div className="container">
          <div className="exchange-hero-grid">
            <div>
              <div className="hero-badge">exchange_v1 · live workflow</div>
              <h1 className="hero-headline">
                {c.title[0]}
                <em>{c.title[1]}</em>
              </h1>
              <p className="hero-sub">{c.sub}</p>
              <div className="hero-actions">
                <a href={SIGNUP_URL} className="btn btn-primary btn-lg">
                  {c.ctaPrimary}
                </a>
                <a href={DEMO_URL} className="btn btn-secondary btn-lg">
                  {c.ctaSecondary}
                </a>
              </div>
              <div className="exchange-active-scenario">
                <span>Selected QA state</span>
                <strong>{t(scenario.title, lang)}</strong>
                <p>{t(scenario.summary, lang)}</p>
              </div>
              <div className="exchange-proof-strip exchange-scenario-tags">
                {EXCHANGE_WORKFLOW_SCENARIOS.map((item) => (
                  <a
                    key={item.key}
                    className={item.key === scenario.key ? "active" : ""}
                    href={scenarioHref(item.key)}
                  >
                    {t(item.tag, lang)}
                  </a>
                ))}
              </div>
            </div>
            <ExchangeOpsConsole lang={lang} scenario={scenario} />
          </div>
        </div>
      </section>

      <section className="section" style={{ paddingTop: 0 }}>
        <div className="container">
          <div className="section-label">{c.kpiLabel}</div>
          <h2 className="section-title">{c.opsTitle}</h2>
          <p className="section-sub" style={{ marginBottom: 28 }}>
            {c.opsSub}
          </p>
          <div className="exchange-money-layers">
            <div className="exchange-layer">
              <span>Business funnel</span>
              <strong>{scenario.stages.join(" -> ")}</strong>
            </div>
            <div className="exchange-layer">
              <span>Exchange order status</span>
              <strong>
                {scenario.orderRows
                  .filter((row) => ["status", "payment", "payout", "rail"].includes(row.label.en))
                  .map((row) => row.value)
                  .join(" -> ")}
              </strong>
            </div>
            <div className="exchange-layer">
              <span>Operator work</span>
              <strong>{scenarioHandoffText(scenario)}</strong>
            </div>
          </div>
          <div className="exchange-scenario-grid">
            <div className="exchange-scenario-panel">
              <span>Scenario fields</span>
              <strong>{scenario.corpusId}</strong>
              <div className="exchange-case-path">
                {scenario.fields.map((field) => (
                  <span key={field}>{field}</span>
                ))}
              </div>
            </div>
            <div className="exchange-qa-panel">
              <span>QA status</span>
              <strong>{qa.result}</strong>
              <div className="exchange-qa-grid">
                <div>
                  <em>source</em>
                  <b>{qa.source}</b>
                </div>
                <div>
                  <em>run</em>
                  <b>{qa.run}</b>
                </div>
                <div>
                  <em>score</em>
                  <b>{qa.score}</b>
                </div>
                <div>
                  <em>fields</em>
                  <b>{qa.fields}</b>
                </div>
                <div>
                  <em>stages</em>
                  <b>{qa.stages}</b>
                </div>
                <div>
                  <em>handoff</em>
                  <b>{qa.handoffs}</b>
                </div>
                <div>
                  <em>guard findings</em>
                  <b>{qa.guard}</b>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section section-alt">
        <div className="container">
          <div className="section-label">{c.casesLabel}</div>
          <h2 className="section-title">{c.casesTitle}</h2>
          <p className="section-sub" style={{ marginBottom: 28 }}>
            {c.casesSub}
          </p>
          <div className="exchange-case-grid">
            {EXCHANGE_WORKFLOW_SCENARIOS.map((item) => (
              <a
                key={item.key}
                href={scenarioHref(item.key)}
                className={`exchange-case tone-${item.tone} ${
                  item.key === scenario.key ? "is-active" : ""
                }`}
              >
                <div className="exchange-case-top">
                  <span>{item.corpusId}</span>
                  <strong>{t(item.title, lang)}</strong>
                </div>
                <p>{t(item.summary, lang)}</p>
                <div className="exchange-case-path">
                  {item.stages.map((step) => (
                    <span key={step}>{step}</span>
                  ))}
                </div>
                <em>{t(item.result, lang)}</em>
              </a>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="section-label">{c.stageLabel}</div>
          <h2 className="section-title">{c.stageTitle}</h2>
          <p className="section-sub" style={{ marginBottom: 28 }}>
            {c.stageSub}
          </p>
          <div className="exchange-stage-table">
            <table className="demo-rate-table">
              <thead>
                <tr>
                  <th>Stage</th>
                  <th>Phase</th>
                  <th>Fields</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {scenario.stages.map((stageSlug) => {
                  const stage = STAGES.find((item) => item.slug === stageSlug);
                  return (
                    <tr key={stageSlug}>
                      <td>
                        <strong>{stageSlug}</strong>
                        <span>{stage ? t(stage.title, lang) : "Scenario-specific state"}</span>
                      </td>
                      <td>{stage ? t(stage.phase, lang) : stagePhase(stageSlug)}</td>
                      <td>{stage?.fields ?? scenario.fields.join(", ")}</td>
                      <td className="demo-rate-dev">
                        {stage?.action ?? "guard / operator decision"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="section section-alt">
        <div className="container">
          <div className="section-label">{c.toolsLabel}</div>
          <h2 className="section-title">{c.toolsTitle}</h2>
          <p className="section-sub" style={{ marginBottom: 28 }}>
            {c.toolsSub}
          </p>
          <div className="exchange-tool-grid">
            {TOOLS.map((tool) => (
              <div key={tool.name} className={`exchange-tool-card tone-${tool.tone}`}>
                <div>
                  <span>{tool.output}</span>
                  <strong>{tool.name}</strong>
                </div>
                <p>{t(tool.desc, lang)}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="section-label">{c.handoffLabel}</div>
          <h2 className="section-title">{c.handoffTitle}</h2>
          <p className="section-sub" style={{ marginBottom: 28 }}>
            {c.handoffSub}
          </p>
          <div className="exchange-handoff-grid">
            {scenario.handoffs.length > 0 ? (
              scenario.handoffs.map((handoff) => (
                <div key={handoff} className="exchange-handoff">
                  <span>{scenario.corpusId}</span>
                  <strong>{handoff}</strong>
                  <p>{t(scenario.summary, lang)}</p>
                </div>
              ))
            ) : (
              <div className="exchange-handoff">
                <span>{scenario.corpusId}</span>
                <strong>No operator handoff</strong>
                <p>{t(scenario.result, lang)}</p>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="section section-alt">
        <div className="container">
          <div className="hero-inner">
            <div>
              <div className="section-label">{c.dialogLabel}</div>
              <h2 className="section-title" style={{ textAlign: "left" }}>
                {c.dialogTitle}
              </h2>
              <div className="exchange-dialog-scenario">
                <span>{scenario.fixture}</span>
                <strong>{t(scenario.title, lang)}</strong>
              </div>
              <p className="section-sub">{c.dialogSub}</p>
            </div>
            <TelegramMockup
              botName="Lead Engine Exchange"
              ctaLabel={c.ctaBubble}
              messages={scenario.messages[lang]}
              notify={`Operator: ${scenarioHandoffText(scenario)}`}
            />
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container demo-cta">
          <h2 className="section-title">{c.ctaTitle}</h2>
          <p className="section-sub" style={{ margin: "0 auto 28px", textAlign: "center" }}>
            {c.ctaSub}
          </p>
          <div className="hero-actions" style={{ justifyContent: "center" }}>
            <a href={SIGNUP_URL} className="btn btn-primary btn-lg">
              {c.ctaPrimary}
            </a>
            <a href={DEMO_URL} className="btn btn-secondary btn-lg">
              {c.ctaSecondary}
            </a>
          </div>
        </div>
      </section>

      <Footer {...c.footer} />
    </>
  );
}

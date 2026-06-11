import {
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  RocketIcon,
  SendIcon,
  SparklesIcon,
  TriangleAlertIcon,
  UploadIcon,
  UserIcon,
} from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { RateCardEditor } from "@/components/exchange/RateCardEditor";
import { ModeToggle } from "@/components/mode-toggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { AiWorkflowPanel } from "@/components/AiWorkflowPanel";
import { CopilotDock, useCopilot, usePageCopilot } from "@/components/copilot";
import {
  ApiError,
  type ChannelItem,
  clearToken,
  type ExchangeRate,
  type ExchangeRateCardProposal,
  type KbDoc,
  type LlmConfig,
  type LlmProvider,
  type LlmPurpose,
  type OnboardingStatus,
  saas,
  type VerticalInfo,
} from "../api/saas.ts";

/**
 * Обязательный пошаговый мастер первичной настройки. Заполняется ВНАЧАЛЕ —
 * только после завершения (server `onboarding-status.done`) гейт пускает в
 * кабинет (см. App.tsx OnboardingGate).
 *
 * Шаги динамические и зависят от вертикали:
 *   generic:  Бизнес → Канал → LLM → База знаний(opt) → Готово
 *   exchange: Бизнес → Канал → LLM → Курсы → Реквизиты → Тир-карта(opt)
 *             → База знаний(opt) → Бизнес-данные(opt) → Готово
 *
 * Required-шаги гейтят завершение и зеркалят серверный расчёт `done`.
 */

const PROVIDER_LABEL: Record<LlmProvider, string> = {
  openai: "OpenAI",
  openrouter: "OpenRouter",
  anthropic: "Anthropic",
  ollama: "Ollama (local)",
  jina: "Jina",
  cohere: "Cohere",
};

/** Назначения LLM (purpose) — chat обязателен, остальные опциональны. */
const ALL_PURPOSES: LlmPurpose[] = ["chat", "embed", "vision", "judge", "reranker"];

interface PurposeMeta {
  label: string;
  desc: string;
  required: boolean;
  providers: LlmProvider[];
}
const PURPOSE_META: Record<LlmPurpose, PurposeMeta> = {
  chat: {
    label: "Chat — ответы ассистента",
    desc: "Основные ответы бота клиентам",
    required: true,
    providers: ["openai", "openrouter", "anthropic", "ollama"],
  },
  embed: {
    label: "Embeddings — поиск по базе",
    desc: "Нужны для базы знаний (RAG)",
    required: false,
    providers: ["openai", "openrouter", "ollama", "jina", "cohere"],
  },
  vision: {
    label: "Vision — анализ изображений",
    desc: "Фото и документы: чеки, KYC",
    required: false,
    providers: ["openai", "openrouter", "anthropic", "ollama"],
  },
  judge: {
    label: "Judge — оценка ответов",
    desc: "Оценка качества и сравнение моделей",
    required: false,
    providers: ["openai", "openrouter", "anthropic"],
  },
  reranker: {
    label: "Reranker — точность поиска",
    desc: "Переранжирование результатов RAG",
    required: false,
    providers: ["jina", "cohere"],
  },
  transcribe: {
    label: "Расшифровка голоса",
    desc: "Распознавание голосовых (OpenRouter / OpenAI / Groq)",
    required: false,
    providers: ["openrouter", "openai"],
  },
};

/** Пример модели под (провайдер × назначение) — для placeholder поля «Модель». */
const MODEL_PLACEHOLDER: Partial<Record<LlmProvider, Partial<Record<LlmPurpose, string>>>> = {
  openai: {
    chat: "gpt-4o-mini",
    embed: "text-embedding-3-small",
    vision: "gpt-4o",
    judge: "gpt-4o",
  },
  openrouter: {
    chat: "google/gemini-2.5-flash",
    embed: "google/gemini-embedding-2",
    vision: "google/gemini-2.5-flash",
    judge: "google/gemini-2.5-flash",
  },
  anthropic: {
    chat: "claude-3-5-sonnet-latest",
    vision: "claude-3-5-sonnet-latest",
    judge: "claude-3-5-sonnet-latest",
  },
  ollama: { chat: "llama3.2", embed: "nomic-embed-text", vision: "llama3.2-vision" },
  jina: { embed: "jina-embeddings-v3", reranker: "jina-reranker-v2-base-multilingual" },
  cohere: { embed: "embed-multilingual-v3.0", reranker: "rerank-multilingual-v3.0" },
};
function modelPlaceholder(provider: LlmProvider, purpose: LlmPurpose): string {
  return MODEL_PLACEHOLDER[provider]?.[purpose] ?? "model-id";
}

/**
 * Готовые заготовки KB-документов для обменника. Жмёшь чип — форма «Добавить
 * текст» заполняется шаблоном с уже подставленными вариантами (цветные
 * банкоматы, способы выдачи и т.п.); остаётся вписать своё вместо `<…>`.
 * Бот отвечает по этим документам через RAG (см. шаг «База знаний»).
 */
const EXCHANGE_KB_TEMPLATES: { label: string; title: string; topic: string; body: string }[] = [
  {
    label: "Офисы и банкоматы",
    title: "Офисы, точки выдачи и банкоматы",
    topic: "locations",
    body: [
      "# Офисы, точки выдачи и банкоматы",
      "",
      "## Офисы",
      "- <район>: <адрес>, часы 10:00–20:00",
      "- <район>: <адрес>, часы 11:00–19:00",
      "(подскажем ближайший; код выдачи даёт оператор)",
      "",
      "## Cardless-снятие в банкомате (без карты)",
      "Поддерживаем «цветные» банкоматы:",
      "- 🟢 зелёный — Kasikorn (KBank)",
      "- 🟡 жёлтый — Krungsri",
      "- 🔵 синий — Bangkok Bank",
      "- 🟣 фиолетовый — SCB",
      "Подойдёт любой рядом с вами — пришлём банк, телефон и код снятия.",
      "",
      "## Курьер",
      "Доставка наличных: <зоны>, мин. сумма <…>, срок <…>.",
    ].join("\n"),
  },
  {
    label: "Способы и сроки выдачи",
    title: "Способы и сроки выдачи",
    topic: "payout",
    body: [
      "# Способы и сроки выдачи THB",
      "",
      "- Наличные в офисе (код): <условия>",
      "- Cardless в банкомате (🟢 KBank / 🟡 Krungsri / 🔵 Bangkok Bank / 🟣 SCB): <условия>",
      "- Курьер: <зоны, мин. сумма, срок>",
      "- Перевод на тайский банк: <банки, срок>",
      "",
      "Сроки: обычно <…> минут после подтверждения оплаты.",
    ].join("\n"),
  },
  {
    label: "Курс, лимиты, комиссии",
    title: "Курс, лимиты и комиссии",
    topic: "rates",
    body: [
      "# Курс, лимиты и комиссии",
      "",
      "- Направления: RUB→THB, USDT→THB, THB→RUB",
      "- Минимальная сумма: <…>",
      "- Комиссия: <… или «уже в курсе»>",
      "- Курс действует <…> минут после фиксации.",
      "- KYC: <напр. паспорт свыше 50 000 THB>",
    ].join("\n"),
  },
  {
    label: "Как проходит обмен",
    title: "Как проходит обмен",
    topic: "faq",
    body: [
      "# Как проходит обмен",
      "",
      "1. Вы пишете сумму и направление (напр. 45 000 ₽ → THB).",
      "2. Мы фиксируем курс и даём реквизиты для оплаты (QR/СБП, карта или крипто-кошелёк).",
      "3. Вы оплачиваете и присылаете подтверждение.",
      "4. Мы подтверждаем оплату и согласуем выдачу: офис, банкомат, курьер или перевод на банк.",
      "5. Выдаём наличные/перевод и присылаем код снятия (для банкомата).",
    ].join("\n"),
  },
];

type StepId =
  | "vertical"
  | "channel"
  | "llm"
  | "ai_funnel"
  | "ex_rates"
  | "ex_requisites"
  | "kb"
  | "ex_business"
  | "done";

/**
 * Выбор AI-пути («опиши бизнес — AI соберёт воронку») на шаге «Бизнес».
 * Переживает перезагрузку страницы, пока воронка ещё не применена.
 */
const AI_PATH_LS_KEY = "lead-engine.onboarding.ai-path";

interface StepDef {
  id: StepId;
  label: string;
  required: boolean;
  done: boolean;
  visible: boolean;
}

interface KeyForm {
  provider: LlmProvider;
  model: string;
  apiKey: string;
  baseUrl: string;
  embedDim: string;
}

const EMPTY_KEY_FORM: KeyForm = {
  provider: "openai",
  model: "",
  apiKey: "",
  baseUrl: "",
  embedDim: "",
};

const OLLAMA_PRESETS: Partial<Record<LlmPurpose, { model: string; embedDim?: string }>> = {
  chat: { model: "llama3.2" },
  embed: { model: "nomic-embed-text" },
  vision: { model: "llama3.2-vision" },
};

/** Типы реквизитов и настроек приёма для шага «Реквизиты» (ключи tenant_secrets). */
const REQUISITE_TYPES: { key: string; label: string; placeholder: string; secret?: boolean }[] = [
  { key: "exchange_wallet_usdt_trc20", label: "USDT TRC20 — адрес", placeholder: "T..." },
  { key: "exchange_wallet_usdt_erc20", label: "USDT ERC20 — адрес", placeholder: "0x..." },
  { key: "exchange_wallet_usdt_bep20", label: "USDT BEP20 / BSC — адрес", placeholder: "0x..." },
  { key: "exchange_wallet_usdt_ton", label: "USDT TON — адрес", placeholder: "UQ..." },
  {
    key: "exchange_wallet_usdt_ton_memo",
    label: "USDT TON — memo/comment",
    placeholder: "12345 или comment",
  },
  {
    key: "exchange_wallet_usdt_solana",
    label: "USDT Solana — адрес",
    placeholder: "solana address",
  },
  { key: "exchange_wallet_usdc_erc20", label: "USDC ERC20 — адрес", placeholder: "0x..." },
  {
    key: "exchange_wallet_usdc_solana",
    label: "USDC Solana — адрес",
    placeholder: "solana address",
  },
  { key: "exchange_wallet_btc_default", label: "BTC — адрес", placeholder: "bc1..." },
  { key: "exchange_wallet_eth_erc20", label: "ETH ERC20 — адрес", placeholder: "0x..." },
  { key: "exchange_wallet_ltc_default", label: "LTC — адрес", placeholder: "ltc1..." },
  { key: "exchange_wallet_trx_tron", label: "TRX Tron — адрес", placeholder: "T..." },
  { key: "exchange_wallet_ton_ton", label: "TON — адрес", placeholder: "UQ..." },
  {
    key: "exchange_wallet_ton_ton_memo",
    label: "TON — memo/comment",
    placeholder: "12345 или comment",
  },
  { key: "exchange_binance_id", label: "Binance ID / Pay ID", placeholder: "123456789" },
  { key: "exchange_bybit_uid", label: "Bybit UID", placeholder: "123456789" },
  { key: "exchange_htx_uid", label: "HTX UID", placeholder: "123456789" },
  {
    key: "exchange_fiat_payment_url",
    label: "СБП / платёжная ссылка RUB",
    placeholder: "https://...",
  },
  { key: "exchange_rub_card_number", label: "RUB карта — номер", placeholder: "2200..." },
  { key: "exchange_rub_card_phone", label: "RUB карта — телефон", placeholder: "+7..." },
  { key: "exchange_rub_card_bank", label: "RUB карта — банк", placeholder: "Сбер / T-Bank..." },
  { key: "exchange_rub_card_recipient", label: "RUB карта — получатель", placeholder: "Иван И." },
  {
    key: "exchange_payout_bank_methods",
    label: "Выдача THB — банки",
    placeholder: "Bangkok Bank, Kasikorn, SCB...",
  },
  {
    key: "exchange_payout_cash_methods",
    label: "Выдача THB — наличные",
    placeholder: "office cash, courier cash, cardless ATM...",
  },
  {
    key: "exchange_aml_policy",
    label: "AML правила",
    placeholder: "AML до 60%, high-risk — оператор...",
  },
  { key: "exchange_kyc_policy", label: "KYC правила", placeholder: "Паспорт / селфи / видео..." },
  {
    key: "exchange_operator_telegram",
    label: "Контакт оператора — Telegram",
    placeholder: "@operator",
  },
  {
    key: "exchange_operator_whatsapp",
    label: "Контакт оператора — WhatsApp",
    placeholder: "+66...",
  },
  { key: "exchange_operator_line", label: "Контакт оператора — Line", placeholder: "line id" },
  { key: "exchange_office_address", label: "Адрес офиса", placeholder: "Phuket, ..." },
  { key: "exchange_working_hours", label: "Часы работы", placeholder: "10:00-22:00 Bangkok" },
  {
    key: "exchange_westwallet_api_key",
    label: "WestWallet public API key",
    placeholder: "public key",
    secret: true,
  },
  {
    key: "exchange_westwallet_secret_key",
    label: "WestWallet private API key",
    placeholder: "private key",
    secret: true,
  },
  {
    key: "exchange_westwallet_ipn_url",
    label: "WestWallet IPN URL",
    placeholder: "https://your-domain/webhook/westwallet/tenantId",
  },
  {
    key: "exchange_westwallet_success_url",
    label: "WestWallet success URL",
    placeholder: "https://...",
  },
];

const LEGACY_REQUISITE_LABELS: Record<string, string> = {
  exchange_operator_contact: "Контакт оператора",
  exchange_payout_methods: "Выдача THB: банки / наличные",
  exchange_rub_card_requisites: "RUB карта / телефон",
};

/** Ключи, которые относятся к экрану реквизитов/настроек обменника. */
function isRequisiteKey(key: string): boolean {
  return (
    key.startsWith("exchange_wallet_") ||
    REQUISITE_TYPES.some((t) => t.key === key) ||
    key in LEGACY_REQUISITE_LABELS
  );
}

/** Человекочитаемая подпись реквизита по ключу. */
function requisiteLabel(key: string): string {
  const known = REQUISITE_TYPES.find((t) => t.key === key);
  if (known) return known.label;
  if (LEGACY_REQUISITE_LABELS[key]) return LEGACY_REQUISITE_LABELS[key];
  const m = /^exchange_wallet_(.+)$/.exec(key);
  if (m) return `Кошелёк ${m[1].replace(/_/g, " ").toUpperCase()}`;
  return key;
}

function configReady(cfg: LlmConfig | undefined): boolean {
  if (!cfg) return false;
  return cfg.provider === "ollama" || cfg.hasSecret;
}

export function SaasOnboarding() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState(0);
  const [error, setError] = useState("");

  const [channels, setChannels] = useState<ChannelItem[]>([]);
  const [configs, setConfigs] = useState<LlmConfig[]>([]);
  const [docs, setDocs] = useState<KbDoc[]>([]);
  const [status, setStatus] = useState<OnboardingStatus | null>(null);

  const [channelMode, setChannelMode] = useState<"userbot" | "bot">("userbot");
  const [botToken, setBotToken] = useState("");
  const [tgSubmitting, setTgSubmitting] = useState(false);

  const [ubStep, setUbStep] = useState<"phone" | "code" | "2fa">("phone");
  const [ubPhone, setUbPhone] = useState("");
  const [ubApiId, setUbApiId] = useState("");
  const [ubApiHash, setUbApiHash] = useState("");
  const [ubCode, setUbCode] = useState("");
  const [ubPassword, setUbPassword] = useState("");
  const [ubLoginId, setUbLoginId] = useState("");
  const [ubSubmitting, setUbSubmitting] = useState(false);
  const [ubError, setUbError] = useState("");

  const [keyForms, setKeyForms] = useState<Record<LlmPurpose, KeyForm>>(() => {
    const init = {} as Record<LlmPurpose, KeyForm>;
    for (const p of ALL_PURPOSES) {
      init[p] = {
        ...EMPTY_KEY_FORM,
        provider: PURPOSE_META[p].providers[0] ?? "openai",
        // Размерность embed фиксирована под колонку БЗ (vector(1536)); вектор
        // любой модели приводится к ней автоматически (openai-embed.fitDim).
        ...(p === "embed" ? { embedDim: "1536" } : {}),
      };
    }
    return init;
  });
  const [savingPurpose, setSavingPurpose] = useState<LlmPurpose | null>(null);
  // Какие назначения раскрыты в аккордеоне (chat — по умолчанию).
  const [expandedPurpose, setExpandedPurpose] = useState<Set<LlmPurpose>>(
    () => new Set<LlmPurpose>(["chat"]),
  );

  const [pasteTitle, setPasteTitle] = useState("");
  const [pasteTopic, setPasteTopic] = useState("");
  const [pasteBody, setPasteBody] = useState("");
  const [uploading, setUploading] = useState(false);
  const [lastIndexed, setLastIndexed] = useState<number | null>(null);

  const [verticals, setVerticals] = useState<VerticalInfo[]>([]);
  const [installingVertical, setInstallingVertical] = useState<string | null>(null);
  const [installedVertical, setInstalledVertical] = useState<string | null>(null);
  const [aiPath, setAiPath] = useState<boolean>(() => localStorage.getItem(AI_PATH_LS_KEY) === "1");
  const [aiPanelOpen, setAiPanelOpen] = useState(false);

  // Exchange — курсы (тир-карта от рыночного фида: RUB + USDT)
  const [rates, setRates] = useState<ExchangeRate[]>([]);
  const [cardProposals, setCardProposals] = useState<ExchangeRateCardProposal[]>([]);
  const [cardLoading, setCardLoading] = useState(false);
  const [cardSaving, setCardSaving] = useState(false);
  const [cardError, setCardError] = useState("");

  // Exchange — реквизиты
  const [reqType, setReqType] = useState(REQUISITE_TYPES[0]!.key);
  const [reqValue, setReqValue] = useState("");
  const [savingReq, setSavingReq] = useState(false);
  const [savedRequisites, setSavedRequisites] = useState<
    Array<{ key: string; value: string; hasValue?: boolean; sensitive?: boolean }>
  >([]);

  // Exchange — бизнес-данные (информационные)
  const [bizForm, setBizForm] = useState({
    operatorContact: "",
    payoutMethods: "",
    kycPolicy: "",
    workingHours: "",
    officeAddress: "",
  });
  const [savingBiz, setSavingBiz] = useState(false);
  const [bizSaved, setBizSaved] = useState(false);

  const chatCfg = configs.find((c) => c.purpose === "chat");

  /** Есть ли уже сохранённый ключ у какого-либо назначения с этим провайдером. */
  const providerHasKey = (provider: LlmProvider): boolean =>
    configs.some((c) => c.provider === provider && c.hasSecret);

  const isExchange = installedVertical === "exchange_v1" || status?.isExchange === true;

  // Completion-предикаты (зеркалят серверный `done`).
  const verticalDone = !!installedVertical || !!status?.funnelInstalled;
  // Шаг «Бизнес» закрыт выбором пути: установлен шаблон ИЛИ выбран AI-путь
  // (воронка соберётся на шаге «AI-воронка» после подключения LLM).
  const businessChosen = verticalDone || aiPath;
  // Только активные каналы — зеркалит серверный onboarding-status (paused не считается).
  const channelDone = channels.some((c) => c.status === "active");
  const chatDone = configReady(chatCfg); // chat обязателен; embed — опционально
  const ratesDone = rates.some((r) => r.isActive);
  const requisitesDone = (status?.requisiteCount ?? 0) >= 1;
  const kbDone = docs.length > 0;

  const allSteps: StepDef[] = [
    { id: "vertical", label: "Бизнес", required: true, done: businessChosen, visible: true },
    { id: "channel", label: "Канал", required: true, done: channelDone, visible: true },
    { id: "llm", label: "LLM", required: true, done: chatDone, visible: true },
    {
      id: "ai_funnel",
      label: "AI-воронка",
      required: true,
      done: !!status?.funnelInstalled,
      visible: aiPath && !installedVertical,
    },
    { id: "ex_rates", label: "Курсы", required: true, done: ratesDone, visible: isExchange },
    {
      id: "ex_requisites",
      label: "Реквизиты",
      required: true,
      done: requisitesDone,
      visible: isExchange,
    },
    { id: "kb", label: "База знаний", required: false, done: kbDone, visible: true },
    { id: "ex_business", label: "Данные", required: false, done: bizSaved, visible: isExchange },
    { id: "done", label: "Готово", required: false, done: false, visible: true },
  ];
  const steps = allSteps.filter((s) => s.visible);
  const currentId: StepId = steps[Math.min(step, steps.length - 1)]?.id ?? "vertical";

  /** Шаг достижим, если все предыдущие REQUIRED-шаги выполнены. */
  function reachable(target: number): boolean {
    for (let i = 0; i < target; i++) {
      const s = steps[i];
      if (s?.required && !s.done) return false;
    }
    return true;
  }

  /** Все ли required-шаги выполнены (можно завершить онбординг). */
  const allRequiredDone = steps.every((s) => !s.required || s.done);

  /** Перейти к шагу по id (после успешного сохранения). */
  function goToStep(id: StepId) {
    const idx = steps.findIndex((s) => s.id === id);
    if (idx >= 0) setStep(idx);
  }

  /** Перейти к первому незавершённому required-шагу (или к Готово). */
  function resumeStep(list: StepDef[]) {
    const idx = list.findIndex((s) => s.required && !s.done);
    setStep(idx >= 0 ? idx : list.length - 1);
  }

  function handleAuthError(err: unknown): boolean {
    if (err instanceof ApiError && err.status === 401) {
      clearToken();
      navigate("/login", { replace: true });
      return true;
    }
    return false;
  }

  async function loadState() {
    const [ch, cfg, verts, st] = await Promise.all([
      saas.listChannels(),
      saas.listLlmConfigs(),
      saas.listVerticals().catch(() => ({ items: [] as VerticalInfo[] })),
      saas.onboardingStatus().catch(() => null),
    ]);
    setVerticals(verts.items);
    setStatus(st);
    if (st?.funnelInstalled && st.vertical)
      setInstalledVertical((prev) => prev ?? st.vertical ?? null);
    let docItems: KbDoc[] = [];
    try {
      docItems = (await saas.listDocs()).items;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) throw err;
    }
    let rateItems: ExchangeRate[] = [];
    try {
      rateItems = (await saas.exchangeRates()).rates;
    } catch {
      // не-обменный тенант / нет доступа — игнорируем
    }
    let reqItems: Array<{ key: string; value: string }> = [];
    try {
      reqItems = (await saas.exchangeRequisites()).items;
    } catch {
      // нет доступа / не-обменный — игнорируем
    }
    setChannels(ch.items);
    setConfigs(cfg.items);
    setDocs(docItems);
    setRates(rateItems);
    setSavedRequisites(reqItems);
    for (const c of cfg.items) {
      if ((ALL_PURPOSES as string[]).includes(c.purpose)) {
        setKeyForms((prev) => ({
          ...prev,
          [c.purpose]: {
            provider: c.provider,
            model: c.model,
            apiKey: "",
            baseUrl: c.baseUrl ?? "",
            embedDim: c.embedDim?.toString() ?? (c.purpose === "embed" ? "1536" : ""),
          },
        }));
      }
    }
    // Для ещё НЕ настроенных назначений по умолчанию подставляем уже выбранного
    // провайдера (chat) — если он валиден для этого назначения. Тогда ключ
    // переиспользуется (один провайдер) и не нужно вводить повторно / ловить
    // ошибку «укажите ключ» из-за дефолтного openai.
    const primary = cfg.items.find((c) => c.purpose === "chat")?.provider ?? cfg.items[0]?.provider;
    if (primary) {
      const configured = new Set(cfg.items.map((c) => c.purpose));
      for (const p of ALL_PURPOSES) {
        if (!configured.has(p) && PURPOSE_META[p].providers.includes(primary as LlmProvider)) {
          setKeyForms((prev) => ({
            ...prev,
            [p]: { ...prev[p], provider: primary as LlmProvider },
          }));
        }
      }
    }
    return { ch: ch.items, cfg: cfg.items, kb: docItems, rates: rateItems, status: st };
  }

  const chatConfigured = configReady(chatCfg);

  const { appliedTick, navStep } = useCopilot();

  usePageCopilot({
    pageId: "onboarding",
    label: "Онбординг — настройка кабинета",
    llmReady: chatConfigured,
    data: {
      step,
      stepLabel: currentId,
      channelCount: channels.length,
      channelDone,
      chatConfigured,
      embedConfigured: configReady(configs.find((c) => c.purpose === "embed")),
      kbDocs: docs.length,
      verticals: verticals.map((v) => ({ slug: v.slug, displayName: v.displayName })),
      installedVertical,
    },
  });

  // Копайлот применил действие (установка вертикали/воронки) → перечитать стейт.
  useEffect(() => {
    if (appliedTick > 0) loadState().catch(() => {});
  }, [appliedTick]);

  // Ассистент попросил перейти к шагу онбординга.
  useEffect(() => {
    if (navStep && navStep.step >= 0 && navStep.step <= 3) setStep(navStep.step);
  }, [navStep]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await loadState();
        if (cancelled) return;
        // Пересобираем шаги под загруженное состояние и резюмим с первого незавершённого.
        const exch = res.status?.isExchange === true;
        const list = (
          [
            {
              id: "vertical",
              label: "",
              required: true,
              done: !!res.status?.funnelInstalled || aiPath,
              visible: true,
            },
            {
              id: "channel",
              label: "",
              required: true,
              done: res.ch.some((c) => c.status === "active"),
              visible: true,
            },
            {
              id: "llm",
              label: "",
              required: true,
              done: configReady(res.cfg.find((c) => c.purpose === "chat")),
              visible: true,
            },
            {
              id: "ai_funnel",
              label: "",
              required: true,
              done: !!res.status?.funnelInstalled,
              visible: aiPath && !res.status?.vertical,
            },
            {
              id: "ex_rates",
              label: "",
              required: true,
              done: res.rates.some((r) => r.isActive),
              visible: exch,
            },
            {
              id: "ex_requisites",
              label: "",
              required: true,
              done: (res.status?.requisiteCount ?? 0) >= 1,
              visible: exch,
            },
            { id: "kb", label: "", required: false, done: res.kb.length > 0, visible: true },
            { id: "ex_business", label: "", required: false, done: false, visible: exch },
            { id: "done", label: "", required: false, done: false, visible: true },
          ] satisfies StepDef[]
        ).filter((s) => s.visible);
        resumeStep(list);
      } catch (err) {
        if (cancelled) return;
        if (!handleAuthError(err)) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: run once
  }, []);

  // Авто-подтягиваем курс с рынка при входе на шаг «Курсы» (если ещё не настроен).
  useEffect(() => {
    if (currentId === "ex_rates" && !ratesDone && cardProposals.length === 0 && !cardLoading) {
      void loadRateCard();
    }
    // biome-ignore lint/correctness/useExhaustiveDependencies: реагируем на смену шага
  }, [currentId]);

  function updateKeyForm(purpose: LlmPurpose, patch: Partial<KeyForm>) {
    setKeyForms((prev) => ({ ...prev, [purpose]: { ...prev[purpose], ...patch } }));
  }

  function togglePurpose(purpose: LlmPurpose) {
    setExpandedPurpose((prev) => {
      const next = new Set(prev);
      if (next.has(purpose)) next.delete(purpose);
      else next.add(purpose);
      return next;
    });
  }

  async function handleTelegram(e: FormEvent) {
    e.preventDefault();
    setError("");
    const token = botToken.trim();
    if (!token) {
      setError("Вставьте Telegram bot token из @BotFather");
      return;
    }
    setTgSubmitting(true);
    try {
      await saas.createTelegramChannel(token);
      setBotToken("");
      await loadState();
      goToStep("llm");
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401 && err.errorCode.toLowerCase().includes("telegram")) {
          setError("Telegram отверг токен — проверьте, что вставили правильно из @BotFather");
        } else if (handleAuthError(err)) {
          return;
        } else if (err.status === 409) {
          setError("Этот бот уже подключён к аккаунту");
        } else if (err.status === 502) {
          setError("Telegram недоступен — попробуйте позже");
        } else {
          setError(`Ошибка ${err.status}: ${err.errorCode}`);
        }
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setTgSubmitting(false);
    }
  }

  function userbotErrMessage(err: unknown): string {
    if (err instanceof ApiError) {
      if (handleAuthError(err)) return "";
      if (err.errorCode === "userbot_creds_required" || err.errorCode === "userbot_creds_invalid") {
        return (
          (err.extra?.message as string | undefined) ??
          "Укажите API ID и API Hash (my.telegram.org → API development tools)"
        );
      }
      if (err.status === 503) return "Userbot временно недоступен — попробуйте позже";
      const msg = err.extra?.message as string | undefined;
      const retry = err.extra?.retryAfterSec as number | undefined;
      if (err.errorCode === "flood_wait") {
        return `Слишком много попыток — подождите ${retry ?? "?"} сек`;
      }
      return msg ?? `Ошибка: ${err.errorCode}`;
    }
    return err instanceof Error ? err.message : String(err);
  }

  function resetUserbot() {
    setUbStep("phone");
    setUbPhone("");
    setUbApiId("");
    setUbApiHash("");
    setUbCode("");
    setUbPassword("");
    setUbLoginId("");
    setUbError("");
  }

  async function handleUbPhone(e: FormEvent) {
    e.preventDefault();
    setUbError("");
    const phone = ubPhone.trim();
    if (!/^\+?\d{7,15}$/.test(phone)) {
      setUbError("Укажите номер в формате +79991234567");
      return;
    }
    setUbSubmitting(true);
    try {
      const res = await saas.startUserbotLogin(phone, ubApiId, ubApiHash);
      setUbLoginId(res.loginId);
      setUbStep("code");
    } catch (err) {
      setUbError(userbotErrMessage(err));
    } finally {
      setUbSubmitting(false);
    }
  }

  async function handleUbCode(e: FormEvent) {
    e.preventDefault();
    setUbError("");
    setUbSubmitting(true);
    try {
      const res = await saas.verifyUserbotCode(ubLoginId, ubCode.trim());
      if ("awaiting" in res) {
        setUbStep("2fa");
        return;
      }
      resetUserbot();
      await loadState();
      goToStep("llm");
    } catch (err) {
      setUbError(userbotErrMessage(err));
    } finally {
      setUbSubmitting(false);
    }
  }

  async function handleUb2fa(e: FormEvent) {
    e.preventDefault();
    setUbError("");
    setUbSubmitting(true);
    try {
      await saas.submitUserbot2fa(ubLoginId, ubPassword);
      resetUserbot();
      await loadState();
      goToStep("llm");
    } catch (err) {
      setUbError(userbotErrMessage(err));
    } finally {
      setUbSubmitting(false);
    }
  }

  async function handleSaveKey(e: FormEvent, purpose: LlmPurpose) {
    e.preventDefault();
    setError("");
    const f = keyForms[purpose];
    if (!f.model.trim()) {
      setError(`${purpose}: укажите модель`);
      return;
    }
    if (purpose === "embed" && !f.embedDim) {
      setError("embed: укажите размерность (например, 1536 для text-embedding-3-small)");
      return;
    }
    const existing = configs.find((c) => c.purpose === purpose);
    // Ключ обязателен, только если у этого назначения его нет И нет сохранённого
    // ключа того же провайдера в другом назначении (бэкенд переиспользует его).
    if (
      f.provider !== "ollama" &&
      !f.apiKey &&
      !existing?.hasSecret &&
      !providerHasKey(f.provider)
    ) {
      setError(`${purpose}: укажите API key`);
      return;
    }
    setSavingPurpose(purpose);
    try {
      await saas.upsertLlmConfig(purpose, {
        provider: f.provider,
        model: f.model.trim(),
        ...(f.apiKey ? { apiKey: f.apiKey } : {}),
        ...(f.baseUrl.trim() ? { baseUrl: f.baseUrl.trim() } : {}),
        ...(purpose === "embed" && f.embedDim ? { embedDim: Number.parseInt(f.embedDim, 10) } : {}),
      });
      updateKeyForm(purpose, { apiKey: "" });
      await loadState();
    } catch (err) {
      if (!handleAuthError(err)) setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingPurpose(null);
    }
  }

  // Курсы = тир-карта от рыночного фида (Binance + ЦБ). Превью тянет актуальный
  // рынок и строит дефолтные тиры RUB+USDT; пользователь правит отклонения; сохранение
  // (approve) создаёт активные базовые курсы + тиры. Авто-обновление рынка — да.
  async function loadRateCard() {
    setCardError("");
    setCardLoading(true);
    try {
      const res = await saas.previewExchangeRateCard();
      setCardProposals(res.proposals);
    } catch (err) {
      if (!handleAuthError(err)) {
        setCardError(err instanceof Error ? err.message : "Не удалось получить курс с рынка");
      }
    } finally {
      setCardLoading(false);
    }
  }

  async function saveRateCard() {
    if (cardProposals.length === 0) {
      setCardError("Сначала получите курс с рынка");
      return;
    }
    setCardError("");
    setCardSaving(true);
    try {
      await saas.approveExchangeRateCard(cardProposals);
      await loadState();
    } catch (err) {
      if (!handleAuthError(err)) setCardError(err instanceof Error ? err.message : String(err));
    } finally {
      setCardSaving(false);
    }
  }

  async function handleSaveRequisite(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (!reqValue.trim()) {
      setError("Реквизиты: укажите значение");
      return;
    }
    setSavingReq(true);
    try {
      await saas.saveExchangeRequisite(reqType, reqValue.trim());
      setReqValue("");
      await loadState();
    } catch (err) {
      if (!handleAuthError(err)) setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingReq(false);
    }
  }

  async function handleSaveBusiness(e: FormEvent) {
    e.preventDefault();
    setError("");
    setSavingBiz(true);
    try {
      const entries: [string, string][] = [
        ["exchange_operator_contact", bizForm.operatorContact],
        ["exchange_payout_methods", bizForm.payoutMethods],
        ["exchange_kyc_policy", bizForm.kycPolicy],
        ["exchange_working_hours", bizForm.workingHours],
        ["exchange_office_address", bizForm.officeAddress],
      ];
      for (const [key, value] of entries) {
        if (value.trim()) await saas.saveExchangeRequisite(key, value.trim());
      }
      setBizSaved(true);
    } catch (err) {
      if (!handleAuthError(err)) setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingBiz(false);
    }
  }

  function handleKbError(err: unknown) {
    if (err instanceof ApiError && err.status === 402) {
      setError((err.extra?.upgradeHint as string) ?? "Лимит документов исчерпан — повысьте план");
    } else if (!handleAuthError(err)) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError("");
    setLastIndexed(null);
    try {
      const res = await saas.uploadFile(file);
      setLastIndexed(res.chunks);
      await loadState();
    } catch (err) {
      handleKbError(err);
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }

  async function handlePaste(e: FormEvent) {
    e.preventDefault();
    if (!pasteBody.trim()) return;
    setUploading(true);
    setError("");
    setLastIndexed(null);
    try {
      const res = await saas.uploadJson({
        title: pasteTitle.trim() || "untitled",
        body: pasteBody,
        ...(pasteTopic.trim() ? { topic: pasteTopic.trim() } : {}),
      });
      setLastIndexed(res.chunks);
      setPasteTitle("");
      setPasteTopic("");
      setPasteBody("");
      await loadState();
    } catch (err) {
      handleKbError(err);
    } finally {
      setUploading(false);
    }
  }

  /** Кнопка «Далее» — к следующему видимому шагу. */
  function NextButton({ label }: { label: string }) {
    return (
      <Button onClick={() => setStep((s) => Math.min(s + 1, steps.length - 1))}>
        {label} <ArrowRightIcon />
      </Button>
    );
  }

  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center text-sm text-muted-foreground">
        Загрузка…
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <header className="flex h-14 items-center justify-between border-b px-4 md:px-8">
        <div className="flex items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-primary to-chart-5 text-primary-foreground">
            <RocketIcon className="size-4" />
          </span>
          <span className="text-[15px] font-semibold tracking-tight">
            lead<span className="text-primary">·</span>engine
          </span>
        </div>
        <ModeToggle />
      </header>

      <div className="flex">
        <div className="min-w-0 flex-1">
          <div className="mx-auto w-full max-w-2xl px-4 py-10">
            <div className="mb-8 text-center">
              <h1 className="text-2xl font-semibold tracking-tight">Настройка кабинета</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Заполните настройки — и бот начнёт отвечать вашим клиентам. Необязательные шаги
                можно пропустить.
              </p>
            </div>

            {/* Stepper */}
            <ol className="mb-8 flex flex-wrap items-center gap-2">
              {steps.map((s, i) => {
                const active = i === step;
                const canGo = reachable(i);
                return (
                  <li key={s.id} className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={!canGo}
                      onClick={() => canGo && setStep(i)}
                      className={cn(
                        "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors",
                        active && "border-primary/50 bg-accent text-foreground",
                        !active && canGo && "text-muted-foreground hover:bg-muted/60",
                        !canGo && "cursor-not-allowed opacity-50",
                      )}
                    >
                      <span
                        className={cn(
                          "grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold",
                          s.done
                            ? "bg-[color-mix(in_oklch,var(--success)_22%,transparent)] text-[var(--success)]"
                            : active
                              ? "bg-primary text-primary-foreground"
                              : "bg-muted text-muted-foreground",
                        )}
                      >
                        {s.done ? <CheckIcon className="size-3" /> : i + 1}
                      </span>
                      <span className="hidden items-center gap-1.5 font-medium sm:inline-flex">
                        {s.label}
                        {!s.required && (
                          <span className="rounded-full bg-muted px-1.5 py-px text-[10px] font-medium leading-normal text-muted-foreground">
                            опц
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>

            {error && (
              <p className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}

            {currentId === "vertical" && (
              <Card>
                <CardHeader>
                  <CardTitle>Ваш бизнес</CardTitle>
                  <p className="text-sm text-muted-foreground">
                    Lead Engine работает с любым бизнесом, где есть лиды. Соберите воронку с AI под
                    себя — или начните с готового примера. Всё можно изменить позже.
                  </p>
                </CardHeader>
                <CardContent className="space-y-4">
                  <button
                    type="button"
                    aria-pressed={aiPath && !installedVertical}
                    disabled={installingVertical !== null}
                    onClick={() => {
                      setAiPath(true);
                      localStorage.setItem(AI_PATH_LS_KEY, "1");
                      setError("");
                    }}
                    className={cn(
                      "flex w-full flex-col items-start gap-2 rounded-lg border p-4 text-left transition-colors disabled:opacity-60",
                      aiPath && !installedVertical
                        ? "border-primary bg-primary/5 ring-1 ring-primary"
                        : "border-border hover:border-primary/50 hover:bg-muted/50",
                    )}
                  >
                    <div className="flex w-full items-center justify-between gap-2">
                      <span className="flex items-center gap-2 font-medium">
                        <SparklesIcon className="size-4 text-primary" />
                        Собрать воронку с AI
                      </span>
                      {aiPath && !installedVertical && (
                        <CheckIcon className="size-4 shrink-0 text-primary" />
                      )}
                    </div>
                    <span className="text-sm text-muted-foreground">
                      Опишите бизнес своими словами — AI спроектирует этапы воронки, вопросы для
                      квалификации и поля анкеты. Конструктор откроется после подключения канала и
                      LLM-ключа.
                    </span>
                  </button>

                  <div className="flex items-center gap-3">
                    <div className="h-px flex-1 bg-border" />
                    <span className="text-xs text-muted-foreground">
                      или начните с готового примера
                    </span>
                    <div className="h-px flex-1 bg-border" />
                  </div>

                  {verticals.length === 0 && (
                    <p className="text-sm text-muted-foreground">Список примеров недоступен.</p>
                  )}
                  <div className="grid gap-2 sm:grid-cols-2">
                    {verticals.map((v) => {
                      const selected = installedVertical === v.slug;
                      const installing = installingVertical === v.slug;
                      const includes = [
                        v.hasFunnel && "Воронка",
                        v.hasStyles && "Стиль продаж",
                        v.hasKbDocuments && "База знаний",
                      ].filter(Boolean) as string[];
                      return (
                        <button
                          key={v.slug}
                          type="button"
                          disabled={installingVertical !== null}
                          aria-pressed={selected}
                          onClick={async () => {
                            setInstallingVertical(v.slug);
                            setError("");
                            try {
                              await saas.installVertical(v.slug);
                              setInstalledVertical(v.slug);
                              setAiPath(false);
                              localStorage.removeItem(AI_PATH_LS_KEY);
                              await loadState();
                            } catch (err) {
                              if (!handleAuthError(err)) {
                                setError(err instanceof Error ? err.message : String(err));
                              }
                            } finally {
                              setInstallingVertical(null);
                            }
                          }}
                          className={`flex flex-col items-start gap-2 rounded-lg border p-3 text-left transition-colors disabled:opacity-60 ${
                            selected
                              ? "border-primary bg-primary/5 ring-1 ring-primary"
                              : "border-border hover:border-primary/50 hover:bg-muted/50"
                          }`}
                        >
                          <div className="flex w-full items-center justify-between gap-2">
                            <span className="font-medium">{v.displayName}</span>
                            {selected && <CheckIcon className="size-4 shrink-0 text-primary" />}
                          </div>
                          {installing ? (
                            <span className="text-xs text-muted-foreground">Устанавливаем…</span>
                          ) : includes.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {includes.map((label) => (
                                <Badge key={label} variant="secondary" className="text-[10px]">
                                  {label}
                                </Badge>
                              ))}
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              Пустой костяк воронки
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                  {verticalDone && (
                    <p className="flex items-center gap-2 text-sm text-muted-foreground">
                      Шаблон установлен <Badge variant="success">готово</Badge>
                    </p>
                  )}
                  {businessChosen && <NextButton label="Далее: канал" />}
                </CardContent>
              </Card>
            )}

            {currentId === "channel" && (
              <Card>
                <CardHeader>
                  <CardTitle>Подключите канал</CardTitle>
                  <p className="text-sm text-muted-foreground">
                    Откуда приходят лиды? Достаточно одного мессенджера — личный Telegram или
                    отдельный бот.
                  </p>
                </CardHeader>
                <CardContent className="space-y-4">
                  {channelDone && (
                    <p className="flex items-center gap-2 text-sm text-muted-foreground">
                      Подключено каналов: <code className="font-mono">{channels.length}</code>
                      <Badge variant="success">готово</Badge>
                    </p>
                  )}

                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setChannelMode("userbot")}
                      className={cn(
                        "flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors",
                        channelMode === "userbot"
                          ? "border-primary/50 bg-accent"
                          : "text-muted-foreground hover:bg-muted/60",
                      )}
                    >
                      <UserIcon className="mt-0.5 size-4 shrink-0" />
                      <span>
                        <span className="block text-sm font-medium text-foreground">
                          Личный аккаунт
                        </span>
                        <span className="block text-xs">Лиды пишут вам в личку</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setChannelMode("bot")}
                      className={cn(
                        "flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors",
                        channelMode === "bot"
                          ? "border-primary/50 bg-accent"
                          : "text-muted-foreground hover:bg-muted/60",
                      )}
                    >
                      <SendIcon className="mt-0.5 size-4 shrink-0" />
                      <span>
                        <span className="block text-sm font-medium text-foreground">
                          Telegram-бот
                        </span>
                        <span className="block text-xs">Отдельный бот из @BotFather</span>
                      </span>
                    </button>
                  </div>

                  {channelMode === "userbot" ? (
                    <div className="space-y-3">
                      <p className="flex items-start gap-2 rounded-md border border-[var(--warning)]/40 bg-[color-mix(in_oklch,var(--warning)_10%,transparent)] px-3 py-2 text-sm text-[var(--warning)]">
                        <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
                        Подключайте только свой аккаунт и для ответов своим лидам — массовая
                        рассылка нарушает правила Telegram.
                      </p>
                      {ubError && (
                        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                          {ubError}
                        </p>
                      )}

                      {ubStep === "phone" && (
                        <form onSubmit={handleUbPhone} className="space-y-3">
                          <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1.5">
                              <Label>API ID</Label>
                              <Input
                                inputMode="numeric"
                                autoComplete="off"
                                value={ubApiId}
                                onChange={(e) => setUbApiId(e.target.value)}
                                placeholder="1234567"
                              />
                            </div>
                            <div className="space-y-1.5">
                              <Label>API Hash</Label>
                              <Input
                                autoComplete="off"
                                value={ubApiHash}
                                onChange={(e) => setUbApiHash(e.target.value)}
                                placeholder="abcd1234ef…"
                              />
                            </div>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            Получите на{" "}
                            <a
                              href="https://my.telegram.org/apps"
                              target="_blank"
                              rel="noreferrer"
                              className="underline"
                            >
                              my.telegram.org → API development tools
                            </a>
                            . Можно оставить пустым, если платформа предоставляет общие ключи.
                          </p>
                          <div className="space-y-1.5">
                            <Label>Номер телефона аккаунта</Label>
                            <Input
                              type="tel"
                              autoComplete="off"
                              value={ubPhone}
                              onChange={(e) => setUbPhone(e.target.value)}
                              placeholder="+79991234567"
                            />
                          </div>
                          <Button type="submit" disabled={ubSubmitting || !ubPhone.trim()}>
                            {ubSubmitting ? "Отправляем код…" : "Получить код"}
                          </Button>
                        </form>
                      )}

                      {ubStep === "code" && (
                        <form onSubmit={handleUbCode} className="space-y-3">
                          <p className="text-sm text-muted-foreground">
                            Telegram отправил код на {ubPhone}. Введите его.
                          </p>
                          <div className="space-y-1.5">
                            <Label>Код подтверждения</Label>
                            <Input
                              inputMode="numeric"
                              autoComplete="one-time-code"
                              value={ubCode}
                              onChange={(e) => setUbCode(e.target.value)}
                              placeholder="12345"
                            />
                          </div>
                          <div className="flex gap-2">
                            <Button type="submit" disabled={ubSubmitting || !ubCode.trim()}>
                              {ubSubmitting ? "Проверяем…" : "Подтвердить"}
                            </Button>
                            <Button type="button" variant="ghost" onClick={resetUserbot}>
                              Изменить номер
                            </Button>
                          </div>
                        </form>
                      )}

                      {ubStep === "2fa" && (
                        <form onSubmit={handleUb2fa} className="space-y-3">
                          <p className="text-sm text-muted-foreground">
                            У аккаунта включён облачный пароль (2FA). Введите его.
                          </p>
                          <div className="space-y-1.5">
                            <Label>Пароль 2FA</Label>
                            <Input
                              type="password"
                              autoComplete="off"
                              value={ubPassword}
                              onChange={(e) => setUbPassword(e.target.value)}
                              placeholder="••••••••"
                            />
                          </div>
                          <div className="flex gap-2">
                            <Button type="submit" disabled={ubSubmitting || !ubPassword}>
                              {ubSubmitting ? "Проверяем…" : "Войти"}
                            </Button>
                            <Button type="button" variant="ghost" onClick={resetUserbot}>
                              Начать заново
                            </Button>
                          </div>
                        </form>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <p className="text-sm text-muted-foreground">
                        Создайте бота в{" "}
                        <a
                          href="https://t.me/BotFather"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline"
                        >
                          @BotFather
                        </a>{" "}
                        и вставьте токен. Webhook настроится автоматически.
                      </p>
                      <form onSubmit={handleTelegram} className="space-y-3">
                        <div className="space-y-1.5">
                          <Label>Telegram bot token</Label>
                          <Input
                            type="text"
                            autoComplete="off"
                            value={botToken}
                            onChange={(e) => setBotToken(e.target.value)}
                            placeholder="123456789:AAEhBP…"
                          />
                        </div>
                        <Button type="submit" disabled={tgSubmitting || !botToken.trim()}>
                          {tgSubmitting ? "Проверяем…" : "Подключить"}
                        </Button>
                      </form>
                    </div>
                  )}

                  <p className="text-sm text-muted-foreground">
                    Нужен WhatsApp или web-виджет?{" "}
                    <Link to="/channels" className="text-primary hover:underline">
                      Все типы каналов →
                    </Link>
                  </p>
                  {channelDone && <NextButton label="Далее: LLM-провайдер" />}
                </CardContent>
              </Card>
            )}

            {currentId === "llm" && (
              <Card>
                <CardHeader>
                  <CardTitle>LLM-провайдеры</CardTitle>
                  <p className="text-sm text-muted-foreground">
                    Chat обязателен — ответы бота. Остальное по желанию: embeddings (база знаний),
                    vision (фото/документы), judge (оценка/сравнение), reranker (точность поиска).
                    Для Ollama API-ключ не нужен.
                  </p>
                  <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                    Для alpha быстрее всего OpenRouter: создайте key в openrouter.ai, поставьте
                    лимит бюджета и вставьте его в Chat. Ключ хранится зашифрованным; не отправляйте
                    его в Telegram или WhatsApp.
                  </p>
                </CardHeader>
                <CardContent className="space-y-2">
                  {ALL_PURPOSES.map((purpose) => {
                    const meta = PURPOSE_META[purpose];
                    const cfg = configs.find((c) => c.purpose === purpose);
                    const f = keyForms[purpose];
                    const open = expandedPurpose.has(purpose);
                    const ready = configReady(cfg);
                    const hasOllama = meta.providers.includes("ollama");
                    // Ключ этого провайдера уже сохранён в другом назначении → можно не вводить.
                    const reuseKey =
                      !cfg?.hasSecret && f.provider !== "ollama" && providerHasKey(f.provider);
                    return (
                      <div key={purpose} className="rounded-lg border">
                        <button
                          type="button"
                          onClick={() => togglePurpose(purpose)}
                          className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left"
                        >
                          <span className="min-w-0">
                            <span className="text-sm font-medium">
                              {meta.label}
                              {meta.required && <span className="text-destructive"> *</span>}
                            </span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {meta.desc}
                            </span>
                          </span>
                          <span className="flex shrink-0 items-center gap-2">
                            {ready ? (
                              <Badge variant="success">настроено</Badge>
                            ) : meta.required ? (
                              <Badge variant="warning">нужно</Badge>
                            ) : (
                              <span className="text-xs text-muted-foreground">опц.</span>
                            )}
                            <ChevronDownIcon
                              className={cn(
                                "size-4 text-muted-foreground transition-transform",
                                open && "rotate-180",
                              )}
                            />
                          </span>
                        </button>
                        {open && (
                          <form
                            onSubmit={(e) => handleSaveKey(e, purpose)}
                            className="grid gap-3 border-t px-3 py-3 sm:grid-cols-2"
                          >
                            <div className="space-y-1.5">
                              <Label>Провайдер</Label>
                              <Select
                                value={f.provider}
                                onValueChange={(v) =>
                                  updateKeyForm(purpose, { provider: v as LlmProvider })
                                }
                              >
                                <SelectTrigger>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {meta.providers.map((pv) => (
                                    <SelectItem key={pv} value={pv}>
                                      {PROVIDER_LABEL[pv]}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                            <div className="space-y-1.5">
                              <Label>Модель</Label>
                              <Input
                                value={f.model}
                                onChange={(e) => updateKeyForm(purpose, { model: e.target.value })}
                                placeholder={modelPlaceholder(f.provider, purpose)}
                              />
                            </div>
                            {f.provider !== "ollama" && (
                              <div className="space-y-1.5">
                                <Label>
                                  API-ключ{" "}
                                  {cfg?.hasSecret
                                    ? "(пусто — не менять)"
                                    : reuseKey
                                      ? "(можно не вводить)"
                                      : ""}
                                </Label>
                                <Input
                                  type="password"
                                  autoComplete="new-password"
                                  value={f.apiKey}
                                  onChange={(e) =>
                                    updateKeyForm(purpose, { apiKey: e.target.value })
                                  }
                                  placeholder={
                                    cfg?.hasSecret
                                      ? "•••••••• (сохранён)"
                                      : reuseKey
                                        ? `ключ ${PROVIDER_LABEL[f.provider]} уже сохранён — переиспользуем`
                                        : "sk-…"
                                  }
                                />
                              </div>
                            )}
                            {f.provider === "ollama" && (
                              <div className="space-y-1.5">
                                <Label>URL Ollama</Label>
                                <Input
                                  value={f.baseUrl}
                                  onChange={(e) =>
                                    updateKeyForm(purpose, { baseUrl: e.target.value })
                                  }
                                  placeholder="http://localhost:11434"
                                />
                              </div>
                            )}
                            {purpose === "embed" && (
                              <div className="space-y-1.5">
                                <Label>Размерность</Label>
                                <Input
                                  type="number"
                                  value={f.embedDim}
                                  onChange={(e) =>
                                    updateKeyForm(purpose, { embedDim: e.target.value })
                                  }
                                  placeholder="1536"
                                />
                              </div>
                            )}
                            {purpose === "embed" && (
                              <p className="sm:col-span-2 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                                Оставьте <code className="font-mono">1536</code> — под базу знаний.
                                Вектор любой современной модели приводится к 1536 автоматически
                                (нужна модель с размерностью ≥ 1536).
                              </p>
                            )}
                            {f.provider === "ollama" && OLLAMA_PRESETS[purpose] && (
                              <p className="sm:col-span-2 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                                Ollama локальный — ключ не нужен. Запустите{" "}
                                <code className="font-mono">ollama serve</code> и{" "}
                                <code className="font-mono">
                                  ollama pull {OLLAMA_PRESETS[purpose]?.model}
                                </code>
                              </p>
                            )}
                            <div className="flex items-center gap-2 sm:col-span-2">
                              <Button type="submit" disabled={savingPurpose !== null}>
                                {savingPurpose === purpose ? "Сохраняем…" : "Сохранить"}
                              </Button>
                              {hasOllama && f.provider !== "ollama" && (
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={() =>
                                    updateKeyForm(purpose, {
                                      provider: "ollama",
                                      model: OLLAMA_PRESETS[purpose]?.model ?? "",
                                      baseUrl: "http://localhost:11434",
                                      apiKey: "",
                                    })
                                  }
                                >
                                  Использовать Ollama
                                </Button>
                              )}
                            </div>
                          </form>
                        )}
                      </div>
                    );
                  })}
                  <p className="text-sm text-muted-foreground">
                    Расширенные параметры (timeout и т.д.) —{" "}
                    <Link to="/settings" className="text-primary hover:underline">
                      настройки →
                    </Link>
                  </p>
                  {chatDone && <NextButton label="Далее" />}
                </CardContent>
              </Card>
            )}

            {currentId === "ai_funnel" && (
              <Card>
                <CardHeader>
                  <CardTitle>Соберите воронку с AI</CardTitle>
                  <p className="text-sm text-muted-foreground">
                    Опишите бизнес своими словами: чем занимаетесь, как приходят клиенты и что нужно
                    от них узнать. AI спроектирует этапы воронки и поля анкеты — вы увидите
                    предпросмотр и подтвердите перед применением.
                  </p>
                </CardHeader>
                <CardContent className="space-y-4">
                  {status?.funnelInstalled ? (
                    <>
                      <p className="flex items-center gap-2 text-sm text-muted-foreground">
                        Воронка собрана <Badge variant="success">готово</Badge>
                      </p>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button variant="outline" onClick={() => setAiPanelOpen(true)}>
                          <SparklesIcon className="size-4" /> Уточнить воронку
                        </Button>
                        <NextButton label="Далее: база знаний" />
                      </div>
                    </>
                  ) : (
                    <Button onClick={() => setAiPanelOpen(true)}>
                      <SparklesIcon className="size-4" /> Открыть AI-конструктор
                    </Button>
                  )}
                </CardContent>
              </Card>
            )}

            {currentId === "ex_rates" && (
              <Card>
                <CardHeader>
                  <CardTitle>Курсы обмена</CardTitle>
                  <p className="text-sm text-muted-foreground">
                    Актуальный курс берём с рынка (Binance + ЦБ) и авто-обновляем. Вы задаёте свои
                    курсы по диапазонам сумм — отдельно для рублей и USDT (как на табло). Система
                    сохраняет отклонение от рынка и обновляет значения вместе с рынком.
                  </p>
                </CardHeader>
                <CardContent className="space-y-4">
                  {cardError && (
                    <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                      {cardError}
                    </p>
                  )}

                  {cardProposals.length === 0 ? (
                    <Button type="button" onClick={loadRateCard} disabled={cardLoading}>
                      {cardLoading ? "Получаем курс…" : "Получить актуальный курс с рынка"}
                    </Button>
                  ) : (
                    <>
                      <RateCardEditor
                        proposals={cardProposals}
                        quoteCode="THB"
                        onChange={setCardProposals}
                      />
                      <div className="flex flex-wrap gap-2">
                        <Button type="button" onClick={saveRateCard} disabled={cardSaving}>
                          {cardSaving
                            ? "Сохраняем…"
                            : ratesDone
                              ? "Обновить курсы"
                              : "Сохранить курсы"}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={loadRateCard}
                          disabled={cardLoading}
                        >
                          {cardLoading ? "Обновляем…" : "Сбросить к рынку"}
                        </Button>
                      </div>
                    </>
                  )}

                  {ratesDone && (
                    <p className="rounded-md border border-[var(--success)]/40 bg-[color-mix(in_oklch,var(--success)_12%,transparent)] px-3 py-2 text-sm text-[var(--success)]">
                      ✓ Курсы сохранены и активны. Авто-обновление рынка включено.
                    </p>
                  )}
                  {ratesDone && <NextButton label="Далее: реквизиты" />}
                </CardContent>
              </Card>
            )}

            {currentId === "ex_requisites" && (
              <Card>
                <CardHeader>
                  <CardTitle>Реквизиты приёма</CardTitle>
                  <p className="text-sm text-muted-foreground">
                    Куда клиент отправляет средства. Добавьте минимум один реквизит — бот выдаёт их
                    клиенту автоматически (иначе — передача оператору). Значения шифруются.
                  </p>
                </CardHeader>
                <CardContent className="space-y-4">
                  <p className="text-sm text-muted-foreground">
                    Сохранено реквизитов:{" "}
                    <code className="font-mono">{status?.requisiteCount ?? 0}</code>
                    {requisitesDone && (
                      <Badge variant="success" className="ml-2">
                        готово
                      </Badge>
                    )}
                  </p>

                  {savedRequisites.filter((r) => isRequisiteKey(r.key)).length > 0 && (
                    <ul className="space-y-1.5">
                      {savedRequisites
                        .filter((r) => isRequisiteKey(r.key))
                        .map((r) => (
                          <li
                            key={r.key}
                            className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
                          >
                            <CheckIcon className="size-4 shrink-0 text-[var(--success)]" />
                            <span className="shrink-0 font-medium">{requisiteLabel(r.key)}:</span>
                            <span
                              className="truncate font-mono text-xs text-muted-foreground"
                              title={r.sensitive ? undefined : r.value}
                            >
                              {r.sensitive && r.hasValue ? "сохранено" : r.value}
                            </span>
                          </li>
                        ))}
                    </ul>
                  )}

                  <form onSubmit={handleSaveRequisite} className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label>Тип реквизита</Label>
                      <Select value={reqType} onValueChange={setReqType}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {REQUISITE_TYPES.map((t) => (
                            <SelectItem key={t.key} value={t.key}>
                              {t.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label>Значение</Label>
                      <Input
                        autoComplete="off"
                        type={
                          REQUISITE_TYPES.find((t) => t.key === reqType)?.secret
                            ? "password"
                            : "text"
                        }
                        value={reqValue}
                        onChange={(e) => setReqValue(e.target.value)}
                        placeholder={
                          REQUISITE_TYPES.find((t) => t.key === reqType)?.placeholder ?? "значение"
                        }
                      />
                    </div>
                    <div className="sm:col-span-2">
                      <Button type="submit" disabled={savingReq || !reqValue.trim()}>
                        {savingReq ? "Сохраняем…" : "Добавить реквизит"}
                      </Button>
                    </div>
                  </form>
                  {requisitesDone && <NextButton label="Далее" />}
                </CardContent>
              </Card>
            )}

            {currentId === "kb" && (
              <Card>
                <CardHeader>
                  <CardTitle>База знаний (опционально)</CardTitle>
                  <p className="text-sm text-muted-foreground">
                    Загрузите документы — бот будет отвечать по вашей базе (RAG). Шаг можно
                    пропустить.
                  </p>
                </CardHeader>
                <CardContent className="space-y-4">
                  {lastIndexed !== null && (
                    <p className="rounded-md border border-[var(--success)]/40 bg-[color-mix(in_oklch,var(--success)_12%,transparent)] px-3 py-2 text-sm text-[var(--success)]">
                      ✓ Документ проиндексирован — {lastIndexed} фрагментов.
                    </p>
                  )}

                  <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-muted/30 px-4 py-7 text-center transition-colors hover:border-primary/50 hover:bg-muted/50">
                    <span className="grid size-9 place-items-center rounded-full bg-primary/15 text-primary">
                      <UploadIcon className="size-4" />
                    </span>
                    <span className="text-sm font-medium">Загрузить файл</span>
                    <span className="text-xs text-muted-foreground">.txt, .md, .json, .pdf</span>
                    <input
                      type="file"
                      accept=".txt,.md,.json,.pdf"
                      onChange={handleFileUpload}
                      disabled={uploading}
                      className="sr-only"
                    />
                  </label>

                  {isExchange && (
                    <div className="space-y-2">
                      <p className="text-xs text-muted-foreground">
                        Заготовки для обменника — нажмите, заполнится форма ниже, останется вписать
                        свои адреса и условия:
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {EXCHANGE_KB_TEMPLATES.map((t) => (
                          <Button
                            key={t.title}
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setPasteTitle(t.title);
                              setPasteTopic(t.topic);
                              setPasteBody(t.body);
                            }}
                          >
                            {t.label}
                          </Button>
                        ))}
                      </div>
                    </div>
                  )}

                  <form onSubmit={handlePaste} className="space-y-3">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Input
                        placeholder="Заголовок"
                        value={pasteTitle}
                        onChange={(e) => setPasteTitle(e.target.value)}
                      />
                      <Input
                        placeholder="Тема (опционально)"
                        value={pasteTopic}
                        onChange={(e) => setPasteTopic(e.target.value)}
                      />
                    </div>
                    <Textarea
                      placeholder="Текст документа…"
                      rows={5}
                      className="font-mono text-xs"
                      value={pasteBody}
                      onChange={(e) => setPasteBody(e.target.value)}
                    />
                    <Button
                      type="submit"
                      variant="outline"
                      disabled={uploading || !pasteBody.trim()}
                    >
                      {uploading ? "Загружаем…" : "Добавить текст"}
                    </Button>
                  </form>

                  {docs.length > 0 && (
                    <p className="text-sm text-muted-foreground">
                      Документов в базе: <code className="font-mono">{docs.length}</code>
                    </p>
                  )}

                  <NextButton label={kbDone ? "Далее" : "Пропустить"} />
                </CardContent>
              </Card>
            )}

            {currentId === "ex_business" && (
              <Card>
                <CardHeader>
                  <CardTitle>Данные обменника (опционально)</CardTitle>
                  <p className="text-sm text-muted-foreground">
                    Эти данные сохраняются для оператора. Автоматизация (подстановка в ответы бота,
                    расписание, KYC-гейтинг) — в следующем релизе.
                  </p>
                </CardHeader>
                <CardContent className="space-y-4">
                  {bizSaved && (
                    <p className="rounded-md border border-[var(--success)]/40 bg-[color-mix(in_oklch,var(--success)_12%,transparent)] px-3 py-2 text-sm text-[var(--success)]">
                      ✓ Данные сохранены.
                    </p>
                  )}
                  <form onSubmit={handleSaveBusiness} className="space-y-3">
                    <div className="space-y-1.5">
                      <Label>Контакт оператора (для эскалаций)</Label>
                      <Input
                        value={bizForm.operatorContact}
                        onChange={(e) =>
                          setBizForm((p) => ({ ...p, operatorContact: e.target.value }))
                        }
                        placeholder="@operator / +66…"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Методы выдачи</Label>
                      <Input
                        value={bizForm.payoutMethods}
                        onChange={(e) =>
                          setBizForm((p) => ({ ...p, payoutMethods: e.target.value }))
                        }
                        placeholder="офис, безкарточный ATM, курьер, тайский банк"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Политика KYC</Label>
                      <Input
                        value={bizForm.kycPolicy}
                        onChange={(e) => setBizForm((p) => ({ ...p, kycPolicy: e.target.value }))}
                        placeholder="напр. обязательна свыше 50 000 THB"
                      />
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label>Часы работы</Label>
                        <Input
                          value={bizForm.workingHours}
                          onChange={(e) =>
                            setBizForm((p) => ({ ...p, workingHours: e.target.value }))
                          }
                          placeholder="10:00–20:00, Пхукет"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label>Адрес офиса</Label>
                        <Input
                          value={bizForm.officeAddress}
                          onChange={(e) =>
                            setBizForm((p) => ({ ...p, officeAddress: e.target.value }))
                          }
                          placeholder="—"
                        />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button type="submit" disabled={savingBiz}>
                        {savingBiz ? "Сохраняем…" : "Сохранить"}
                      </Button>
                      <NextButton label="Далее" />
                    </div>
                  </form>
                </CardContent>
              </Card>
            )}

            {currentId === "done" && (
              <Card>
                <CardHeader>
                  <CardTitle>{allRequiredDone ? "Готово!" : "Почти готово"}</CardTitle>
                  <p className="text-sm text-muted-foreground">
                    {allRequiredDone
                      ? "Всё настроено — можно переходить к работе."
                      : "Завершите обязательные шаги (без пометки «опц»), чтобы открыть кабинет."}
                  </p>
                </CardHeader>
                <CardContent className="space-y-4">
                  <ul className="space-y-2">
                    {steps
                      .filter((s) => s.id !== "done")
                      .map((s) => (
                        <li
                          key={s.id}
                          className="flex items-center gap-3 rounded-lg border px-3 py-2.5"
                        >
                          <span
                            className={cn(
                              "grid size-6 shrink-0 place-items-center rounded-full text-xs",
                              s.done
                                ? "bg-[color-mix(in_oklch,var(--success)_22%,transparent)] text-[var(--success)]"
                                : "border text-muted-foreground",
                            )}
                          >
                            {s.done ? <CheckIcon className="size-3.5" /> : "○"}
                          </span>
                          <div>
                            <p className="text-sm font-medium leading-tight">
                              {s.label}
                              {!s.required && (
                                <span className="text-muted-foreground"> (опционально)</span>
                              )}
                            </p>
                          </div>
                        </li>
                      ))}
                  </ul>
                  <Button
                    className="w-full"
                    disabled={!allRequiredDone}
                    onClick={() => navigate("/dashboard", { replace: true })}
                  >
                    Перейти в кабинет <ArrowRightIcon />
                  </Button>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
        <CopilotDock underHeader />
        <AiWorkflowPanel
          open={aiPanelOpen}
          onOpenChange={setAiPanelOpen}
          onApplied={() => {
            loadState().catch(() => {});
          }}
        />
      </div>
    </div>
  );
}

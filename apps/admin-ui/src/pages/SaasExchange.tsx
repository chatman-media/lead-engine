import {
  AlertTriangleIcon,
  CheckCircleIcon,
  CheckIcon,
  Loader2Icon,
  MapIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  Trash2Icon,
  XCircleIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  ApiError,
  clearToken,
  type ExchangeEvalResult,
  type ExchangeKycContact,
  type ExchangeOrder,
  type ExchangeRate,
  type ExchangeRateCardProposal,
  type ExchangeRateInput,
  type ExchangeRateProposal,
  type ExchangeSettings,
  type ExchangeTurnover,
  type PayoutCoverageOperator,
  type PayoutPoint,
  type PayoutPointInput,
  saas,
} from "@/api/saas";
import { RateCardEditor } from "@/components/exchange/RateCardEditor";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

// Активы и сети для произвольных направлений обмена (не только табло RUB/USDT→THB).
const ASSETS = ["USDT", "USDC", "BTC", "ETH", "LTC", "TRX", "TON", "RUB", "EUR", "USD", "THB"];
const NETWORKS = ["", "trc20", "erc20", "bep20", "ton", "solana", "tron"];

// Дефолт quoteAsset берётся ИЗ валюты тенанта через emptyRate(quoteCode):
// статичный фикс `"RUB"` (THB-центризм) приводил к битой строке `→RUB`, которая
// проваливается фильтром listActiveDirections (quoteAsset должен совпадать с
// валютой тенанта). Поэтому используем фабрику и читаем `quoteCode` в компоненте.
function emptyRate(quoteCode: string): ExchangeRateInput {
  return {
    asset: "USDT",
    quoteAsset: quoteCode,
    network: "trc20",
    baseRate: 0,
    quoteMode: "multiply",
    marginPct: 0,
    isActive: true,
    autoUpdate: false,
  };
}

const STATUS_VARIANT: Record<
  string,
  "default" | "secondary" | "success" | "warning" | "destructive" | "outline"
> = {
  quote: "secondary",
  awaiting_payment: "warning",
  paid: "default",
  payout: "default",
  completed: "success",
  cancelled: "destructive",
  expired: "destructive",
};

type RequisiteField = {
  key: string;
  label: string;
  savedLabel: string;
  placeholder: string;
  secret?: boolean;
  multiline?: boolean;
  hint?: string;
};

const REQUISITE_GROUPS: Array<{ title: string; fields: RequisiteField[] }> = [
  {
    title: "USDT TRC20",
    fields: [
      {
        key: "exchange_wallet_usdt_trc20",
        label: "Адрес",
        savedLabel: "USDT TRC20 — адрес",
        placeholder: "T...",
      },
    ],
  },
  {
    title: "USDT ERC20",
    fields: [
      {
        key: "exchange_wallet_usdt_erc20",
        label: "Адрес",
        savedLabel: "USDT ERC20 — адрес",
        placeholder: "0x...",
      },
    ],
  },
  {
    title: "USDT BEP20 / BSC",
    fields: [
      {
        key: "exchange_wallet_usdt_bep20",
        label: "Адрес",
        savedLabel: "USDT BEP20 / BSC — адрес",
        placeholder: "0x...",
      },
    ],
  },
  {
    title: "USDT TON",
    fields: [
      {
        key: "exchange_wallet_usdt_ton",
        label: "Адрес",
        savedLabel: "USDT TON — адрес",
        placeholder: "UQ...",
      },
      {
        key: "exchange_wallet_usdt_ton_memo",
        label: "Memo/comment",
        savedLabel: "USDT TON — memo/comment",
        placeholder: "12345 или comment",
      },
    ],
  },
  {
    title: "USDT Solana",
    fields: [
      {
        key: "exchange_wallet_usdt_solana",
        label: "Адрес",
        savedLabel: "USDT Solana — адрес",
        placeholder: "solana address",
      },
    ],
  },
  {
    title: "USDC ERC20",
    fields: [
      {
        key: "exchange_wallet_usdc_erc20",
        label: "Адрес",
        savedLabel: "USDC ERC20 — адрес",
        placeholder: "0x...",
      },
    ],
  },
  {
    title: "USDC Solana",
    fields: [
      {
        key: "exchange_wallet_usdc_solana",
        label: "Адрес",
        savedLabel: "USDC Solana — адрес",
        placeholder: "solana address",
      },
    ],
  },
  {
    title: "BTC",
    fields: [
      {
        key: "exchange_wallet_btc_default",
        label: "Адрес",
        savedLabel: "BTC — адрес",
        placeholder: "bc1...",
      },
    ],
  },
  {
    title: "ETH ERC20",
    fields: [
      {
        key: "exchange_wallet_eth_erc20",
        label: "Адрес",
        savedLabel: "ETH ERC20 — адрес",
        placeholder: "0x...",
      },
    ],
  },
  {
    title: "LTC",
    fields: [
      {
        key: "exchange_wallet_ltc_default",
        label: "Адрес",
        savedLabel: "LTC — адрес",
        placeholder: "ltc1...",
      },
    ],
  },
  {
    title: "TRX Tron",
    fields: [
      {
        key: "exchange_wallet_trx_tron",
        label: "Адрес",
        savedLabel: "TRX Tron — адрес",
        placeholder: "T...",
      },
    ],
  },
  {
    title: "TON",
    fields: [
      {
        key: "exchange_wallet_ton_ton",
        label: "Адрес",
        savedLabel: "TON — адрес",
        placeholder: "UQ...",
      },
      {
        key: "exchange_wallet_ton_ton_memo",
        label: "Memo/comment",
        savedLabel: "TON — memo/comment",
        placeholder: "12345 или comment",
      },
    ],
  },
  {
    title: "Exchange ID",
    fields: [
      {
        key: "exchange_binance_id",
        label: "Binance ID / Pay ID",
        savedLabel: "Binance ID / Pay ID",
        placeholder: "123456789",
      },
      {
        key: "exchange_bybit_uid",
        label: "Bybit UID",
        savedLabel: "Bybit UID",
        placeholder: "123456789",
      },
      {
        key: "exchange_htx_uid",
        label: "HTX UID",
        savedLabel: "HTX UID",
        placeholder: "123456789",
      },
    ],
  },
  {
    title: "RUB оплата",
    fields: [
      {
        key: "exchange_fiat_payment_url",
        label: "СБП / платёжная ссылка",
        savedLabel: "СБП / платёжная ссылка RUB",
        placeholder: "https://...",
      },
      {
        key: "exchange_rub_card_number",
        label: "Номер карты",
        savedLabel: "RUB карта — номер",
        placeholder: "2200...",
      },
      {
        key: "exchange_rub_card_phone",
        label: "Телефон",
        savedLabel: "RUB карта — телефон",
        placeholder: "+7...",
      },
      {
        key: "exchange_rub_card_bank",
        label: "Банк",
        savedLabel: "RUB карта — банк",
        placeholder: "Сбер / T-Bank...",
      },
      {
        key: "exchange_rub_card_recipient",
        label: "Получатель",
        savedLabel: "RUB карта — получатель",
        placeholder: "Иван И.",
      },
    ],
  },
  {
    title: "Выдача средств",
    fields: [
      {
        key: "exchange_payout_bank_methods",
        label: "Банки",
        savedLabel: "Выдача — банки",
        placeholder: "BDO, BPI, GCash / Bangkok Bank, Kasikorn...",
      },
      {
        key: "exchange_payout_cash_methods",
        label: "Наличные / офис / курьер",
        savedLabel: "Выдача — наличные",
        placeholder: "office cash, courier cash, cardless ATM...",
      },
    ],
  },
  {
    title: "AML / KYC",
    fields: [
      {
        key: "exchange_aml_policy",
        label: "AML правила",
        savedLabel: "AML правила",
        placeholder: "AML до 60%, high-risk — оператор...",
      },
      {
        key: "exchange_kyc_policy",
        label: "KYC правила",
        savedLabel: "KYC правила",
        placeholder: "Паспорт / селфи / видео...",
      },
    ],
  },
  {
    title: "Контакты и офисы",
    fields: [
      {
        key: "exchange_operator_telegram",
        label: "Telegram",
        savedLabel: "Контакт оператора — Telegram",
        placeholder: "@operator",
      },
      {
        key: "exchange_operator_whatsapp",
        label: "WhatsApp",
        savedLabel: "Контакт оператора — WhatsApp",
        placeholder: "+66...",
      },
      {
        key: "exchange_operator_line",
        label: "Line",
        savedLabel: "Контакт оператора — Line",
        placeholder: "line id",
      },
      {
        key: "exchange_office_address",
        label: "Адреса офисов",
        savedLabel: "Адреса офисов",
        placeholder:
          "Bangkok Asok — Interchange 21, 10:00-20:00\nPhuket Central — bank zone, 10:00-20:00",
        multiline: true,
        hint: "Один офис на строку. Бот сможет предложить клиенту несколько вариантов.",
      },
      {
        key: "exchange_working_hours",
        label: "Часы работы",
        savedLabel: "Часы работы",
        placeholder: "10:00-22:00 Bangkok",
      },
    ],
  },
  {
    title: "WestWallet",
    fields: [
      {
        key: "exchange_westwallet_api_key",
        label: "Public API key",
        savedLabel: "WestWallet public API key",
        placeholder: "public key",
        secret: true,
      },
      {
        key: "exchange_westwallet_secret_key",
        label: "Private API key",
        savedLabel: "WestWallet private API key",
        placeholder: "private key",
        secret: true,
      },
      {
        key: "exchange_westwallet_ipn_url",
        label: "IPN URL",
        savedLabel: "WestWallet IPN URL",
        placeholder: "https://your-domain/webhook/westwallet/tenantId",
      },
      {
        key: "exchange_westwallet_success_url",
        label: "Success URL",
        savedLabel: "WestWallet success URL",
        placeholder: "https://...",
      },
    ],
  },
];

const REQUISITE_TYPES = REQUISITE_GROUPS.flatMap((group) => group.fields);

const LEGACY_REQUISITE_LABELS: Record<string, string> = {
  exchange_operator_contact: "Контакт оператора",
  exchange_payout_methods: "Выдача: банки / наличные",
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
  if (known) return known.savedLabel;
  if (LEGACY_REQUISITE_LABELS[key]) return LEGACY_REQUISITE_LABELS[key];
  const m = /^exchange_wallet_(.+)$/.exec(key);
  if (m) return `Кошелёк ${m[1].replace(/_/g, " ").toUpperCase()}`;
  return key;
}

function formatRate(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

interface QuoteMeta {
  word: string;
  tablo: string;
  flag: string;
}
const QUOTE_META: Record<string, QuoteMeta> = {
  PHP: { word: "песо", tablo: "Песо", flag: "🇵🇭" },
  THB: { word: "бат", tablo: "Баты", flag: "🇹🇭" },
  VND: { word: "донг", tablo: "Донги", flag: "🇻🇳" },
  IDR: { word: "рупий", tablo: "Рупии", flag: "🇮🇩" },
};
function quoteMeta(code: string): QuoteMeta {
  return QUOTE_META[code] ?? { word: code, tablo: code, flag: "" };
}

function renderRange(min: number, max: number | null, word: string): string {
  const fmt = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  if (max === null) return `от${fmt(min)} ${word}`;
  return `от${fmt(min)} до${fmt(max)} ${word}`;
}

function renderRateCardMessage(proposals: ExchangeRateCardProposal[], quote: string): string {
  const q = quoteMeta(quote);
  const rub = proposals.find((p) => p.asset === "RUB");
  const usdt = proposals.find((p) => p.asset === "USDT");
  const lines = ["🙏 АКТУАЛЬНЫЙ КУРС НА СЕГОДНЯ 🙏", ""];
  if (rub) {
    rub.tiers.forEach((tier, idx) => {
      const marker = idx === 0 ? ">" : idx === 1 ? "-" : "<";
      lines.push(
        `🇷🇺RUB // ${q.tablo} - ${formatRate(tier.displayRate)} ${marker} (${renderRange(tier.minThb, tier.maxThb, q.word)}${q.flag}`,
      );
    });
    lines.push("***", "", "🏪💲———💳💳 💰 💳💳———💲🏪", "");
  }
  if (usdt) {
    usdt.tiers.forEach((tier) => {
      lines.push(
        `💲USDT // ${q.tablo} < ${formatRate(tier.displayRate)} - (${renderRange(tier.minThb, tier.maxThb, q.word)})${q.flag}`,
      );
    });
    lines.push(
      "",
      "💲💲💲💲💲💲без карты(Инструкция)",
      "",
      "📞 LINE",
      "📞 WhatsApp",
      "📞 WeChat",
      "",
      "💬Отзывы о Нашей Работе 📨",
    );
  }
  return lines.join("\n");
}

const REFRESH_PRESETS = [
  { sec: 180, label: "Каждые 3 мин" },
  { sec: 300, label: "Каждые 5 мин" },
  { sec: 600, label: "Каждые 10 мин" },
  { sec: 900, label: "Каждые 15 мин" },
  { sec: 1800, label: "Каждые 30 мин" },
  { sec: 3600, label: "Каждый час" },
];
const STALE_PRESETS = [
  { sec: 600, label: "10 мин" },
  { sec: 1200, label: "20 мин" },
  { sec: 1800, label: "30 мин" },
  { sec: 3600, label: "1 час" },
];
const QUOTE_ASSET_LABELS: Record<string, string> = {
  PHP: "🇵🇭 PHP — песо (Филиппины)",
  THB: "🇹🇭 THB — бат (Таиланд)",
  VND: "🇻🇳 VND — донг (Вьетнам)",
  IDR: "🇮🇩 IDR — рупия (Индонезия)",
};
const DEFAULT_QUOTE_ASSET_OPTIONS = Object.keys(QUOTE_ASSET_LABELS);
const DEFAULT_SETTINGS: ExchangeSettings = {
  rateRefreshSec: 180,
  feedStaleSec: null,
  quoteAsset: "PHP",
  quoteAssetOptions: DEFAULT_QUOTE_ASSET_OPTIONS,
  handoffCustomerNotice: true,
  requireRateConfirmation: false,
};

export function SaasExchange() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [rates, setRates] = useState<ExchangeRate[]>([]);
  const [orders, setOrders] = useState<ExchangeOrder[]>([]);
  const [turnover, setTurnover] = useState<ExchangeTurnover | null>(null);
  const [exchangeEval, setExchangeEval] = useState<ExchangeEvalResult | null>(null);
  const [exchangeEvalRunning, setExchangeEvalRunning] = useState(false);

  // Курсы — тир-карта от рыночного фида (RUB + USDT), редактируемая
  const [cardProposals, setCardProposals] = useState<ExchangeRateCardProposal[]>([]);
  const [cardLoading, setCardLoading] = useState(false);
  const [cardSaving, setCardSaving] = useState(false);
  const [rateCardMessage, setRateCardMessage] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [pendingProposals, setPendingProposals] = useState<ExchangeRateProposal[]>([]);
  const [proposalActing, setProposalActing] = useState<number | null>(null);
  const [settings, setSettings] = useState<ExchangeSettings>(DEFAULT_SETTINGS);
  const [savingSettings, setSavingSettings] = useState(false);
  // Котируемая валюта тенанта — для подписи оборота, табло и дефолтов направлений.
  const quoteCode = settings.quoteAsset ?? "PHP";

  // Произвольное направление обмена (помимо табло RUB/USDT→THB)
  const [addingRate, setAddingRate] = useState(false);
  const [rateForm, setRateForm] = useState<ExchangeRateInput>(() => emptyRate(quoteCode));
  const [savingRate, setSavingRate] = useState(false);

  // Реквизиты
  const [savedRequisites, setSavedRequisites] = useState<
    Array<{ key: string; value: string; hasValue?: boolean; sensitive?: boolean }>
  >([]);
  const [reqValues, setReqValues] = useState<Record<string, string>>({});
  const [savingReqKey, setSavingReqKey] = useState<string | null>(null);

  function handle401(err: unknown) {
    if (err instanceof ApiError && err.status === 401) {
      clearToken();
      navigate("/login", { replace: true });
      return true;
    }
    return false;
  }

  function load() {
    setLoading(true);
    Promise.all([
      saas.exchangeRates(),
      saas.exchangeOrders(),
      saas.exchangeTurnover(),
      saas.exchangeRequisites().catch(() => ({ items: [] })),
      saas.exchangeSettings().catch(() => DEFAULT_SETTINGS),
      saas.listRateProposals().catch(() => ({ proposals: [] })),
    ])
      .then(([r, o, t, req, st, prop]) => {
        setRates(r.rates);
        setOrders(o.orders);
        setTurnover(t);
        setSavedRequisites(req.items);
        setSettings(st);
        setPendingProposals(prop.proposals);
      })
      .catch((err) => {
        if (!handle401(err)) toast.error("Не удалось загрузить данные обменника");
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    // Сразу показываем редактор курсов (а не прячем за кнопкой) — чтобы было
    // очевидно, где менять и добавлять курсы.
    loadRateCard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function removeRate(id: number) {
    try {
      await saas.deleteExchangeRate(id);
      load();
    } catch (err) {
      if (!handle401(err)) toast.error("Не удалось удалить курс");
    }
  }

  async function saveRate() {
    if (!rateForm.asset || (!rateForm.autoUpdate && !(rateForm.baseRate > 0))) {
      toast.error("Укажите актив и положительный курс (или включите авто-курс с рынка)");
      return;
    }
    setSavingRate(true);
    try {
      await saas.saveExchangeRate(rateForm);
      toast.success("Направление сохранено");
      setRateForm(emptyRate(quoteCode));
      setAddingRate(false);
      load();
    } catch (err) {
      if (!handle401(err)) toast.error("Не удалось сохранить курс");
    } finally {
      setSavingRate(false);
    }
  }

  async function refreshRates() {
    setRefreshing(true);
    try {
      const r = await saas.refreshExchangeRates();
      toast.success(`Курсы обновлены: ${r.updated}, пропущено ${r.skipped}, ошибок ${r.failed}`);
      load();
    } catch (err) {
      if (!handle401(err)) toast.error("Не удалось обновить курсы с рынка");
    } finally {
      setRefreshing(false);
    }
  }

  async function confirmProposal(id: number) {
    setProposalActing(id);
    try {
      await saas.confirmRateProposal(id);
      toast.success("Курс обновлён");
      load();
    } catch (err) {
      if (!handle401(err)) {
        toast.error(
          err instanceof ApiError && err.status === 409
            ? "Курс уже изменился — обновите страницу и подтвердите заново"
            : "Не удалось подтвердить курс",
        );
      }
    } finally {
      setProposalActing(null);
    }
  }

  async function rejectProposal(id: number) {
    setProposalActing(id);
    try {
      await saas.rejectRateProposal(id);
      toast.success("Предложение отклонено, курс прежний");
      load();
    } catch (err) {
      if (!handle401(err)) toast.error("Не удалось отклонить предложение");
    } finally {
      setProposalActing(null);
    }
  }

  async function saveSettings() {
    setSavingSettings(true);
    try {
      const r = await saas.saveExchangeSettings(settings);
      setSettings((s) => ({
        ...r.settings,
        quoteAssetOptions: s.quoteAssetOptions ?? DEFAULT_QUOTE_ASSET_OPTIONS,
      }));
      toast.success("Настройки обновления сохранены");
    } catch (err) {
      if (!handle401(err)) {
        toast.error(err instanceof ApiError ? err.message : "Не удалось сохранить настройки");
      }
    } finally {
      setSavingSettings(false);
    }
  }

  // Курсы = тир-карта от рынка. Превью тянет актуальный рынок и строит дефолтные
  // тиры RUB+USDT; оператор правит/добавляет диапазоны; «Сохранить» (approve)
  // создаёт активные базовые курсы + тиры. Авто-обновление рынка включено.
  async function loadRateCard() {
    setCardLoading(true);
    try {
      const result = await saas.previewExchangeRateCard();
      setCardProposals(result.proposals);
      setRateCardMessage(result.message);
    } catch (err) {
      if (!handle401(err)) toast.error("Не удалось получить курс с рынка");
    } finally {
      setCardLoading(false);
    }
  }

  function updateRateCard(next: ExchangeRateCardProposal[]) {
    setCardProposals(next);
    setRateCardMessage(renderRateCardMessage(next, quoteCode));
  }

  async function saveRateCard() {
    if (cardProposals.length === 0) {
      toast.error("Сначала получите курс с рынка");
      return;
    }
    setCardSaving(true);
    try {
      const result = await saas.approveExchangeRateCard(cardProposals);
      setRateCardMessage(result.message);
      toast.success("Курсы сохранены и активны");
      load();
    } catch (err) {
      if (!handle401(err)) toast.error("Не удалось сохранить курсы");
    } finally {
      setCardSaving(false);
    }
  }

  async function handleSaveRequisite(key: string) {
    const value = reqValues[key]?.trim() ?? "";
    if (!value) return;
    setSavingReqKey(key);
    try {
      await saas.saveExchangeRequisite(key, value);
      toast.success(`Реквизит сохранён: ${requisiteLabel(key)}`);
      setReqValues((prev) => ({ ...prev, [key]: "" }));
      const req = await saas.exchangeRequisites().catch(() => ({ items: savedRequisites }));
      setSavedRequisites(req.items);
    } catch (err) {
      if (!handle401(err)) toast.error("Не удалось сохранить реквизит");
    } finally {
      setSavingReqKey(null);
    }
  }

  async function patchOrder(id: number, patch: Parameters<typeof saas.updateExchangeOrder>[1]) {
    try {
      await saas.updateExchangeOrder(id, patch);
      toast.success("Заявка обновлена");
      load();
    } catch (err) {
      if (!handle401(err)) toast.error("Не удалось обновить заявку");
    }
  }

  async function runEval() {
    setExchangeEvalRunning(true);
    const tid = toast.loading("Прогон эмуляции качества…");
    try {
      const r = await saas.runExchangeEval(undefined, 6);
      setExchangeEval(r);
      toast.success(
        `Эмуляция: ${r.summary.passed}/${r.summary.total} сценариев прошли сквозняком`,
        {
          id: tid,
        },
      );
    } catch (err) {
      if (!handle401(err))
        toast.error("Не удалось прогнать эмуляцию (нужен chat-LLM у тенанта)", { id: tid });
    } finally {
      setExchangeEvalRunning(false);
    }
  }

  async function confirmPayment(id: number) {
    try {
      const r = await saas.confirmExchangePayment(id);
      toast.success(r.delivered ? "Оплата подтверждена, клиент уведомлён" : "Оплата подтверждена");
      load();
    } catch (err) {
      if (!handle401(err)) toast.error("Не удалось подтвердить оплату");
    }
  }

  async function issueCode(id: number, code: string) {
    try {
      const r = await saas.issueExchangePayoutCode(
        id,
        code.trim() ? { payoutCode: code.trim() } : { generate: true },
      );
      toast.success(
        r.delivered
          ? `Код ${r.payoutCode} отправлен клиенту`
          : `Код ${r.payoutCode} сохранён (клиенту не отправлен — нет активного канала)`,
      );
      load();
    } catch (err) {
      if (!handle401(err)) toast.error("Не удалось выдать код");
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <PageHeader title="Обменник" description="Курсы, заявки и оборот" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const visibleRequisites = savedRequisites.filter((r) => isRequisiteKey(r.key));
  const savedByKey = new Map(visibleRequisites.map((r) => [r.key, r]));

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        title="Обменник"
        description="Курсы по диапазонам, CRM заявок, оборот, реквизиты для приёма средств"
      />

      {turnover?.totals && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground">Оборот ({quoteCode})</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">
              {Math.round(turnover.totals.totalThb || 0).toLocaleString("ru-RU")}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground">Завершено сделок</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">
              {turnover.totals.completedCount || 0}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground">Активных заявок</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">
              {turnover.totals.openCount || 0}
            </CardContent>
          </Card>
        </div>
      )}

      <Tabs defaultValue="rates">
        <TabsList className="max-w-full justify-start overflow-x-auto">
          <TabsTrigger value="rates">Курсы</TabsTrigger>
          <TabsTrigger value="orders">Заявки</TabsTrigger>
          <TabsTrigger value="kyc">Клиенты (KYC)</TabsTrigger>
          <TabsTrigger value="requisites">Реквизиты</TabsTrigger>
          <TabsTrigger value="payout-points">Точки выдачи</TabsTrigger>
        </TabsList>

        {/* ── Курсы ─────────────────────────────────────────────── */}
        <TabsContent value="rates" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Обновление курсов с рынка</CardTitle>
              <p className="text-sm text-muted-foreground">
                Валюта выдачи — локальная валюта, в которой бот считает и выдаёт котировки (песо,
                баты…). После смены валюты пересоздайте курсы ниже через «Курсы обмена по
                диапазонам». Частота — как часто авто-курсы подтягиваются с рынка. Реальная цена
                меняется раз в ~10–15 мин, поэтому чаще обычно не нужно — настройка полезнее, чтобы
                обновлять реже (стабильнее котировки) под вашу пару.
              </p>
            </CardHeader>
            <CardContent className="flex flex-col items-stretch gap-4 sm:flex-row sm:flex-wrap sm:items-end">
              <div className="space-y-1.5 sm:w-auto">
                <Label>Валюта выдачи</Label>
                <Select
                  value={settings.quoteAsset ?? "PHP"}
                  onValueChange={(v) => setSettings((s) => ({ ...s, quoteAsset: v }))}
                >
                  <SelectTrigger className="w-full sm:w-64">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(settings.quoteAssetOptions ?? DEFAULT_QUOTE_ASSET_OPTIONS).map((code) => (
                      <SelectItem key={code} value={code}>
                        {QUOTE_ASSET_LABELS[code] ?? code}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5 sm:w-auto">
                <Label>Частота обновления</Label>
                <Select
                  value={String(settings.rateRefreshSec)}
                  onValueChange={(v) => {
                    const sec = Number(v);
                    setSettings((s) => ({
                      ...s,
                      rateRefreshSec: sec,
                      feedStaleSec:
                        s.feedStaleSec != null && s.feedStaleSec < sec ? null : s.feedStaleSec,
                    }));
                  }}
                >
                  <SelectTrigger className="w-full sm:w-44">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {REFRESH_PRESETS.map((p) => (
                      <SelectItem key={p.sec} value={String(p.sec)}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5 sm:w-auto">
                <Label>Порог «курсы устарели»</Label>
                <Select
                  value={settings.feedStaleSec == null ? "auto" : String(settings.feedStaleSec)}
                  onValueChange={(v) =>
                    setSettings((s) => ({ ...s, feedStaleSec: v === "auto" ? null : Number(v) }))
                  }
                >
                  <SelectTrigger className="w-full sm:w-44">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Авто (по частоте)</SelectItem>
                    {STALE_PRESETS.filter((p) => p.sec >= settings.rateRefreshSec).map((p) => (
                      <SelectItem key={p.sec} value={String(p.sec)}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-3 rounded-md border px-3 py-2 sm:max-w-xl">
                <Switch
                  checked={settings.handoffCustomerNotice}
                  onCheckedChange={(checked) =>
                    setSettings((s) => ({ ...s, handoffCustomerNotice: checked }))
                  }
                />
                <div className="space-y-0.5">
                  <Label>Писать клиенту при авто-передаче оператору</Label>
                  <p className="text-xs text-muted-foreground">
                    Если выключено, бот молча остановится, а оператор всё равно получит задачу.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3 rounded-md border px-3 py-2 sm:max-w-xl">
                <Switch
                  checked={settings.requireRateConfirmation ?? false}
                  onCheckedChange={(checked) =>
                    setSettings((s) => ({ ...s, requireRateConfirmation: checked }))
                  }
                />
                <div className="space-y-0.5">
                  <Label>Требовать подтверждение обновлений курса</Label>
                  <p className="text-xs text-muted-foreground">
                    Если включено, любое обновление курса от рынка попадёт в карточку «Обновлённые
                    курсы» и применится только после вашего подтверждения. По умолчанию мелкие
                    изменения применяются автоматически.
                  </p>
                </div>
              </div>
              <Button
                type="button"
                onClick={saveSettings}
                disabled={savingSettings}
                className="sm:w-auto"
              >
                <SaveIcon className="size-4" />
                {savingSettings ? "Сохранение…" : "Сохранить"}
              </Button>
            </CardContent>
          </Card>

          {pendingProposals.length > 0 && (
            <Card className="border-amber-500/50">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <AlertTriangleIcon className="size-4 text-amber-500" />
                  Обновлённые курсы — подтвердите
                </CardTitle>
                <p className="text-sm text-muted-foreground">
                  Рынок дал новые значения курса. До подтверждения бот считает по прежнему курсу.
                </p>
              </CardHeader>
              <CardContent className="space-y-2">
                {pendingProposals.map((p) => {
                  const dir = `${p.asset}${p.network ? ` (${p.network})` : ""} → ${p.quoteAsset}`;
                  const acting = proposalActing === p.id;
                  const up = p.deviationPct >= 0;
                  return (
                    <div
                      key={p.id}
                      className="flex flex-col gap-2 rounded-md border px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{dir}</span>
                          <Badge variant={p.severity === "hard" ? "destructive" : "outline"}>
                            {p.severity === "hard" ? "резкое" : "плавное"}
                          </Badge>
                        </div>
                        <p className="text-sm text-muted-foreground">
                          было {formatRate(p.prevBaseRate)} → стало{" "}
                          <span className={up ? "text-emerald-600" : "text-red-600"}>
                            {formatRate(p.nextBaseRate)} ({up ? "+" : ""}
                            {p.deviationPct.toFixed(2)}%)
                          </span>
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => confirmProposal(p.id)}
                          disabled={acting}
                        >
                          {acting ? (
                            <Loader2Icon className="size-4 animate-spin" />
                          ) : (
                            <CheckIcon className="size-4" />
                          )}
                          Подтвердить
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => rejectProposal(p.id)}
                          disabled={acting}
                        >
                          <XCircleIcon className="size-4" />
                          Отклонить
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Курсы обмена по диапазонам</CardTitle>
              <p className="text-sm text-muted-foreground">
                Актуальный курс берём с рынка (Binance + ЦБ) и авто-обновляем. Вы задаёте свои курсы
                по диапазонам сумм — отдельно для рублей и USDT (как на табло). Система сохраняет
                отклонение от рынка и обновляет значения вместе с рынком.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              {cardProposals.length === 0 ? (
                <div className="flex flex-col items-start gap-2">
                  <p className="text-sm text-muted-foreground">
                    {cardLoading
                      ? "Загружаем актуальный курс с рынка…"
                      : "Не удалось получить курс с рынка. Попробуйте ещё раз."}
                  </p>
                  <Button type="button" onClick={loadRateCard} disabled={cardLoading}>
                    <RefreshCwIcon className="size-4" />
                    {cardLoading ? "Загрузка…" : "Загрузить курс с рынка"}
                  </Button>
                </div>
              ) : (
                <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
                  <div className="space-y-4">
                    <RateCardEditor
                      proposals={cardProposals}
                      quoteCode={quoteCode}
                      onChange={updateRateCard}
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" onClick={saveRateCard} disabled={cardSaving}>
                        <SaveIcon className="size-4" />
                        {cardSaving ? "Сохраняем…" : "Сохранить курсы"}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={loadRateCard}
                        disabled={cardLoading}
                      >
                        <RefreshCwIcon className="size-4" />
                        {cardLoading ? "Обновляем…" : "Сбросить к рынку"}
                      </Button>
                    </div>
                  </div>
                  <pre className="max-h-[460px] overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-xs">
                    {rateCardMessage}
                  </pre>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Другие направления обмена (произвольные пары/сети) */}
          <Card>
            <CardHeader className="flex flex-col items-start gap-3 space-y-0 pb-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle className="text-base">Другие направления обмена</CardTitle>
                <p className="text-sm text-muted-foreground">
                  Любая пара помимо табло: USDT→RUB, BTC→{quoteCode}, EUR→{quoteCode} и т.д.
                </p>
              </div>
              {!addingRate && (
                <Button size="sm" onClick={() => setAddingRate(true)} className="w-full sm:w-auto">
                  <PlusIcon className="size-4" /> Добавить направление
                </Button>
              )}
            </CardHeader>
            {addingRate && (
              <CardContent className="space-y-3">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="space-y-1">
                    <Label className="text-xs">Отдаёт клиент</Label>
                    <Select
                      value={rateForm.asset}
                      onValueChange={(v) => setRateForm({ ...rateForm, asset: v })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ASSETS.map((a) => (
                          <SelectItem key={a} value={a}>
                            {a}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Получает клиент</Label>
                    <Select
                      value={rateForm.quoteAsset || quoteCode}
                      onValueChange={(v) => setRateForm({ ...rateForm, quoteAsset: v })}
                    >
                      <SelectTrigger className="min-w-[9.5rem]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ASSETS.map((a) => (
                          <SelectItem key={a} value={a}>
                            {a}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Сеть</Label>
                    <Select
                      value={rateForm.network || "none"}
                      onValueChange={(v) =>
                        setRateForm({ ...rateForm, network: v === "none" ? "" : v })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="—" />
                      </SelectTrigger>
                      <SelectContent>
                        {NETWORKS.map((n) => (
                          <SelectItem key={n || "none"} value={n || "none"}>
                            {n || "(нет)"}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Режим</Label>
                    <Select
                      value={rateForm.quoteMode ?? "multiply"}
                      onValueChange={(v) =>
                        setRateForm({ ...rateForm, quoteMode: v as "multiply" | "divide" })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="multiply">× умножение</SelectItem>
                        <SelectItem value="divide">÷ деление</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">
                      Курс {rateForm.autoUpdate ? "(стартовый)" : ""}
                    </Label>
                    <Input
                      type="number"
                      step="any"
                      value={rateForm.baseRate || ""}
                      placeholder={rateForm.autoUpdate ? "заполнит рынок" : "напр. 31.5"}
                      onChange={(e) =>
                        setRateForm({ ...rateForm, baseRate: Number(e.target.value) })
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Маржа, %</Label>
                    <Input
                      type="number"
                      step="any"
                      value={rateForm.marginPct ?? 0}
                      onChange={(e) =>
                        setRateForm({ ...rateForm, marginPct: Number(e.target.value) })
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Мин. сумма</Label>
                    <Input
                      type="number"
                      step="any"
                      value={rateForm.minAmountFrom ?? ""}
                      onChange={(e) =>
                        setRateForm({
                          ...rateForm,
                          minAmountFrom: e.target.value === "" ? null : Number(e.target.value),
                        })
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Макс. сумма</Label>
                    <Input
                      type="number"
                      step="any"
                      value={rateForm.maxAmountFrom ?? ""}
                      onChange={(e) =>
                        setRateForm({
                          ...rateForm,
                          maxAmountFrom: e.target.value === "" ? null : Number(e.target.value),
                        })
                      }
                    />
                  </div>
                </div>
                <div className="flex items-start gap-2 sm:items-center">
                  <Switch
                    id="rate-auto"
                    checked={!!rateForm.autoUpdate}
                    onCheckedChange={(v) => setRateForm({ ...rateForm, autoUpdate: v })}
                  />
                  <Label htmlFor="rate-auto" className="cursor-pointer text-sm">
                    Авто-курс с рынка (если пара торгуется на Binance/ЦБ)
                  </Label>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button onClick={saveRate} disabled={savingRate}>
                    <SaveIcon className="size-4" /> {savingRate ? "Сохраняем…" : "Сохранить"}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setAddingRate(false);
                      setRateForm(emptyRate(quoteCode));
                    }}
                  >
                    Отмена
                  </Button>
                </div>
              </CardContent>
            )}
          </Card>

          {/* Активные курсы (справочно) */}
          <Card>
            <CardHeader className="flex flex-col items-start gap-3 space-y-0 sm:flex-row sm:items-center sm:justify-between">
              <CardTitle className="text-base">Активные курсы</CardTitle>
              <Button
                variant="outline"
                size="sm"
                onClick={refreshRates}
                disabled={refreshing}
                className="w-full sm:w-auto"
              >
                <RefreshCwIcon className="size-4" /> Обновить с рынка
              </Button>
            </CardHeader>
            <CardContent className="p-0">
              <div className="space-y-2 px-4 pb-4 sm:hidden">
                {rates.length === 0 && (
                  <p className="rounded-lg border px-3 py-4 text-center text-sm text-muted-foreground">
                    Курсы не настроены — получите курс с рынка выше
                  </p>
                )}
                {rates.map((r) => (
                  <div key={r.id} className="rounded-lg border p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate font-medium">
                          {r.asset} → {r.quoteAsset}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {r.network || "сеть —"} · {r.quoteMode}
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => removeRate(r.id)}
                        className="size-8 shrink-0 p-0"
                        aria-label="Удалить курс"
                      >
                        <Trash2Icon className="size-4 text-destructive" />
                      </Button>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                      <div>
                        <div className="text-xs text-muted-foreground">Базовый</div>
                        <div className="font-medium">{r.baseRate}</div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">Маржа</div>
                        <div className="font-medium">{r.marginPct}%</div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">Авто</div>
                        {r.autoUpdate ? (
                          <Badge variant="success">рынок</Badge>
                        ) : (
                          <Badge variant="outline">ручной</Badge>
                        )}
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">Лимиты</div>
                        <div className="font-medium">
                          {r.minAmountFrom ?? "—"} / {r.maxAmountFrom ?? "—"}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="hidden sm:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Актив</TableHead>
                      <TableHead>Сеть</TableHead>
                      <TableHead>Режим</TableHead>
                      <TableHead>Базовый</TableHead>
                      <TableHead>Авто</TableHead>
                      <TableHead>Маржа %</TableHead>
                      <TableHead>Лимиты</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rates.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={8} className="text-center text-muted-foreground">
                          Курсы не настроены — получите курс с рынка выше
                        </TableCell>
                      </TableRow>
                    )}
                    {rates.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="font-medium">
                          {r.asset}→{r.quoteAsset}
                        </TableCell>
                        <TableCell>{r.network || "—"}</TableCell>
                        <TableCell>{r.quoteMode}</TableCell>
                        <TableCell>{r.baseRate}</TableCell>
                        <TableCell>
                          {r.autoUpdate ? (
                            <Badge variant="success">рынок</Badge>
                          ) : (
                            <Badge variant="outline">ручной</Badge>
                          )}
                        </TableCell>
                        <TableCell>{r.marginPct}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {r.minAmountFrom ?? "—"} / {r.maxAmountFrom ?? "—"}
                        </TableCell>
                        <TableCell>
                          <Button variant="ghost" size="sm" onClick={() => removeRate(r.id)}>
                            <Trash2Icon className="size-4 text-destructive" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Заявки ─────────────────────────────────────────────── */}
        <TabsContent value="orders" className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <CardTitle className="text-base">Заявки обмена</CardTitle>
                  <p className="text-muted-foreground text-xs">
                    Статус — короткий денежный lifecycle заявки. Шаг — бизнес-стадия полной 12-step
                    exchange funnel.
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={runEval}
                  disabled={exchangeEvalRunning}
                  title="Прогнать exchange-сценарии как живые LLM-диалоги и оценить сквозной поток"
                >
                  {exchangeEvalRunning ? (
                    <Loader2Icon className="size-4 animate-spin" />
                  ) : (
                    <RefreshCwIcon className="size-4" />
                  )}
                  {exchangeEvalRunning ? "Проверяем…" : "Эмуляция качества"}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>#</TableHead>
                    <TableHead>Направление</TableHead>
                    <TableHead>Сумма</TableHead>
                    <TableHead>{quoteCode}</TableHead>
                    <TableHead>Статус</TableHead>
                    <TableHead>Шаг</TableHead>
                    <TableHead>TG / Верификация</TableHead>
                    <TableHead>Оплата</TableHead>
                    <TableHead>Выдача</TableHead>
                    <TableHead>Действия</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {orders.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={10} className="text-center text-muted-foreground">
                        Заявок нет
                      </TableCell>
                    </TableRow>
                  )}
                  {orders.map((o) => (
                    <OrderRow
                      key={o.id}
                      order={o}
                      onPatch={patchOrder}
                      onIssueCode={issueCode}
                      onConfirmPayment={confirmPayment}
                    />
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {(exchangeEval || exchangeEvalRunning) && (
            <ExchangeEvalReportCard result={exchangeEval} running={exchangeEvalRunning} />
          )}
        </TabsContent>

        {/* ── Клиенты (KYC) ─────────────────────────────────────── */}
        <TabsContent value="kyc" className="space-y-4">
          <KycContactsCard />
        </TabsContent>

        {/* ── Реквизиты ──────────────────────────────────────────── */}
        <TabsContent value="requisites" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Реквизиты приёма</CardTitle>
              <p className="text-sm text-muted-foreground">
                Куда клиент отправляет средства. Бот выдаёт их автоматически (иначе — передача
                оператору). Значения шифруются.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              {visibleRequisites.length > 0 ? (
                <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  {visibleRequisites.map((r) => (
                    <li
                      key={r.key}
                      className="flex min-w-0 items-center gap-2 rounded-md border px-3 py-2 text-sm"
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
              ) : (
                <p className="text-sm text-muted-foreground">
                  Реквизиты ещё не добавлены — добавьте минимум один ниже.
                </p>
              )}

              <div className="grid gap-4 xl:grid-cols-2 2xl:grid-cols-3">
                {REQUISITE_GROUPS.map((group) => {
                  const groupHasSavedValue = group.fields.some((field) => {
                    const saved = savedByKey.get(field.key);
                    return Boolean(saved?.value || saved?.hasValue);
                  });
                  return (
                    <div key={group.title} className="space-y-3 rounded-md border p-4">
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-medium text-sm">{group.title}</div>
                        {groupHasSavedValue && <Badge variant="outline">сохранено</Badge>}
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                        {group.fields.map((item) => {
                          const saved = savedByKey.get(item.key);
                          const current = reqValues[item.key] ?? "";
                          return (
                            <div key={item.key} className="space-y-1.5">
                              <Label>{item.label}</Label>
                              <div className="flex items-start gap-2">
                                {item.multiline ? (
                                  <Textarea
                                    autoComplete="off"
                                    rows={4}
                                    value={current}
                                    onChange={(e) =>
                                      setReqValues((prev) => ({
                                        ...prev,
                                        [item.key]: e.target.value,
                                      }))
                                    }
                                    placeholder={
                                      saved?.sensitive && saved.hasValue
                                        ? "сохранено, введите новое для замены"
                                        : item.placeholder
                                    }
                                    className="min-h-[96px]"
                                  />
                                ) : (
                                  <Input
                                    autoComplete="off"
                                    type={item.secret ? "password" : "text"}
                                    value={current}
                                    onChange={(e) =>
                                      setReqValues((prev) => ({
                                        ...prev,
                                        [item.key]: e.target.value,
                                      }))
                                    }
                                    placeholder={
                                      saved?.sensitive && saved.hasValue
                                        ? "сохранено, введите новое для замены"
                                        : item.placeholder
                                    }
                                  />
                                )}
                                <Button
                                  type="button"
                                  onClick={() => handleSaveRequisite(item.key)}
                                  disabled={savingReqKey === item.key || !current.trim()}
                                >
                                  <SaveIcon className="size-4" />
                                  OK
                                </Button>
                              </div>
                              {item.hint && (
                                <p className="text-xs text-muted-foreground">{item.hint}</p>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Точки выдачи ──────────────────────────────────────── */}
        <TabsContent value="payout-points" className="space-y-4">
          <PayoutPointsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

const KIND_LABEL: Record<string, string> = {
  atm: "ATM",
  office: "Офис",
  courier_zone: "Курьер",
};

const EMPTY_POINT: PayoutPointInput = {
  kind: "atm",
  code: "",
  label: "",
  bankName: null,
  quoteAsset: "PHP",
  denomination: null,
  perWithdrawalMax: null,
  feeFixed: 0,
  feePct: 0,
  codeTtlSec: null,
  city: null,
  address: null,
  isActive: true,
};

function PayoutPointsTab() {
  const [points, setPoints] = useState<PayoutPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [editPoint, setEditPoint] = useState<PayoutPoint | null>(null);
  const [editForm, setEditForm] = useState<PayoutPointInput>(EMPTY_POINT);
  const [isNew, setIsNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [coveragePoint, setCoveragePoint] = useState<PayoutPoint | null>(null);
  const [coverage, setCoverage] = useState<PayoutCoverageOperator[]>([]);
  const [coverageLoading, setCoverageLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [viewMode, setViewMode] = useState<"list" | "map">("list");

  const load = () => {
    setLoading(true);
    saas
      .listPayoutPoints()
      .then((r) => setPoints(r.points))
      .catch(() => toast.error("Не удалось загрузить точки выдачи"))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const openNew = () => {
    setIsNew(true);
    setEditForm(EMPTY_POINT);
    setEditPoint({} as PayoutPoint);
  };

  const openEdit = (p: PayoutPoint) => {
    setIsNew(false);
    setEditForm({
      kind: p.kind,
      code: p.code,
      label: p.label,
      bankName: p.bankName,
      quoteAsset: p.quoteAsset,
      denomination: p.denomination,
      perWithdrawalMax: p.perWithdrawalMax,
      feeFixed: p.feeFixed,
      feePct: p.feePct,
      codeTtlSec: p.codeTtlSec,
      city: p.city,
      address: p.address,
      isActive: p.isActive,
    });
    setEditPoint(p);
  };

  const savePoint = async () => {
    setSaving(true);
    try {
      if (isNew) {
        await saas.createPayoutPoint(editForm);
        toast.success("Точка выдачи добавлена");
      } else if (editPoint?.id) {
        await saas.updatePayoutPoint(editPoint.id, editForm);
        toast.success("Точка обновлена");
      }
      setEditPoint(null);
      load();
    } catch {
      toast.error("Ошибка сохранения");
    } finally {
      setSaving(false);
    }
  };

  const deactivate = async (p: PayoutPoint) => {
    if (!confirm(`Деактивировать точку «${p.label}»?`)) return;
    try {
      await saas.deletePayoutPoint(p.id);
      toast.success("Деактивировано");
      load();
    } catch {
      toast.error("Ошибка");
    }
  };

  const openCoverage = async (p: PayoutPoint) => {
    setCoveragePoint(p);
    setCoverageLoading(true);
    try {
      const r = await saas.listPayoutCoverage(p.id);
      setCoverage(r.operators);
    } catch {
      toast.error("Не удалось загрузить операторов");
    } finally {
      setCoverageLoading(false);
    }
  };

  const toggleCoverage = async (op: PayoutCoverageOperator) => {
    if (!coveragePoint) return;
    try {
      if (op.covering) {
        await saas.removePayoutCoverage(coveragePoint.id, op.adminId);
      } else {
        await saas.addPayoutCoverage(coveragePoint.id, op.adminId);
      }
      const r = await saas.listPayoutCoverage(coveragePoint.id);
      setCoverage(r.operators);
    } catch {
      toast.error("Ошибка");
    }
  };

  const syncOsm = async () => {
    setSyncing(true);
    try {
      const r = await saas.syncOsmAtms();
      toast.success(
        `OSM синк: добавлено/обновлено ${r.upserted} из ${r.fetched} (пропущено ${r.skipped})`,
      );
      load();
    } catch {
      toast.error("Ошибка синхронизации OSM");
    } finally {
      setSyncing(false);
    }
  };

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Каталог точек выдачи</CardTitle>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant={viewMode === "map" ? "secondary" : "outline"}
              onClick={() => setViewMode((v) => (v === "list" ? "map" : "list"))}
            >
              <MapIcon className="mr-1 h-4 w-4" />
              {viewMode === "map" ? "Список" : "Карта"}
            </Button>
            <Button size="sm" variant="outline" onClick={syncOsm} disabled={syncing}>
              {syncing ? "Синхронизация…" : "Синк OSM"}
            </Button>
            <Button size="sm" onClick={openNew}>
              <PlusIcon className="mr-1 h-4 w-4" />
              Добавить
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-24 w-full" />
          ) : viewMode === "map" ? (
            <PayoutPointsMap points={points} />
          ) : points.length === 0 ? (
            <p className="text-sm text-muted-foreground">Точки выдачи не настроены.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Тип</TableHead>
                  <TableHead>Банк / Зона</TableHead>
                  <TableHead>Название</TableHead>
                  <TableHead>Валюта</TableHead>
                  <TableHead>Номинал</TableHead>
                  <TableHead>Лим./сн.</TableHead>
                  <TableHead>Комиссия</TableHead>
                  <TableHead>Город</TableHead>
                  <TableHead>Активна</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {points.map((p) => (
                  <TableRow key={p.id} className={!p.isActive ? "opacity-50" : undefined}>
                    <TableCell>
                      <Badge variant="outline">{KIND_LABEL[p.kind] ?? p.kind}</Badge>
                    </TableCell>
                    <TableCell className="text-sm">{p.bankName ?? "—"}</TableCell>
                    <TableCell className="font-medium">{p.label}</TableCell>
                    <TableCell>{p.quoteAsset}</TableCell>
                    <TableCell>{p.denomination ?? "—"}</TableCell>
                    <TableCell>{p.perWithdrawalMax?.toLocaleString() ?? "—"}</TableCell>
                    <TableCell>
                      {p.feeFixed > 0 ? `+${p.feeFixed}` : ""}
                      {p.feePct > 0 ? ` ${p.feePct}%` : ""}
                      {p.feeFixed === 0 && p.feePct === 0 ? "0" : ""}
                    </TableCell>
                    <TableCell>{p.city ?? "—"}</TableCell>
                    <TableCell>
                      <Switch
                        checked={p.isActive}
                        onCheckedChange={(v) =>
                          saas
                            .updatePayoutPoint(p.id, { isActive: v })
                            .then(load)
                            .catch(() => toast.error("Ошибка"))
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button size="sm" variant="ghost" onClick={() => openEdit(p)}>
                          Изм.
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => openCoverage(p)}>
                          Операторы
                        </Button>
                        {p.isActive && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-destructive"
                            onClick={() => deactivate(p)}
                          >
                            <Trash2Icon className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Диалог редактирования точки */}
      <Dialog open={editPoint != null} onOpenChange={(o) => !o && setEditPoint(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{isNew ? "Добавить точку выдачи" : "Редактировать точку"}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 pt-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Тип</Label>
                <Select
                  value={editForm.kind}
                  onValueChange={(v) =>
                    setEditForm((f) => ({ ...f, kind: v as PayoutPointInput["kind"] }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="atm">ATM (cardless)</SelectItem>
                    <SelectItem value="office">Офис</SelectItem>
                    <SelectItem value="courier_zone">Зона курьера</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Валюта выдачи</Label>
                <Select
                  value={editForm.quoteAsset}
                  onValueChange={(v) => setEditForm((f) => ({ ...f, quoteAsset: v }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {["PHP", "THB", "USD", "VND", "IDR"].map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Код (уникальный)</Label>
                <Input
                  value={editForm.code}
                  disabled={!isNew}
                  onChange={(e) => setEditForm((f) => ({ ...f, code: e.target.value }))}
                  placeholder="scb_asok"
                />
              </div>
              <div className="space-y-1">
                <Label>Банк / Провайдер</Label>
                <Input
                  value={editForm.bankName ?? ""}
                  onChange={(e) => setEditForm((f) => ({ ...f, bankName: e.target.value || null }))}
                  placeholder="SCB"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label>Название точки</Label>
              <Input
                value={editForm.label}
                onChange={(e) => setEditForm((f) => ({ ...f, label: e.target.value }))}
                placeholder="SCB Asok (BTS)"
              />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1">
                <Label>Номинал (шаг)</Label>
                <Input
                  type="number"
                  value={editForm.denomination ?? ""}
                  onChange={(e) =>
                    setEditForm((f) => ({
                      ...f,
                      denomination: e.target.value ? Number(e.target.value) : null,
                    }))
                  }
                  placeholder="500"
                />
              </div>
              <div className="space-y-1">
                <Label>Лимит снятия</Label>
                <Input
                  type="number"
                  value={editForm.perWithdrawalMax ?? ""}
                  onChange={(e) =>
                    setEditForm((f) => ({
                      ...f,
                      perWithdrawalMax: e.target.value ? Number(e.target.value) : null,
                    }))
                  }
                  placeholder="20000"
                />
              </div>
              <div className="space-y-1">
                <Label>TTL кода (сек)</Label>
                <Input
                  type="number"
                  value={editForm.codeTtlSec ?? ""}
                  onChange={(e) =>
                    setEditForm((f) => ({
                      ...f,
                      codeTtlSec: e.target.value ? Number(e.target.value) : null,
                    }))
                  }
                  placeholder="900"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Комиссия фикс.</Label>
                <Input
                  type="number"
                  value={editForm.feeFixed}
                  onChange={(e) => setEditForm((f) => ({ ...f, feeFixed: Number(e.target.value) }))}
                />
              </div>
              <div className="space-y-1">
                <Label>Комиссия %</Label>
                <Input
                  type="number"
                  value={editForm.feePct}
                  onChange={(e) => setEditForm((f) => ({ ...f, feePct: Number(e.target.value) }))}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Город</Label>
                <Input
                  value={editForm.city ?? ""}
                  onChange={(e) => setEditForm((f) => ({ ...f, city: e.target.value || null }))}
                  placeholder="Bangkok"
                />
              </div>
              <div className="space-y-1">
                <Label>Адрес</Label>
                <Input
                  value={editForm.address ?? ""}
                  onChange={(e) => setEditForm((f) => ({ ...f, address: e.target.value || null }))}
                  placeholder="Sukhumvit Soi 21"
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                checked={editForm.isActive}
                onCheckedChange={(v) => setEditForm((f) => ({ ...f, isActive: v }))}
              />
              <Label>Активна</Label>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setEditPoint(null)}>
                Отмена
              </Button>
              <Button onClick={savePoint} disabled={saving}>
                {saving ? <Loader2Icon className="mr-1 h-4 w-4 animate-spin" /> : null}
                Сохранить
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Диалог покрытия операторов */}
      <Dialog open={coveragePoint != null} onOpenChange={(o) => !o && setCoveragePoint(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Операторы: {coveragePoint?.label}</DialogTitle>
          </DialogHeader>
          {coverageLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : coverage.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Нет операторов (нет записей в operator_settings).
            </p>
          ) : (
            <div className="space-y-2 pt-1">
              {coverage.map((op) => (
                <div
                  key={op.adminId}
                  className="flex items-center justify-between rounded border px-3 py-2"
                >
                  <div>
                    <p className="text-sm font-medium">{op.name ?? op.email}</p>
                    {op.name && <p className="text-xs text-muted-foreground">{op.email}</p>}
                  </div>
                  <Switch checked={op.covering} onCheckedChange={() => toggleCoverage(op)} />
                </div>
              ))}
              <p className="text-xs text-muted-foreground pt-1">
                Включённые операторы получают хэндофф выдачи через эту точку.
              </p>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── ATM dot-map (SVG, no external lib) ────────────────────────────────────────

const BANK_COLORS: Record<string, string> = {
  BDO: "#2563eb",
  BPI: "#16a34a",
  Metrobank: "#dc2626",
  UnionBank: "#ea580c",
  Landbank: "#92400e",
  PNB: "#7c3aed",
  RCBC: "#0891b2",
  EastWest: "#db2777",
  Chinabank: "#d97706",
  "Security Bank": "#059669",
  PSBank: "#4f46e5",
  HSBC: "#b91c1c",
  AUB: "#0369a1",
  "Bank of Commerce": "#854d0e",
  Citibank: "#1d4ed8",
  "Robinsons Bank": "#15803d",
  DBP: "#6d28d9",
  UCPB: "#be185d",
};

function PayoutPointsMap({ points }: { points: PayoutPoint[] }) {
  const [hovered, setHovered] = useState<PayoutPoint | null>(null);

  const geoPoints = points.filter((p) => p.lat != null && p.lng != null);

  if (geoPoints.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Нет точек с координатами — запустите «Синк OSM».
      </p>
    );
  }

  const lats = geoPoints.map((p) => p.lat!);
  const lngs = geoPoints.map((p) => p.lng!);
  const pad = 0.008;
  const minLat = Math.min(...lats) - pad;
  const maxLat = Math.max(...lats) + pad;
  const minLng = Math.min(...lngs) - pad;
  const maxLng = Math.max(...lngs) + pad;

  const W = 700;
  const H = 480;
  const toX = (lng: number) => ((lng - minLng) / (maxLng - minLng)) * W;
  const toY = (lat: number) => H - ((lat - minLat) / (maxLat - minLat)) * H;
  const getColor = (bank: string | null) => BANK_COLORS[bank ?? ""] ?? "#6b7280";

  const banks = [
    ...new Set(geoPoints.map((p) => p.bankName).filter((b): b is string => b != null)),
  ];

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-md border bg-muted/30">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-[440px] w-full">
          {Array.from({ length: 6 }, (_, i) => (
            <line
              key={`h${i}`}
              x1={0}
              y1={((i + 1) * H) / 7}
              x2={W}
              y2={((i + 1) * H) / 7}
              stroke="#e2e8f0"
              strokeWidth={0.6}
            />
          ))}
          {Array.from({ length: 8 }, (_, i) => (
            <line
              key={`v${i}`}
              x1={((i + 1) * W) / 9}
              y1={0}
              x2={((i + 1) * W) / 9}
              y2={H}
              stroke="#e2e8f0"
              strokeWidth={0.6}
            />
          ))}
          {geoPoints.map((p) => (
            <circle
              key={p.id}
              cx={toX(p.lng!)}
              cy={toY(p.lat!)}
              r={5}
              fill={getColor(p.bankName)}
              fillOpacity={p.isActive ? 0.88 : 0.28}
              stroke="white"
              strokeWidth={1}
              style={{ cursor: "pointer" }}
              onMouseEnter={() => setHovered(p)}
              onMouseLeave={() => setHovered(null)}
            />
          ))}
          {hovered &&
            (() => {
              const cx = toX(hovered.lng!);
              const cy = toY(hovered.lat!);
              const tw = 210;
              const th = 56;
              const tx = cx + tw + 14 > W ? cx - tw - 8 : cx + 8;
              const ty = Math.max(4, Math.min(cy - th / 2, H - th - 4));
              const bankLine = (hovered.bankName ?? hovered.label).slice(0, 30);
              const labelLine = hovered.label.slice(0, 32);
              return (
                <g pointerEvents="none">
                  <rect
                    x={tx}
                    y={ty}
                    width={tw}
                    height={th}
                    rx={4}
                    fill="white"
                    stroke="#cbd5e1"
                    strokeWidth={1}
                  />
                  <text x={tx + 8} y={ty + 18} fontSize={11} fill="#0f172a" fontWeight="600">
                    {bankLine}
                  </text>
                  <text x={tx + 8} y={ty + 32} fontSize={10} fill="#475569">
                    {labelLine}
                  </text>
                  {hovered.city && (
                    <text x={tx + 8} y={ty + 46} fontSize={9} fill="#94a3b8">
                      {hovered.city}
                    </text>
                  )}
                </g>
              );
            })()}
        </svg>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {banks.map((bank) => {
          const count = geoPoints.filter((p) => p.bankName === bank).length;
          return (
            <div key={bank} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span
                className="inline-block h-2.5 w-2.5 flex-shrink-0 rounded-full"
                style={{ background: getColor(bank) }}
              />
              {bank} <span className="font-medium text-foreground">({count})</span>
            </div>
          );
        })}
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="inline-block h-2.5 w-2.5 flex-shrink-0 rounded-full bg-[#6b7280]" />
          Прочие ({geoPoints.filter((p) => !p.bankName || !BANK_COLORS[p.bankName]).length})
        </div>
      </div>
    </div>
  );
}

function ExchangeEvalReportCard({
  result,
  running,
}: {
  result: ExchangeEvalResult | null;
  running: boolean;
}) {
  const failed = result ? result.summary.total - result.summary.passed : 0;
  const allPassed = Boolean(result && failed === 0);

  return (
    <Card
      className={
        allPassed ? "border-[var(--success)]/40" : failed > 0 ? "border-destructive/40" : undefined
      }
    >
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              {running ? (
                <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
              ) : allPassed ? (
                <CheckCircleIcon className="size-4 text-[var(--success)]" />
              ) : (
                <AlertTriangleIcon className="size-4 text-destructive" />
              )}
              Отчёт эмуляции качества
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              Live self-play сценарии exchange: курс, реквизиты и преждевременный handoff.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant={allPassed ? "success" : failed > 0 ? "destructive" : "outline"}>
              {result ? `${result.summary.passed}/${result.summary.total} passed` : "running"}
            </Badge>
            {result && (
              <Badge variant={failed > 0 ? "destructive" : "outline"}>{failed} failed</Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Сценарий</TableHead>
              <TableHead>Итог</TableHead>
              <TableHead>Причины</TableHead>
              <TableHead>Сигналы</TableHead>
              <TableHead className="text-right">Диалог</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {running && !result && (
              <TableRow>
                <TableCell colSpan={5} className="py-6 text-center text-sm text-muted-foreground">
                  Сценарии выполняются синхронно, отчёт появится после завершения прогона
                </TableCell>
              </TableRow>
            )}
            {result?.report.map((item) => (
              <TableRow key={item.id}>
                <TableCell className="max-w-[240px]">
                  <div className="truncate text-sm font-medium">{item.displayName}</div>
                  <div className="mt-1 font-mono text-[11px] text-muted-foreground">{item.id}</div>
                </TableCell>
                <TableCell>
                  <Badge variant={item.passed ? "success" : "destructive"} className="gap-1">
                    {item.passed ? (
                      <CheckCircleIcon className="size-3.5" />
                    ) : (
                      <XCircleIcon className="size-3.5" />
                    )}
                    {item.passed ? "pass" : "fail"}
                  </Badge>
                </TableCell>
                <TableCell className="max-w-[300px] text-xs">
                  {item.error ? (
                    <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-destructive">
                      {item.error}
                    </div>
                  ) : item.reasons && item.reasons.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {item.reasons.map((reason) => (
                        <Badge key={reason} variant="destructive" className="font-normal">
                          {reason}
                        </Badge>
                      ))}
                    </div>
                  ) : (
                    <span className="text-muted-foreground">критичных причин нет</span>
                  )}
                </TableCell>
                <TableCell>
                  <ExchangeEvalSignals signals={item.signals} />
                </TableCell>
                <TableCell className="text-right">
                  {item.conversationId ? (
                    <Button asChild size="sm" variant="ghost" className="h-8 px-2 text-xs">
                      <Link to={`/conversations/${item.conversationId}`}>Открыть</Link>
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function ExchangeEvalSignals({
  signals,
}: {
  signals?: ExchangeEvalResult["report"][number]["signals"];
}) {
  if (!signals) return <span className="text-xs text-muted-foreground">нет данных</span>;

  return (
    <div className="flex max-w-[360px] flex-wrap gap-1">
      <SignalBadge ok={signals.reachedQuote} label="курс" />
      <SignalBadge ok={signals.requisitesIssued} label="реквизиты" />
      <SignalBadge ok={signals.payoutDelivered} label="выдача" neutral />
      <SignalBadge ok={!signals.prematureOperator} label="handoff" />
      {signals.orderStatus && <Badge variant="outline">order: {signals.orderStatus}</Badge>}
      {signals.assistantTurns !== undefined && (
        <Badge variant="secondary">{signals.assistantTurns} turns</Badge>
      )}
    </div>
  );
}

function SignalBadge({
  ok,
  label,
  neutral = false,
}: {
  ok: boolean;
  label: string;
  neutral?: boolean;
}) {
  return (
    <Badge variant={neutral ? "outline" : ok ? "success" : "destructive"} className="gap-1">
      {ok ? <CheckCircleIcon className="size-3" /> : <XCircleIcon className="size-3" />}
      {label}
    </Badge>
  );
}

function OrderRow({
  order,
  onPatch,
  onIssueCode,
  onConfirmPayment,
}: {
  order: ExchangeOrder;
  onPatch: (id: number, patch: Parameters<typeof saas.updateExchangeOrder>[1]) => void;
  onIssueCode: (id: number, code: string) => void;
  onConfirmPayment: (id: number) => void;
}) {
  const [code, setCode] = useState(order.payoutCode ?? "");
  const [verif, setVerif] = useState(order.verificationId ?? "");
  const [sourceBank, setSourceBank] = useState(order.sourceBank ?? "");
  return (
    <TableRow>
      <TableCell>{order.id}</TableCell>
      <TableCell className="font-medium">
        {order.direction}
        {order.network ? ` (${order.network})` : ""}
      </TableCell>
      <TableCell>
        <div>
          {order.amountFrom} {order.assetFrom}
        </div>
        {order.amountMode === "target_thb" && (
          <div className="text-[10px] text-muted-foreground">
            запрошено {order.requestedAmount} {order.direction?.split("->")[1] ?? ""}
          </div>
        )}
      </TableCell>
      <TableCell>{order.amountToThb}</TableCell>
      <TableCell>
        <Badge variant={STATUS_VARIANT[order.status] ?? "secondary"}>{order.status}</Badge>
      </TableCell>
      <TableCell className="max-w-36 text-xs">
        <Badge variant="outline">{order.workflowStage?.label ?? "—"}</Badge>
        {order.workflowStage?.slug && (
          <div className="mt-1 text-[10px] text-muted-foreground">{order.workflowStage.slug}</div>
        )}
      </TableCell>
      <TableCell className="text-xs">
        <div>{order.telegramId ?? "—"}</div>
        <Input
          className="mt-1 h-7 w-32"
          value={verif}
          onChange={(e) => setVerif(e.target.value)}
          onBlur={() =>
            verif !== (order.verificationId ?? "") && onPatch(order.id, { verificationId: verif })
          }
          placeholder="ID верифик."
        />
      </TableCell>
      <TableCell className="text-xs">
        <Select
          value={order.paymentMethod ?? "none"}
          onValueChange={(v) => onPatch(order.id, { paymentMethod: v === "none" ? null : v })}
        >
          <SelectTrigger className="h-7 w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">оплата —</SelectItem>
            <SelectItem value="crypto_transfer">crypto</SelectItem>
            <SelectItem value="sbp_qr">SBP QR</SelectItem>
            <SelectItem value="card_transfer">карта</SelectItem>
            <SelectItem value="bank_transfer">банк</SelectItem>
            <SelectItem value="cash">нал</SelectItem>
          </SelectContent>
        </Select>
        <Input
          className="mt-1 h-7 w-36"
          value={sourceBank}
          onChange={(e) => setSourceBank(e.target.value)}
          onBlur={() =>
            sourceBank !== (order.sourceBank ?? "") &&
            onPatch(order.id, { sourceBank: sourceBank || null })
          }
          placeholder="банк-источник"
        />
      </TableCell>
      <TableCell className="text-xs">
        <Select
          value={order.payoutMethod ?? "none"}
          onValueChange={(v) => onPatch(order.id, { payoutMethod: v === "none" ? null : v })}
        >
          <SelectTrigger className="h-7 w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">выдача —</SelectItem>
            <SelectItem value="courier_cash">курьер</SelectItem>
            <SelectItem value="cardless_atm">cardless ATM</SelectItem>
            <SelectItem value="thai_bank_transfer">Перевод на банк</SelectItem>
            <SelectItem value="office_cash">офис</SelectItem>
            <SelectItem value="atm">ATM legacy</SelectItem>
          </SelectContent>
        </Select>
        <Input
          className="mt-1 h-7 w-28"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onBlur={() =>
            code !== (order.payoutCode ?? "") && onPatch(order.id, { payoutCode: code })
          }
          placeholder="Код выдачи"
        />
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="mt-1 h-7 w-28 text-[11px]"
          onClick={() => onIssueCode(order.id, code)}
          title="Сохранить код, перевести в «выдача» и отправить клиенту в чат"
        >
          {code.trim() ? "Выдать клиенту" : "🎲 Сген. и выдать"}
        </Button>
      </TableCell>
      <TableCell>
        <Select
          value={order.status || "quote"}
          onValueChange={(v) => onPatch(order.id, { status: v })}
        >
          <SelectTrigger className="h-8 w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[
              "quote",
              "awaiting_payment",
              "paid",
              "payout",
              "completed",
              "cancelled",
              "expired",
            ].map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {order.status === "awaiting_payment" && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="mt-1 h-7 w-36 text-[11px]"
            onClick={() => onConfirmPayment(order.id)}
            title="Подтвердить оплату (фиат) — перевести в paid и уведомить клиента"
          >
            ✅ Подтвердить оплату
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}

// ── Клиенты (KYC) — реестр верификаций (#511) ──────────────────────────────

const KYC_STATUS_RU: Record<
  string,
  { label: string; variant: "success" | "warning" | "destructive" | "secondary" }
> = {
  verified: { label: "Верифицирован", variant: "success" },
  documents_received: { label: "Прислал документы", variant: "warning" },
  materials_requested: { label: "Ждём материалы", variant: "warning" },
  pending_review: { label: "На проверке", variant: "warning" },
  rejected: { label: "Отклонён", variant: "destructive" },
  unknown: { label: "—", variant: "secondary" },
};

function KycContactsCard() {
  const [items, setItems] = useState<ExchangeKycContact[]>([]);
  const [query, setQuery] = useState("");
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  const load = (q?: string, offset = 0, append = false) => {
    setLoading(true);
    saas
      .exchangeKycContacts({ q, limit: 50, offset })
      .then((r) => {
        setItems((prev) => (append ? [...prev, ...r.contacts] : r.contacts));
        setNextOffset(r.nextOffset);
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : "Не удалось загрузить KYC-реестр"))
      .finally(() => setLoading(false));
  };

  // Подгрузка при открытии вкладки; поиск — по Enter/кнопке.
  useEffect(() => {
    load();
  }, []);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">KYC: верификации и документы</CardTitle>
            <p className="text-muted-foreground text-xs">
              Статус живёт на клиенте, а не на заявке: повторные обмены проходят без нового KYC.
              «Прислал документы» — OCR распознал паспорт, решения оператора ещё нет (подтверждение
              — в оператор-боте).
            </p>
          </div>
          <div className="flex gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && load(query)}
              placeholder="Имя, паспорт, ID…"
              className="h-8 w-48 text-sm"
            />
            <Button type="button" size="sm" variant="outline" onClick={() => load(query)}>
              <RefreshCwIcon className="size-4" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Клиент</TableHead>
              <TableHead>Паспорт (OCR)</TableHead>
              <TableHead>Статус</TableHead>
              <TableHead>ID верификации</TableHead>
              <TableHead>Проверен</TableHead>
              <TableHead className="text-right">Заявок</TableHead>
              <TableHead className="text-right">Оборот</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && (
              <TableRow>
                <TableCell colSpan={7}>
                  <Skeleton className="h-5 w-full" />
                </TableCell>
              </TableRow>
            )}
            {!loading && items.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground">
                  Пока никто не проходил верификацию
                </TableCell>
              </TableRow>
            )}
            {!loading &&
              items.map((it) => {
                const st = KYC_STATUS_RU[it.status] ?? KYC_STATUS_RU.unknown!;
                return (
                  <TableRow key={it.contactId}>
                    <TableCell className="font-medium">
                      {it.displayName ?? `Контакт #${it.contactId}`}
                    </TableCell>
                    <TableCell>
                      {it.passportName || it.passportNumberMasked ? (
                        <div className="text-sm">
                          <span>{it.passportName ?? "—"}</span>{" "}
                          {it.passportNumberMasked && (
                            <span className="text-muted-foreground font-mono text-xs">
                              {it.passportNumberMasked}
                            </span>
                          )}
                          {it.passportExpiry && (
                            <span className="text-muted-foreground text-xs">
                              {" "}
                              до {it.passportExpiry}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-muted-foreground text-xs">нет данных</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={st.variant}>{st.label}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{it.verificationId ?? "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {it.reviewedAt
                        ? new Date(it.reviewedAt * 1000).toLocaleString("ru-RU", {
                            day: "2-digit",
                            month: "2-digit",
                            year: "2-digit",
                            hour: "2-digit",
                            minute: "2-digit",
                          })
                        : "—"}
                      {it.reviewedByAdminId ? ` · admin #${it.reviewedByAdminId}` : ""}
                    </TableCell>
                    <TableCell className="text-right">{it.ordersCount}</TableCell>
                    <TableCell className="text-right font-medium">
                      {it.turnoverThb.toLocaleString("ru-RU")}
                    </TableCell>
                  </TableRow>
                );
              })}
          </TableBody>
        </Table>
        {nextOffset !== null && (
          <div className="border-t p-3 text-center">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={() => load(query, nextOffset, true)}
            >
              Загрузить ещё
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

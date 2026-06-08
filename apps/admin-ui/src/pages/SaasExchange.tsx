import { CheckIcon, PlusIcon, RefreshCwIcon, SaveIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  ApiError,
  clearToken,
  type ExchangeOrder,
  type ExchangeRate,
  type ExchangeRateCardProposal,
  type ExchangeRateInput,
  type ExchangeSettings,
  type ExchangeTurnover,
  saas,
} from "@/api/saas";
import { PageHeader } from "@/components/page-header";
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

// Активы и сети для произвольных направлений обмена (не только табло RUB/USDT→THB).
const ASSETS = ["USDT", "USDC", "BTC", "ETH", "LTC", "TRX", "TON", "RUB", "EUR", "USD", "THB"];
const NETWORKS = ["", "trc20", "erc20", "bep20", "ton", "solana", "tron"];

const EMPTY_RATE: ExchangeRateInput = {
  asset: "USDT",
  quoteAsset: "RUB",
  network: "trc20",
  baseRate: 0,
  quoteMode: "multiply",
  marginPct: 0,
  isActive: true,
  autoUpdate: false,
};

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

/** Типы реквизитов и настроек приёма (ключи tenant_secrets) — те же, что в онбординге. */
const REQUISITE_TYPES: { key: string; label: string; placeholder: string; secret?: boolean }[] = [
  { key: "exchange_wallet_usdt_trc20", label: "USDT TRC20 — адрес", placeholder: "T..." },
  { key: "exchange_wallet_usdt_erc20", label: "USDT ERC20 — адрес", placeholder: "0x..." },
  { key: "exchange_wallet_usdt_bep20", label: "USDT BEP20 / BSC — адрес", placeholder: "0x..." },
  { key: "exchange_wallet_usdt_ton", label: "USDT TON — адрес", placeholder: "UQ..." },
  { key: "exchange_wallet_usdt_ton_memo", label: "USDT TON — memo/comment", placeholder: "12345 или comment" },
  { key: "exchange_wallet_usdt_solana", label: "USDT Solana — адрес", placeholder: "solana address" },
  { key: "exchange_wallet_usdc_erc20", label: "USDC ERC20 — адрес", placeholder: "0x..." },
  { key: "exchange_wallet_usdc_solana", label: "USDC Solana — адрес", placeholder: "solana address" },
  { key: "exchange_wallet_btc_default", label: "BTC — адрес", placeholder: "bc1..." },
  { key: "exchange_wallet_eth_erc20", label: "ETH ERC20 — адрес", placeholder: "0x..." },
  { key: "exchange_wallet_ltc_default", label: "LTC — адрес", placeholder: "ltc1..." },
  { key: "exchange_wallet_trx_tron", label: "TRX Tron — адрес", placeholder: "T..." },
  { key: "exchange_wallet_ton_ton", label: "TON — адрес", placeholder: "UQ..." },
  { key: "exchange_wallet_ton_ton_memo", label: "TON — memo/comment", placeholder: "12345 или comment" },
  { key: "exchange_binance_id", label: "Binance ID / Pay ID", placeholder: "123456789" },
  { key: "exchange_bybit_uid", label: "Bybit UID", placeholder: "123456789" },
  { key: "exchange_htx_uid", label: "HTX UID", placeholder: "123456789" },
  { key: "exchange_fiat_payment_url", label: "СБП / платёжная ссылка RUB", placeholder: "https://..." },
  { key: "exchange_rub_card_requisites", label: "RUB карта / телефон", placeholder: "2200... / +7..." },
  { key: "exchange_payout_methods", label: "Выдача THB: банки / наличные", placeholder: "Bangkok Bank, Kasikorn, cash..." },
  { key: "exchange_kyc_policy", label: "AML/KYC правила", placeholder: "AML до 60%, KYC по паспорту..." },
  { key: "exchange_operator_contact", label: "Контакт оператора", placeholder: "@operator / WhatsApp / Line" },
  { key: "exchange_office_address", label: "Адрес офиса", placeholder: "Phuket, ..." },
  { key: "exchange_working_hours", label: "Часы работы", placeholder: "10:00-22:00 Bangkok" },
  { key: "exchange_westwallet_api_key", label: "WestWallet public API key", placeholder: "public key", secret: true },
  { key: "exchange_westwallet_secret_key", label: "WestWallet private API key", placeholder: "private key", secret: true },
  {
    key: "exchange_westwallet_ipn_url",
    label: "WestWallet IPN URL",
    placeholder: "https://your-domain/webhook/westwallet/tenantId",
  },
  { key: "exchange_westwallet_success_url", label: "WestWallet success URL", placeholder: "https://..." },
];

/** Ключи, которые относятся к экрану реквизитов/настроек обменника. */
function isRequisiteKey(key: string): boolean {
  return (
    key.startsWith("exchange_wallet_") ||
    REQUISITE_TYPES.some((t) => t.key === key)
  );
}

/** Человекочитаемая подпись реквизита по ключу. */
function requisiteLabel(key: string): string {
  const known = REQUISITE_TYPES.find((t) => t.key === key);
  if (known) return known.label;
  const m = /^exchange_wallet_(.+)$/.exec(key);
  if (m) return `Кошелёк ${m[1].replace(/_/g, " ").toUpperCase()}`;
  return key;
}

function formatRate(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function renderRange(min: number, max: number | null): string {
  const fmt = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  if (max === null) return `от${fmt(min)} бат`;
  return `от${fmt(min)} до${fmt(max)} бат`;
}

function renderRateCardMessage(proposals: ExchangeRateCardProposal[]): string {
  const rub = proposals.find((p) => p.asset === "RUB");
  const usdt = proposals.find((p) => p.asset === "USDT");
  const lines = ["🙏 АКТУАЛЬНЫЙ КУРС НА СЕГОДНЯ 🙏", ""];
  if (rub) {
    rub.tiers.forEach((tier, idx) => {
      const marker = idx === 0 ? ">" : idx === 1 ? "-" : "<";
      lines.push(
        `🇷🇺RUB // Баты - ${formatRate(tier.displayRate)} ${marker} (${renderRange(tier.minThb, tier.maxThb)}🇹🇭`,
      );
    });
    lines.push("***", "", "🏪💲———💳💳 💰 💳💳———💲🏪", "");
  }
  if (usdt) {
    usdt.tiers.forEach((tier) => {
      lines.push(
        `💲USDT // Баты < ${formatRate(tier.displayRate)} - (${renderRange(tier.minThb, tier.maxThb)})🇹🇭`,
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

/** Пересчёт отклонения тира от рынка (%, 2 знака). */
function calcDeviation(displayRate: number, marketRate: number): number {
  return marketRate > 0 && Number.isFinite(displayRate)
    ? Math.round(((displayRate - marketRate) / marketRate) * 10000) / 100
    : 0;
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
const DEFAULT_SETTINGS: ExchangeSettings = { rateRefreshSec: 180, feedStaleSec: null };

export function SaasExchange() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [rates, setRates] = useState<ExchangeRate[]>([]);
  const [orders, setOrders] = useState<ExchangeOrder[]>([]);
  const [turnover, setTurnover] = useState<ExchangeTurnover | null>(null);

  // Курсы — тир-карта от рыночного фида (RUB + USDT), редактируемая
  const [cardProposals, setCardProposals] = useState<ExchangeRateCardProposal[]>([]);
  const [cardLoading, setCardLoading] = useState(false);
  const [cardSaving, setCardSaving] = useState(false);
  const [rateCardMessage, setRateCardMessage] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [settings, setSettings] = useState<ExchangeSettings>(DEFAULT_SETTINGS);
  const [savingSettings, setSavingSettings] = useState(false);

  // Произвольное направление обмена (помимо табло RUB/USDT→THB)
  const [addingRate, setAddingRate] = useState(false);
  const [rateForm, setRateForm] = useState<ExchangeRateInput>(EMPTY_RATE);
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
    ])
      .then(([r, o, t, req, st]) => {
        setRates(r.rates);
        setOrders(o.orders);
        setTurnover(t);
        setSavedRequisites(req.items);
        setSettings(st);
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
      setRateForm(EMPTY_RATE);
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

  async function saveSettings() {
    setSavingSettings(true);
    try {
      const r = await saas.saveExchangeSettings(settings);
      setSettings(r.settings);
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

  /** Патч одного тира (курс/мин/макс). При смене курса пересчитывает отклонение и формулу. */
  function patchTier(
    pIdx: number,
    tIdx: number,
    patch: Partial<{ minThb: number; maxThb: number | null; displayRate: number }>,
  ) {
    setCardProposals((prev) => {
      const next = prev.map((p, i) => {
        if (i !== pIdx) return p;
        const tiers = p.tiers.map((t, j) => {
          if (j !== tIdx) return t;
          const merged = { ...t, ...patch };
          if (patch.displayRate !== undefined) {
            const dev = calcDeviation(merged.displayRate, p.marketRate);
            merged.deviationPct = dev;
            merged.formula = `${formatRate(p.marketRate)} ${dev >= 0 ? "+" : "-"} ${formatRate(Math.abs(dev))}% = ${formatRate(merged.displayRate)}`;
          }
          return merged;
        });
        return { ...p, tiers };
      });
      setRateCardMessage(renderRateCardMessage(next));
      return next;
    });
  }

  /** Добавить строку диапазона снизу (своя шкала). */
  function addTier(pIdx: number) {
    setCardProposals((prev) => {
      const next = prev.map((p, i) => {
        if (i !== pIdx) return p;
        const last = p.tiers[p.tiers.length - 1];
        const minThb = last ? (last.maxThb ?? last.minThb + 1000) : 0;
        const displayRate = last ? last.displayRate : p.marketRate;
        return {
          ...p,
          tiers: [
            ...p.tiers,
            {
              minThb,
              maxThb: null,
              displayRate,
              deviationPct: calcDeviation(displayRate, p.marketRate),
              formula: "",
            },
          ],
        };
      });
      setRateCardMessage(renderRateCardMessage(next));
      return next;
    });
  }

  function removeTier(pIdx: number, tIdx: number) {
    setCardProposals((prev) => {
      const next = prev.map((p, i) =>
        i === pIdx ? { ...p, tiers: p.tiers.filter((_, j) => j !== tIdx) } : p,
      );
      setRateCardMessage(renderRateCardMessage(next));
      return next;
    });
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
    const tid = toast.loading("Прогон эмуляции качества…");
    try {
      const r = await saas.runExchangeEval(undefined, 6);
      toast.success(`Эмуляция: ${r.summary.passed}/${r.summary.total} сценариев прошли сквозняком`, {
        id: tid,
      });
      // Детали по сценариям — в консоли (pass/fail + причины).
      console.table(
        r.report.map((x) => ({
          scenario: x.id,
          passed: x.passed,
          reasons: (x.reasons ?? []).join("; "),
          error: x.error ?? "",
        })),
      );
    } catch (err) {
      if (!handle401(err))
        toast.error("Не удалось прогнать эмуляцию (нужен chat-LLM у тенанта)", { id: tid });
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
    <div className="space-y-6">
      <PageHeader
        title="Обменник"
        description="Курсы по диапазонам, CRM заявок, оборот, реквизиты для приёма средств"
      />

      {turnover?.totals && (
        <div className="grid grid-cols-3 gap-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground">Оборот (THB)</CardTitle>
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
        <TabsList>
          <TabsTrigger value="rates">Курсы</TabsTrigger>
          <TabsTrigger value="orders">Заявки</TabsTrigger>
          <TabsTrigger value="requisites">Реквизиты</TabsTrigger>
        </TabsList>

        {/* ── Курсы ─────────────────────────────────────────────── */}
        <TabsContent value="rates" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Обновление курсов с рынка</CardTitle>
              <p className="text-sm text-muted-foreground">
                Как часто авто-курсы подтягиваются с рынка. Реальная цена меняется раз в
                ~10–15 мин, поэтому чаще обычно не нужно — настройка полезнее, чтобы обновлять
                реже (стабильнее котировки) под вашу пару.
              </p>
            </CardHeader>
            <CardContent className="flex flex-wrap items-end gap-4">
              <div className="space-y-1.5">
                <Label>Частота обновления</Label>
                <Select
                  value={String(settings.rateRefreshSec)}
                  onValueChange={(v) => {
                    const sec = Number(v);
                    setSettings((s) => ({
                      rateRefreshSec: sec,
                      feedStaleSec:
                        s.feedStaleSec != null && s.feedStaleSec < sec ? null : s.feedStaleSec,
                    }));
                  }}
                >
                  <SelectTrigger className="w-44">
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
              <div className="space-y-1.5">
                <Label>Порог «курсы устарели»</Label>
                <Select
                  value={settings.feedStaleSec == null ? "auto" : String(settings.feedStaleSec)}
                  onValueChange={(v) =>
                    setSettings((s) => ({ ...s, feedStaleSec: v === "auto" ? null : Number(v) }))
                  }
                >
                  <SelectTrigger className="w-44">
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
              <Button type="button" onClick={saveSettings} disabled={savingSettings}>
                <SaveIcon className="size-4" />
                {savingSettings ? "Сохранение…" : "Сохранить"}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Курсы обмена по диапазонам</CardTitle>
              <p className="text-sm text-muted-foreground">
                Актуальный курс берём с рынка (Binance + ЦБ) и авто-обновляем. Вы задаёте свои курсы
                по диапазонам сумм — отдельно для рублей и USDT (как на табло). Бот выдаёт клиенту
                ровно эти значения.
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
                <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
                  <div className="space-y-4">
                    {cardProposals.map((p, pIdx) => (
                      <div key={p.asset} className="rounded-lg border">
                        <div className="flex items-center justify-between border-b px-3 py-2">
                          <span className="text-sm font-medium">
                            {p.asset === "RUB"
                              ? "🇷🇺 RUB → THB"
                              : p.asset === "USDT"
                                ? "💲 USDT → THB"
                                : `${p.asset} → THB`}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            рынок: {p.marketRate}{" "}
                            {p.quoteMode === "divide" ? `${p.asset}/THB` : `THB/${p.asset}`}
                          </span>
                        </div>
                        <div className="grid grid-cols-[1fr_1fr_5rem_3rem_1.5rem] gap-2 px-3 py-1.5 text-xs text-muted-foreground">
                          <span>от (THB)</span>
                          <span>до (THB)</span>
                          <span>курс</span>
                          <span className="text-right">откл.</span>
                          <span />
                        </div>
                        {p.tiers.map((t, tIdx) => (
                          <div
                            // biome-ignore lint/suspicious/noArrayIndexKey: строки переупорядочиваемы пользователем
                            key={`${p.asset}-${tIdx}`}
                            className="grid grid-cols-[1fr_1fr_5rem_3rem_1.5rem] items-center gap-2 border-t px-3 py-1.5"
                          >
                            <Input
                              className="h-8"
                              type="number"
                              step="any"
                              value={Number.isFinite(t.minThb) ? t.minThb : ""}
                              onChange={(e) =>
                                patchTier(pIdx, tIdx, { minThb: Number.parseFloat(e.target.value) })
                              }
                            />
                            <Input
                              className="h-8"
                              type="number"
                              step="any"
                              placeholder="∞"
                              value={t.maxThb ?? ""}
                              onChange={(e) =>
                                patchTier(pIdx, tIdx, {
                                  maxThb:
                                    e.target.value.trim() === ""
                                      ? null
                                      : Number.parseFloat(e.target.value),
                                })
                              }
                            />
                            <Input
                              className="h-8"
                              type="number"
                              step="any"
                              value={Number.isFinite(t.displayRate) ? t.displayRate : ""}
                              onChange={(e) =>
                                patchTier(pIdx, tIdx, {
                                  displayRate: Number.parseFloat(e.target.value),
                                })
                              }
                            />
                            <span className="text-right text-xs text-muted-foreground">
                              {t.deviationPct > 0 ? "+" : ""}
                              {t.deviationPct}%
                            </span>
                            <button
                              type="button"
                              onClick={() => removeTier(pIdx, tIdx)}
                              aria-label="Удалить строку"
                              className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                            >
                              ✕
                            </button>
                          </div>
                        ))}
                        <div className="border-t px-3 py-1.5">
                          <button
                            type="button"
                            onClick={() => addTier(pIdx)}
                            className="text-sm text-primary hover:underline"
                          >
                            + Добавить диапазон
                          </button>
                        </div>
                      </div>
                    ))}
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
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
              <div>
                <CardTitle className="text-base">Другие направления обмена</CardTitle>
                <p className="text-sm text-muted-foreground">
                  Любая пара помимо табло: USDT→RUB, BTC→THB, EUR→THB и т.д.
                </p>
              </div>
              {!addingRate && (
                <Button size="sm" onClick={() => setAddingRate(true)}>
                  <PlusIcon className="size-4" /> Добавить направление
                </Button>
              )}
            </CardHeader>
            {addingRate && (
              <CardContent className="space-y-3">
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
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
                      value={rateForm.quoteAsset || "THB"}
                      onValueChange={(v) => setRateForm({ ...rateForm, quoteAsset: v })}
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
                <div className="flex items-center gap-2">
                  <Switch
                    id="rate-auto"
                    checked={!!rateForm.autoUpdate}
                    onCheckedChange={(v) => setRateForm({ ...rateForm, autoUpdate: v })}
                  />
                  <Label htmlFor="rate-auto" className="cursor-pointer text-sm">
                    Авто-курс с рынка (если пара торгуется на Binance/ЦБ)
                  </Label>
                </div>
                <div className="flex gap-2">
                  <Button onClick={saveRate} disabled={savingRate}>
                    <SaveIcon className="size-4" /> {savingRate ? "Сохраняем…" : "Сохранить"}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setAddingRate(false);
                      setRateForm(EMPTY_RATE);
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
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">Активные курсы</CardTitle>
              <Button variant="outline" size="sm" onClick={refreshRates} disabled={refreshing}>
                <RefreshCwIcon className="size-4" /> Обновить с рынка
              </Button>
            </CardHeader>
            <CardContent className="p-0">
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
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Заявки ─────────────────────────────────────────────── */}
        <TabsContent value="orders">
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
                  title="Прогнать exchange-сценарии как живые LLM-диалоги и оценить сквозной поток"
                >
                  ▶ Эмуляция качества
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
                    <TableHead>THB</TableHead>
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
                <ul className="space-y-1.5">
                  {visibleRequisites.map((r) => (
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
              ) : (
                <p className="text-sm text-muted-foreground">
                  Реквизиты ещё не добавлены — добавьте минимум один ниже.
                </p>
              )}

              <div className="grid gap-3 lg:grid-cols-2">
                {REQUISITE_TYPES.map((item) => {
                  const saved = savedByKey.get(item.key);
                  const current = reqValues[item.key] ?? "";
                  const hasSavedValue = Boolean(saved?.value || saved?.hasValue);
                  return (
                    <div key={item.key} className="space-y-1.5 rounded-md border p-3">
                      <div className="flex items-center justify-between gap-2">
                        <Label>{item.label}</Label>
                        {hasSavedValue && <Badge variant="outline">сохранено</Badge>}
                      </div>
                      <div className="flex gap-2">
                        <Input
                          autoComplete="off"
                          type={item.secret ? "password" : "text"}
                          value={current}
                          onChange={(e) =>
                            setReqValues((prev) => ({ ...prev, [item.key]: e.target.value }))
                          }
                          placeholder={
                            saved?.sensitive && saved.hasValue
                              ? "сохранено, введите новое для замены"
                              : item.placeholder
                          }
                        />
                        <Button
                          type="button"
                          onClick={() => handleSaveRequisite(item.key)}
                          disabled={savingReqKey === item.key || !current.trim()}
                        >
                          <SaveIcon className="size-4" />
                          OK
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
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
            запрошено {order.requestedAmount} THB
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
          <SelectTrigger className="h-7 w-36">
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
          <SelectTrigger className="h-7 w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">выдача —</SelectItem>
            <SelectItem value="courier_cash">курьер</SelectItem>
            <SelectItem value="cardless_atm">cardless ATM</SelectItem>
            <SelectItem value="thai_bank_transfer">Thai bank</SelectItem>
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

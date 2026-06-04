import { CheckIcon, RefreshCwIcon, SaveIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  ApiError,
  clearToken,
  type ExchangeOrder,
  type ExchangeRate,
  type ExchangeRateCardProposal,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

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

/** Типы реквизитов приёма (ключи tenant_secrets) — те же, что в онбординге. */
const REQUISITE_TYPES: { key: string; label: string; placeholder: string }[] = [
  { key: "exchange_wallet_usdt_trc20", label: "USDT TRC20 — адрес кошелька", placeholder: "T..." },
  { key: "exchange_wallet_usdt_erc20", label: "USDT ERC20 — адрес", placeholder: "0x..." },
  { key: "exchange_wallet_btc_default", label: "BTC — адрес", placeholder: "bc1..." },
  { key: "exchange_wallet_eth_erc20", label: "ETH ERC20 — адрес", placeholder: "0x..." },
  { key: "exchange_binance_id", label: "Binance ID (P2P)", placeholder: "123456789" },
  {
    key: "exchange_fiat_payment_url",
    label: "СБП / платёжная ссылка (RUB)",
    placeholder: "https://...",
  },
  {
    key: "exchange_rub_card_requisites",
    label: "Карта / телефон для RUB",
    placeholder: "2200… / +7…",
  },
];

/** Только ключи-реквизиты приёма (кошельки + фиксированные платёжные). */
function isRequisiteKey(key: string): boolean {
  return (
    key.startsWith("exchange_wallet_") ||
    ["exchange_binance_id", "exchange_fiat_payment_url", "exchange_rub_card_requisites"].includes(
      key,
    )
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

  // Реквизиты
  const [savedRequisites, setSavedRequisites] = useState<Array<{ key: string; value: string }>>([]);
  const [reqType, setReqType] = useState(REQUISITE_TYPES[0]!.key);
  const [reqValue, setReqValue] = useState("");
  const [savingReq, setSavingReq] = useState(false);

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
    ])
      .then(([r, o, t, req]) => {
        setRates(r.rates);
        setOrders(o.orders);
        setTurnover(t);
        setSavedRequisites(req.items);
      })
      .catch((err) => {
        if (!handle401(err)) toast.error("Не удалось загрузить данные обменника");
      })
      .finally(() => setLoading(false));
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => load(), []);

  async function removeRate(id: number) {
    try {
      await saas.deleteExchangeRate(id);
      load();
    } catch (err) {
      if (!handle401(err)) toast.error("Не удалось удалить курс");
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

  async function handleSaveRequisite() {
    if (!reqValue.trim()) return;
    setSavingReq(true);
    try {
      await saas.saveExchangeRequisite(reqType, reqValue.trim());
      toast.success(`Реквизит сохранён: ${requisiteLabel(reqType)}`);
      setReqValue("");
      const req = await saas.exchangeRequisites().catch(() => ({ items: savedRequisites }));
      setSavedRequisites(req.items);
    } catch (err) {
      if (!handle401(err)) toast.error("Не удалось сохранить реквизит");
    } finally {
      setSavingReq(false);
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

  if (loading) {
    return (
      <div className="space-y-4">
        <PageHeader title="Обменник" description="Курсы, заявки и оборот" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const visibleRequisites = savedRequisites.filter((r) => isRequisiteKey(r.key));

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
              <CardTitle className="text-base">Курсы обмена по диапазонам</CardTitle>
              <p className="text-sm text-muted-foreground">
                Актуальный курс берём с рынка (Binance + ЦБ) и авто-обновляем. Вы задаёте свои курсы
                по диапазонам сумм — отдельно для рублей и USDT (как на табло). Бот выдаёт клиенту
                ровно эти значения.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              {cardProposals.length === 0 ? (
                <Button type="button" onClick={loadRateCard} disabled={cardLoading}>
                  <RefreshCwIcon className="size-4" />
                  {cardLoading ? "Получаем курс…" : "Получить актуальный курс с рынка"}
                </Button>
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
              <CardTitle className="text-base">Заявки обмена</CardTitle>
              <p className="text-muted-foreground text-xs">
                Статус — короткий денежный lifecycle заявки. Шаг — бизнес-стадия полной 12-step
                exchange funnel.
              </p>
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
                    <OrderRow key={o.id} order={o} onPatch={patchOrder} />
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
                        title={r.value}
                      >
                        {r.value}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Реквизиты ещё не добавлены — добавьте минимум один ниже.
                </p>
              )}

              <div className="grid gap-3 sm:grid-cols-2">
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
                    value={reqValue}
                    onChange={(e) => setReqValue(e.target.value)}
                    placeholder={
                      REQUISITE_TYPES.find((t) => t.key === reqType)?.placeholder ?? "значение"
                    }
                  />
                </div>
                <div className="sm:col-span-2">
                  <Button onClick={handleSaveRequisite} disabled={savingReq || !reqValue.trim()}>
                    <SaveIcon className="size-4" />
                    {savingReq ? "Сохраняем…" : "Добавить реквизит"}
                  </Button>
                </div>
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
}: {
  order: ExchangeOrder;
  onPatch: (id: number, patch: Parameters<typeof saas.updateExchangeOrder>[1]) => void;
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
      </TableCell>
    </TableRow>
  );
}

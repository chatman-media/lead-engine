import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ApiError,
  clearToken,
  type ExchangeOrder,
  type ExchangeRate,
  type ExchangeRateInput,
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
import { PlusIcon, RefreshCwIcon, SaveIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";

const ASSETS = ["USDT", "BTC", "ETH", "RUB", "EUR", "USD"];
const NETWORKS = ["", "trc20", "erc20", "bep20"];

const STATUS_VARIANT: Record<string, "default" | "secondary" | "success" | "warning" | "destructive" | "outline"> = {
  quote: "secondary",
  awaiting_payment: "warning",
  paid: "default",
  payout: "default",
  completed: "success",
  cancelled: "destructive",
  expired: "destructive",
};

const EMPTY_RATE: ExchangeRateInput = {
  asset: "USDT",
  network: "trc20",
  baseRate: 0,
  quoteMode: "multiply",
  marginPct: 0,
  feeFixedThb: 0,
  isActive: true,
  autoUpdate: false,
};

export function SaasExchange() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [rates, setRates] = useState<ExchangeRate[]>([]);
  const [orders, setOrders] = useState<ExchangeOrder[]>([]);
  const [turnover, setTurnover] = useState<ExchangeTurnover | null>(null);
  const [form, setForm] = useState<ExchangeRateInput>(EMPTY_RATE);
  const [saving, setSaving] = useState(false);

  // requisites
  const [reqAsset, setReqAsset] = useState("usdt");
  const [reqNetwork, setReqNetwork] = useState("trc20");
  const [reqWallet, setReqWallet] = useState("");
  const [fiatUrl, setFiatUrl] = useState("");

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
    Promise.all([saas.exchangeRates(), saas.exchangeOrders(), saas.exchangeTurnover()])
      .then(([r, o, t]) => {
        setRates(r.rates);
        setOrders(o.orders);
        setTurnover(t);
      })
      .catch((err) => {
        if (!handle401(err)) toast.error("Не удалось загрузить данные обменника");
      })
      .finally(() => setLoading(false));
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => load(), []);

  async function saveRate() {
    if (!form.asset || (!form.autoUpdate && !(form.baseRate > 0))) {
      toast.error("Укажите актив и положительный базовый курс (или включите авто-курс)");
      return;
    }
    setSaving(true);
    try {
      await saas.saveExchangeRate(form);
      toast.success("Курс сохранён");
      setForm(EMPTY_RATE);
      load();
    } catch (err) {
      if (!handle401(err)) toast.error("Ошибка сохранения курса");
    } finally {
      setSaving(false);
    }
  }

  async function removeRate(id: number) {
    try {
      await saas.deleteExchangeRate(id);
      load();
    } catch (err) {
      if (!handle401(err)) toast.error("Не удалось удалить курс");
    }
  }

  const [refreshing, setRefreshing] = useState(false);
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

  async function saveWallet() {
    if (!reqWallet.trim()) return;
    const key = `exchange_wallet_${reqAsset}_${reqNetwork || "default"}`;
    try {
      await saas.saveExchangeRequisite(key, reqWallet.trim());
      toast.success(`Кошелёк сохранён (${key})`);
      setReqWallet("");
    } catch (err) {
      if (!handle401(err)) toast.error("Не удалось сохранить кошелёк");
    }
  }

  async function saveFiatUrl() {
    if (!fiatUrl.trim()) return;
    try {
      await saas.saveExchangeRequisite("exchange_fiat_payment_url", fiatUrl.trim());
      toast.success("Платёжная ссылка сохранена");
      setFiatUrl("");
    } catch (err) {
      if (!handle401(err)) toast.error("Не удалось сохранить ссылку");
    }
  }

  async function patchOrder(
    id: number,
    patch: Parameters<typeof saas.updateExchangeOrder>[1],
  ) {
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

  return (
    <div className="space-y-6">
      <PageHeader
        title="Обменник"
        description="Курсы и формулы, CRM заявок, оборот, реквизиты для оплаты"
      />

      {turnover && (
        <div className="grid grid-cols-3 gap-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground">Оборот (THB)</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">
              {Math.round(turnover.totals.totalThb).toLocaleString("ru-RU")}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground">Завершено сделок</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{turnover.totals.completedCount}</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground">Активных заявок</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{turnover.totals.openCount}</CardContent>
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
              <CardTitle className="text-base">Добавить / обновить курс</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <div className="space-y-1">
                <Label>Актив</Label>
                <Select value={form.asset} onValueChange={(v) => setForm({ ...form, asset: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ASSETS.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Сеть</Label>
                <Select value={form.network || ""} onValueChange={(v) => setForm({ ...form, network: v })}>
                  <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
                  <SelectContent>
                    {NETWORKS.map((n) => <SelectItem key={n || "none"} value={n}>{n || "(нет)"}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Режим</Label>
                <Select
                  value={form.quoteMode ?? "multiply"}
                  onValueChange={(v) => setForm({ ...form, quoteMode: v as "multiply" | "divide" })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="multiply">multiply (крипта: ×)</SelectItem>
                    <SelectItem value="divide">divide (RUB: ÷)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Базовый курс {form.autoUpdate ? "(стартовый, обновит рынок)" : ""}</Label>
                <Input
                  type="number"
                  step="any"
                  value={form.baseRate || ""}
                  placeholder={form.autoUpdate ? "0 — заполнит фид" : ""}
                  onChange={(e) => setForm({ ...form, baseRate: Number(e.target.value) })}
                />
              </div>
              <div className="flex items-center gap-2 self-end pb-2">
                <Switch
                  checked={!!form.autoUpdate}
                  onCheckedChange={(v) => setForm({ ...form, autoUpdate: v })}
                />
                <Label className="cursor-pointer">Авто-курс с рынка</Label>
              </div>
              <div className="space-y-1">
                <Label>Маржа, %</Label>
                <Input
                  type="number"
                  step="any"
                  value={form.marginPct ?? 0}
                  onChange={(e) => setForm({ ...form, marginPct: Number(e.target.value) })}
                />
              </div>
              <div className="space-y-1">
                <Label>Фикс. комиссия THB</Label>
                <Input
                  type="number"
                  step="any"
                  value={form.feeFixedThb ?? 0}
                  onChange={(e) => setForm({ ...form, feeFixedThb: Number(e.target.value) })}
                />
              </div>
              <div className="space-y-1">
                <Label>Мин. сумма</Label>
                <Input
                  type="number"
                  step="any"
                  value={form.minAmountFrom ?? ""}
                  onChange={(e) =>
                    setForm({ ...form, minAmountFrom: e.target.value === "" ? null : Number(e.target.value) })
                  }
                />
              </div>
              <div className="space-y-1">
                <Label>Макс. сумма</Label>
                <Input
                  type="number"
                  step="any"
                  value={form.maxAmountFrom ?? ""}
                  onChange={(e) =>
                    setForm({ ...form, maxAmountFrom: e.target.value === "" ? null : Number(e.target.value) })
                  }
                />
              </div>
              <div className="col-span-2 md:col-span-4">
                <Button onClick={saveRate} disabled={saving}>
                  <PlusIcon className="size-4" /> Сохранить курс
                </Button>
              </div>
            </CardContent>
          </Card>

          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={refreshRates} disabled={refreshing}>
              <RefreshCwIcon className="size-4" /> Обновить курсы сейчас
            </Button>
          </div>
          <Card>
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
                    <TableHead>Комиссия</TableHead>
                    <TableHead>Лимиты</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rates.length === 0 && (
                    <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground">Курсы не настроены</TableCell></TableRow>
                  )}
                  {rates.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium">{r.asset}→{r.quoteAsset}</TableCell>
                      <TableCell>{r.network || "—"}</TableCell>
                      <TableCell>{r.quoteMode}</TableCell>
                      <TableCell>{r.baseRate}</TableCell>
                      <TableCell>
                        {r.autoUpdate ? <Badge variant="success">рынок</Badge> : <Badge variant="outline">ручной</Badge>}
                      </TableCell>
                      <TableCell>{r.marginPct}</TableCell>
                      <TableCell>{r.feeFixedThb}</TableCell>
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
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>#</TableHead>
                    <TableHead>Направление</TableHead>
                    <TableHead>Сумма</TableHead>
                    <TableHead>THB</TableHead>
                    <TableHead>Статус</TableHead>
                    <TableHead>TG / Верификация</TableHead>
                    <TableHead>Выдача</TableHead>
                    <TableHead>Действия</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {orders.length === 0 && (
                    <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground">Заявок нет</TableCell></TableRow>
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
            <CardHeader><CardTitle className="text-base">Крипто-кошелёк</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <div className="space-y-1">
                <Label>Актив</Label>
                <Select value={reqAsset} onValueChange={setReqAsset}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {["usdt", "btc", "eth"].map((a) => <SelectItem key={a} value={a}>{a.toUpperCase()}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Сеть</Label>
                <Select value={reqNetwork} onValueChange={setReqNetwork}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {["trc20", "erc20", "bep20"].map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="col-span-2 space-y-1">
                <Label>Адрес кошелька</Label>
                <Input value={reqWallet} onChange={(e) => setReqWallet(e.target.value)} placeholder="TEwydv6i...vNuA" />
              </div>
              <div className="col-span-2 md:col-span-4">
                <Button onClick={saveWallet}><SaveIcon className="size-4" /> Сохранить кошелёк</Button>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-base">Платёжная ссылка (СБП, фиат)</CardTitle></CardHeader>
            <CardContent className="flex items-end gap-3">
              <div className="flex-1 space-y-1">
                <Label>URL</Label>
                <Input value={fiatUrl} onChange={(e) => setFiatUrl(e.target.value)} placeholder="https://arbi.exchange/exchange-payments/..." />
              </div>
              <Button onClick={saveFiatUrl}><SaveIcon className="size-4" /> Сохранить</Button>
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
  return (
    <TableRow>
      <TableCell>{order.id}</TableCell>
      <TableCell className="font-medium">{order.direction}{order.network ? ` (${order.network})` : ""}</TableCell>
      <TableCell>{order.amountFrom} {order.assetFrom}</TableCell>
      <TableCell>{order.amountToThb}</TableCell>
      <TableCell><Badge variant={STATUS_VARIANT[order.status] ?? "secondary"}>{order.status}</Badge></TableCell>
      <TableCell className="text-xs">
        <div>{order.telegramId ?? "—"}</div>
        <Input
          className="mt-1 h-7 w-32"
          value={verif}
          onChange={(e) => setVerif(e.target.value)}
          onBlur={() => verif !== (order.verificationId ?? "") && onPatch(order.id, { verificationId: verif })}
          placeholder="ID верифик."
        />
      </TableCell>
      <TableCell className="text-xs">
        <div>{order.payoutMethod ?? "—"} {order.payoutLocation ?? ""}</div>
        <Input
          className="mt-1 h-7 w-28"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onBlur={() => code !== (order.payoutCode ?? "") && onPatch(order.id, { payoutCode: code })}
          placeholder="Код выдачи"
        />
      </TableCell>
      <TableCell>
        <Select value={order.status} onValueChange={(v) => onPatch(order.id, { status: v })}>
          <SelectTrigger className="h-8 w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            {["quote", "awaiting_payment", "paid", "payout", "completed", "cancelled", "expired"].map((s) => (
              <SelectItem key={s} value={s}>{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableCell>
    </TableRow>
  );
}

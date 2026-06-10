import {
  CheckCircle2Icon,
  ClipboardListIcon,
  PowerIcon,
  RefreshCwIcon,
  SendIcon,
  UserPlusIcon,
  XCircleIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  ApiError,
  type ProviderOrderDetail,
  type ProviderOrderListItem,
  type ProviderOrderProviderOption,
  type ProviderOrderStatus,
  type ProviderRequestStatus,
  type ProviderRelayOps,
  saas,
} from "@/api/saas";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const ORDER_STATUS_LABEL: Record<ProviderOrderStatus, string> = {
  intake: "Новая",
  matching: "Подбор",
  awaiting_provider: "Ждём провайдера",
  provider_declined: "Отказ провайдера",
  offer_ready: "Оффер готов",
  awaiting_customer_payment: "Ждём оплату",
  paid: "Оплачено",
  confirmed: "Подтверждено",
  fulfilled: "Выполнено",
  cancelled: "Отменено",
  failed: "Ошибка",
};

const REQUEST_STATUS_LABEL: Record<ProviderRequestStatus, string> = {
  draft: "Черновик",
  sent: "Отправлен",
  seen: "Просмотрен",
  quoted: "Котировка",
  accepted: "Принят",
  declined: "Отказ",
  expired: "Истёк",
  cancelled: "Отменён",
  failed: "Ошибка",
};

function statusVariant(status: string): "default" | "secondary" | "outline" | "success" | "warning" | "destructive" {
  if (["fulfilled", "paid", "confirmed", "accepted"].includes(status)) return "success";
  if (["offer_ready", "awaiting_customer_payment", "quoted", "sent", "seen"].includes(status)) return "warning";
  if (["cancelled", "failed", "provider_declined", "declined", "expired"].includes(status)) return "destructive";
  if (["matching", "awaiting_provider"].includes(status)) return "default";
  return "secondary";
}

function formatMoney(value: number | null, currency: string): string {
  if (value === null || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDate(epoch: number | null): string {
  if (!epoch) return "—";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(epoch * 1000);
}

function slaText(sla: ProviderOrderListItem["sla"]): string {
  if (!sla.dueAt) return "без SLA";
  if (sla.state === "breached") return "просрочен";
  const minutes = Math.max(0, Math.round((sla.secondsLeft ?? 0) / 60));
  if (minutes < 60) return `${minutes} мин`;
  return `${Math.round(minutes / 60)} ч`;
}

function eventLabel(value: string): string {
  return value.replace(/_/g, " ");
}

function providerLabel(provider: ProviderOrderProviderOption): string {
  const service = provider.services[0];
  const area = service?.serviceArea ?? provider.serviceArea;
  return [provider.name, service?.name, area].filter(Boolean).join(" · ");
}

function relaySourceLabel(source: ProviderRelayOps["settings"]["source"]): string {
  return source === "flag" ? "tenant flag" : "default";
}

function actionErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.errorCode === "provider_relay_disabled") {
    return "Provider relay выключен. Включите его в блоке «Provider relay» выше.";
  }
  return err instanceof Error ? err.message : "Действие не выполнено";
}

export function SaasProviderOrders() {
  const [orders, setOrders] = useState<ProviderOrderListItem[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ProviderOrderDetail | null>(null);
  const [providers, setProviders] = useState<ProviderOrderProviderOption[]>([]);
  const [ops, setOps] = useState<ProviderRelayOps | null>(null);
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [providerMessage, setProviderMessage] = useState("");
  const [offerText, setOfferText] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [opsLoading, setOpsLoading] = useState(true);
  const [opsUpdating, setOpsUpdating] = useState(false);
  const [action, setAction] = useState<string | null>(null);

  const selectedOrder = useMemo(
    () => orders.find((order) => order.id === selectedId) ?? null,
    [orders, selectedId],
  );

  const loadOrders = useCallback(async () => {
    setLoading(true);
    try {
      const res = await saas.listProviderOrders({ limit: 100 });
      setOrders(res.items);
      setSelectedId((current) => current ?? res.items[0]?.id ?? null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось загрузить заказы");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadOps = useCallback(async () => {
    setOpsLoading(true);
    try {
      setOps(await saas.getProviderOrderOps());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось загрузить rollout status");
      setOps(null);
    } finally {
      setOpsLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (id: number) => {
    setDetailLoading(true);
    try {
      const next = await saas.getProviderOrder(id);
      setDetail(next);
      setSelectedProviderId(next.provider?.id ? String(next.provider.id) : "");
      const providerRes = await saas.listProviderOrderProviders(next.order.requestType);
      setProviders(providerRes.items);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось загрузить заказ");
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadOrders();
  }, [loadOrders]);

  useEffect(() => {
    void loadOps();
  }, [loadOps]);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  async function refreshCurrent() {
    await Promise.all([loadOrders(), loadOps()]);
    if (selectedId) await loadDetail(selectedId);
  }

  async function runAction(name: string, fn: () => Promise<void>) {
    setAction(name);
    try {
      await fn();
      await refreshCurrent();
    } catch (err) {
      if (err instanceof ApiError && err.errorCode === "provider_relay_disabled") {
        void loadOps();
      }
      toast.error(actionErrorMessage(err));
    } finally {
      setAction(null);
    }
  }

  async function toggleProviderRelay(enabled: boolean) {
    setOpsUpdating(true);
    try {
      const res = await saas.updateProviderOrderOpsSettings(enabled);
      setOps((current) =>
        current
          ? { ...current, settings: res.settings }
          : {
              settings: res.settings,
              metrics: {
                generatedAt: 0,
                ordersCreated: 0,
                ordersByStatus: {},
                providerRequestsSent: 0,
                providerRequestsByStatus: {},
                providerResponseRatePct: null,
                avgTimeToQuoteSec: null,
                paidOrders: 0,
                commissionAmountTotal: 0,
                paidCommissionAmount: 0,
                failuresByChannel: {},
                failedDispatches: 0,
                stuckOrders: { count: 0, items: [] },
              },
            },
      );
      toast.success(enabled ? "Provider relay включён" : "Provider relay выключен");
      await refreshCurrent();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось обновить provider relay");
    } finally {
      setOpsUpdating(false);
    }
  }

  const activeQuote = detail?.providerRequests.find((request) =>
    ["quoted", "accepted"].includes(request.status),
  );
  const latestRequest = detail?.providerRequests[0] ?? null;
  const providerId = selectedProviderId ? Number(selectedProviderId) : null;
  const relayDisabled = ops?.settings.enabled === false;
  const relayActionsDisabled = relayDisabled || action !== null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Заказы"
        description="Операторская консоль для брокерских заявок, провайдеров и клиентских офферов."
        actions={
          <Button variant="outline" onClick={() => void refreshCurrent()} disabled={loading}>
            <RefreshCwIcon className={cn("size-4", loading && "animate-spin")} />
            Обновить
          </Button>
        }
      />

      <Card className={cn(relayDisabled && "border-warning/50 bg-warning/5")}>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-sm">
              <PowerIcon className="size-4 text-muted-foreground" />
              Provider relay
              {ops && (
                <Badge variant={ops.settings.enabled ? "success" : "warning"}>
                  {ops.settings.enabled ? "включён" : "выключен"}
                </Badge>
              )}
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Управляет отправкой запросов провайдерам, офферами клиентам и статусными
              переходами брокерских заказов.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {opsLoading ? "загрузка" : ops?.settings.enabled ? "on" : "off"}
            </span>
            <Switch
              checked={ops?.settings.enabled ?? false}
              disabled={opsLoading || opsUpdating}
              onCheckedChange={(checked) => void toggleProviderRelay(checked)}
              aria-label="Provider relay rollout"
            />
          </div>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-4">
          <Metric label="Источник" value={ops ? relaySourceLabel(ops.settings.source) : "—"} />
          <Metric label="Запросов" value={String(ops?.metrics.providerRequestsSent ?? "—")} />
          <Metric
            label="Ответы"
            value={
              ops?.metrics.providerResponseRatePct !== null &&
              ops?.metrics.providerResponseRatePct !== undefined
                ? `${ops.metrics.providerResponseRatePct}%`
                : "—"
            }
          />
          <Metric label="Зависшие" value={String(ops?.metrics.stuckOrders.count ?? "—")} />
          {relayDisabled && (
            <div className="rounded-md border border-warning/50 bg-background px-3 py-2 text-xs text-muted-foreground sm:col-span-4">
              Provider relay выключен: действия с заказами недоступны до включения rollout.
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(380px,0.9fr)]">
        <Card className="min-w-0">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-sm">Очередь</CardTitle>
            <Badge variant="outline">{orders.length}</Badge>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="py-12 text-center text-sm text-muted-foreground">Загрузка…</div>
            ) : orders.length === 0 ? (
              <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
                Заказов пока нет.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Заказ</TableHead>
                      <TableHead>Клиент</TableHead>
                      <TableHead>Провайдер</TableHead>
                      <TableHead>Сумма</TableHead>
                      <TableHead>SLA</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {orders.map((order) => (
                      <TableRow
                        key={order.id}
                        className={cn(
                          "cursor-pointer",
                          selectedId === order.id && "bg-muted/60",
                        )}
                        onClick={() => setSelectedId(order.id)}
                      >
                        <TableCell className="min-w-[220px] whitespace-normal">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">#{order.id}</span>
                            <Badge variant={statusVariant(order.status)}>
                              {ORDER_STATUS_LABEL[order.status]}
                            </Badge>
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {order.requestType}
                          </div>
                          {order.summary && (
                            <div className="mt-1 max-w-md truncate text-xs text-muted-foreground">
                              {order.summary}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="min-w-[140px] whitespace-normal">
                          {order.customer.name ?? `Контакт #${order.customer.id}`}
                        </TableCell>
                        <TableCell className="min-w-[160px] whitespace-normal">
                          <div>{order.provider?.name ?? "Не назначен"}</div>
                          {order.latestProviderRequest && (
                            <div className="mt-1 text-xs text-muted-foreground">
                              {REQUEST_STATUS_LABEL[order.latestProviderRequest.status]}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>{formatMoney(order.customerAmount, order.currency)}</TableCell>
                        <TableCell>
                          <Badge variant={order.sla.state === "breached" ? "destructive" : order.sla.state === "risk" ? "warning" : "outline"}>
                            {slaText(order.sla)}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="min-w-0 space-y-4">
          {!selectedOrder ? (
            <Card>
              <CardContent className="py-12 text-center text-sm text-muted-foreground">
                Выберите заказ.
              </CardContent>
            </Card>
          ) : (
            <>
              <Card>
                <CardHeader className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <ClipboardListIcon className="size-4" />
                      #{selectedOrder.id}
                    </CardTitle>
                    <Badge variant={statusVariant(selectedOrder.status)}>
                      {ORDER_STATUS_LABEL[selectedOrder.status]}
                    </Badge>
                  </div>
                  <div className="grid gap-2 text-sm sm:grid-cols-3">
                    <Metric label="Клиент" value={selectedOrder.customer.name ?? "—"} />
                    <Metric label="Оплата" value={detail?.order.payment.status ?? selectedOrder.paymentStatus} />
                    <Metric label="SLA" value={detail ? slaText(detail.sla) : slaText(selectedOrder.sla)} />
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label>Провайдер</Label>
                      <Select value={selectedProviderId} onValueChange={setSelectedProviderId}>
                        <SelectTrigger>
                          <SelectValue placeholder="Выбрать провайдера" />
                        </SelectTrigger>
                        <SelectContent>
                          {providers.map((provider) => (
                            <SelectItem key={provider.id} value={String(provider.id)}>
                              {providerLabel(provider)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label>Сумма клиенту</Label>
                      <div className="flex h-10 items-center rounded-md border px-3 text-sm">
                        {formatMoney(
                          detail?.order.amounts.customerAmount ?? selectedOrder.customerAmount,
                          detail?.order.amounts.currency ?? selectedOrder.currency,
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label>Сообщение провайдеру</Label>
                    <Textarea
                      value={providerMessage}
                      onChange={(event) => setProviderMessage(event.target.value)}
                      rows={3}
                      placeholder={detail?.order.summary ?? "Текст запроса"}
                    />
                  </div>

                  <div className="grid gap-2 sm:grid-cols-2">
                    <Button
                      variant="outline"
                      disabled={!providerId || relayActionsDisabled}
                      onClick={() =>
                        void runAction("assign", async () => {
                          if (!selectedId || !providerId) return;
                          await saas.assignProviderOrder(selectedId, providerId);
                          toast.success("Провайдер назначен");
                        })
                      }
                    >
                      <UserPlusIcon className="size-4" />
                      Назначить
                    </Button>
                    <Button
                      disabled={!selectedId || relayActionsDisabled}
                      onClick={() =>
                        void runAction("send-provider", async () => {
                          if (!selectedId) return;
                          await saas.sendProviderOrderProviderRequest(selectedId, {
                            providerId: providerId ?? undefined,
                            messageText: providerMessage.trim() || undefined,
                          });
                          setProviderMessage("");
                          toast.success("Запрос отправлен провайдеру");
                        })
                      }
                    >
                      <SendIcon className="size-4" />
                      Запрос провайдеру
                    </Button>
                    <Button
                      variant="outline"
                      disabled={!selectedId || !activeQuote || relayActionsDisabled}
                      onClick={() =>
                        void runAction("approve", async () => {
                          if (!selectedId || !activeQuote) return;
                          await saas.approveProviderOrderQuote(selectedId, activeQuote.id);
                          toast.success("Котировка утверждена");
                        })
                      }
                    >
                      <CheckCircle2Icon className="size-4" />
                      Утвердить цену
                    </Button>
                    <Button
                      variant="outline"
                      disabled={!selectedId || !activeQuote || relayActionsDisabled}
                      onClick={() =>
                        void runAction("offer", async () => {
                          if (!selectedId) return;
                          await saas.sendProviderOrderCustomerOffer(selectedId, {
                            offerText: offerText.trim() || undefined,
                          });
                          setOfferText("");
                          toast.success("Оффер отправлен клиенту");
                        })
                      }
                    >
                      <SendIcon className="size-4" />
                      Оффер клиенту
                    </Button>
                    <Button
                      variant="outline"
                      disabled={!selectedId || relayActionsDisabled}
                      onClick={() =>
                        void runAction("fulfilled", async () => {
                          if (!selectedId) return;
                          await saas.markProviderOrderFulfilled(selectedId);
                          toast.success("Заказ отмечен выполненным");
                        })
                      }
                    >
                      <CheckCircle2Icon className="size-4" />
                      Выполнен
                    </Button>
                    <Button
                      variant="outline"
                      className="text-destructive hover:text-destructive"
                      disabled={!selectedId || relayActionsDisabled}
                      onClick={() =>
                        void runAction("cancel", async () => {
                          if (!selectedId) return;
                          await saas.cancelProviderOrder(selectedId, cancelReason.trim() || undefined);
                          setCancelReason("");
                          toast.success("Заказ отменён");
                        })
                      }
                    >
                      <XCircleIcon className="size-4" />
                      Отменить
                    </Button>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label>Оффер клиенту</Label>
                      <Textarea
                        value={offerText}
                        onChange={(event) => setOfferText(event.target.value)}
                        rows={3}
                        placeholder="Оставьте пустым для стандартного текста"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Причина отмены</Label>
                      <Textarea
                        value={cancelReason}
                        onChange={(event) => setCancelReason(event.target.value)}
                        rows={3}
                        placeholder="Опционально"
                      />
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Клиент видит</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {detailLoading ? (
                    <div className="text-sm text-muted-foreground">Загрузка…</div>
                  ) : detail?.customer.messages.length ? (
                    detail.customer.messages.map((message) => (
                      <MessageBubble key={message.id} role={message.role} text={message.text} />
                    ))
                  ) : (
                    <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                      Нет сообщений клиента.
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between">
                  <CardTitle className="text-sm">Провайдер видит</CardTitle>
                  {latestRequest && (
                    <Badge variant={statusVariant(latestRequest.status)}>
                      {REQUEST_STATUS_LABEL[latestRequest.status]}
                    </Badge>
                  )}
                </CardHeader>
                <CardContent className="space-y-3">
                  {detail?.providerRequests.length ? (
                    detail.providerRequests.map((request) => (
                      <div key={request.id} className="rounded-md border p-3">
                        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                          <div className="text-sm font-medium">
                            {request.providerName ?? "Провайдер"} · #{request.id}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {formatDate(request.updatedAt)}
                          </div>
                        </div>
                        {request.outboundText && (
                          <MessageBubble role="operator" text={request.outboundText} />
                        )}
                        {request.responseText && (
                          <MessageBubble role="provider" text={request.responseText} />
                        )}
                        {request.outboundLastError && (
                          <div className="mt-2 text-xs text-destructive">
                            {request.outboundLastError}
                          </div>
                        )}
                      </div>
                    ))
                  ) : (
                    <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                      Запросов провайдеру нет.
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">События</CardTitle>
                </CardHeader>
                <CardContent>
                  {detail?.events.length ? (
                    <div className="space-y-3">
                      {detail.events.map((event) => (
                        <div key={event.id} className="flex gap-3 text-sm">
                          <div className="mt-1 size-2 rounded-full bg-primary" />
                          <div className="min-w-0">
                            <div className="font-medium">{eventLabel(event.eventType)}</div>
                            <div className="text-xs text-muted-foreground">
                              {event.actorType} · {formatDate(event.createdAt)}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground">Событий нет.</div>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-sm font-medium">{value}</div>
    </div>
  );
}

function MessageBubble({ role, text }: { role: string; text: string }) {
  const isUser = role === "user" || role === "customer";
  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2 text-sm",
        isUser ? "bg-muted/50" : "bg-background",
      )}
    >
      <div className="mb-1 text-[11px] uppercase text-muted-foreground">{role}</div>
      <div className="whitespace-pre-wrap break-words">{text}</div>
    </div>
  );
}

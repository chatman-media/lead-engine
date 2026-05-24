import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, clearToken, saas, type AuditEntry, type FunnelData } from "@/api/saas";
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
import { Textarea } from "@/components/ui/textarea";
import { CalendarClockIcon, SendIcon } from "lucide-react";

function fmtDateTime(epoch: number) {
  return new Date(epoch * 1000).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function OutreachHistoryItem({ entry }: { entry: AuditEntry }) {
  const d = entry.details ?? {};
  const text = typeof d.text === "string" ? d.text : "";
  const enqueued = typeof d.enqueued === "number" ? d.enqueued : 0;
  const skipped = typeof d.skipped === "number" ? d.skipped : 0;
  const stageSlug = typeof d.stageSlug === "string" ? d.stageSlug : null;
  const leadCount = typeof d.leadCount === "number" ? d.leadCount : null;

  return (
    <div className="flex flex-col gap-1 rounded-md border px-4 py-3 text-sm">
      <div className="flex items-start justify-between gap-4">
        <p className="flex-1 text-muted-foreground line-clamp-2">{text || "—"}</p>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{fmtDateTime(entry.createdAt)}</span>
      </div>
      <div className="flex items-center gap-3 pt-0.5">
        {stageSlug && (
          <Badge variant="secondary" className="text-[10px]">
            Стадия: {stageSlug}
          </Badge>
        )}
        {leadCount !== null && (
          <Badge variant="secondary" className="text-[10px]">
            {leadCount} лид{leadCount !== 1 ? "ов" : ""}
          </Badge>
        )}
        <span className="text-xs text-green-600 font-medium">{enqueued} отправлено</span>
        {skipped > 0 && (
          <span className="text-xs text-muted-foreground">{skipped} пропущено</span>
        )}
        {entry.adminEmail && (
          <span className="ml-auto text-xs text-muted-foreground">{entry.adminEmail}</span>
        )}
      </div>
    </div>
  );
}

export function SaasOutreach() {
  const navigate = useNavigate();

  // Compose state
  const [funnel, setFunnel] = useState<FunnelData | null>(null);
  const [target, setTarget] = useState<"all" | "stage">("all");
  const [stageSlug, setStageSlug] = useState("");
  const [text, setText] = useState("");
  const [scheduledAt, setScheduledAt] = useState(""); // datetime-local string
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<{ enqueued: number; skipped: number; scheduledAt: number | null } | null>(null);

  // History state
  const [history, setHistory] = useState<AuditEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  function onAuthError(err: unknown) {
    if (err instanceof ApiError && err.status === 401) {
      clearToken();
      navigate("/login", { replace: true });
      return true;
    }
    return false;
  }

  useEffect(() => {
    saas.getFunnel().then(setFunnel).catch((err) => { onAuthError(err); });
    saas
      .listAuditLog({ limit: 200 })
      .then((res) => setHistory(res.items.filter((e) => e.action === "outreach.send")))
      .catch((err) => { onAuthError(err); })
      .finally(() => setHistoryLoading(false));
  }, []);

  async function handleSend() {
    if (!text.trim()) return;
    setSending(true);
    setSendResult(null);
    try {
      const body =
        target === "stage" && stageSlug
          ? { text: text.trim(), stageSlug }
          : { text: text.trim(), leadIds: [] as number[] };

      if (target === "all") {
        delete (body as { leadIds?: number[] }).leadIds;
        (body as { stageSlug?: string }).stageSlug = undefined;
      }

      const scheduledAtEpoch = scheduledAt
        ? Math.floor(new Date(scheduledAt).getTime() / 1000)
        : undefined;

      const res = await saas.sendOutreach({
        text: text.trim(),
        ...(target === "stage" && stageSlug ? { stageSlug } : {}),
        ...(scheduledAtEpoch && scheduledAtEpoch > Math.floor(Date.now() / 1000) ? { scheduledAt: scheduledAtEpoch } : {}),
      });
      setSendResult(res);
      // Refresh history
      const updated = await saas.listAuditLog({ limit: 200 });
      setHistory(updated.items.filter((e) => e.action === "outreach.send"));
    } catch (err) {
      if (!onAuthError(err)) {
        setSendResult(null);
      }
    } finally {
      setSending(false);
    }
  }

  const stages = funnel?.stages ?? [];
  const canSend = text.trim().length > 0 && text.length <= 4000 && !sending && (target === "all" || !!stageSlug);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Рассылка"
        description="Отправить сообщение лидам через их каналы (Telegram, WhatsApp, Web)"
      />

      {/* Compose card */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <SendIcon className="size-4" />
            Новая рассылка
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label>Кому отправить</Label>
            <Select value={target} onValueChange={(v) => setTarget(v as "all" | "stage")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Всем лидам (у кого есть канал)</SelectItem>
                <SelectItem value="stage">По стадии воронки</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {target === "stage" && stages.length > 0 && (
            <div className="space-y-1.5">
              <Label>Стадия</Label>
              <Select value={stageSlug} onValueChange={setStageSlug}>
                <SelectTrigger>
                  <SelectValue placeholder="Выберите стадию…" />
                </SelectTrigger>
                <SelectContent>
                  {stages.map((s) => (
                    <SelectItem key={s.id} value={s.slug}>
                      {s.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Текст сообщения</Label>
            <Textarea
              placeholder="Введите текст сообщения…"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={5}
              className="resize-none"
            />
            <p className="text-xs text-muted-foreground text-right">{text.length}/4000</p>
          </div>

          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5">
              <CalendarClockIcon className="size-3.5" />
              Отложенная отправка
              <span className="text-muted-foreground font-normal">(опционально)</span>
            </Label>
            <Input
              type="datetime-local"
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
              min={new Date(Date.now() + 60_000).toISOString().slice(0, 16)}
              className="w-auto"
            />
            {scheduledAt && (
              <p className="text-xs text-muted-foreground">
                Сообщения будут поставлены в очередь и отправлены в {new Date(scheduledAt).toLocaleString("ru-RU")}
              </p>
            )}
          </div>

          {sendResult && (
            <div className="rounded-md bg-muted px-4 py-3 text-sm flex items-center gap-4">
              <span>
                {sendResult.scheduledAt
                  ? <>Запланировано: <span className="font-semibold text-blue-600">{sendResult.enqueued}</span></>
                  : <>Отправлено: <span className="font-semibold text-green-600">{sendResult.enqueued}</span></>
                }
              </span>
              <span className="text-muted-foreground">·</span>
              <span>
                Пропущено:{" "}
                <span className="font-semibold text-muted-foreground">{sendResult.skipped}</span>
              </span>
              {sendResult.scheduledAt && (
                <>
                  <span className="text-muted-foreground">·</span>
                  <span className="text-xs text-muted-foreground">
                    Отправка в {fmtDateTime(sendResult.scheduledAt)}
                  </span>
                </>
              )}
            </div>
          )}

          <Button disabled={!canSend} onClick={handleSend} className="gap-2">
            {scheduledAt ? <CalendarClockIcon className="size-4" /> : <SendIcon className="size-4" />}
            {sending ? "Сохраняем…" : scheduledAt ? "Запланировать" : "Отправить"}
          </Button>
        </CardContent>
      </Card>

      {/* History */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
          История рассылок
        </h2>
        {historyLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-md" />
            ))}
          </div>
        ) : history.length === 0 ? (
          <p className="text-sm text-muted-foreground">Рассылок ещё не было.</p>
        ) : (
          <div className="space-y-2">
            {history.map((e) => (
              <OutreachHistoryItem key={e.id} entry={e} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

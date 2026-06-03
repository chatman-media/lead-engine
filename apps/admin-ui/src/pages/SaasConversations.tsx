import { ExternalLinkIcon, SearchIcon, SendHorizontalIcon, Trash2Icon } from "lucide-react";
import React, { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ApiError,
  type ConversationDetail,
  type ConversationListItem,
  clearToken,
  type LeadListItem,
  type MessageRow,
  saas,
} from "../api/saas.ts";

const POLL_INTERVAL_MS = 5000;

const SOURCE_RU: Record<string, string> = {
  bot: "Telegram-бот",
  userbot: "Telegram",
  whatsapp: "WhatsApp",
  web: "Web",
};
const MODE_RU: Record<string, string> = { ai: "AI", human: "Оператор" };
const STATUS_RU: Record<string, string> = {
  open: "Открыт",
  pending: "Ожидание",
  resolved: "Решен",
};
const ROLE_RU: Record<string, string> = {
  user: "клиент",
  assistant: "AI",
  human: "оператор",
  system: "система",
};
const STATE_RU: Record<string, string> = {
  active: "активен",
  won: "выигран",
  lost: "проигран",
  intake: "входящий",
  terminal_won: "закрыт ✓",
  terminal_lost: "закрыт ✗",
};

function fmtTime(epoch: number | null): string {
  if (!epoch) return "—";
  return new Date(epoch * 1000).toLocaleString("ru", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function fmtShortTime(epoch: number): string {
  return new Date(epoch * 1000).toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" });
}

export function SaasConversations() {
  const navigate = useNavigate();
  const params = useParams<{ id?: string }>();
  const selectedId = params.id ? Number.parseInt(params.id, 10) : null;

  const [list, setList] = useState<ConversationListItem[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadedCountRef = useRef(30);

  // Filters
  const [filterStatus, setFilterStatus] = useState("open");
  const [filterSource, setFilterSource] = useState("");
  const [filterMode, setFilterMode] = useState("");
  const [filterEscalated, setFilterEscalated] = useState(false);
  const [filterQ, setFilterQ] = useState("");
  const [filterQDebounced, setFilterQDebounced] = useState("");
  const filterQTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [detail, setDetail] = useState<{
    conversation: ConversationDetail;
    messages: MessageRow[];
  } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);
  const [togglingMode, setTogglingMode] = useState(false);
  const [confirmingTakeover, setConfirmingTakeover] = useState(false);
  const [contactLead, setContactLead] = useState<LeadListItem | null>(null);
  const [admins, setAdmins] = useState<import("../api/saas.ts").AdminRow[]>([]);

  function handleAuthError(err: unknown): boolean {
    if (err instanceof ApiError && err.status === 401) {
      clearToken();
      navigate("/login", { replace: true });
      return true;
    }
    return false;
  }

  useEffect(() => {
    saas.listAdmins().then((r) => setAdmins(r.items)).catch(() => {});
  }, []);

  const buildFilters = useCallback(() => ({
    status: filterStatus,
    ...(filterSource ? { source: filterSource } : {}),
    ...(filterMode ? { mode: filterMode } : {}),
    ...(filterEscalated ? { escalated: true } : {}),
    ...(filterQDebounced ? { q: filterQDebounced } : {}),
  }), [filterStatus, filterSource, filterMode, filterEscalated, filterQDebounced]);

  async function refreshList(limit = 30, filters = buildFilters()) {
    try {
      const res = await saas.listConversations({ limit, ...filters });
      setList(res.items);
      setNextCursor(res.nextCursor ?? null);
      loadedCountRef.current = res.items.length;
    } catch (err) {
      if (handleAuthError(err)) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await saas.listConversations({ limit: 30, cursor: nextCursor, ...buildFilters() });
      setList((prev) => {
        const merged = [...prev, ...res.items];
        loadedCountRef.current = merged.length;
        return merged;
      });
      setNextCursor(res.nextCursor ?? null);
    } catch (err) {
      if (handleAuthError(err)) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingMore(false);
    }
  }

  async function refreshDetail(id: number) {
    try {
      setDetail(await saas.getConversation(id));
    } catch (err) {
      if (handleAuthError(err)) return;
      if (err instanceof ApiError && err.status === 404) {
        setError("Диалог не найден");
        setDetail(null);
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    (async () => {
      setDetailLoading(true);
      await refreshDetail(selectedId);
      if (!cancelled) setDetailLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: selectedId only
  }, [selectedId]);

  useEffect(() => {
    if (!detail) {
      setContactLead(null);
      return;
    }
    saas.listLeads({ contactId: detail.conversation.contactId, limit: 1 })
      .then((r) => setContactLead(r.items[0] ?? null))
      .catch(() => setContactLead(null));
  }, [detail?.conversation.contactId]);

  // Debounce search query
  useEffect(() => {
    if (filterQTimerRef.current) clearTimeout(filterQTimerRef.current);
    filterQTimerRef.current = setTimeout(() => setFilterQDebounced(filterQ), 350);
    return () => { if (filterQTimerRef.current) clearTimeout(filterQTimerRef.current); };
  }, [filterQ]);

  // Re-fetch when filters change
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional
  useEffect(() => {
    setListLoading(true);
    const filters = {
      status: filterStatus,
      ...(filterSource ? { source: filterSource } : {}),
      ...(filterMode ? { mode: filterMode } : {}),
      ...(filterEscalated ? { escalated: true } : {}),
      ...(filterQDebounced ? { q: filterQDebounced } : {}),
    };
    refreshList(30, filters).finally(() => setListLoading(false));
  }, [filterStatus, filterSource, filterMode, filterEscalated, filterQDebounced]);

  async function handleToggleMode() {
    if (!detail || !selectedId) return;
    const next = detail.conversation.mode === "human" ? "ai" : "human";
    // Перехват — inline-подтверждение вместо confirm()
    if (next === "human" && !confirmingTakeover) {
      setConfirmingTakeover(true);
      return;
    }
    setConfirmingTakeover(false);
    setTogglingMode(true);
    setError("");
    try {
      await saas.setConversationMode(selectedId, next);
      await refreshDetail(selectedId);
    } catch (err) {
      if (handleAuthError(err)) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTogglingMode(false);
    }
  }

  async function handleReply(e: FormEvent) {
    e.preventDefault();
    if (!selectedId) return;
    const text = replyText.trim();
    if (!text) return;
    setSending(true);
    setError("");
    try {
      await saas.replyToConversation(selectedId, text);
      setReplyText("");
      await refreshDetail(selectedId);
    } catch (err) {
      if (handleAuthError(err)) return;
      if (err instanceof ApiError && err.status === 409) {
        setError("Не удалось отправить: канал клиента недоступен (удалён?)");
      } else if (err instanceof ApiError) {
        setError(`Ошибка ${err.status}: ${err.errorCode}`);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSending(false);
    }
  }

  async function handleDeleteMessage(messageId: number) {
    if (!selectedId) return;
    try {
      await saas.deleteMessage(selectedId, messageId);
      await refreshDetail(selectedId);
    } catch (err) {
      if (!handleAuthError(err)) setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleUpdateConversation(patch: { status?: string; assignedAdminId?: number | null }) {
    if (!selectedId) return;
    try {
      await saas.updateConversation(selectedId, patch);
      await refreshDetail(selectedId);
      void refreshList(Math.max(30, loadedCountRef.current));
    } catch (err) {
      if (!handleAuthError(err)) setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [detail?.messages]);

  useEffect(() => {
    const t = setInterval(() => {
      // Не поллим когда вкладка скрыта — экономим запросы
      if (document.visibilityState === "hidden") return;
      void refreshList(Math.max(30, loadedCountRef.current));
      if (selectedId) void refreshDetail(selectedId);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(t);
    // biome-ignore lint/correctness/useExhaustiveDependencies: selectedId only
  }, [selectedId]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Диалоги"
        description="Входящие от клиентов и ответы бота. Авто-обновление каждые 5 секунд."
      />

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[300px_1fr_300px]">
        {/* Список */}
        <Card className="flex max-h-[72vh] flex-col gap-0 overflow-hidden py-0">
          <div className="border-b">
            <div className="flex">
              {["open", "pending", "resolved"].map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setFilterStatus(s)}
                  className={cn(
                    "flex-1 px-2 py-2.5 text-xs font-medium border-b-2 transition-colors",
                    filterStatus === s
                      ? "border-primary text-primary bg-primary/5"
                      : "border-transparent text-muted-foreground hover:bg-muted/40",
                  )}
                >
                  {STATUS_RU[s]}
                </button>
              ))}
            </div>
          </div>
          <div className="border-b px-3 py-2 space-y-2">
            <div className="relative">
              <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
              <Input
                placeholder="Поиск по имени…"
                value={filterQ}
                onChange={(e) => setFilterQ(e.target.value)}
                className="h-8 pl-8 text-sm"
              />
            </div>
            <div className="flex gap-1.5">
              <Select value={filterSource || "all"} onValueChange={(v) => setFilterSource(v === "all" ? "" : v)}>
                <SelectTrigger className="h-7 text-xs flex-1">
                  <SelectValue placeholder="Канал" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Все каналы</SelectItem>
                  <SelectItem value="userbot">Telegram</SelectItem>
                  <SelectItem value="bot">TG-бот</SelectItem>
                  <SelectItem value="whatsapp">WhatsApp</SelectItem>
                  <SelectItem value="web">Web</SelectItem>
                </SelectContent>
              </Select>
              <Select value={filterMode || "all"} onValueChange={(v) => setFilterMode(v === "all" ? "" : v)}>
                <SelectTrigger className="h-7 text-xs flex-1">
                  <SelectValue placeholder="Режим" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Все режимы</SelectItem>
                  <SelectItem value="ai">AI</SelectItem>
                  <SelectItem value="human">Оператор</SelectItem>
                </SelectContent>
              </Select>
              <Button
                variant={filterEscalated ? "destructive" : "outline"}
                size="sm"
                className="h-7 px-2 text-xs shrink-0"
                onClick={() => setFilterEscalated((v) => !v)}
              >
                🔴
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground px-0.5">
              {list.length}{nextCursor ? "+" : ""} диалог{list.length === 1 ? "" : list.length < 5 ? "а" : "ов"}
            </p>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {listLoading ? (
              <div className="space-y-1.5 p-2">
                {Array.from({ length: 6 }).map((_, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: skeleton
                  <div key={i} className="rounded-lg border px-3 py-2.5 space-y-1.5">
                    <div className="flex justify-between">
                      <Skeleton className="h-4 w-28" />
                      <Skeleton className="h-3 w-10" />
                    </div>
                    <Skeleton className="h-3 w-20" />
                  </div>
                ))}
              </div>
            ) : list.length === 0 ? (
              <p className="p-4 text-center text-sm text-muted-foreground">Пока нет диалогов</p>
            ) : (
              <>
                <ul className="space-y-1">
                  {list.map((c) => (
                    <li key={c.id}>
                      <Link
                        to={`/conversations/${c.id}`}
                        className={cn(
                          "block rounded-lg border px-3 py-2.5 transition-colors",
                          c.id === selectedId
                            ? "border-primary/50 bg-accent"
                            : "border-transparent hover:bg-muted/60",
                        )}
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-sm font-medium">
                            {c.contactName ?? `Контакт #${c.contactId}`}
                          </span>
                          <div className="flex items-center gap-2 shrink-0">
                            {c.unreadCount > 0 && (
                              <span className="flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
                                {c.unreadCount}
                              </span>
                            )}
                            <span className="font-mono text-[11px] text-muted-foreground">
                              {fmtTime(c.lastMessageAt)}
                            </span>
                          </div>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1">
                          <Badge variant="secondary">{SOURCE_RU[c.source] ?? c.source}</Badge>
                          <Badge variant={c.mode === "human" ? "warning" : "outline"}>
                            {MODE_RU[c.mode] ?? c.mode}
                          </Badge>
                          {c.escalatedAt && <Badge variant="destructive">эскалация</Badge>}
                        </div>
                        {c.lastMessagePreview && (
                          <p className="mt-1 truncate text-xs text-muted-foreground">
                            {c.lastMessagePreview}
                          </p>
                        )}
                      </Link>
                    </li>
                  ))}
                </ul>
                {nextCursor && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-2 w-full"
                    onClick={loadMore}
                    disabled={loadingMore}
                  >
                    {loadingMore ? "Загружаем…" : "Загрузить ещё"}
                  </Button>
                )}
              </>
            )}
          </div>
        </Card>

        {/* Тред */}
        <Card className="flex max-h-[72vh] flex-col gap-0 overflow-hidden py-0">
          {!selectedId ? (
            <div className="grid flex-1 place-items-center p-8 text-sm text-muted-foreground">
              Выберите диалог слева
            </div>
          ) : detailLoading && !detail ? (
            <div className="flex flex-1 flex-col gap-3 p-4">
              <div className="flex items-center justify-between gap-3 border-b pb-3">
                <div className="space-y-1.5">
                  <Skeleton className="h-5 w-36" />
                  <div className="flex gap-1">
                    <Skeleton className="h-5 w-16" />
                    <Skeleton className="h-5 w-10" />
                  </div>
                </div>
                <Skeleton className="h-8 w-24" />
              </div>
              <div className="flex flex-col gap-3 flex-1">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton
                    key={i}
                    className={`h-14 max-w-[70%] rounded-2xl ${i % 2 === 0 ? "self-start" : "self-end"}`}
                  />
                ))}
              </div>
            </div>
          ) : detail ? (
            <>
              <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    {detail.conversation.contactName ?? `Контакт #${detail.conversation.contactId}`}
                  </p>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1">
                    <Badge variant="secondary">{SOURCE_RU[detail.conversation.source] ?? detail.conversation.source}</Badge>
                    <Badge variant={detail.conversation.mode === "human" ? "warning" : "outline"}>
                      {detail.conversation.mode === "human" ? "оператор" : "AI"}
                    </Badge>
                    {detail.conversation.currentStage && (
                      <Badge variant="outline">{detail.conversation.currentStage}</Badge>
                    )}
                    {detail.conversation.escalatedAt && (
                      <Badge variant="destructive">эскалация</Badge>
                    )}
                    {contactLead && (
                      <Link
                        to={`/leads/${contactLead.id}`}
                        className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      >
                        <ExternalLinkIcon className="size-3" />
                        Лид · {STATE_RU[contactLead.state] ?? contactLead.state}
                      </Link>
                    )}
                  </div>
                </div>
                {confirmingTakeover ? (
                  <div className="flex items-center gap-1.5 text-sm">
                    <span className="text-muted-foreground">AI замолчит?</span>
                    <Button size="sm" variant="destructive" onClick={handleToggleMode} disabled={togglingMode}>
                      Да
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmingTakeover(false)}>
                      Нет
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant={detail.conversation.mode === "human" ? "outline" : "default"}
                    size="sm"
                    onClick={handleToggleMode}
                    disabled={togglingMode}
                  >
                    {togglingMode
                      ? "…"
                      : detail.conversation.mode === "human"
                        ? "Вернуть AI"
                        : "Перехватить"}
                  </Button>
                )}
              </div>

              <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
                {detail.messages.length === 0 ? (
                  <p className="text-center text-sm text-muted-foreground">Сообщений нет</p>
                ) : (
                  detail.messages.map((m) => {
                    const mine = m.role === "assistant" || m.role === "human";
                    const system = m.role === "system";
                    const showLabel = m.role !== "user";
                    const labelColor =
                      m.role === "assistant" ? "text-primary" :
                      m.role === "human" ? "text-[var(--success)]" :
                      "text-muted-foreground";
                    return (
                      <div
                        key={m.id}
                        className={cn(
                          "group max-w-[78%] rounded-2xl border px-3.5 py-2 text-sm",
                          system &&
                            "max-w-[92%] self-center border-dashed bg-transparent text-xs text-muted-foreground",
                          !system && !mine && "self-start bg-muted",
                          m.role === "assistant" && "self-end border-primary/30 bg-primary/10",
                          m.role === "human" &&
                            "self-end border-[var(--success)]/30 bg-[color-mix(in_oklch,var(--success)_12%,transparent)]",
                          m.deletedAt && "opacity-50",
                        )}
                      >
                        <div className="mb-1 flex items-center justify-between gap-3">
                          <span className={cn("text-[11px] font-semibold", showLabel ? labelColor : "text-muted-foreground/50")}>
                            {showLabel ? (ROLE_RU[m.role] ?? m.role) : ""}
                          </span>
                          <div className="flex items-center gap-1.5">
                            {m.role === "human" && !m.deletedAt && (
                              <button
                                type="button"
                                onClick={() => handleDeleteMessage(m.id)}
                                className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground/60 hover:text-destructive"
                              >
                                <Trash2Icon className="size-3" />
                              </button>
                            )}
                            <span className="font-mono text-[10px] text-muted-foreground">{fmtShortTime(m.createdAt)}</span>
                          </div>
                        </div>
                        <div
                          className={cn(
                            "whitespace-pre-wrap break-words",
                            m.deletedAt && "line-through",
                          )}
                        >
                          {(() => {
                            let voiceDuration: number | undefined;
                            try {
                              const meta = m.metaJson ? JSON.parse(m.metaJson) as { parts?: Array<{ kind: string; durationSec?: number }> } : null;
                              const voice = meta?.parts?.find((p) => p.kind === "voice");
                              if (voice) voiceDuration = voice.durationSec;
                            } catch { /* ignore */ }

                            if (voiceDuration !== undefined || (!m.text && m.metaJson?.includes('"voice"'))) {
                              return (
                                <span className="flex flex-col gap-1">
                                  <span className="text-xs text-muted-foreground italic">
                                    🎤 Голосовое{voiceDuration ? ` (${voiceDuration}с)` : ""}
                                  </span>
                                  {m.text && <span>{m.text}</span>}
                                </span>
                              );
                            }
                            return m.text
                              ? <span>{m.text}</span>
                              : <span className="italic text-muted-foreground">—</span>;
                          })()}
                        </div>
                      </div>
                    );
                  })
                )}
                <div ref={messagesEndRef} />
              </div>

              <form onSubmit={handleReply} className="flex items-end gap-2 border-t p-3">
                <Textarea
                  placeholder={
                    detail.conversation.mode === "human"
                      ? "Сообщение от имени оператора… (Ctrl+Enter — отправить)"
                      : "Отправить от оператора — бот перестанет отвечать (mode → human)."
                  }
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault();
                      void handleReply(e as unknown as React.FormEvent);
                    }
                  }}
                  rows={2}
                  maxLength={4000}
                  disabled={sending}
                  className="min-h-11 flex-1 resize-none"
                />
                <Button type="submit" size="icon" disabled={sending || !replyText.trim()}>
                  <SendHorizontalIcon className="size-4" />
                </Button>
              </form>
            </>
          ) : (
            <p className="p-4 text-sm text-muted-foreground">Диалог не загружен</p>
          )}
        </Card>

        {/* Инфо-панель (Right Sidebar) */}
        <Card className="flex max-h-[72vh] flex-col gap-0 overflow-hidden py-0">
          {!detail ? (
            <div className="p-4 text-center text-sm text-muted-foreground">
              Выберите диалог
            </div>
          ) : (
            <div className="flex flex-col h-full overflow-y-auto p-4 space-y-6">
              {/* Статус и Назначение */}
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <label className="text-[11px] font-bold uppercase text-muted-foreground">Статус</label>
                  <Select
                    value={detail.conversation.status}
                    onValueChange={(v) => handleUpdateConversation({ status: v })}
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="open">Открыт</SelectItem>
                      <SelectItem value="pending">Ожидание</SelectItem>
                      <SelectItem value="resolved">Решен</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <label className="text-[11px] font-bold uppercase text-muted-foreground">Назначен на</label>
                  <Select
                    value={String(detail.conversation.assignedAdminId ?? "none")}
                    onValueChange={(v) => handleUpdateConversation({ assignedAdminId: v === "none" ? null : Number.parseInt(v, 10) })}
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Без оператора</SelectItem>
                      {admins.map((a) => (
                        <SelectItem key={a.id} value={String(a.id)}>
                          {a.email}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Контакт и Лид */}
              <div className="space-y-3 border-t pt-4">
                <div className="space-y-1">
                  <label className="text-[11px] font-bold uppercase text-muted-foreground">Контакт</label>
                  <p className="text-sm font-medium">{detail.conversation.contactName || "Без имени"}</p>
                  <p className="text-[11px] text-muted-foreground">ID: {detail.conversation.contactId}</p>
                </div>

                {contactLead ? (
                  <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold">Лид</span>
                      <Link to={`/leads/${contactLead.id}`} className="text-primary">
                        <ExternalLinkIcon className="size-3.5" />
                      </Link>
                    </div>
                    <div className="space-y-1">
                      <p className="text-[11px] text-muted-foreground">Стадия</p>
                      <Badge variant="outline" className="text-[10px]">{STATE_RU[contactLead.state] ?? contactLead.state}</Badge>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-lg border border-dashed p-3 text-center">
                    <p className="text-xs text-muted-foreground">Лид не создан</p>
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto p-0 text-xs"
                      onClick={async () => {
                        try {
                          await saas.createLead(detail.conversation.contactId);
                          await refreshDetail(selectedId!);
                        } catch (err) {
                          if (!handleAuthError(err)) setError(err instanceof Error ? err.message : String(err));
                        }
                      }}
                    >
                      Создать лид
                    </Button>
                  </div>
                )}
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

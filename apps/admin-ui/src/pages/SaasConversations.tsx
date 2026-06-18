import {
  AlertTriangleIcon,
  BanIcon,
  ExternalLinkIcon,
  FileTextIcon,
  ImageIcon,
  MicIcon,
  SearchIcon,
  SendHorizontalIcon,
  ShieldCheckIcon,
  Trash2Icon,
  VideoIcon,
} from "lucide-react";
import React, { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { LeadKbGuidanceCard } from "@/components/LeadKbGuidanceCard";
import { QuickReplies } from "@/components/QuickReplies";
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
  type FunnelListItem,
  type LeadKbGuidance,
  type LeadListItem,
  type MessageRow,
  type OperatorHandoffNotification,
  saas,
  type ServiceCatalogItem,
} from "../api/saas.ts";

const POLL_INTERVAL_MS = 5000;

const SOURCE_RU: Record<string, string> = {
  bot: "Telegram-бот",
  userbot: "Telegram",
  whatsapp: "WhatsApp",
  web: "Web",
  self_play: "Симуляция",
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

type MessageMeta = {
  adminId?: number;
  /** Клиент отредактировал сообщение (epoch сек.) — рендерим метку «изменено». */
  editedAt?: number;
  exchangeAction?: string;
  orderId?: number | string;
  parts?: Array<{
    kind: string;
    durationSec?: number;
    caption?: string;
    mimeType?: string;
    fileName?: string;
    mediaRef?: { channelId?: string; externalRef?: string };
  }>;
  payoutCode?: string;
  sentVia?: string;
  source?: string;
};

type MessageMediaPart = NonNullable<MessageMeta["parts"]>[number];

const OPERATOR_BOT_ACTION_RU: Record<string, string> = {
  kyc_approved: "KYC OK",
  kyc_request_materials: "KYC: дослать",
  kyc_rejected: "KYC отклонён",
  payment_under_review: "Оплата проверяется",
  payment_confirmed: "Оплата OK",
  payment_problem: "Проблема оплаты",
  payout_ready: "Выдача готова",
  office_details: "Офис/время",
  operator_reply: "Ответ оператора",
};

const FUNNEL_VERTICAL_RU: Record<string, string> = {
  exchange_v1: "Обменка",
  real_estate_v1: "Продажа недвижимости",
  saas_v1: "Продукт",
  concierge_v1: "Мультисервис",
  recruitment_v1: "Рекрутинг",
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

function parseMessageMeta(metaJson: string | null): MessageMeta | null {
  if (!metaJson) return null;
  try {
    const parsed = JSON.parse(metaJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as MessageMeta;
  } catch {
    return null;
  }
}

function parseJsonRecord(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function mediaParts(meta: MessageMeta | null): MessageMediaPart[] {
  return (meta?.parts ?? []).filter((part) => part.kind !== "text" && part.kind !== "callback_query");
}

function mediaKindLabel(kind: string): string {
  const labels: Record<string, string> = {
    photo: "Фото",
    video: "Видео",
    video_note: "Видео-кружок",
    voice: "Голосовое",
    document: "Документ",
    passport: "Паспорт",
    full_body: "Фото в полный рост",
    portrait: "Портрет",
    other: "Другое",
  };
  return labels[kind] ?? kind;
}

function mediaRefLabel(part: MessageMediaPart): string | null {
  if (part.fileName) return part.fileName;
  const ref = part.mediaRef;
  if (!ref?.externalRef) return part.mimeType ?? null;
  const shortRef =
    ref.externalRef.length > 18
      ? `${ref.externalRef.slice(0, 8)}...${ref.externalRef.slice(-6)}`
      : ref.externalRef;
  return ref.channelId ? `${ref.channelId}:${shortRef}` : shortRef;
}

function MediaPartIcon({ kind }: { kind: string }) {
  if (kind === "photo") return <ImageIcon className="size-4 text-primary" />;
  if (kind === "video" || kind === "video_note") return <VideoIcon className="size-4 text-primary" />;
  if (kind === "voice") return <MicIcon className="size-4 text-primary" />;
  return <FileTextIcon className="size-4 text-primary" />;
}

function MediaPreview({
  conversationId,
  messageId,
  part,
}: {
  conversationId: number | null;
  messageId: number;
  part: MessageMediaPart;
}) {
  const ref = part.mediaRef?.externalRef ?? null;
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!conversationId || !ref) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    setUrl(null);
    setFailed(false);
    saas
      .getConversationMedia(conversationId, messageId, ref)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [conversationId, messageId, ref]);

  // Эффективный тип превью — по kind И по mimeType: видео/фото, присланные
  // «файлом», приходят kind="document" (напр. IMG_6466.mp4 → document+video/mp4),
  // а кружок — video_note. Учитываем оба, чтобы рендерить везде одинаково.
  const kind = part.kind;
  const mime = part.mimeType ?? "";
  const isImage = kind === "photo" || mime.startsWith("image/");
  const isVideo = kind === "video" || kind === "video_note" || mime.startsWith("video/");
  const isAudio = kind === "voice" || mime.startsWith("audio/");

  if (!conversationId || !ref || failed) return null;
  if (!url) return <Skeleton className="h-40 w-full max-w-[260px] rounded-md" />;

  if (isImage) {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="block w-fit">
        <img
          src={url}
          alt="Вложение клиента"
          className="max-h-72 max-w-[260px] rounded-md border object-contain"
        />
      </a>
    );
  }
  if (isVideo) {
    // biome-ignore lint/a11y/useMediaCaption: пользовательское видео без субтитров
    return <video src={url} controls className="max-h-72 max-w-[260px] rounded-md border" />;
  }
  if (isAudio) {
    // biome-ignore lint/a11y/useMediaCaption: голосовое сообщение без субтитров
    return <audio src={url} controls className="w-full max-w-[260px]" />;
  }
  // Прочие документы (pdf и т.п.) — ссылка на скачивание.
  return (
    <a
      href={url}
      download={part.fileName ?? "attachment"}
      className="inline-flex w-fit items-center gap-1 text-xs text-primary underline"
    >
      <FileTextIcon className="size-3.5" />
      Скачать {part.fileName ?? "файл"}
    </a>
  );
}

function MessageMediaList({
  parts,
  conversationId,
  messageId,
}: {
  parts: MessageMediaPart[];
  conversationId: number | null;
  messageId: number;
}) {
  if (parts.length === 0) return null;
  return (
    <div className="space-y-1.5">
      {parts.map((part, index) => {
        const detail = [
          part.durationSec ? `${part.durationSec}с` : null,
          part.mimeType,
          mediaRefLabel(part),
        ].filter(Boolean).join(" · ");
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: media parts have no stable ids in stored meta
          <div key={index} className="space-y-2 rounded-lg border bg-background/70 px-2.5 py-2">
            <MediaPreview conversationId={conversationId} messageId={messageId} part={part} />
            <div className="flex items-start gap-2">
              <MediaPartIcon kind={part.kind} />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium">{mediaKindLabel(part.kind)}</p>
                {detail && (
                  <p className="mt-0.5 break-all font-mono text-[10px] text-muted-foreground">
                    {detail}
                  </p>
                )}
                {part.caption && (
                  <p className="mt-1 whitespace-pre-wrap break-words text-xs">{part.caption}</p>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function maskPassport(value: string): string {
  const compact = value.replace(/\s+/g, "");
  return compact.length > 4 ? `**** ${compact.slice(-4)}` : compact;
}

function ConversationVerificationPanel({ attributesJson }: { attributesJson: string | null }) {
  const attrs = parseJsonRecord(attributesJson);
  const kyc = attrs.exchangeKyc && typeof attrs.exchangeKyc === "object" && !Array.isArray(attrs.exchangeKyc)
    ? (attrs.exchangeKyc as Record<string, unknown>)
    : {};
  const passportName = [attrs.passport_family_name, attrs.passport_given_name]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ");
  const passportNumber = typeof attrs.passport_number === "string" ? attrs.passport_number : null;
  const passportExpiry = typeof attrs.passport_expiry === "string" ? attrs.passport_expiry : null;
  const lastPhotoClass = typeof attrs.last_photo_class === "string" ? attrs.last_photo_class : null;
  const status =
    typeof kyc.status === "string"
      ? kyc.status
      : attrs.isVerified === true
        ? "verified"
        : passportName || passportNumber
          ? "documents_received"
          : null;
  if (!status && !passportName && !passportNumber && !passportExpiry && !lastPhotoClass) return null;
  const statusLabel: Record<string, string> = {
    verified: "KYC OK",
    documents_received: "Документы получены",
    materials_requested: "Ждём материалы",
    pending_review: "На проверке",
    rejected: "Отклонён",
  };
  return (
    <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
      <div className="flex items-center gap-2">
        <ShieldCheckIcon className="size-4 text-primary" />
        <span className="text-xs font-semibold">KYC / OCR</span>
        {status && <Badge variant={status === "verified" ? "success" : status === "rejected" ? "destructive" : "warning"}>{statusLabel[status] ?? status}</Badge>}
      </div>
      <div className="space-y-1 text-xs">
        {lastPhotoClass && (
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Последнее фото</span>
            <span>{mediaKindLabel(lastPhotoClass)}</span>
          </div>
        )}
        {passportName && (
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Паспорт</span>
            <span className="text-right">{passportName}</span>
          </div>
        )}
        {passportNumber && (
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Номер</span>
            <span className="font-mono">{maskPassport(passportNumber)}</span>
          </div>
        )}
        {passportExpiry && (
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">До</span>
            <span>{passportExpiry}</span>
          </div>
        )}
        {typeof kyc.reviewedAt === "number" && (
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Проверен</span>
            <span>{fmtTime(kyc.reviewedAt)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function operatorBotLabel(meta: MessageMeta): string | null {
  if (meta.sentVia === "operator-bot-preview") return "Operator bot";
  if (meta.source === "operator_bot_exchange_action") return "Operator bot";
  return null;
}

function operatorActionLabel(action: string | undefined): string | null {
  if (!action) return null;
  return OPERATOR_BOT_ACTION_RU[action] ?? action.replaceAll("_", " ");
}

function funnelLabel(item: Pick<FunnelListItem, "slug" | "verticalTemplateId">): string {
  return item.verticalTemplateId ? (FUNNEL_VERTICAL_RU[item.verticalTemplateId] ?? item.slug) : item.slug;
}

function serviceTargetLabel(item: ServiceCatalogItem): string {
  const target =
    item.routeType === "partner_service"
      ? item.partnerServiceName || "партнёрская услуга"
      : item.funnelSlug
        ? funnelLabel({ slug: item.funnelSlug, verticalTemplateId: item.funnelVerticalTemplateId ?? null })
        : "авто";
  return `${item.name} → ${target}`;
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
  const [filterBanned, setFilterBanned] = useState(false);
  const [filterQ, setFilterQ] = useState("");
  const [filterQDebounced, setFilterQDebounced] = useState("");
  const filterQTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  // Прилипаем к низу только если пользователь уже внизу — иначе не дёргаем его,
  // когда он отскроллил вверх читать историю (поллинг идёт каждые 5с).
  const stickToBottomRef = useRef(true);
  const prevConvIdRef = useRef<number | null>(null);
  const prevMsgCountRef = useRef(0);
  const [detail, setDetail] = useState<{
    conversation: ConversationDetail;
    messages: MessageRow[];
  } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);
  const [togglingMode, setTogglingMode] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [confirmingTakeover, setConfirmingTakeover] = useState(false);
  const [banningContact, setBanningContact] = useState(false);
  const [confirmBanContact, setConfirmBanContact] = useState(false);
  const [banReason, setBanReason] = useState("");
  const [unbanningContact, setUnbanningContact] = useState(false);
  const [confirmUnbanContact, setConfirmUnbanContact] = useState(false);
  const [contactLead, setContactLead] = useState<LeadListItem | null>(null);
  const [kbGuidance, setKbGuidance] = useState<LeadKbGuidance | null>(null);
  const [kbGuidanceLoading, setKbGuidanceLoading] = useState(false);
  const [kbGuidanceError, setKbGuidanceError] = useState("");
  const [admins, setAdmins] = useState<import("../api/saas.ts").AdminRow[]>([]);
  const [operatorHandoffs, setOperatorHandoffs] = useState<OperatorHandoffNotification[]>([]);

  // Dialog simulator (dev/test)
  const [simOpen, setSimOpen] = useState(false);
  const [simPersonas, setSimPersonas] = useState<
    Array<{ id: string; name: string; displayName: string }>
  >([]);
  const [simFunnels, setSimFunnels] = useState<FunnelListItem[]>([]);
  const [simServices, setSimServices] = useState<ServiceCatalogItem[]>([]);
  const [simTarget, setSimTarget] = useState("auto");
  const [simPersonaId, setSimPersonaId] = useState("");
  const [simTurns, setSimTurns] = useState("6");
  const [simStarting, setSimStarting] = useState(false);
  // Поток («боевой режим»): N клиентов по интервалу
  const [simStream, setSimStream] = useState(false);
  const [simCount, setSimCount] = useState("10");
  const [simIntervalSec, setSimIntervalSec] = useState("60");
  const [simStreams, setSimStreams] = useState<
    Array<{ id: string; total: number; spawned: number; intervalSec: number }>
  >([]);

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

  const refreshSimStreams = useCallback(() => {
    saas.listSimStreams().then((r) => setSimStreams(r.streams)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!simOpen) return;
    if (simPersonas.length === 0) {
      saas
        .listSimPersonas()
        .then((r) => {
          setSimPersonas(r.personas);
          if (r.personas[0]) setSimPersonaId(r.personas[0].id);
        })
        .catch(() => {});
    }
    if (simFunnels.length === 0) {
      saas.listFunnels().then((r) => setSimFunnels(r.items)).catch(() => {});
    }
    if (simServices.length === 0) {
      saas.listServiceCatalog().then((r) => setSimServices(r.items)).catch(() => {});
    }
    refreshSimStreams();
    const t = setInterval(refreshSimStreams, POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [simOpen, simPersonas.length, simFunnels.length, simServices.length, refreshSimStreams]);

  function simTargetPayload(): { targetFunnelId?: number; targetCatalogItemId?: number } {
    if (simTarget.startsWith("funnel:")) {
      const id = Number(simTarget.slice("funnel:".length));
      return Number.isFinite(id) ? { targetFunnelId: id } : {};
    }
    if (simTarget.startsWith("service:")) {
      const id = Number(simTarget.slice("service:".length));
      return Number.isFinite(id) ? { targetCatalogItemId: id } : {};
    }
    return {};
  }

  async function handleStartSim() {
    setSimStarting(true);
    setError("");
    try {
      const maxTurns = Number.parseInt(simTurns, 10) || 6;
      const target = simTargetPayload();
      if (simStream) {
        await saas.startSimStream({
          count: Number.parseInt(simCount, 10) || 10,
          intervalSec: Number.parseInt(simIntervalSec, 10) || 60,
          ...(simPersonaId ? { personaIds: [simPersonaId] } : {}),
          maxTurns,
          ...target,
        });
        await refreshList();
        refreshSimStreams();
      } else {
        if (!simPersonaId) return;
        const res = await saas.startSim({ personaId: simPersonaId, maxTurns, ...target });
        setSimOpen(false);
        await refreshList();
        navigate(`/conversations/${res.conversationId}`);
      }
    } catch (err) {
      if (!handleAuthError(err)) {
        setError(err instanceof ApiError ? err.message : "Не удалось запустить симуляцию");
      }
    } finally {
      setSimStarting(false);
    }
  }

  async function handleStopStream(id: string) {
    try {
      await saas.stopSimStream(id);
      refreshSimStreams();
    } catch (err) {
      handleAuthError(err);
    }
  }

  async function handleStopAllStreams() {
    try {
      await saas.stopAllSimStreams();
      refreshSimStreams();
    } catch (err) {
      handleAuthError(err);
    }
  }

  const buildFilters = useCallback(() => ({
    status: filterStatus,
    ...(filterSource ? { source: filterSource } : {}),
    ...(filterMode ? { mode: filterMode } : {}),
    ...(filterEscalated ? { escalated: true } : {}),
    ...(filterBanned ? { includeBanned: true } : {}),
    ...(filterQDebounced ? { q: filterQDebounced } : {}),
  }), [filterStatus, filterSource, filterMode, filterEscalated, filterBanned, filterQDebounced]);

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
      const conversationDetail = await saas.getConversation(id);
      setDetail(conversationDetail);
      saas
        .getConversationOperatorHandoffs(id)
        .then((res) => setOperatorHandoffs(res.items))
        .catch(() => setOperatorHandoffs([]));
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

  async function refreshContactLead(contactId: number) {
    try {
      const res = await saas.listLeads({ contactId, limit: 1 });
      const lead = res.items[0] ?? null;
      setContactLead(lead);
      return lead;
    } catch (err) {
      if (!handleAuthError(err)) setContactLead(null);
      return null;
    }
  }

  async function refreshKbGuidance(leadId?: number | null) {
    const resolvedLeadId = leadId ?? contactLead?.id ?? null;
    if (!resolvedLeadId) {
      setKbGuidance(null);
      setKbGuidanceError("");
      setKbGuidanceLoading(false);
      return;
    }
    setKbGuidanceLoading(true);
    setKbGuidanceError("");
    try {
      const guidance = await saas.getLeadKbGuidance(resolvedLeadId);
      setKbGuidance(guidance);
    } catch (err) {
      if (!handleAuthError(err)) setKbGuidanceError("Не удалось загрузить подсказки");
    } finally {
      setKbGuidanceLoading(false);
    }
  }

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setOperatorHandoffs([]);
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
    void refreshContactLead(detail.conversation.contactId);
    // biome-ignore lint/correctness/useExhaustiveDependencies: refresh when selected contact/stage changes
  }, [detail?.conversation.contactId, detail?.conversation.currentStage]);

  useEffect(() => {
    if (!contactLead) {
      setKbGuidance(null);
      setKbGuidanceError("");
      setKbGuidanceLoading(false);
      return;
    }
    void refreshKbGuidance(contactLead.id);
    // biome-ignore lint/correctness/useExhaustiveDependencies: derived from current lead only
  }, [contactLead?.id, contactLead?.stageDefinitionId]);

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
      ...(filterBanned ? { includeBanned: true } : {}),
      ...(filterQDebounced ? { q: filterQDebounced } : {}),
    };
    refreshList(30, filters).finally(() => setListLoading(false));
  }, [filterStatus, filterSource, filterMode, filterEscalated, filterBanned, filterQDebounced]);

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

  async function handleBanContact() {
    if (!selectedId) return;
    setConfirmBanContact(false);
    setBanningContact(true);
    setError("");
    try {
      await saas.banConversationContact(selectedId, banReason.trim() || undefined);
      setBanReason("");
      await refreshDetail(selectedId);
      await refreshList();
    } catch (err) {
      if (handleAuthError(err)) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBanningContact(false);
    }
  }

  async function handleUnbanContact() {
    if (!selectedId) return;
    setConfirmUnbanContact(false);
    setUnbanningContact(true);
    setError("");
    try {
      await saas.unbanConversationContact(selectedId);
      await refreshDetail(selectedId);
      await refreshList();
    } catch (err) {
      if (handleAuthError(err)) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUnbanningContact(false);
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

  function appendReplyDraft(text: string) {
    const clean = text.trim();
    if (!clean) return;
    setReplyText((prev) => {
      const current = prev.trim();
      return current ? `${current}\n${clean}` : clean;
    });
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

  // Автоскролл к низу: при смене диалога — мгновенно, при новом сообщении —
  // плавно и только если пользователь уже был внизу. Скроллим сам контейнер
  // (не scrollIntoView), чтобы в узком режиме не дёргать скролл всего окна.
  useEffect(() => {
    const messages = detail?.messages;
    const convId = detail?.conversation.id ?? null;
    if (!messages) {
      prevConvIdRef.current = null;
      prevMsgCountRef.current = 0;
      return;
    }
    const convChanged = convId !== prevConvIdRef.current;
    const countIncreased = messages.length > prevMsgCountRef.current;
    prevConvIdRef.current = convId;
    prevMsgCountRef.current = messages.length;

    const el = messagesContainerRef.current;
    if (!el) return;
    if (convChanged) {
      el.scrollTop = el.scrollHeight;
      stickToBottomRef.current = true;
      return;
    }
    if (countIncreased && stickToBottomRef.current) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, [detail?.messages, detail?.conversation.id]);

  function handleMessagesScroll() {
    const el = messagesContainerRef.current;
    if (!el) return;
    // «Внизу» с допуском, чтобы инерция/дробные пиксели не сбивали флаг.
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

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

  const activeServiceTargets = simServices.filter((item) => item.isActive);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Диалоги"
        description="Входящие от клиентов и ответы бота. Авто-обновление каждые 5 секунд."
        actions={
          <Button variant="outline" size="sm" onClick={() => setSimOpen((v) => !v)}>
            🤖 Симулировать клиента
          </Button>
        }
      />

      {simOpen && (
        <Card className="space-y-3 p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[220px] flex-1 space-y-1">
              <span className="text-xs font-medium text-muted-foreground">
                {simStream ? "Сценарий (пусто = все по очереди)" : "Сценарий / персона"}
              </span>
              <Select value={simPersonaId} onValueChange={setSimPersonaId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Выберите персону…" />
                </SelectTrigger>
                <SelectContent>
                  {simPersonas.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name} — {p.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="min-w-[220px] flex-1 space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Куда писать</span>
              <Select value={simTarget} onValueChange={setSimTarget}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Авто по сообщению" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Авто по сообщению</SelectItem>
                  {simFunnels.map((f) => (
                    <SelectItem key={`funnel:${f.id}`} value={`funnel:${f.id}`}>
                      Воронка: {funnelLabel(f)}
                    </SelectItem>
                  ))}
                  {activeServiceTargets.map((item) => (
                    <SelectItem key={`service:${item.id}`} value={`service:${item.id}`}>
                      Услуга: {serviceTargetLabel(item)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Ходов</span>
              <Input
                type="number"
                min={1}
                max={20}
                value={simTurns}
                onChange={(e) => setSimTurns(e.target.value)}
                className="w-20"
              />
            </div>
            {simStream && (
              <>
                <div className="space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">Клиентов</span>
                  <Input
                    type="number"
                    min={1}
                    max={50}
                    value={simCount}
                    onChange={(e) => setSimCount(e.target.value)}
                    className="w-20"
                  />
                </div>
                <div className="space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">Интервал, сек</span>
                  <Input
                    type="number"
                    min={5}
                    value={simIntervalSec}
                    onChange={(e) => setSimIntervalSec(e.target.value)}
                    className="w-24"
                  />
                </div>
              </>
            )}
            <Button onClick={handleStartSim} disabled={simStarting || (!simStream && !simPersonaId)}>
              {simStarting ? "Запуск…" : simStream ? "Запустить поток" : "Запустить"}
            </Button>
            <Button variant="destructive" onClick={handleStopAllStreams}>
              ⏹ Остановить все
            </Button>
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={simStream}
              onChange={(e) => setSimStream(e.target.checked)}
            />
            Поток («боевой режим»): новый клиент каждые N секунд. «Остановить все» глушит и
            уже идущие диалоги.
          </label>
          {simStreams.length > 0 && (
            <div className="space-y-1 border-t pt-2">
              <span className="text-xs font-medium text-muted-foreground">Активные потоки</span>
              {simStreams.map((s) => (
                <div key={s.id} className="flex items-center justify-between text-xs">
                  <span>
                    {s.spawned}/{s.total} клиентов · каждые {s.intervalSec}с
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => handleStopStream(s.id)}>
                    Стоп
                  </Button>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="grid gap-4 xl:grid-cols-[300px_minmax(0,1fr)_300px]">
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
                title="Только эскалированные"
              >
                🔴
              </Button>
              <Button
                variant={filterBanned ? "destructive" : "outline"}
                size="sm"
                className="h-7 px-2 text-xs shrink-0"
                onClick={() => setFilterBanned((v) => !v)}
                title="Показывать забаненных"
              >
                🚫
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
                          c.contactBan?.banned && "opacity-60",
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
                          {c.source === "self_play" && <Badge variant="warning">SIM</Badge>}
                          <Badge variant="secondary">{SOURCE_RU[c.source] ?? c.source}</Badge>
                          <Badge variant={c.mode === "human" ? "warning" : "outline"}>
                            {MODE_RU[c.mode] ?? c.mode}
                          </Badge>
                          {c.escalatedAt && <Badge variant="destructive">эскалация</Badge>}
                          {c.contactBan?.banned && <Badge variant="destructive">бан</Badge>}
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
                    {detail.conversation.contactBan?.banned && (
                      <Badge variant="destructive" className="gap-1">
                        <BanIcon className="size-3" />
                        бан
                      </Badge>
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
                <div className="flex shrink-0 items-center gap-1.5">
                  {detail.conversation.contactBan?.banned ? (
                    confirmUnbanContact ? (
                      <div className="flex items-center gap-1.5 text-sm">
                        <span className="text-muted-foreground">Разбанить?</span>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={handleUnbanContact}
                          disabled={unbanningContact}
                        >
                          Да
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setConfirmUnbanContact(false)}
                          disabled={unbanningContact}
                        >
                          Нет
                        </Button>
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1.5"
                        onClick={() => setConfirmUnbanContact(true)}
                        disabled={unbanningContact}
                        title="Снять блокировку контакта"
                      >
                        <BanIcon className="size-3.5" />
                        Разбанить
                      </Button>
                    )
                  ) : confirmBanContact ? (
                    <div className="flex items-center gap-1.5 text-sm">
                      <Input
                        value={banReason}
                        onChange={(e) => setBanReason(e.target.value)}
                        placeholder="Причина (опц.)"
                        className="h-8 w-36 text-xs"
                        disabled={banningContact}
                      />
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={handleBanContact}
                        disabled={banningContact}
                      >
                        Бан
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirmBanContact(false)}
                        disabled={banningContact}
                      >
                        Отмена
                      </Button>
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => setConfirmBanContact(true)}
                      disabled={banningContact}
                      title="Забанить контакт"
                    >
                      <BanIcon className="size-3.5" />
                    </Button>
                  )}
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
              </div>

              {operatorHandoffs.length > 0 && (
                <div className="border-b bg-amber-500/10 px-4 py-3">
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div className="min-w-0 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <AlertTriangleIcon className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                        <span className="text-sm font-semibold">Нужно действие оператора</span>
                        <Badge variant="warning">{operatorHandoffs.length}</Badge>
                      </div>
                      <div className="space-y-1">
                        {operatorHandoffs.slice(0, 2).map((item) => (
                          <div key={item.id} className="text-xs text-muted-foreground">
                            <span className="font-medium text-foreground">{item.title}</span>
                            {item.body ? ` · ${item.body}` : ""}
                            <span className="ml-1 font-mono">{fmtTime(item.createdAt)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                    {detail.conversation.mode !== "human" && (
                      <Button size="sm" variant="outline" onClick={handleToggleMode}>
                        Перехватить
                      </Button>
                    )}
                  </div>
                </div>
              )}

              <div
                ref={messagesContainerRef}
                onScroll={handleMessagesScroll}
                className="flex flex-1 flex-col gap-3 overflow-y-auto p-4"
              >
                {detail.messages.length === 0 ? (
                  <p className="text-center text-sm text-muted-foreground">Сообщений нет</p>
                ) : (
                  detail.messages.map((m) => {
                    const mine = m.role === "assistant" || m.role === "human";
                    const system = m.role === "system";
                    const showLabel = m.role !== "user";
                    const meta = parseMessageMeta(m.metaJson);
                    const operatorBot = meta ? operatorBotLabel(meta) : null;
                    const operatorAction = meta ? operatorActionLabel(meta.exchangeAction) : null;
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
                            {meta?.editedAt && (
                              <span className="text-[10px] italic text-muted-foreground/70">изменено</span>
                            )}
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
                            const attachments = mediaParts(meta);
                            if (attachments.length > 0) {
                              return (
                                <div className="space-y-2">
                                  <MessageMediaList
                                    parts={attachments}
                                    conversationId={selectedId}
                                    messageId={m.id}
                                  />
                                  {m.text && <div>{m.text}</div>}
                                </div>
                              );
                            }
                            return m.text
                              ? <span>{m.text}</span>
                              : <span className="italic text-muted-foreground">—</span>;
                          })()}
                        </div>
                        {(operatorBot || operatorAction || meta?.orderId || meta?.payoutCode) && (
                          <div className="mt-2 flex flex-wrap gap-1">
                            {operatorBot && (
                              <Badge variant="outline" className="border-[var(--success)]/30 text-[var(--success)]">
                                {operatorBot}
                              </Badge>
                            )}
                            {operatorAction && (
                              <Badge variant="secondary">{operatorAction}</Badge>
                            )}
                            {meta?.orderId && (
                              <Badge variant="outline">Заявка #{meta.orderId}</Badge>
                            )}
                            {meta?.payoutCode && (
                              <Badge variant="warning">Код {meta.payoutCode}</Badge>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
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
                  <div className="flex h-9 items-center">
                    <Badge
                      variant={
                        detail.conversation.status === "resolved"
                          ? "success"
                          : detail.conversation.status === "pending"
                            ? "warning"
                            : "secondary"
                      }
                    >
                      {STATUS_RU[detail.conversation.status] ?? detail.conversation.status}
                    </Badge>
                  </div>
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

              {detail.conversation.mode === "human" && (
                <QuickReplies stage={contactLead?.state ?? null} onPick={appendReplyDraft} />
              )}

              {/* Контакт и Лид */}
              <div className="space-y-3 border-t pt-4">
                <div className="space-y-1">
                  <label className="text-[11px] font-bold uppercase text-muted-foreground">Контакт</label>
                  <p className="text-sm font-medium">{detail.conversation.contactName || "Без имени"}</p>
                  <p className="text-[11px] text-muted-foreground">ID: {detail.conversation.contactId}</p>
                </div>

                <ConversationVerificationPanel attributesJson={detail.conversation.contactAttributesJson} />

                {contactLead ? (
                  <>
                    <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold">Лид</span>
                        <Link to={`/leads/${contactLead.id}`} className="text-primary">
                          <ExternalLinkIcon className="size-3.5" />
                        </Link>
                      </div>
                      <div className="space-y-1">
                        <p className="text-[11px] text-muted-foreground">Стадия</p>
                        <Badge variant="outline" className="text-[10px]">
                          {STATE_RU[contactLead.state] ?? contactLead.state}
                        </Badge>
                      </div>
                      <Button
                        size="sm"
                        className="w-full"
                        disabled={advancing}
                        onClick={async () => {
                          setAdvancing(true);
                          setError("");
                          try {
                            const r = await saas.advanceConversation(detail.conversation.id);
                            await refreshDetail(detail.conversation.id);
                            await refreshList();
                            const nextLead = await refreshContactLead(detail.conversation.contactId);
                            await refreshKbGuidance(nextLead?.id ?? null);
                            if (r.terminal) setError("");
                          } catch (err) {
                            if (!handleAuthError(err))
                              setError(err instanceof ApiError ? err.message : "Не удалось продвинуть");
                          } finally {
                            setAdvancing(false);
                          }
                        }}
                      >
                        {advancing ? "…" : "Продвинуть по воронке"}
                      </Button>
                    </div>
                    {detail.conversation.mode !== "human" && (
                      <LeadKbGuidanceCard
                        guidance={kbGuidance}
                        loading={kbGuidanceLoading}
                        error={kbGuidanceError}
                        onRefresh={() => void refreshKbGuidance(contactLead.id)}
                        variant="section"
                        onUseAction={appendReplyDraft}
                        actionButtonLabel="В ответ"
                      />
                    )}
                  </>
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
                          await refreshDetail(detail.conversation.id);
                          const nextLead = await refreshContactLead(detail.conversation.contactId);
                          await refreshKbGuidance(nextLead?.id ?? null);
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

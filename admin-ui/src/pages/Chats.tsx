import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ws } from "../App.tsx";
import { api, type Conversation, type ConversationSource } from "../api.ts";

function relativeTime(unix: number | null) {
  if (!unix) return "—";
  const diff = Math.floor((Date.now() - unix * 1000) / 1000);
  if (diff < 60) return `${diff} с назад`;
  if (diff < 3600) return `${Math.floor(diff / 60)} мин назад`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} ч назад`;
  return `${Math.floor(diff / 86400)} дн назад`;
}

const MODE_LABEL: Record<Conversation["mode"], string> = {
  ai: "бот",
  queued: "очередь",
  human: "оператор",
};

function modeBadge(mode: Conversation["mode"]) {
  return <span className={`badge badge-${mode}`}>{MODE_LABEL[mode] ?? mode}</span>;
}

// Channel badge — `userbot` is the real funnel, `bot` is test traffic.
const SOURCE_LABEL: Record<ConversationSource, string> = {
  userbot: "личка",
  bot: "тест",
  self_play: "self-play",
};
const SOURCE_COLOR: Record<ConversationSource, string> = {
  userbot: "#16a34a",
  bot: "#9ca3af",
  self_play: "#a855f7",
};
function sourceBadge(source: ConversationSource) {
  return (
    <span
      style={{
        fontSize: 11,
        padding: "1px 6px",
        borderRadius: 4,
        border: `1px solid ${SOURCE_COLOR[source]}`,
        color: SOURCE_COLOR[source],
      }}
    >
      {SOURCE_LABEL[source]}
    </span>
  );
}

// Filter options for the channel selector. `userbot` first so the default
// view is the real funnel — test traffic stays out of sight unless asked for.
const SOURCE_FILTERS: Array<{ value: ConversationSource | "all"; label: string }> = [
  { value: "userbot", label: "Личка" },
  { value: "bot", label: "Тест" },
  { value: "all", label: "Все" },
];

export function Chats() {
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [sourceFilter, setSourceFilter] = useState<ConversationSource | "all">("userbot");
  // Conversation id to flash — set when Layout navigated here because a
  // chat just escalated into the queue.
  const [highlightId, setHighlightId] = useState<number | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const tickRef = useRef<ReturnType<typeof setInterval>>(null);
  // Keep the latest filter in a ref so the WS-triggered reload (set up once
  // in an effect) always reads the current value without re-subscribing.
  const sourceRef = useRef(sourceFilter);
  sourceRef.current = sourceFilter;

  function reload() {
    const s = sourceRef.current;
    api
      .conversations(false, s === "all" ? undefined : s)
      .then(({ conversations }) => setConvs(conversations))
      .finally(() => setLoading(false));
  }

  async function handleDelete(c: Conversation, e: React.MouseEvent) {
    e.stopPropagation();
    const label = c.user.tg_username ? `@${c.user.tg_username}` : `tg:${c.user.tg_user_id}`;
    if (
      !confirm(
        `Удалить чат с ${label}? Сообщения будут стёрты, статус сбросится. Действие необратимо.`,
      )
    ) {
      return;
    }
    setConvs((prev) => prev.filter((x) => x.id !== c.id));
    try {
      await api.deleteConversation(c.id);
    } catch (err) {
      console.error("[chats] delete failed", err);
      reload();
    }
  }

  useEffect(() => {
    reload();
    tickRef.current = setInterval(reload, 10_000);
    const unsub = ws.on((evt) => {
      if (evt.type === "message:new" || evt.type === "conversation:updated") {
        reload();
      }
    });
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fetch when the operator switches the channel filter.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    reload();
  }, [sourceFilter]);

  // Flash the row of a chat that just escalated — Layout passes its id
  // (with a timestamp so a repeat escalation re-triggers) via router state.
  useEffect(() => {
    const state = location.state as { highlightConvId?: number } | null;
    if (!state?.highlightConvId) return;
    setHighlightId(state.highlightConvId);
    const t = setTimeout(() => setHighlightId(null), 5000);
    return () => clearTimeout(t);
  }, [location.state]);

  const queued = convs.filter((c) => c.mode === "queued");
  const rest = convs.filter((c) => c.mode !== "queued");

  return (
    <div className="page fade-in">
      <div className="page-header">
        <span className="page-title">Чаты</span>
        <span className="page-count">— {convs.length}</span>
        {queued.length > 0 && (
          <span className="queued-alert" data-testid="queued-count">
            ▲ {queued.length} требует внимания
          </span>
        )}
        <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
          {SOURCE_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setSourceFilter(f.value)}
              className={`btn btn-sm ${sourceFilter === f.value ? "btn-primary" : "btn-ghost"}`}
            >
              {f.label}
            </button>
          ))}
        </span>
      </div>

      {loading ? (
        <div className="loading-text">загрузка…</div>
      ) : (
        <div data-testid="chats-list">
          {[...queued, ...rest].map((c) => (
            <div
              key={c.id}
              onClick={() => navigate(`/admin/chats/${c.id}`)}
              data-testid={`chat-row-${c.id}`}
              data-mode={c.mode}
              className={`chat-card fade-in${c.mode === "queued" ? " queued" : ""}${
                c.id === highlightId ? " chat-card-highlight" : ""
              }`}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="chat-name">
                  {c.user.tg_username ? `@${c.user.tg_username}` : `tg:${c.user.tg_user_id}`}
                </div>
                <div className="chat-time">{relativeTime(c.last_message_at)}</div>
              </div>

              {sourceBadge(c.source)}
              {modeBadge(c.mode)}

              <button
                onClick={(e) => handleDelete(c, e)}
                data-testid={`delete-chat-${c.id}`}
                title="Удалить чат"
                aria-label="Удалить чат"
                className="btn btn-ghost btn-icon"
                style={{ fontSize: 16 }}
              >
                ×
              </button>
            </div>
          ))}

          {convs.length === 0 && <div className="empty">Нет чатов.</div>}
        </div>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Conversation } from "../api.ts";
import { ws } from "../App.tsx";

function relativeTime(unix: number | null) {
  if (!unix) return "—";
  const diff = Math.floor((Date.now() - unix * 1000) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function modeBadge(mode: Conversation["mode"]) {
  return (
    <span className={`badge badge-${mode}`}>{mode}</span>
  );
}

export function Chats() {
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  const tickRef = useRef<ReturnType<typeof setInterval>>(null);

  function reload() {
    api
      .conversations()
      .then(({ conversations }) => setConvs(conversations))
      .finally(() => setLoading(false));
  }

  async function handleDelete(c: Conversation, e: React.MouseEvent) {
    e.stopPropagation();
    const label = c.user.tg_username
      ? `@${c.user.tg_username}`
      : `tg:${c.user.tg_user_id}`;
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
      if (
        evt.type === "message:new" ||
        evt.type === "conversation:updated"
      ) {
        reload();
      }
    });
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
      unsub();
    };
  }, []);

  const queued = convs.filter((c) => c.mode === "queued");
  const rest = convs.filter((c) => c.mode !== "queued");

  return (
    <div className="page fade-in">
      <div className="page-header">
        <span className="page-title">Chats</span>
        <span className="page-count">— {convs.length}</span>
        {queued.length > 0 && (
          <span className="queued-alert" data-testid="queued-count">
            ▲ {queued.length} needs attention
          </span>
        )}
      </div>

      {loading ? (
        <div className="loading-text">loading…</div>
      ) : (
        <div data-testid="chats-list">
          {[...queued, ...rest].map((c) => (
            <div
              key={c.id}
              onClick={() => navigate(`/admin/chats/${c.id}`)}
              data-testid={`chat-row-${c.id}`}
              data-mode={c.mode}
              className={`chat-card fade-in${c.mode === "queued" ? " queued" : ""}`}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="chat-name">
                  {c.user.tg_username
                    ? `@${c.user.tg_username}`
                    : `tg:${c.user.tg_user_id}`}
                </div>
                <div className="chat-time">{relativeTime(c.last_message_at)}</div>
              </div>

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

          {convs.length === 0 && (
            <div className="empty">No conversations yet.</div>
          )}
        </div>
      )}
    </div>
  );
}

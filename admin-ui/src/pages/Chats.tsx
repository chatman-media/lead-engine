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
  const styles: Record<
    string,
    { bg: string; color: string; label: string }
  > = {
    ai: { bg: "rgba(59,130,246,0.12)", color: "var(--blue)", label: "ai" },
    queued: {
      bg: "var(--amber-dim)",
      color: "var(--amber)",
      label: "queued",
    },
    human: {
      bg: "rgba(34,197,94,0.12)",
      color: "var(--green)",
      label: "human",
    },
  };
  const s = styles[mode]!;
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        background: s.bg,
        color: s.color,
        borderRadius: "var(--radius)",
        fontFamily: "var(--mono)",
        fontSize: 11,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.05em",
      }}
    >
      {s.label}
    </span>
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
    <div style={{ padding: "28px 32px" }} className="fade-in">
      <h1
        style={{
          fontFamily: "var(--mono)",
          fontSize: 14,
          fontWeight: 600,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "var(--text-2)",
          marginBottom: 20,
        }}
      >
        Chats —{" "}
        <span style={{ color: "var(--text)" }}>{convs.length}</span>
        {queued.length > 0 && (
          <span
            style={{
              marginLeft: 12,
              fontFamily: "var(--mono)",
              fontSize: 12,
              color: "var(--amber)",
            }}
            data-testid="queued-count"
          >
            ▲ {queued.length} needs attention
          </span>
        )}
      </h1>

      {loading ? (
        <div style={{ color: "var(--text-3)", fontFamily: "var(--mono)" }}>
          loading…
        </div>
      ) : (
        <div data-testid="chats-list">
          {[...queued, ...rest].map((c, i) => (
            <div
              key={c.id}
              onClick={() => navigate(`/admin/chats/${c.id}`)}
              data-testid={`chat-row-${c.id}`}
              data-mode={c.mode}
              className="fade-in"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 16,
                padding: "12px 16px",
                marginBottom: 4,
                background: "var(--bg-1)",
                border: `1px solid ${
                  c.mode === "queued" ? "var(--amber)" : "var(--border)"
                }`,
                borderRadius: "var(--radius)",
                cursor: "pointer",
                transition: "border-color 0.15s, background 0.15s",
                animation: `fade-in 0.15s ${i * 0.02}s ease both`,
                ...(c.mode === "queued"
                  ? { animation: "pulse-amber 2s infinite" }
                  : {}),
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--bg-2)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "var(--bg-1)";
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontFamily: "var(--mono)",
                    fontSize: 13,
                    color: "var(--text)",
                    marginBottom: 3,
                  }}
                >
                  {c.user.tg_username
                    ? `@${c.user.tg_username}`
                    : `tg:${c.user.tg_user_id}`}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-3)" }}>
                  {relativeTime(c.last_message_at)}
                </div>
              </div>
              {modeBadge(c.mode)}
            </div>
          ))}

          {convs.length === 0 && (
            <div
              style={{
                color: "var(--text-3)",
                fontFamily: "var(--mono)",
                textAlign: "center",
                marginTop: 60,
              }}
            >
              No conversations yet.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

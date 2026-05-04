import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  api,
  type Conversation,
  type Message,
  type MessageTelemetry,
  type User,
  type UserMemory,
} from "../api.ts";
import { ws } from "../App.tsx";
import { MemoryPane } from "../components/MemoryPane.tsx";

function tsShort(unix: number) {
  return new Date(unix * 1000).toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

const ROLE_COLOR: Record<string, string> = {
  user: "var(--text)",
  assistant: "var(--blue)",
  human: "var(--amber)",
  system: "var(--text-3)",
};

const ROLE_LABEL: Record<string, string> = {
  user: "user",
  assistant: "bot",
  human: "manager",
  system: "system",
};

export function Chat() {
  const { id } = useParams<{ id: string }>();
  const convId = Number(id);
  const navigate = useNavigate();

  const [conv, setConv] = useState<Conversation | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [memory, setMemory] = useState<UserMemory | null>(null);
  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);
  // Debug toggle: when on, each assistant/human message gets a small
  // telemetry strip beneath it (path, latencies, distances, reflect verdict).
  // Off by default — most operators only want the conversation view.
  const [debug, setDebug] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  function reload() {
    api.conversation(convId).then(({ conversation, user, messages, memory }) => {
      setConv(conversation);
      setUser(user);
      setMessages(messages);
      setMemory(memory);
    });
  }

  useEffect(() => {
    reload();
    const unsub = ws.on((evt) => {
      if (
        (evt.type === "message:new" && evt.conversationId === convId) ||
        (evt.type === "conversation:updated" && evt.conversationId === convId)
      ) {
        reload();
      }
    });
    return unsub;
  }, [convId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  async function handleTake() {
    await api.take(convId);
    reload();
  }

  async function handleRelease() {
    await api.release(convId);
    reload();
  }

  async function handleDelete() {
    const userLabel = user?.tg_username
      ? `@${user.tg_username}`
      : `tg:${user?.tg_user_id}`;
    if (
      !confirm(
        `Удалить чат с ${userLabel}? Сообщения будут стёрты, статус сбросится. Действие необратимо.`,
      )
    ) {
      return;
    }
    await api.deleteConversation(convId);
    navigate("/admin/chats");
  }

  async function handleSend() {
    const text = replyText.trim();
    if (!text) return;
    setSending(true);
    try {
      await api.sendMessage(convId, text);
      setReplyText("");
      reload();
    } finally {
      setSending(false);
    }
  }

  if (!conv || !user) {
    return (
      <div
        style={{
          padding: 32,
          color: "var(--text-3)",
          fontFamily: "var(--mono)",
        }}
      >
        loading…
      </div>
    );
  }

  const isHuman = conv.mode === "human";
  const isQueued = conv.mode === "queued";

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
      className="fade-in"
    >
      {/* Header */}
      <div
        style={{
          padding: "16px 24px",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-1)",
          display: "flex",
          alignItems: "center",
          gap: 16,
          flexShrink: 0,
        }}
      >
        <button
          onClick={() => navigate("/admin/chats")}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--text-3)",
            fontSize: 18,
            padding: "0 8px 0 0",
          }}
          title="Back"
        >
          ←
        </button>

        <div style={{ flex: 1 }}>
          <div
            style={{
              fontFamily: "var(--mono)",
              fontWeight: 600,
              fontSize: 14,
            }}
          >
            {user.tg_username ? `@${user.tg_username}` : `tg:${user.tg_user_id}`}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 2 }}>
            status: {user.status} · tg_id: {user.tg_user_id}
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {(isQueued || isHuman) && (
            <span
              style={{
                fontFamily: "var(--mono)",
                fontSize: 11,
                color: isQueued ? "var(--amber)" : "var(--green)",
                padding: "3px 10px",
                border: `1px solid ${isQueued ? "var(--amber)" : "var(--green)"}`,
                borderRadius: "var(--radius)",
              }}
              data-testid="mode-badge"
            >
              {conv.mode.toUpperCase()}
            </span>
          )}

          {!isHuman && (
            <button
              onClick={handleTake}
              data-testid="take-btn"
              style={actionBtnStyle("var(--amber)")}
            >
              Take over
            </button>
          )}

          {isHuman && (
            <button
              onClick={handleRelease}
              data-testid="release-btn"
              style={actionBtnStyle("var(--text-3)")}
            >
              Release
            </button>
          )}

          <button
            onClick={() => setDebug((d) => !d)}
            data-testid="debug-toggle"
            title="Показать диагностику ответов бота: путь, латентности, расстояния KB, reflect-вердикт"
            style={actionBtnStyle(debug ? "var(--amber)" : "var(--text-3)")}
          >
            {debug ? "DEBUG ON" : "DEBUG"}
          </button>

          <a
            href={api.conversationExportUrl(convId)}
            download={`conversation-${convId}.jsonl`}
            data-testid="export-btn"
            title="Скачать диалог в формате JSONL (one OpenAI fine-tune sample per line)"
            style={{
              ...actionBtnStyle("var(--text-3)"),
              textDecoration: "none",
              display: "inline-flex",
              alignItems: "center",
            }}
          >
            ↓ JSONL
          </a>

          <button
            onClick={handleDelete}
            data-testid="delete-btn"
            title="Удалить чат и сбросить статус"
            style={actionBtnStyle("var(--red, #ef4444)")}
          >
            Delete
          </button>
        </div>
      </div>

      {/* Cross-session memory pane (collapsed by default) */}
      {memory && (
        <MemoryPane
          userId={user.id}
          initialMemory={memory}
          onSaved={(next) => setMemory(next)}
        />
      )}

      {/* Messages */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "24px",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
        data-testid="messages-list"
      >
        {messages.map((m) => (
          <div
            key={m.id}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems:
                m.role === "user" ? "flex-start" : "flex-end",
              gap: 4,
            }}
          >
            <div
              style={{
                maxWidth: "72%",
                padding: "10px 14px",
                background:
                  m.role === "user" ? "var(--bg-2)" : "var(--bg-3)",
                border: `1px solid ${
                  m.role === "user" ? "var(--border)" : "transparent"
                }`,
                borderRadius: 6,
                fontSize: 13,
                lineHeight: 1.5,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {m.text}
            </div>
            <div
              style={{
                fontFamily: "var(--mono)",
                fontSize: 10,
                color: ROLE_COLOR[m.role] ?? "var(--text-3)",
                display: "flex",
                gap: 6,
              }}
            >
              <span>{ROLE_LABEL[m.role] ?? m.role}</span>
              <span style={{ color: "var(--text-3)" }}>
                {tsShort(m.created_at)}
              </span>
            </div>
            {debug && <TelemetryStrip message={m} />}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Reply box — only in human mode */}
      {isHuman && (
        <div
          style={{
            padding: "16px 24px",
            borderTop: "1px solid var(--border)",
            background: "var(--bg-1)",
            display: "flex",
            gap: 10,
            flexShrink: 0,
          }}
        >
          <textarea
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            placeholder="Type a reply and press Ctrl+Enter…"
            data-testid="reply-input"
            rows={2}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) handleSend();
            }}
            style={{
              flex: 1,
              background: "var(--bg-2)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              padding: "10px 12px",
              color: "var(--text)",
              fontFamily: "var(--mono)",
              fontSize: 13,
              resize: "none",
              outline: "none",
            }}
          />
          <button
            onClick={handleSend}
            disabled={sending || !replyText.trim()}
            data-testid="send-btn"
            style={{
              padding: "0 20px",
              background: sending ? "var(--bg-3)" : "var(--amber)",
              color: sending ? "var(--text-3)" : "#000",
              border: "none",
              borderRadius: "var(--radius)",
              fontFamily: "var(--mono)",
              fontWeight: 600,
              fontSize: 12,
              letterSpacing: "0.05em",
              alignSelf: "stretch",
              transition: "background 0.15s",
            }}
          >
            SEND
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * One-line diagnostic strip rendered under each message when debug is on.
 * Reads `message.meta_json` (set by webhook on assistant replies) and
 * surfaces only the parts an operator actually uses for diagnosis: which
 * code path the answer took, latencies per stage, top-k retrieval distances,
 * the rewritten query (if any), and reflection verdict (if any).
 */
function TelemetryStrip({ message }: { message: Message }) {
  if (!message.meta_json) return null;
  let parsed: { telemetry?: MessageTelemetry; used_chunk_ids?: number[] } = {};
  try {
    parsed = JSON.parse(message.meta_json);
  } catch {
    return null;
  }
  const t = parsed.telemetry;
  if (!t) return null;

  const pieces: string[] = [];
  pieces.push(`path=${t.path}`);
  if (t.total_ms !== undefined) pieces.push(`total=${t.total_ms}ms`);
  if (t.retrieval_ms !== undefined) pieces.push(`retr=${t.retrieval_ms}ms`);
  if (t.generation_ms !== undefined) pieces.push(`gen=${t.generation_ms}ms`);
  if (t.hybrid) pieces.push("hybrid");
  if (t.top_distances?.length) {
    pieces.push(`d=[${t.top_distances.map((d) => d.toFixed(3)).join(", ")}]`);
  }
  if (t.reflect) {
    pieces.push(
      t.reflect.grounded
        ? "reflect=ok"
        : `reflect=FAIL${t.reflect.reason ? ` (${t.reflect.reason})` : ""}`,
    );
  }

  const color =
    t.path === "ungrounded"
      ? "var(--red, #ef4444)"
      : t.path === "no_context"
        ? "var(--amber)"
        : t.path === "ok"
          ? "var(--green)"
          : "var(--text-3)";

  return (
    <div
      data-testid="telemetry-strip"
      style={{
        maxWidth: "72%",
        marginTop: 4,
        padding: "4px 8px",
        fontFamily: "var(--mono)",
        fontSize: 10,
        color,
        background: "var(--bg-2)",
        border: "1px solid var(--border)",
        borderRadius: 4,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {pieces.join(" · ")}
      {t.original_query !== undefined && (
        <div style={{ marginTop: 2, color: "var(--text-3)" }}>
          rewrite: {t.original_query} → {t.rewritten_query}
        </div>
      )}
    </div>
  );
}

function actionBtnStyle(color: string): React.CSSProperties {
  return {
    padding: "6px 14px",
    background: "transparent",
    border: `1px solid ${color}`,
    borderRadius: "var(--radius)",
    color,
    fontFamily: "var(--mono)",
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: "0.05em",
    transition: "all 0.1s",
  };
}

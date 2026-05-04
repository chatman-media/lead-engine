import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  api,
  type Conversation,
  type Message,
  type MessageTelemetry,
  type User,
  type UserMemory,
} from "../api";
import { ws } from "../App";
import { MemoryPane } from "../components/MemoryPane";

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

const BUBBLE_CLASS: Record<string, string> = {
  user: "bubble bubble-user",
  assistant: "bubble bubble-bot",
  human: "bubble bubble-human",
  system: "bubble bubble-system",
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
    return <div className="loading-text" style={{ padding: 32 }}>loading…</div>;
  }

  const isHuman = conv.mode === "human";
  const isQueued = conv.mode === "queued";

  return (
    <div className="chat-view fade-in">
      {/* Header */}
      <div className="chat-header">
        <button
          onClick={() => navigate("/admin/chats")}
          className="btn btn-ghost btn-icon"
          title="Back"
          style={{ fontSize: 18 }}
        >
          ←
        </button>

        <div className="chat-header-info">
          <div className="chat-header-name">
            {user.tg_username ? `@${user.tg_username}` : `tg:${user.tg_user_id}`}
          </div>
          <div className="chat-header-meta">
            status: {user.status} · tg_id: {user.tg_user_id}
          </div>
        </div>

        <div className="chat-header-actions">
          {(isQueued || isHuman) && (
            <span
              className={`mode-chip ${conv.mode}`}
              data-testid="mode-badge"
            >
              {conv.mode}
            </span>
          )}

          {!isHuman && (
            <button
              onClick={handleTake}
              data-testid="take-btn"
              className="btn btn-warn btn-sm"
            >
              Take over
            </button>
          )}

          {isHuman && (
            <button
              onClick={handleRelease}
              data-testid="release-btn"
              className="btn btn-ghost btn-sm"
            >
              Release
            </button>
          )}

          <button
            onClick={() => setDebug((d) => !d)}
            data-testid="debug-toggle"
            title="Показать диагностику ответов бота: путь, латентности, расстояния KB, reflect-вердикт"
            className={`btn btn-sm ${debug ? "btn-warn" : "btn-ghost"}`}
          >
            {debug ? "DEBUG ON" : "DEBUG"}
          </button>

          <a
            href={api.conversationExportUrl(convId)}
            download={`conversation-${convId}.jsonl`}
            data-testid="export-btn"
            title="Скачать диалог в формате JSONL (one OpenAI fine-tune sample per line)"
            className="btn btn-ghost btn-sm"
            style={{ textDecoration: "none" }}
          >
            ↓ JSONL
          </a>

          <button
            onClick={handleDelete}
            data-testid="delete-btn"
            className="btn btn-danger btn-sm"
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
      <div className="messages" data-testid="messages-list">
        {messages.map((m) => (
          <div
            key={m.id}
            className={`msg ${m.role === "user" ? "msg-left" : "msg-right"}`}
          >
            <div className={BUBBLE_CLASS[m.role] ?? "bubble bubble-user"}>
              {m.text}
            </div>
            <div className="msg-meta">
              <span style={{ color: ROLE_COLOR[m.role] ?? "var(--text-3)" }}>
                {ROLE_LABEL[m.role] ?? m.role}
              </span>
              <span>{tsShort(m.created_at)}</span>
            </div>
            {debug && <TelemetryStrip message={m} />}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Reply box — only in human mode */}
      {isHuman && (
        <div className="reply-box">
          <textarea
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            placeholder="Type a reply and press Ctrl+Enter…"
            data-testid="reply-input"
            rows={2}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) handleSend();
            }}
            className="input"
            style={{ flex: 1 }}
          />
          <button
            onClick={handleSend}
            disabled={sending || !replyText.trim()}
            data-testid="send-btn"
            className="btn btn-primary"
          >
            Send
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


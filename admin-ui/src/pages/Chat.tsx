import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, type Conversation, type Message, type User } from "../api.ts";
import { ws } from "../App.tsx";

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
  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  function reload() {
    api.conversation(convId).then(({ conversation, user, messages }) => {
      setConv(conversation);
      setUser(user);
      setMessages(messages);
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
            onClick={handleDelete}
            data-testid="delete-btn"
            className="btn btn-danger btn-sm"
          >
            Delete
          </button>
        </div>
      </div>

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

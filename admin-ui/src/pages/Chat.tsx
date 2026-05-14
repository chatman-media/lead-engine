import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ws } from "../App";
import {
  api,
  type Conversation,
  type ConversationSummary,
  type Message,
  type MessageTelemetry,
  type User,
  type UserMemory,
} from "../api";
import { MemoryPane } from "../components/MemoryPane";
import { SummaryPane } from "../components/SummaryPane";

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
  const [summary, setSummary] = useState<ConversationSummary | null>(null);
  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);
  // After a successful reply, prompt operator to add Q&A to KB.
  const [addToKb, setAddToKb] = useState<{ question: string; answer: string } | null>(null);
  const [kbFlash, setKbFlash] = useState<string | null>(null);
  // Debug toggle: when on, each assistant/human message gets a small
  // telemetry strip beneath it (path, latencies, distances, reflect verdict).
  // Off by default — most operators only want the conversation view.
  const [debug, setDebug] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  function reload() {
    api.conversation(convId).then(({ conversation, user, messages, memory, summary }) => {
      setConv(conversation);
      setUser(user);
      setMessages(messages);
      setMemory(memory);
      setSummary(summary);
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

  async function handlePromoteLead() {
    try {
      const { lead } = await api.promoteLead(convId);
      navigate(`/admin/leads`);
      // Navigate is synchronous router push; the toast-equivalent hint
      // is intentionally absent — Leads page shows the new card.
      void lead;
    } catch (err) {
      alert(`Не удалось продвинуть в лиды: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handleDelete() {
    const userLabel = user?.tg_username ? `@${user.tg_username}` : `tg:${user?.tg_user_id}`;
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
    // Clear the input optimistically before the API roundtrip so the
    // operator can immediately start typing the next reply (and so the
    // e2e test doesn't race the await on api.sendMessage).
    setReplyText("");
    setSending(true);
    try {
      await api.sendMessage(convId, text);
    } catch (err) {
      // Backend persists the message to the DB BEFORE attempting the
      // Telegram send, so a 502 here means "saved but delivery failed"
      // (typically a stale chat session / 404 from Telegram). The row
      // shows up in the conversation list on reload either way; don't
      // restore the input or the operator would think nothing happened.
      // The alert is the only signal that delivery itself didn't land.
      alert(`Ошибка отправки в Telegram: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Find last user message to pre-fill the KB suggestion question —
    // outside the try so the prompt opens even when the Telegram leg
    // failed but the DB write succeeded.
    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    if (lastUserMsg) {
      setAddToKb({ question: lastUserMsg.text, answer: text });
    }
    reload();
    setSending(false);
  }

  async function handleAddToKb() {
    if (!addToKb) return;
    try {
      await api.createKbSuggestion({
        question_text: addToKb.question,
        answer_draft: addToKb.answer,
        source_conversation_id: convId,
      });
      setAddToKb(null);
      setKbFlash("✓ Добавлено в очередь KB");
      setTimeout(() => setKbFlash(null), 3000);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  }

  if (!conv || !user) {
    return (
      <div className="loading-text" style={{ padding: 32 }}>
        loading…
      </div>
    );
  }

  const isHuman = conv.mode === "human";

  return (
    <div className="chat-view fade-in">
      {/* Header */}
      <div className="chat-header">
        <button
          onClick={() => navigate("/admin/chats")}
          className="btn btn-ghost btn-icon"
          title="Назад"
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
          {/* Mode selector — segmented control */}
          <div className="mode-selector" data-testid="mode-selector">
            <button
              className={`mode-btn ${conv.mode === "ai" ? "mode-btn-active" : ""}`}
              onClick={conv.mode !== "ai" ? handleRelease : undefined}
              disabled={conv.mode === "ai"}
              data-testid="release-btn"
              title="Бот отвечает автоматически"
            >
              🤖 Авто
            </button>
            <button
              className={`mode-btn ${conv.mode === "queued" ? "mode-btn-active mode-btn-queued" : ""}`}
              disabled
              title="Ждёт оператора"
            >
              ⏳ Очередь
            </button>
            <button
              className={`mode-btn ${conv.mode === "human" ? "mode-btn-active mode-btn-human" : ""}`}
              onClick={conv.mode !== "human" ? handleTake : undefined}
              disabled={conv.mode === "human"}
              data-testid="take-btn"
              title="Оператор отвечает вручную"
            >
              👤 Я
            </button>
          </div>

          <button
            onClick={handlePromoteLead}
            data-testid="promote-lead-btn"
            title="Создать лида из этого диалога — бот запостит карточку в LEADS_CHAT_ID с кнопками одобрить/отклонить"
            className="btn btn-warn btn-sm"
          >
            → Lead
          </button>

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

          <button onClick={handleDelete} data-testid="delete-btn" className="btn btn-danger btn-sm">
            Delete
          </button>
        </div>
      </div>

      {/* Cross-session memory pane (collapsed by default) */}
      {memory && (
        <MemoryPane userId={user.id} initialMemory={memory} onSaved={(next) => setMemory(next)} />
      )}

      {/* Long-conversation summary (only rendered when one exists) */}
      <SummaryPane summary={summary} />

      {/* Messages */}
      <div className="messages" data-testid="messages-list">
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role === "user" ? "msg-left" : "msg-right"}`}>
            <div className={BUBBLE_CLASS[m.role] ?? "bubble bubble-user"}>
              <MessageBody message={m} />
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
            placeholder="Ответ оператора (Ctrl+Enter для отправки)…"
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
            Отправить
          </button>
        </div>
      )}

      {/* "Add to KB" prompt — shown after operator sends a reply */}
      {kbFlash && (
        <div
          style={{
            padding: "8px 16px",
            background: "rgba(34,197,94,0.1)",
            color: "var(--green)",
            fontSize: 13,
            borderTop: "1px solid var(--border)",
          }}
        >
          {kbFlash}
        </div>
      )}
      {addToKb && !kbFlash && (
        <div
          style={{
            padding: "12px 16px",
            background: "var(--bg-2)",
            borderTop: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div style={{ fontSize: 12, color: "var(--text-3)" }}>
            Добавить этот ответ в базу знаний?
          </div>
          <div style={{ fontSize: 12, color: "var(--text-2)", fontFamily: "var(--mono)" }}>
            Q: {addToKb.question.slice(0, 120)}
            {addToKb.question.length > 120 ? "…" : ""}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-sm btn-primary" onClick={handleAddToKb}>
              В базу знаний
            </button>
            <button className="btn btn-sm btn-ghost" onClick={() => setAddToKb(null)}>
              Пропустить
            </button>
          </div>
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
/**
 * Renders the body of a message bubble. Three cases:
 *   - text-only message → render `m.text` plain
 *   - media message with caption → render media + caption text below
 *   - media message without caption → render media only (skip the
 *     auto-stamped placeholder like "[photo]" / "[video]")
 *
 * Media is fetched through /admin/api/tg-files/:fileId — same-origin
 * proxy that holds the bot token. Authentication is the admin session
 * cookie (auto-sent on same-origin <img>/<video> requests).
 */
function MessageBody({ message }: { message: Message }) {
  let media: { type: string; file_id: string } | null = null;
  if (message.meta_json) {
    try {
      const parsed = JSON.parse(message.meta_json) as {
        media?: { type: string; file_id: string };
      };
      if (parsed.media?.file_id) media = parsed.media;
    } catch {
      // ignore — non-JSON meta or schema drift
    }
  }

  if (!media) {
    return <>{message.text}</>;
  }

  // Caption: hide the placeholder text the webhook auto-stamps
  // ("[photo]" / "[video]" / "[document]" / "[voice]") since the
  // media itself is the content. Real captions stay visible.
  const isPlaceholder = /^\[(photo|video|document|voice)\]$/.test(message.text);
  const caption = isPlaceholder ? "" : message.text;
  const url = api.tgFileUrl(media.file_id);

  let preview: React.ReactNode = null;
  if (media.type === "photo") {
    preview = (
      <a href={url} target="_blank" rel="noopener noreferrer">
        <img
          src={url}
          alt="photo"
          loading="lazy"
          style={{
            maxWidth: "100%",
            maxHeight: 360,
            borderRadius: 4,
            display: "block",
          }}
        />
      </a>
    );
  } else if (media.type === "video") {
    preview = (
      <video
        src={url}
        controls
        preload="metadata"
        style={{
          maxWidth: "100%",
          maxHeight: 360,
          borderRadius: 4,
          display: "block",
        }}
      />
    );
  } else if (media.type === "voice") {
    preview = <audio src={url} controls preload="metadata" style={{ maxWidth: "100%" }} />;
  } else {
    // document — just a download link with a paperclip glyph
    preview = (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        style={{ color: "var(--blue)", textDecoration: "underline" }}
      >
        📎 document
      </a>
    );
  }

  return (
    <div
      data-testid="message-media"
      data-media-type={media.type}
      style={{ display: "flex", flexDirection: "column", gap: 4 }}
    >
      {preview}
      {caption && <div style={{ marginTop: 4 }}>{caption}</div>}
    </div>
  );
}

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

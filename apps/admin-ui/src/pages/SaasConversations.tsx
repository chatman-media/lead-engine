import { type FormEvent, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ApiError,
  clearToken,
  type ConversationDetail,
  type ConversationListItem,
  type MessageRow,
  saas,
} from "../api/saas.ts";

/**
 * Inbox view: список диалогов (left) + thread активного (right).
 * Auto-poll каждые 5s для активного thread'а — простой long-polling
 * shim до настоящего WS-feed'а (отдельный PR).
 */
const POLL_INTERVAL_MS = 5000;

function fmtTime(epoch: number | null): string {
  if (!epoch) return "—";
  return new Date(epoch * 1000).toLocaleString();
}

function fmtShortTime(epoch: number): string {
  return new Date(epoch * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function SaasConversations() {
  const navigate = useNavigate();
  const params = useParams<{ id?: string }>();
  const selectedId = params.id ? Number.parseInt(params.id, 10) : null;

  const [list, setList] = useState<ConversationListItem[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [detail, setDetail] = useState<{
    conversation: ConversationDetail;
    messages: MessageRow[];
  } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);
  const [togglingMode, setTogglingMode] = useState(false);

  function handleAuthError(err: unknown): boolean {
    if (err instanceof ApiError && err.status === 401) {
      clearToken();
      navigate("/login", { replace: true });
      return true;
    }
    return false;
  }

  async function refreshList() {
    try {
      const res = await saas.listConversations({ limit: 50 });
      setList(res.items);
    } catch (err) {
      if (handleAuthError(err)) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function refreshDetail(id: number) {
    try {
      const res = await saas.getConversation(id);
      setDetail(res);
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

  // Initial list load
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await refreshList();
      if (!cancelled) setListLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: navigate stable
  }, []);

  // Load detail when id changes
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
    // biome-ignore lint/correctness/useExhaustiveDependencies: navigate stable
  }, [selectedId]);

  async function handleToggleMode() {
    if (!detail || !selectedId) return;
    const next = detail.conversation.mode === "human" ? "ai" : "human";
    if (next === "human" && !confirm("Перехватить диалог? AI перестанет отвечать.")) {
      return;
    }
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
      if (err instanceof ApiError) {
        if (err.status === 409) {
          setError("Не удалось отправить: канал клиента недоступен (удалён?)");
        } else {
          setError(`Ошибка ${err.status}: ${err.errorCode}`);
        }
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSending(false);
    }
  }

  // Auto-poll the selected thread + list every 5s.
  useEffect(() => {
    const t = setInterval(() => {
      void refreshList();
      if (selectedId) void refreshDetail(selectedId);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(t);
    // biome-ignore lint/correctness/useExhaustiveDependencies: navigate stable
  }, [selectedId]);

  return (
    <div className="dashboard inbox-layout">
      <header className="dashboard-header">
        <div>
          <h1>Диалоги</h1>
          <p className="dashboard-sub">
            Входящие от клиентов + ответы бота. Авто-обновление каждые 5 сек.
          </p>
        </div>
        <Link to="/dashboard" className="back-link">
          ← К базе знаний
        </Link>
      </header>

      {error && <div className="dashboard-error">{error}</div>}

      <div className="inbox-grid">
        <aside className="inbox-sidebar">
          <h2>Список ({list.length})</h2>
          {listLoading ? (
            <p className="muted">Загрузка…</p>
          ) : list.length === 0 ? (
            <p className="empty-state">Пока нет диалогов</p>
          ) : (
            <ul className="inbox-list">
              {list.map((c) => (
                <li key={c.id}>
                  <Link
                    to={`/conversations/${c.id}`}
                    className={`inbox-item ${c.id === selectedId ? "active" : ""}`}
                  >
                    <div className="inbox-item-head">
                      <strong>{c.contactName ?? `Контакт #${c.contactId}`}</strong>
                      <small>{fmtTime(c.lastMessageAt)}</small>
                    </div>
                    <small className="inbox-item-meta">
                      <span className="badge">{c.source}</span>{" "}
                      <span className="badge">{c.mode}</span>{" "}
                      {c.currentStage && <span className="badge">{c.currentStage}</span>}
                    </small>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <main className="inbox-thread">
          {!selectedId ? (
            <div className="empty-state">
              <p>Выберите диалог слева</p>
            </div>
          ) : detailLoading && !detail ? (
            <p className="muted">Загрузка…</p>
          ) : detail ? (
            <>
              <div className="inbox-thread-header">
                <div className="inbox-thread-title">
                  <h2>
                    {detail.conversation.contactName ??
                      `Контакт #${detail.conversation.contactId}`}
                  </h2>
                  <button
                    type="button"
                    className="link-button"
                    onClick={handleToggleMode}
                    disabled={togglingMode}
                  >
                    {togglingMode
                      ? "…"
                      : detail.conversation.mode === "human"
                        ? "Вернуть AI"
                        : "Перехватить"}
                  </button>
                </div>
                <small>
                  <span className="badge">{detail.conversation.source}</span>{" "}
                  {detail.conversation.mode === "human" ? (
                    <span className="badge badge-warning">оператор</span>
                  ) : (
                    <span className="badge">AI</span>
                  )}{" "}
                  {detail.conversation.currentStage && (
                    <span className="badge">{detail.conversation.currentStage}</span>
                  )}{" "}
                  {detail.conversation.escalatedAt && (
                    <span className="badge badge-warning">эскалация</span>
                  )}
                </small>
              </div>
              <div className="inbox-messages">
                {detail.messages.length === 0 ? (
                  <p className="empty-state">Сообщений нет</p>
                ) : (
                  detail.messages.map((m) => (
                    <div
                      key={m.id}
                      className={`msg msg-${m.role} ${m.deletedAt ? "msg-deleted" : ""}`}
                    >
                      <div className="msg-meta">
                        <span className="msg-role">{m.role}</span>
                        <span className="msg-time">{fmtShortTime(m.createdAt)}</span>
                      </div>
                      <div className="msg-text">{m.text}</div>
                    </div>
                  ))
                )}
              </div>
              <form className="inbox-reply" onSubmit={handleReply}>
                <textarea
                  placeholder={
                    detail.conversation.mode === "human"
                      ? "Ваше сообщение от имени оператора…"
                      : "Перехватить диалог — отправить от оператора. Бот перестанет отвечать (mode → human)."
                  }
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  rows={2}
                  maxLength={4000}
                  disabled={sending}
                />
                <button type="submit" disabled={sending || !replyText.trim()}>
                  {sending ? "Отправляем…" : "Отправить"}
                </button>
              </form>
            </>
          ) : (
            <p className="muted">Диалог не загружен</p>
          )}
        </main>
      </div>
    </div>
  );
}

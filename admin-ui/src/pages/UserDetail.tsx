import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api.ts";

type Detail = Awaited<ReturnType<typeof api.userDetail>>;

function ts(unix: number) {
  return new Date(unix * 1000).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Single-user dossier — collapses everything an operator wants to know about
 * a candidate into one screen: profile, conversation pointer, lead state,
 * cross-session memory facts, and a recent-messages tail. Memory editing
 * stays in the conversation view (Chat.tsx) — this page is read-only so
 * accidental edits during quick triage aren't possible.
 */
export function UserDetail() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setData(null);
    setError(null);
    api
      .userDetail(Number(id))
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [id]);

  if (error) {
    return (
      <div style={{ padding: 24, color: "var(--red, #ef4444)", fontFamily: "var(--mono)" }}>
        {error}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="loading-text" style={{ padding: 24 }}>
        загрузка…
      </div>
    );
  }

  const { user, conversation, lead, memory, recent_messages } = data;
  const factsEntries = Object.entries(memory.facts);

  return (
    <div style={{ padding: "24px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <Link
          to="/admin/users"
          style={{ fontSize: 12, color: "var(--text-3)", fontFamily: "var(--mono)" }}
        >
          ← все пользователи
        </Link>
        <h2 style={{ fontFamily: "var(--display)", color: "var(--text)", margin: "8px 0 0" }}>
          {user.tg_username ? `@${user.tg_username}` : `tg:${user.tg_user_id}`}
        </h2>
        <div
          style={{
            fontSize: 12,
            color: "var(--text-3)",
            marginTop: 4,
            fontFamily: "var(--mono)",
            display: "flex",
            gap: 16,
            flexWrap: "wrap",
          }}
        >
          <span>id={user.id}</span>
          <span>tg_id={user.tg_user_id}</span>
          <span>
            status: <span className={`status-${user.status}`}>{user.status}</span>
          </span>
          <span>зарегистрирован {ts(user.created_at)}</span>
          <span>обновлён {ts(user.updated_at)}</span>
        </div>
      </div>

      <Section title="Переписка">
        {conversation ? (
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 12,
            }}
          >
            <div style={{ fontSize: 13, color: "var(--text-2)", fontFamily: "var(--mono)" }}>
              <div>id: {conversation.id}</div>
              <div>mode: {conversation.mode}</div>
              {conversation.last_message_at && (
                <div>последнее сообщение: {ts(conversation.last_message_at)}</div>
              )}
            </div>
            <Link to={`/admin/chats/${conversation.id}`} className="btn btn-primary btn-sm">
              открыть чат →
            </Link>
          </div>
        ) : (
          <Empty>Нет чата.</Empty>
        )}
      </Section>

      <Section title="Лид">
        {lead ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              fontSize: 13,
              fontFamily: "var(--mono)",
              color: "var(--text-2)",
            }}
          >
            <div>id: {lead.id}</div>
            <div>
              state: <strong>{lead.state}</strong>
            </div>
            {lead.application_id && <div>application_id: {lead.application_id}</div>}
            {lead.rejected_reason && (
              <div style={{ color: "var(--red, #ef4444)" }}>
                причина отказа: {lead.rejected_reason}
              </div>
            )}
            <Link
              to="/admin/leads"
              style={{ marginTop: 6, fontSize: 12 }}
              className="btn btn-ghost btn-sm"
            >
              воронка →
            </Link>
          </div>
        ) : (
          <Empty>Нет лида.</Empty>
        )}
      </Section>

      <Section title={`Память (${factsEntries.length})`}>
        {factsEntries.length === 0 ? (
          <Empty>Фактов нет. Память извлекается автоматически из переписки.</Empty>
        ) : (
          <table className="data-table" style={{ marginTop: 0 }}>
            <thead>
              <tr>
                <th style={{ width: 200 }}>key</th>
                <th>value</th>
              </tr>
            </thead>
            <tbody>
              {factsEntries.map(([k, v]) => (
                <tr key={k}>
                  <td style={{ fontFamily: "var(--mono)", color: "var(--text-3)" }}>{k}</td>
                  <td style={{ color: "var(--text-2)" }}>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {memory.updatedAt && (
          <div
            style={{
              fontSize: 11,
              color: "var(--text-3)",
              fontFamily: "var(--mono)",
              marginTop: 8,
            }}
          >
            updated {ts(memory.updatedAt)}
          </div>
        )}
      </Section>

      <Section title={`Recent messages (${recent_messages.length})`}>
        {recent_messages.length === 0 ? (
          <Empty>No messages.</Empty>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {recent_messages.map((m) => (
              <div
                key={m.id}
                style={{
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderLeft: `3px solid ${roleColor(m.role)}`,
                  borderRadius: "var(--radius)",
                  padding: 8,
                }}
              >
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--text-3)",
                    fontFamily: "var(--mono)",
                    marginBottom: 4,
                    display: "flex",
                    gap: 12,
                  }}
                >
                  <span>{m.role}</span>
                  <span>{ts(m.created_at)}</span>
                </div>
                <div
                  style={{
                    fontSize: 13,
                    color: "var(--text-2)",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    lineHeight: 1.5,
                  }}
                >
                  {m.text}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function roleColor(role: string): string {
  if (role === "user") return "var(--amber, #d97706)";
  if (role === "assistant") return "var(--green, #2ea043)";
  if (role === "human") return "var(--blue, #3b82f6)";
  return "var(--text-3)";
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      style={{
        background: "var(--bg-1)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: 16,
      }}
    >
      <div
        style={{
          fontFamily: "var(--mono)",
          fontSize: 12,
          color: "var(--text-3)",
          textTransform: "uppercase",
          letterSpacing: 1,
          marginBottom: 12,
        }}
      >
        {title}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ color: "var(--text-3)", fontSize: 12, fontStyle: "italic" }}>{children}</div>
  );
}

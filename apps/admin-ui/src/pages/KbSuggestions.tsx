import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ws } from "../App.tsx";
import { api, type KbSuggestion, type SuggestionCounts, type SuggestionStatus } from "../api.ts";

const TABS: { key: SuggestionStatus | "all"; label: string }[] = [
  { key: "pending", label: "Ожидает" },
  { key: "ingested", label: "Добавлено" },
  { key: "rejected", label: "Отклонено" },
];

export function KbSuggestions() {
  const [tab, setTab] = useState<SuggestionStatus>("pending");
  const [suggestions, setSuggestions] = useState<KbSuggestion[] | null>(null);
  const [counts, setCounts] = useState<SuggestionCounts>({ pending: 0, ingested: 0, rejected: 0 });
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const draftRefs = useRef<Record<number, string>>({});

  async function load(status: SuggestionStatus) {
    try {
      setError(null);
      const res = await api.kbSuggestions(status);
      setSuggestions(res.suggestions);
      setCounts(res.counts);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    load(tab);
  }, [tab]);

  useEffect(() => {
    const unsub = ws.on((evt) => {
      if (evt.type === "kb-suggestion:created" && tab === "pending") {
        load("pending");
      }
    });
    return unsub;
  }, [tab]);

  function showFlash(msg: string) {
    setFlash(msg);
    setTimeout(() => setFlash(null), 3000);
  }

  async function handleApprove(s: KbSuggestion) {
    // Use locally typed draft first, fall back to server-side value.
    const localDraft = draftRefs.current[s.id];
    const draft = localDraft !== undefined ? localDraft : (s.answer_draft ?? "");
    if (!draft.trim()) {
      alert("Сначала добавьте ответ в поле ниже.");
      return;
    }
    if (!confirm(`Добавить в KB?\nВопрос: "${s.question_text}"`)) return;
    setBusy(s.id);
    try {
      // Save draft to server first if it differs from what's persisted.
      if (draft !== (s.answer_draft ?? "")) {
        await api.updateKbSuggestionDraft(s.id, draft);
      }
      await api.approveKbSuggestion(s.id);
      showFlash(`✓ Добавлено в KB`);
      await load(tab);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleReject(s: KbSuggestion) {
    const reason = prompt("Причина отклонения (необязательно):") ?? "";
    setBusy(s.id);
    try {
      await api.rejectKbSuggestion(s.id, reason || undefined);
      showFlash("Отклонено");
      await load(tab);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleDraftBlur(s: KbSuggestion) {
    const draft = draftRefs.current[s.id] ?? s.answer_draft ?? "";
    if (draft === (s.answer_draft ?? "")) return;
    try {
      await api.updateKbSuggestionDraft(s.id, draft);
    } catch (err) {
      console.error("draft save failed:", err);
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Вопросы без ответа</h1>
          <p className="page-subtitle">Просмотрите, добавьте ответ и одобрите в базу знаний.</p>
        </div>
      </div>

      {flash && (
        <div
          style={{
            margin: "0 0 16px",
            padding: "10px 14px",
            background: "rgba(34,197,94,0.1)",
            color: "var(--green)",
            borderRadius: "var(--radius)",
            fontSize: "13px",
          }}
        >
          {flash}
        </div>
      )}

      {error && (
        <div className="error-banner" style={{ marginBottom: 16 }}>
          {error}
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        {TABS.map(({ key, label }) => {
          const count = counts[key as SuggestionStatus];
          return (
            <button
              key={key}
              onClick={() => setTab(key as SuggestionStatus)}
              className={`btn btn-sm ${tab === key ? "btn-primary" : "btn-ghost"}`}
              style={{ display: "flex", alignItems: "center", gap: 6 }}
            >
              {label}
              {count > 0 && (
                <span
                  style={{
                    background: tab === key ? "rgba(255,255,255,0.25)" : "var(--bg-3)",
                    borderRadius: 8,
                    padding: "0 5px",
                    fontSize: 11,
                    fontWeight: 700,
                  }}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {suggestions === null ? (
        <div className="loading-text">Loading…</div>
      ) : suggestions.length === 0 ? (
        <div className="empty">{tab === "pending" ? "Нет вопросов без ответа" : "Нет записей"}</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {suggestions.map((s) => (
            <SuggestionCard
              key={s.id}
              suggestion={s}
              isPending={tab === "pending"}
              isBusy={busy === s.id}
              onDraftChange={(val) => {
                draftRefs.current[s.id] = val;
              }}
              onDraftBlur={() => handleDraftBlur(s)}
              onApprove={() => handleApprove(s)}
              onReject={() => handleReject(s)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface CardProps {
  suggestion: KbSuggestion;
  isPending: boolean;
  isBusy: boolean;
  onDraftChange: (val: string) => void;
  onDraftBlur: () => void;
  onApprove: () => void;
  onReject: () => void;
}

function SuggestionCard({
  suggestion: s,
  isPending,
  isBusy,
  onDraftChange,
  onDraftBlur,
  onApprove,
  onReject,
}: CardProps) {
  const [draft, setDraft] = useState(s.answer_draft ?? "");
  const date = new Date(s.created_at * 1000).toLocaleString("ru-RU");

  return (
    <div
      style={{
        background: "var(--bg-2)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: "16px 18px",
      }}
    >
      {/* Question + meta */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 12,
          marginBottom: 12,
        }}
      >
        <div style={{ flex: 1 }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: "var(--text)",
              marginBottom: 4,
              lineHeight: 1.4,
            }}
          >
            {s.question_text}
          </div>
          <div style={{ fontSize: 12, color: "var(--text-3)", fontFamily: "var(--mono)" }}>
            {date}
            {s.source_conversation_id && (
              <>
                {" · "}
                <Link
                  to={`/admin/chats/${s.source_conversation_id}`}
                  style={{ color: "var(--blue)" }}
                >
                  Чат →
                </Link>
              </>
            )}
            {!isPending && s.status === "ingested" && s.kb_document_id && (
              <span style={{ marginLeft: 8, color: "var(--green)" }}>✓ в KB</span>
            )}
            {!isPending && s.status === "rejected" && s.rejected_reason && (
              <span style={{ marginLeft: 8, color: "var(--red, #ef4444)" }}>
                отклонено: {s.rejected_reason}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Answer draft */}
      {isPending ? (
        <>
          <textarea
            defaultValue={draft}
            placeholder="Введите ответ для добавления в базу знаний…"
            rows={3}
            style={{
              width: "100%",
              resize: "vertical",
              fontFamily: "var(--mono)",
              fontSize: 13,
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              padding: "8px 10px",
              color: "var(--text)",
              boxSizing: "border-box",
            }}
            onChange={(e) => {
              setDraft(e.target.value);
              onDraftChange(e.target.value);
            }}
            onBlur={onDraftBlur}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button className="btn btn-sm btn-primary" disabled={isBusy} onClick={onApprove}>
              {isBusy ? "…" : "Добавить в KB"}
            </button>
            <button className="btn btn-sm btn-ghost" disabled={isBusy} onClick={onReject}>
              Отклонить
            </button>
          </div>
        </>
      ) : (
        s.answer_draft && (
          <div
            style={{
              fontSize: 13,
              color: "var(--text-2)",
              fontFamily: "var(--mono)",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              padding: "8px 10px",
              whiteSpace: "pre-wrap",
            }}
          >
            {s.answer_draft}
          </div>
        )
      )}
    </div>
  );
}

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  api,
  type Lead,
  type LeadCounts,
  type LeadState,
} from "../api.ts";

/**
 * Lead pipeline view. Each row is a candidate at some stage of the
 * approval/docs flow. The sort puts intake_complete on top (operator
 * needs to act) and docs_complete next (ready to submit on consulate).
 */
const STATE_LABEL: Record<LeadState, string> = {
  intake_pending: "intake",
  intake_complete: "ready for review",
  approved: "approved",
  rejected: "rejected",
  docs_pending: "docs",
  docs_complete: "ready for visa submit",
  submitted: "submitted",
  closed: "closed",
};

const STATE_ACCENT: Record<LeadState, string> = {
  intake_pending: "var(--text-3)",
  intake_complete: "var(--amber)",
  approved: "var(--green, #2ea043)",
  rejected: "var(--red, #ef4444)",
  docs_pending: "var(--blue)",
  docs_complete: "var(--amber)",
  submitted: "var(--green, #2ea043)",
  closed: "var(--text-3)",
};

export function Leads() {
  const [items, setItems] = useState<Lead[] | null>(null);
  const [counts, setCounts] = useState<LeadCounts | null>(null);
  const [filter, setFilter] = useState<LeadState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const navigate = useNavigate();

  async function refresh() {
    try {
      setError(null);
      const data = await api.leads(filter ?? undefined);
      setItems(data.leads);
      setCounts(data.counts);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    refresh();
  }, [filter]);

  async function withBusy(id: number, fn: () => Promise<unknown>) {
    setBusy(id);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ padding: "24px 32px", display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h2 style={{ fontFamily: "var(--mono)", color: "var(--amber)", margin: 0 }}>
          Leads
        </h2>
        <div style={{ fontSize: 12, color: "var(--text-3)", fontFamily: "var(--mono)" }}>
          {counts ? `${counts.intake_complete} ready · ${counts.docs_complete} for visa submit` : "—"}
        </div>
      </div>

      <p style={{ color: "var(--text-3)", fontSize: 12, margin: 0, lineHeight: 1.6 }}>
        Воронка лидов: бот собирает анкету → ты одобряешь/отклоняешь → бот
        автоматически шлёт девочке шаблоны → собирает визовую анкету → отдаёт
        тебе на подачу. Карточка с inline-кнопками постится в группу{" "}
        <code>LEADS_CHAT_ID</code> (если задана), оттуда можно жать одобрить/отклонить
        прямо из Telegram.
      </p>

      {error && (
        <div
          style={{
            color: "var(--red, #ef4444)",
            fontFamily: "var(--mono)",
            fontSize: 12,
            padding: "8px 12px",
            border: "1px solid var(--red, #ef4444)",
            borderRadius: "var(--radius)",
          }}
        >
          {error}
        </div>
      )}

      {/* Filter pills */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <FilterPill label="all" active={filter === null} onClick={() => setFilter(null)} />
        {(Object.keys(STATE_LABEL) as LeadState[]).map((s) => {
          const count = counts?.[s] ?? 0;
          if (count === 0 && filter !== s) return null;
          return (
            <FilterPill
              key={s}
              label={`${STATE_LABEL[s]} (${count})`}
              active={filter === s}
              accent={STATE_ACCENT[s]}
              onClick={() => setFilter(s)}
            />
          );
        })}
      </div>

      {items === null ? (
        <div className="loading-text">loading…</div>
      ) : items.length === 0 ? (
        <EmptyState filter={filter} />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {items.map((lead) => (
            <LeadCard
              key={lead.id}
              lead={lead}
              busy={busy === lead.id}
              onOpen={() =>
                fetch(`/admin/api/conversations`, { credentials: "include" })
                  .then((r) => r.json())
                  .then((d: { conversations: Array<{ id: number; user: { id: number } }> }) => {
                    const conv = d.conversations.find(
                      (c) => c.user.id === lead.user_id,
                    );
                    if (conv) navigate(`/admin/chats/${conv.id}`);
                  })
              }
              onSendIntake={() => withBusy(lead.id, () => api.sendIntakeTemplate(lead.id))}
              onApprove={() => withBusy(lead.id, () => api.approveLead(lead.id))}
              onReject={() => {
                const reason =
                  prompt("Причина отказа (Enter для шаблонной формулировки):") ?? "";
                return withBusy(lead.id, () => api.rejectLead(lead.id, reason || undefined));
              }}
              onSubmitToVisa={() => {
                if (
                  !confirm(
                    "Передать в подачу на визу? Бот сгенерирует номер заявки, опубликует пакет в VISA_CHAT_ID и отметит лида как готового к консулу.",
                  )
                ) {
                  return Promise.resolve();
                }
                return withBusy(lead.id, () => api.submitLeadToVisa(lead.id));
              }}
              onDelete={() => {
                if (!confirm(`Удалить лид #${lead.id}? Нельзя будет его восстановить.`)) return;
                return withBusy(lead.id, () => api.deleteLead(lead.id));
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface IntakeFields {
  height?: string;
  weight?: string;
  city?: string;
  departure_readiness?: string;
  photos_count?: number;
  videos_count?: number;
  passport_photo_received?: boolean;
  dance_video_received?: boolean;
}

function parseIntake(json: string | null): IntakeFields | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as IntakeFields;
  } catch {
    return null;
  }
}

function LeadCard({
  lead,
  busy,
  onOpen,
  onSendIntake,
  onApprove,
  onReject,
  onSubmitToVisa,
  onDelete,
}: {
  lead: Lead;
  busy: boolean;
  onOpen: () => void;
  onSendIntake: () => void;
  onApprove: () => void;
  onReject: () => void;
  onSubmitToVisa: () => void | Promise<void>;
  onDelete: () => void;
}) {
  const accent = STATE_ACCENT[lead.state];
  const ready = lead.state === "intake_complete";
  const decided = lead.state === "approved" || lead.state === "rejected";
  const inFlight =
    lead.state === "approved" ||
    lead.state === "docs_pending" ||
    lead.state === "docs_complete" ||
    lead.state === "submitted";
  const canSubmitToVisa =
    lead.state === "approved" ||
    lead.state === "docs_pending" ||
    lead.state === "docs_complete";
  const intake = parseIntake(lead.intake_json);
  return (
    <div
      data-testid="lead-card"
      style={{
        background: "var(--bg-1)",
        border: "1px solid var(--border)",
        borderLeft: `3px solid ${accent}`,
        borderRadius: "var(--radius)",
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 12,
        }}
      >
        <div>
          <div
            style={{
              fontFamily: "var(--mono)",
              fontWeight: 600,
              fontSize: 14,
              color: "var(--text)",
            }}
          >
            #{lead.id} ·{" "}
            {lead.tg_username ? `@${lead.tg_username}` : `tg:${lead.tg_user_id}`}
            {lead.application_id && (
              <span style={{ marginLeft: 12, color: "var(--amber)" }}>
                {lead.application_id}
              </span>
            )}
          </div>
          <div
            style={{
              fontSize: 11,
              color: "var(--text-3)",
              fontFamily: "var(--mono)",
              marginTop: 4,
              display: "flex",
              gap: 12,
            }}
          >
            <span style={{ color: accent, fontWeight: 600 }}>
              {STATE_LABEL[lead.state]}
            </span>
            <span>updated {new Date(lead.updated_at * 1000).toLocaleString("ru-RU")}</span>
            {lead.ops_message_id && <span>card in ops chat</span>}
          </div>
          {lead.rejected_reason && (
            <div
              style={{
                fontSize: 11,
                color: "var(--text-3)",
                fontStyle: "italic",
                marginTop: 4,
              }}
            >
              reason: {lead.rejected_reason}
            </div>
          )}
        </div>

        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          <button onClick={onOpen} className="btn btn-ghost btn-sm" disabled={busy}>
            open chat
          </button>
          {!decided && !inFlight && (
            <button
              onClick={onSendIntake}
              className="btn btn-ghost btn-sm"
              disabled={busy}
              title="Отправить девочке шаблон с 7 пунктами анкеты"
            >
              send intake
            </button>
          )}
          {ready && (
            <>
              <button
                onClick={onApprove}
                className="btn btn-primary btn-sm"
                disabled={busy}
                data-testid="lead-approve"
              >
                ✅ approve
              </button>
              <button
                onClick={onReject}
                className="btn btn-warn btn-sm"
                disabled={busy}
                data-testid="lead-reject"
              >
                ❌ reject
              </button>
            </>
          )}
          {canSubmitToVisa && (
            <button
              onClick={() => void onSubmitToVisa()}
              className="btn btn-primary btn-sm"
              disabled={busy}
              data-testid="lead-submit-visa"
              title={
                lead.application_id
                  ? "Перепостить пакет в VISA_CHAT_ID (id уже выдан)"
                  : "Сгенерировать номер заявки и опубликовать в VISA_CHAT_ID"
              }
            >
              {lead.application_id ? "↻ resend visa" : "→ visa submit"}
            </button>
          )}
          <button
            onClick={onDelete}
            className="btn btn-danger btn-sm"
            disabled={busy}
            title="Удалить запись лида"
          >
            ×
          </button>
        </div>
      </div>

      {intake && (lead.state === "intake_pending" || lead.state === "intake_complete") && (
        <IntakeProgress intake={intake} />
      )}
    </div>
  );
}

function IntakeProgress({ intake }: { intake: IntakeFields }) {
  const items: Array<[string, string | undefined, boolean]> = [
    ["рост", intake.height, !!intake.height],
    ["вес", intake.weight, !!intake.weight],
    ["город", intake.city, !!intake.city],
    ["выезд", intake.departure_readiness, !!intake.departure_readiness],
    [
      "фото 6+",
      intake.photos_count !== undefined ? String(intake.photos_count) : "0",
      (intake.photos_count ?? 0) >= 6,
    ],
    [
      "видео 2+",
      intake.videos_count !== undefined ? String(intake.videos_count) : "0",
      (intake.videos_count ?? 0) >= 2,
    ],
    [
      "загранпаспорт",
      intake.passport_photo_received ? "получено" : undefined,
      intake.passport_photo_received === true,
    ],
    [
      "видео танца",
      intake.dance_video_received ? "получено" : undefined,
      intake.dance_video_received === true,
    ],
  ];
  return (
    <div
      style={{
        display: "flex",
        gap: 6,
        flexWrap: "wrap",
        fontFamily: "var(--mono)",
        fontSize: 10,
        marginTop: 4,
      }}
    >
      {items.map(([label, value, ok]) => (
        <span
          key={label}
          style={{
            padding: "2px 8px",
            borderRadius: "var(--radius)",
            background: ok ? "rgba(46,160,67,0.15)" : "var(--bg-3)",
            color: ok ? "var(--green, #2ea043)" : "var(--text-3)",
            border: `1px solid ${ok ? "rgba(46,160,67,0.3)" : "var(--border)"}`,
          }}
        >
          {ok ? "✓" : "·"} {label}
          {value && ok ? `: ${value}` : ""}
        </span>
      ))}
    </div>
  );
}

function FilterPill({
  label,
  active,
  accent,
  onClick,
}: {
  label: string;
  active: boolean;
  accent?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "4px 10px",
        background: active ? "var(--bg-3)" : "transparent",
        border: `1px solid ${active && accent ? accent : "var(--border)"}`,
        borderRadius: "var(--radius)",
        color: active && accent ? accent : "var(--text-2)",
        fontFamily: "var(--mono)",
        fontSize: 11,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

function EmptyState({ filter }: { filter: LeadState | null }) {
  return (
    <div
      style={{
        border: "1px dashed var(--border)",
        borderRadius: "var(--radius)",
        padding: 24,
        background: "var(--bg-1)",
        color: "var(--text-2)",
        fontSize: 13,
        lineHeight: 1.6,
      }}
    >
      <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-3)", marginBottom: 8 }}>
        no leads {filter ? `in state "${filter}"` : "yet"}
      </div>
      <div>
        Лиды появляются здесь когда оператор нажимает <strong>Promote to lead</strong>
        {" "}на странице чата (TODO в этой фазе) или когда бот автоматически детектит, что
        анкета заполнена (Phase 2).
      </div>
      <div style={{ marginTop: 8, color: "var(--text-3)" }}>
        Для теста: создай лид через <code>POST /admin/api/leads/from-conversation/:convId</code> —
        бот запостит карточку в LEADS_CHAT_ID (если настроен) с inline-кнопками одобрить/отклонить.
      </div>
    </div>
  );
}

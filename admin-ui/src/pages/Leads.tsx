import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  api,
  type Lead,
  type LeadCounts,
  type LeadEvent,
  type LeadNote,
  type LeadState,
  type VisaDocs,
} from "../api.ts";

/**
 * Subset of visa fields the admin shows as "required" — mirrors
 * VISA_REQUIRED_FIELDS in src/leads/visa-docs.ts. New required fields
 * MUST be kept in sync between backend and frontend.
 */
const VISA_REQUIRED: Array<keyof VisaDocs> = [
  "family_name",
  "given_name",
  "date_of_birth",
  "country_of_birth",
  "city_of_birth",
  "marital_status",
  "current_nationality",
  "national_id_number",
  "passport_number",
  "passport_issuing_country",
  "passport_expiration_date",
  "current_address",
  "phone",
  "email",
  "father_name",
  "mother_name",
  "been_to_china",
];

/** All visa fields in display order. Keep in sync with VISA_FIELD_LABELS
 *  in src/leads/visa-docs.ts. */
const VISA_FIELD_ORDER: Array<keyof VisaDocs> = [
  "family_name",
  "given_name",
  "date_of_birth",
  "country_of_birth",
  "city_of_birth",
  "marital_status",
  "current_nationality",
  "national_id_number",
  "passport_number",
  "passport_issuing_country",
  "passport_issuing_place",
  "passport_expiration_date",
  "current_address",
  "phone",
  "email",
  "father_name",
  "father_nationality",
  "father_dob",
  "mother_name",
  "mother_nationality",
  "mother_dob",
  "been_to_china",
  "previous_chinese_visa",
  "work_experience",
  "education",
  "travel_history_12mo",
  "family_other",
];

const VISA_FIELD_LABELS: Record<keyof VisaDocs, string> = {
  family_name: "Family name",
  given_name: "Given name",
  date_of_birth: "Date of birth",
  country_of_birth: "Country of birth",
  city_of_birth: "City of birth",
  marital_status: "Marital status",
  current_nationality: "Current nationality",
  national_id_number: "National ID number",
  passport_number: "Passport number",
  passport_issuing_country: "Passport issuing country",
  passport_issuing_place: "Passport issuing place",
  passport_expiration_date: "Passport expiration",
  current_address: "Current address",
  phone: "Phone",
  email: "Email",
  father_name: "Father name",
  father_nationality: "Father nationality",
  father_dob: "Father DOB",
  mother_name: "Mother name",
  mother_nationality: "Mother nationality",
  mother_dob: "Mother DOB",
  been_to_china: "Been to China?",
  previous_chinese_visa: "Previous Chinese visa",
  work_experience: "Work experience",
  education: "Education",
  travel_history_12mo: "Travel last 12mo",
  family_other: "Spouse / children",
};

const VISA_LONG_FIELDS: ReadonlySet<keyof VisaDocs> = new Set([
  "current_address",
  "work_experience",
  "education",
  "travel_history_12mo",
  "family_other",
  "previous_chinese_visa",
]);

/**
 * Lead pipeline view. Each row is a candidate at some stage of the
 * approval/docs flow. The sort puts intake_complete on top (operator
 * needs to act) and docs_complete next (ready to submit on consulate).
 */
const STATE_LABEL: Record<LeadState, string> = {
  intake_pending: "анкета",
  intake_complete: "ожидает решения",
  approved: "одобрен",
  rejected: "отклонён",
  docs_pending: "документы",
  docs_complete: "готов к подаче",
  submitted: "подан",
  closed: "закрыт",
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
        <h2 style={{ fontFamily: "var(--mono)", color: "var(--amber)", margin: 0 }}>Лиды</h2>
        <div style={{ fontSize: 12, color: "var(--text-3)", fontFamily: "var(--mono)" }}>
          {counts
            ? `${counts.intake_complete} ожидают решения · ${counts.docs_complete} готовы к подаче`
            : "—"}
        </div>
      </div>

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
        <FilterPill label="все" active={filter === null} onClick={() => setFilter(null)} />
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
                    const conv = d.conversations.find((c) => c.user.id === lead.user_id);
                    if (conv) navigate(`/admin/chats/${conv.id}`);
                  })
              }
              onSendIntake={() => withBusy(lead.id, () => api.sendIntakeTemplate(lead.id))}
              onApprove={() => withBusy(lead.id, () => api.approveLead(lead.id))}
              onReject={() => {
                const reason = prompt("Причина отказа (Enter для шаблонной формулировки):") ?? "";
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
  age?: string;
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
    lead.state === "approved" || lead.state === "docs_pending" || lead.state === "docs_complete";
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
            #{lead.id} · {lead.tg_username ? `@${lead.tg_username}` : `tg:${lead.tg_user_id}`}
            {lead.application_id && (
              <span style={{ marginLeft: 12, color: "var(--amber)" }}>{lead.application_id}</span>
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
            <span style={{ color: accent, fontWeight: 600 }}>{STATE_LABEL[lead.state]}</span>
            <span>обновлён {new Date(lead.updated_at * 1000).toLocaleString("ru-RU")}</span>
            {lead.ops_message_id && <span>карточка в чате</span>}
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
              причина: {lead.rejected_reason}
            </div>
          )}
        </div>

        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          <button onClick={onOpen} className="btn btn-ghost btn-sm" disabled={busy}>
            чат
          </button>
          {!decided && !inFlight && (
            <button
              onClick={onSendIntake}
              className="btn btn-ghost btn-sm"
              disabled={busy}
              title="Отправить девочке шаблон с 7 пунктами анкеты"
            >
              анкета
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
                ✅ одобрить
              </button>
              <button
                onClick={onReject}
                className="btn btn-warn btn-sm"
                disabled={busy}
                data-testid="lead-reject"
              >
                ❌ отклонить
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
              {lead.application_id ? "↻ на визу" : "→ на визу"}
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

      {(lead.state === "docs_pending" ||
        lead.state === "docs_complete" ||
        lead.state === "submitted") && <VisaDocsPane leadId={lead.id} />}

      <NotesPane leadId={lead.id} />
      <TimelinePane leadId={lead.id} />
    </div>
  );
}

/**
 * Operator-facing note panel: free-form commentary on a lead, distinct
 * from the bot-driven message log and the auto-tracked timeline.
 * Add via inline form, delete with × per note. Lazy-loaded on first
 * expand (same pattern as TimelinePane / VisaDocsPane).
 */
function NotesPane({ leadId }: { leadId: number }) {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState<LeadNote[] | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  async function ensureLoaded() {
    if (notes !== null) return;
    try {
      const detail = await api.leadDetail(leadId);
      setNotes(detail.notes);
    } catch (err) {
      console.error("[notes] load failed", err);
    }
  }

  async function handleAdd() {
    const body = draft.trim();
    if (!body) return;
    setSaving(true);
    try {
      const { note } = await api.addLeadNote(leadId, body);
      setNotes((prev) => (prev ? [note, ...prev] : [note]));
      setDraft("");
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(noteId: number) {
    if (!confirm("Удалить заметку?")) return;
    try {
      await api.deleteLeadNote(leadId, noteId);
      setNotes((prev) => prev?.filter((n) => n.id !== noteId) ?? null);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div
      style={{
        marginTop: 8,
        borderTop: "1px solid var(--border)",
        paddingTop: 8,
      }}
    >
      <button
        type="button"
        onClick={() => {
          setOpen((o) => !o);
          if (!open) void ensureLoaded();
        }}
        style={{
          background: "transparent",
          border: "none",
          color: "var(--text-3)",
          fontFamily: "var(--mono)",
          fontSize: 11,
          cursor: "pointer",
          padding: 0,
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
        }}
        data-testid="notes-toggle"
      >
        <span style={{ width: 10, display: "inline-block" }}>{open ? "▾" : "▸"}</span>
        <span>ЗАМЕТКИ</span>
        {notes !== null && <span style={{ color: "var(--text-2)" }}>{notes.length}</span>}
      </button>

      {open && (
        <div
          style={{
            marginTop: 8,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div style={{ display: "flex", gap: 6 }}>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Внутренняя заметка для оператора (не отправляется девушке)..."
              rows={2}
              className="input"
              style={{
                flex: 1,
                fontSize: 12,
                fontFamily: "var(--sans)",
                resize: "vertical",
              }}
              data-testid="notes-input"
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  void handleAdd();
                }
              }}
            />
            <button
              onClick={handleAdd}
              disabled={saving || !draft.trim()}
              className="btn btn-primary btn-sm"
              data-testid="notes-add"
              style={{ alignSelf: "flex-start", fontSize: 11 }}
            >
              {saving ? "сохранение…" : "добавить"}
            </button>
          </div>

          {notes === null ? (
            <div
              style={{
                fontFamily: "var(--mono)",
                fontSize: 11,
                color: "var(--text-3)",
              }}
            >
              loading…
            </div>
          ) : notes.length === 0 ? (
            <div
              style={{
                fontFamily: "var(--mono)",
                fontSize: 11,
                color: "var(--text-3)",
                padding: "4px 0",
              }}
            >
              нет заметок
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {notes.map((n) => (
                <div
                  key={n.id}
                  data-testid="notes-row"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr auto",
                    gap: 8,
                    alignItems: "start",
                    padding: "6px 8px",
                    borderRadius: "var(--radius)",
                    background: "var(--bg-2)",
                    border: "1px solid var(--border)",
                  }}
                >
                  <div>
                    <div
                      style={{
                        fontSize: 13,
                        color: "var(--text)",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        lineHeight: 1.4,
                      }}
                    >
                      {n.body}
                    </div>
                    <div
                      style={{
                        marginTop: 4,
                        fontFamily: "var(--mono)",
                        fontSize: 10,
                        color: "var(--text-3)",
                        display: "flex",
                        gap: 8,
                      }}
                    >
                      <span>{new Date(n.created_at * 1000).toLocaleString("ru-RU")}</span>
                      {n.by_admin_id !== null && <span>admin#{n.by_admin_id}</span>}
                    </div>
                  </div>
                  <button
                    onClick={() => handleDelete(n.id)}
                    className="btn btn-ghost btn-sm"
                    style={{ fontSize: 11, padding: "2px 8px" }}
                    title="Удалить заметку"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Collapsible audit-trail of every state transition on the lead, plus
 * application-id allocation. Lazy-loaded on first expand to avoid a
 * fetch storm on the list view. Detail endpoint is the same one
 * VisaDocsPane already uses, so two opens hit the cache once.
 */
function TimelinePane({ leadId }: { leadId: number }) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<LeadEvent[] | null>(null);

  async function ensureLoaded() {
    if (events !== null) return;
    try {
      const detail = await api.leadDetail(leadId);
      setEvents(detail.events);
    } catch (err) {
      console.error("[timeline] load failed", err);
    }
  }

  return (
    <div
      style={{
        marginTop: 8,
        borderTop: "1px solid var(--border)",
        paddingTop: 8,
      }}
    >
      <button
        type="button"
        onClick={() => {
          setOpen((o) => !o);
          if (!open) void ensureLoaded();
        }}
        style={{
          background: "transparent",
          border: "none",
          color: "var(--text-3)",
          fontFamily: "var(--mono)",
          fontSize: 11,
          cursor: "pointer",
          padding: 0,
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
        }}
        data-testid="timeline-toggle"
      >
        <span style={{ width: 10, display: "inline-block" }}>{open ? "▾" : "▸"}</span>
        <span>ИСТОРИЯ</span>
        {events !== null && <span style={{ color: "var(--text-2)" }}>{events.length} событий</span>}
      </button>

      {open && (
        <div
          style={{
            marginTop: 8,
            display: "flex",
            flexDirection: "column",
            gap: 4,
            fontFamily: "var(--mono)",
            fontSize: 11,
          }}
        >
          {events === null ? (
            <div style={{ color: "var(--text-3)" }}>загрузка…</div>
          ) : events.length === 0 ? (
            <div style={{ color: "var(--text-3)" }}>нет событий</div>
          ) : (
            events.map((ev) => <TimelineRow key={ev.id} event={ev} />)
          )}
        </div>
      )}
    </div>
  );
}

function TimelineRow({ event: ev }: { event: LeadEvent }) {
  const ts = new Date(ev.created_at * 1000).toLocaleString("ru-RU");
  const isCreate = ev.from_state === null;
  const isApplicationId = ev.from_state === ev.to_state && ev.notes?.startsWith("application_id=");
  const arrow = isCreate
    ? "✨ created"
    : isApplicationId
      ? "🪪 id allocated"
      : `${ev.from_state} → ${ev.to_state}`;
  const accent =
    ev.to_state === "approved" || ev.to_state === "docs_complete"
      ? "var(--green, #2ea043)"
      : ev.to_state === "rejected"
        ? "var(--red, #ef4444)"
        : ev.to_state === "intake_complete" || isApplicationId
          ? "var(--amber)"
          : "var(--text-3)";
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "150px 1fr",
        gap: 8,
        alignItems: "baseline",
      }}
      data-testid="timeline-row"
    >
      <span style={{ color: "var(--text-3)" }}>{ts}</span>
      <span>
        <span style={{ color: accent, fontWeight: 600 }}>{arrow}</span>
        {ev.by_admin_id !== null && (
          <span style={{ color: "var(--text-3)" }}> · admin#{ev.by_admin_id}</span>
        )}
        {ev.notes && !isApplicationId && (
          <span style={{ color: "var(--text-3)" }}> · {ev.notes}</span>
        )}
        {isApplicationId && (
          <span style={{ color: "var(--amber)" }}>
            {" "}
            · {ev.notes!.replace(/^application_id=/, "")}
          </span>
        )}
      </span>
    </div>
  );
}

function VisaDocsPane({ leadId }: { leadId: number }) {
  const [open, setOpen] = useState(false);
  const [docs, setDocs] = useState<VisaDocs | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [editingKey, setEditingKey] = useState<keyof VisaDocs | null>(null);
  const [editValue, setEditValue] = useState("");
  const [saving, setSaving] = useState(false);

  // Lazy-load on first expand so the list view doesn't trigger a fetch
  // per card on mount. After load, the operator can re-collapse and
  // we keep the state.
  async function ensureLoaded() {
    if (loaded) return;
    try {
      const detail = await api.leadDetail(leadId);
      setDocs(detail.visa_docs ?? {});
      setLoaded(true);
    } catch (err) {
      console.error("[visa-docs] load failed", err);
    }
  }

  function startEdit(key: keyof VisaDocs) {
    setEditingKey(key);
    setEditValue(docs?.[key] ?? "");
  }

  async function commitEdit() {
    if (!editingKey) return;
    setSaving(true);
    try {
      const patch: Partial<VisaDocs> = { [editingKey]: editValue.trim() } as Partial<VisaDocs>;
      const { visa_docs } = await api.updateVisaDocs(leadId, patch);
      setDocs(visa_docs);
      setEditingKey(null);
      setEditValue("");
    } finally {
      setSaving(false);
    }
  }

  const filled = docs
    ? VISA_REQUIRED.filter((k) => {
        const v = docs[k];
        return typeof v === "string" && v.trim();
      }).length
    : 0;
  const totalRequired = VISA_REQUIRED.length;
  const pct = totalRequired > 0 ? Math.round((filled / totalRequired) * 100) : 0;

  return (
    <div
      style={{
        marginTop: 8,
        borderTop: "1px solid var(--border)",
        paddingTop: 8,
      }}
    >
      <button
        type="button"
        onClick={() => {
          setOpen((o) => !o);
          if (!open) void ensureLoaded();
        }}
        style={{
          background: "transparent",
          border: "none",
          color: "var(--text-3)",
          fontFamily: "var(--mono)",
          fontSize: 11,
          cursor: "pointer",
          padding: 0,
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
        }}
        data-testid="visa-docs-toggle"
      >
        <span style={{ width: 10, display: "inline-block" }}>{open ? "▾" : "▸"}</span>
        <span>ВИЗОВАЯ АНКЕТА</span>
        <span
          style={{
            color: pct >= 100 ? "var(--green, #2ea043)" : "var(--amber)",
            fontWeight: 600,
          }}
        >
          {filled}/{totalRequired} required ({pct}%)
        </span>
      </button>

      {open && (
        <div
          style={{
            marginTop: 8,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          {!loaded ? (
            <div
              style={{
                fontFamily: "var(--mono)",
                fontSize: 11,
                color: "var(--text-3)",
              }}
            >
              loading…
            </div>
          ) : (
            VISA_FIELD_ORDER.map((key) => {
              const value = docs?.[key] ?? "";
              const required = (VISA_REQUIRED as ReadonlyArray<keyof VisaDocs>).includes(key);
              const isLong = VISA_LONG_FIELDS.has(key);
              const editing = editingKey === key;
              return (
                <div
                  key={key}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "180px 1fr auto",
                    gap: 8,
                    alignItems: "start",
                    fontSize: 12,
                  }}
                >
                  <div
                    style={{
                      fontFamily: "var(--mono)",
                      color: "var(--text-3)",
                      paddingTop: 4,
                    }}
                  >
                    {VISA_FIELD_LABELS[key]}
                    {required && (
                      <span style={{ color: "var(--red, #ef4444)", marginLeft: 4 }}>*</span>
                    )}
                  </div>
                  {editing ? (
                    isLong ? (
                      <textarea
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        rows={4}
                        className="input"
                        style={{ fontSize: 12, fontFamily: "var(--sans)" }}
                        data-testid={`visa-docs-textarea-${key}`}
                      />
                    ) : (
                      <input
                        type="text"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        className="input"
                        style={{ fontSize: 12 }}
                        data-testid={`visa-docs-input-${key}`}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void commitEdit();
                          else if (e.key === "Escape") {
                            setEditingKey(null);
                            setEditValue("");
                          }
                        }}
                      />
                    )
                  ) : (
                    <div
                      style={{
                        color: value ? "var(--text)" : "var(--text-3)",
                        fontStyle: value ? "normal" : "italic",
                        wordBreak: "break-word",
                        whiteSpace: "pre-wrap",
                        paddingTop: 4,
                      }}
                    >
                      {value || "—"}
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 4 }}>
                    {editing ? (
                      <>
                        <button
                          onClick={commitEdit}
                          disabled={saving}
                          className="btn btn-primary btn-sm"
                          style={{ fontSize: 11, padding: "4px 8px" }}
                        >
                          сохранить
                        </button>
                        <button
                          onClick={() => {
                            setEditingKey(null);
                            setEditValue("");
                          }}
                          disabled={saving}
                          className="btn btn-ghost btn-sm"
                          style={{ fontSize: 11, padding: "4px 8px" }}
                        >
                          ✕
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => startEdit(key)}
                        className="btn btn-ghost btn-sm"
                        style={{ fontSize: 11, padding: "4px 8px" }}
                        data-testid={`visa-docs-edit-${key}`}
                      >
                        изменить
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

function IntakeProgress({ intake }: { intake: IntakeFields }) {
  const items: Array<[string, string | undefined, boolean]> = [
    ["возраст", intake.age, !!intake.age],
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
        color: "var(--text-3)",
        fontSize: 13,
        fontFamily: "var(--mono)",
      }}
    >
      {filter ? `нет лидов в статусе «${STATE_LABEL[filter]}»` : "нет лидов"}
    </div>
  );
}

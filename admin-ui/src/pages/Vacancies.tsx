import { useEffect, useState } from "react";
import { api, type Vacancy } from "../api.ts";

/**
 * CRUD over admin-managed vacancies. These rows are NOT in the embedded KB —
 * they're prepended to the RAG context as "АКТУАЛЬНЫЕ ВАКАНСИИ" on every
 * turn, so an operator's edit shows up in the bot's next reply without any
 * re-embedding pipeline. KB stays for slowly-changing background info
 * (visa rules, payment models, etc.); vacancies are the fast-changing
 * "what's open right now" layer.
 *
 * UX choices:
 * - Single page, no detail route — operators add 5-15 vacancies, not
 *   hundreds. Inline editing keeps the workflow tight.
 * - Closed (is_active=0) entries stay visible (greyed out) so operators
 *   can re-enable them next month without re-typing.
 * - "+ ADD" form is collapsible to keep the list clean.
 */
export function Vacancies() {
  const [list, setList] = useState<Vacancy[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);

  async function refresh() {
    try {
      setError(null);
      const { vacancies } = await api.vacancies();
      setList(vacancies);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleCreate(input: { title: string; body: string }) {
    setError(null);
    try {
      await api.createVacancy(input);
      setShowAdd(false);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleUpdate(
    id: number,
    patch: { title?: string; body?: string; is_active?: boolean },
  ) {
    setError(null);
    try {
      await api.updateVacancy(id, patch);
      setEditing(null);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleToggleActive(v: Vacancy) {
    await handleUpdate(v.id, { is_active: v.is_active === 1 ? false : true });
  }

  async function handleDelete(v: Vacancy) {
    if (!confirm(`Удалить вакансию "${v.title}"? Это необратимо.`)) return;
    setError(null);
    try {
      await api.deleteVacancy(v.id);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const activeCount = list?.filter((v) => v.is_active === 1).length ?? 0;

  return (
    <div style={{ padding: "24px 32px", display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div>
          <h2 style={{ fontFamily: "var(--mono)", color: "var(--amber)", margin: 0 }}>
            Vacancies
          </h2>
          <div
            style={{
              fontSize: 12,
              color: "var(--text-3)",
              marginTop: 4,
              fontFamily: "var(--mono)",
            }}
          >
            {activeCount} active · prepended to RAG context as АКТУАЛЬНЫЕ ВАКАНСИИ
          </div>
        </div>
        <button onClick={() => setShowAdd((s) => !s)} className="btn btn-primary btn-sm">
          {showAdd ? "cancel" : "+ ADD"}
        </button>
      </div>

      <p style={{ color: "var(--text-3)", fontSize: 12, margin: 0, lineHeight: 1.6 }}>
        Свежие вакансии. Бот использует ИХ в первую очередь, KB остаётся
        для общих фактов про визу, проживание, страны. Изменения видны на
        следующем сообщении кандидата — без переиндексации.
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

      {showAdd && <AddForm onSubmit={handleCreate} />}

      {list === null ? (
        <div className="loading-text">loading…</div>
      ) : list.length === 0 ? (
        <EmptyState onAdd={() => setShowAdd(true)} />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {list.map((v) =>
            editing === v.id ? (
              <EditForm
                key={v.id}
                vacancy={v}
                onSubmit={(patch) => handleUpdate(v.id, patch)}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <VacancyCard
                key={v.id}
                vacancy={v}
                onEdit={() => setEditing(v.id)}
                onToggleActive={() => handleToggleActive(v)}
                onDelete={() => handleDelete(v)}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

function VacancyCard({
  vacancy: v,
  onEdit,
  onToggleActive,
  onDelete,
}: {
  vacancy: Vacancy;
  onEdit: () => void;
  onToggleActive: () => void;
  onDelete: () => void;
}) {
  const isActive = v.is_active === 1;
  return (
    <div
      data-testid="vacancy-card"
      style={{
        background: "var(--bg-1)",
        border: "1px solid var(--border)",
        borderLeft: `3px solid ${isActive ? "var(--green, #2ea043)" : "var(--text-3)"}`,
        borderRadius: "var(--radius)",
        padding: 16,
        opacity: isActive ? 1 : 0.6,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 12,
          marginBottom: 8,
        }}
      >
        <div style={{ flex: 1 }}>
          <div
            style={{
              fontFamily: "var(--mono)",
              fontWeight: 600,
              fontSize: 14,
              color: "var(--text)",
            }}
          >
            {v.title}
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
            <span>id={v.id}</span>
            <span>{isActive ? "active" : "closed"}</span>
            <span>updated {new Date(v.updated_at * 1000).toLocaleString("ru-RU")}</span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          <button
            onClick={onToggleActive}
            className={`btn btn-sm ${isActive ? "btn-ghost" : "btn-warn"}`}
            data-testid="vacancy-toggle"
          >
            {isActive ? "close" : "reopen"}
          </button>
          <button onClick={onEdit} className="btn btn-ghost btn-sm" data-testid="vacancy-edit">
            edit
          </button>
          <button
            onClick={onDelete}
            className="btn btn-danger btn-sm"
            data-testid="vacancy-delete"
          >
            delete
          </button>
        </div>
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
        {v.body}
      </div>
    </div>
  );
}

function AddForm({ onSubmit }: { onSubmit: (input: { title: string; body: string }) => void }) {
  return (
    <FormShell
      submitLabel="create"
      initial={{ title: "", body: "" }}
      onSubmit={(values) => onSubmit({ title: values.title, body: values.body })}
    />
  );
}

function EditForm({
  vacancy,
  onSubmit,
  onCancel,
}: {
  vacancy: Vacancy;
  onSubmit: (patch: { title: string; body: string }) => void;
  onCancel: () => void;
}) {
  return (
    <FormShell
      submitLabel="save"
      initial={{ title: vacancy.title, body: vacancy.body }}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />
  );
}

function FormShell({
  submitLabel,
  initial,
  onSubmit,
  onCancel,
}: {
  submitLabel: string;
  initial: { title: string; body: string };
  onSubmit: (values: { title: string; body: string }) => void;
  onCancel?: () => void;
}) {
  const [title, setTitle] = useState(initial.title);
  const [body, setBody] = useState(initial.body);
  const canSubmit = title.trim().length > 0 && body.trim().length > 0;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit) return;
        onSubmit({ title: title.trim(), body: body.trim() });
      }}
      style={{
        background: "var(--bg-1)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
      data-testid="vacancy-form"
    >
      <input
        type="text"
        placeholder="title (e.g. Шаохинг Premium — 3000 юаней/смена)"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="input"
        data-testid="vacancy-title-input"
        style={{ width: "100%" }}
      />
      <textarea
        placeholder="body — условия, требования, что входит в оплату..."
        value={body}
        onChange={(e) => setBody(e.target.value)}
        className="input"
        rows={8}
        data-testid="vacancy-body-input"
        style={{ width: "100%", resize: "vertical", fontFamily: "var(--sans)" }}
      />
      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="submit"
          disabled={!canSubmit}
          className="btn btn-primary btn-sm"
          data-testid="vacancy-submit"
        >
          {submitLabel}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="btn btn-ghost btn-sm"
            data-testid="vacancy-cancel"
          >
            cancel
          </button>
        )}
      </div>
    </form>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
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
        display: "flex",
        flexDirection: "column",
        gap: 10,
        alignItems: "flex-start",
      }}
    >
      <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-3)" }}>
        no vacancies yet
      </div>
      <div>
        Добавь актуальные вакансии — заголовок (страна / город / ставка) +
        тело (условия, требования, что входит). Бот будет ссылаться на них
        в ответах вместо устаревших постов из чатов.
      </div>
      <button onClick={onAdd} className="btn btn-primary btn-sm">
        + add the first vacancy
      </button>
    </div>
  );
}

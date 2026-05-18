import { type FormEvent, useEffect, useState } from "react";
import { useAdmin } from "../App.tsx";
import { type AdminRole, type AdminSummary, api } from "../api.ts";
import { confirmDialog } from "../components/Dialogs.tsx";

const sectionLabelStyle: React.CSSProperties = {
  fontFamily: "var(--mono)",
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "var(--text-3)",
  marginBottom: 10,
};

const cardStyle: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  overflow: "hidden",
};

const inputStyle: React.CSSProperties = {
  fontFamily: "var(--mono)",
  fontSize: 12,
  padding: "6px 8px",
};

function roleLabel(role: AdminRole): string {
  return role === "superadmin" ? "суперадминистратор" : "менеджер";
}

export function Operators() {
  const me = useAdmin();
  const [admins, setAdmins] = useState<AdminSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // New-operator form.
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<AdminRole>("manager");
  const [creating, setCreating] = useState(false);

  // Inline reset-password state: which admin id is being reset + its draft.
  const [resetId, setResetId] = useState<number | null>(null);
  const [resetValue, setResetValue] = useState("");
  const [busy, setBusy] = useState(false);

  function load() {
    api
      .admins()
      .then((r) => setAdmins(r.admins))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }

  useEffect(() => {
    if (me.role === "superadmin") load();
  }, [me.role]);

  if (me.role !== "superadmin") {
    return (
      <div className="page">
        <div className="page-header">
          <div className="page-title">Операторы</div>
        </div>
        <div style={{ color: "var(--text-3)", fontSize: 13 }}>
          Раздел доступен только суперадминистратору.
        </div>
      </div>
    );
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!email.includes("@")) {
      setError("Введите корректный email.");
      return;
    }
    if (password.length < 8) {
      setError("Пароль — минимум 8 символов.");
      return;
    }
    setCreating(true);
    try {
      await api.createAdmin(email.trim(), password, role);
      setEmail("");
      setPassword("");
      setRole("manager");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  async function remove(a: AdminSummary) {
    if (
      !(await confirmDialog(`Оператор ${a.email} будет удалён. Это действие необратимо.`, {
        title: "Удалить оператора?",
        confirmLabel: "Удалить",
        danger: true,
      }))
    ) {
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await api.deleteAdmin(a.id);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function applyReset(id: number) {
    setError(null);
    if (resetValue.length < 8) {
      setError("Новый пароль — минимум 8 символов.");
      return;
    }
    setBusy(true);
    try {
      await api.resetAdminPassword(id, resetValue);
      setResetId(null);
      setResetValue("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-title">Операторы</div>
      </div>

      {error && (
        <div style={{ fontSize: 12, color: "var(--red, #ef4444)", marginBottom: 16 }}>{error}</div>
      )}

      <div style={{ maxWidth: 640, marginBottom: 32 }}>
        <div style={sectionLabelStyle}>Учётные записи</div>
        <div style={cardStyle}>
          {admins === null ? (
            <div style={{ padding: 16, color: "var(--text-3)", fontSize: 13 }}>загрузка…</div>
          ) : (
            admins.map((a, i) => (
              <div
                key={a.id}
                style={{
                  padding: "12px 16px",
                  borderTop: i === 0 ? undefined : "1px solid var(--border)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, color: "var(--text)" }}>
                      {a.email}
                      {a.id === me.id && (
                        <span style={{ color: "var(--text-3)", fontSize: 11 }}> · вы</span>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-3)" }}>{roleLabel(a.role)}</div>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={busy}
                      onClick={() => {
                        setResetId(resetId === a.id ? null : a.id);
                        setResetValue("");
                      }}
                    >
                      Сбросить пароль
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={busy || a.id === me.id}
                      title={a.id === me.id ? "Нельзя удалить свой аккаунт" : undefined}
                      onClick={() => remove(a)}
                    >
                      Удалить
                    </button>
                  </div>
                </div>
                {resetId === a.id && (
                  <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                    <input
                      type="password"
                      value={resetValue}
                      placeholder="Новый пароль (минимум 8 символов)"
                      autoComplete="new-password"
                      onChange={(e) => setResetValue(e.target.value)}
                      style={{ ...inputStyle, flex: 1 }}
                    />
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={busy}
                      onClick={() => applyReset(a.id)}
                    >
                      Сохранить
                    </button>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      <div style={{ maxWidth: 640 }}>
        <div style={sectionLabelStyle}>Добавить оператора</div>
        <div style={{ ...cardStyle, padding: 16 }}>
          <form onSubmit={create}>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <input
                type="email"
                value={email}
                placeholder="email@example.com"
                autoComplete="off"
                onChange={(e) => setEmail(e.target.value)}
                style={inputStyle}
              />
              <input
                type="password"
                value={password}
                placeholder="Пароль (минимум 8 символов)"
                autoComplete="new-password"
                onChange={(e) => setPassword(e.target.value)}
                style={inputStyle}
              />
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as AdminRole)}
                style={inputStyle}
              >
                <option value="manager">Менеджер</option>
                <option value="superadmin">Суперадминистратор</option>
              </select>
            </div>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={creating}
              style={{ marginTop: 12 }}
            >
              {creating ? "Создание…" : "Создать"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

import { type FormEvent, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  type AdminRow,
  ApiError,
  clearToken,
  type CreateInviteResult,
  type InviteRow,
  saas,
} from "../api/saas.ts";

/**
 * Team management — список admin'ов + invite flow. Email-доставка
 * приглашений пока не автоматизирована (нет email-infra) — superadmin
 * получает share-url и передаёт коллеге out-of-band (TG/WA/etc).
 */
export function SaasTeam() {
  const navigate = useNavigate();
  const [admins, setAdmins] = useState<AdminRow[]>([]);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"manager" | "superadmin">("manager");
  const [submitting, setSubmitting] = useState(false);
  const [lastCreated, setLastCreated] = useState<CreateInviteResult | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleAuthError(err: unknown): boolean {
    if (err instanceof ApiError && err.status === 401) {
      clearToken();
      navigate("/login", { replace: true });
      return true;
    }
    return false;
  }

  async function refresh() {
    try {
      const [adminsRes, invitesRes] = await Promise.all([
        saas.listAdmins(),
        saas.listInvites(),
      ]);
      setAdmins(adminsRes.items);
      setInvites(invitesRes.items);
    } catch (err) {
      if (handleAuthError(err)) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await refresh();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: navigate stable
  }, []);

  async function handleInvite(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLastCreated(null);
    if (!email.trim()) {
      setError("Email обязателен");
      return;
    }
    setSubmitting(true);
    try {
      const res = await saas.inviteAdmin({ email: email.trim().toLowerCase(), role });
      setLastCreated(res);
      setEmail("");
      await refresh();
    } catch (err) {
      if (handleAuthError(err)) return;
      if (err instanceof ApiError) {
        if (err.status === 403) setError("Только superadmin может приглашать");
        else if (err.status === 409) setError("Admin с этим email уже существует");
        else if (err.status === 400) setError(`Ошибка: ${err.errorCode}`);
        else setError(`Ошибка ${err.status}: ${err.errorCode}`);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRevoke(id: number, email: string) {
    if (!confirm(`Отозвать приглашение для ${email}?`)) return;
    try {
      await saas.revokeInvite(id);
      await refresh();
    } catch (err) {
      if (handleAuthError(err)) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function copyShareUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API may be unavailable (non-HTTPS or old browser).
    }
  }

  if (loading) {
    return (
      <div className="dashboard-loading">
        <p>Загрузка…</p>
      </div>
    );
  }

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div>
          <h1>Команда</h1>
          <p className="dashboard-sub">
            Управление admin'ами и приглашениями коллег.
          </p>
        </div>
        <Link to="/dashboard" className="back-link">
          ← К базе знаний
        </Link>
      </header>

      {error && <div className="dashboard-error">{error}</div>}

      <section className="settings-section">
        <div className="settings-header">
          <h2>Пригласить коллегу</h2>
        </div>
        <p className="hint">
          Email-доставка пока не автоматизирована. Создайте приглашение, скопируйте
          ссылку и отправьте коллеге через Telegram / WhatsApp / email.
        </p>
        <form className="settings-form" onSubmit={handleInvite}>
          <label>
            Email
            <input
              type="email"
              autoComplete="off"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="colleague@yourcompany.com"
              required
            />
          </label>
          <label>
            Роль
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as "manager" | "superadmin")}
            >
              <option value="manager">Manager (повседневный доступ)</option>
              <option value="superadmin">Superadmin (полный доступ)</option>
            </select>
          </label>
          <button type="submit" disabled={submitting || !email.trim()}>
            {submitting ? "Создаём…" : "Создать приглашение"}
          </button>
        </form>

        {lastCreated?.shareUrl && (
          <div className="snippet-box">
            <strong>Ссылка-приглашение для {lastCreated.email}</strong>
            <p className="hint">
              Скопируйте и отправьте коллеге. Действует 7 дней.
            </p>
            <pre>{lastCreated.shareUrl}</pre>
            <button
              type="button"
              className="nav-link"
              onClick={() => copyShareUrl(lastCreated.shareUrl!)}
            >
              {copied ? "✓ Скопировано" : "Копировать"}
            </button>
          </div>
        )}
        {lastCreated && !lastCreated.shareUrl && (
          <div className="settings-warning">
            ⚠ PLATFORM_PUBLIC_URL не настроен. Token: <code>{lastCreated.token}</code>{" "}
            — передайте коллеге вместе с URL вашего admin-UI.
          </div>
        )}
      </section>

      <section className="docs-section">
        <h2>Admin'ы ({admins.length})</h2>
        {admins.length === 0 ? (
          <p className="empty-state">Никого нет</p>
        ) : (
          <ul className="docs-list">
            {admins.map((a) => (
              <li key={a.id} className="doc-row">
                <div className="doc-meta">
                  <strong>{a.email}</strong>
                  <small>
                    <span className="badge">{a.role}</span>{" "}
                    <span className="muted">
                      · добавлен {new Date(a.createdAt * 1000).toLocaleString()}
                    </span>
                  </small>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="docs-section">
        <h2>Приглашения ({invites.length})</h2>
        {invites.length === 0 ? (
          <p className="empty-state">Нет приглашений</p>
        ) : (
          <ul className="docs-list">
            {invites.map((inv) => (
              <li key={inv.id} className="doc-row">
                <div className="doc-meta">
                  <strong>{inv.email}</strong>
                  <small>
                    <span className="badge">{inv.role}</span>{" "}
                    {inv.status === "pending" && <span className="badge">⏳ pending</span>}
                    {inv.status === "accepted" && (
                      <span className="badge badge-ok">✓ принято</span>
                    )}
                    {inv.status === "expired" && (
                      <span className="badge badge-warning">истёк</span>
                    )}{" "}
                    <span className="muted">
                      · создано {new Date(inv.createdAt * 1000).toLocaleString()}
                    </span>
                  </small>
                </div>
                {inv.status === "pending" && (
                  <button
                    type="button"
                    onClick={() => handleRevoke(inv.id, inv.email)}
                  >
                    Отозвать
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

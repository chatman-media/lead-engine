import { type FormEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ApiError,
  type ChannelItem,
  clearToken,
  saas,
} from "../api/saas.ts";

/**
 * Per-tenant channel onboarding. MVP: Telegram bot — пользователь
 * вставляет token из @BotFather, backend validate'ит через getMe,
 * encrypted token живёт в tenant_secrets.
 *
 * NB: после create нужен restart apps/api + apps/worker чтобы новый
 * channel был подхвачен в ChannelRegistry. Hot-reload — TODO.
 */
export function SaasChannels() {
  const navigate = useNavigate();
  const [channels, setChannels] = useState<ChannelItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [botToken, setBotToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [lastCreated, setLastCreated] = useState<{ username: string } | null>(null);

  async function refresh() {
    try {
      const { items } = await saas.listChannels();
      setChannels(items);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearToken();
        navigate("/login", { replace: true });
        return;
      }
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

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLastCreated(null);
    const trimmed = botToken.trim();
    if (!trimmed) {
      setError("Вставьте Telegram bot token из @BotFather");
      return;
    }
    setSubmitting(true);
    try {
      const res = await saas.createTelegramChannel(trimmed);
      setLastCreated({ username: res.username });
      setBotToken("");
      await refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) {
          // Could be either auth-401 (token expired) или telegram-401 (bad bot token).
          // Telegram-rejected message comes back via errorCode "Telegram rejected token (invalid)".
          if (err.errorCode.toLowerCase().includes("telegram")) {
            setError("Telegram отверг токен — проверьте, что вставили правильно из @BotFather");
          } else {
            clearToken();
            navigate("/login", { replace: true });
            return;
          }
        } else if (err.status === 400) {
          setError(`Ошибка: ${err.errorCode}`);
        } else if (err.status === 409) {
          setError("Этот бот уже подключён к аккаунту");
        } else if (err.status === 502) {
          setError("Telegram недоступен — попробуйте позже");
        } else {
          setError(`Ошибка ${err.status}: ${err.errorCode}`);
        }
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: number, externalId: string) {
    if (!confirm(`Отключить канал @${externalId}? Token в tenant_secrets останется.`)) return;
    try {
      await saas.deleteChannel(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
          <h1>Каналы</h1>
          <p className="dashboard-sub">
            Telegram-боты, через которые приходят сообщения от клиентов.
          </p>
        </div>
        <Link to="/dashboard" className="back-link">
          ← К базе знаний
        </Link>
      </header>

      {error && <div className="dashboard-error">{error}</div>}

      {lastCreated && (
        <div className="settings-warning">
          ✓ Бот @{lastCreated.username} подключён. Для активации перезапустите apps/api +
          apps/worker (CD-deploy).
        </div>
      )}

      <section className="settings-section">
        <div className="settings-header">
          <h2>Подключить Telegram-бота</h2>
        </div>
        <p className="hint">
          Создайте бота в{" "}
          <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer">
            @BotFather
          </a>{" "}
          и вставьте сюда токен (формат <code>123456:ABC-DEF...</code>).
        </p>
        <form className="settings-form" onSubmit={handleSubmit}>
          <label>
            Bot token
            <input
              type="password"
              autoComplete="off"
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              placeholder="123456789:AAEhBP..."
              required
            />
          </label>
          <button type="submit" disabled={submitting || !botToken.trim()}>
            {submitting ? "Проверяем…" : "Подключить"}
          </button>
        </form>
      </section>

      <section className="docs-section">
        <h2>Подключённые каналы ({channels.length})</h2>
        {channels.length === 0 ? (
          <p className="empty-state">Пока ничего не подключено. Вставьте токен ↑</p>
        ) : (
          <ul className="docs-list">
            {channels.map((ch) => (
              <li key={ch.id} className="doc-row">
                <div className="doc-meta">
                  <strong>
                    {ch.kind === "telegram_bot" ? `@${ch.externalId}` : ch.externalId}
                  </strong>
                  <small>
                    <span className="badge">{ch.kind}</span>{" "}
                    <span className="badge">{ch.status}</span>{" "}
                    {ch.hasCredentials ? (
                      <span className="badge">creds OK</span>
                    ) : (
                      <span className="badge badge-warning">no creds</span>
                    )}{" "}
                    <span className="muted">
                      · добавлен {new Date(ch.createdAt * 1000).toLocaleString()}
                    </span>
                  </small>
                </div>
                <button type="button" onClick={() => handleDelete(ch.id, ch.externalId)}>
                  Отключить
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

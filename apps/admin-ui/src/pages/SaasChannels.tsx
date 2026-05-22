import { type FormEvent, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ApiError,
  type ChannelItem,
  type CreateWebChannelResult,
  type CreateWhatsAppChannelResult,
  clearToken,
  saas,
} from "../api/saas.ts";

/**
 * Per-tenant channel onboarding. Telegram (auto-setWebhook) + WhatsApp
 * (manual Meta dashboard setup с copy-paste snippet'ом) + Web widget
 * (snippet для customer site, без token'ов — anonymized externalUserId).
 *
 * Backend encrypt'ит токены через AES-256-GCM в tenant_secrets,
 * ChannelRegistry hot-reload'ится в apps/api (без рестарта).
 * apps/worker требует рестарта для подхвата новых каналов.
 */
type ChannelTab = "telegram" | "userbot" | "whatsapp" | "web";
type UserbotStep = "phone" | "code" | "2fa";

export function SaasChannels() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<ChannelTab>("telegram");
  const [channels, setChannels] = useState<ChannelItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Telegram form
  const [botToken, setBotToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [lastCreated, setLastCreated] = useState<{ username: string } | null>(null);

  // Telegram userbot (личный аккаунт) — пошаговый логин
  const [ubStep, setUbStep] = useState<UserbotStep>("phone");
  const [ubPhone, setUbPhone] = useState("");
  const [ubCode, setUbCode] = useState("");
  const [ubPassword, setUbPassword] = useState("");
  const [ubLoginId, setUbLoginId] = useState("");
  const [ubSubmitting, setUbSubmitting] = useState(false);
  const [ubError, setUbError] = useState("");
  const [ubDone, setUbDone] = useState<{ username: string | null } | null>(null);

  // WhatsApp form
  const [waPhoneId, setWaPhoneId] = useState("");
  const [waAccessToken, setWaAccessToken] = useState("");
  const [waBizId, setWaBizId] = useState("");
  const [waSubmitting, setWaSubmitting] = useState(false);
  const [waResult, setWaResult] = useState<CreateWhatsAppChannelResult | null>(null);

  // Web widget form
  const [webBrand, setWebBrand] = useState("");
  const [webColor, setWebColor] = useState("");
  const [webSubmitting, setWebSubmitting] = useState(false);
  const [webResult, setWebResult] = useState<CreateWebChannelResult | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  async function handleWebSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setWebResult(null);
    setWebSubmitting(true);
    try {
      const res = await saas.createWebChannel({
        ...(webBrand.trim() ? { brandName: webBrand.trim() } : {}),
        ...(/^#[0-9a-fA-F]{3,8}$/.test(webColor) ? { primaryColor: webColor } : {}),
      });
      setWebResult(res);
      await refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 402) {
          setError("Лимит каналов исчерпан — обновите план для добавления web-виджета");
        } else if (err.status === 401) {
          clearToken();
          navigate("/login", { replace: true });
          return;
        } else if (err.status === 400) {
          setError(`Ошибка: ${err.errorCode}`);
        } else {
          setError(`Ошибка ${err.status}: ${err.errorCode}`);
        }
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setWebSubmitting(false);
    }
  }

  async function copySnippet(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API may be unavailable (non-HTTPS or old browser).
    }
  }

  async function handleWhatsAppSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setWaResult(null);
    const phoneNumberId = waPhoneId.trim();
    const accessToken = waAccessToken.trim();
    if (!phoneNumberId || !accessToken) {
      setError("phone_number_id и access_token обязательны");
      return;
    }
    setWaSubmitting(true);
    try {
      const res = await saas.createWhatsAppChannel({
        phoneNumberId,
        accessToken,
        ...(waBizId.trim() ? { businessAccountId: waBizId.trim() } : {}),
      });
      setWaResult(res);
      setWaAccessToken("");
      await refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) {
          if (err.errorCode.toLowerCase().includes("meta")) {
            setError("Meta отвергла access_token — проверьте permissions и срок действия");
          } else {
            clearToken();
            navigate("/login", { replace: true });
            return;
          }
        } else if (err.status === 404) {
          setError("phone_number_id не найден — проверьте Meta dashboard → WhatsApp → API Setup");
        } else if (err.status === 400) {
          setError(`Ошибка: ${err.errorCode}`);
        } else if (err.status === 502) {
          setError("Meta Graph недоступен — попробуйте позже");
        } else {
          setError(`Ошибка ${err.status}: ${err.errorCode}`);
        }
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setWaSubmitting(false);
    }
  }

  function userbotErrMessage(err: unknown): string {
    if (err instanceof ApiError) {
      if (err.status === 401) {
        clearToken();
        navigate("/login", { replace: true });
        return "";
      }
      if (err.status === 503) return "Userbot отключён на сервере (нет TELEGRAM_API_ID/HASH)";
      if (err.status === 403) return "Доступно только для superadmin";
      const msg = err.extra?.message as string | undefined;
      const retry = err.extra?.retryAfterSec as number | undefined;
      if (err.errorCode === "flood_wait") {
        return `Слишком много попыток — подождите ${retry ?? "?"} сек`;
      }
      return msg ?? `Ошибка: ${err.errorCode}`;
    }
    return err instanceof Error ? err.message : String(err);
  }

  function resetUserbot() {
    setUbStep("phone");
    setUbPhone("");
    setUbCode("");
    setUbPassword("");
    setUbLoginId("");
    setUbError("");
  }

  async function handleUbPhone(e: FormEvent) {
    e.preventDefault();
    setUbError("");
    setUbDone(null);
    const phone = ubPhone.trim();
    if (!/^\+?\d{7,15}$/.test(phone)) {
      setUbError("Укажите номер в формате +79991234567");
      return;
    }
    setUbSubmitting(true);
    try {
      const res = await saas.startUserbotLogin(phone);
      setUbLoginId(res.loginId);
      setUbStep("code");
    } catch (err) {
      setUbError(userbotErrMessage(err));
    } finally {
      setUbSubmitting(false);
    }
  }

  async function handleUbCode(e: FormEvent) {
    e.preventDefault();
    setUbError("");
    setUbSubmitting(true);
    try {
      const res = await saas.verifyUserbotCode(ubLoginId, ubCode.trim());
      if ("awaiting" in res) {
        setUbStep("2fa");
      } else {
        setUbDone({ username: res.username });
        resetUserbot();
        await refresh();
      }
    } catch (err) {
      setUbError(userbotErrMessage(err));
    } finally {
      setUbSubmitting(false);
    }
  }

  async function handleUb2fa(e: FormEvent) {
    e.preventDefault();
    setUbError("");
    setUbSubmitting(true);
    try {
      const res = await saas.submitUserbot2fa(ubLoginId, ubPassword);
      if (!("awaiting" in res)) {
        setUbDone({ username: res.username });
      }
      resetUserbot();
      await refresh();
    } catch (err) {
      setUbError(userbotErrMessage(err));
    } finally {
      setUbSubmitting(false);
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
          ✓ Бот @{lastCreated.username} подключён и активирован — webhook настроен, канал работает.
        </div>
      )}

      {ubDone && (
        <div className="settings-warning">
          ✓ Личный аккаунт{ubDone.username ? ` @${ubDone.username}` : ""} подключён — входящие
          сообщения обрабатываются ассистентом.
        </div>
      )}

      {waResult && (
        <div className="settings-warning">
          ✓ WhatsApp канал {waResult.displayPhoneNumber ?? waResult.phoneNumberId} (
          {waResult.verifiedName ?? "no verified name"}) подключён.
          {waResult.webhookSetupHint && (
            <div style={{ marginTop: 8 }}>
              <strong>Настройте webhook в Meta dashboard:</strong>
              <pre style={{ marginTop: 4, padding: 8 }}>
                URL: {waResult.webhookSetupHint.url}
                {"\n"}
                Verify token: {waResult.webhookSetupHint.verifyToken}
                {"\n"}
                {waResult.webhookSetupHint.appSecretHint}
              </pre>
            </div>
          )}
        </div>
      )}

      <div className="channel-tabs">
        <button
          type="button"
          className={`channel-tab ${tab === "telegram" ? "active" : ""}`}
          onClick={() => setTab("telegram")}
        >
          Telegram
        </button>
        <button
          type="button"
          className={`channel-tab ${tab === "userbot" ? "active" : ""}`}
          onClick={() => setTab("userbot")}
        >
          Telegram (личный)
        </button>
        <button
          type="button"
          className={`channel-tab ${tab === "whatsapp" ? "active" : ""}`}
          onClick={() => setTab("whatsapp")}
        >
          WhatsApp
        </button>
        <button
          type="button"
          className={`channel-tab ${tab === "web" ? "active" : ""}`}
          onClick={() => setTab("web")}
        >
          Web виджет
        </button>
      </div>

      {tab === "telegram" && (
        <section className="settings-section">
          <div className="settings-header">
            <h2>Подключить Telegram-бота</h2>
          </div>
          <p className="hint">
            Создайте бота в{" "}
            <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer">
              @BotFather
            </a>{" "}
            и вставьте сюда токен (формат <code>123456:ABC-DEF...</code>). Webhook настроится
            автоматически.
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
      )}

      {tab === "whatsapp" && (
        <section className="settings-section">
          <div className="settings-header">
            <h2>Подключить WhatsApp Business</h2>
          </div>
          <p className="hint">
            Откройте{" "}
            <a
              href="https://developers.facebook.com/apps/"
              target="_blank"
              rel="noopener noreferrer"
            >
              Meta for Developers
            </a>{" "}
            → ваше WhatsApp Business приложение → API Setup. Скопируйте <code>Phone number ID</code>{" "}
            + сгенерируйте <code>Access token</code> (рекомендуется system user token, не временный
            24h). После создания канала здесь — UI покажет URL+token для webhook setup'а в Meta
            dashboard.
          </p>
          <form className="settings-form" onSubmit={handleWhatsAppSubmit}>
            <label>
              Phone number ID
              <input
                type="text"
                value={waPhoneId}
                onChange={(e) => setWaPhoneId(e.target.value)}
                placeholder="123456789012345"
                pattern="\d{10,20}"
                required
              />
            </label>
            <label>
              Access token (Bearer)
              <input
                type="password"
                autoComplete="off"
                value={waAccessToken}
                onChange={(e) => setWaAccessToken(e.target.value)}
                placeholder="EAAJZBxxxxxxx..."
                required
              />
            </label>
            <label>
              Business account ID (опционально)
              <input
                type="text"
                value={waBizId}
                onChange={(e) => setWaBizId(e.target.value)}
                placeholder="123456789012345"
              />
            </label>
            <button
              type="submit"
              disabled={waSubmitting || !waPhoneId.trim() || !waAccessToken.trim()}
            >
              {waSubmitting ? "Проверяем у Meta…" : "Подключить"}
            </button>
          </form>
        </section>
      )}

      {tab === "web" && (
        <section className="settings-section">
          <div className="settings-header">
            <h2>Web-виджет на сайт</h2>
          </div>
          <p className="hint">
            Включает чат-виджет для вашего сайта — посетители пишут через плавающий bubble. Backend
            без token'ов (channel-web использует WS-соединение, anonymized externalUserId). После
            включения UI покажет готовый snippet — вставьте перед закрывающим
            <code>{"</body>"}</code>.
          </p>
          <form className="settings-form" onSubmit={handleWebSubmit}>
            <label>
              Brand name (опционально)
              <input
                type="text"
                value={webBrand}
                onChange={(e) => setWebBrand(e.target.value)}
                placeholder="Acme Support"
                maxLength={64}
              />
            </label>
            <label>
              Цвет акцента (hex, опционально)
              <input
                type="text"
                value={webColor}
                onChange={(e) => setWebColor(e.target.value)}
                placeholder="#6aa6ff"
                pattern="#[0-9a-fA-F]{3,8}"
              />
            </label>
            <button type="submit" disabled={webSubmitting}>
              {webSubmitting ? "Создаём…" : webResult ? "Обновить" : "Включить виджет"}
            </button>
          </form>

          {webResult?.snippet && (
            <div className="snippet-box">
              <strong>Embed snippet</strong>
              <p className="hint">
                Скопируйте этот HTML и вставьте на ваш сайт перед закрывающим тегом
                <code>{"</body>"}</code>:
              </p>
              <pre>{webResult.snippet.html}</pre>
              <button
                type="button"
                className="nav-link"
                onClick={() => copySnippet(webResult.snippet!.html)}
              >
                {copied ? "✓ Скопировано" : "Копировать"}
              </button>
              <p className="hint" style={{ marginTop: 12 }}>
                Smoke-test:{" "}
                <a href={webResult.snippet.demoUrl} target="_blank" rel="noopener noreferrer">
                  открыть demo-чат
                </a>{" "}
                · WS URL: <code>{webResult.snippet.wsUrl}</code>
              </p>
            </div>
          )}
          {webResult && !webResult.snippet && (
            <div className="settings-warning">
              ⚠ {webResult.snippetHint ?? "snippet недоступен"}
            </div>
          )}
        </section>
      )}

      {tab === "userbot" && (
        <section className="settings-section">
          <div className="settings-header">
            <h2>Подключить личный Telegram-аккаунт</h2>
          </div>
          <p className="hint">
            Для случаев, когда лиды пишут в личку (а не боту). Подключается ваш личный аккаунт через
            MTProto. Доступно только для superadmin.
          </p>
          <div className="settings-warning" style={{ color: "#f0c674" }}>
            ⚠ Это автоматизация личного аккаунта. Подключайте только аккаунт, которым владеете, и
            используйте для ответов своим лидам — массовая рассылка нарушает правила Telegram и
            грозит блокировкой.
          </div>

          {ubError && <div className="dashboard-error">{ubError}</div>}

          {ubStep === "phone" && (
            <form className="settings-form" onSubmit={handleUbPhone}>
              <label>
                Номер телефона аккаунта
                <input
                  type="tel"
                  value={ubPhone}
                  onChange={(e) => setUbPhone(e.target.value)}
                  placeholder="+79991234567"
                  autoComplete="off"
                />
              </label>
              <button type="submit" disabled={ubSubmitting || !ubPhone.trim()}>
                {ubSubmitting ? "Отправляем код…" : "Получить код"}
              </button>
            </form>
          )}

          {ubStep === "code" && (
            <>
              <form className="settings-form" onSubmit={handleUbCode}>
                <p className="hint">
                  Telegram отправил код подтверждения на {ubPhone} (в приложение или SMS). Введите
                  его.
                </p>
                <label>
                  Код подтверждения
                  <input
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={ubCode}
                    onChange={(e) => setUbCode(e.target.value)}
                    placeholder="12345"
                  />
                </label>
                <button type="submit" disabled={ubSubmitting || !ubCode.trim()}>
                  {ubSubmitting ? "Проверяем…" : "Подтвердить"}
                </button>
              </form>
              <button type="button" className="link-button" onClick={resetUserbot}>
                ← Изменить номер
              </button>
            </>
          )}

          {ubStep === "2fa" && (
            <>
              <form className="settings-form" onSubmit={handleUb2fa}>
                <p className="hint">
                  У аккаунта включён облачный пароль (2FA). Введите его, чтобы завершить вход.
                </p>
                <label>
                  Пароль 2FA
                  <input
                    type="password"
                    autoComplete="off"
                    value={ubPassword}
                    onChange={(e) => setUbPassword(e.target.value)}
                    placeholder="••••••••"
                  />
                </label>
                <button type="submit" disabled={ubSubmitting || !ubPassword}>
                  {ubSubmitting ? "Проверяем…" : "Войти"}
                </button>
              </form>
              <button type="button" className="link-button" onClick={resetUserbot}>
                ← Начать заново
              </button>
            </>
          )}
        </section>
      )}

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
                    {ch.kind === "telegram_bot"
                      ? `@${ch.externalId}`
                      : ch.kind === "telegram_userbot"
                        ? `${ch.username ? `@${ch.username}` : `TG ${ch.externalId}`} (личный)`
                        : ch.kind === "whatsapp"
                          ? `WhatsApp #${ch.externalId}`
                          : ch.kind === "web"
                            ? `Web виджет (${ch.externalId})`
                            : ch.externalId}
                  </strong>
                  <small>
                    <span className="badge">{ch.kind}</span>{" "}
                    <span className={`badge ${ch.status === "error" ? "badge-warning" : ""}`}>
                      {ch.status}
                    </span>{" "}
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
                <div style={{ display: "flex", gap: 8 }}>
                  {ch.kind === "telegram_userbot" && ch.status === "error" && (
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => {
                        resetUserbot();
                        setUbDone(null);
                        setTab("userbot");
                      }}
                    >
                      Авторизовать заново
                    </button>
                  )}
                  <button type="button" onClick={() => handleDelete(ch.id, ch.externalId)}>
                    Отключить
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

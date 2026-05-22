import { type FormEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ApiError,
  type ChannelItem,
  clearToken,
  type KbDoc,
  type LlmConfig,
  type LlmProvider,
  type LlmPurpose,
  saas,
} from "../api/saas.ts";

/**
 * Пошаговый мастер первичной настройки кабинета. Ведёт нового
 * пользователя по шагам: канал → API-ключи → база знаний → готово.
 *
 * Мастер самодостаточен и переиспользует готовые saas.* методы. Формы
 * лёгкие (только необходимое для старта); продвинутые опции — на полных
 * страницах /channels и /settings, куда даём ссылки. Порядок не случаен:
 * эмбеддинги базы знаний требуют ключ embed-провайдера, поэтому ключи
 * идут раньше базы.
 */

const PROVIDERS: { value: LlmProvider; label: string }[] = [
  { value: "openai", label: "OpenAI" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "anthropic", label: "Anthropic" },
  { value: "ollama", label: "Ollama (local, без API key)" },
];

const STEP_LABELS = ["Канал", "API-ключи", "База знаний", "Готово"];

interface KeyForm {
  provider: LlmProvider;
  model: string;
  apiKey: string;
  embedDim: string;
}

const EMPTY_KEY_FORM: KeyForm = { provider: "openai", model: "", apiKey: "", embedDim: "" };

function configReady(cfg: LlmConfig | undefined): boolean {
  if (!cfg) return false;
  return cfg.provider === "ollama" || cfg.hasSecret;
}

export function SaasOnboarding() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState(0);
  const [error, setError] = useState("");

  const [channels, setChannels] = useState<ChannelItem[]>([]);
  const [configs, setConfigs] = useState<LlmConfig[]>([]);
  const [docs, setDocs] = useState<KbDoc[]>([]);

  // Step 1 — Telegram
  const [botToken, setBotToken] = useState("");
  const [tgSubmitting, setTgSubmitting] = useState(false);

  // Step 2 — keys
  const [keyForms, setKeyForms] = useState<Record<"chat" | "embed", KeyForm>>({
    chat: { ...EMPTY_KEY_FORM },
    embed: { ...EMPTY_KEY_FORM },
  });
  const [savingPurpose, setSavingPurpose] = useState<LlmPurpose | null>(null);

  // Step 3 — KB
  const [pasteTitle, setPasteTitle] = useState("");
  const [pasteTopic, setPasteTopic] = useState("");
  const [pasteBody, setPasteBody] = useState("");
  const [uploading, setUploading] = useState(false);
  const [lastIndexed, setLastIndexed] = useState<number | null>(null);

  const chatCfg = configs.find((c) => c.purpose === "chat");
  const embedCfg = configs.find((c) => c.purpose === "embed");

  const channelDone = channels.length > 0;
  const keysDone = configReady(chatCfg) && configReady(embedCfg);
  const kbDone = docs.length > 0;
  const stepDone = [channelDone, keysDone, kbDone, false];

  function reachable(target: number): boolean {
    if (target <= 0) return true;
    if (target === 1) return channelDone;
    // keys (2) and done (3) require channel + keys; KB is optional
    return channelDone && keysDone;
  }

  /** Возвращает обработчик 401 (сброс токена + редирект) или false. */
  function handleAuthError(err: unknown): boolean {
    if (err instanceof ApiError && err.status === 401) {
      clearToken();
      navigate("/login", { replace: true });
      return true;
    }
    return false;
  }

  async function loadState() {
    const [ch, cfg] = await Promise.all([saas.listChannels(), saas.listLlmConfigs()]);
    // KB-роуты на бэкенде включаются только если у какого-то тенанта есть
    // embed-конфиг на старте. У нового пользователя их ещё нет → listDocs
    // отдаёт 404. Для онбординга это не фатально (KB-шаг опционален), поэтому
    // глотаем не-401 ошибки и считаем, что документов пока нет.
    let docItems: KbDoc[] = [];
    try {
      docItems = (await saas.listDocs()).items;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) throw err;
    }
    setChannels(ch.items);
    setConfigs(cfg.items);
    setDocs(docItems);
    for (const c of cfg.items) {
      if (c.purpose === "chat" || c.purpose === "embed") {
        setKeyForms((prev) => ({
          ...prev,
          [c.purpose]: {
            provider: c.provider,
            model: c.model,
            apiKey: "",
            embedDim: c.embedDim?.toString() ?? "",
          },
        }));
      }
    }
    return { ch: ch.items, cfg: cfg.items, kb: docItems };
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { ch, cfg, kb } = await loadState();
        if (cancelled) return;
        const cDone = ch.length > 0;
        const kDone =
          configReady(cfg.find((c) => c.purpose === "chat")) &&
          configReady(cfg.find((c) => c.purpose === "embed"));
        const dDone = kb.length > 0;
        setStep(!cDone ? 0 : !kDone ? 1 : !dDone ? 2 : 3);
      } catch (err) {
        if (cancelled) return;
        if (!handleAuthError(err)) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function updateKeyForm(purpose: "chat" | "embed", patch: Partial<KeyForm>) {
    setKeyForms((prev) => ({ ...prev, [purpose]: { ...prev[purpose], ...patch } }));
  }

  async function handleTelegram(e: FormEvent) {
    e.preventDefault();
    setError("");
    const token = botToken.trim();
    if (!token) {
      setError("Вставьте Telegram bot token из @BotFather");
      return;
    }
    setTgSubmitting(true);
    try {
      await saas.createTelegramChannel(token);
      setBotToken("");
      const { ch } = await loadState();
      if (ch.length > 0) setStep(1);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401 && err.errorCode.toLowerCase().includes("telegram")) {
          setError("Telegram отверг токен — проверьте, что вставили правильно из @BotFather");
        } else if (handleAuthError(err)) {
          return;
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
      setTgSubmitting(false);
    }
  }

  async function handleSaveKey(e: FormEvent, purpose: "chat" | "embed") {
    e.preventDefault();
    setError("");
    const f = keyForms[purpose];
    if (!f.model.trim()) {
      setError(`${purpose}: укажите модель`);
      return;
    }
    if (purpose === "embed" && !f.embedDim) {
      setError("embed: укажите размерность (например, 1536 для text-embedding-3-small)");
      return;
    }
    const existing = configs.find((c) => c.purpose === purpose);
    if (f.provider !== "ollama" && !f.apiKey && !existing?.hasSecret) {
      setError(`${purpose}: укажите API key`);
      return;
    }
    setSavingPurpose(purpose);
    try {
      await saas.upsertLlmConfig(purpose, {
        provider: f.provider,
        model: f.model.trim(),
        ...(f.apiKey ? { apiKey: f.apiKey } : {}),
        ...(purpose === "embed" && f.embedDim ? { embedDim: Number.parseInt(f.embedDim, 10) } : {}),
      });
      updateKeyForm(purpose, { apiKey: "" });
      const { cfg } = await loadState();
      const ready =
        configReady(cfg.find((c) => c.purpose === "chat")) &&
        configReady(cfg.find((c) => c.purpose === "embed"));
      if (ready) setStep(2);
    } catch (err) {
      if (!handleAuthError(err)) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSavingPurpose(null);
    }
  }

  function handleKbError(err: unknown) {
    if (err instanceof ApiError && err.status === 402) {
      const hint = err.extra?.upgradeHint as string | undefined;
      setError(hint ?? "Лимит документов исчерпан — повысьте план");
    } else if (!handleAuthError(err)) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError("");
    setLastIndexed(null);
    try {
      const res = await saas.uploadFile(file);
      setLastIndexed(res.chunks);
      await loadState();
    } catch (err) {
      handleKbError(err);
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }

  async function handlePaste(e: FormEvent) {
    e.preventDefault();
    if (!pasteBody.trim()) return;
    setUploading(true);
    setError("");
    setLastIndexed(null);
    try {
      const res = await saas.uploadJson({
        title: pasteTitle.trim() || "untitled",
        body: pasteBody,
        ...(pasteTopic.trim() ? { topic: pasteTopic.trim() } : {}),
      });
      setLastIndexed(res.chunks);
      setPasteTitle("");
      setPasteTopic("");
      setPasteBody("");
      await loadState();
    } catch (err) {
      handleKbError(err);
    } finally {
      setUploading(false);
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
          <h1>Настройка кабинета</h1>
          <p className="dashboard-sub">Несколько шагов — и бот начнёт отвечать вашим клиентам.</p>
        </div>
        <Link to="/dashboard" className="back-link">
          Пропустить → в кабинет
        </Link>
      </header>

      {error && <div className="dashboard-error">{error}</div>}

      <ol className="wizard-steps">
        {STEP_LABELS.map((label, i) => {
          const done = stepDone[i];
          const active = step === i;
          const canGo = reachable(i);
          return (
            <li
              key={label}
              className={`wizard-step ${active ? "active" : ""} ${done ? "done" : ""} ${
                canGo ? "" : "locked"
              }`}
            >
              <button
                type="button"
                className="wizard-step-btn"
                disabled={!canGo}
                onClick={() => canGo && setStep(i)}
              >
                <span className="wizard-step-mark">{done ? "✓" : i + 1}</span>
                <span className="wizard-step-label">{label}</span>
              </button>
            </li>
          );
        })}
      </ol>

      {step === 0 && (
        <section className="settings-section">
          <div className="settings-header">
            <h2>Шаг 1. Подключите канал</h2>
          </div>
          <p className="hint">
            Создайте бота в{" "}
            <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer">
              @BotFather
            </a>{" "}
            и вставьте токен (формат <code>123456:ABC-DEF…</code>). Webhook настроится
            автоматически.
          </p>
          {channelDone && (
            <p className="settings-status">
              Подключено каналов: <code>{channels.length}</code>{" "}
              <span className="badge badge-ok">готово</span>
            </p>
          )}
          <form className="settings-form" onSubmit={handleTelegram}>
            <label>
              Telegram bot token
              <input
                type="password"
                autoComplete="off"
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
                placeholder="123456789:AAEhBP…"
              />
            </label>
            <button type="submit" disabled={tgSubmitting || !botToken.trim()}>
              {tgSubmitting ? "Проверяем…" : "Подключить"}
            </button>
          </form>
          <p className="hint" style={{ marginTop: 12 }}>
            Нужен WhatsApp или web-виджет? <Link to="/channels">Все типы каналов →</Link>
          </p>
          {channelDone && (
            <button type="button" className="wizard-next" onClick={() => setStep(1)}>
              Далее: API-ключи →
            </button>
          )}
        </section>
      )}

      {step === 1 && (
        <section className="settings-section">
          <div className="settings-header">
            <h2>Шаг 2. API-ключи</h2>
          </div>
          <p className="hint">
            BYOK — ваши ключи для генерации ответов (chat) и поиска по базе знаний (embed). Хранятся
            зашифрованными (AES-256-GCM).
          </p>

          {(["chat", "embed"] as const).map((purpose) => {
            const cfg = purpose === "chat" ? chatCfg : embedCfg;
            const f = keyForms[purpose];
            const isChat = purpose === "chat";
            return (
              <div key={purpose} className="wizard-key-block">
                <h3>{isChat ? "Chat — ответы ассистента" : "Embeddings — поиск по базе"}</h3>
                {cfg && (
                  <p className="settings-status">
                    <code>{cfg.provider}</code> / <code>{cfg.model}</code>{" "}
                    {configReady(cfg) ? (
                      <span className="badge badge-ok">ключ есть</span>
                    ) : (
                      <span className="badge badge-warning">без ключа</span>
                    )}
                  </p>
                )}
                <form className="settings-form" onSubmit={(e) => handleSaveKey(e, purpose)}>
                  <label>
                    Provider
                    <select
                      value={f.provider}
                      onChange={(e) =>
                        updateKeyForm(purpose, { provider: e.target.value as LlmProvider })
                      }
                    >
                      {PROVIDERS.map((p) => (
                        <option key={p.value} value={p.value}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Model
                    <input
                      type="text"
                      value={f.model}
                      onChange={(e) => updateKeyForm(purpose, { model: e.target.value })}
                      placeholder={isChat ? "gpt-4o-mini" : "text-embedding-3-small"}
                    />
                  </label>
                  {f.provider !== "ollama" && (
                    <label>
                      API key {cfg?.hasSecret ? "(пусто — не менять)" : ""}
                      <input
                        type="password"
                        autoComplete="new-password"
                        value={f.apiKey}
                        onChange={(e) => updateKeyForm(purpose, { apiKey: e.target.value })}
                        placeholder={cfg?.hasSecret ? "•••••••• (сохранён)" : "sk-…"}
                      />
                    </label>
                  )}
                  {!isChat && (
                    <label>
                      Размерность embed (обязательно)
                      <input
                        type="number"
                        value={f.embedDim}
                        onChange={(e) => updateKeyForm(purpose, { embedDim: e.target.value })}
                        placeholder="1536"
                      />
                    </label>
                  )}
                  <button type="submit" disabled={savingPurpose !== null}>
                    {savingPurpose === purpose ? "Сохраняем…" : "Сохранить"}
                  </button>
                </form>
              </div>
            );
          })}

          <p className="hint" style={{ marginTop: 12 }}>
            Base URL, timeout и др. — <Link to="/settings">расширенные настройки →</Link>
          </p>
          {keysDone && (
            <button type="button" className="wizard-next" onClick={() => setStep(2)}>
              Далее: база знаний →
            </button>
          )}
        </section>
      )}

      {step === 2 && (
        <section className="settings-section">
          <div className="settings-header">
            <h2>Шаг 3. База знаний (опционально)</h2>
          </div>
          <p className="hint">
            Загрузите документы — бот будет отвечать по вашей базе (RAG). Файлы при загрузке
            автоматически индексируются. Шаг можно пропустить.
          </p>

          {lastIndexed !== null && (
            <div className="settings-warning" style={{ color: "var(--ok)" }}>
              ✓ Документ проиндексирован — {lastIndexed} фрагментов.
            </div>
          )}

          <div className="upload-card">
            <h3>Загрузить файл</h3>
            <p className="hint">.txt, .md, .json, .pdf</p>
            <input
              type="file"
              accept=".txt,.md,.json,.pdf"
              onChange={handleFileUpload}
              disabled={uploading}
            />
          </div>

          <div className="upload-card">
            <h3>Или вставить текст</h3>
            <form onSubmit={handlePaste} className="paste-form">
              <input
                type="text"
                placeholder="Заголовок"
                value={pasteTitle}
                onChange={(e) => setPasteTitle(e.target.value)}
              />
              <input
                type="text"
                placeholder="Тема (опционально)"
                value={pasteTopic}
                onChange={(e) => setPasteTopic(e.target.value)}
              />
              <textarea
                placeholder="Текст документа…"
                rows={6}
                value={pasteBody}
                onChange={(e) => setPasteBody(e.target.value)}
              />
              <button type="submit" disabled={uploading || !pasteBody.trim()}>
                {uploading ? "Загружаем…" : "Добавить"}
              </button>
            </form>
          </div>

          {docs.length > 0 && (
            <p className="settings-status">
              Документов в базе: <code>{docs.length}</code>
            </p>
          )}

          <button type="button" className="wizard-next" onClick={() => setStep(3)}>
            {kbDone ? "Далее →" : "Пропустить →"}
          </button>
        </section>
      )}

      {step === 3 && (
        <section className="settings-section">
          <div className="settings-header">
            <h2>Готово!</h2>
          </div>
          <ul className="onboarding-list">
            <li className={`onboarding-step ${channelDone ? "done" : ""}`}>
              <span className="onboarding-mark">{channelDone ? "✓" : "○"}</span>
              <div className="onboarding-step-body">
                <strong>Канал</strong>
                <small>{channelDone ? `Подключено: ${channels.length}` : "Не подключён"}</small>
              </div>
            </li>
            <li className={`onboarding-step ${keysDone ? "done" : ""}`}>
              <span className="onboarding-mark">{keysDone ? "✓" : "○"}</span>
              <div className="onboarding-step-body">
                <strong>API-ключи</strong>
                <small>{keysDone ? "chat + embed настроены" : "Не настроены"}</small>
              </div>
            </li>
            <li className={`onboarding-step ${kbDone ? "done" : ""}`}>
              <span className="onboarding-mark">{kbDone ? "✓" : "○"}</span>
              <div className="onboarding-step-body">
                <strong>База знаний</strong>
                <small>{kbDone ? `Документов: ${docs.length}` : "Пропущено (опционально)"}</small>
              </div>
            </li>
          </ul>
          <button
            type="button"
            className="wizard-next"
            onClick={() => navigate("/dashboard", { replace: true })}
          >
            Перейти в кабинет →
          </button>
        </section>
      )}
    </div>
  );
}

import { useEffect, useState } from "react";
import { useAdmin } from "../App.tsx";
import { api } from "../api.ts";
import { confirmDialog } from "../components/Dialogs.tsx";

/**
 * Operations page — routine maintenance actions.
 *
 * Two tiers:
 *   - everyday actions an operator/owner can safely run (KB refresh, vacancy
 *     list refresh, userbot queue status);
 *   - a collapsed "Для разработчика" block for technical / destructive
 *     actions (wipe KB, Telegram webhook, MTProto proxies, purge old stats).
 *
 * Every action runs synchronously inside the request; the UI shows a
 * spinner and a plain-language result. Destructive actions confirm twice.
 */

type Result =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "ok"; data: unknown }
  | { kind: "err"; msg: string };

function ResultView({ result }: { result: Result }) {
  if (result.kind === "idle") return null;
  if (result.kind === "running") {
    return <div style={{ color: "var(--text-3)", fontSize: 13 }}>Выполняется…</div>;
  }
  if (result.kind === "err") {
    return <div style={{ color: "var(--red, #ef4444)", fontSize: 13 }}>Ошибка: {result.msg}</div>;
  }
  return (
    <div style={{ fontSize: 13 }}>
      <div style={{ color: "var(--green, #16a34a)", fontWeight: 600 }}>Готово ✓</div>
      <details style={{ marginTop: 4 }}>
        <summary style={{ cursor: "pointer", color: "var(--text-3)", fontSize: 12 }}>
          подробности
        </summary>
        <pre
          style={{
            background: "var(--bg-2)",
            border: "1px solid var(--border)",
            color: "var(--text)",
            padding: 8,
            borderRadius: 4,
            fontSize: 12,
            fontFamily: "var(--mono)",
            overflow: "auto",
            maxHeight: 200,
            marginTop: 6,
          }}
        >
          {JSON.stringify(result.data, null, 2)}
        </pre>
      </details>
    </div>
  );
}

function Card({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      style={{
        background: "var(--bg-1)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        boxShadow: "var(--shadow-sm)",
        padding: 16,
        marginBottom: 16,
      }}
    >
      <h3 style={{ margin: 0, marginBottom: hint ? 4 : 12, fontSize: 14, fontWeight: 600 }}>
        {title}
      </h3>
      {hint && <div style={{ color: "var(--text-3)", fontSize: 12, marginBottom: 12 }}>{hint}</div>}
      {children}
    </section>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3
      style={{
        fontSize: 12,
        textTransform: "uppercase",
        letterSpacing: 0.5,
        color: "var(--text-3)",
        marginBottom: 8,
      }}
    >
      {children}
    </h3>
  );
}

// ─── KB refresh from disk ──────────────────────────────────────────────

// Mirror of the whitelist in src/admin/routes/ops.ts.
type KbIngestSource = "curated" | "books" | "extracted" | "chats";

function KbIngestPanel() {
  const [result, setResult] = useState<Result>({ kind: "idle" });
  const [source, setSource] = useState<KbIngestSource>("curated");

  async function run() {
    setResult({ kind: "running" });
    try {
      const data = await api.opsKbIngest({ source });
      setResult({ kind: "ok", data });
    } catch (err) {
      setResult({ kind: "err", msg: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <Card
      title="Обновить базу знаний бота"
      hint="Загружает документы (.md / .txt / .pdf) из выбранной папки проекта в базу знаний, по которой бот отвечает. Безопасно: повторный запуск не создаёт дубликатов."
    >
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
        <select
          value={source}
          onChange={(e) => setSource(e.target.value as KbIngestSource)}
          disabled={result.kind === "running"}
        >
          <option value="curated">Готовые ответы (FAQ)</option>
          <option value="extracted">Посты и диалоги</option>
          <option value="chats">Дампы переписок</option>
          <option value="books">Книги</option>
        </select>
        <button
          type="button"
          className="btn btn-primary"
          onClick={run}
          disabled={result.kind === "running"}
        >
          Загрузить
        </button>
      </div>
      <ResultView result={result} />
    </Card>
  );
}

// ─── Vacancy list refresh ──────────────────────────────────────────────

function ReseedVacanciesPanel() {
  const [result, setResult] = useState<Result>({ kind: "idle" });

  async function run() {
    setResult({ kind: "running" });
    try {
      const data = await api.opsReseedVacancies();
      setResult({ kind: "ok", data });
    } catch (err) {
      setResult({ kind: "err", msg: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <Card
      title="Восстановить список вакансий"
      hint="Добавляет стандартный набор вакансий Infinity. Уже существующие вакансии не трогает и не дублирует."
    >
      <button
        type="button"
        className="btn btn-primary"
        onClick={run}
        disabled={result.kind === "running"}
      >
        Восстановить
      </button>
      <div style={{ marginTop: 12 }}>
        <ResultView result={result} />
      </div>
    </Card>
  );
}

// ─── Userbot queue status ──────────────────────────────────────────────

function UserbotQueuePanel() {
  const [stats, setStats] = useState<{
    by_status: Record<string, number>;
    userbot_enabled: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setError(null);
    try {
      const data = await api.opsUserbotQueueStats();
      setStats(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  return (
    <Card
      title="Очередь ответов с личного аккаунта"
      hint="Сколько ответов оператора ждут отправки через личный аккаунт (userbot)."
    >
      {stats && (
        <div style={{ fontSize: 13, marginBottom: 12 }}>
          <div>
            Личный аккаунт: <strong>{stats.userbot_enabled ? "подключён" : "выключен"}</strong>
          </div>
          {Object.entries(stats.by_status).length === 0 ? (
            <div style={{ color: "var(--text-3)" }}>Очередь пустая.</div>
          ) : (
            Object.entries(stats.by_status).map(([status, count]) => (
              <div key={status}>
                <span style={{ color: "var(--text-3)" }}>{status}:</span> {count}
              </div>
            ))
          )}
        </div>
      )}
      <button type="button" className="btn btn-ghost btn-sm" onClick={refresh}>
        Обновить
      </button>
      {error && (
        <div style={{ color: "var(--red, #ef4444)", fontSize: 13, marginTop: 8 }}>{error}</div>
      )}
    </Card>
  );
}

// ─── KB wipe (destructive) ─────────────────────────────────────────────

function KbWipePanel() {
  const [result, setResult] = useState<Result>({ kind: "idle" });
  const [confirming, setConfirming] = useState(false);

  async function run() {
    setResult({ kind: "running" });
    try {
      const data = await api.opsKbWipe();
      setResult({ kind: "ok", data });
      setConfirming(false);
    } catch (err) {
      setResult({ kind: "err", msg: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <Card
      title="Очистить базу знаний"
      hint="Удаляет ВСЕ документы из базы знаний бота. После этого нужно загрузить базу заново. Действие необратимо."
    >
      {!confirming ? (
        <button type="button" className="btn btn-ghost" onClick={() => setConfirming(true)}>
          Очистить…
        </button>
      ) : (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ color: "var(--red, #ef4444)", fontSize: 13 }}>
            Точно удалить все документы?
          </span>
          <button
            type="button"
            style={{ background: "var(--red, #ef4444)", color: "#fff" }}
            className="btn"
            onClick={run}
            disabled={result.kind === "running"}
          >
            Да, очистить
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => setConfirming(false)}>
            Отмена
          </button>
        </div>
      )}
      <div style={{ marginTop: 12 }}>
        <ResultView result={result} />
      </div>
    </Card>
  );
}

// ─── Telegram webhook ──────────────────────────────────────────────────

function TelegramWebhookPanel() {
  const [info, setInfo] = useState<{ url: string; pending_update_count: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState("");

  async function refresh() {
    setError(null);
    try {
      const { info } = await api.opsGetTelegramWebhook();
      setInfo(info);
      if (!url) setUrl(info.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function setHook() {
    setBusy(true);
    setError(null);
    try {
      const { info } = await api.opsSetTelegramWebhook({ url });
      setInfo(info);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function deleteHook() {
    if (
      !(await confirmDialog("Бот перестанет получать сообщения из Telegram.", {
        title: "Удалить вебхук?",
        confirmLabel: "Удалить",
        danger: true,
      }))
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.opsDeleteTelegramWebhook(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Telegram webhook"
      hint="Адрес, на который Telegram присылает сообщения боту. Должен начинаться с https://."
    >
      {info && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 13, marginBottom: 12 }}>
          <div>
            <span style={{ color: "var(--text-3)" }}>url:</span> {info.url || "(не задан)"}
          </div>
          <div>
            <span style={{ color: "var(--text-3)" }}>в очереди:</span> {info.pending_update_count}
          </div>
        </div>
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input
          type="url"
          placeholder="https://домен/telegram/СЕКРЕТ"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={busy}
          style={{ flex: 1, minWidth: 280 }}
        />
        <button type="button" className="btn btn-primary" onClick={setHook} disabled={busy || !url}>
          Привязать
        </button>
        <button type="button" className="btn btn-ghost" onClick={refresh} disabled={busy}>
          Обновить
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={deleteHook}
          disabled={busy}
          style={{ color: "var(--red, #ef4444)" }}
        >
          Удалить
        </button>
      </div>
      {error && (
        <div style={{ color: "var(--red, #ef4444)", fontSize: 13, marginTop: 8 }}>{error}</div>
      )}
    </Card>
  );
}

// ─── Purge old stats (destructive-ish) ─────────────────────────────────

function PurgeOutcomesPanel() {
  const [days, setDays] = useState(90);
  const [result, setResult] = useState<Result>({ kind: "idle" });

  async function run(dryRun: boolean) {
    setResult({ kind: "running" });
    try {
      const data = await api.opsPurgeOutcomes({ days, dryRun });
      setResult({ kind: "ok", data });
    } catch (err) {
      setResult({ kind: "err", msg: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <Card
      title="Очистка старой статистики"
      hint="Удаляет старые записи обучающей статистики (skill / self-play). История решений сохраняется."
    >
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
        <label style={{ fontSize: 13 }}>
          Старше{" "}
          <input
            type="number"
            min={1}
            value={days}
            onChange={(e) => setDays(Math.max(1, Number(e.target.value) || 90))}
            style={{ width: 60 }}
            disabled={result.kind === "running"}
          />{" "}
          дней
        </label>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => run(true)}
          disabled={result.kind === "running"}
        >
          Сначала проверить
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => run(false)}
          disabled={result.kind === "running"}
        >
          Удалить
        </button>
      </div>
      <ResultView result={result} />
    </Card>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────

// ─── OpenRouter balance ────────────────────────────────────────────────

function OpenRouterBalancePanel() {
  const [state, setState] = useState<
    { kind: "idle" } | { kind: "running" } | { kind: "done"; ok: boolean; text: string }
  >({ kind: "idle" });

  async function run() {
    setState({ kind: "running" });
    try {
      const r = await api.opsOpenRouterCredits();
      if (r.ok && r.credits) {
        setState({
          kind: "done",
          ok: true,
          text: `Остаток: $${r.credits.remaining.toFixed(2)} · потрачено $${r.credits.totalUsage.toFixed(2)}`,
        });
      } else {
        setState({ kind: "done", ok: false, text: r.detail ?? "Не удалось получить баланс" });
      }
    } catch (err) {
      setState({ kind: "done", ok: false, text: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <Card
      title="Баланс OpenRouter"
      hint="Проверяет остаток средств на счёте OpenRouter прямо сейчас. Бот и так следит за балансом в фоне и предупредит при низком остатке."
    >
      <button
        type="button"
        className="btn btn-primary"
        onClick={run}
        disabled={state.kind === "running"}
      >
        {state.kind === "running" ? "Проверяется…" : "Проверить баланс"}
      </button>
      {state.kind === "done" && (
        <div
          style={{
            marginTop: 12,
            fontSize: 13,
            color: state.ok ? "var(--green, #16a34a)" : "var(--red, #ef4444)",
          }}
        >
          {state.ok ? "✓ " : "✗ "}
          {state.text}
        </div>
      )}
    </Card>
  );
}

// ─── Restart the bot ───────────────────────────────────────────────────

function RestartPanel() {
  const [restarting, setRestarting] = useState(false);

  async function run() {
    if (
      !(await confirmDialog("Бот будет недоступен ~15 секунд.", {
        title: "Перезапустить бота?",
        confirmLabel: "Перезапустить",
      }))
    ) {
      return;
    }
    setRestarting(true);
    try {
      await api.opsRestart();
    } catch {
      // Бот завершает процесс — ответ может не дойти, это ожидаемо.
    }
  }

  return (
    <Card
      title="Перезапустить бота"
      hint="Нужно после смены ключей или настроек. Работает, если сервис настроен на авто-рестарт (systemd Restart=always — см. docs/RUNBOOK.md)."
    >
      <button type="button" className="btn btn-primary" onClick={run} disabled={restarting}>
        {restarting ? "Перезапуск…" : "Перезапустить"}
      </button>
      {restarting && (
        <div style={{ marginTop: 12, fontSize: 13, color: "var(--text-3)" }}>
          Бот перезапускается — обновите страницу через ~15 секунд.
        </div>
      )}
    </Card>
  );
}

export function Operations() {
  const admin = useAdmin();
  if (admin.role !== "superadmin") {
    return (
      <div style={{ padding: 24, maxWidth: 900 }}>
        <h2 style={{ marginTop: 0, marginBottom: 4, fontFamily: "var(--display)" }}>Операции</h2>
        <div style={{ color: "var(--text-3)", fontSize: 13 }}>
          Раздел доступен только суперадминистратору.
        </div>
      </div>
    );
  }
  return (
    <div style={{ padding: 24, maxWidth: 900 }}>
      <h2 style={{ marginTop: 0, marginBottom: 4, fontFamily: "var(--display)" }}>Операции</h2>
      <div style={{ color: "var(--text-3)", fontSize: 13, marginBottom: 20 }}>
        Обслуживающие действия. Обычные — сверху; технические — в блоке «Для разработчика».
      </div>

      <SectionTitle>Обслуживание</SectionTitle>
      <KbIngestPanel />
      <ReseedVacanciesPanel />
      <UserbotQueuePanel />
      <OpenRouterBalancePanel />
      <RestartPanel />

      <details style={{ marginTop: 24 }}>
        <summary
          style={{
            cursor: "pointer",
            fontSize: 12,
            textTransform: "uppercase",
            letterSpacing: 0.5,
            color: "var(--text-3)",
            marginBottom: 12,
            userSelect: "none",
          }}
        >
          Для разработчика
        </summary>

        <div style={{ marginTop: 12 }}>
          <TelegramWebhookPanel />
          <PurgeOutcomesPanel />
          <KbWipePanel />
        </div>
      </details>
    </div>
  );
}

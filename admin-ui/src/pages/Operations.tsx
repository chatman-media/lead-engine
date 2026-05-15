import { useEffect, useState } from "react";
import { api } from "../api.ts";

/**
 * Operations / maintenance dashboard. Surfaces common CLI scripts:
 *   - re-ingest the KB from disk (kb/curated, kb/books)
 *   - wipe the KB
 *   - inspect / set / clear the Telegram webhook
 *   - re-seed default Infinity vacancies
 *   - purge old skill_outcomes + self_play_matches
 *   - inspect the userbot send-queue
 *
 * Everything runs synchronously inside the request; the UI just shows a
 * spinner + result. Destructive actions (wipe, delete-webhook, purge)
 * require a second click on a confirm step.
 */

type Result =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "ok"; data: unknown }
  | { kind: "err"; msg: string };

function ResultView({ result }: { result: Result }) {
  if (result.kind === "idle") return null;
  if (result.kind === "running") {
    return <div style={{ color: "var(--text-3)", fontSize: 13 }}>выполняется…</div>;
  }
  if (result.kind === "err") {
    return (
      <div style={{ color: "var(--red, #ef4444)", fontSize: 13, fontFamily: "var(--mono)" }}>
        ошибка: {result.msg}
      </div>
    );
  }
  return (
    <pre
      style={{
        background: "var(--surface-2, #1a1a1a)",
        padding: 8,
        borderRadius: 4,
        fontSize: 12,
        fontFamily: "var(--mono)",
        overflow: "auto",
        maxHeight: 200,
      }}
    >
      {JSON.stringify(result.data, null, 2)}
    </pre>
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
        background: "var(--surface-1, #111)",
        border: "1px solid var(--border, #2a2a2a)",
        borderRadius: 6,
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

// ─── KB ingest from disk ───────────────────────────────────────────────

// Mirror of the whitelist in src/admin/routes/ops.ts. Kept in sync so the
// dropdown only offers what the backend actually accepts — typo'd source
// names get a 400 immediately rather than after submit.
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
      title="Загрузить базу знаний с диска"
      hint="Запускает ingest всех .md / .txt / .pdf под выбранной директорией. Идемпотентно — повторный запуск пропустит уже залитые файлы (SHA-256 dedup). Эквивалент CLI: bun scripts/ingest.ts kb/curated"
    >
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
        <select
          value={source}
          onChange={(e) => setSource(e.target.value as KbIngestSource)}
          disabled={result.kind === "running"}
        >
          <option value="curated">kb/curated/ (ручной FAQ)</option>
          <option value="extracted">kb/extracted/ (посты + диалоги)</option>
          <option value="chats">kb/chats/ (дампы переписок)</option>
          <option value="books">kb/books/ (topic=books)</option>
        </select>
        <button className="btn btn-primary" onClick={run} disabled={result.kind === "running"}>
          Запустить ingest
        </button>
      </div>
      <ResultView result={result} />
    </Card>
  );
}

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
      hint="Удаляет ВСЕ kb_documents + kb_chunks. После — нужно повторно запустить ingest. Эквивалент CLI: bun scripts/kb-wipe.ts"
    >
      {!confirming ? (
        <button className="btn btn-ghost" onClick={() => setConfirming(true)}>
          Очистить…
        </button>
      ) : (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ color: "var(--red, #ef4444)", fontSize: 13 }}>
            Точно удалить все документы?
          </span>
          <button
            style={{ background: "var(--red, #ef4444)", color: "#fff" }}
            className="btn"
            onClick={run}
            disabled={result.kind === "running"}
          >
            Да, очистить
          </button>
          <button className="btn btn-ghost" onClick={() => setConfirming(false)}>
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
    if (!window.confirm("Удалить вебхук? Бот перестанет получать апдейты от Telegram.")) return;
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
      hint="Текущая привязка bot API к публичному URL. Должен быть https. Эквивалент CLI: bun scripts/set-webhook.ts (set / info / delete)"
    >
      {info && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 13, marginBottom: 12 }}>
          <div>
            <span style={{ color: "var(--text-3)" }}>url:</span> {info.url || "(не задан)"}
          </div>
          <div>
            <span style={{ color: "var(--text-3)" }}>pending:</span> {info.pending_update_count}
          </div>
        </div>
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input
          type="url"
          placeholder="https://your-domain/telegram/SECRET"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={busy}
          style={{ flex: 1, minWidth: 280 }}
        />
        <button className="btn btn-primary" onClick={setHook} disabled={busy || !url}>
          Привязать
        </button>
        <button className="btn btn-ghost" onClick={refresh} disabled={busy}>
          Обновить
        </button>
        <button
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

// ─── Maintenance ───────────────────────────────────────────────────────

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
      title="Засеять дефолтные вакансии Infinity"
      hint="Создаёт стартовый набор вакансий из встроенного снимка t.me/infinity_agency_world. Не трогает уже существующие (matching по title). Эквивалент CLI: bun scripts/seed-vacancies-infinity.ts"
    >
      <button className="btn btn-primary" onClick={run} disabled={result.kind === "running"}>
        Засеять
      </button>
      <div style={{ marginTop: 12 }}>
        <ResultView result={result} />
      </div>
    </Card>
  );
}

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
      title="Очистка старых результатов skill / self-play"
      hint="Удаляет skill_outcomes и self_play_matches старше N дней. pairwise / shadow / coach сохраняются (audit trail). Эквивалент CLI: bun scripts/purge-old-outcomes.ts"
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
          className="btn btn-ghost"
          onClick={() => run(true)}
          disabled={result.kind === "running"}
        >
          Сначала dry-run
        </button>
        <button className="btn" onClick={() => run(false)} disabled={result.kind === "running"}>
          Удалить
        </button>
      </div>
      <ResultView result={result} />
    </Card>
  );
}

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
      title="Очередь userbot"
      hint="Сколько админ-ответов ждут отправки через MTProto-аккаунт. Дренажит отдельный процесс userbot (Bun.spawn из index.ts при TELEGRAM_USERBOT=1)."
    >
      {stats && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 13, marginBottom: 12 }}>
          <div>
            <span style={{ color: "var(--text-3)" }}>userbot:</span>{" "}
            {stats.userbot_enabled ? "включён" : "выключен"}
          </div>
          {Object.entries(stats.by_status).length === 0 ? (
            <div style={{ color: "var(--text-3)" }}>(очередь пустая)</div>
          ) : (
            Object.entries(stats.by_status).map(([status, count]) => (
              <div key={status}>
                <span style={{ color: "var(--text-3)" }}>{status}:</span> {count}
              </div>
            ))
          )}
        </div>
      )}
      <button className="btn btn-ghost btn-sm" onClick={refresh}>
        Обновить
      </button>
      {error && (
        <div style={{ color: "var(--red, #ef4444)", fontSize: 13, marginTop: 8 }}>{error}</div>
      )}
    </Card>
  );
}

// ─── Userbot MTProto proxy list ────────────────────────────────────────

interface ProxyRow {
  id: number;
  position: number;
  host: string;
  port: number;
  raw: string;
  last_status: "never_tried" | "ok" | "timeout" | "failed";
  last_tried_at: number | null;
  last_error: string | null;
  last_connect_ms: number | null;
}

function statusEmoji(s: ProxyRow["last_status"]): string {
  switch (s) {
    case "ok":
      return "✅";
    case "timeout":
      return "⏱";
    case "failed":
      return "❌";
    default:
      return "⚪";
  }
}

function relTime(ts: number | null): string {
  if (!ts) return "—";
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return `${diff}с назад`;
  if (diff < 3600) return `${Math.floor(diff / 60)}м назад`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}ч назад`;
  return `${Math.floor(diff / 86400)}д назад`;
}

function UserbotProxiesPanel() {
  const [rows, setRows] = useState<ProxyRow[] | null>(null);
  const [text, setText] = useState("");
  const [saveResult, setSaveResult] = useState<
    | { kind: "idle" }
    | { kind: "saving" }
    | { kind: "ok"; saved: number; invalid_lines: number[] }
    | { kind: "err"; msg: string }
  >({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setError(null);
    try {
      const data = await api.opsListUserbotProxies();
      setRows(data.proxies);
      // Initialize the textarea on first load with what's persisted, so an
      // operator who already pasted a list can edit it rather than start over.
      if (data.proxies.length > 0 && text === "") {
        setText(data.proxies.map((p) => p.raw).join("\n"));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function save() {
    setSaveResult({ kind: "saving" });
    try {
      const data = await api.opsReplaceUserbotProxies(text);
      setSaveResult({ kind: "ok", saved: data.saved, invalid_lines: data.invalid_lines });
      await refresh();
    } catch (err) {
      setSaveResult({ kind: "err", msg: err instanceof Error ? err.message : String(err) });
    }
  }

  async function clearStatuses() {
    setError(null);
    try {
      await api.opsClearUserbotProxyStatuses();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    refresh();
    // Poll every 5s so the operator sees status flip as the userbot
    // subprocess iterates through the list.
    const handle = setInterval(refresh, 5_000);
    return () => clearInterval(handle);
  }, []);

  return (
    <Card
      title="MTProto proxies"
      hint="Список прокси через которые userbot пробует подключиться к Telegram (по порядку, до первого живого). Сохраняется в БД и читается без редеплоя — userbot перечитывает на каждом restart subprocess'a (~раз в 10 минут или сразу когда весь список умер)."
    >
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={`# По одному прокси на строку, любой из форматов:\n# host:port:secret\n# tg://proxy?server=H&port=P&secret=S\n# https://t.me/proxy?server=H&port=P&secret=S\n\nhttps://t.me/proxy?server=...&port=443&secret=dd...`}
        rows={8}
        style={{
          width: "100%",
          fontFamily: "var(--mono)",
          fontSize: 12,
          padding: 8,
          marginBottom: 8,
          resize: "vertical",
        }}
        disabled={saveResult.kind === "saving"}
      />
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button className="btn btn-primary" onClick={save} disabled={saveResult.kind === "saving"}>
          Сохранить и применить
        </button>
        <button className="btn btn-ghost" onClick={clearStatuses}>
          Сбросить статусы
        </button>
      </div>

      {saveResult.kind === "ok" && (
        <div style={{ fontSize: 13, marginBottom: 8 }}>
          Сохранено: {saveResult.saved}.{" "}
          {saveResult.invalid_lines.length > 0 && (
            <span style={{ color: "var(--amber, #f59e0b)" }}>
              Не распарсилось (строки): {saveResult.invalid_lines.join(", ")}
            </span>
          )}
        </div>
      )}
      {saveResult.kind === "err" && (
        <div style={{ color: "var(--red, #ef4444)", fontSize: 13, marginBottom: 8 }}>
          {saveResult.msg}
        </div>
      )}

      {rows && rows.length > 0 && (
        <table style={{ width: "100%", fontSize: 12, fontFamily: "var(--mono)" }}>
          <thead>
            <tr style={{ color: "var(--text-3)", textAlign: "left" }}>
              <th style={{ padding: "4px 6px" }}>#</th>
              <th style={{ padding: "4px 6px" }}>Status</th>
              <th style={{ padding: "4px 6px" }}>Host</th>
              <th style={{ padding: "4px 6px" }}>Port</th>
              <th style={{ padding: "4px 6px" }}>Last tried</th>
              <th style={{ padding: "4px 6px" }}>ms</th>
              <th style={{ padding: "4px 6px" }}>Error</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={{ borderTop: "1px solid var(--border, #2a2a2a)" }}>
                <td style={{ padding: "4px 6px", color: "var(--text-3)" }}>{r.position + 1}</td>
                <td style={{ padding: "4px 6px" }}>
                  {statusEmoji(r.last_status)} {r.last_status}
                </td>
                <td style={{ padding: "4px 6px" }}>{r.host}</td>
                <td style={{ padding: "4px 6px" }}>{r.port}</td>
                <td style={{ padding: "4px 6px", color: "var(--text-3)" }}>
                  {relTime(r.last_tried_at)}
                </td>
                <td style={{ padding: "4px 6px", color: "var(--text-3)" }}>
                  {r.last_connect_ms ?? "—"}
                </td>
                <td
                  style={{
                    padding: "4px 6px",
                    color: "var(--text-3)",
                    maxWidth: 280,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {r.last_error ?? ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows && rows.length === 0 && (
        <div style={{ color: "var(--text-3)", fontSize: 13 }}>
          (список пустой — userbot подключится напрямую или возьмёт значение из USERBOT_MTPROXY_LIST
          в env)
        </div>
      )}
      {error && (
        <div style={{ color: "var(--red, #ef4444)", fontSize: 13, marginTop: 8 }}>{error}</div>
      )}
    </Card>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────

export function Operations() {
  return (
    <div style={{ padding: 24, maxWidth: 900 }}>
      <h2 style={{ marginTop: 0, marginBottom: 4 }}>Операции</h2>
      <div style={{ color: "var(--text-3)", fontSize: 13, marginBottom: 20 }}>
        Регулярные обслуживающие действия. CLI-эквиваленты указаны под каждым блоком.
      </div>

      <h3
        style={{
          fontSize: 12,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          color: "var(--text-3)",
          marginBottom: 8,
        }}
      >
        База знаний
      </h3>
      <KbIngestPanel />
      <KbWipePanel />

      <h3
        style={{
          fontSize: 12,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          color: "var(--text-3)",
          marginTop: 24,
          marginBottom: 8,
        }}
      >
        Telegram
      </h3>
      <TelegramWebhookPanel />

      <h3
        style={{
          fontSize: 12,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          color: "var(--text-3)",
          marginTop: 24,
          marginBottom: 8,
        }}
      >
        Userbot
      </h3>
      <UserbotProxiesPanel />
      <UserbotQueuePanel />

      <h3
        style={{
          fontSize: 12,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          color: "var(--text-3)",
          marginTop: 24,
          marginBottom: 8,
        }}
      >
        Обслуживание
      </h3>
      <ReseedVacanciesPanel />
      <PurgeOutcomesPanel />
    </div>
  );
}

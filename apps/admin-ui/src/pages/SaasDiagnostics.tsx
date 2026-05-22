import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ApiError,
  clearToken,
  type DiagnosticsResult,
  saas,
} from "../api/saas.ts";

/**
 * Diagnostics — health-check setup'а tenant'а. Запускается по кнопке;
 * сервер прогоняет channel/LLM/embed/KB checks и возвращает per-component
 * status. Hover-tooltip показывает latency / error.
 */

const STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  pass: { label: "OK", cls: "diag-pass" },
  warn: { label: "WARN", cls: "diag-warn" },
  fail: { label: "FAIL", cls: "diag-fail" },
  skip: { label: "—", cls: "diag-skip" },
};

const CHECK_LABELS: Record<string, string> = {
  "channel.telegram": "Telegram канал",
  "llm.chat": "LLM (chat)",
  "llm.ping": "LLM live ping",
  "llm.embed": "LLM (embed)",
  tenant_secrets: "Шифрование секретов",
};

export function SaasDiagnostics() {
  const navigate = useNavigate();
  const [result, setResult] = useState<DiagnosticsResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  async function run(live = false) {
    setRunning(true);
    setError("");
    try {
      const res = await saas.runDiagnostics({ live });
      setResult(res);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearToken();
        navigate("/login", { replace: true });
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div>
          <h1>Диагностика</h1>
          <p className="dashboard-sub">
            Проверка что bot setup работает: канал + LLM + KB. Без отправки сообщений.
          </p>
        </div>
        <Link to="/dashboard" className="back-link">
          ← К базе знаний
        </Link>
      </header>

      {error && <div className="dashboard-error">{error}</div>}

      <section className="settings-section">
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => run(false)}
            disabled={running}
            className="diag-run-btn"
          >
            {running ? "Проверяем…" : result ? "Перепроверить" : "Запустить проверку"}
          </button>
          <button
            type="button"
            onClick={() => run(true)}
            disabled={running}
            className="diag-run-btn diag-run-btn-secondary"
            title="Делает реальный LLM-вызов (~1 токен) для проверки connectivity"
          >
            {running ? "Проверяем…" : "Live LLM ping"}
          </button>
        </div>

        {result && (
          <>
            <div className={`diag-summary diag-summary-${result.summary.overall}`}>
              {result.summary.overall === "pass" ? "✓" : result.summary.overall === "warn" ? "⚠" : "✗"}{" "}
              {result.summary.passed} OK
              {result.summary.warned > 0 && `, ${result.summary.warned} WARN`}
              {result.summary.failed > 0 && `, ${result.summary.failed} FAIL`}
              {" из "}
              {result.summary.total}
            </div>
            <ul className="diag-list">
              {result.checks.map((c) => {
                const meta = STATUS_LABELS[c.status] ?? STATUS_LABELS.skip!;
                return (
                  <li key={c.name} className="diag-row">
                    <span className={`diag-badge ${meta.cls}`}>{meta.label}</span>
                    <div className="diag-body">
                      <strong>{CHECK_LABELS[c.name] ?? c.name}</strong>
                      {c.message && <small>{c.message}</small>}
                    </div>
                    {c.latencyMs !== undefined && (
                      <small className="diag-latency">{c.latencyMs}ms</small>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}

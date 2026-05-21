import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ApiError,
  type AuditEntry,
  clearToken,
  saas,
} from "../api/saas.ts";

/**
 * Read-only audit log: показывает кто из admin'ов tenant'а что менял
 * когда. Запись происходит из backend handlers (см. lib/audit.ts).
 *
 * Лимит — 50 записей за page, cursor-based pagination по createdAt.
 */

function fmtTime(epoch: number): string {
  return new Date(epoch * 1000).toLocaleString();
}

function fmtAction(action: string): string {
  // human-readable label для known actions; unknown — as-is.
  const labels: Record<string, string> = {
    "llm_config.create": "Добавлен LLM конфиг",
    "llm_config.update": "Изменён LLM конфиг",
    "llm_config.delete": "Удалён LLM конфиг",
    "channel.create": "Подключён канал",
    "channel.update": "Обновлён канал",
    "channel.delete": "Отключён канал",
    "conversation.reply": "Ответ оператора",
  };
  return labels[action] ?? action;
}

export function SaasAudit() {
  const navigate = useNavigate();
  const [items, setItems] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<number | undefined>(undefined);

  async function loadInitial() {
    try {
      const res = await saas.listAuditLog({ limit: 50 });
      setItems(res.items);
      setNextCursor(res.nextCursor);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearToken();
        navigate("/login", { replace: true });
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const res = await saas.listAuditLog({ limit: 50, cursor: nextCursor });
      setItems((prev) => [...prev, ...res.items]);
      setNextCursor(res.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await loadInitial();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: navigate stable
  }, []);

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
          <h1>Аудит-лог</h1>
          <p className="dashboard-sub">
            Кто из admin'ов что менял. Запись автоматическая (нельзя редактировать).
          </p>
        </div>
        <Link to="/dashboard" className="back-link">
          ← К базе знаний
        </Link>
      </header>

      {error && <div className="dashboard-error">{error}</div>}

      {items.length === 0 ? (
        <p className="empty-state">Пока ничего не происходило</p>
      ) : (
        <ul className="audit-list">
          {items.map((e) => (
            <li key={e.id} className="audit-row">
              <div className="audit-head">
                <strong>{fmtAction(e.action)}</strong>
                <small>{fmtTime(e.createdAt)}</small>
              </div>
              <small className="audit-meta">
                <span className="muted">
                  {e.adminEmail ?? `admin#${e.adminId ?? "?"}`}
                </span>
                {e.targetKind && (
                  <>
                    {" · "}
                    <span className="badge">{e.targetKind}</span>
                  </>
                )}
                {e.targetId && (
                  <>
                    {" · "}
                    <span className="muted">id={e.targetId}</span>
                  </>
                )}
              </small>
              {e.details && (
                <pre className="audit-details">{JSON.stringify(e.details, null, 2)}</pre>
              )}
            </li>
          ))}
        </ul>
      )}

      {nextCursor && (
        <div style={{ marginTop: 16, textAlign: "center" }}>
          <button
            type="button"
            className="nav-link"
            onClick={loadMore}
            disabled={loadingMore}
          >
            {loadingMore ? "Загрузка…" : "Загрузить ещё"}
          </button>
        </div>
      )}
    </div>
  );
}

import { type FormEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  type Admin,
  ApiError,
  clearToken,
  type KbDoc,
  saas,
  type Tenant,
} from "../api/saas.ts";

export function SaasDashboard() {
  const navigate = useNavigate();
  const [admin, setAdmin] = useState<Admin | null>(null);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [docs, setDocs] = useState<KbDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Upload form state
  const [pasteTitle, setPasteTitle] = useState("");
  const [pasteBody, setPasteBody] = useState("");
  const [pasteTopic, setPasteTopic] = useState("");
  const [uploading, setUploading] = useState(false);

  async function refreshDocs() {
    try {
      const list = await saas.listDocs();
      setDocs(list.items);
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
      try {
        const me = await saas.me();
        if (cancelled) return;
        setAdmin(me.admin);
        setTenant(me.tenant);
        await refreshDocs();
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          clearToken();
          navigate("/login", { replace: true });
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: navigate stable
  }, []);

  async function handleLogout() {
    try {
      await saas.logout();
    } catch {
      // ignore
    }
    clearToken();
    navigate("/login", { replace: true });
  }

  async function handlePaste(e: FormEvent) {
    e.preventDefault();
    if (!pasteBody.trim()) return;
    setUploading(true);
    setError("");
    try {
      await saas.uploadJson({
        title: pasteTitle.trim() || "untitled",
        body: pasteBody,
        ...(pasteTopic.trim() ? { topic: pasteTopic.trim() } : {}),
      });
      setPasteTitle("");
      setPasteBody("");
      setPasteTopic("");
      await refreshDocs();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError("");
    try {
      await saas.uploadFile(file);
      await refreshDocs();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }

  async function handleDelete(id: number) {
    if (!confirm("Удалить документ?")) return;
    try {
      await saas.deleteDoc(id);
      await refreshDocs();
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
          <h1>База знаний</h1>
          <p className="dashboard-sub">
            {admin?.email} · {tenant?.slug ?? "—"} · {tenant?.plan ?? "—"}
          </p>
        </div>
        <div className="dashboard-nav">
          <Link to="/channels" className="nav-link">
            Каналы
          </Link>
          <Link to="/settings" className="nav-link">
            Настройки LLM
          </Link>
          <button type="button" onClick={handleLogout}>
            Выйти
          </button>
        </div>
      </header>

      {error && <div className="dashboard-error">{error}</div>}

      <section className="upload-section">
        <h2>Добавить документ</h2>

        <div className="upload-card">
          <h3>Загрузить файл</h3>
          <p className="hint">.txt, .md, .json (PDF — пока вручную через API)</p>
          <input
            type="file"
            accept=".txt,.md,.json"
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
              placeholder="Текст документа..."
              rows={8}
              value={pasteBody}
              onChange={(e) => setPasteBody(e.target.value)}
              required
            />
            <button type="submit" disabled={uploading || !pasteBody.trim()}>
              {uploading ? "Загружаем…" : "Добавить"}
            </button>
          </form>
        </div>
      </section>

      <section className="docs-section">
        <h2>Документы ({docs.length})</h2>
        {docs.length === 0 ? (
          <p className="empty-state">Документов пока нет. Загрузите первый ↑</p>
        ) : (
          <ul className="docs-list">
            {docs.map((d) => (
              <li key={d.id} className="doc-row">
                <div className="doc-meta">
                  <strong>{d.title}</strong>
                  <small>
                    {d.topic && <span className="badge">{d.topic}</span>}{" "}
                    <span className="muted">{d.source}</span>{" "}
                    <span className="muted">
                      · {new Date(d.createdAt * 1000).toLocaleString()}
                    </span>
                  </small>
                </div>
                <button type="button" onClick={() => handleDelete(d.id)}>
                  Удалить
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

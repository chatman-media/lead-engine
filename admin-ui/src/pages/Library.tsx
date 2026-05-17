import { useEffect, useRef, useState } from "react";
import { api, type KbDocument } from "../api.ts";

/**
 * Management page for the book knowledge base (topic="books").
 * Operators upload PDF/TXT/MD files here; the bot uses them as its primary
 * knowledge source when RAG_BOOKS_PRIORITY=true is set in the environment.
 */
export function Library() {
  const [docs, setDocs] = useState<KbDocument[] | null>(null);
  const [totals, setTotals] = useState<{ documents: number; chunks: number } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function refresh() {
    try {
      setError(null);
      const res = await api.kbDocuments({ topic: "books" });
      setDocs(res.documents);
      setTotals(res.totals);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);
    setFlash(null);
    setUploading(true);
    const results: string[] = [];
    for (const file of Array.from(files)) {
      try {
        const r = await api.uploadBook(file);
        results.push(
          r.created
            ? `«${r.filename}» — ${r.chunks} чанков`
            : `«${r.filename}» — уже есть (без изменений)`,
        );
      } catch (err) {
        results.push(
          `«${file.name}» — ошибка: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    setFlash(results.join("\n"));
    setUploading(false);
    refresh();
  }

  async function handleDelete(d: KbDocument) {
    const msg = `Удалить «${d.title}»? Это удалит ${d.chunk_count ?? 0} чанков из векторного индекса.`;
    if (!confirm(msg)) return;
    setError(null);
    try {
      await api.deleteKbDocument(d.id);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
    setDragging(true);
  }
  function onDragLeave() {
    setDragging(false);
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    handleFiles(e.dataTransfer.files);
  }

  return (
    <div style={{ padding: "24px 32px", display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h2 style={{ fontFamily: "var(--mono)", color: "var(--amber)", margin: 0 }}>Library</h2>
        <div
          style={{
            fontSize: 12,
            color: "var(--text-3)",
            marginTop: 4,
            fontFamily: "var(--mono)",
          }}
        >
          {totals ? `${totals.documents} books · ${totals.chunks} chunks indexed` : "загрузка…"}
        </div>
      </div>

      <p style={{ color: "var(--text-3)", fontSize: 12, margin: 0, lineHeight: 1.6 }}>
        Загружайте книги по управлению и манипуляциям (PDF, TXT, MD). Все файлы индексируются с
        тегом <code>books</code>. Включите приоритетный поиск по книгам:{" "}
        <code>RAG_BOOKS_PRIORITY=true</code> в .env — бот будет искать сначала в библиотеке, и лишь
        если ничего не нашёл — во всей KB.
      </p>

      {/* Drop zone */}
      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={() => !uploading && fileInputRef.current?.click()}
        style={{
          border: `2px dashed ${dragging ? "var(--amber)" : "var(--border)"}`,
          borderRadius: "var(--radius)",
          padding: "32px 24px",
          textAlign: "center",
          cursor: uploading ? "default" : "pointer",
          background: dragging ? "var(--bg-1)" : "transparent",
          transition: "border-color 0.15s, background 0.15s",
        }}
        data-testid="library-dropzone"
      >
        <div
          style={{
            fontSize: 13,
            color: uploading ? "var(--amber)" : "var(--text-2)",
            fontFamily: "var(--mono)",
          }}
        >
          {uploading
            ? "загружаю…"
            : dragging
              ? "отпустите файлы"
              : "перетащите PDF/TXT/MD сюда или нажмите для выбора"}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 6 }}>
          Поддерживаются .pdf, .txt, .md · Максимум 50 МБ · Можно несколько файлов
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.txt,.md"
          multiple
          style={{ display: "none" }}
          onChange={(e) => handleFiles(e.target.files)}
          data-testid="library-file-input"
        />
      </div>

      {flash && (
        <div
          style={{
            color: "var(--green, #2ea043)",
            fontFamily: "var(--mono)",
            fontSize: 12,
            padding: "10px 12px",
            border: "1px solid var(--green, #2ea043)",
            borderRadius: "var(--radius)",
            whiteSpace: "pre-wrap",
          }}
          data-testid="library-flash"
        >
          {flash}
        </div>
      )}

      {error && (
        <div
          style={{
            color: "var(--red, #ef4444)",
            fontFamily: "var(--mono)",
            fontSize: 12,
            padding: "10px 12px",
            border: "1px solid var(--red, #ef4444)",
            borderRadius: "var(--radius)",
          }}
          data-testid="library-error"
        >
          {error}
        </div>
      )}

      {docs === null ? (
        <div className="loading-text">загрузка…</div>
      ) : docs.length === 0 ? (
        <EmptyState />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {docs.map((d) => (
            <BookCard key={d.id} doc={d} onDelete={() => handleDelete(d)} />
          ))}
        </div>
      )}
    </div>
  );
}

function BookCard({ doc, onDelete }: { doc: KbDocument; onDelete: () => void }) {
  const ext = doc.title.slice(doc.title.lastIndexOf(".") + 1).toLowerCase();
  const extColor = ext === "pdf" ? "var(--red, #ef4444)" : "var(--amber)";

  return (
    <div
      data-testid="library-book-card"
      style={{
        background: "var(--bg-1)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: "12px 16px",
        display: "flex",
        alignItems: "center",
        gap: 16,
      }}
    >
      <div
        style={{
          fontFamily: "var(--mono)",
          fontSize: 10,
          color: extColor,
          fontWeight: 700,
          textTransform: "uppercase",
          minWidth: 30,
          textAlign: "center",
        }}
      >
        {ext || "?"}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontWeight: 600,
            fontSize: 13,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={doc.title}
        >
          {doc.title}
        </div>
        <div
          style={{
            fontSize: 11,
            color: "var(--text-3)",
            fontFamily: "var(--mono)",
            marginTop: 2,
            display: "flex",
            gap: 10,
          }}
        >
          <span>{doc.chunk_count ?? 0} chunks</span>
          <span>id={doc.id}</span>
          <span>{new Date(doc.created_at * 1000).toLocaleDateString("ru-RU")}</span>
        </div>
      </div>

      <button
        onClick={onDelete}
        className="btn btn-danger btn-sm"
        data-testid="library-book-delete"
      >
        delete
      </button>
    </div>
  );
}

function EmptyState() {
  return (
    <div
      style={{
        border: "1px dashed var(--border)",
        borderRadius: "var(--radius)",
        padding: 24,
        background: "var(--bg-1)",
        color: "var(--text-2)",
        fontSize: 13,
        lineHeight: 1.6,
      }}
    >
      <div
        style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-3)", marginBottom: 8 }}
      >
        библиотека пуста
      </div>
      <div>
        Загрузите первые книги через форму выше или CLI:
        <br />
        <code>bun scripts/ingest-books.ts ./kb/books</code>
      </div>
    </div>
  );
}

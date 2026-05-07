import { useEffect, useState } from "react";
import { api, type KbChunkPreview, type KbDocument } from "../api.ts";

/**
 * Operator-facing KB management. The KB is the slow-changing background
 * layer (visa rules, payment models, …) that gets retrieved into the bot's
 * RAG context. Vacancies live in their own table — see /admin/vacancies.
 *
 * Why this page exists: when an old chat-dump or stale doc is producing
 * hallucinated answers ("вакансий нет, но бот про какую-то рассказывает"),
 * an operator needs to find and remove the offending doc *without* the CLI.
 * That's what this page does — list, search, inspect chunks, re-tag, delete.
 */
export function Kb() {
  const [docs, setDocs] = useState<KbDocument[] | null>(null);
  const [topics, setTopics] = useState<string[]>([]);
  const [totals, setTotals] = useState<{ documents: number; chunks: number } | null>(null);
  const [topicFilter, setTopicFilter] = useState<string | null | undefined>(undefined);
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      setError(null);
      const opts: { topic?: string | null; q?: string } = {};
      if (topicFilter !== undefined) opts.topic = topicFilter;
      if (q.trim()) opts.q = q.trim();
      const res = await api.kbDocuments(opts);
      setDocs(res.documents);
      setTopics(res.topics);
      setTotals(res.totals);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    refresh();
    // Re-run on filter change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicFilter]);

  async function handleDelete(d: KbDocument) {
    const msg =
      `Удалить документ "${d.title}"? Это удалит и все его чанки из векторного индекса. ` +
      `Бот перестанет ссылаться на эти данные начиная со следующего сообщения.`;
    if (!confirm(msg)) return;
    setError(null);
    try {
      await api.deleteKbDocument(d.id);
      if (openId === d.id) setOpenId(null);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRetag(d: KbDocument, nextTopic: string | null) {
    setError(null);
    try {
      await api.updateKbDocument(d.id, { topic: nextTopic });
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div style={{ padding: "24px 32px", display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h2 style={{ fontFamily: "var(--mono)", color: "var(--amber)", margin: 0 }}>
          Knowledge base
        </h2>
        <div
          style={{
            fontSize: 12,
            color: "var(--text-3)",
            marginTop: 4,
            fontFamily: "var(--mono)",
          }}
        >
          {totals ? `${totals.documents} documents · ${totals.chunks} chunks indexed` : "loading…"}
        </div>
      </div>

      <p style={{ color: "var(--text-3)", fontSize: 12, margin: 0, lineHeight: 1.6 }}>
        Документы, которые бот использует как фон для ответов. Удаление чистит и векторный индекс —
        изменения вступают в силу со следующего сообщения кандидата без переиндексации. Тэг (topic)
        сужает поиск: если задан, бот ищет только в этом тэге плюс untagged. Свежие вакансии живут
        отдельно в /admin/vacancies — этот раздел для slowly-changing справочной базы.
      </p>

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <input
          type="text"
          placeholder="search by title or source…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") refresh();
          }}
          className="input"
          style={{ minWidth: 280 }}
          data-testid="kb-search-input"
        />
        <button onClick={refresh} className="btn btn-ghost btn-sm">
          search
        </button>
        <div style={{ flex: 1 }} />
        <TopicFilter topics={topics} value={topicFilter} onChange={setTopicFilter} />
      </div>

      {error && (
        <div
          style={{
            color: "var(--red, #ef4444)",
            fontFamily: "var(--mono)",
            fontSize: 12,
            padding: "8px 12px",
            border: "1px solid var(--red, #ef4444)",
            borderRadius: "var(--radius)",
          }}
        >
          {error}
        </div>
      )}

      {docs === null ? (
        <div className="loading-text">loading…</div>
      ) : docs.length === 0 ? (
        <EmptyState />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {docs.map((d) => (
            <KbDocCard
              key={d.id}
              doc={d}
              isOpen={openId === d.id}
              knownTopics={topics}
              onToggle={() => setOpenId(openId === d.id ? null : d.id)}
              onDelete={() => handleDelete(d)}
              onRetag={(t) => handleRetag(d, t)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TopicFilter({
  topics,
  value,
  onChange,
}: {
  topics: string[];
  value: string | null | undefined;
  onChange: (v: string | null | undefined) => void;
}) {
  // Tri-state: undefined = all, null = untagged-only, string = that topic
  const cur = value === undefined ? "all" : value === null ? "__untagged__" : value;
  return (
    <select
      value={cur}
      onChange={(e) => {
        const v = e.target.value;
        if (v === "all") onChange(undefined);
        else if (v === "__untagged__") onChange(null);
        else onChange(v);
      }}
      className="input"
      style={{ minWidth: 160 }}
      data-testid="kb-topic-filter"
    >
      <option value="all">all topics</option>
      <option value="__untagged__">(untagged only)</option>
      {topics.map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
    </select>
  );
}

/** Strips noisy `file:///abs/path/to/kb/...` prefix so the source column
 *  shows just the file's place inside the KB tree. Falls back to the full
 *  string when no `kb/` segment is found. */
function shortenSource(src: string): string {
  const m = src.match(/\/kb\/(.+)$/);
  if (m) return m[1]!;
  // For non-file sources (URLs, raw paths) drop the protocol if any.
  return src.replace(/^file:\/\//, "");
}

function KbDocCard({
  doc,
  isOpen,
  knownTopics,
  onToggle,
  onDelete,
  onRetag,
}: {
  doc: KbDocument;
  isOpen: boolean;
  knownTopics: string[];
  onToggle: () => void;
  onDelete: () => void;
  onRetag: (topic: string | null) => void;
}) {
  return (
    <div
      data-testid="kb-doc-card"
      style={{
        background: "var(--bg-1)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 12,
        }}
      >
        <button
          onClick={onToggle}
          className="btn btn-ghost btn-sm"
          style={{
            flex: 1,
            minWidth: 0,
            textAlign: "left",
            fontFamily: "var(--sans)",
          }}
          data-testid="kb-doc-toggle"
        >
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
              gap: 12,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            <span>id={doc.id}</span>
            <span
              style={{
                maxWidth: 280,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={doc.source}
            >
              {shortenSource(doc.source)}
            </span>
            <span>{doc.chunk_count ?? 0} chunks</span>
            <span>
              topic:{" "}
              <span
                style={{
                  color:
                    doc.topic === "noise"
                      ? "var(--red, #ef4444)"
                      : doc.topic
                        ? "var(--amber)"
                        : "var(--text-3)",
                }}
              >
                {doc.topic ?? "(untagged)"}
              </span>
            </span>
            <span>{new Date(doc.created_at * 1000).toLocaleDateString("ru-RU")}</span>
          </div>
        </button>
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          <RetagControl current={doc.topic} knownTopics={knownTopics} onSet={onRetag} />
          <button onClick={onDelete} className="btn btn-danger btn-sm" data-testid="kb-doc-delete">
            delete
          </button>
        </div>
      </div>

      {isOpen && <ChunksPane docId={doc.id} />}
    </div>
  );
}

function RetagControl({
  current,
  knownTopics,
  onSet,
}: {
  current: string | null;
  knownTopics: string[];
  onSet: (topic: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(current ?? "");
  if (!editing) {
    return (
      <button
        onClick={() => {
          setVal(current ?? "");
          setEditing(true);
        }}
        className="btn btn-ghost btn-sm"
        data-testid="kb-doc-retag"
      >
        retag
      </button>
    );
  }
  return (
    <div style={{ display: "flex", gap: 4, flexWrap: "wrap", justifyContent: "flex-end" }}>
      <input
        type="text"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        list="kb-known-topics"
        placeholder="topic (empty = untagged)"
        className="input"
        style={{ width: 140, fontSize: 12 }}
      />
      <datalist id="kb-known-topics">
        {knownTopics.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <button
        onClick={() => {
          onSet(val.trim() ? val.trim() : null);
          setEditing(false);
        }}
        className="btn btn-primary btn-sm"
      >
        save
      </button>
      <button onClick={() => setEditing(false)} className="btn btn-ghost btn-sm">
        cancel
      </button>
    </div>
  );
}

function ChunksPane({ docId }: { docId: number }) {
  const [chunks, setChunks] = useState<KbChunkPreview[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setChunks(null);
    api
      .kbDocument(docId)
      .then((res) => setChunks(res.chunks))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [docId]);

  if (error) {
    return (
      <div
        style={{
          marginTop: 12,
          color: "var(--red, #ef4444)",
          fontFamily: "var(--mono)",
          fontSize: 12,
        }}
      >
        {error}
      </div>
    );
  }
  if (chunks === null) {
    return (
      <div className="loading-text" style={{ marginTop: 12 }}>
        loading chunks…
      </div>
    );
  }
  return (
    <div
      style={{
        marginTop: 12,
        borderTop: "1px solid var(--border)",
        paddingTop: 12,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      {chunks.map((c) => (
        <div
          key={c.id}
          style={{
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: 10,
          }}
        >
          <div
            style={{
              fontSize: 11,
              color: "var(--text-3)",
              fontFamily: "var(--mono)",
              marginBottom: 6,
              display: "flex",
              gap: 12,
            }}
          >
            <span>chunk #{c.chunk_index}</span>
            <span>id={c.id}</span>
            <span>{c.token_count} tokens</span>
          </div>
          <div
            style={{
              fontSize: 12,
              color: "var(--text-2)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              lineHeight: 1.5,
            }}
          >
            {c.text}
          </div>
        </div>
      ))}
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
        ничего не найдено
      </div>
      <div>
        Под выбранный фильтр документов нет. KB наполняется через CLI (
        <code>bun run scripts/ingest-kb.ts</code>); этот раздел только для управления уже
        проиндексированными данными.
      </div>
    </div>
  );
}

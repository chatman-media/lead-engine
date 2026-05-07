import { useEffect, useState } from "react";
import { api, type UserMemory } from "../api.ts";

/**
 * Editable view of a user's cross-session memory facts. Operators use this
 * to correct LLM extraction mistakes — facts saved here REPLACE stored
 * memory wholesale (no merge), then the next bot turn picks them up.
 *
 * Shape contract: keys are short snake_case strings ("city", "age", …),
 * values are short free-form strings. We don't validate the keyspace
 * because the extractor itself uses an open vocabulary.
 */
export function MemoryPane({
  userId,
  initialMemory,
  onSaved,
}: {
  userId: number;
  initialMemory: UserMemory;
  onSaved?: (next: UserMemory) => void;
}) {
  const [collapsed, setCollapsed] = useState(true);
  // Stored as ordered tuples so editing a key doesn't reorder the row.
  const [rows, setRows] = useState<Array<{ key: string; value: string }>>([]);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    setRows(
      Object.entries(initialMemory.facts ?? {}).map(([key, value]) => ({
        key,
        value,
      })),
    );
    setSavedAt(initialMemory.updatedAt ?? null);
  }, [userId, initialMemory]);

  function setRow(i: number, patch: Partial<{ key: string; value: string }>) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  function removeRow(i: number) {
    setRows((rs) => rs.filter((_, idx) => idx !== i));
  }

  function addRow() {
    setRows((rs) => [...rs, { key: "", value: "" }]);
  }

  async function save() {
    // Collapse rows into the {key:value} dict the API expects.
    // Empty keys/values are dropped server-side too, but we filter here so
    // the UI shows the cleaned result without a re-fetch.
    const facts: Record<string, string> = {};
    for (const r of rows) {
      const k = r.key.trim();
      const v = r.value.trim();
      if (!k || !v) continue;
      facts[k] = v;
    }
    setSaving(true);
    try {
      const { memory } = await api.updateUserMemory(userId, facts);
      setRows(
        Object.entries(memory.facts ?? {}).map(([key, value]) => ({
          key,
          value,
        })),
      );
      setSavedAt(memory.updatedAt ?? Math.floor(Date.now() / 1000));
      onSaved?.(memory);
    } finally {
      setSaving(false);
    }
  }

  const factCount = rows.filter((r) => r.key.trim() && r.value.trim()).length;

  return (
    <div
      data-testid="memory-pane"
      style={{
        borderBottom: "1px solid var(--border)",
        background: "var(--bg-1)",
        flexShrink: 0,
      }}
    >
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        data-testid="memory-toggle"
        style={{
          width: "100%",
          padding: "10px 24px",
          background: "transparent",
          border: "none",
          borderTop: "1px solid var(--border)",
          color: "var(--text-3)",
          fontFamily: "var(--mono)",
          fontSize: 11,
          letterSpacing: "0.06em",
          textAlign: "left",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span style={{ width: 10, display: "inline-block" }}>{collapsed ? "▸" : "▾"}</span>
        <span>MEMORY</span>
        <span style={{ color: "var(--text)", fontWeight: 600 }}>{factCount}</span>
        {savedAt !== null && (
          <span style={{ marginLeft: "auto", fontSize: 10 }}>
            updated {new Date(savedAt * 1000).toLocaleString("ru-RU")}
          </span>
        )}
      </button>

      {!collapsed && (
        <div
          style={{
            padding: "8px 24px 14px",
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          {rows.length === 0 && (
            <div
              style={{
                fontFamily: "var(--mono)",
                fontSize: 11,
                color: "var(--text-3)",
                padding: "6px 0",
              }}
            >
              no facts stored yet — extractor adds them as the candidate volunteers info
            </div>
          )}

          {rows.map((r, i) => (
            <div
              key={i}
              data-testid="memory-row"
              style={{ display: "flex", gap: 6, alignItems: "center" }}
            >
              <input
                value={r.key}
                onChange={(e) => setRow(i, { key: e.target.value })}
                placeholder="key (e.g. city)"
                data-testid="memory-key-input"
                style={{
                  width: 140,
                  background: "var(--bg-2)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  padding: "6px 8px",
                  fontFamily: "var(--mono)",
                  fontSize: 12,
                  color: "var(--text)",
                  outline: "none",
                }}
              />
              <input
                value={r.value}
                onChange={(e) => setRow(i, { value: e.target.value })}
                placeholder="value"
                data-testid="memory-value-input"
                style={{
                  flex: 1,
                  background: "var(--bg-2)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  padding: "6px 8px",
                  fontFamily: "var(--mono)",
                  fontSize: 12,
                  color: "var(--text)",
                  outline: "none",
                }}
              />
              <button
                type="button"
                onClick={() => removeRow(i)}
                data-testid="memory-remove-row"
                title="Remove"
                style={{
                  padding: "5px 10px",
                  background: "transparent",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  color: "var(--text-3)",
                  fontFamily: "var(--mono)",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                ×
              </button>
            </div>
          ))}

          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <button
              type="button"
              onClick={addRow}
              data-testid="memory-add-row"
              style={{
                padding: "5px 12px",
                background: "transparent",
                border: "1px dashed var(--border)",
                borderRadius: "var(--radius)",
                color: "var(--text-3)",
                fontFamily: "var(--mono)",
                fontSize: 11,
                letterSpacing: "0.05em",
                cursor: "pointer",
              }}
            >
              + ADD FACT
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving}
              data-testid="memory-save"
              style={{
                marginLeft: "auto",
                padding: "5px 14px",
                background: saving ? "var(--bg-3)" : "var(--amber)",
                color: saving ? "var(--text-3)" : "#000",
                border: "none",
                borderRadius: "var(--radius)",
                fontFamily: "var(--mono)",
                fontWeight: 600,
                fontSize: 11,
                letterSpacing: "0.06em",
                cursor: saving ? "default" : "pointer",
              }}
            >
              {saving ? "SAVING…" : "SAVE"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

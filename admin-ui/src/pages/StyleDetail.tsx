import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, api, type StyleDetail as StyleDetailT } from "../api.ts";

export function StyleDetail() {
  const { id } = useParams();
  const [style, setStyle] = useState<StyleDetailT | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function load(styleId: number) {
    setError(null);
    api
      .style(styleId)
      .then((res) => {
        setStyle(res.style);
        setDraft(JSON.stringify(res.style.config, null, 2));
      })
      .catch((err) => setError(err.message ?? String(err)));
  }

  useEffect(() => {
    if (!id) return;
    load(Number(id));
  }, [id]);

  // Live JSON validation while typing — surface parse errors before the user
  // bothers clicking save. The Zod check happens server-side; this only
  // catches "is it valid JSON".
  let draftParseError: string | null = null;
  if (editing) {
    try {
      JSON.parse(draft);
    } catch (err) {
      draftParseError = err instanceof Error ? err.message : String(err);
    }
  }

  async function handleSave() {
    if (!style || !id) return;
    setSaveError(null);
    setSaving(true);
    try {
      const config = JSON.parse(draft);
      const res = await api.editStyle(Number(id), config);
      // Navigate to the new version's id — the URL was for the now-historical row.
      window.history.replaceState(null, "", `/admin/styles/${res.style.id}`);
      setStyle(res.style);
      setDraft(JSON.stringify(res.style.config, null, 2));
      setEditing(false);
    } catch (err) {
      if (err instanceof ApiError) {
        const issues = (err as unknown as { issues?: Array<{ path: string; message: string }> }).issues;
        if (issues && issues.length > 0) {
          setSaveError(
            `Schema errors:\n${issues.map((i) => `  ${i.path}: ${i.message}`).join("\n")}`,
          );
        } else {
          setSaveError(err.message);
        }
      } else {
        setSaveError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ padding: "24px 32px" }}>
      <Link
        to="/admin/styles"
        style={{ color: "var(--text-3)", fontSize: 12, textDecoration: "none" }}
      >
        ← styles
      </Link>

      {error ? (
        <div style={{ color: "var(--red, #f55)", marginTop: 16 }}>
          error: {error}
        </div>
      ) : style === null ? (
        <div style={{ color: "var(--text-3)", marginTop: 16 }}>loading…</div>
      ) : (
        <>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginTop: 12,
              marginBottom: 16,
            }}
          >
            <div>
              <h2
                style={{
                  fontFamily: "var(--mono)",
                  color: "var(--amber)",
                  margin: 0,
                }}
              >
                {style.slug}
              </h2>
              <div
                style={{
                  color: "var(--text-2)",
                  fontSize: 14,
                  marginTop: 4,
                }}
              >
                {style.display_name}
                <span
                  style={{
                    marginLeft: 12,
                    color: "var(--text-3)",
                    fontFamily: "var(--mono)",
                    fontSize: 12,
                  }}
                >
                  v{style.version} · id={style.id}
                  {!style.is_active ? " · historical" : ""}
                </span>
              </div>
            </div>

            {style.is_active && !style.parse_error ? (
              <div style={{ display: "flex", gap: 8 }}>
                {editing ? (
                  <>
                    <button
                      onClick={() => {
                        setEditing(false);
                        setSaveError(null);
                        setDraft(JSON.stringify(style.config, null, 2));
                      }}
                      style={btnStyle()}
                    >
                      cancel
                    </button>
                    <button
                      onClick={handleSave}
                      disabled={saving || draftParseError !== null}
                      style={{
                        ...btnStyle(),
                        opacity: saving || draftParseError !== null ? 0.4 : 1,
                        cursor:
                          saving || draftParseError !== null ? "default" : "pointer",
                      }}
                    >
                      {saving ? "saving…" : "save as v" + (style.version + 1)}
                    </button>
                  </>
                ) : (
                  <button onClick={() => setEditing(true)} style={btnStyle()}>
                    edit
                  </button>
                )}
              </div>
            ) : null}
          </div>

          {saveError ? (
            <pre
              style={{
                background: "var(--bg-1)",
                border: "1px solid var(--red, #f55)",
                color: "var(--red, #f55)",
                padding: 12,
                borderRadius: "var(--radius)",
                fontSize: 12,
                whiteSpace: "pre-wrap",
                marginBottom: 12,
              }}
            >
              {saveError}
            </pre>
          ) : null}

          {style.parse_error ? (
            <pre
              style={{
                background: "var(--bg-1)",
                border: "1px solid var(--red, #f55)",
                color: "var(--red, #f55)",
                padding: 12,
                borderRadius: "var(--radius)",
                fontSize: 12,
                whiteSpace: "pre-wrap",
              }}
            >
              {`Zod validation failed:\n${style.parse_error}\n\nRaw JSON:\n${style.config_raw}`}
            </pre>
          ) : editing ? (
            <>
              {draftParseError ? (
                <div
                  style={{
                    color: "var(--red, #f55)",
                    fontFamily: "var(--mono)",
                    fontSize: 12,
                    marginBottom: 8,
                  }}
                >
                  JSON parse error: {draftParseError}
                </div>
              ) : (
                <div
                  style={{
                    color: "var(--text-3)",
                    fontFamily: "var(--mono)",
                    fontSize: 11,
                    marginBottom: 8,
                  }}
                >
                  Saving creates v{style.version + 1}. The current version stays
                  in the DB so any conversation already pinned to it keeps the
                  original prompt.
                </div>
              )}
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                style={{
                  width: "100%",
                  minHeight: "60vh",
                  background: "var(--bg-1)",
                  border: `1px solid ${
                    draftParseError ? "var(--red, #f55)" : "var(--border)"
                  }`,
                  color: "var(--text)",
                  padding: 12,
                  borderRadius: "var(--radius)",
                  fontSize: 12,
                  fontFamily: "var(--mono)",
                  resize: "vertical",
                }}
              />
            </>
          ) : (
            <pre
              style={{
                background: "var(--bg-1)",
                border: "1px solid var(--border)",
                color: "var(--text)",
                padding: 16,
                borderRadius: "var(--radius)",
                fontSize: 12,
                fontFamily: "var(--mono)",
                whiteSpace: "pre-wrap",
                overflow: "auto",
                maxHeight: "70vh",
              }}
            >
              {JSON.stringify(style.config, null, 2)}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

function btnStyle(): React.CSSProperties {
  return {
    padding: "6px 12px",
    background: "transparent",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    color: "var(--text-2)",
    fontSize: 12,
    fontFamily: "var(--mono)",
    cursor: "pointer",
  };
}

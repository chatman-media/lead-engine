import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ApiError, api, type StyleDetail } from "../api.ts";

/**
 * Create a new sales style by cloning an existing one as a starting template.
 * The operator picks a source style via the `?from=<slug>` query param (set
 * from the dropdown on /admin/styles), the page fetches that style's full
 * config, replaces the slug with a placeholder, and drops the operator into
 * the JSON editor. Save → POST → redirect to the new style's detail page.
 *
 * Cloning instead of "blank slate" because the Style schema is rich (persona,
 * voice, framework, hooks, 5 stages, few-shot, guardrails, model) and getting
 * it right from scratch is error-prone. Editing a known-good template is the
 * fast path.
 */
export function NewStyle() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const fromSlug = params.get("from");

  const [draft, setDraft] = useState<string | null>(null);
  const [originalSlug, setOriginalSlug] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!fromSlug) {
      setLoadError(
        "no template specified — go back to /admin/styles and pick one in the 'Clone from' dropdown.",
      );
      return;
    }
    api
      .styles()
      .then(({ styles }) => {
        const tpl = styles.find((s) => s.slug === fromSlug);
        if (!tpl) {
          setLoadError(`template "${fromSlug}" not found`);
          return;
        }
        return api.style(tpl.id);
      })
      .then((res) => {
        if (!res) return;
        const cloned = cloneAsNewStyle(res.style);
        setOriginalSlug(res.style.slug);
        setDraft(JSON.stringify(cloned, null, 2));
      })
      .catch((err) => setLoadError(err.message ?? String(err)));
  }, [fromSlug]);

  // Live JSON validation while typing.
  let parseError: string | null = null;
  if (draft !== null) {
    try {
      JSON.parse(draft);
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err);
    }
  }

  async function handleSave() {
    if (draft === null) return;
    setSaveError(null);
    setSaving(true);
    try {
      const config = JSON.parse(draft);
      const res = await api.createStyle(config);
      navigate(`/admin/styles/${res.style.id}`, { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        const issues = (
          err as unknown as {
            issues?: Array<{ path: string; message: string }>;
          }
        ).issues;
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
              fontFamily: "var(--display)",
              color: "var(--text)",
              margin: 0,
            }}
          >
            new style
          </h2>
          {originalSlug ? (
            <div
              style={{
                color: "var(--text-3)",
                fontFamily: "var(--mono)",
                fontSize: 12,
                marginTop: 4,
              }}
            >
              cloned from <span style={{ color: "var(--text-2)" }}>{originalSlug}</span>
              <span style={{ marginLeft: 8 }}>
                — change slug + displayName + persona, then save.
              </span>
            </div>
          ) : null}
        </div>

        {draft !== null ? (
          <button
            onClick={handleSave}
            disabled={saving || parseError !== null}
            style={{
              padding: "6px 14px",
              background: "var(--amber)",
              border: "none",
              borderRadius: "var(--radius)",
              color: "var(--bg)",
              fontFamily: "var(--mono)",
              fontSize: 12,
              fontWeight: 600,
              cursor: saving || parseError !== null ? "default" : "pointer",
              opacity: saving || parseError !== null ? 0.4 : 1,
            }}
          >
            {saving ? "creating…" : "create style"}
          </button>
        ) : null}
      </div>

      {loadError ? (
        <div style={{ color: "var(--red, #f55)" }}>error: {loadError}</div>
      ) : draft === null ? (
        <div style={{ color: "var(--text-3)" }}>загрузка шаблона…</div>
      ) : (
        <>
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

          {parseError ? (
            <div
              style={{
                color: "var(--red, #f55)",
                fontFamily: "var(--mono)",
                fontSize: 12,
                marginBottom: 8,
              }}
            >
              JSON parse error: {parseError}
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
              The placeholder slug below ends in <code>-clone</code> — change it to your real slug
              (kebab-case). Slug must be unique among active styles. Server-side Zod validation will
              catch shape issues before insert.
            </div>
          )}

          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            style={{
              width: "100%",
              minHeight: "70vh",
              background: "var(--bg-1)",
              border: `1px solid ${parseError ? "var(--red, #f55)" : "var(--border)"}`,
              color: "var(--text)",
              padding: 12,
              borderRadius: "var(--radius)",
              fontSize: 12,
              fontFamily: "var(--mono)",
              resize: "vertical",
            }}
          />
        </>
      )}
    </div>
  );
}

/**
 * Build a "fresh" template from an existing style: clear the slug to a
 * placeholder, prefix the displayName with "[clone]" so the operator
 * notices it's untouched. Everything else (persona, voice, hooks, stages,
 * few-shot, guardrails, model) is kept verbatim.
 */
function cloneAsNewStyle(source: StyleDetail): unknown {
  const config =
    source.config && typeof source.config === "object"
      ? structuredClone(source.config)
      : JSON.parse(source.config_raw);
  if (typeof config === "object" && config !== null) {
    const c = config as Record<string, unknown>;
    c.slug = `${source.slug}-clone`;
    c.displayName = `[clone] ${source.display_name}`;
  }
  return config;
}

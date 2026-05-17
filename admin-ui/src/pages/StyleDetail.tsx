import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ApiError,
  api,
  type PlaygroundResult,
  type SkillDto,
  type StyleDetail as StyleDetailT,
} from "../api.ts";

const FUNNEL_STAGES = ["auto", "opener", "qualify", "pitch", "objection", "close"] as const;

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
        const issues = (err as unknown as { issues?: Array<{ path: string; message: string }> })
          .issues;
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
        <div style={{ color: "var(--red, #f55)", marginTop: 16 }}>error: {error}</div>
      ) : style === null ? (
        <div style={{ color: "var(--text-3)", marginTop: 16 }}>загрузка…</div>
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
                        cursor: saving || draftParseError !== null ? "default" : "pointer",
                      }}
                    >
                      {saving ? "saving…" : `save as v${style.version + 1}`}
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
                  Saving creates v{style.version + 1}. The current version stays in the DB so any
                  conversation already pinned to it keeps the original prompt.
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
                  border: `1px solid ${draftParseError ? "var(--red, #f55)" : "var(--border)"}`,
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

          {style.is_active && !style.parse_error && !editing ? (
            <>
              <SkillsPicker styleId={style.id} />
              <Playground styleId={style.id} />
            </>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * Test the style against a sample prospect message — no DB writes, no
 * Telegram traffic. Shows the auto-detected stage, the KB hits that would
 * have been injected, the full composed system prompt, and the LLM reply.
 *
 * The "save and pray" antidote: edit JSON, click Run, see what comes back
 * BEFORE versioning the row.
 */
function Playground({ styleId }: { styleId: number }) {
  const [open, setOpen] = useState(false);
  const [userMessage, setUserMessage] = useState("сколько в Дубае платят?");
  const [stage, setStage] = useState<(typeof FUNNEL_STAGES)[number]>("auto");
  const [useKb, setUseKb] = useState(true);
  const [dropFewShot, setDropFewShot] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<PlaygroundResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setError(null);
    setResult(null);
    setRunning(true);
    try {
      const res = await api.playgroundStyle(styleId, {
        userMessage,
        ...(stage !== "auto" ? { stage } : {}),
        useKb,
        dropFewShot,
      });
      setResult(res);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div
      style={{
        marginTop: 24,
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        background: "var(--bg-1)",
      }}
    >
      <button
        onClick={() => setOpen((s) => !s)}
        style={{
          width: "100%",
          padding: "12px 16px",
          background: "transparent",
          border: "none",
          borderBottom: open ? "1px solid var(--border)" : "none",
          color: "var(--amber)",
          fontFamily: "var(--mono)",
          fontSize: 13,
          textAlign: "left",
          cursor: "pointer",
        }}
      >
        {open ? "▾" : "▸"} Playground — test this style against a sample message
      </button>

      {open ? (
        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          <label
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
              fontSize: 12,
              color: "var(--text-3)",
            }}
          >
            prospect message
            <textarea
              value={userMessage}
              onChange={(e) => setUserMessage(e.target.value)}
              rows={2}
              style={{
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius)",
                color: "var(--text)",
                padding: "6px 10px",
                fontSize: 13,
                fontFamily: "var(--mono)",
                resize: "vertical",
              }}
            />
          </label>

          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <label
              style={{
                display: "flex",
                gap: 6,
                alignItems: "center",
                fontSize: 12,
                color: "var(--text-3)",
              }}
            >
              stage
              <select
                value={stage}
                onChange={(e) => setStage(e.target.value as (typeof FUNNEL_STAGES)[number])}
                style={{
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  color: "var(--text)",
                  padding: "4px 8px",
                  fontSize: 12,
                  fontFamily: "var(--mono)",
                }}
              >
                {FUNNEL_STAGES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>

            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
              <input type="checkbox" checked={useKb} onChange={(e) => setUseKb(e.target.checked)} />
              <span style={{ color: "var(--text-3)" }}>inject KB context</span>
            </label>

            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
              <input
                type="checkbox"
                checked={dropFewShot}
                onChange={(e) => setDropFewShot(e.target.checked)}
              />
              <span style={{ color: "var(--text-3)" }}>drop few-shot (turn-2+ mode)</span>
            </label>

            <button
              onClick={run}
              disabled={running || !userMessage.trim()}
              style={{
                padding: "6px 14px",
                background: "var(--amber)",
                border: "none",
                borderRadius: "var(--radius)",
                color: "var(--bg)",
                fontFamily: "var(--mono)",
                fontSize: 12,
                fontWeight: 600,
                cursor: running || !userMessage.trim() ? "default" : "pointer",
                opacity: running || !userMessage.trim() ? 0.4 : 1,
                marginLeft: "auto",
              }}
            >
              {running ? "running…" : "Run"}
            </button>
          </div>

          {error ? (
            <pre
              style={{
                background: "var(--bg)",
                border: "1px solid var(--red, #f55)",
                color: "var(--red, #f55)",
                padding: 12,
                borderRadius: "var(--radius)",
                fontSize: 12,
                whiteSpace: "pre-wrap",
              }}
            >
              {error}
            </pre>
          ) : null}

          {result ? <PlaygroundResultView result={result} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function PlaygroundResultView({ result }: { result: PlaygroundResult }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 4 }}>
      <div
        style={{
          fontSize: 11,
          color: "var(--text-3)",
          fontFamily: "var(--mono)",
        }}
      >
        stage={result.stage} ({result.stage_source}) · model={result.model.id} · T=
        {result.model.temperature} · kb_hits={result.kb_hits.length} · dur=
        {result.duration_ms}ms
      </div>

      <Section title="reply">
        <div
          style={{
            background: "var(--bg)",
            border: "1px solid var(--amber)",
            borderRadius: "var(--radius)",
            padding: 12,
            color: "var(--text)",
            fontSize: 14,
            whiteSpace: "pre-wrap",
          }}
        >
          {result.reply}
        </div>
      </Section>

      {result.kb_hits.length > 0 ? (
        <Section title={`kb hits (${result.kb_hits.length})`}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {result.kb_hits.map((h, i) => (
              <div
                key={h.chunk_id}
                style={{
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  padding: 8,
                  fontSize: 12,
                  fontFamily: "var(--mono)",
                }}
              >
                <div style={{ color: "var(--text-3)", fontSize: 11 }}>
                  [#{i + 1}] {h.title} · distance={h.distance.toFixed(3)}
                </div>
                <div style={{ color: "var(--text)", marginTop: 4 }}>{h.text}</div>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      <Section title="composed system prompt">
        <pre
          style={{
            background: "var(--bg)",
            border: "1px solid var(--border)",
            color: "var(--text-2)",
            padding: 12,
            borderRadius: "var(--radius)",
            fontSize: 11,
            fontFamily: "var(--mono)",
            whiteSpace: "pre-wrap",
            maxHeight: 300,
            overflow: "auto",
          }}
        >
          {result.system_prompt}
        </pre>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        style={{
          fontSize: 11,
          color: "var(--text-3)",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          marginBottom: 4,
        }}
      >
        {title}
      </div>
      {children}
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

/**
 * Per-style skill attachment picker. Loads the full catalogue + the
 * style's currently-attached set, lets the operator toggle skills, and
 * persists with PUT /admin/api/styles/:id/skills. "Dirty" state is
 * surfaced explicitly with a save button — checkbox clicks don't auto-
 * persist, to avoid surprise prompt regressions when scrolling fast.
 */
function SkillsPicker({ styleId }: { styleId: number }) {
  const [open, setOpen] = useState(false);
  const [catalogue, setCatalogue] = useState<SkillDto[] | null>(null);
  const [attached, setAttached] = useState<Set<string>>(new Set());
  const [pristine, setPristine] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.skills(), api.styleSkills(styleId)])
      .then(([cat, mine]) => {
        if (cancelled) return;
        setCatalogue(cat.skills);
        const set = new Set(mine.slugs);
        setAttached(set);
        setPristine(new Set(set));
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [styleId]);

  const dirty =
    catalogue != null &&
    (attached.size !== pristine.size || [...attached].some((s) => !pristine.has(s)));

  function toggle(slug: string) {
    setAttached((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.setStyleSkills(styleId, [...attached]);
      setPristine(new Set(attached));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  // Group by family for readable browsing.
  const grouped = (() => {
    if (!catalogue) return [];
    const fams: SkillDto["family"][] = ["cialdini", "voss", "nlp", "sales", "custom"];
    return fams
      .map((f) => ({
        family: f,
        skills: catalogue.filter((s) => s.family === f && s.is_enabled),
      }))
      .filter((g) => g.skills.length > 0);
  })();

  return (
    <section
      style={{
        marginTop: 24,
        background: "var(--bg-1)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: 16,
      }}
    >
      <button
        onClick={() => setOpen((s) => !s)}
        style={{
          width: "100%",
          textAlign: "left",
          background: "none",
          border: "none",
          color: "var(--text)",
          fontFamily: "var(--mono)",
          fontSize: 13,
          cursor: "pointer",
          padding: 0,
        }}
        data-testid="skills-picker-toggle"
      >
        {open ? "▾" : "▸"} Persuasion skills — {attached.size} attached
        {dirty && !saving && (
          <span style={{ color: "var(--amber, #d97706)", marginLeft: 8 }}>(unsaved)</span>
        )}
      </button>

      {open && (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: 12, color: "var(--text-3)", lineHeight: 1.5 }}>
            Выбранные приёмы добавляются в system prompt этого стиля. Описание и текст приёма — на
            странице <code>/admin/skills</code>.
          </div>

          {error && (
            <div
              style={{
                color: "var(--red, #ef4444)",
                fontFamily: "var(--mono)",
                fontSize: 12,
              }}
            >
              {error}
            </div>
          )}

          {!catalogue && <div className="loading-text">загрузка каталога…</div>}

          {grouped.map(({ family, skills }) => (
            <div key={family}>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--text-3)",
                  fontFamily: "var(--mono)",
                  textTransform: "uppercase",
                  letterSpacing: 1,
                  marginBottom: 4,
                }}
              >
                {family}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {skills.map((s) => {
                  const on = attached.has(s.slug);
                  return (
                    <button
                      key={s.slug}
                      onClick={() => toggle(s.slug)}
                      title={s.description}
                      data-testid={`skill-chip-${s.slug}`}
                      style={{
                        padding: "4px 10px",
                        borderRadius: 999,
                        border: `1px solid ${on ? "var(--amber, #d97706)" : "var(--border)"}`,
                        background: on ? "var(--amber, #d97706)" : "transparent",
                        color: on ? "var(--bg)" : "var(--text-2)",
                        fontFamily: "var(--mono)",
                        fontSize: 11,
                        cursor: "pointer",
                      }}
                    >
                      {on ? "✓ " : ""}
                      {s.display_name}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button
              onClick={save}
              disabled={!dirty || saving}
              className="btn btn-primary btn-sm"
              data-testid="skills-picker-save"
              style={{ opacity: !dirty || saving ? 0.5 : 1 }}
            >
              {saving ? "saving…" : `save (${attached.size} skills)`}
            </button>
            {dirty && (
              <button
                onClick={() => setAttached(new Set(pristine))}
                className="btn btn-ghost btn-sm"
              >
                revert
              </button>
            )}
            <AutoSuggestButton onPick={(slugs) => setAttached(new Set(slugs))} />
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * Data-driven shortcut: pick the skill set the recommender suggests
 * (Wilson lower-bound on win-rate). When no outcomes have been
 * collected yet, the button explains the empty state instead of
 * silently producing a random pick.
 *
 * On click it calls /admin/api/skills/recommend, replaces the picker's
 * `attached` set with the recommended slugs, and bumps the dirty flag
 * so the operator can review and `save` to persist.
 */
function AutoSuggestButton({ onPick }: { onPick: (slugs: string[]) => void }) {
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function suggest() {
    setBusy(true);
    setInfo(null);
    setError(null);
    try {
      const res = await api.recommendSkills();
      const recommended = res.recommendations.filter((r) => r.recommended);
      if (res.total_outcomes === 0) {
        setError(
          "Нет данных для рекомендаций — запусти self-play или собери реальные исходы. Без статистики я просто угадаю.",
        );
        return;
      }
      if (recommended.length === 0) {
        setError(
          `Из ${res.total_outcomes} исходов ни один скилл не превысил порог уверенности (Wilson lb ≥ ${res.params.accept}, ≥${res.params.minSamples} samples). Попробуй больше матчей или снизь требования.`,
        );
        return;
      }
      onPick(recommended.map((r) => r.slug));
      const families = new Set(recommended.map((r) => r.family));
      setInfo(
        `Подобрано ${recommended.length} скилов из ${[...families].join(", ")} (Wilson lb ≥ ${res.params.accept}, на ${res.total_outcomes} исходах).`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        onClick={suggest}
        disabled={busy}
        className="btn btn-ghost btn-sm"
        title="Автовыбор по win-rate (Wilson lower bound)"
        data-testid="skills-picker-suggest"
      >
        {busy ? "thinking…" : "✨ auto-select from data"}
      </button>
      {info && (
        <span style={{ fontSize: 11, color: "var(--green, #2ea043)", fontFamily: "var(--mono)" }}>
          {info}
        </span>
      )}
      {error && (
        <span style={{ fontSize: 11, color: "var(--amber, #d97706)", fontFamily: "var(--mono)" }}>
          {error}
        </span>
      )}
    </>
  );
}

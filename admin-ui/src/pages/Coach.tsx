import { useEffect, useMemo, useState } from "react";
import {
  api,
  type CoachProposalDetail,
  type CoachProposalRow,
  type CoachProposalStatus,
  type SelfPlayPersona,
  type ShadowEvalRow,
} from "../api.ts";
import { confirmDialog } from "../components/Dialogs.tsx";

const STATUS_COLOR: Record<CoachProposalStatus, string> = {
  pending: "var(--amber, #d97706)",
  applied: "var(--green, #2ea043)",
  dismissed: "var(--text-3)",
};

/**
 * Coach proposals browser. Operator workflow:
 *   1. Pick a style + sample size in the "Run coach" panel → POST /run
 *   2. Review the freshly-generated proposal (summary + edits + rationale)
 *   3. Mark as "Applied" (after editing style.json by hand) or "Dismissed"
 *
 * Pending proposals get an amber badge in the sidebar nav so they're not
 * forgotten.
 */
export function Coach() {
  const [proposals, setProposals] = useState<CoachProposalRow[] | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [styles, setStyles] = useState<Array<{ slug: string; display_name: string }>>([]);
  const [personas, setPersonas] = useState<SelfPlayPersona[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [filterStatus, setFilterStatus] = useState<"all" | CoachProposalStatus>("all");
  const [filterStyle, setFilterStyle] = useState<string | "all">("all");

  // Run form
  const [runStyle, setRunStyle] = useState("alina-infinity-v1");
  const [runSample, setRunSample] = useState(8);
  const [runPersona, setRunPersona] = useState<string | "all">("all");
  const [running, setRunning] = useState(false);

  // Detail view
  const [openId, setOpenId] = useState<number | null>(null);
  const [detail, setDetail] = useState<CoachProposalDetail | null>(null);
  const [deciding, setDeciding] = useState<"applied" | "dismissed" | null>(null);

  // Apply / shadow-eval state — declared up here so the useEffect below
  // (polling shadowEval) can reference these in its deps without a TDZ.
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<{
    slug: string;
    version: number;
    id: number;
  } | null>(null);
  const [shadowEval, setShadowEval] = useState<ShadowEvalRow | null>(null);
  const [shadowStarting, setShadowStarting] = useState(false);
  const [shadowRuns, setShadowRuns] = useState(1);
  const [rollingBack, setRollingBack] = useState(false);

  async function refresh() {
    try {
      setError(null);
      const opts: Parameters<typeof api.coachProposals>[0] = {};
      if (filterStatus !== "all") opts.status = filterStatus;
      if (filterStyle !== "all") opts.style = filterStyle;
      const res = await api.coachProposals(opts);
      setProposals(res.proposals);
      setPendingCount(res.pending_count);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void refresh();
  }, [filterStatus, filterStyle]);

  useEffect(() => {
    api
      .styles()
      .then((r) => setStyles(r.styles.map((s) => ({ slug: s.slug, display_name: s.display_name }))))
      .catch(() => undefined);
    // Personas come from any /admin/api/pairwise (cheap) or /self-play call.
    // Reusing pairwise here keeps Coach independent of self-play data presence.
    api
      .pairwiseMatches({ limit: 1 })
      .then((r) => setPersonas(r.personas))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (openId === null) {
      setDetail(null);
      setShadowEval(null);
      return;
    }
    api
      .coachProposal(openId)
      .then((r) => setDetail(r.proposal))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    api
      .getShadowEval(openId)
      .then((r) => setShadowEval(r.shadow_eval))
      .catch(() => undefined);
  }, [openId]);

  // Poll shadow-eval status when running.
  useEffect(() => {
    if (!shadowEval || shadowEval.status !== "running") return;
    const id = shadowEval.proposal_id;
    const handle = setInterval(() => {
      api
        .getShadowEval(id)
        .then((r) => {
          if (r.shadow_eval) setShadowEval(r.shadow_eval);
          if (r.shadow_eval && r.shadow_eval.status !== "running") {
            clearInterval(handle);
          }
        })
        .catch(() => undefined);
    }, 5000);
    return () => clearInterval(handle);
  }, [shadowEval]);

  async function runCoach() {
    if (running) return;
    setRunning(true);
    setError(null);
    try {
      const body: Parameters<typeof api.runCoach>[0] = {
        style_slug: runStyle,
        sample: runSample,
      };
      if (runPersona !== "all") body.persona = runPersona;
      const res = await api.runCoach(body);
      await refresh();
      setOpenId(res.proposal.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  async function decide(id: number, status: "applied" | "dismissed") {
    setDeciding(status);
    try {
      const res = await api.decideCoachProposal(id, status);
      setDetail(res.proposal);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeciding(null);
    }
  }

  async function applyAsNewVersion(id: number) {
    if (
      !(await confirmDialog(
        "The current version will be marked is_active=0 (historical) but stays " +
          "available for already-pinned conversations. The new version becomes the " +
          "active default for new chats.",
        {
          title: "Fork a new version with the proposal's edits?",
          confirmLabel: "Fork version",
        },
      ))
    ) {
      return;
    }
    setApplying(true);
    setApplyResult(null);
    try {
      const res = await api.applyCoachProposal(id);
      setDetail(res.proposal);
      setApplyResult(res.new_style);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  }

  async function startShadow(id: number) {
    if (shadowStarting) return;
    setShadowStarting(true);
    try {
      const res = await api.startShadowEval(id, { runs: shadowRuns });
      setShadowEval(res.shadow_eval);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setShadowStarting(false);
    }
  }

  async function rollback(id: number) {
    if (
      !(await confirmDialog(
        "The new style version will be deactivated and the parent will be reactivated. " +
          "Conversations already pinned to the new version keep working — this only affects " +
          "which version becomes the default for new chats.",
        { title: "Roll back this proposal?", confirmLabel: "Roll back" },
      ))
    ) {
      return;
    }
    setRollingBack(true);
    try {
      await api.rollbackCoachProposal(id);
      await refresh();
      // Reload the proposal so the badge shows the new state.
      const r = await api.coachProposal(id);
      setDetail(r.proposal);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRollingBack(false);
    }
  }

  async function deleteProposal(id: number) {
    if (
      !(await confirmDialog(`Proposal #${id} will be deleted.`, {
        title: "Delete proposal?",
        confirmLabel: "Delete",
        danger: true,
      }))
    ) {
      return;
    }
    try {
      await api.deleteCoachProposal(id);
      if (openId === id) setOpenId(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const personaLookup = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of personas) m.set(p.slug, p.display_name);
    return m;
  }, [personas]);

  return (
    <div style={{ padding: 16, maxWidth: 1200, margin: "0 auto" }}>
      <h1>Coach proposals</h1>
      <p style={{ color: "var(--text-3)", fontSize: 13 }}>
        LLM coach analyzes recent self-play losses + draws and proposes concrete edits to the style
        spec. Proposals are NEVER auto-applied — review here, then update style.json by hand and
        mark the proposal as applied.{" "}
        {pendingCount > 0 && <strong>· {pendingCount} pending</strong>}
      </p>

      {error && (
        <div
          style={{
            background: "var(--bg-2)",
            color: "var(--red, #ef4444)",
            padding: 8,
            borderRadius: 4,
            margin: "8px 0",
          }}
        >
          {error}
        </div>
      )}

      <div
        style={{
          background: "var(--bg-2, #1a1a1a)",
          padding: 12,
          borderRadius: 6,
          margin: "16px 0",
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          alignItems: "flex-end",
        }}
      >
        <label>
          <div style={{ fontSize: 12, color: "var(--text-3)" }}>Style</div>
          <select value={runStyle} onChange={(e) => setRunStyle(e.target.value)}>
            {styles.length === 0 ? (
              <option value="alina-infinity-v1">alina-infinity-v1</option>
            ) : (
              styles.map((s) => (
                <option key={s.slug} value={s.slug}>
                  {s.display_name}
                </option>
              ))
            )}
          </select>
        </label>
        <label>
          <div style={{ fontSize: 12, color: "var(--text-3)" }}>Sample</div>
          <input
            type="number"
            min={1}
            max={50}
            value={runSample}
            onChange={(e) => setRunSample(Number(e.target.value) || 8)}
            style={{ width: 60 }}
          />
        </label>
        <label>
          <div style={{ fontSize: 12, color: "var(--text-3)" }}>Persona filter</div>
          <select value={runPersona} onChange={(e) => setRunPersona(e.target.value)}>
            <option value="all">all personas</option>
            {personas.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.display_name}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={runCoach} disabled={running}>
          {running ? "Running coach… (30-90s)" : "Run coach"}
        </button>
      </div>

      <h2 style={{ marginTop: 24 }}>Proposals</h2>
      <div style={{ display: "flex", gap: 12, marginBottom: 8 }}>
        <label>
          Status:&nbsp;
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value as typeof filterStatus)}
          >
            <option value="all">all</option>
            <option value="pending">pending</option>
            <option value="applied">applied</option>
            <option value="dismissed">dismissed</option>
          </select>
        </label>
        <label>
          Style:&nbsp;
          <select value={filterStyle} onChange={(e) => setFilterStyle(e.target.value)}>
            <option value="all">all</option>
            {styles.map((s) => (
              <option key={s.slug} value={s.slug}>
                {s.slug}
              </option>
            ))}
          </select>
        </label>
      </div>

      {proposals === null ? (
        <p style={{ color: "var(--text-3)" }}>Загрузка…</p>
      ) : proposals.length === 0 ? (
        <p style={{ color: "var(--text-3)" }}>No proposals yet — run the coach above.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {proposals.map((p) => (
            <li
              key={p.id}
              style={{
                padding: 10,
                borderBottom: "1px solid var(--border, #2a2a2a)",
                fontSize: 14,
                cursor: "pointer",
                background: openId === p.id ? "var(--bg-2, #1a1a1a)" : undefined,
              }}
              onClick={() => setOpenId(openId === p.id ? null : p.id)}
            >
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <div>
                  <span
                    style={{
                      color: STATUS_COLOR[p.status],
                      fontWeight: 600,
                      marginRight: 8,
                      textTransform: "uppercase",
                    }}
                  >
                    {p.status}
                  </span>
                  <strong>{p.style_slug}</strong>
                  <span style={{ color: "var(--text-3)", marginLeft: 8 }}>
                    · sample={p.sample_size}
                  </span>
                  {p.persona_filter && (
                    <span style={{ color: "var(--text-3)", marginLeft: 8 }}>
                      · persona={personaLookup.get(p.persona_filter) ?? p.persona_filter}
                    </span>
                  )}
                </div>
                <div style={{ color: "var(--text-3)", fontSize: 12 }}>
                  {new Date(p.created_at * 1000).toLocaleString()}
                </div>
              </div>
              <div style={{ marginTop: 4, color: "var(--text-2)" }}>{p.summary}</div>
            </li>
          ))}
        </ul>
      )}

      {detail && (
        <div
          style={{
            position: "fixed",
            top: 0,
            right: 0,
            width: "min(640px, 90vw)",
            height: "100vh",
            background: "var(--bg, #0a0a0a)",
            borderLeft: "1px solid var(--border, #2a2a2a)",
            padding: 16,
            overflowY: "auto",
            boxShadow: "-8px 0 24px rgba(0,0,0,0.4)",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 12,
            }}
          >
            <h2 style={{ margin: 0 }}>Proposal #{detail.id}</h2>
            <button
              type="button"
              onClick={() => setOpenId(null)}
              style={{
                background: "transparent",
                border: "none",
                color: "var(--text-3)",
                cursor: "pointer",
                fontSize: 20,
              }}
            >
              ×
            </button>
          </div>
          <div style={{ fontSize: 13, color: "var(--text-3)" }}>
            <span
              style={{
                color: STATUS_COLOR[detail.status],
                fontWeight: 600,
                marginRight: 8,
                textTransform: "uppercase",
              }}
            >
              {detail.status}
            </span>
            {detail.style_slug} · sample={detail.sample_size}
            {detail.persona_filter && ` · persona=${detail.persona_filter}`}
          </div>

          <p style={{ marginTop: 12 }}>
            <strong>Summary:</strong> {detail.summary}
          </p>

          {detail.rationale.length > 0 && (
            <>
              <h3>Rationale</h3>
              <ul style={{ paddingLeft: 20 }}>
                {detail.rationale.map((r, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: rationale list is read-only and append-only — index is stable
                  <li key={i} style={{ marginBottom: 4 }}>
                    {r}
                  </li>
                ))}
              </ul>
            </>
          )}

          <h3>Edits</h3>
          {Object.keys(detail.edits).length === 0 ? (
            <p style={{ color: "var(--text-3)", fontStyle: "italic" }}>
              No actionable edits — coach found nothing concrete to suggest.
            </p>
          ) : (
            <pre
              style={{
                background: "var(--bg-2, #1a1a1a)",
                padding: 12,
                borderRadius: 4,
                fontSize: 12,
                overflow: "auto",
                maxHeight: 400,
              }}
            >
              {JSON.stringify(detail.edits, null, 2)}
            </pre>
          )}

          {detail.raw_output && (
            <details style={{ marginTop: 12 }}>
              <summary style={{ color: "var(--text-3)", cursor: "pointer" }}>
                Raw LLM output (parse failed)
              </summary>
              <pre
                style={{
                  background: "var(--bg-2)",
                  padding: 8,
                  fontSize: 11,
                  overflow: "auto",
                  maxHeight: 200,
                }}
              >
                {detail.raw_output}
              </pre>
            </details>
          )}

          {detail.status === "pending" && (
            <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => applyAsNewVersion(detail.id)}
                disabled={applying || deciding !== null}
                title="Forks a new style version with these edits applied (current version becomes historical)"
                style={{
                  background: "var(--accent, #3b82f6)",
                  color: "white",
                  border: "none",
                  padding: "8px 16px",
                  borderRadius: 4,
                  cursor: "pointer",
                  fontWeight: 600,
                }}
              >
                {applying ? "Forking…" : "Apply as new version"}
              </button>
              <button
                type="button"
                onClick={() => decide(detail.id, "applied")}
                disabled={deciding !== null || applying}
                title="Mark applied without forking (e.g. you already edited style.json by hand)"
                style={{
                  background: "var(--green, #2ea043)",
                  color: "white",
                  border: "none",
                  padding: "8px 16px",
                  borderRadius: 4,
                  cursor: "pointer",
                }}
              >
                {deciding === "applied" ? "Marking…" : "Mark applied (manual)"}
              </button>
              <button
                type="button"
                onClick={() => decide(detail.id, "dismissed")}
                disabled={deciding !== null || applying}
                style={{
                  background: "var(--bg-2)",
                  color: "var(--text)",
                  border: "1px solid var(--border)",
                  padding: "8px 16px",
                  borderRadius: 4,
                  cursor: "pointer",
                }}
              >
                Dismiss
              </button>
            </div>
          )}
          {applyResult && (
            <div
              style={{
                marginTop: 12,
                padding: 8,
                background: "var(--bg-2)",
                borderLeft: "3px solid var(--green, #2ea043)",
                borderRadius: 4,
                fontSize: 13,
              }}
            >
              ✓ Forked <strong>{applyResult.slug}</strong> v{applyResult.version} (style id #
              {applyResult.id}). Skills attachments copied + edited.
            </div>
          )}

          {detail.status === "applied" && (
            <div
              style={{
                marginTop: 16,
                padding: 12,
                background: "var(--bg-2, #1a1a1a)",
                border: "1px solid var(--border, #2a2a2a)",
                borderRadius: 6,
              }}
            >
              <h3 style={{ margin: "0 0 8px 0", fontSize: 14 }}>Shadow A/B</h3>
              {shadowEval === null && (
                <div>
                  <p style={{ fontSize: 13, color: "var(--text-3)", marginTop: 0 }}>
                    Pit the new fork (B) against the parent (A) head-to-head. Wilson 95% lower bound
                    on B's win rate decides keep / rollback.
                  </p>
                  <label style={{ marginRight: 8 }}>
                    Runs/persona:&nbsp;
                    <input
                      type="number"
                      min={1}
                      max={5}
                      value={shadowRuns}
                      onChange={(e) => setShadowRuns(Number(e.target.value) || 1)}
                      style={{ width: 50 }}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => startShadow(detail.id)}
                    disabled={shadowStarting}
                    style={{
                      background: "var(--accent, #3b82f6)",
                      color: "white",
                      border: "none",
                      padding: "6px 12px",
                      borderRadius: 4,
                      cursor: "pointer",
                    }}
                  >
                    {shadowStarting ? "Starting…" : "Run shadow A/B"}
                  </button>
                  <p style={{ fontSize: 11, color: "var(--text-3)", marginTop: 6 }}>
                    Default: 4 personas × {shadowRuns} run = {4 * shadowRuns} pairs. Each pair ~2-3
                    min on Ollama, so plan accordingly.
                  </p>
                </div>
              )}
              {shadowEval && (
                <div style={{ fontSize: 13 }}>
                  <div style={{ marginBottom: 6 }}>
                    Status:&nbsp;
                    <strong
                      style={{
                        color:
                          shadowEval.status === "running"
                            ? "var(--amber, #d97706)"
                            : shadowEval.status === "complete"
                              ? "var(--green, #2ea043)"
                              : "var(--red, #ef4444)",
                      }}
                    >
                      {shadowEval.status.toUpperCase()}
                    </strong>
                    &nbsp;· {shadowEval.pairs_done}/{shadowEval.pairs_planned} pairs
                  </div>
                  <div style={{ color: "var(--text-3)" }}>
                    A (parent={shadowEval.parent_style_slug}) wins:{" "}
                    <strong>{shadowEval.a_wins}</strong>, B (new) wins:{" "}
                    <strong>{shadowEval.b_wins}</strong>, draws: <strong>{shadowEval.draws}</strong>
                  </div>
                  {shadowEval.win_rate_lb !== null && (
                    <div style={{ marginTop: 4 }}>
                      B Wilson LB: <strong>{shadowEval.win_rate_lb.toFixed(3)}</strong>
                      {shadowEval.decision && (
                        <>
                          &nbsp;· decision:&nbsp;
                          <strong
                            style={{
                              color:
                                shadowEval.decision === "keep"
                                  ? "var(--green)"
                                  : shadowEval.decision === "rollback"
                                    ? "var(--red)"
                                    : "var(--amber)",
                            }}
                          >
                            {shadowEval.decision}
                          </strong>
                        </>
                      )}
                    </div>
                  )}
                  {shadowEval.error_message && (
                    <div style={{ color: "var(--red)", fontSize: 12, marginTop: 4 }}>
                      Error: {shadowEval.error_message}
                    </div>
                  )}
                  {(shadowEval.decision === "rollback" ||
                    shadowEval.decision === "inconclusive") && (
                    <button
                      type="button"
                      onClick={() => rollback(detail.id)}
                      disabled={rollingBack}
                      style={{
                        marginTop: 8,
                        background: "var(--red, #ef4444)",
                        color: "white",
                        border: "none",
                        padding: "6px 12px",
                        borderRadius: 4,
                        cursor: "pointer",
                        fontSize: 13,
                      }}
                    >
                      {rollingBack ? "Rolling back…" : "Rollback to parent"}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          {detail.status !== "pending" && detail.decided_at && (
            <p style={{ color: "var(--text-3)", fontSize: 12, marginTop: 12 }}>
              Decided {new Date(detail.decided_at * 1000).toLocaleString()}
            </p>
          )}

          <button
            type="button"
            onClick={() => deleteProposal(detail.id)}
            style={{
              marginTop: 24,
              background: "transparent",
              color: "var(--red, #ef4444)",
              border: "1px solid var(--red)",
              padding: "4px 12px",
              borderRadius: 4,
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            Delete proposal
          </button>
        </div>
      )}
    </div>
  );
}

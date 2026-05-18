import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import {
  api,
  type PairwiseMatchRow,
  type PairwiseMatrixRow,
  type SelfPlayPersona,
} from "../api.ts";
import { confirmDialog } from "../components/Dialogs.tsx";

const WINNER_COLOR: Record<PairwiseMatchRow["winner"], string> = {
  a: "var(--green, #2ea043)",
  b: "var(--accent, #3b82f6)",
  draw: "var(--text-3)",
};

const WINNER_LABEL: Record<PairwiseMatchRow["winner"], string> = {
  a: "A wins",
  b: "B wins",
  draw: "draw",
};

/**
 * Pairwise self-play browser. Each row is one head-to-head pair
 * (style A vs style B on the same candidate persona) — the verdict
 * is from the comparative judge, ELO snapshots are post-pair.
 *
 * Drill-down: clicking the "A: ..." or "B: ..." link opens the solo
 * transcript on /admin/self-play/:id (the existing page) — pairwise
 * itself doesn't store a transcript, just the verdict + links.
 */
export function Pairwise() {
  const [matches, setMatches] = useState<PairwiseMatchRow[] | null>(null);
  const [matrix, setMatrix] = useState<PairwiseMatrixRow[]>([]);
  const [personas, setPersonas] = useState<SelfPlayPersona[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [filterWinner, setFilterWinner] = useState<"all" | "a" | "b" | "draw">("all");
  const [filterPersona, setFilterPersona] = useState<string | "all">("all");

  async function refresh() {
    try {
      setError(null);
      const opts: Parameters<typeof api.pairwiseMatches>[0] = {};
      if (filterWinner !== "all") opts.winner = filterWinner;
      if (filterPersona !== "all") opts.persona = filterPersona;
      const res = await api.pairwiseMatches(opts);
      setMatches(res.matches);
      setMatrix(res.matrix);
      setPersonas(res.personas);
      setTotal(res.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void refresh();
  }, [filterWinner, filterPersona]);

  const personaLookup = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of personas) m.set(p.slug, p.display_name);
    return m;
  }, [personas]);

  async function deleteMatch(id: number) {
    if (
      !(await confirmDialog("Solo transcripts stay.", {
        title: `Delete pairwise match #${id}?`,
        confirmLabel: "Delete",
        danger: true,
      }))
    ) {
      return;
    }
    try {
      await api.deletePairwiseMatch(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div style={{ padding: 16, maxWidth: 1200, margin: "0 auto" }}>
      <h1>Pairwise self-play</h1>
      <p style={{ color: "var(--text-3)", fontSize: 13 }}>
        Head-to-head comparison: style A vs style B against the same candidate persona. Winner is
        called by a comparative LLM judge. ELO updates are symmetric (<code>eloUpdatePair</code>) on
        top of the per-match solo ELO already applied by the orchestrator.
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

      <h2 style={{ marginTop: 24 }}>Head-to-head matrix</h2>
      <p style={{ color: "var(--text-3)", fontSize: 13 }}>
        Each row aggregates one ordered pair (A vs B). Order matters — to symmetrize, run the
        reverse direction too.
      </p>
      {matrix.length === 0 ? (
        <p style={{ color: "var(--text-3)" }}>No pairwise matches yet.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr>
                <th style={cellHeadStyle}>A (style)</th>
                <th style={cellHeadStyle}>B (style)</th>
                <th style={cellHeadStyle}>A wins</th>
                <th style={cellHeadStyle}>B wins</th>
                <th style={cellHeadStyle}>Draws</th>
                <th style={cellHeadStyle}>Total</th>
                <th style={cellHeadStyle}>A win rate</th>
              </tr>
            </thead>
            <tbody>
              {matrix.map((r) => {
                const wr = r.total > 0 ? Math.round((r.a_wins / r.total) * 100) : null;
                return (
                  <tr key={`${r.style_a_slug}|${r.style_b_slug}`}>
                    <td style={cellStyle}>{r.style_a_slug}</td>
                    <td style={cellStyle}>{r.style_b_slug}</td>
                    <td style={cellStyle}>{r.a_wins}</td>
                    <td style={cellStyle}>{r.b_wins}</td>
                    <td style={cellStyle}>{r.draws}</td>
                    <td style={cellStyle}>{r.total}</td>
                    <td style={cellStyle}>{wr === null ? "—" : `${wr}%`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <h2 style={{ marginTop: 24 }}>Recent pairs ({total})</h2>
      <div style={{ display: "flex", gap: 12, marginBottom: 8 }}>
        <label>
          Winner:&nbsp;
          <select
            value={filterWinner}
            onChange={(e) => setFilterWinner(e.target.value as "all" | "a" | "b" | "draw")}
          >
            <option value="all">all</option>
            <option value="a">A wins</option>
            <option value="b">B wins</option>
            <option value="draw">draw</option>
          </select>
        </label>
        <label>
          Persona:&nbsp;
          <select value={filterPersona} onChange={(e) => setFilterPersona(e.target.value)}>
            <option value="all">all</option>
            {personas.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.display_name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {matches === null ? (
        <p style={{ color: "var(--text-3)" }}>Загрузка…</p>
      ) : matches.length === 0 ? (
        <p style={{ color: "var(--text-3)" }}>No matches under current filters.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {matches.map((m) => (
            <li
              key={m.id}
              style={{
                padding: 10,
                borderBottom: "1px solid var(--border, #2a2a2a)",
                fontSize: 14,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <div>
                  <span
                    style={{
                      color: WINNER_COLOR[m.winner],
                      fontWeight: 600,
                      marginRight: 8,
                    }}
                  >
                    {WINNER_LABEL[m.winner].toUpperCase()}
                  </span>
                  <span>
                    <strong>{m.style_a_slug}</strong>{" "}
                    <span style={{ color: "var(--text-3)" }}>vs</span>{" "}
                    <strong>{m.style_b_slug}</strong>
                  </span>
                  <span style={{ color: "var(--text-3)", marginLeft: 8 }}>
                    · {personaLookup.get(m.persona_slug) ?? m.persona_slug}
                  </span>
                  <span style={{ color: "var(--text-3)", marginLeft: 8 }}>
                    · ELO A={m.elo_a_after} B={m.elo_b_after}
                  </span>
                </div>
                <div style={{ color: "var(--text-3)", fontSize: 12 }}>
                  {new Date(m.created_at * 1000).toLocaleString()}
                  &nbsp;·&nbsp;
                  <button
                    type="button"
                    onClick={() => deleteMatch(m.id)}
                    style={{
                      background: "transparent",
                      color: "var(--red, #ef4444)",
                      border: "none",
                      cursor: "pointer",
                      padding: 0,
                      fontSize: 12,
                    }}
                  >
                    delete
                  </button>
                </div>
              </div>
              {m.judge_reason && (
                <div
                  style={{
                    color: "var(--text-2)",
                    fontStyle: "italic",
                    marginTop: 4,
                    fontSize: 13,
                  }}
                >
                  "{m.judge_reason}"
                </div>
              )}
              <div style={{ marginTop: 4, fontSize: 12 }}>
                {m.match_a_id !== null && (
                  <Link to={`/admin/self-play?focus=${m.match_a_id}`} style={{ marginRight: 12 }}>
                    A transcript →
                  </Link>
                )}
                {m.match_b_id !== null && (
                  <Link to={`/admin/self-play?focus=${m.match_b_id}`}>B transcript →</Link>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const cellHeadStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "6px 12px",
  borderBottom: "1px solid var(--border, #2a2a2a)",
  fontWeight: 600,
};
const cellStyle: React.CSSProperties = {
  padding: "6px 12px",
  borderBottom: "1px solid var(--border, #2a2a2a)",
};

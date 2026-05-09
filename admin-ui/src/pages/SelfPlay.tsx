import { useEffect, useMemo, useState } from "react";
import {
  api,
  type SelfPlayMatchDetail,
  type SelfPlayMatchSummary,
  type SelfPlayMatrixRow,
  type SelfPlayPersona,
} from "../api.ts";

const OUTCOME_COLOR: Record<SelfPlayMatchSummary["outcome"], string> = {
  won: "var(--green, #2ea043)",
  lost: "var(--red, #ef4444)",
  draw: "var(--text-3)",
};

/**
 * Self-play results browser. Reads transcripts persisted by the
 * orchestrator (see migration 016 + scripts/self-play.ts), so the
 * operator can review WHY a match ended a given way without diving
 * into SQL or rerunning the simulation.
 *
 * Layout: matrix card on top (style × persona heat-map of win-rates),
 * recent matches list below, click a row to expand into a transcript
 * panel.
 */
export function SelfPlay() {
  const [matches, setMatches] = useState<SelfPlayMatchSummary[] | null>(null);
  const [matrix, setMatrix] = useState<SelfPlayMatrixRow[]>([]);
  const [personas, setPersonas] = useState<SelfPlayPersona[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [detail, setDetail] = useState<SelfPlayMatchDetail | null>(null);
  const [filterOutcome, setFilterOutcome] = useState<"all" | "won" | "lost" | "draw">("all");
  const [filterPersona, setFilterPersona] = useState<string | "all">("all");

  async function refresh() {
    try {
      setError(null);
      const opts: Parameters<typeof api.selfPlayMatches>[0] = {};
      if (filterOutcome !== "all") opts.outcome = filterOutcome;
      if (filterPersona !== "all") opts.persona = filterPersona;
      const res = await api.selfPlayMatches(opts);
      setMatches(res.matches);
      setMatrix(res.matrix);
      setPersonas(res.personas);
      setTotal(res.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterOutcome, filterPersona]);

  async function openMatch(id: number) {
    if (openId === id) {
      setOpenId(null);
      setDetail(null);
      return;
    }
    setOpenId(id);
    setDetail(null);
    try {
      const res = await api.selfPlayMatch(id);
      setDetail(res.match);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function deleteMatch(id: number) {
    if (!confirm("Удалить этот матч из статистики? Это не повлияет на скиллы (skill_outcomes)."))
      return;
    try {
      await api.deleteSelfPlayMatch(id);
      if (openId === id) {
        setOpenId(null);
        setDetail(null);
      }
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div style={{ padding: "24px 32px", display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h2 style={{ fontFamily: "var(--mono)", color: "var(--amber)", margin: 0 }}>Self-play</h2>
        <div
          style={{
            fontSize: 12,
            color: "var(--text-3)",
            marginTop: 4,
            fontFamily: "var(--mono)",
          }}
        >
          {total} matches · simulations of bot vs candidate persona
        </div>
      </div>

      <p style={{ color: "var(--text-3)", fontSize: 12, margin: 0, lineHeight: 1.6 }}>
        Тренировочные матчи бота против синтетических кандидатов. Каждая строка — один диалог,
        законченный вердиктом LLM-судьи. Запускается через CLI:{" "}
        <code>bun run scripts/self-play.ts --style alina-infinity-v1 --runs 3</code>. Результаты
        идут в win-rate скилов и ELO стиля.
      </p>

      <Matrix matrix={matrix} personas={personas} />

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 11, color: "var(--text-3)", fontFamily: "var(--mono)" }}>
          outcome:
        </span>
        {(["all", "won", "lost", "draw"] as const).map((o) => (
          <button
            key={o}
            onClick={() => setFilterOutcome(o)}
            className={`btn btn-sm ${filterOutcome === o ? "btn-primary" : "btn-ghost"}`}
            data-testid={`self-play-filter-outcome-${o}`}
          >
            {o}
          </button>
        ))}
        <span
          style={{
            fontSize: 11,
            color: "var(--text-3)",
            fontFamily: "var(--mono)",
            marginLeft: 12,
          }}
        >
          persona:
        </span>
        <select
          value={filterPersona}
          onChange={(e) => setFilterPersona(e.target.value)}
          className="input"
          style={{ minWidth: 200 }}
          data-testid="self-play-filter-persona"
        >
          <option value="all">all personas</option>
          {personas.map((p) => (
            <option key={p.slug} value={p.slug}>
              {p.display_name}
            </option>
          ))}
        </select>
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

      {!matches && <div className="loading-text">loading…</div>}
      {matches && matches.length === 0 && (
        <div
          style={{
            padding: 24,
            textAlign: "center",
            color: "var(--text-3)",
            background: "var(--bg-1)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
          }}
        >
          Пока ни одного матча. Запусти{" "}
          <code>
            bun run scripts/self-play.ts --style alina-infinity-v1 --runs 1 --personas eager-kate
          </code>{" "}
          чтобы получить первый.
        </div>
      )}

      {matches && matches.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {matches.map((m) => (
            <MatchRow
              key={m.id}
              match={m}
              personas={personas}
              isOpen={openId === m.id}
              detail={openId === m.id ? detail : null}
              onToggle={() => openMatch(m.id)}
              onDelete={() => deleteMatch(m.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Matrix({
  matrix,
  personas,
}: {
  matrix: SelfPlayMatrixRow[];
  personas: SelfPlayPersona[];
}) {
  const styles = useMemo(() => Array.from(new Set(matrix.map((m) => m.style_slug))), [matrix]);
  const cell = (style: string, persona: string) =>
    matrix.find((m) => m.style_slug === style && m.persona_slug === persona);

  if (matrix.length === 0 || styles.length === 0) return null;

  return (
    <div
      style={{
        background: "var(--bg-1)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: 12,
        overflowX: "auto",
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: "var(--text-3)",
          fontFamily: "var(--mono)",
          textTransform: "uppercase",
          letterSpacing: 1,
          marginBottom: 8,
        }}
      >
        Win-rate matrix · style × persona
      </div>
      <table style={{ borderCollapse: "collapse", fontSize: 12, fontFamily: "var(--mono)" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left", padding: "4px 8px", color: "var(--text-3)" }}></th>
            {personas.map((p) => (
              <th
                key={p.slug}
                style={{
                  padding: "4px 8px",
                  textAlign: "center",
                  color: "var(--text-3)",
                  whiteSpace: "nowrap",
                  fontWeight: 500,
                }}
                title={p.summary}
              >
                {p.display_name.split(" ")[0]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {styles.map((s) => (
            <tr key={s}>
              <td style={{ padding: "4px 8px", color: "var(--text-2)" }}>{s}</td>
              {personas.map((p) => {
                const c = cell(s, p.slug);
                if (!c)
                  return (
                    <td
                      key={p.slug}
                      style={{ padding: "4px 8px", textAlign: "center", color: "var(--text-3)" }}
                    >
                      —
                    </td>
                  );
                const winRate = c.total > 0 ? c.won / c.total : 0;
                const color =
                  winRate >= 0.6
                    ? "var(--green, #2ea043)"
                    : winRate >= 0.3
                      ? "var(--amber, #d97706)"
                      : "var(--red, #ef4444)";
                return (
                  <td
                    key={p.slug}
                    style={{
                      padding: "4px 8px",
                      textAlign: "center",
                      color,
                      whiteSpace: "nowrap",
                    }}
                    title={`${c.won}W / ${c.lost}L / ${c.draw}D`}
                  >
                    {(winRate * 100).toFixed(0)}% ({c.total})
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MatchRow({
  match,
  personas,
  isOpen,
  detail,
  onToggle,
  onDelete,
}: {
  match: SelfPlayMatchSummary;
  personas: SelfPlayPersona[];
  isOpen: boolean;
  detail: SelfPlayMatchDetail | null;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const persona = personas.find((p) => p.slug === match.persona_slug);
  return (
    <div
      data-testid="self-play-match"
      style={{
        background: "var(--bg-1)",
        border: "1px solid var(--border)",
        borderLeft: `3px solid ${OUTCOME_COLOR[match.outcome]}`,
        borderRadius: "var(--radius)",
      }}
    >
      <div
        style={{
          padding: 10,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          cursor: "pointer",
        }}
        onClick={onToggle}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1, minWidth: 0 }}>
          <span
            style={{
              width: 60,
              padding: "2px 6px",
              borderRadius: 3,
              background: OUTCOME_COLOR[match.outcome],
              color: "var(--bg)",
              fontFamily: "var(--mono)",
              fontSize: 11,
              fontWeight: 600,
              textAlign: "center",
              flexShrink: 0,
            }}
          >
            {match.outcome.toUpperCase()}
          </span>
          <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text)" }}>
            {persona?.display_name ?? match.persona_slug}
          </span>
          <span style={{ fontSize: 12, color: "var(--text-3)" }}>
            vs <strong style={{ color: "var(--amber)" }}>{match.style_slug}</strong>
          </span>
          <span style={{ fontSize: 11, color: "var(--text-3)", fontFamily: "var(--mono)" }}>
            {match.turns} turns · {match.skills_count} skills
            {match.fabrications_caught > 0 && (
              <span
                style={{ color: "var(--amber, #d97706)", marginLeft: 8 }}
                title="Reflect rejected this many ungrounded replies"
              >
                ⚠ {match.fabrications_caught} fabrication{match.fabrications_caught > 1 ? "s" : ""}
              </span>
            )}
          </span>
          {match.judge_reason && (
            <span
              style={{
                fontSize: 12,
                color: "var(--text-2)",
                fontStyle: "italic",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                flex: 1,
                minWidth: 0,
              }}
              title={match.judge_reason}
            >
              "{match.judge_reason}"
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ fontSize: 11, color: "var(--text-3)", fontFamily: "var(--mono)" }}>
            {new Date(match.created_at * 1000).toLocaleDateString("ru-RU")}
          </span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="btn btn-danger btn-sm"
            data-testid="self-play-delete"
          >
            del
          </button>
        </div>
      </div>

      {isOpen && (
        <div
          style={{
            borderTop: "1px solid var(--border)",
            padding: 12,
            background: "var(--bg)",
          }}
        >
          {!detail && <div className="loading-text">loading transcript…</div>}
          {detail && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--text-3)",
                  fontFamily: "var(--mono)",
                  display: "flex",
                  gap: 12,
                  flexWrap: "wrap",
                }}
              >
                <span>skills: {detail.skills.join(", ") || "(none)"}</span>
                {detail.lead_id !== null && <span>lead_id: {detail.lead_id}</span>}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {detail.transcript.map((m, i) => (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: transcript order is stable
                    key={i}
                    style={{
                      display: "flex",
                      gap: 8,
                      padding: 8,
                      background: m.role === "candidate" ? "var(--bg-1)" : "transparent",
                      borderRadius: "var(--radius)",
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "var(--mono)",
                        fontSize: 10,
                        color: "var(--text-3)",
                        width: 90,
                        flexShrink: 0,
                        paddingTop: 2,
                      }}
                    >
                      {m.role === "candidate" ? detail.persona_display_name : "Алина"}
                    </span>
                    <span
                      style={{
                        fontSize: 13,
                        color: "var(--text-2)",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        lineHeight: 1.5,
                      }}
                    >
                      {m.text}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

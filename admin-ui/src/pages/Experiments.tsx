import { useEffect, useState } from "react";
import {
  api,
  type Experiment,
  type ExperimentStatus,
  type FunnelRow,
  type StyleSummary,
  type SystemStatus,
} from "../api.ts";

export function Experiments() {
  const [experiments, setExperiments] = useState<Experiment[] | null>(null);
  const [styles, setStyles] = useState<StyleSummary[] | null>(null);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  async function refresh() {
    try {
      const [eRes, sRes, stRes] = await Promise.all([
        api.experiments(),
        api.styles(),
        api.status().catch(() => null),
      ]);
      setExperiments(eRes.experiments);
      setStyles(sRes.styles);
      setSystemStatus(stRes);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function setStatus(id: number, status: ExperimentStatus) {
    setError(null);
    try {
      await api.setExperimentStatus(id, status);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div style={{ padding: "24px 32px" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 4,
        }}
      >
        <h2
          style={{
            fontFamily: "var(--mono)",
            color: "var(--amber)",
            margin: 0,
          }}
        >
          A/B experiments
        </h2>
        <button onClick={() => setShowCreate((s) => !s)} style={btnStyle()}>
          {showCreate ? "cancel" : "+ new experiment"}
        </button>
      </div>
      <p style={{ color: "var(--text-3)", fontSize: 13, marginBottom: 20 }}>
        At most one experiment may be in <code>running</code> at a time. New conversations get a
        deterministic per-user variant assignment via SHA-256 hash; the assignment is sticky for the
        lifetime of the chat.
      </p>

      {systemStatus && <ActiveRoutingBanner status={systemStatus} />}

      {error ? (
        <div style={{ color: "var(--red, #f55)", marginBottom: 12 }}>error: {error}</div>
      ) : null}

      {showCreate && styles ? (
        <CreateExperimentForm
          styles={styles}
          onCreated={() => {
            setShowCreate(false);
            refresh();
          }}
          onError={setError}
        />
      ) : null}

      {experiments === null ? (
        <div style={{ color: "var(--text-3)" }}>загрузка…</div>
      ) : experiments.length === 0 ? (
        <EmptyState envOverride={systemStatus?.routing.mode === "env_override"} />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {experiments.map((e) => (
            <ExperimentCard key={e.id} experiment={e} onStatus={setStatus} />
          ))}
        </div>
      )}
    </div>
  );
}

function ActiveRoutingBanner({ status }: { status: SystemStatus }) {
  const r = status.routing;
  let body: React.ReactNode;
  let accent = "var(--text-3)";
  if (r.mode === "env_override") {
    body = (
      <>
        <strong style={{ color: "var(--amber)" }}>env override active</strong>
        <span style={{ color: "var(--text-3)" }}> — </span>
        all conversations are forced to <code>{r.active_style_slug}</code> via{" "}
        <code>BOT_SALES_STYLE</code>. Experiments below are visible but{" "}
        <strong>do not affect routing</strong>.
      </>
    );
    accent = "var(--amber)";
  } else if (r.mode === "running_experiment") {
    body = (
      <>
        <strong style={{ color: "var(--green, #2ea043)" }}>experiment running</strong>
        <span style={{ color: "var(--text-3)" }}> — </span>
        <code>{r.running_experiment_slug}</code> is currently routing new conversations.
      </>
    );
    accent = "var(--green, #2ea043)";
  } else if (r.mode === "legacy_persona") {
    body = (
      <>
        <strong style={{ color: "var(--text)" }}>legacy persona active</strong>
        <span style={{ color: "var(--text-3)" }}> — </span>
        sales-style engine is OFF; all chats use <code>BOT_PERSONA_*</code>. Experiments are
        scaffolding for when you switch on a sales style.
      </>
    );
  } else {
    body = (
      <>
        <strong>no routing configured</strong>
        <span style={{ color: "var(--text-3)" }}> — </span>
        bot replies with a generic AI persona. Set <code>BOT_PERSONA_*</code> or{" "}
        <code>BOT_SALES_STYLE</code>, or start an experiment below.
      </>
    );
  }
  return (
    <div
      style={{
        background: "var(--bg-1)",
        border: `1px solid ${accent}`,
        borderLeft: `3px solid ${accent}`,
        borderRadius: "var(--radius)",
        padding: "10px 14px",
        marginBottom: 16,
        fontSize: 13,
        fontFamily: "var(--sans)",
        color: "var(--text-2)",
      }}
    >
      {body}
    </div>
  );
}

function EmptyState({ envOverride }: { envOverride: boolean }) {
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
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-3)" }}>
        no experiments yet
      </div>
      <div>
        Use this when you want to A/B test two or more sales styles on real candidates — e.g.
        flirt-recruiter vs. empathetic-consultant.
      </div>
      <div style={{ color: "var(--text-3)" }}>
        Workflow:{" "}
        <span style={{ color: "var(--text-2)" }}>
          create as draft → set variant weights → start
        </span>
        . Each new candidate gets a deterministic variant via SHA-256 hash; existing chats keep
        their assigned style. Per-style funnel conversion shows up here once traffic accumulates.
      </div>
      {envOverride && (
        <div style={{ color: "var(--amber)", marginTop: 4 }}>
          ⚠ <code>BOT_SALES_STYLE</code> is currently set in env — even if you start an experiment,
          it won't actually route until you unset that env var.
        </div>
      )}
      <div style={{ marginTop: 4 }}>
        <button onClick={() => undefined} style={{ display: "none" }} />
      </div>
    </div>
  );
}

function ExperimentCard({
  experiment: e,
  onStatus,
}: {
  experiment: Experiment;
  onStatus: (id: number, status: ExperimentStatus) => void;
}) {
  const [funnel, setFunnel] = useState<FunnelRow[] | null>(null);

  useEffect(() => {
    api
      .experimentFunnel(e.id)
      .then((res) => setFunnel(res.funnel))
      .catch(() => setFunnel([]));
  }, [e.id]);

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: 16,
        background: "var(--bg-1)",
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
        <div>
          <div
            style={{
              fontFamily: "var(--mono)",
              fontSize: 14,
              fontWeight: 600,
              color: "var(--text)",
            }}
          >
            {e.slug}
          </div>
          <div
            style={{
              fontSize: 11,
              color: "var(--text-3)",
              fontFamily: "var(--mono)",
              marginTop: 2,
            }}
          >
            id={e.id} · success={e.success_metric} ·{" "}
            {e.started_at
              ? `started ${new Date(e.started_at * 1000).toISOString().slice(0, 10)}`
              : "not started"}
            {e.ended_at ? ` · ended ${new Date(e.ended_at * 1000).toISOString().slice(0, 10)}` : ""}
          </div>
        </div>
        <StatusBadge status={e.status} />
      </div>

      <div style={{ marginBottom: 12 }}>
        <div
          style={{
            fontSize: 11,
            color: "var(--text-3)",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            marginBottom: 4,
          }}
        >
          allocation
        </div>
        <code style={{ fontSize: 12, color: "var(--text-2)" }}>{JSON.stringify(e.allocation)}</code>
      </div>

      {funnel === null ? (
        <div style={{ color: "var(--text-3)", fontSize: 12 }}>загрузка воронки…</div>
      ) : funnel.length === 0 ? (
        <div style={{ color: "var(--text-3)", fontSize: 12 }}>no traffic yet</div>
      ) : (
        <FunnelTable funnel={funnel} successMetric={e.success_metric} />
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <StatusButton experiment={e} target="running" label="start" onStatus={onStatus} />
        <StatusButton experiment={e} target="paused" label="pause" onStatus={onStatus} />
        <StatusButton experiment={e} target="done" label="finish" onStatus={onStatus} />
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: ExperimentStatus }) {
  const colors: Record<ExperimentStatus, { bg: string; fg: string }> = {
    draft: { bg: "var(--bg-3)", fg: "var(--text-3)" },
    running: { bg: "rgba(46,160,67,0.15)", fg: "rgb(46,160,67)" },
    paused: { bg: "rgba(255,184,0,0.15)", fg: "rgb(255,184,0)" },
    done: { bg: "var(--bg-2)", fg: "var(--text-3)" },
  };
  const c = colors[status];
  return (
    <span
      style={{
        background: c.bg,
        color: c.fg,
        fontFamily: "var(--mono)",
        fontSize: 11,
        padding: "4px 8px",
        borderRadius: "var(--radius)",
        textTransform: "uppercase",
        letterSpacing: "0.05em",
      }}
    >
      {status}
    </span>
  );
}

function StatusButton({
  experiment,
  target,
  label,
  onStatus,
}: {
  experiment: Experiment;
  target: ExperimentStatus;
  label: string;
  onStatus: (id: number, status: ExperimentStatus) => void;
}) {
  const disabled = experiment.status === target;
  return (
    <button
      disabled={disabled}
      onClick={() => onStatus(experiment.id, target)}
      style={{
        ...btnStyle(),
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? "default" : "pointer",
      }}
    >
      {label}
    </button>
  );
}

function FunnelTable({
  funnel,
  successMetric,
}: {
  funnel: FunnelRow[];
  successMetric: "qualified" | "won" | "replied_3+";
}) {
  const successKey: keyof FunnelRow = successMetric === "won" ? "won" : "qualified";
  return (
    <table
      style={{
        width: "100%",
        borderCollapse: "collapse",
        fontSize: 12,
        fontFamily: "var(--mono)",
        marginTop: 4,
      }}
    >
      <thead>
        <tr style={{ borderBottom: "1px solid var(--border)" }}>
          <th style={thStyle()}>style</th>
          <th style={thStyle()}>conv</th>
          <th style={thStyle()}>success ({successMetric})</th>
          <th style={thStyle()}>rate</th>
          <th style={thStyle()}>escalated</th>
        </tr>
      </thead>
      <tbody>
        {funnel.map((r) => {
          const success = r[successKey] as number;
          const rate = r.conversations > 0 ? (success / r.conversations) * 100 : 0;
          return (
            <tr key={r.style_id} style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={tdStyle()}>{r.slug}</td>
              <td style={tdStyle()}>{r.conversations}</td>
              <td style={tdStyle()}>{success}</td>
              <td style={tdStyle({ color: "var(--amber)" })}>{rate.toFixed(1)}%</td>
              <td style={tdStyle({ color: "var(--text-3)" })}>{r.escalated_to_human}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function CreateExperimentForm({
  styles,
  onCreated,
  onError,
}: {
  styles: StyleSummary[];
  onCreated: () => void;
  onError: (msg: string) => void;
}) {
  const [slug, setSlug] = useState("");
  const [weights, setWeights] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const allocation: Record<string, number> = {};
      for (const [k, v] of Object.entries(weights)) {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) allocation[k] = n;
      }
      if (!slug.trim()) throw new Error("slug is required");
      if (Object.keys(allocation).length === 0)
        throw new Error("set at least one variant weight > 0");
      await api.createExperiment({
        slug: slug.trim(),
        allocation,
        status: "draft",
      });
      onCreated();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      style={{
        background: "var(--bg-1)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: 16,
        marginBottom: 20,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <label
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 4,
          fontSize: 12,
          color: "var(--text-3)",
        }}
      >
        slug (kebab-case)
        <input
          type="text"
          value={slug}
          onChange={(ev) => setSlug(ev.target.value)}
          placeholder="april-2026-recruit"
          style={inputStyle()}
        />
      </label>

      <div>
        <div
          style={{
            fontSize: 12,
            color: "var(--text-3)",
            marginBottom: 6,
          }}
        >
          variant weights (skip = 0):
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {styles.map((s) => (
            <label
              key={s.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 13,
              }}
            >
              <span
                style={{
                  flex: 1,
                  fontFamily: "var(--mono)",
                  color: "var(--text-2)",
                }}
              >
                {s.slug}
              </span>
              <input
                type="number"
                min="0"
                step="1"
                value={weights[s.slug] ?? ""}
                onChange={(ev) => setWeights((w) => ({ ...w, [s.slug]: ev.target.value }))}
                placeholder="0"
                style={{ ...inputStyle(), width: 80 }}
              />
            </label>
          ))}
        </div>
      </div>

      <button type="submit" disabled={submitting} style={btnStyle()}>
        {submitting ? "creating…" : "create as draft"}
      </button>
    </form>
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

function inputStyle(): React.CSSProperties {
  return {
    background: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    padding: "6px 10px",
    color: "var(--text)",
    fontSize: 13,
    fontFamily: "var(--mono)",
  };
}

function thStyle(): React.CSSProperties {
  return {
    padding: "6px 10px",
    textAlign: "left",
    fontWeight: 500,
    color: "var(--text-3)",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    fontSize: 10,
  };
}

function tdStyle(extra: React.CSSProperties = {}): React.CSSProperties {
  return { padding: "8px 10px", color: "var(--text)", ...extra };
}

import { useEffect, useState } from "react";
import { api } from "../api.ts";

type Window = "1h" | "24h" | "7d" | "30d";
type Data = Awaited<ReturnType<typeof api.analytics>>;

const PATH_COLORS: Record<string, string> = {
  ok: "var(--green, #2ea043)",
  smalltalk: "var(--text-3)",
  persona_fact: "var(--text-3)",
  no_context: "var(--amber, #d97706)",
  ungrounded: "var(--red, #ef4444)",
};

/**
 * RAG quality dashboard. Reads aggregates from
 * `messages.meta_json.telemetry` over a rolling window so operators can
 * see whether retrieval is healthy and which turns are hitting the
 * NO_CONTEXT escalation. Data appears only when the bot has answered at
 * least once in the chosen window — empty state explains that.
 */
export function Analytics() {
  const [window, setWindow] = useState<Window>("24h");
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .analytics(window)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [window]);

  return (
    <div style={{ padding: "24px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div>
          <h2 style={{ fontFamily: "var(--mono)", color: "var(--amber)", margin: 0 }}>Analytics</h2>
          <div
            style={{
              fontSize: 12,
              color: "var(--text-3)",
              marginTop: 4,
              fontFamily: "var(--mono)",
            }}
          >
            per-turn telemetry from messages.meta_json
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {(["1h", "24h", "7d", "30d"] as const).map((w) => (
            <button
              key={w}
              onClick={() => setWindow(w)}
              className={`btn btn-sm ${window === w ? "btn-primary" : "btn-ghost"}`}
              data-testid={`analytics-window-${w}`}
            >
              {w}
            </button>
          ))}
        </div>
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

      {loading && !data && <div className="loading-text">loading…</div>}

      {data && data.total_assistant_messages === 0 && (
        <Empty>
          За окно <code>{window}</code> бот не отвечал ни разу. Подожди пока кандидат напишет, или
          переключи окно на 7d / 30d.
        </Empty>
      )}

      {data && data.total_assistant_messages > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <SectionRow>
            <Card title="Total replies">
              <BigNumber value={data.total_assistant_messages} />
              <Hint>assistant turns with telemetry</Hint>
            </Card>
            <Card title="No-context rate" tone={noCtxTone(data)}>
              <BigNumber value={`${pct(noCtxCount(data), data.total_assistant_messages)}%`} />
              <Hint>turns that returned NO_CONTEXT (silent escalation)</Hint>
            </Card>
            <Card title="Ungrounded rate" tone={data.ungrounded_count > 0 ? "warn" : "ok"}>
              <BigNumber value={`${pct(data.ungrounded_count, data.total_assistant_messages)}%`} />
              <Hint>reflect dropped as ungrounded</Hint>
            </Card>
          </SectionRow>

          <SectionRow>
            <Card title="Total latency (ms)">
              <Latency stats={data.latency.total_ms} />
            </Card>
            <Card title="Retrieval (ms)">
              <Latency stats={data.latency.retrieval_ms} />
            </Card>
            <Card title="Generation (ms)">
              <Latency stats={data.latency.generation_ms} />
            </Card>
          </SectionRow>

          <Card title={`Path breakdown (${data.by_path.length})`}>
            <Distribution
              total={data.total_assistant_messages}
              rows={data.by_path.map((r) => ({
                key: r.path,
                count: r.count,
                color: PATH_COLORS[r.path] ?? "var(--text-2)",
              }))}
            />
          </Card>

          <SectionRow>
            <Card title={`Topic routing (${data.by_topic.length})`}>
              {data.by_topic.length === 0 ? (
                <Hint>
                  Topic routing не сработал ни разу — либо флаг выключен, либо вопросы ambiguous
                  (классификатор возвращал null → global поиск).
                </Hint>
              ) : (
                <Distribution
                  total={data.total_assistant_messages}
                  rows={data.by_topic.map((r) => ({
                    key: r.topic,
                    count: r.count,
                    color: "var(--amber, #d97706)",
                  }))}
                />
              )}
            </Card>
            <Card title="RAG layers usage">
              <KV
                label="hybrid retrieval"
                value={data.hybrid_count}
                total={data.total_assistant_messages}
              />
              <KV
                label="query rewrites"
                value={data.rewrite_count}
                total={data.total_assistant_messages}
              />
              <KV
                label="ungrounded (reflect)"
                value={data.ungrounded_count}
                total={data.total_assistant_messages}
              />
            </Card>
          </SectionRow>
        </div>
      )}
    </div>
  );
}

function noCtxCount(d: Data): number {
  return d.by_path.find((r) => r.path === "no_context")?.count ?? 0;
}

function noCtxTone(d: Data): "ok" | "warn" | "bad" {
  const r = noCtxCount(d) / Math.max(1, d.total_assistant_messages);
  if (r > 0.4) return "bad";
  if (r > 0.15) return "warn";
  return "ok";
}

function pct(n: number, total: number): string {
  if (total === 0) return "0";
  return ((n / total) * 100).toFixed(1);
}

function SectionRow({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
      {children}
    </div>
  );
}

function Card({
  title,
  children,
  tone,
}: {
  title: string;
  children: React.ReactNode;
  tone?: "ok" | "warn" | "bad";
}) {
  const borderColor =
    tone === "bad"
      ? "var(--red, #ef4444)"
      : tone === "warn"
        ? "var(--amber, #d97706)"
        : "var(--border)";
  return (
    <div
      style={{
        background: "var(--bg-1)",
        border: `1px solid ${borderColor}`,
        borderRadius: "var(--radius)",
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div
        style={{
          fontFamily: "var(--mono)",
          fontSize: 11,
          color: "var(--text-3)",
          textTransform: "uppercase",
          letterSpacing: 1,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function BigNumber({ value }: { value: string | number }) {
  return (
    <div style={{ fontSize: 28, fontWeight: 600, fontFamily: "var(--mono)", color: "var(--text)" }}>
      {value}
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, color: "var(--text-3)", lineHeight: 1.4 }}>{children}</div>;
}

function Latency({ stats }: { stats: Data["latency"]["total_ms"] }) {
  if (stats.count === 0) {
    return <Hint>no samples</Hint>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, fontFamily: "var(--mono)" }}>
      <Row label="p50" value={stats.p50} />
      <Row label="p95" value={stats.p95} />
      <Row label="p99" value={stats.p99} />
      <Row label="avg" value={stats.avg} />
      <Row label="n" value={stats.count} mono />
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: number | null; mono?: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        fontSize: 13,
        color: "var(--text-2)",
      }}
    >
      <span style={{ color: "var(--text-3)" }}>{label}</span>
      <span style={{ fontFamily: mono ? "var(--mono)" : "var(--mono)" }}>
        {value === null ? "—" : value}
      </span>
    </div>
  );
}

function Distribution({
  total,
  rows,
}: {
  total: number;
  rows: Array<{ key: string; count: number; color: string }>;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {rows.map((r) => {
        const w = Math.max(2, Math.round((r.count / Math.max(1, total)) * 100));
        return (
          <div key={r.key} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: 12,
                color: "var(--text-2)",
                fontFamily: "var(--mono)",
              }}
            >
              <span>{r.key}</span>
              <span style={{ color: "var(--text-3)" }}>
                {r.count} · {pct(r.count, total)}%
              </span>
            </div>
            <div
              style={{
                height: 6,
                background: "var(--border)",
                borderRadius: 3,
                overflow: "hidden",
              }}
            >
              <div style={{ width: `${w}%`, height: "100%", background: r.color }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function KV({ label, value, total }: { label: string; value: number; total: number }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        fontSize: 13,
        color: "var(--text-2)",
        fontFamily: "var(--mono)",
      }}
    >
      <span style={{ color: "var(--text-3)" }}>{label}</span>
      <span>
        {value} <span style={{ color: "var(--text-3)" }}>· {pct(value, total)}%</span>
      </span>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: 24,
        textAlign: "center",
        color: "var(--text-3)",
        fontStyle: "italic",
        background: "var(--bg-1)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
      }}
    >
      {children}
    </div>
  );
}

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

// Lead states in funnel order (rejected is a side-exit, shown last).
const LEAD_STATE_ORDER = [
  "intake_pending",
  "intake_complete",
  "approved",
  "partner_review",
  "docs_pending",
  "docs_complete",
  "submitted",
  "ready_to_work",
  "closed",
  "rejected",
] as const;

const LEAD_STATE_LABEL: Record<string, string> = {
  intake_pending: "заполнение анкеты",
  intake_complete: "ожидает решения",
  approved: "одобрено",
  partner_review: "ожидает апрув партнёров",
  docs_pending: "ожидание документов",
  docs_complete: "подача на документы",
  submitted: "подача на визу",
  ready_to_work: "готова к работе",
  closed: "закрыт",
  rejected: "отклонён",
};

const LEAD_STATE_COLOR: Record<string, string> = {
  intake_pending: "var(--text-3)",
  intake_complete: "var(--amber, #d97706)",
  approved: "var(--green, #2ea043)",
  partner_review: "var(--text-3)",
  docs_pending: "var(--text-3)",
  docs_complete: "var(--amber, #d97706)",
  submitted: "var(--green, #2ea043)",
  ready_to_work: "var(--green, #2ea043)",
  closed: "var(--text-2)",
  rejected: "var(--red, #ef4444)",
};

/**
 * Admin analytics dashboard. Three independent sections:
 *  - RAG quality (per-turn telemetry from `messages.meta_json`);
 *  - lead funnel (`leads` / `lead_events`);
 *  - activity trend (time-bucketed conversations / leads / answers).
 * The RAG section has its own empty state — the funnel and trend render
 * regardless of whether the bot answered in the chosen window.
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
          <h2 style={{ fontFamily: "var(--mono)", color: "var(--amber)", margin: 0 }}>Аналитика</h2>
          <div
            style={{
              fontSize: 12,
              color: "var(--text-3)",
              marginTop: 4,
              fontFamily: "var(--mono)",
            }}
          >
            качество RAG, воронка лидов и динамика за окно
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

      {loading && !data && <div className="loading-text">загрузка…</div>}

      {data && (
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <RagSection data={data} window={window} />
          <FunnelSection funnel={data.funnel} />
          <TrendSection trend={data.trend} />
        </div>
      )}
    </div>
  );
}

// ─── RAG quality ───────────────────────────────────────────────────────

function RagSection({ data, window }: { data: Data; window: Window }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <SectionTitle>Качество RAG</SectionTitle>
      {data.total_assistant_messages === 0 ? (
        <Empty>
          За окно <code>{window}</code> бот не отвечал ни разу. Подожди пока кандидат напишет, или
          переключи окно на 7d / 30d.
        </Empty>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <SectionRow>
            <Card title="Всего ответов">
              <BigNumber value={data.total_assistant_messages} />
              <Hint>ходов бота с телеметрией</Hint>
            </Card>
            <Card title="Без контекста" tone={noCtxTone(data)}>
              <BigNumber value={`${pct(noCtxCount(data), data.total_assistant_messages)}%`} />
              <Hint>ходы с NO_CONTEXT (тихая эскалация)</Hint>
            </Card>
            <Card title="Неподкреплённых" tone={data.ungrounded_count > 0 ? "warn" : "ok"}>
              <BigNumber value={`${pct(data.ungrounded_count, data.total_assistant_messages)}%`} />
              <Hint>fact-checker отбросил как ungrounded</Hint>
            </Card>
            <Card title="Без ответа" tone={(data.unanswered_rate ?? 0) > 0 ? "warn" : "ok"}>
              <BigNumber value={`${Math.round((data.unanswered_rate ?? 0) * 100)}%`} />
              <Hint>вопросы без ответа (no_context + ungrounded)</Hint>
            </Card>
          </SectionRow>

          <SectionRow>
            <Card title="Общая задержка (с)">
              <Latency stats={data.latency.total_ms} />
            </Card>
            <Card title="Поиск (с)">
              <Latency stats={data.latency.retrieval_ms} />
            </Card>
            <Card title="Генерация (с)">
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
            <Card title="Использование RAG">
              <KV
                label="гибридный поиск"
                value={data.hybrid_count}
                total={data.total_assistant_messages}
              />
              <KV
                label="перефразирование запроса"
                value={data.rewrite_count}
                total={data.total_assistant_messages}
              />
              <KV
                label="без подтверждения (fact-check)"
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

// ─── Lead funnel ───────────────────────────────────────────────────────

function FunnelSection({ funnel }: { funnel: Data["funnel"] }) {
  const totalLeads = Object.values(funnel.by_state).reduce((s, n) => s + n, 0);
  const rejReasonTotal = funnel.rejection_reasons.reduce((s, r) => s + r.count, 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <SectionTitle>Воронка лидов</SectionTitle>

      {totalLeads === 0 ? (
        <Empty>
          Лидов пока нет — здесь появится воронка, когда кандидаты начнут проходить анкету.
        </Empty>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <SectionRow>
            <Card title="Новые лиды">
              <BigNumber value={funnel.new_in_window} />
              <Hint>за выбранное окно</Hint>
            </Card>
            <Card title="Одобрено" tone="ok">
              <BigNumber value={funnel.decided.approved} />
              <Hint>решений за окно</Hint>
            </Card>
            <Card title="Отклонено" tone={funnel.decided.rejected > 0 ? "warn" : "ok"}>
              <BigNumber value={funnel.decided.rejected} />
              <Hint>решений за окно</Hint>
            </Card>
            <Card title="Подано">
              <BigNumber value={funnel.submitted_in_window} />
              <Hint>пакетов на визу за окно</Hint>
            </Card>
          </SectionRow>

          <Card title={`Лиды по состояниям · всего ${totalLeads}`}>
            <Distribution
              total={totalLeads}
              rows={LEAD_STATE_ORDER.filter((s) => (funnel.by_state[s] ?? 0) > 0).map((s) => ({
                key: LEAD_STATE_LABEL[s] ?? s,
                count: funnel.by_state[s] ?? 0,
                color: LEAD_STATE_COLOR[s] ?? "var(--text-2)",
              }))}
            />
          </Card>

          <SectionRow>
            <Card title={`Причины отказов (${funnel.rejection_reasons.length})`}>
              {funnel.rejection_reasons.length === 0 ? (
                <Hint>За окно отказов с указанной причиной не было.</Hint>
              ) : (
                <Distribution
                  total={rejReasonTotal}
                  rows={funnel.rejection_reasons.map((r) => ({
                    key: r.reason,
                    count: r.count,
                    color: "var(--red, #ef4444)",
                  }))}
                />
              )}
            </Card>
            <Card title="Среднее время в стадии">
              <KVRow
                label="до решения (одобр/отказ)"
                value={fmtDuration(funnel.avg_decision_seconds)}
              />
              {funnel.stage_dwell.length === 0 ? (
                <Hint>За окно переходов между стадиями не было.</Hint>
              ) : (
                funnel.stage_dwell
                  .slice()
                  .sort((a, b) => b.avg_seconds - a.avg_seconds)
                  .map((d) => (
                    <KVRow
                      key={d.state}
                      label={`${LEAD_STATE_LABEL[d.state] ?? d.state} (n=${d.n})`}
                      value={fmtDuration(d.avg_seconds)}
                    />
                  ))
              )}
            </Card>
          </SectionRow>
        </div>
      )}
    </div>
  );
}

// ─── Activity trend ────────────────────────────────────────────────────

function TrendSection({ trend }: { trend: Data["trend"] }) {
  const totals = trend.buckets.reduce(
    (acc, b) => ({
      conversations: acc.conversations + b.conversations,
      leads: acc.leads + b.leads,
      messages: acc.messages + b.messages,
    }),
    { conversations: 0, leads: 0, messages: 0 },
  );
  const daily = trend.bucket_seconds >= 24 * 60 * 60;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <SectionTitle>Динамика {daily ? "по дням" : "по часам"}</SectionTitle>
      <SectionRow>
        <Card title={`Новые диалоги · ${totals.conversations}`}>
          <MiniBars
            buckets={trend.buckets}
            pickValue={(b) => b.conversations}
            color="var(--amber, #d97706)"
            daily={daily}
          />
        </Card>
        <Card title={`Новые лиды · ${totals.leads}`}>
          <MiniBars
            buckets={trend.buckets}
            pickValue={(b) => b.leads}
            color="var(--green, #2ea043)"
            daily={daily}
          />
        </Card>
        <Card title={`Ответы бота · ${totals.messages}`}>
          <MiniBars
            buckets={trend.buckets}
            pickValue={(b) => b.messages}
            color="var(--text-2)"
            daily={daily}
          />
        </Card>
      </SectionRow>
    </div>
  );
}

function MiniBars({
  buckets,
  pickValue,
  color,
  daily,
}: {
  buckets: Data["trend"]["buckets"];
  pickValue: (b: Data["trend"]["buckets"][number]) => number;
  color: string;
  daily: boolean;
}) {
  const max = Math.max(1, ...buckets.map(pickValue));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 72 }}>
        {buckets.map((b) => {
          const v = pickValue(b);
          const h = v > 0 ? Math.max(3, Math.round((v / max) * 100)) : 0;
          return (
            <div
              key={b.start_unix}
              title={`${fmtBucket(b.start_unix, daily)} · ${v}`}
              style={{
                flex: 1,
                height: "100%",
                display: "flex",
                alignItems: "flex-end",
              }}
            >
              <div
                style={{
                  width: "100%",
                  height: `${h}%`,
                  background: color,
                  borderRadius: 2,
                }}
              />
            </div>
          );
        })}
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 10,
          color: "var(--text-3)",
          fontFamily: "var(--mono)",
        }}
      >
        <span>{buckets.length > 0 ? fmtBucket(buckets[0]!.start_unix, daily) : ""}</span>
        <span>
          {buckets.length > 0 ? fmtBucket(buckets[buckets.length - 1]!.start_unix, daily) : ""}
        </span>
      </div>
    </div>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────

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

function fmtDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)} с`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} мин`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} ч`;
  return `${(seconds / 86400).toFixed(1)} д`;
}

function fmtBucket(unix: number, daily: boolean): string {
  const d = new Date(unix * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (daily) return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontFamily: "var(--mono)",
        fontSize: 13,
        color: "var(--text-2)",
        textTransform: "uppercase",
        letterSpacing: 1,
        borderBottom: "1px solid var(--border)",
        paddingBottom: 6,
      }}
    >
      {children}
    </div>
  );
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
    return <Hint>нет данных</Hint>;
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
      <span style={{ fontFamily: "var(--mono)" }}>
        {value === null ? "—" : mono ? value : `${(value / 1000).toFixed(2)}с`}
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

function KVRow({ label, value }: { label: string; value: string }) {
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
      <span>{value}</span>
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

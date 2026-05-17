// Lightweight in-process metrics. Prometheus-text-format export at /metrics.
// Counters only — gauges/histograms cost more memory and we don't need them
// at current scale. Sample names follow Prometheus conventions
// (snake_case, _total suffix for counters).
//
// Use `inc(name, by, labels?)` from anywhere. The /metrics handler in
// src/app.ts renders the current snapshot. Single-process; multi-instance
// deployment would want a sidecar pusher or PostgreSQL counter table.

type LabelValues = Record<string, string | number>;

interface Counter {
  name: string;
  help: string;
  // Map key is "label1=value1,label2=value2"; "" when no labels.
  series: Map<string, number>;
}

const counters = new Map<string, Counter>();

function seriesKey(labels?: LabelValues): string {
  if (!labels) return "";
  const entries = Object.entries(labels)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => [k, String(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.map(([k, v]) => `${k}=${v}`).join(",");
}

export function registerCounter(name: string, help: string): void {
  if (!counters.has(name)) counters.set(name, { name, help, series: new Map() });
}

export function inc(name: string, by = 1, labels?: LabelValues): void {
  let c = counters.get(name);
  if (!c) {
    c = { name, help: name, series: new Map() };
    counters.set(name, c);
  }
  const key = seriesKey(labels);
  c.series.set(key, (c.series.get(key) ?? 0) + by);
}

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function renderLabels(key: string): string {
  if (key === "") return "";
  const parts = key.split(",").map((pair) => {
    const eq = pair.indexOf("=");
    const k = pair.slice(0, eq);
    const v = pair.slice(eq + 1);
    return `${k}="${escapeLabelValue(v)}"`;
  });
  return `{${parts.join(",")}}`;
}

export function renderPrometheus(): string {
  const out: string[] = [];
  for (const c of counters.values()) {
    out.push(`# HELP ${c.name} ${c.help}`);
    out.push(`# TYPE ${c.name} counter`);
    if (c.series.size === 0) {
      out.push(`${c.name} 0`);
    } else {
      for (const [labelKey, value] of c.series) {
        out.push(`${c.name}${renderLabels(labelKey)} ${value}`);
      }
    }
  }
  return out.join("\n") + (out.length > 0 ? "\n" : "");
}

// Pre-register well-known counters so /metrics has a useful baseline
// even before the first event.
registerCounter("tg_messages_total", "Telegram messages received via webhook or userbot");
registerCounter("tg_replies_total", "Replies sent to Telegram (bot API or userbot)");
registerCounter("rag_kb_hits_total", "RAG KB hits by path (ok/no_context/ungrounded)");
registerCounter("llm_errors_total", "LLM API call errors by provider");
registerCounter("lead_transitions_total", "Lead state transitions by to_state");
registerCounter("admin_requests_total", "Admin API requests by method+route");

/** Reset all counters — testing hook only. Not exported via the public API. */
export function __resetForTesting(): void {
  counters.clear();
  registerCounter("tg_messages_total", "Telegram messages received via webhook or userbot");
  registerCounter("tg_replies_total", "Replies sent to Telegram (bot API or userbot)");
  registerCounter("rag_kb_hits_total", "RAG KB hits by path (ok/no_context/ungrounded)");
  registerCounter("llm_errors_total", "LLM API call errors by provider");
  registerCounter("lead_transitions_total", "Lead state transitions by to_state");
  registerCounter("admin_requests_total", "Admin API requests by method+route");
}

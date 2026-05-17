import { useEffect, useState } from "react";
import { api, type SystemStatus } from "../api.ts";

/**
 * Operator-facing dashboard. Surfaces:
 *   - which RAG layers are currently enabled (env flags)
 *   - which chat / embedding provider + model is wired
 *   - vision model config + photo-classification stats
 *   - active routing (env override / running experiment / legacy persona)
 *   - KB stats with topic breakdown
 *   - conversation / user / message counters
 *   - signal whether memory and summary layers actually have data
 *
 * Read-only. Pulls from GET /admin/api/status — refreshed on mount and via
 * a small "refresh" button. No live websocket here on purpose: counts can
 * lag a few seconds without operator confusion, and we don't want every
 * dashboard view to add WS load.
 */
export function Status() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      setError(null);
      const data = await api.status();
      setStatus(data);
      setLoadedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  if (error && !status) {
    return (
      <div style={{ padding: 32, color: "var(--red, #ef4444)", fontFamily: "var(--mono)" }}>
        Failed to load status: {error}
      </div>
    );
  }
  if (!status) {
    return (
      <div className="loading-text" style={{ padding: 32 }}>
        loading…
      </div>
    );
  }

  return (
    <div style={{ padding: "24px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h2 style={{ fontFamily: "var(--mono)", color: "var(--amber)", margin: 0 }}>Статус</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {loadedAt && (
            <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-3)" }}>
              обновлено {new Date(loadedAt).toLocaleTimeString("ru-RU")}
            </span>
          )}
          <button onClick={refresh} className="btn btn-ghost btn-sm">
            обновить
          </button>
        </div>
      </div>

      {error && (
        <div style={{ color: "var(--red, #ef4444)", fontSize: 12, fontFamily: "var(--mono)" }}>
          {error}
        </div>
      )}

      <div style={gridStyle()}>
        <BotHealthCard status={status} />
        <RoutingCard status={status} />
        <RagFlagsCard status={status} />
        <ProvidersCard status={status} />
        <VisionCard status={status} />
        <OpenRouterCard status={status} />
        <KbCard status={status} />
        <LeadsCard status={status} />
        <VacanciesCard status={status} />
        <ConversationsCard status={status} />
        <UsersCard status={status} />
        <MessagesCard status={status} />
      </div>
    </div>
  );
}

function BotHealthCard({ status }: { status: SystemStatus }) {
  const h = status.bot_health;
  const ok = h.ok;
  const accent = ok ? "var(--green, #2ea043)" : "var(--red, #ef4444)";
  const checkedAgo = Math.max(0, Math.floor(Date.now() / 1000) - h.checked_at);
  return (
    <Card title="Bot health" accent={accent}>
      <Row
        label="status"
        value={
          <span style={{ color: accent, fontWeight: 600 }}>
            {ok ? "● connected" : "✗ unreachable"}
          </span>
        }
      />
      {ok ? (
        <>
          <Row label="username" value={h.username ? `@${h.username}` : "—"} mono />
          <Row label="first name" value={h.first_name ?? "—"} mono />
          <Row label="bot_id" value={String(h.bot_id)} mono />
        </>
      ) : (
        <Row label="error" value={<span style={{ color: accent }}>{h.error}</span>} mono />
      )}
      <Row label="last check" value={`${checkedAgo}s ago`} hint="cached 60s" />
      {!ok && (
        <div style={{ marginTop: 6, fontSize: 11, color: accent }}>
          ⚠ getMe failing — invalid TELEGRAM_BOT_TOKEN, bot deleted, or Telegram API down.
        </div>
      )}
    </Card>
  );
}

function RoutingCard({ status }: { status: SystemStatus }) {
  const { routing } = status;
  let summary = "";
  let detailLines: string[] = [];
  switch (routing.mode) {
    case "env_override":
      summary = `env-override → ${routing.active_style_slug}`;
      detailLines = [
        "BOT_SALES_STYLE is set in .env.",
        "All conversations use this style. Experiments are ignored.",
      ];
      break;
    case "running_experiment":
      summary = `experiment → ${routing.running_experiment_slug}`;
      detailLines = [
        "An experiment is running; new conversations get a deterministic per-user variant.",
        "Existing conversations keep their assigned style.",
      ];
      break;
    case "legacy_persona": {
      const p = routing.legacy_persona!;
      summary = `legacy persona → ${p.name}${p.company ? ` @ ${p.company}` : ""} (${p.role})`;
      detailLines = [
        "BOT_PERSONA_* env vars are set; sales-style engine is OFF.",
        "All conversations use the simpler persona prompt without funnel stages or hooks.",
      ];
      break;
    }
    case "none":
      summary = "no routing configured";
      detailLines = [
        "Neither BOT_SALES_STYLE nor BOT_PERSONA_NAME is set, and no experiment is running.",
        "The bot will reply with a generic AI-assistant persona.",
      ];
      break;
  }
  return (
    <Card title="Routing" accent="var(--amber)">
      <Row label="mode" value={routing.mode} />
      <Row label="active" value={summary} mono />
      <Row label="stage classifier" value={routing.stage_classifier} />
      {detailLines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: detail lines are derived deterministically from routing config — index is stable
        <div key={i} style={{ fontSize: 11, color: "var(--text-3)", marginTop: i === 0 ? 8 : 4 }}>
          {line}
        </div>
      ))}
    </Card>
  );
}

function RagFlagsCard({ status }: { status: SystemStatus }) {
  const flags: Array<[string, boolean, string]> = [
    ["userMemory", status.rag.userMemory, "RAG_USER_MEMORY"],
    ["queryRewrite", status.rag.queryRewrite, "RAG_QUERY_REWRITE"],
    ["reflect", status.rag.reflect, "RAG_REFLECT"],
    ["hybridSearch", status.rag.hybridSearch, "RAG_HYBRID_SEARCH"],
    ["conversationSummary", status.rag.conversationSummary, "RAG_CONVERSATION_SUMMARY"],
    ["topicRouting", status.rag.topicRouting, "RAG_TOPIC_ROUTING"],
  ];
  return (
    <Card title="RAG layers">
      {flags.map(([name, on, env]) => (
        <Row
          key={name}
          label={name}
          value={
            <span
              style={{
                color: on ? "var(--green, #2ea043)" : "var(--text-3)",
                fontWeight: on ? 600 : 400,
              }}
            >
              {on ? "ON" : "off"}
            </span>
          }
          hint={env}
        />
      ))}
      <Row label="topK" value={String(status.rag.topK)} hint="RAG_TOP_K" />
      <Row
        label="maxDistance"
        value={status.rag.maxDistance === null ? "—" : String(status.rag.maxDistance)}
        hint="RAG_MAX_DISTANCE"
      />
    </Card>
  );
}

function ProvidersCard({ status }: { status: SystemStatus }) {
  const { chat, embed } = status.providers;
  return (
    <Card title="Providers">
      <Row label="chat" value={`${chat.provider} / ${chat.model}`} mono />
      <Row label="embed" value={`${embed.provider} / ${embed.model}`} mono />
      <Row label="embed dim" value={String(embed.dim)} mono />
    </Card>
  );
}

function VisionCard({ status }: { status: SystemStatus }) {
  const v = status.vision;
  const keyMissing = v.enabled && !v.api_key_configured;
  const total =
    v.classified.passport + v.classified.full_body + v.classified.portrait + v.classified.other;
  return (
    <Card title="Vision" accent={keyMissing ? "var(--amber)" : undefined}>
      <Row
        label="enabled"
        value={
          <span
            style={{
              color: v.enabled ? "var(--green, #2ea043)" : "var(--text-3)",
              fontWeight: v.enabled ? 600 : 400,
            }}
          >
            {v.enabled ? "ON" : "off"}
          </span>
        }
        hint="VISION_ENABLED"
      />
      <Row label="model" value={`${v.provider} / ${v.model}`} mono hint="VISION_MODEL" />
      <Row
        label="api key"
        value={
          <span style={{ color: v.api_key_configured ? "var(--text)" : "var(--amber)" }}>
            {v.api_key_configured ? "configured" : "missing"}
          </span>
        }
        hint="OPENROUTER_API_KEY"
      />
      <div
        style={{
          marginTop: 10,
          fontSize: 10,
          color: "var(--text-3)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          fontFamily: "var(--mono)",
        }}
      >
        classified photos ({total})
      </div>
      <Row label="passport" value={String(v.classified.passport)} mono />
      <Row label="full_body" value={String(v.classified.full_body)} mono />
      <Row label="portrait" value={String(v.classified.portrait)} mono />
      <Row label="other" value={String(v.classified.other)} mono />
      <Row label="unclassified" value={String(v.unclassified)} mono />
      {keyMissing && (
        <div style={{ marginTop: 6, fontSize: 11, color: "var(--amber)" }}>
          ⚠ <code>VISION_ENABLED</code> включён, но <code>OPENROUTER_API_KEY</code> не задан —
          классификация фото отключена.
        </div>
      )}
    </Card>
  );
}

function KbCard({ status }: { status: SystemStatus }) {
  return (
    <Card title="Knowledge base">
      <Row label="total docs" value={String(status.kb.documents)} mono />
      <Row label="total chunks" value={String(status.kb.chunks)} mono />
      <Row label="active styles" value={String(status.kb.styles)} mono />
      {status.kb.by_topic.length > 0 && (
        <>
          <div
            style={{
              marginTop: 10,
              fontSize: 10,
              color: "var(--text-3)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              fontFamily: "var(--mono)",
            }}
          >
            by topic
          </div>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              marginTop: 4,
              fontFamily: "var(--mono)",
              fontSize: 12,
            }}
          >
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                <th style={thStyle()}>topic</th>
                <th style={thStyle()}>docs</th>
                <th style={thStyle()}>chunks</th>
              </tr>
            </thead>
            <tbody>
              {status.kb.by_topic.map((row) => (
                <tr key={row.topic ?? "_null"}>
                  <td style={tdStyle()}>
                    {row.topic ?? <i style={{ color: "var(--text-3)" }}>untagged</i>}
                  </td>
                  <td style={tdStyle()}>{row.documents}</td>
                  <td style={tdStyle()}>{row.chunks}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {status.rag.topicRouting && status.kb.by_topic.every((r) => r.topic === null) && (
        <div
          style={{
            marginTop: 8,
            fontSize: 11,
            color: "var(--amber)",
            fontFamily: "var(--mono)",
          }}
        >
          ⚠ topic routing is ON but no documents are tagged. Re-run ingest with --topic or under
          kb/&lt;topic&gt;/ to benefit from filtering.
        </div>
      )}
    </Card>
  );
}

function ConversationsCard({ status }: { status: SystemStatus }) {
  const summarized = status.conversations.with_summary;
  const sumPct =
    status.conversations.total > 0
      ? Math.round((summarized / status.conversations.total) * 100)
      : 0;
  return (
    <Card title="Conversations">
      <Row label="total" value={String(status.conversations.total)} mono />
      {Object.entries(status.conversations.by_mode).map(([mode, count]) => (
        <Row key={mode} label={mode} value={String(count)} mono />
      ))}
      {status.rag.conversationSummary && (
        <Row
          label="with summary"
          value={`${summarized} (${sumPct}%)`}
          mono
          hint="from summary_json"
        />
      )}
    </Card>
  );
}

function UsersCard({ status }: { status: SystemStatus }) {
  const memCount = status.users.with_memory;
  const memPct = status.users.total > 0 ? Math.round((memCount / status.users.total) * 100) : 0;
  return (
    <Card title="Users">
      <Row label="total" value={String(status.users.total)} mono />
      {Object.entries(status.users.by_status).map(([s, c]) => (
        <Row key={s} label={s} value={String(c)} mono />
      ))}
      {status.rag.userMemory && (
        <Row label="with memory" value={`${memCount} (${memPct}%)`} mono hint="extracted facts" />
      )}
    </Card>
  );
}

function LeadsCard({ status }: { status: SystemStatus }) {
  const c = status.leads.by_state;
  const ready = c.intake_complete;
  const inDocs = c.docs_pending;
  const forSubmit = c.docs_complete;
  const closed = c.rejected + c.closed;
  return (
    <Card title="Leads pipeline" accent="var(--amber)">
      {ready > 0 && (
        <Row
          label="ready for review"
          value={<span style={{ color: "var(--amber)", fontWeight: 600 }}>{ready}</span>}
          mono
        />
      )}
      <Row label="intake_pending" value={String(c.intake_pending)} mono />
      <Row label="approved → docs" value={String(inDocs)} mono />
      {forSubmit > 0 && (
        <Row
          label="ready for visa submit"
          value={
            <span style={{ color: "var(--green, #2ea043)", fontWeight: 600 }}>{forSubmit}</span>
          }
          mono
        />
      )}
      <Row label="submitted" value={String(c.submitted)} mono />
      <Row label="closed/rejected" value={String(closed)} mono />
      <div style={{ marginTop: 8, fontSize: 11, color: "var(--text-3)" }}>
        <a href="/admin/leads" style={{ color: "var(--amber)" }}>
          воронка →
        </a>
      </div>
      {!status.leads.leads_chat_configured && (
        <div style={{ marginTop: 6, fontSize: 11, color: "var(--amber)" }}>
          ⚠ <code>LEADS_CHAT_ID</code> не задан — карточки в TG-чат не постятся (только в админке).
        </div>
      )}
    </Card>
  );
}

function VacanciesCard({ status }: { status: SystemStatus }) {
  return (
    <Card title="Vacancies">
      <Row label="active" value={String(status.vacancies.active)} mono />
      <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 8 }}>
        Вставляются в RAG-контекст как АКТУАЛЬНЫЕ ВАКАНСИИ на каждом ходу.{" "}
        <a href="/admin/vacancies" style={{ color: "var(--amber)" }}>
          управление →
        </a>
      </div>
      {status.vacancies.active === 0 && (
        <div
          style={{
            marginTop: 6,
            fontSize: 11,
            color: "var(--text-3)",
          }}
        >
          Нет активных вакансий — бот отвечает только из KB.
        </div>
      )}
    </Card>
  );
}

function MessagesCard({ status }: { status: SystemStatus }) {
  return (
    <Card title="Messages">
      <Row label="total" value={String(status.messages.total)} mono />
      {Object.entries(status.messages.by_role).map(([role, count]) => (
        <Row key={role} label={role} value={String(count)} mono />
      ))}
    </Card>
  );
}

function OpenRouterCard({ status }: { status: SystemStatus }) {
  const or = status.openrouter;
  // Only shown when chat runs through OpenRouter.
  if (!or) return null;
  const { remaining } = or;
  const low = remaining != null && remaining < or.low_balance_usd;
  const accent = low
    ? "var(--red, #ef4444)"
    : remaining != null
      ? "var(--green, #2ea043)"
      : undefined;
  return (
    <Card title="Баланс OpenRouter" accent={accent}>
      <Row
        label="остаток"
        value={
          remaining != null ? (
            <span style={{ color: accent, fontWeight: 600 }}>${remaining.toFixed(2)}</span>
          ) : (
            "— (проверяется в фоне)"
          )
        }
        mono
      />
      <Row
        label="потрачено"
        value={or.total_usage != null ? `$${or.total_usage.toFixed(2)}` : "—"}
        mono
      />
      <Row label="порог алерта" value={`$${or.low_balance_usd}`} mono />
      {or.checked_at != null && (
        <Row label="проверено" value={new Date(or.checked_at * 1000).toLocaleString("ru-RU")} />
      )}
      {low && (
        <div style={{ marginTop: 6, fontSize: 11, color: accent }}>
          ⚠ Баланс заканчивается — пополните на openrouter.ai/credits
        </div>
      )}
    </Card>
  );
}

function Card({
  title,
  accent,
  children,
}: {
  title: string;
  accent?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        background: "var(--bg-1)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div
        style={{
          fontFamily: "var(--mono)",
          fontSize: 11,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: accent ?? "var(--text-3)",
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function Row({
  label,
  value,
  hint,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  mono?: boolean;
}) {
  return (
    <div
      style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" }}
    >
      <div
        style={{
          fontFamily: "var(--mono)",
          fontSize: 11,
          color: "var(--text-3)",
        }}
      >
        {label}
        {hint && <span style={{ marginLeft: 6, fontSize: 10, opacity: 0.7 }}>({hint})</span>}
      </div>
      <div
        style={{
          fontFamily: mono ? "var(--mono)" : "var(--sans)",
          fontSize: 12,
          color: "var(--text)",
          textAlign: "right",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function thStyle(): React.CSSProperties {
  return {
    padding: "6px 8px",
    textAlign: "left",
    fontWeight: 500,
    color: "var(--text-3)",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    fontSize: 10,
  };
}

function tdStyle(): React.CSSProperties {
  return { padding: "6px 8px", color: "var(--text)" };
}

function gridStyle(): React.CSSProperties {
  return {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
    gap: 16,
  };
}

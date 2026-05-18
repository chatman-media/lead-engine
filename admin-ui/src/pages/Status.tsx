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
        Не удалось загрузить статус: {error}
      </div>
    );
  }
  if (!status) {
    return (
      <div className="loading-text" style={{ padding: 32 }}>
        загрузка…
      </div>
    );
  }

  return (
    <div style={{ padding: "24px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h2 style={{ fontFamily: "var(--display)", color: "var(--text)", margin: 0 }}>Статус</h2>
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

/** Человекочитаемые подписи для режимов диалога. */
const MODE_LABEL: Record<string, string> = {
  ai: "бот",
  queued: "в очереди",
  human: "оператор",
};

/** Человекочитаемые подписи для ролей сообщений. */
const ROLE_LABEL: Record<string, string> = {
  user: "кандидат",
  assistant: "бот",
  human: "оператор",
  system: "система",
};

function BotHealthCard({ status }: { status: SystemStatus }) {
  const h = status.bot_health;
  const ok = h.ok;
  const accent = ok ? "var(--green, #2ea043)" : "var(--red, #ef4444)";
  const checkedAgo = Math.max(0, Math.floor(Date.now() / 1000) - h.checked_at);
  return (
    <Card title="Состояние бота" accent={accent}>
      <Row
        label="статус"
        value={
          <span style={{ color: accent, fontWeight: 600 }}>
            {ok ? "● на связи" : "✗ нет связи"}
          </span>
        }
      />
      {ok ? (
        <>
          <Row label="ник" value={h.username ? `@${h.username}` : "—"} mono />
          <Row label="имя" value={h.first_name ?? "—"} mono />
          <Row label="ID бота" value={String(h.bot_id)} mono />
        </>
      ) : (
        <Row label="ошибка" value={<span style={{ color: accent }}>{h.error}</span>} mono />
      )}
      <Row label="проверено" value={`${checkedAgo} с назад`} hint="кэш 60 с" />
      {!ok && (
        <div style={{ marginTop: 6, fontSize: 11, color: accent }}>
          ⚠ getMe не отвечает — неверный TELEGRAM_BOT_TOKEN, бот удалён или Telegram API недоступен.
        </div>
      )}
    </Card>
  );
}

/** Подпись для значения routing.mode. */
const ROUTING_MODE_LABEL: Record<string, string> = {
  env_override: "переопределение из .env",
  running_experiment: "эксперимент",
  legacy_persona: "устаревшая персона",
  none: "не настроено",
};

function RoutingCard({ status }: { status: SystemStatus }) {
  const { routing } = status;
  let summary = "";
  let detailLines: string[] = [];
  switch (routing.mode) {
    case "env_override":
      summary = `переопределение из .env → ${routing.active_style_slug}`;
      detailLines = [
        "BOT_SALES_STYLE задан в .env.",
        "Все диалоги используют этот стиль. Эксперименты игнорируются.",
      ];
      break;
    case "running_experiment":
      summary = `эксперимент → ${routing.running_experiment_slug}`;
      detailLines = [
        "Запущен эксперимент: новые диалоги получают детерминированный вариант для каждого пользователя.",
        "Существующие диалоги сохраняют назначенный стиль.",
      ];
      break;
    case "legacy_persona": {
      const p = routing.legacy_persona!;
      summary = `устаревшая персона → ${p.name}${p.company ? ` @ ${p.company}` : ""} (${p.role})`;
      detailLines = [
        "Заданы переменные BOT_PERSONA_*; движок стилей продаж выключен.",
        "Все диалоги используют упрощённый промпт персоны без этапов воронки и приёмов.",
      ];
      break;
    }
    case "none":
      summary = "маршрутизация не настроена";
      detailLines = [
        "Ни BOT_SALES_STYLE, ни BOT_PERSONA_NAME не заданы, эксперимент не запущен.",
        "Бот будет отвечать как обычный ИИ-ассистент.",
      ];
      break;
  }
  return (
    <Card title="Маршрутизация" accent="var(--amber)">
      <Row label="режим" value={ROUTING_MODE_LABEL[routing.mode] ?? routing.mode} />
      <Row label="активно" value={summary} mono />
      <Row label="классификатор этапа" value={routing.stage_classifier} />
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
    ["Память о собеседнике", status.rag.userMemory, "RAG_USER_MEMORY"],
    ["Переформулировка запроса", status.rag.queryRewrite, "RAG_QUERY_REWRITE"],
    ["Проверка фактов", status.rag.reflect, "RAG_REFLECT"],
    ["Гибридный поиск", status.rag.hybridSearch, "RAG_HYBRID_SEARCH"],
    ["Резюме диалога", status.rag.conversationSummary, "RAG_CONVERSATION_SUMMARY"],
    ["Поиск по темам", status.rag.topicRouting, "RAG_TOPIC_ROUTING"],
  ];
  return (
    <Card title="Слои поиска (RAG)">
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
              {on ? "вкл" : "выкл"}
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
    <Card title="Провайдеры ИИ">
      <Row label="чат-модель" value={`${chat.provider} / ${chat.model}`} mono />
      <Row label="эмбеддинги" value={`${embed.provider} / ${embed.model}`} mono />
      <Row label="размерность" value={String(embed.dim)} mono />
    </Card>
  );
}

function VisionCard({ status }: { status: SystemStatus }) {
  const v = status.vision;
  const keyMissing = v.enabled && !v.api_key_configured;
  const total =
    v.classified.passport +
    v.classified.internal_passport +
    v.classified.full_body +
    v.classified.portrait +
    v.classified.other;
  return (
    <Card title="Распознавание фото" accent={keyMissing ? "var(--amber)" : undefined}>
      <Row
        label="включено"
        value={
          <span
            style={{
              color: v.enabled ? "var(--green, #2ea043)" : "var(--text-3)",
              fontWeight: v.enabled ? 600 : 400,
            }}
          >
            {v.enabled ? "вкл" : "выкл"}
          </span>
        }
        hint="VISION_ENABLED"
      />
      <Row label="модель" value={`${v.provider} / ${v.model}`} mono hint="VISION_MODEL" />
      <Row
        label="ключ API"
        value={
          <span style={{ color: v.api_key_configured ? "var(--text)" : "var(--amber)" }}>
            {v.api_key_configured ? "задан" : "не задан"}
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
        распознано фото ({total})
      </div>
      <Row label="загранпаспорт" value={String(v.classified.passport)} mono />
      <Row label="внутренний паспорт" value={String(v.classified.internal_passport)} mono />
      <Row label="в полный рост" value={String(v.classified.full_body)} mono />
      <Row label="портрет" value={String(v.classified.portrait)} mono />
      <Row label="другое" value={String(v.classified.other)} mono />
      <Row label="не распознано" value={String(v.unclassified)} mono />
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
    <Card title="База знаний">
      <Row label="всего документов" value={String(status.kb.documents)} mono />
      <Row label="всего фрагментов" value={String(status.kb.chunks)} mono />
      <Row label="активных стилей" value={String(status.kb.styles)} mono />
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
            по темам
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
                <th style={thStyle()}>тема</th>
                <th style={thStyle()}>док-ты</th>
                <th style={thStyle()}>фрагменты</th>
              </tr>
            </thead>
            <tbody>
              {status.kb.by_topic.map((row) => (
                <tr key={row.topic ?? "_null"}>
                  <td style={tdStyle()}>
                    {row.topic ?? <i style={{ color: "var(--text-3)" }}>без темы</i>}
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
          ⚠ Поиск по темам включён, но у документов нет тегов. Перезапустите импорт с --topic или в
          kb/&lt;тема&gt;/, чтобы фильтрация работала.
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
    <Card title="Диалоги">
      <Row label="всего" value={String(status.conversations.total)} mono />
      {Object.entries(status.conversations.by_mode).map(([mode, count]) => (
        <Row key={mode} label={MODE_LABEL[mode] ?? mode} value={String(count)} mono />
      ))}
      {status.rag.conversationSummary && (
        <Row label="с резюме" value={`${summarized} (${sumPct}%)`} mono />
      )}
    </Card>
  );
}

function UsersCard({ status }: { status: SystemStatus }) {
  const memCount = status.users.with_memory;
  const memPct = status.users.total > 0 ? Math.round((memCount / status.users.total) * 100) : 0;
  return (
    <Card title="Пользователи">
      <Row label="всего" value={String(status.users.total)} mono />
      {Object.entries(status.users.by_status).map(([s, c]) => (
        <Row key={s} label={s} value={String(c)} mono />
      ))}
      {status.rag.userMemory && (
        <Row label="с памятью" value={`${memCount} (${memPct}%)`} mono hint="извлечённые факты" />
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
    <Card title="Воронка лидов" accent="var(--amber)">
      {ready > 0 && (
        <Row
          label="ждут решения"
          value={<span style={{ color: "var(--amber)", fontWeight: 600 }}>{ready}</span>}
          mono
        />
      )}
      <Row label="заполняют анкету" value={String(c.intake_pending)} mono />
      <Row label="оформляют документы" value={String(inDocs)} mono />
      {forSubmit > 0 && (
        <Row
          label="готовы к подаче"
          value={
            <span style={{ color: "var(--green, #2ea043)", fontWeight: 600 }}>{forSubmit}</span>
          }
          mono
        />
      )}
      <Row label="поданы" value={String(c.submitted)} mono />
      <Row label="закрыты/отклонены" value={String(closed)} mono />
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
    <Card title="Вакансии">
      <Row label="активных" value={String(status.vacancies.active)} mono />
      <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 8 }}>
        Вставляются в контекст бота как АКТУАЛЬНЫЕ ВАКАНСИИ на каждом ходу.{" "}
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
          Нет активных вакансий — бот отвечает только из базы знаний.
        </div>
      )}
    </Card>
  );
}

function MessagesCard({ status }: { status: SystemStatus }) {
  return (
    <Card title="Сообщения">
      <Row label="всего" value={String(status.messages.total)} mono />
      {Object.entries(status.messages.by_role).map(([role, count]) => (
        <Row key={role} label={ROLE_LABEL[role] ?? role} value={String(count)} mono />
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
        boxShadow: "var(--shadow-sm)",
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div
        style={{
          fontFamily: "var(--display)",
          fontSize: 17,
          fontWeight: 600,
          letterSpacing: "-0.01em",
          color: accent ?? "var(--text)",
          marginBottom: 8,
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
          fontFamily: "var(--sans)",
          fontSize: 12.5,
          color: "var(--text-2)",
        }}
      >
        {label}
        {hint && (
          <span style={{ marginLeft: 6, fontSize: 10, opacity: 0.7, fontFamily: "var(--mono)" }}>
            ({hint})
          </span>
        )}
      </div>
      <div
        style={{
          fontFamily: mono ? "var(--mono)" : "var(--sans)",
          fontSize: 13,
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

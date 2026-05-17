import { useEffect, useMemo, useState } from "react";
import { api, type SkillDto } from "../api.ts";

const FAMILY_LABELS: Record<SkillDto["family"], string> = {
  cialdini: "Cialdini — principles of influence",
  voss: "Voss — tactical empathy",
  nlp: "NLP — pacing / framing",
  sales: "Classical sales primitives",
  custom: "Custom — domain-specific",
};

const FAMILY_COLORS: Record<SkillDto["family"], string> = {
  cialdini: "var(--amber, #d97706)",
  voss: "var(--blue, #3b82f6)",
  nlp: "var(--green, #2ea043)",
  sales: "var(--text-2)",
  custom: "var(--text-3)",
};

/**
 * Read-only catalogue of persuasion / sales skills the bot can use,
 * grouped by family. Operators can globally disable a noisy skill via
 * the toggle — that hides it from prompt composition for ALL styles.
 *
 * Per-style attachment lives on the StyleDetail page.
 */
export function Skills() {
  const [list, setList] = useState<SkillDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | SkillDto["family"]>("all");

  async function refresh() {
    try {
      setError(null);
      const { skills } = await api.skills();
      setList(skills);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  const grouped = useMemo(() => {
    if (!list) return [];
    const filtered = filter === "all" ? list : list.filter((s) => s.family === filter);
    const families: SkillDto["family"][] = ["cialdini", "voss", "nlp", "sales", "custom"];
    return families
      .map((fam) => ({ family: fam, skills: filtered.filter((s) => s.family === fam) }))
      .filter((g) => g.skills.length > 0);
  }, [list, filter]);

  async function handleToggle(slug: string, enabled: boolean) {
    setError(null);
    try {
      await api.setSkillEnabled(slug, enabled);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div style={{ padding: "24px 32px", display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h2 style={{ fontFamily: "var(--mono)", color: "var(--amber)", margin: 0 }}>
          Persuasion skills
        </h2>
        <div
          style={{
            fontSize: 12,
            color: "var(--text-3)",
            marginTop: 4,
            fontFamily: "var(--mono)",
          }}
        >
          {list
            ? `${list.length} skills · ${list.filter((s) => s.is_enabled).length} enabled`
            : "загрузка…"}
        </div>
      </div>

      <p style={{ color: "var(--text-3)", fontSize: 12, margin: 0, lineHeight: 1.6 }}>
        Каталог приёмов влияния и продаж. Каждый стиль может подключить свой набор приёмов на
        странице стиля. Выключить здесь = убрать из промптов всех стилей сразу (полезно если приём
        оказался вредным или некультурным для текущей аудитории).
      </p>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {(["all", "cialdini", "voss", "nlp", "sales", "custom"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`btn btn-sm ${filter === f ? "btn-primary" : "btn-ghost"}`}
            data-testid={`skill-filter-${f}`}
          >
            {f === "all" ? "all families" : f}
          </button>
        ))}
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

      {!list && <div className="loading-text">загрузка…</div>}

      {grouped.map(({ family, skills }) => (
        <section key={family} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div
            style={{
              fontFamily: "var(--mono)",
              fontSize: 11,
              color: FAMILY_COLORS[family],
              textTransform: "uppercase",
              letterSpacing: 1,
            }}
          >
            {FAMILY_LABELS[family]} · {skills.length}
          </div>
          {skills.map((s) => (
            <SkillCard key={s.slug} skill={s} onToggle={(en) => handleToggle(s.slug, en)} />
          ))}
        </section>
      ))}
    </div>
  );
}

function winRateColor(rate: number | null): string {
  if (rate === null) return "var(--text-3)";
  if (rate >= 0.6) return "var(--green, #2ea043)";
  if (rate >= 0.3) return "var(--amber, #d97706)";
  return "var(--red, #ef4444)";
}

function SkillCard({ skill, onToggle }: { skill: SkillDto; onToggle: (enabled: boolean) => void }) {
  return (
    <div
      data-testid={`skill-card-${skill.slug}`}
      style={{
        background: "var(--bg-1)",
        border: "1px solid var(--border)",
        borderLeft: `3px solid ${FAMILY_COLORS[skill.family]}`,
        borderRadius: "var(--radius)",
        padding: 12,
        opacity: skill.is_enabled ? 1 : 0.55,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 12,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 14, color: "var(--text)" }}>
            {skill.display_name}
          </div>
          <div
            style={{
              fontSize: 11,
              color: "var(--text-3)",
              fontFamily: "var(--mono)",
              marginTop: 2,
              display: "flex",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <span>{skill.slug}</span>
            <span>intent: {skill.intent}</span>
            {skill.applicable_stages.length > 0 && (
              <span>stages: {skill.applicable_stages.join(", ")}</span>
            )}
            <span>used by {skill.attached_to_styles} styles</span>
            {skill.outcomes.count > 0 ? (
              <span style={{ color: winRateColor(skill.outcomes.win_rate) }}>
                {skill.outcomes.count} outcomes ·{" "}
                {skill.outcomes.win_rate !== null
                  ? `${(skill.outcomes.win_rate * 100).toFixed(0)}% win`
                  : "—"}{" "}
                ({skill.outcomes.wins}W / {skill.outcomes.losses}L / {skill.outcomes.draws}D)
              </span>
            ) : (
              <span style={{ color: "var(--text-3)" }}>no outcomes yet</span>
            )}
          </div>
        </div>
        <button
          onClick={() => onToggle(!skill.is_enabled)}
          className={`btn btn-sm ${skill.is_enabled ? "btn-ghost" : "btn-primary"}`}
          data-testid={`skill-toggle-${skill.slug}`}
        >
          {skill.is_enabled ? "disable" : "enable"}
        </button>
      </div>
      <div
        style={{
          marginTop: 8,
          fontSize: 13,
          color: "var(--text-2)",
          lineHeight: 1.5,
        }}
      >
        {skill.description}
      </div>
      <details style={{ marginTop: 8 }}>
        <summary
          style={{
            fontSize: 11,
            color: "var(--text-3)",
            fontFamily: "var(--mono)",
            cursor: "pointer",
          }}
        >
          prompt fragment
        </summary>
        <div
          style={{
            marginTop: 6,
            padding: 8,
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            fontFamily: "var(--mono)",
            fontSize: 12,
            color: "var(--text-2)",
            whiteSpace: "pre-wrap",
            lineHeight: 1.5,
          }}
        >
          {skill.prompt_fragment}
        </div>
      </details>
    </div>
  );
}

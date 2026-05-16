import { useEffect, useState } from "react";
import { api, type RuntimeSetting } from "../api.ts";
import { CONFIGURABLE_TABS, useTabVisibility } from "../useTabVisibility.ts";

const sectionLabelStyle: React.CSSProperties = {
  fontFamily: "var(--mono)",
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "var(--text-3)",
  marginBottom: 10,
};

const cardStyle: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  overflow: "hidden",
};

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; msg: string };

// ─── Bot parameters (runtime settings backed by the .env file) ──────────

function RuntimeSettingsSection() {
  const [settings, setSettings] = useState<RuntimeSetting[] | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [save, setSave] = useState<SaveState>({ kind: "idle" });

  function load() {
    api
      .getRuntimeSettings()
      .then((r) => {
        setSettings(r.settings);
        setDraft(Object.fromEntries(r.settings.map((s) => [s.key, s.value])));
      })
      .catch((err) =>
        setSave({ kind: "error", msg: err instanceof Error ? err.message : String(err) }),
      );
  }

  useEffect(() => {
    load();
  }, []);

  const changed: Record<string, string> = {};
  if (settings) {
    for (const s of settings) {
      if ((draft[s.key] ?? "") !== s.value) changed[s.key] = draft[s.key] ?? "";
    }
  }
  const dirty = Object.keys(changed).length > 0;

  async function persist() {
    if (!dirty) return;
    setSave({ kind: "saving" });
    try {
      await api.updateRuntimeSettings(changed);
      setSave({ kind: "saved" });
      load();
    } catch (err) {
      setSave({ kind: "error", msg: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <div style={{ maxWidth: 560, marginBottom: 32 }}>
      <div style={sectionLabelStyle}>Параметры бота</div>

      {settings === null ? (
        <div style={{ color: "var(--text-3)", fontSize: 13 }}>загрузка…</div>
      ) : (
        <>
          <div style={cardStyle}>
            {settings.map((s, i) => (
              <div
                key={s.key}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "space-between",
                  gap: 16,
                  padding: "12px 16px",
                  borderTop: i === 0 ? undefined : "1px solid var(--border)",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: "var(--text)", marginBottom: 3 }}>
                    {s.label}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-3)", lineHeight: 1.4 }}>
                    {s.hint}
                  </div>
                </div>

                {s.type === "boolean" ? (
                  <input
                    type="checkbox"
                    checked={draft[s.key] === "1"}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, [s.key]: e.target.checked ? "1" : "0" }))
                    }
                    style={{
                      width: 16,
                      height: 16,
                      cursor: "pointer",
                      accentColor: "var(--accent)",
                      flexShrink: 0,
                      marginTop: 2,
                    }}
                  />
                ) : (
                  <input
                    type={s.type === "number" ? "number" : "text"}
                    value={draft[s.key] ?? ""}
                    placeholder="по умолчанию"
                    onChange={(e) => setDraft((d) => ({ ...d, [s.key]: e.target.value }))}
                    style={{
                      width: s.type === "number" ? 90 : 230,
                      flexShrink: 0,
                      fontFamily: "var(--mono)",
                      fontSize: 12,
                      padding: "5px 8px",
                    }}
                  />
                )}
              </div>
            ))}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12 }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={persist}
              disabled={!dirty || save.kind === "saving"}
            >
              {save.kind === "saving" ? "Сохранение…" : "Сохранить"}
            </button>
            {save.kind === "saved" && (
              <span style={{ fontSize: 12, color: "var(--text-3)" }}>
                Сохранено. Изменения применятся после перезапуска бота.
              </span>
            )}
            {save.kind === "error" && (
              <span style={{ fontSize: 12, color: "var(--red, #ef4444)" }}>{save.msg}</span>
            )}
            {save.kind === "idle" && dirty && (
              <span style={{ fontSize: 12, color: "var(--text-3)" }}>
                Применится после перезапуска бота.
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────

export function Settings() {
  const { visible, setTab } = useTabVisibility();

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-title">Настройки</div>
      </div>

      <RuntimeSettingsSection />

      <div style={{ maxWidth: 560 }}>
        <div style={sectionLabelStyle}>Вкладки в меню</div>

        <div style={cardStyle}>
          {CONFIGURABLE_TABS.map(({ key, label }, i) => (
            <label
              key={key}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "11px 16px",
                borderTop: i === 0 ? undefined : "1px solid var(--border)",
                cursor: "pointer",
                userSelect: "none",
              }}
            >
              <span
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 13,
                  color: "var(--text)",
                }}
              >
                {label}
              </span>
              <input
                type="checkbox"
                checked={visible(key)}
                onChange={(e) => setTab(key, e.target.checked)}
                style={{ width: 16, height: 16, cursor: "pointer", accentColor: "var(--accent)" }}
              />
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

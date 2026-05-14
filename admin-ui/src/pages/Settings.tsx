import { CONFIGURABLE_TABS, useTabVisibility } from "../useTabVisibility.ts";

export function Settings() {
  const { visible, setTab } = useTabVisibility();

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-title">Settings</div>
      </div>

      <div style={{ maxWidth: 480 }}>
        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 11,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--text-3)",
            marginBottom: 10,
          }}
        >
          Sidebar tabs
        </div>

        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            overflow: "hidden",
          }}
        >
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

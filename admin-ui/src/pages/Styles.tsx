import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type StyleSummary } from "../api.ts";

export function Styles() {
  const [styles, setStyles] = useState<StyleSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cloneFrom, setCloneFrom] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    api
      .styles()
      .then((res) => {
        setStyles(res.styles);
        // Default the dropdown to the first style so "+ Create" is one click.
        if (res.styles.length > 0 && !cloneFrom) setCloneFrom(res.styles[0]!.slug);
      })
      .catch((err) => setError(err.message ?? String(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ padding: "24px 32px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 4,
        }}
      >
        <h2
          style={{
            fontFamily: "var(--display)",
            color: "var(--text)",
            margin: 0,
          }}
        >
          Sales styles
        </h2>

        {styles && styles.length > 0 ? (
          <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}>
            <span style={{ color: "var(--text-3)", fontFamily: "var(--mono)" }}>clone from:</span>
            <select
              value={cloneFrom}
              onChange={(e) => setCloneFrom(e.target.value)}
              style={{
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius)",
                color: "var(--text)",
                padding: "4px 8px",
                fontSize: 12,
                fontFamily: "var(--mono)",
              }}
            >
              {styles.map((s) => (
                <option key={s.id} value={s.slug}>
                  {s.slug}
                </option>
              ))}
            </select>
            <button
              onClick={() => navigate(`/admin/styles/new?from=${encodeURIComponent(cloneFrom)}`)}
              disabled={!cloneFrom}
              style={{
                padding: "5px 12px",
                background: "transparent",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius)",
                color: "var(--text-2)",
                fontFamily: "var(--mono)",
                fontSize: 12,
                cursor: cloneFrom ? "pointer" : "default",
                opacity: cloneFrom ? 1 : 0.4,
              }}
            >
              + new style
            </button>
          </div>
        ) : null}
      </div>
      <p style={{ color: "var(--text-3)", fontSize: 13, marginBottom: 20 }}>
        Personas + sales frameworks + Cialdini hooks composed into the system prompt at runtime.
        Click any row to view + edit. New styles are created by cloning an existing one as a
        template — pick a template above and change slug + displayName + tone in the editor.
      </p>

      {error ? (
        <div style={{ color: "var(--red, #f55)" }}>error: {error}</div>
      ) : styles === null ? (
        <div style={{ color: "var(--text-3)" }}>загрузка…</div>
      ) : styles.length === 0 ? (
        <div style={{ color: "var(--text-3)" }}>
          no styles in DB — they should be auto-seeded on next server boot.
        </div>
      ) : (
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: 13,
            fontFamily: "var(--mono)",
          }}
        >
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <Th>id</Th>
              <Th>slug</Th>
              <Th>name</Th>
              <Th>version</Th>
              <Th>created</Th>
            </tr>
          </thead>
          <tbody>
            {styles.map((s) => (
              <tr
                key={s.id}
                style={{
                  borderBottom: "1px solid var(--border)",
                  transition: "background 0.1s",
                }}
              >
                <Td>{s.id}</Td>
                <Td>
                  <Link
                    to={`/admin/styles/${s.id}`}
                    style={{ color: "var(--amber)", textDecoration: "none" }}
                  >
                    {s.slug}
                  </Link>
                </Td>
                <Td>{s.display_name}</Td>
                <Td>v{s.version}</Td>
                <Td style={{ color: "var(--text-3)" }}>
                  {new Date(s.created_at * 1000).toISOString().slice(0, 10)}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Th(props: { children: React.ReactNode }) {
  return (
    <th
      style={{
        padding: "8px 12px",
        textAlign: "left",
        fontWeight: 500,
        color: "var(--text-3)",
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        fontSize: 11,
      }}
    >
      {props.children}
    </th>
  );
}

function Td(props: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <td style={{ padding: "10px 12px", color: "var(--text)", ...(props.style ?? {}) }}>
      {props.children}
    </td>
  );
}

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type StyleSummary } from "../api.ts";

export function Styles() {
  const [styles, setStyles] = useState<StyleSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .styles()
      .then((res) => setStyles(res.styles))
      .catch((err) => setError(err.message ?? String(err)));
  }, []);

  return (
    <div style={{ padding: "24px 32px" }}>
      <h2 style={{ fontFamily: "var(--mono)", color: "var(--amber)", marginTop: 0 }}>
        Sales styles
      </h2>
      <p style={{ color: "var(--text-3)", fontSize: 13, marginBottom: 20 }}>
        Personas + sales frameworks + Cialdini hooks composed into the system
        prompt at runtime. Read-only here; edits go through SQL or a future
        editor.
      </p>

      {error ? (
        <div style={{ color: "var(--red, #f55)" }}>error: {error}</div>
      ) : styles === null ? (
        <div style={{ color: "var(--text-3)" }}>loading…</div>
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

function Td(props: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <td style={{ padding: "10px 12px", color: "var(--text)", ...(props.style ?? {}) }}>
      {props.children}
    </td>
  );
}

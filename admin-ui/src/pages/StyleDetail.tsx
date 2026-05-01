import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type StyleDetail as StyleDetailT } from "../api.ts";

export function StyleDetail() {
  const { id } = useParams();
  const [style, setStyle] = useState<StyleDetailT | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    api
      .style(Number(id))
      .then((res) => setStyle(res.style))
      .catch((err) => setError(err.message ?? String(err)));
  }, [id]);

  return (
    <div style={{ padding: "24px 32px" }}>
      <Link
        to="/admin/styles"
        style={{ color: "var(--text-3)", fontSize: 12, textDecoration: "none" }}
      >
        ← styles
      </Link>

      {error ? (
        <div style={{ color: "var(--red, #f55)", marginTop: 16 }}>
          error: {error}
        </div>
      ) : style === null ? (
        <div style={{ color: "var(--text-3)", marginTop: 16 }}>loading…</div>
      ) : (
        <>
          <h2
            style={{
              fontFamily: "var(--mono)",
              color: "var(--amber)",
              marginTop: 12,
            }}
          >
            {style.slug}
          </h2>
          <div
            style={{
              color: "var(--text-2)",
              fontSize: 14,
              marginBottom: 16,
            }}
          >
            {style.display_name}
            <span
              style={{
                marginLeft: 12,
                color: "var(--text-3)",
                fontFamily: "var(--mono)",
                fontSize: 12,
              }}
            >
              v{style.version} · id={style.id}
              {!style.is_active ? " · inactive" : ""}
            </span>
          </div>

          {style.parse_error ? (
            <pre
              style={{
                background: "var(--bg-1)",
                border: "1px solid var(--red, #f55)",
                color: "var(--red, #f55)",
                padding: 12,
                borderRadius: "var(--radius)",
                fontSize: 12,
                whiteSpace: "pre-wrap",
              }}
            >
              {`Zod validation failed:\n${style.parse_error}\n\nRaw JSON:\n${style.config_raw}`}
            </pre>
          ) : (
            <pre
              style={{
                background: "var(--bg-1)",
                border: "1px solid var(--border)",
                color: "var(--text)",
                padding: 16,
                borderRadius: "var(--radius)",
                fontSize: 12,
                fontFamily: "var(--mono)",
                whiteSpace: "pre-wrap",
                overflow: "auto",
                maxHeight: "70vh",
              }}
            >
              {JSON.stringify(style.config, null, 2)}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

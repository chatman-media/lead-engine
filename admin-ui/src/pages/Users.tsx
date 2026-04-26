import { useEffect, useState } from "react";
import { api, type User } from "../api.ts";

const STATUS_COLOR: Record<string, string> = {
  new: "var(--text-3)",
  questionnaire_pending: "var(--blue)",
  qualified: "var(--amber)",
  won: "var(--green)",
  lost: "var(--red)",
};

function ts(unix: number) {
  return new Date(unix * 1000).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function Users() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .users()
      .then(({ users }) => setUsers(users))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div style={{ padding: "28px 32px" }} className="fade-in">
      <h1
        style={{
          fontFamily: "var(--mono)",
          fontSize: 14,
          fontWeight: 600,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "var(--text-2)",
          marginBottom: 20,
        }}
      >
        Users —{" "}
        <span style={{ color: "var(--text)" }} data-testid="user-count">
          {users.length}
        </span>
      </h1>

      {loading ? (
        <div style={{ color: "var(--text-3)", fontFamily: "var(--mono)" }}>
          loading…
        </div>
      ) : (
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontFamily: "var(--mono)",
            fontSize: 12,
          }}
          data-testid="users-table"
        >
          <thead>
            <tr>
              {["tg_id", "username", "status", "registered"].map((h) => (
                <th
                  key={h}
                  style={{
                    textAlign: "left",
                    padding: "6px 12px",
                    color: "var(--text-3)",
                    fontWeight: 500,
                    letterSpacing: "0.05em",
                    borderBottom: "1px solid var(--border)",
                    textTransform: "uppercase",
                    fontSize: 10,
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr
                key={u.id}
                style={{ borderBottom: "1px solid var(--border)" }}
              >
                <td style={cellStyle}>{u.tg_user_id}</td>
                <td style={{ ...cellStyle, color: "var(--text-2)" }}>
                  {u.tg_username ? `@${u.tg_username}` : "—"}
                </td>
                <td style={cellStyle}>
                  <span
                    style={{
                      color: STATUS_COLOR[u.status] ?? "var(--text-3)",
                      fontWeight: 500,
                    }}
                  >
                    {u.status}
                  </span>
                </td>
                <td style={{ ...cellStyle, color: "var(--text-3)" }}>
                  {ts(u.created_at)}
                </td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr>
                <td
                  colSpan={4}
                  style={{
                    ...cellStyle,
                    color: "var(--text-3)",
                    textAlign: "center",
                    padding: 32,
                  }}
                >
                  No users yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

const cellStyle: React.CSSProperties = {
  padding: "10px 12px",
  color: "var(--text)",
};

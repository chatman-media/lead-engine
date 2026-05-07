import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type User } from "../api.ts";

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
    <div className="page fade-in">
      <div className="page-header">
        <span className="page-title">Users</span>
        <span className="page-count" data-testid="user-count">
          — {users.length}
        </span>
      </div>

      {loading ? (
        <div className="loading-text">loading…</div>
      ) : (
        <table className="data-table" data-testid="users-table">
          <thead>
            <tr>
              {["tg_id", "username", "status", "registered"].map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  <Link
                    to={`/admin/users/${u.id}`}
                    style={{ color: "var(--amber)", fontFamily: "var(--mono)" }}
                  >
                    {u.tg_user_id}
                  </Link>
                </td>
                <td style={{ color: "var(--text-2)" }}>
                  {u.tg_username ? `@${u.tg_username}` : "—"}
                </td>
                <td>
                  <span className={`status-${u.status}`} style={{ fontWeight: 500 }}>
                    {u.status}
                  </span>
                </td>
                <td style={{ color: "var(--text-3)" }}>{ts(u.created_at)}</td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr>
                <td colSpan={4} className="empty" style={{ padding: 32 }}>
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

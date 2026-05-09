import { useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { type Admin, api } from "./api.ts";
import { Layout } from "./components/Layout.tsx";
import { Analytics } from "./pages/Analytics.tsx";
import { Chat } from "./pages/Chat.tsx";
import { Chats } from "./pages/Chats.tsx";
import { Experiments } from "./pages/Experiments.tsx";
import { Kb } from "./pages/Kb.tsx";
import { Leads } from "./pages/Leads.tsx";
import { Library } from "./pages/Library.tsx";
import { Login } from "./pages/Login.tsx";
import { NewStyle } from "./pages/NewStyle.tsx";
import { Skills } from "./pages/Skills.tsx";
import { Status } from "./pages/Status.tsx";
import { StyleDetail } from "./pages/StyleDetail.tsx";
import { Styles } from "./pages/Styles.tsx";
import { UserDetail } from "./pages/UserDetail.tsx";
import { Users } from "./pages/Users.tsx";
import { Vacancies } from "./pages/Vacancies.tsx";
import { AdminWs } from "./ws.ts";

export const ws = new AdminWs();

interface AuthState {
  loading: boolean;
  admin: Admin | null;
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({ loading: true, admin: null });
  const navigate = useNavigate();

  useEffect(() => {
    api
      .me()
      .then(({ admin }) => {
        setState({ loading: false, admin });
        ws.connect();
      })
      .catch(() => {
        setState({ loading: false, admin: null });
        navigate("/admin/login", { replace: true });
      });
  }, [navigate]);

  if (state.loading) {
    return (
      <div
        style={{
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text-3)",
          fontFamily: "var(--mono)",
        }}
      >
        connecting…
      </div>
    );
  }

  if (!state.admin) return null;

  return <Layout admin={state.admin}>{children}</Layout>;
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/admin/login" element={<Login />} />
        <Route
          path="/admin/*"
          element={
            <AuthGate>
              <Routes>
                <Route index element={<Navigate to="status" replace />} />
                <Route path="status" element={<Status />} />
                <Route path="analytics" element={<Analytics />} />
                <Route path="skills" element={<Skills />} />
                <Route path="chats" element={<Chats />} />
                <Route path="chats/:id" element={<Chat />} />
                <Route path="users" element={<Users />} />
                <Route path="users/:id" element={<UserDetail />} />
                <Route path="leads" element={<Leads />} />
                <Route path="vacancies" element={<Vacancies />} />
                <Route path="kb" element={<Kb />} />
                <Route path="library" element={<Library />} />
                <Route path="styles" element={<Styles />} />
                <Route path="styles/new" element={<NewStyle />} />
                <Route path="styles/:id" element={<StyleDetail />} />
                <Route path="experiments" element={<Experiments />} />
                <Route path="*" element={<Navigate to="status" replace />} />
              </Routes>
            </AuthGate>
          }
        />
        <Route path="*" element={<Navigate to="/admin/chats" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

import { useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { getToken, saas } from "./api/saas.ts";
import { SaasChannels } from "./pages/SaasChannels.tsx";
import { SaasDashboard } from "./pages/SaasDashboard.tsx";
import { SaasLogin } from "./pages/SaasLogin.tsx";
import { SaasSettings } from "./pages/SaasSettings.tsx";
import { SaasSignup } from "./pages/SaasSignup.tsx";

/**
 * SaaS routing — заменяет легаси 24-страничный admin под старый
 * tg-chatbot backend. Текущий scope: signup / login / dashboard
 * (KB upload + list). Дополнительные страницы (conversations, leads,
 * etc.) будут добавляться по мере wire-up'а соответствующих
 * /api/admin/* endpoint'ов.
 *
 * Token хранится в localStorage (см. api/saas.ts). AuthGate проверяет
 * /api/auth/me на mount; 401 → редирект на /login. Stateless server-
 * side — token живёт 30 дней.
 */
function AuthGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<"checking" | "auth" | "anon">("checking");
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    const token = getToken();
    if (!token) {
      setStatus("anon");
      navigate("/login", { replace: true });
      return;
    }
    saas
      .me()
      .then(() => {
        if (!cancelled) setStatus("auth");
      })
      .catch(() => {
        if (!cancelled) {
          setStatus("anon");
          navigate("/login", { replace: true });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  if (status === "checking") {
    return <div className="auth-checking">Проверяем сессию…</div>;
  }
  if (status === "anon") return null;
  return <>{children}</>;
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<SaasLogin />} />
        <Route path="/signup" element={<SaasSignup />} />
        <Route
          path="/dashboard"
          element={
            <AuthGate>
              <SaasDashboard />
            </AuthGate>
          }
        />
        <Route
          path="/settings"
          element={
            <AuthGate>
              <SaasSettings />
            </AuthGate>
          }
        />
        <Route
          path="/channels"
          element={
            <AuthGate>
              <SaasChannels />
            </AuthGate>
          }
        />
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

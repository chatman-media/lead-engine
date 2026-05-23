import { useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { AppShell } from "@/components/app-shell";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { getToken, saas } from "./api/saas.ts";
import { SaasAcceptInvite } from "./pages/SaasAcceptInvite.tsx";
import { SaasAudit } from "./pages/SaasAudit.tsx";
import { SaasBilling } from "./pages/SaasBilling.tsx";
import { SaasChannels } from "./pages/SaasChannels.tsx";
import { SaasConversations } from "./pages/SaasConversations.tsx";
import { SaasDashboard } from "./pages/SaasDashboard.tsx";
import { SaasDiagnostics } from "./pages/SaasDiagnostics.tsx";
import { SaasExperiments } from "./pages/SaasExperiments.tsx";
import { SaasFunnel } from "./pages/SaasFunnel.tsx";
import { SaasLeadDetail } from "./pages/SaasLeadDetail.tsx";
import { SaasLeads } from "./pages/SaasLeads.tsx";
import { SaasLogin } from "./pages/SaasLogin.tsx";
import { SaasOnboarding } from "./pages/SaasOnboarding.tsx";
import { SaasSettings } from "./pages/SaasSettings.tsx";
import { SaasSignup } from "./pages/SaasSignup.tsx";
import { SaasSkills } from "./pages/SaasSkills.tsx";
import { SaasStyles } from "./pages/SaasStyles.tsx";
import { SaasTeam } from "./pages/SaasTeam.tsx";
import { SaasVacancies } from "./pages/SaasVacancies.tsx";
import { SaasHooks } from "./pages/SaasHooks.tsx";

/**
 * SaaS routing. Token в localStorage (api/saas.ts). AuthGate проверяет
 * /api/auth/me на mount; 401 → /login. Authed-страницы рендерятся внутри
 * AppShell (левый сайдбар + шапка). Onboarding — full-screen без шелла.
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
    return (
      <div className="grid min-h-screen place-items-center text-sm text-muted-foreground">
        Проверяем сессию…
      </div>
    );
  }
  if (status === "anon") return null;
  return <>{children}</>;
}

/** Authed-страница в шелле (сайдбар + шапка). */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <AuthGate>
      <AppShell>{children}</AppShell>
    </AuthGate>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<SaasLogin />} />
          <Route path="/signup" element={<SaasSignup />} />
          <Route path="/accept-invite" element={<SaasAcceptInvite />} />
          <Route
            path="/onboarding"
            element={
              <AuthGate>
                <SaasOnboarding />
              </AuthGate>
            }
          />
          <Route
            path="/dashboard"
            element={
              <Shell>
                <SaasDashboard />
              </Shell>
            }
          />
          <Route
            path="/settings"
            element={
              <Shell>
                <SaasSettings />
              </Shell>
            }
          />
          <Route
            path="/channels"
            element={
              <Shell>
                <SaasChannels />
              </Shell>
            }
          />
          <Route
            path="/conversations"
            element={
              <Shell>
                <SaasConversations />
              </Shell>
            }
          />
          <Route
            path="/conversations/:id"
            element={
              <Shell>
                <SaasConversations />
              </Shell>
            }
          />
          <Route
            path="/audit"
            element={
              <Shell>
                <SaasAudit />
              </Shell>
            }
          />
          <Route
            path="/diagnostics"
            element={
              <Shell>
                <SaasDiagnostics />
              </Shell>
            }
          />
          <Route
            path="/team"
            element={
              <Shell>
                <SaasTeam />
              </Shell>
            }
          />
          <Route
            path="/leads"
            element={<Shell><SaasLeads /></Shell>}
          />
          <Route
            path="/leads/:id"
            element={<Shell><SaasLeadDetail /></Shell>}
          />
          <Route
            path="/funnel"
            element={<Shell><SaasFunnel /></Shell>}
          />
          <Route
            path="/skills"
            element={<Shell><SaasSkills /></Shell>}
          />
          <Route
            path="/styles"
            element={<Shell><SaasStyles /></Shell>}
          />
          <Route
            path="/experiments"
            element={<Shell><SaasExperiments /></Shell>}
          />
          <Route
            path="/vacancies"
            element={<Shell><SaasVacancies /></Shell>}
          />
          <Route
            path="/hooks"
            element={<Shell><SaasHooks /></Shell>}
          />
          <Route
            path="/billing"
            element={<Shell><SaasBilling /></Shell>}
          />
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </BrowserRouter>
      <Toaster />
    </ThemeProvider>
  );
}

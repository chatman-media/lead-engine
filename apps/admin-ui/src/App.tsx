import { useEffect, useState } from "react";
import { BrowserRouter, Navigate, Outlet, Route, Routes } from "react-router-dom";
import { AppShell } from "@/components/app-shell";
import { CopilotProvider } from "@/components/copilot";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { getToken, saas } from "./api/saas.ts";
import { useAdminEvents } from "./hooks/useAdminEvents.ts";
import { toast } from "sonner";
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
import { SaasReferral } from "./pages/SaasReferral.tsx";
import { SaasWebhooks } from "./pages/SaasWebhooks.tsx";
import { SaasOutreach } from "./pages/SaasOutreach.tsx";
import { SaasForgotPassword } from "./pages/SaasForgotPassword.tsx";
import { SaasResetPassword } from "./pages/SaasResetPassword.tsx";
import { SaasSuperadmin } from "./pages/SaasSuperadmin.tsx";
import { SaasNotifications } from "./pages/SaasNotifications.tsx";
import { SaasTestBot } from "./pages/SaasTestBot.tsx";
import { SaasExchange } from "./pages/SaasExchange.tsx";
import { ToolsSettings } from "./pages/ToolsSettings.tsx";

function RequireAuth() {
  const [status, setStatus] = useState<"checking" | "auth" | "anon">(() =>
    getToken() ? "checking" : "anon",
  );

  useEffect(() => {
    if (status !== "checking") return;
    let cancelled = false;
    saas
      .me()
      .then(() => { if (!cancelled) setStatus("auth"); })
      .catch(() => { if (!cancelled) setStatus("anon"); });
    return () => { cancelled = true; };
  }, []);

  if (status === "checking") return null;
  if (status === "anon") return <Navigate to="/login" replace />;
  return <Outlet />;
}

function ShellLayout() {
  useAdminEvents((event) => {
    if (event.type === "new_message") {
      toast.info("Новое сообщение", {
        description: event.preview ?? undefined,
        duration: 4000,
      });
    } else if (event.type === "stage_changed") {
      toast.info(`Стадия изменена → ${event.toStageDisplayName}`, { duration: 3000 });
    }
  });

  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, "") || "/"}>
        <CopilotProvider>
          <Routes>
          {/* Публичные */}
          <Route path="/login" element={<SaasLogin />} />
          <Route path="/signup" element={<SaasSignup />} />
          <Route path="/accept-invite" element={<SaasAcceptInvite />} />
          <Route path="/forgot-password" element={<SaasForgotPassword />} />
          <Route path="/reset-password" element={<SaasResetPassword />} />

          {/* Только для авторизованных */}
          <Route element={<RequireAuth />}>
            <Route path="/onboarding" element={<SaasOnboarding />} />

            {/* С сайдбаром */}
            <Route element={<ShellLayout />}>
              <Route index element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<SaasDashboard />} />
              <Route path="/leads" element={<SaasLeads />} />
              <Route path="/leads/:id" element={<SaasLeadDetail />} />
              <Route path="/outreach" element={<SaasOutreach />} />
              <Route path="/conversations" element={<SaasConversations />} />
              <Route path="/conversations/:id" element={<SaasConversations />} />
              <Route path="/funnel" element={<SaasFunnel />} />
              <Route path="/exchange" element={<SaasExchange />} />
              <Route path="/vacancies" element={<SaasVacancies />} />
              <Route path="/skills" element={<SaasSkills />} />
              <Route path="/hooks" element={<SaasHooks />} />
              <Route path="/webhooks" element={<SaasWebhooks />} />
              <Route path="/styles" element={<SaasStyles />} />
              <Route path="/experiments" element={<SaasExperiments />} />
              <Route path="/channels" element={<SaasChannels />} />
              <Route path="/billing" element={<SaasBilling />} />
              <Route path="/settings" element={<SaasSettings />} />
              <Route path="/referral" element={<SaasReferral />} />
              <Route path="/tools" element={<ToolsSettings />} />
              <Route path="/team" element={<SaasTeam />} />
              <Route path="/audit" element={<SaasAudit />} />
              <Route path="/diagnostics" element={<SaasDiagnostics />} />
              <Route path="/test" element={<SaasTestBot />} />
              <Route path="/notifications" element={<SaasNotifications />} />
              <Route path="/superadmin" element={<SaasSuperadmin />} />
            </Route>
          </Route>

          {/* Платформенный superadmin — публичный роут, авторизация через sa_token */}
          <Route path="/superadmin" element={<SaasSuperadmin />} />

          <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </CopilotProvider>
      </BrowserRouter>
      <Toaster />
    </ThemeProvider>
  );
}

import { useEffect, useState } from "react";
import { BrowserRouter, Navigate, Outlet, Route, Routes } from "react-router-dom";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { CopilotProvider } from "@/components/copilot";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { getToken, saas } from "./api/saas.ts";
import { useAdminEvents } from "./hooks/useAdminEvents.ts";
import { SaasAcceptInvite } from "./pages/SaasAcceptInvite.tsx";
import { SaasAudit } from "./pages/SaasAudit.tsx";
import { SaasBilling } from "./pages/SaasBilling.tsx";
import { SaasCampaigns } from "./pages/SaasCampaigns.tsx";
import { SaasChannels } from "./pages/SaasChannels.tsx";
import { SaasConversations } from "./pages/SaasConversations.tsx";
import { SaasDashboard } from "./pages/SaasDashboard.tsx";
import { SaasDiagnostics } from "./pages/SaasDiagnostics.tsx";
import { SaasExchange } from "./pages/SaasExchange.tsx";
import { SaasExperiments } from "./pages/SaasExperiments.tsx";
import { SaasFaq } from "./pages/SaasFaq.tsx";
import { SaasForgotPassword } from "./pages/SaasForgotPassword.tsx";
import { SaasFunnel } from "./pages/SaasFunnel.tsx";
import { SaasHooks } from "./pages/SaasHooks.tsx";
import { SaasIntegrations } from "./pages/SaasIntegrations.tsx";
import { SaasLeadDetail } from "./pages/SaasLeadDetail.tsx";
import { SaasLeads } from "./pages/SaasLeads.tsx";
import { SaasLogin } from "./pages/SaasLogin.tsx";
import { SaasNotifications } from "./pages/SaasNotifications.tsx";
import { SaasOnboarding } from "./pages/SaasOnboarding.tsx";
import { SaasOutreach } from "./pages/SaasOutreach.tsx";
import { SaasPartners } from "./pages/SaasPartners.tsx";
import SaasProfile from "./pages/SaasProfile.tsx";
import { SaasProviderOrders } from "./pages/SaasProviderOrders.tsx";
import { SaasProviders } from "./pages/SaasProviders.tsx";
import { SaasQuality } from "./pages/SaasQuality.tsx";
import { SaasReferral } from "./pages/SaasReferral.tsx";
import { SaasResetPassword } from "./pages/SaasResetPassword.tsx";
import { SaasServiceCatalog } from "./pages/SaasServiceCatalog.tsx";
import { SaasSettings } from "./pages/SaasSettings.tsx";
import { SaasSkills } from "./pages/SaasSkills.tsx";
import { SaasStyles } from "./pages/SaasStyles.tsx";
import { SaasSuperadmin } from "./pages/SaasSuperadmin.tsx";
import { SaasTeam } from "./pages/SaasTeam.tsx";
import { SaasTestBot } from "./pages/SaasTestBot.tsx";
import { SaasVacancies } from "./pages/SaasVacancies.tsx";

function RequireAuth() {
  const [status, setStatus] = useState<"checking" | "auth" | "anon">(() =>
    getToken() ? "checking" : "anon",
  );

  useEffect(() => {
    if (status !== "checking") return;
    let cancelled = false;
    saas
      .me()
      .then(() => {
        if (!cancelled) setStatus("auth");
      })
      .catch(() => {
        if (!cancelled) setStatus("anon");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (status === "checking") return null;
  if (status === "anon") return <Navigate to="/login" replace />;
  return <Outlet />;
}

/**
 * Гейт онбординга. Читает один флаг `done` из onboarding-status и редиректит:
 *  - require="done": кабинет — если !done, шлёт на /onboarding.
 *  - require="not-done": /onboarding — если done, шлёт на /dashboard.
 * Оба гейта читают ОДИН флаг с противоположной логикой → петли нет.
 * При ошибке статуса fail-open (считаем done), чтобы не запереть пользователя.
 */
function OnboardingGate({ require }: { require: "done" | "not-done" }) {
  const [state, setState] = useState<"checking" | "done" | "not-done">("checking");

  useEffect(() => {
    let cancelled = false;
    saas
      .onboardingStatus()
      .then((s) => {
        if (!cancelled) setState(s.done ? "done" : "not-done");
      })
      .catch(() => {
        if (!cancelled) setState("done"); // fail-open
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === "checking") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="size-6 animate-spin rounded-full border-2 border-muted border-t-primary" />
      </div>
    );
  }
  if (require === "done" && state === "not-done") return <Navigate to="/onboarding" replace />;
  if (require === "not-done" && state === "done") return <Navigate to="/dashboard" replace />;
  return <Outlet />;
}

function RequireSuperadmin() {
  const [state, setState] = useState<"checking" | "allowed" | "forbidden">("checking");

  useEffect(() => {
    let cancelled = false;
    saas
      .me()
      .then((res) => {
        if (!cancelled) {
          setState(res.admin.role === "superadmin" ? "allowed" : "forbidden");
        }
      })
      .catch(() => {
        if (!cancelled) setState("forbidden");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === "checking") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="size-6 animate-spin rounded-full border-2 border-muted border-t-primary" />
      </div>
    );
  }
  if (state === "forbidden") return <Navigate to="/dashboard" replace />;
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
            {/* Публичные (регистрация закрыта — только login + invite) */}
            <Route path="/login" element={<SaasLogin />} />
            <Route path="/accept-invite" element={<SaasAcceptInvite />} />
            <Route path="/forgot-password" element={<SaasForgotPassword />} />
            <Route path="/reset-password" element={<SaasResetPassword />} />

            {/* Только для авторизованных */}
            <Route element={<RequireAuth />}>
              {/* Онбординг: доступен пока НЕ завершён; иначе → /dashboard */}
              <Route element={<OnboardingGate require="not-done" />}>
                <Route path="/onboarding" element={<SaasOnboarding />} />
              </Route>

              {/* Кабинет: доступен только когда онбординг завершён; иначе → /onboarding */}
              <Route element={<OnboardingGate require="done" />}>
                <Route element={<ShellLayout />}>
                  <Route index element={<Navigate to="/dashboard" replace />} />
                  <Route path="/dashboard" element={<SaasDashboard />} />
                  <Route path="/leads" element={<SaasLeads />} />
                  <Route path="/leads/:id" element={<SaasLeadDetail />} />
                  <Route path="/conversations" element={<SaasConversations />} />
                  <Route path="/conversations/:id" element={<SaasConversations />} />
                  <Route path="/orders" element={<SaasProviderOrders />} />
                  <Route path="/exchange" element={<SaasExchange />} />
                  <Route path="/profile" element={<SaasProfile />} />
                  <Route path="/notifications" element={<SaasNotifications />} />
                  <Route path="/quality" element={<SaasQuality />} />
                  <Route element={<RequireSuperadmin />}>
                    <Route path="/outreach" element={<SaasOutreach />} />
                    <Route path="/campaigns" element={<SaasCampaigns />} />
                    <Route path="/funnel" element={<SaasFunnel />} />
                    <Route path="/services" element={<SaasServiceCatalog />} />
                    <Route path="/vacancies" element={<SaasVacancies />} />
                    <Route path="/skills" element={<SaasSkills />} />
                    <Route path="/hooks" element={<SaasHooks />} />
                    <Route path="/styles" element={<SaasStyles />} />
                    <Route path="/experiments" element={<SaasExperiments />} />
                    <Route path="/channels" element={<SaasChannels />} />
                    <Route path="/billing" element={<SaasBilling />} />
                    <Route path="/settings" element={<SaasSettings />} />
                    <Route
                      path="/settings/channels"
                      element={<Navigate to="/channels" replace />}
                    />
                    <Route path="/partners" element={<SaasPartners />} />
                    <Route path="/providers" element={<SaasProviders />} />
                    <Route path="/referral" element={<SaasReferral />} />
                    <Route path="/integrations" element={<SaasIntegrations />} />
                    <Route path="/faq" element={<SaasFaq />} />
                    <Route path="/team" element={<SaasTeam />} />
                    <Route path="/audit" element={<SaasAudit />} />
                    <Route path="/diagnostics" element={<SaasDiagnostics />} />
                    <Route path="/test" element={<SaasTestBot />} />
                    <Route path="/superadmin" element={<SaasSuperadmin />} />
                  </Route>
                </Route>
              </Route>
            </Route>

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </CopilotProvider>
      </BrowserRouter>
      <Toaster />
    </ThemeProvider>
  );
}

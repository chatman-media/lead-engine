import {
  ActivityIcon,
  BarChart2Icon,
  BriefcaseIcon,
  CableIcon,
  DatabaseIcon,
  FlaskConicalIcon,
  GitBranchIcon,
  LogOutIcon,
  type LucideIcon,
  MenuIcon,
  MessagesSquareIcon,
  RocketIcon,
  ScrollTextIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  UsersIcon,
  UserCircleIcon,
  ZapIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { type Admin, clearToken, saas, type Tenant } from "@/api/saas";
import { ModeToggle } from "@/components/mode-toggle";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

const NAV: NavItem[] = [
  { to: "/leads", label: "Лиды", icon: UserCircleIcon },
  { to: "/conversations", label: "Диалоги", icon: MessagesSquareIcon },
  { to: "/funnel", label: "Воронка", icon: GitBranchIcon },
  { to: "/vacancies", label: "Вакансии", icon: BriefcaseIcon },
  { to: "/dashboard", label: "База знаний", icon: DatabaseIcon },
  { to: "/skills", label: "Навыки", icon: ZapIcon },
  { to: "/styles", label: "Стили", icon: SparklesIcon },
  { to: "/experiments", label: "Эксперименты", icon: FlaskConicalIcon },
  { to: "/channels", label: "Каналы", icon: CableIcon },
  { to: "/billing", label: "LLM-использование", icon: BarChart2Icon },
  { to: "/settings", label: "Настройки LLM", icon: SlidersHorizontalIcon },
  { to: "/team", label: "Команда", icon: UsersIcon },
  { to: "/audit", label: "Аудит", icon: ScrollTextIcon },
  { to: "/diagnostics", label: "Диагностика", icon: ActivityIcon },
];

function Brand() {
  return (
    <Link to="/dashboard" className="flex items-center gap-2.5 px-2 py-1">
      <span className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-primary to-chart-5 text-primary-foreground shadow-[0_4px_16px_-4px_var(--primary)]">
        <RocketIcon className="size-4" />
      </span>
      <span className="text-[15px] font-semibold tracking-tight">
        lead<span className="text-primary">·</span>engine
      </span>
    </Link>
  );
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const { pathname } = useLocation();
  return (
    <nav className="flex flex-col gap-0.5">
      {NAV.map(({ to, label, icon: Icon }) => {
        const active = pathname === to || pathname.startsWith(`${to}/`);
        return (
          <NavLink
            key={to}
            to={to}
            onClick={onNavigate}
            className={cn(
              "group relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors",
              active
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground",
            )}
          >
            {active && (
              <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-primary" />
            )}
            <Icon className="size-4 shrink-0" />
            {label}
          </NavLink>
        );
      })}
    </nav>
  );
}

function SidebarBody({
  admin,
  tenant,
  onLogout,
  onNavigate,
}: {
  admin: Admin | null;
  tenant: Tenant | null;
  onLogout: () => void;
  onNavigate?: () => void;
}) {
  const initials = (admin?.email ?? "?").slice(0, 2).toUpperCase();
  return (
    <div className="flex h-full flex-col gap-1">
      <div className="flex h-14 items-center border-b border-sidebar-border px-3">
        <Brand />
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-4">
        <p className="px-2.5 pb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
          Рабочее пространство
        </p>
        <NavLinks onNavigate={onNavigate} />

        <p className="mt-6 px-2.5 pb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
          Настройка
        </p>
        <NavLink
          to="/onboarding"
          onClick={onNavigate}
          className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent/50 hover:text-foreground"
        >
          <RocketIcon className="size-4 shrink-0" />
          Начало работы
        </NavLink>
      </div>

      <div className="border-t border-sidebar-border p-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center gap-2.5 rounded-md p-1.5 text-left transition-colors hover:bg-sidebar-accent/60"
            >
              <Avatar className="size-8 rounded-lg">
                <AvatarFallback className="rounded-lg bg-primary/15 text-primary">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{admin?.email ?? "—"}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {tenant?.slug ?? "—"} · {tenant?.plan ?? "free"}
                </p>
              </div>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-56">
            <DropdownMenuLabel className="font-normal">
              <p className="text-sm font-medium">{admin?.email}</p>
              <p className="text-xs text-muted-foreground">
                {admin?.role === "superadmin" ? "Суперадмин" : "Менеджер"} · {tenant?.slug}
              </p>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onLogout}>
              <LogOutIcon /> Выйти
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const [admin, setAdmin] = useState<Admin | null>(null);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    saas
      .me()
      .then((res) => {
        if (cancelled) return;
        setAdmin(res.admin);
        setTenant(res.tenant);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleLogout() {
    try {
      await saas.logout();
    } catch {
      // ignore
    }
    clearToken();
    navigate("/login", { replace: true });
  }

  return (
    <div className="flex min-h-screen">
      <aside className="bg-sidebar text-sidebar-foreground sticky top-0 hidden h-screen w-64 shrink-0 border-r border-sidebar-border md:block">
        <SidebarBody admin={admin} tenant={tenant} onLogout={handleLogout} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="bg-background/70 sticky top-0 z-30 flex h-14 items-center gap-2 border-b px-4 backdrop-blur-xl md:px-8">
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="md:hidden" aria-label="Меню">
                <MenuIcon className="size-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 p-0">
              <SheetTitle className="sr-only">Навигация</SheetTitle>
              <SidebarBody
                admin={admin}
                tenant={tenant}
                onLogout={handleLogout}
                onNavigate={() => setMobileOpen(false)}
              />
            </SheetContent>
          </Sheet>

          <div className="md:hidden">
            <Brand />
          </div>

          <div className="ml-auto flex items-center gap-1">
            <ModeToggle />
          </div>
        </header>

        <main className="flex-1 px-4 py-6 md:px-8 md:py-8">
          <div className="mx-auto w-full max-w-6xl">{children}</div>
        </main>
      </div>
    </div>
  );
}

import {
  ActivityIcon,
  BarChart2Icon,
  BriefcaseIcon,
  CableIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  DatabaseIcon,
  FlaskConicalIcon,
  GitBranchIcon,
  LinkIcon,
  LogOutIcon,
  WrenchIcon,
  type LucideIcon,
  MenuIcon,
  MessagesSquareIcon,
  PaletteIcon,
  RocketIcon,
  ScrollTextIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  UsersIcon,
  UserCircleIcon,
  ZapIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Работа",
    items: [
      { to: "/leads", label: "Лиды", icon: UserCircleIcon },
      { to: "/conversations", label: "Диалоги", icon: MessagesSquareIcon },
      { to: "/funnel", label: "Воронка", icon: GitBranchIcon },
      { to: "/vacancies", label: "Вакансии", icon: BriefcaseIcon },
    ],
  },
  {
    label: "AI & Бот",
    items: [
      { to: "/dashboard", label: "База знаний", icon: DatabaseIcon },
      { to: "/skills", label: "Навыки", icon: ZapIcon },
      { to: "/hooks", label: "Хуки", icon: SparklesIcon },
      { to: "/styles", label: "Стили", icon: PaletteIcon },
      { to: "/experiments", label: "Эксперименты", icon: FlaskConicalIcon },
    ],
  },
  {
    label: "Система",
    items: [
      { to: "/channels", label: "Каналы", icon: CableIcon },
      { to: "/tools", label: "Инструменты", icon: WrenchIcon },
      { to: "/referral", label: "Партнёры", icon: LinkIcon },
      { to: "/team", label: "Команда", icon: UsersIcon },
      { to: "/billing", label: "LLM-использование", icon: BarChart2Icon },
      { to: "/settings", label: "Настройки LLM", icon: SlidersHorizontalIcon },
      { to: "/audit", label: "Аудит", icon: ScrollTextIcon },
      { to: "/diagnostics", label: "Диагностика", icon: ActivityIcon },
    ],
  },
];

// Items shown in Система by default; the rest are behind "Ещё"
const SISTEMA_ALWAYS_VISIBLE = ["/channels", "/team"];

function Brand({ collapsed }: { collapsed?: boolean }) {
  return (
    <Link to="/dashboard" className="flex items-center gap-2.5 px-2 py-1 min-w-0">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-primary to-chart-5 text-primary-foreground shadow-[0_4px_16px_-4px_var(--primary)]">
        <RocketIcon className="size-4" />
      </span>
      {!collapsed && (
        <span className="text-[15px] font-semibold tracking-tight truncate">
          lead<span className="text-primary">·</span>engine
        </span>
      )}
    </Link>
  );
}

function NavItemLink({
  item,
  collapsed,
  badge,
  onNavigate,
}: {
  item: NavItem;
  collapsed: boolean;
  badge?: number | null;
  onNavigate?: () => void;
}) {
  const { pathname } = useLocation();
  const active = pathname === item.to || pathname.startsWith(`${item.to}/`);
  const { icon: Icon, label, to } = item;

  const link = (
    <NavLink
      to={to}
      onClick={onNavigate}
      className={cn(
        "group relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors",
        collapsed ? "justify-center px-2" : "",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground",
      )}
    >
      {active && !collapsed && (
        <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-primary" />
      )}
      <Icon className="size-4 shrink-0" />
      {!collapsed && (
        <>
          <span className="flex-1">{label}</span>
          {(badge ?? 0) > 0 && (
            <span className="ml-auto grid min-w-[18px] place-items-center rounded-full bg-amber-500 px-1 py-0.5 text-[10px] font-bold leading-none text-white">
              {badge}
            </span>
          )}
        </>
      )}
      {collapsed && (badge ?? 0) > 0 && (
        <span className="absolute right-1 top-1 size-2 rounded-full bg-amber-500" />
      )}
    </NavLink>
  );

  if (!collapsed) return link;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right" className="text-xs">
        {label}
        {(badge ?? 0) > 0 && <span className="ml-1 text-amber-500">({badge})</span>}
      </TooltipContent>
    </Tooltip>
  );
}

function NavLinks({
  onNavigate,
  escalatedCount,
  collapsed,
}: {
  onNavigate?: () => void;
  escalatedCount?: number;
  collapsed: boolean;
}) {
  const [sistemaExpanded, setSistemaExpanded] = useState(false);
  const { pathname } = useLocation();

  // Auto-expand Система if current route is one of the hidden items
  useEffect(() => {
    const sistemaGroup = NAV_GROUPS.find((g) => g.label === "Система");
    const hiddenItems = sistemaGroup?.items.filter((i) => !SISTEMA_ALWAYS_VISIBLE.includes(i.to));
    if (hiddenItems?.some((i) => pathname === i.to || pathname.startsWith(`${i.to}/`))) {
      setSistemaExpanded(true);
    }
  }, [pathname]);

  return (
    <nav className="flex flex-col gap-4">
      {NAV_GROUPS.map((group) => {
        const isSistema = group.label === "Система";
        const visibleItems = isSistema && !sistemaExpanded
          ? group.items.filter((i) => SISTEMA_ALWAYS_VISIBLE.includes(i.to))
          : group.items;
        const hiddenCount = isSistema ? group.items.length - SISTEMA_ALWAYS_VISIBLE.length : 0;

        return (
          <div key={group.label} className="flex flex-col gap-0.5">
            {!collapsed && (
              <p className="px-2.5 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
                {group.label}
              </p>
            )}
            {collapsed && <div className="mx-auto h-px w-6 bg-sidebar-border my-1" />}

            {visibleItems.map((item) => (
              <NavItemLink
                key={item.to}
                item={item}
                collapsed={collapsed}
                badge={item.to === "/conversations" ? escalatedCount : null}
                onNavigate={onNavigate}
              />
            ))}

            {isSistema && !collapsed && (
              <button
                type="button"
                onClick={() => setSistemaExpanded((v) => !v)}
                className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground/70 transition-colors hover:text-muted-foreground"
              >
                {sistemaExpanded ? (
                  <>
                    <ChevronLeftIcon className="size-3" /> Скрыть
                  </>
                ) : (
                  <>
                    <ChevronRightIcon className="size-3" /> Ещё {hiddenCount}
                  </>
                )}
              </button>
            )}
          </div>
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
  escalatedCount,
  collapsed,
  onToggleCollapse,
}: {
  admin: Admin | null;
  tenant: Tenant | null;
  onLogout: () => void;
  onNavigate?: () => void;
  escalatedCount?: number;
  collapsed: boolean;
  onToggleCollapse?: () => void;
}) {
  const initials = (admin?.email ?? "?").slice(0, 2).toUpperCase();
  return (
    <div className="flex h-full flex-col gap-1">
      <div className="flex h-14 items-center border-b border-sidebar-border px-3 gap-2">
        <div className="flex-1 min-w-0">
          <Brand collapsed={collapsed} />
        </div>
        {onToggleCollapse && (
          <button
            type="button"
            onClick={onToggleCollapse}
            className="shrink-0 grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent/50 hover:text-foreground"
            aria-label={collapsed ? "Развернуть меню" : "Свернуть меню"}
          >
            {collapsed ? <ChevronRightIcon className="size-4" /> : <ChevronLeftIcon className="size-4" />}
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-4">
        <NavLinks onNavigate={onNavigate} escalatedCount={escalatedCount} collapsed={collapsed} />
      </div>

      <div className="border-t border-sidebar-border p-3 space-y-1">
        <div className={cn("flex items-center", collapsed ? "justify-center" : "justify-end px-1")}>
          <ModeToggle />
        </div>
        {collapsed ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onLogout}
                className="flex w-full justify-center rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground"
              >
                <Avatar className="size-7 rounded-lg">
                  <AvatarFallback className="rounded-lg bg-primary/15 text-primary text-[10px]">
                    {initials}
                  </AvatarFallback>
                </Avatar>
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" className="text-xs">
              {admin?.email}
            </TooltipContent>
          </Tooltip>
        ) : (
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
        )}
      </div>
    </div>
  );
}

const COLLAPSED_KEY = "sidebar-collapsed";

export function AppShell({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const [admin, setAdmin] = useState<Admin | null>(null);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [escalatedCount, setEscalatedCount] = useState(0);
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(COLLAPSED_KEY) === "true",
  );

  function toggleCollapse() {
    setCollapsed((v) => {
      localStorage.setItem(COLLAPSED_KEY, String(!v));
      return !v;
    });
  }

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

  // Poll for escalated conversations every 30s; show toast on new escalations.
  const prevEscalatedRef = useRef<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const stats = await saas.getDashboardStats();
        if (cancelled) return;
        const n = stats.conversations.escalated;
        setEscalatedCount(n);
        if (prevEscalatedRef.current !== null && n > prevEscalatedRef.current) {
          const delta = n - prevEscalatedRef.current;
          toast.warning(
            delta === 1
              ? "Новый диалог ждёт оператора"
              : `${delta} новых диалога ждут оператора`,
            {
              description: "Перейдите в Диалоги чтобы ответить",
              action: { label: "Перейти", onClick: () => navigate("/conversations") },
              duration: 8000,
            },
          );
        }
        prevEscalatedRef.current = n;
      } catch {
        // ignore — no auth yet or network error
      }
    }
    poll();
    const id = setInterval(poll, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: navigate is stable
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
    <TooltipProvider delayDuration={300}>
      <div className="flex min-h-screen">
        <aside
          className={cn(
            "bg-sidebar text-sidebar-foreground sticky top-0 hidden h-screen shrink-0 border-r border-sidebar-border md:block transition-all duration-200",
            collapsed ? "w-[52px]" : "w-64",
          )}
        >
          <SidebarBody
            admin={admin}
            tenant={tenant}
            onLogout={handleLogout}
            escalatedCount={escalatedCount}
            collapsed={collapsed}
            onToggleCollapse={toggleCollapse}
          />
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="bg-background/70 sticky top-0 z-30 flex h-14 items-center gap-2 border-b px-4 backdrop-blur-xl md:hidden">
            <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Меню">
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
                  escalatedCount={escalatedCount}
                  collapsed={false}
                />
              </SheetContent>
            </Sheet>

            <Brand collapsed={false} />

            <div className="ml-auto">
              <ModeToggle />
            </div>
          </header>

          <main className="flex-1 px-4 py-6 md:px-8 md:py-8">
            <div className="mx-auto w-full max-w-6xl">{children}</div>
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}

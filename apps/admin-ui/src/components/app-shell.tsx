import {
  ActivityIcon,
  ArrowLeftRightIcon,
  BarChart2Icon,
  BellIcon,
  BriefcaseIcon,
  CableIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FlaskConicalIcon,
  GitBranchIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  LinkIcon,
  LogOutIcon,
  type LucideIcon,
  MenuIcon,
  MessagesSquareIcon,
  MonitorIcon,
  MoonIcon,
  PaletteIcon,
  RocketIcon,
  ScrollTextIcon,
  SendIcon,
  ShieldIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  SunIcon,
  TestTube2Icon,
  UserCircleIcon,
  UsersIcon,
  WebhookIcon,
  WrenchIcon,
  ZapIcon,
} from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { type Admin, ApiError, clearToken, saas, type Tenant } from "@/api/saas";
import { ModeToggle } from "@/components/mode-toggle";
import { useTheme } from "@/components/theme-provider";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Показывать только для обменных тенантов (вертикаль exchange). */
  exchangeOnly?: boolean;
  /** Скрывать для обменных тенантов (нерелевантно обменнику). */
  hideForExchange?: boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const TOP_NAV_ITEM: NavItem = { to: "/dashboard", label: "Главная", icon: LayoutDashboardIcon };

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Работа",
    items: [
      { to: "/leads", label: "Лиды", icon: UserCircleIcon },
      { to: "/conversations", label: "Диалоги", icon: MessagesSquareIcon },
      { to: "/outreach", label: "Рассылка", icon: SendIcon },
      { to: "/funnel", label: "Воронка", icon: GitBranchIcon },
      { to: "/exchange", label: "Обменник", icon: ArrowLeftRightIcon, exchangeOnly: true },
      { to: "/vacancies", label: "Каталог", icon: BriefcaseIcon, hideForExchange: true },
    ],
  },
  {
    label: "AI & Бот",
    items: [
      { to: "/skills", label: "Навыки", icon: ZapIcon, hideForExchange: true },
      { to: "/hooks", label: "Хуки", icon: SparklesIcon, hideForExchange: true },
      { to: "/styles", label: "Стили", icon: PaletteIcon, hideForExchange: true },
      { to: "/experiments", label: "Эксперименты", icon: FlaskConicalIcon, hideForExchange: true },
      { to: "/test", label: "Тест бота", icon: TestTube2Icon },
    ],
  },
  {
    label: "Система",
    items: [
      { to: "/channels", label: "Каналы", icon: CableIcon },
      { to: "/notifications", label: "Уведомления", icon: BellIcon },
      { to: "/webhooks", label: "Вебхуки", icon: WebhookIcon },
      { to: "/tools", label: "Инструменты", icon: WrenchIcon },
      { to: "/referral", label: "Партнёры", icon: LinkIcon, hideForExchange: true },
      { to: "/audit", label: "Аудит", icon: ScrollTextIcon },
    ],
  },
];

/** Фильтр пунктов по вертикали: exchangeOnly показываем только обменке, hideForExchange — скрываем у обменки. */
function visibleNavItems(items: NavItem[], isExchange: boolean): NavItem[] {
  return items.filter((it) => {
    if (it.exchangeOnly && !isExchange) return false;
    if (it.hideForExchange && isExchange) return false;
    return true;
  });
}

function Brand({ collapsed }: { collapsed?: boolean }) {
  return (
    <Link
      to="/dashboard"
      className={cn(
        "flex items-center gap-2.5 py-1 min-w-0",
        collapsed ? "justify-center px-0" : "px-2",
      )}
    >
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
  isSuperadmin,
  isExchange,
}: {
  onNavigate?: () => void;
  escalatedCount?: number;
  collapsed: boolean;
  isSuperadmin?: boolean;
  isExchange?: boolean;
}) {
  const groups = NAV_GROUPS.map((g) => ({
    ...g,
    items: visibleNavItems(g.items, isExchange ?? false),
  })).filter((g) => g.items.length > 0);
  return (
    <nav className="flex flex-col gap-4">
      <div className="flex flex-col gap-0.5">
        {collapsed && <div className="mx-auto h-px w-6 bg-sidebar-border my-1" />}
        <NavItemLink item={TOP_NAV_ITEM} collapsed={collapsed} onNavigate={onNavigate} />
      </div>

      {groups.map((group) => (
        <div key={group.label} className="flex flex-col gap-0.5">
          {!collapsed && (
            <p className="px-2.5 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
              {group.label}
            </p>
          )}
          {collapsed && <div className="mx-auto h-px w-6 bg-sidebar-border my-1" />}

          {group.items.map((item) => (
            <NavItemLink
              key={item.to}
              item={item}
              collapsed={collapsed}
              badge={item.to === "/conversations" ? escalatedCount : null}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      ))}

      {isSuperadmin && (
        <div className="flex flex-col gap-0.5">
          {!collapsed && (
            <p className="px-2.5 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
              Платформа
            </p>
          )}
          {collapsed && <div className="mx-auto h-px w-6 bg-sidebar-border my-1" />}
          <NavItemLink
            item={{ to: "/superadmin", label: "Аккаунты", icon: ShieldIcon }}
            collapsed={collapsed}
            onNavigate={onNavigate}
          />
        </div>
      )}
    </nav>
  );
}

const THEME_LABEL: Record<string, string> = {
  light: "Светлая",
  dark: "Тёмная",
  system: "Системная",
};

function ChangePasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [currentPwd, setCurrentPwd] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (newPwd.length < 8) {
      setError("Новый пароль — не менее 8 символов");
      return;
    }
    setSaving(true);
    try {
      await saas.changePassword(currentPwd, newPwd);
      toast.success("Пароль изменён");
      setCurrentPwd("");
      setNewPwd("");
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError("Неверный текущий пароль");
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Сменить пароль</DialogTitle>
        </DialogHeader>
        {error && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <Label>Текущий пароль</Label>
            <Input
              type="password"
              autoComplete="current-password"
              value={currentPwd}
              onChange={(e) => setCurrentPwd(e.target.value)}
              placeholder="••••••••"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label>Новый пароль (≥ 8 символов)</Label>
            <Input
              type="password"
              autoComplete="new-password"
              value={newPwd}
              onChange={(e) => setNewPwd(e.target.value)}
              placeholder="••••••••"
              required
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Отмена
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Сохраняем…" : "Изменить"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AccountDropdown({
  admin,
  tenant,
  onLogout,
  collapsed,
}: {
  admin: Admin | null;
  tenant: Tenant | null;
  onLogout: () => void;
  collapsed: boolean;
}) {
  const { theme, setTheme } = useTheme();
  const [pwdOpen, setPwdOpen] = useState(false);
  const initials = (admin?.email ?? "?").slice(0, 2).toUpperCase();

  const menuContent = (
    <DropdownMenuContent align="start" side={collapsed ? "right" : "top"} className="w-56">
      <DropdownMenuLabel className="font-normal">
        <p className="text-sm font-medium truncate">{admin?.name || admin?.email || "—"}</p>
        <p className="text-xs text-muted-foreground">
          {admin?.role === "superadmin" ? "Суперадмин" : "Менеджер"} · {tenant?.slug ?? "—"}
        </p>
      </DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuItem asChild>
          <Link to="/profile">
            <UserCircleIcon /> Профиль
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/settings">
            <SlidersHorizontalIcon /> Настройки LLM
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/team">
            <UsersIcon /> Команда
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/billing">
            <BarChart2Icon /> LLM-использование
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/diagnostics">
            <ActivityIcon /> Диагностика
          </Link>
        </DropdownMenuItem>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          {theme === "dark" ? <MoonIcon /> : theme === "light" ? <SunIcon /> : <MonitorIcon />}
          Тема
          <span className="ml-auto text-xs text-muted-foreground">{THEME_LABEL[theme]}</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <DropdownMenuItem onClick={() => setTheme("light")}>
            <SunIcon /> Светлая
            {theme === "light" && <span className="ml-auto text-primary">•</span>}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setTheme("dark")}>
            <MoonIcon /> Тёмная
            {theme === "dark" && <span className="ml-auto text-primary">•</span>}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setTheme("system")}>
            <MonitorIcon /> Системная
            {theme === "system" && <span className="ml-auto text-primary">•</span>}
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={() => setPwdOpen(true)}>
        <KeyRoundIcon /> Сменить пароль
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" onClick={onLogout}>
        <LogOutIcon /> Выйти
      </DropdownMenuItem>
    </DropdownMenuContent>
  );

  if (collapsed) {
    return (
      <>
        <ChangePasswordDialog open={pwdOpen} onClose={() => setPwdOpen(false)} />
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="flex w-full justify-center rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground cursor-pointer"
                >
                  <Avatar className="size-7 rounded-lg">
                    <AvatarFallback className="rounded-lg bg-primary/15 text-primary text-[10px]">
                      {initials}
                    </AvatarFallback>
                  </Avatar>
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="right" className="text-xs">
              {admin?.email}
            </TooltipContent>
          </Tooltip>
          {menuContent}
        </DropdownMenu>
      </>
    );
  }

  return (
    <>
      <ChangePasswordDialog open={pwdOpen} onClose={() => setPwdOpen(false)} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-2.5 rounded-md p-1.5 text-left transition-colors hover:bg-sidebar-accent/60 cursor-pointer"
          >
            <Avatar className="size-8 rounded-lg">
              <AvatarFallback className="rounded-lg bg-primary/15 text-primary">
                {initials}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{admin?.email ?? "—"}</p>
              <p className="truncate text-xs text-muted-foreground">{tenant?.slug ?? "—"}</p>
            </div>
          </button>
        </DropdownMenuTrigger>
        {menuContent}
      </DropdownMenu>
    </>
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
  isExchange,
}: {
  admin: Admin | null;
  tenant: Tenant | null;
  onLogout: () => void;
  onNavigate?: () => void;
  escalatedCount?: number;
  collapsed: boolean;
  onToggleCollapse?: () => void;
  isExchange?: boolean;
}) {
  return (
    <div className="flex h-full flex-col gap-1">
      {/* Header: collapsed = centered icon only; expanded = logo + collapse button */}
      <div
        className={cn(
          "flex h-14 items-center border-b border-sidebar-border",
          collapsed ? "justify-center px-2" : "px-3 gap-2",
        )}
      >
        {collapsed ? (
          <Brand collapsed />
        ) : (
          <>
            <div className="flex-1 min-w-0">
              <Brand />
            </div>
            {onToggleCollapse && (
              <button
                type="button"
                onClick={onToggleCollapse}
                className="shrink-0 grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent/50 hover:text-foreground cursor-pointer"
                aria-label="Свернуть меню"
              >
                <ChevronLeftIcon className="size-4" />
              </button>
            )}
          </>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-4">
        {/* Expand button at top of nav when collapsed */}
        {collapsed && onToggleCollapse && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onToggleCollapse}
                className="mb-3 flex w-full justify-center rounded-md p-2 text-muted-foreground transition-colors hover:bg-sidebar-accent/50 hover:text-foreground cursor-pointer"
                aria-label="Развернуть меню"
              >
                <ChevronRightIcon className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" className="text-xs">
              Развернуть
            </TooltipContent>
          </Tooltip>
        )}
        <NavLinks
          onNavigate={onNavigate}
          escalatedCount={escalatedCount}
          collapsed={collapsed}
          isSuperadmin={admin?.role === "superadmin"}
          isExchange={isExchange}
        />
      </div>

      <div className="border-t border-sidebar-border p-3">
        <AccountDropdown admin={admin} tenant={tenant} onLogout={onLogout} collapsed={collapsed} />
      </div>
    </div>
  );
}

const COLLAPSED_KEY = "sidebar-collapsed";

export function AppShell({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const [admin, setAdmin] = useState<Admin | null>(null);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [isExchange, setIsExchange] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [escalatedCount, setEscalatedCount] = useState(0);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === "true");

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
    // Вертикаль тенанта (для скрытия нерелевантных пунктов меню у обменки).
    saas
      .onboardingStatus()
      .then((s) => {
        if (!cancelled) setIsExchange(s.isExchange === true);
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
            delta === 1 ? "Новый диалог ждёт оператора" : `${delta} новых диалога ждут оператора`,
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
            isExchange={isExchange}
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
                  isExchange={isExchange}
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

import {
  ActivityIcon,
  ArrowLeftRightIcon,
  BarChart2Icon,
  BellIcon,
  BlocksIcon,
  BookOpenIcon,
  BriefcaseIcon,
  CableIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClipboardListIcon,
  FlaskConicalIcon,
  GitBranchIcon,
  HandshakeIcon,
  LayoutDashboardIcon,
  LinkIcon,
  ListChecksIcon,
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
  SlidersHorizontalIcon,
  SparklesIcon,
  StoreIcon,
  SunIcon,
  TestTube2Icon,
  UserCircleIcon,
  UsersIcon,
  ZapIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  type Admin,
  clearToken,
  type DashboardStats,
  type FunnelListItem,
  saas,
  type Tenant,
} from "@/api/saas";
import { CopilotDock } from "@/components/copilot";
import { ModeToggle } from "@/components/mode-toggle";
import { useTheme } from "@/components/theme-provider";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
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
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { type AdminEvent, useAdminEvents } from "@/hooks/useAdminEvents";
import { cn } from "@/lib/utils";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Показывать только для обменных тенантов (вертикаль exchange). */
  exchangeOnly?: boolean;
  /** Скрывать для обменных тенантов (нерелевантно обменнику). */
  hideForExchange?: boolean;
  /** Показывать только platform/tenant superadmin'ам. */
  superadminOnly?: boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const TOP_NAV_ITEM: NavItem = { to: "/dashboard", label: "Главная", icon: LayoutDashboardIcon };

// Общая навигация для не-exchange тенантов: оставляем текущую структуру.
const DEFAULT_NAV_GROUPS: NavGroup[] = [
  {
    label: "Продажи",
    items: [
      { to: "/exchange", label: "Обменка", icon: ArrowLeftRightIcon, exchangeOnly: true },
      { to: "/funnel", label: "Процессы", icon: GitBranchIcon },
      { to: "/services", label: "Услуги", icon: ListChecksIcon },
      { to: "/partners", label: "Партнёры", icon: HandshakeIcon },
      { to: "/providers", label: "Провайдеры", icon: StoreIcon },
      { to: "/orders", label: "Заказы", icon: ClipboardListIcon },
      { to: "/leads", label: "Лиды", icon: UserCircleIcon },
      { to: "/conversations", label: "Диалоги", icon: MessagesSquareIcon },
      { to: "/outreach", label: "Рассылка", icon: SendIcon },
      { to: "/campaigns", label: "Кампании", icon: RocketIcon },
      { to: "/vacancies", label: "Каталог", icon: BriefcaseIcon, hideForExchange: true },
    ],
  },
  {
    label: "Бот",
    items: [
      { to: "/channels", label: "Каналы", icon: CableIcon },
      { to: "/test", label: "Тест бота", icon: TestTube2Icon },
      { to: "/integrations", label: "Интеграции", icon: BlocksIcon },
      { to: "/faq", label: "База знаний", icon: BookOpenIcon },
      { to: "/skills", label: "Навыки", icon: ZapIcon, hideForExchange: true },
      { to: "/hooks", label: "Хуки", icon: SparklesIcon, hideForExchange: true },
      { to: "/styles", label: "Стили", icon: PaletteIcon, hideForExchange: true },
      { to: "/experiments", label: "Эксперименты", icon: FlaskConicalIcon, hideForExchange: true },
      { to: "/quality", label: "Качество", icon: ActivityIcon },
    ],
  },
  {
    label: "Система",
    items: [
      { to: "/settings", label: "Настройки", icon: SlidersHorizontalIcon },
      { to: "/team", label: "Команда", icon: UsersIcon, superadminOnly: true },
      { to: "/notifications", label: "Уведомления", icon: BellIcon },
      { to: "/billing", label: "LLM-использование", icon: BarChart2Icon },
      { to: "/diagnostics", label: "Диагностика", icon: ActivityIcon },
      { to: "/audit", label: "Аудит", icon: ScrollTextIcon },
      { to: "/referral", label: "Рефкоды", icon: LinkIcon, hideForExchange: true },
    ],
  },
];

// Exchange-first навигация: только ежедневные рабочие экраны и базовая настройка.
const EXCHANGE_NAV_GROUPS: NavGroup[] = [
  {
    label: "Операции",
    items: [
      { to: "/exchange", label: "Обменный пункт", icon: ArrowLeftRightIcon },
      { to: "/leads", label: "Лиды", icon: UserCircleIcon },
      { to: "/conversations", label: "Диалоги", icon: MessagesSquareIcon },
      { to: "/channels", label: "Каналы", icon: CableIcon },
    ],
  },
  {
    label: "Настройки",
    items: [
      { to: "/settings", label: "Общие", icon: SlidersHorizontalIcon },
      { to: "/notifications", label: "Уведомления", icon: BellIcon },
      { to: "/team", label: "Команда", icon: UsersIcon, superadminOnly: true },
      { to: "/funnel", label: "Процессы", icon: GitBranchIcon },
      { to: "/faq", label: "База знаний", icon: BookOpenIcon },
      { to: "/integrations", label: "Интеграции", icon: BlocksIcon },
    ],
  },
];

/** exchangeOnly зависит от workflow, hideForExchange — только от exchange tenant. */
function visibleNavItems(
  items: NavItem[],
  flags: { hasExchangeWorkflow: boolean; isExchangeTenant: boolean; isSuperadmin: boolean },
): NavItem[] {
  return items.filter((it) => {
    if (it.exchangeOnly && !flags.hasExchangeWorkflow) return false;
    if (it.hideForExchange && flags.isExchangeTenant) return false;
    if (it.superadminOnly && !flags.isSuperadmin) return false;
    return true;
  });
}

type NewMessageEvent = Extract<AdminEvent, { type: "new_message" }>;
type BadgeTone = "message" | "warning";

function formatNotificationPreview(preview: string | null): string {
  const text = preview?.trim();
  if (!text) return "Медиа или вложение";
  return text;
}

function newMessageTitle(event: NewMessageEvent): string {
  return event.contactId > 0 ? `Новое сообщение · контакт #${event.contactId}` : "Новое сообщение";
}

function countBadgeLabel(count: number): string {
  return count > 99 ? "99+" : String(count);
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
          exchanges<span className="text-primary">.</span>agency
        </span>
      )}
    </Link>
  );
}

function NavItemLink({
  item,
  collapsed,
  badge,
  badgeTone = "warning",
  onNavigate,
}: {
  item: NavItem;
  collapsed: boolean;
  badge?: number | null;
  badgeTone?: BadgeTone;
  onNavigate?: () => void;
}) {
  const { pathname } = useLocation();
  const active = pathname === item.to || pathname.startsWith(`${item.to}/`);
  const { icon: Icon, label, to } = item;
  const hasBadge = (badge ?? 0) > 0;
  const badgeClass =
    badgeTone === "message" ? "bg-primary text-primary-foreground" : "bg-amber-500 text-white";

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
          {hasBadge && (
            <span
              className={cn(
                "ml-auto grid min-w-[18px] place-items-center rounded-full px-1 py-0.5 text-[10px] font-bold leading-none",
                badgeClass,
              )}
            >
              {countBadgeLabel(badge ?? 0)}
            </span>
          )}
        </>
      )}
      {collapsed && hasBadge && (
        <span className={cn("absolute right-1 top-1 size-2 rounded-full", badgeClass)} />
      )}
    </NavLink>
  );

  if (!collapsed) return link;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right" className="text-xs">
        {label}
        {hasBadge && (
          <span className={cn("ml-1", badgeTone === "message" ? "text-primary" : "text-amber-500")}>
            ({countBadgeLabel(badge ?? 0)})
          </span>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

function NavLinks({
  onNavigate,
  conversationBadge,
  conversationBadgeTone,
  collapsed,
  hasExchangeWorkflow,
  isExchangeTenant,
  isSuperadmin,
}: {
  onNavigate?: () => void;
  conversationBadge?: number;
  conversationBadgeTone?: BadgeTone;
  collapsed: boolean;
  isSuperadmin?: boolean;
  hasExchangeWorkflow?: boolean;
  isExchangeTenant?: boolean;
}) {
  const isExchangeMode = Boolean(hasExchangeWorkflow || isExchangeTenant);
  const navGroups = isExchangeMode ? EXCHANGE_NAV_GROUPS : DEFAULT_NAV_GROUPS;
  const groups = navGroups
    .map((g) => ({
      ...g,
      items: visibleNavItems(g.items, {
        hasExchangeWorkflow: hasExchangeWorkflow ?? false,
        isExchangeTenant: isExchangeTenant ?? false,
        isSuperadmin: isSuperadmin ?? false,
      }),
    }))
    .filter((g) => g.items.length > 0);
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
              badge={item.to === "/conversations" ? conversationBadge : null}
              badgeTone={conversationBadgeTone}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      ))}
    </nav>
  );
}

const THEME_LABEL: Record<string, string> = {
  light: "Светлая",
  dark: "Тёмная",
  system: "Системная",
};

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
  // Показываем имя (если задано), иначе email.
  const displayName = admin?.name?.trim() || admin?.email || "—";
  const initials = (admin?.name?.trim() || admin?.email || "?").slice(0, 2).toUpperCase();

  const menuContent = (
    <DropdownMenuContent align="start" side={collapsed ? "right" : "top"} className="w-56">
      <DropdownMenuLabel className="font-normal">
        <p className="text-sm font-medium truncate">{admin?.name || admin?.email || "—"}</p>
        <p className="text-xs text-muted-foreground">
          {admin?.role === "superadmin" ? "Суперадмин" : "Оператор"} · {tenant?.slug ?? "—"}
        </p>
      </DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuItem asChild>
          <Link to="/profile">
            <UserCircleIcon /> Профиль
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
      <DropdownMenuItem variant="destructive" onClick={onLogout}>
        <LogOutIcon /> Выйти
      </DropdownMenuItem>
    </DropdownMenuContent>
  );

  if (collapsed) {
    return (
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
            {displayName}
          </TooltipContent>
        </Tooltip>
        {menuContent}
      </DropdownMenu>
    );
  }

  return (
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
            <p className="truncate text-sm font-medium">{displayName}</p>
            <p className="truncate text-xs text-muted-foreground">
              {admin?.name ? admin.email : (tenant?.slug ?? "—")}
            </p>
          </div>
        </button>
      </DropdownMenuTrigger>
      {menuContent}
    </DropdownMenu>
  );
}

function SidebarBody({
  admin,
  tenant,
  onLogout,
  onNavigate,
  conversationBadge,
  conversationBadgeTone,
  collapsed,
  onToggleCollapse,
  hasExchangeWorkflow,
  isExchangeTenant,
  isSuperadmin,
}: {
  admin: Admin | null;
  tenant: Tenant | null;
  onLogout: () => void;
  onNavigate?: () => void;
  conversationBadge?: number;
  conversationBadgeTone?: BadgeTone;
  collapsed: boolean;
  onToggleCollapse?: () => void;
  hasExchangeWorkflow?: boolean;
  isExchangeTenant?: boolean;
  isSuperadmin?: boolean;
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
          conversationBadge={conversationBadge}
          conversationBadgeTone={conversationBadgeTone}
          collapsed={collapsed}
          hasExchangeWorkflow={hasExchangeWorkflow}
          isExchangeTenant={isExchangeTenant}
          isSuperadmin={isSuperadmin}
        />
      </div>

      <div className="border-t border-sidebar-border p-3">
        <AccountDropdown admin={admin} tenant={tenant} onLogout={onLogout} collapsed={collapsed} />
      </div>
    </div>
  );
}

const COLLAPSED_KEY = "sidebar-collapsed";
const FUNNELS_UPDATED_EVENT = "lead-engine:funnel-updated";

function hasExchangeMarker(value?: string | null): boolean {
  const key = value?.toLowerCase() ?? "";
  return key.includes("exchange") || key.includes("обмен") || key.includes("obmen");
}

function funnelLooksLikeExchange(
  item: Pick<FunnelListItem, "slug"> & { verticalTemplateId?: string | null },
) {
  return hasExchangeMarker(item.slug) || hasExchangeMarker(item.verticalTemplateId);
}

async function getExchangeNavState(): Promise<{
  hasExchangeWorkflow: boolean;
  isExchangeTenant: boolean;
}> {
  const [statusResult, listResult] = await Promise.allSettled([
    saas.onboardingStatus(),
    saas.listFunnels(),
  ]);

  const isExchangeTenant =
    statusResult.status === "fulfilled" && statusResult.value.isExchange === true;
  if (isExchangeTenant) return { hasExchangeWorkflow: true, isExchangeTenant };
  if (listResult.status !== "fulfilled") return { hasExchangeWorkflow: false, isExchangeTenant };

  const funnels = listResult.value.items;
  if (funnels.some(funnelLooksLikeExchange)) {
    return { hasExchangeWorkflow: true, isExchangeTenant };
  }

  const details = await Promise.allSettled(funnels.map((funnel) => saas.getFunnelById(funnel.id)));
  const hasExchangeWorkflow = details.some((result) => {
    if (result.status !== "fulfilled") return false;
    return (
      (result.value.funnel ? funnelLooksLikeExchange(result.value.funnel) : false) ||
      result.value.stages.some(
        (stage) => hasExchangeMarker(stage.slug) || hasExchangeMarker(stage.displayName),
      )
    );
  });

  return { hasExchangeWorkflow, isExchangeTenant };
}

// Операционные экраны без max-width капа: таблицы, рабочие панели и 3-колоночные консоли.
const FULL_WIDTH_PATHS = new Set([
  "/audit",
  "/dashboard",
  "/exchange",
  "/faq",
  "/funnel",
  "/leads",
  "/orders",
  "/partners",
  "/providers",
  "/quality",
  "/services",
  "/superadmin",
]);
const FULL_WIDTH_PREFIXES = ["/conversations", "/leads/"];

function isFullWidthPath(pathname: string): boolean {
  return (
    FULL_WIDTH_PATHS.has(pathname) ||
    FULL_WIDTH_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { pathname } = location;
  const fullWidth = isFullWidthPath(pathname);
  const showSettingsReturn =
    pathname !== "/settings" &&
    (location.state as { fromSettings?: boolean } | null)?.fromSettings === true;
  const [admin, setAdmin] = useState<Admin | null>(null);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [hasExchangeWorkflow, setHasExchangeWorkflow] = useState(false);
  const [isExchangeTenant, setIsExchangeTenant] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [escalatedCount, setEscalatedCount] = useState(0);
  const [unreadCount, setUnreadCount] = useState(0);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === "true");
  const conversationBadge = unreadCount > 0 ? unreadCount : escalatedCount;
  const conversationBadgeTone: BadgeTone = unreadCount > 0 ? "message" : "warning";

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
    async function refreshExchangeWorkflowFlag() {
      try {
        const next = await getExchangeNavState();
        if (!cancelled) {
          setHasExchangeWorkflow(next.hasExchangeWorkflow);
          setIsExchangeTenant(next.isExchangeTenant);
        }
      } catch {
        // Leave the previous value on transient API errors.
      }
    }
    void refreshExchangeWorkflowFlag();
    const onFunnelsUpdated = () => {
      void refreshExchangeWorkflowFlag();
    };
    window.addEventListener(FUNNELS_UPDATED_EVENT, onFunnelsUpdated);
    // Профиль обновился (имя) — обновляем сразу, без перезагрузки.
    const onProfileUpdated = (e: Event) => {
      const next = (e as CustomEvent<Admin>).detail;
      if (next) setAdmin((prev) => (prev ? { ...prev, ...next } : next));
    };
    window.addEventListener("admin-profile-updated", onProfileUpdated);
    return () => {
      cancelled = true;
      window.removeEventListener(FUNNELS_UPDATED_EVENT, onFunnelsUpdated);
      window.removeEventListener("admin-profile-updated", onProfileUpdated);
    };
  }, []);

  // Poll counters every 30s; SSE below makes new messages visible immediately.
  const prevEscalatedRef = useRef<number | null>(null);
  const applyDashboardStats = useCallback(
    (stats: DashboardStats, notifyEscalations: boolean) => {
      const n = stats.conversations.escalated;
      setEscalatedCount(n);
      setUnreadCount(stats.conversations.unread ?? 0);
      if (notifyEscalations && prevEscalatedRef.current !== null && n > prevEscalatedRef.current) {
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
    },
    [navigate],
  );

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const stats = await saas.getDashboardStats();
        if (cancelled) return;
        applyDashboardStats(stats, true);
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
  }, [applyDashboardStats]);

  useEffect(() => {
    if (!/^\/conversations\/\d+$/.test(pathname)) return;
    let cancelled = false;
    const id = setTimeout(() => {
      saas
        .getDashboardStats()
        .then((stats) => {
          if (!cancelled) applyDashboardStats(stats, false);
        })
        .catch(() => {});
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [applyDashboardStats, pathname]);

  useAdminEvents((event) => {
    if (event.type === "new_message") {
      if (event.role && event.role !== "user") return;
      const target = `/conversations/${event.conversationId}`;
      const visibleCurrentThread = pathname === target && document.visibilityState === "visible";
      if (!visibleCurrentThread) setUnreadCount((count) => count + 1);
      if (visibleCurrentThread) return;
      toast.info(newMessageTitle(event), {
        description: formatNotificationPreview(event.preview),
        action: { label: "Открыть", onClick: () => navigate(target) },
        duration: document.visibilityState === "hidden" ? 20_000 : 12_000,
      });
    } else if (event.type === "stage_changed") {
      toast.info(`Стадия изменена → ${event.toStageDisplayName}`, { duration: 3000 });
    }
  });

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
            conversationBadge={conversationBadge}
            conversationBadgeTone={conversationBadgeTone}
            collapsed={collapsed}
            onToggleCollapse={toggleCollapse}
            hasExchangeWorkflow={hasExchangeWorkflow}
            isExchangeTenant={isExchangeTenant}
            isSuperadmin={admin?.role === "superadmin"}
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
                  conversationBadge={conversationBadge}
                  conversationBadgeTone={conversationBadgeTone}
                  collapsed={false}
                  hasExchangeWorkflow={hasExchangeWorkflow}
                  isExchangeTenant={isExchangeTenant}
                  isSuperadmin={admin?.role === "superadmin"}
                />
              </SheetContent>
            </Sheet>

            <Brand collapsed={false} />

            <div className="ml-auto">
              <ModeToggle />
            </div>
          </header>

          <main className="flex-1 px-4 py-6 md:px-8 md:py-8">
            <div className={fullWidth ? "w-full" : "mx-auto w-full max-w-6xl"}>
              {showSettingsReturn && (
                <div className="mb-3 flex justify-end">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        asChild
                        variant="outline"
                        size="icon"
                        aria-label="Вернуться в настройки"
                      >
                        <Link to="/settings">
                          <SlidersHorizontalIcon className="size-4" />
                        </Link>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="left" className="text-xs">
                      Вернуться в настройки
                    </TooltipContent>
                  </Tooltip>
                </div>
              )}
              {children}
            </div>
          </main>
        </div>

        <CopilotDock />
      </div>
    </TooltipProvider>
  );
}

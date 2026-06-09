import {
  BriefcaseBusinessIcon,
  CheckCircle2Icon,
  HandshakeIcon,
  LinkIcon,
  PlusIcon,
  RefreshCwIcon,
  StoreIcon,
  Trash2Icon,
  UserCircleIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import {
  type CustomProviderMarketplaceItem,
  type FunnelListItem,
  type FunnelTemplateInfo,
  type PartnerService,
  type ProviderMarketplaceItem,
  type ServiceCatalogItem,
  type ServiceCatalogRouteType,
  saas,
} from "@/api/saas";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type ExecutorType = "own" | "partner" | "webhook" | "manual";
type ProcessMode = "new" | "existing";

interface OfferForm {
  section: string;
  name: string;
  description: string;
  executor: ExecutorType;
  processMode: ProcessMode;
  existingFunnelId: string;
  newFunnelTemplate: string;
  newFunnelSlug: string;
  partnerServiceId: string;
  webhookUrl: string;
}

interface CustomProviderForm {
  providerName: string;
  serviceName: string;
  category: string;
  description: string;
  commissionPct: string;
  requiredFields: string;
}

const EMPTY_FORM: OfferForm = {
  section: "Основное",
  name: "",
  description: "",
  executor: "own",
  processMode: "new",
  existingFunnelId: "",
  newFunnelTemplate: "exchange",
  newFunnelSlug: "",
  partnerServiceId: "",
  webhookUrl: "",
};

const EMPTY_CUSTOM_PROVIDER: CustomProviderForm = {
  providerName: "",
  serviceName: "",
  category: "Custom offer",
  description: "",
  commissionPct: "10",
  requiredFields: "date, address, budget",
};

const EXECUTOR_OPTIONS: Array<{
  value: ExecutorType;
  label: string;
  description: string;
  icon: typeof UserCircleIcon;
}> = [
  {
    value: "own",
    label: "Мы сами",
    description: "Создать или выбрать процесс обработки",
    icon: BriefcaseBusinessIcon,
  },
  {
    value: "partner",
    label: "Партнёр",
    description: "Передавать заявку провайдеру",
    icon: HandshakeIcon,
  },
  {
    value: "webhook",
    label: "Webhook",
    description: "Отправлять во внешний сервис",
    icon: LinkIcon,
  },
  {
    value: "manual",
    label: "Оператор",
    description: "Разбирать вручную без маршрута",
    icon: UserCircleIcon,
  },
];

function funnelLabel(item: Pick<FunnelListItem, "slug" | "verticalTemplateId">): string {
  const key = `${item.slug} ${item.verticalTemplateId ?? ""}`.toLowerCase();
  if (key.includes("exchange")) return "Обменка";
  if (key.includes("real_estate")) return "Продажа недвижимости";
  if (key.includes("partner")) return "Партнёрские услуги";
  if (key.includes("saas") || key.includes("product")) return "Продукт";
  return item.slug.replace(/_/g, " ");
}

function routeLabel(type: ServiceCatalogRouteType): string {
  if (type === "funnel") return "Мы сами";
  if (type === "partner_service") return "Партнёр";
  if (type === "webhook") return "Webhook";
  return "Оператор";
}

function targetLabel(item: ServiceCatalogItem): string {
  if (item.routeType === "manual") return "Ручная обработка";
  if (item.routeType === "funnel") {
    return item.funnelSlug
      ? funnelLabel({
          slug: item.funnelSlug,
          verticalTemplateId: item.funnelVerticalTemplateId ?? null,
        })
      : "Процесс не выбран";
  }
  if (item.routeType === "partner_service") {
    if (item.partnerName && item.partnerServiceName)
      return `${item.partnerName} · ${item.partnerServiceName}`;
    return item.partnerServiceName ?? "Провайдер не выбран";
  }
  return item.webhookUrl ?? "Webhook не задан";
}

function sectionName(item: Pick<ServiceCatalogItem, "category">): string {
  return item.category?.trim() || "Без раздела";
}

function normalizeSlug(value: string): string {
  return transliterate(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

function uniqueFunnelSlug(base: string, funnels: FunnelListItem[]): string {
  const normalized = normalizeSlug(base) || "service";
  const taken = new Set(funnels.map((f) => f.slug));
  if (!taken.has(normalized)) return normalized;
  for (let i = 2; i < 100; i++) {
    const candidate = `${normalized}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${normalized}_${Date.now()}`;
}

function templateAlreadyExists(template: FunnelTemplateInfo, funnels: FunnelListItem[]): boolean {
  if (template.key === "skeleton") return false;
  return funnels.some(
    (funnel) =>
      (template.verticalTemplateId && funnel.verticalTemplateId === template.verticalTemplateId) ||
      funnel.slug === template.key,
  );
}

function availableTemplates(
  templates: FunnelTemplateInfo[],
  funnels: FunnelListItem[],
): FunnelTemplateInfo[] {
  return templates.filter(
    (template) => template.isCreatable !== false && !templateAlreadyExists(template, funnels),
  );
}

function transliterate(value: string): string {
  const map: Record<string, string> = {
    а: "a",
    б: "b",
    в: "v",
    г: "g",
    д: "d",
    е: "e",
    ё: "e",
    ж: "zh",
    з: "z",
    и: "i",
    й: "y",
    к: "k",
    л: "l",
    м: "m",
    н: "n",
    о: "o",
    п: "p",
    р: "r",
    с: "s",
    т: "t",
    у: "u",
    ф: "f",
    х: "h",
    ц: "c",
    ч: "ch",
    ш: "sh",
    щ: "sch",
    ы: "y",
    э: "e",
    ю: "yu",
    я: "ya",
    ъ: "",
    ь: "",
  };
  return value
    .toLowerCase()
    .split("")
    .map((ch) => map[ch] ?? ch)
    .join("");
}

export function SaasServiceCatalog() {
  const [items, setItems] = useState<ServiceCatalogItem[]>([]);
  const [funnels, setFunnels] = useState<FunnelListItem[]>([]);
  const [templates, setTemplates] = useState<FunnelTemplateInfo[]>([]);
  const [partnerServices, setPartnerServices] = useState<PartnerService[]>([]);
  const [marketplace, setMarketplace] = useState<ProviderMarketplaceItem[]>([]);
  const [customProviders, setCustomProviders] = useState<CustomProviderMarketplaceItem[]>([]);
  const [marketplaceCategory, setMarketplaceCategory] = useState("Все");
  const [form, setForm] = useState<OfferForm>(EMPTY_FORM);
  const [customProviderForm, setCustomProviderForm] =
    useState<CustomProviderForm>(EMPTY_CUSTOM_PROVIDER);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingId, setSavingId] = useState<number | null>(null);
  const [installingProvider, setInstallingProvider] = useState<string | null>(null);
  const [savingCustomProvider, setSavingCustomProvider] = useState(false);
  const [error, setError] = useState("");

  const sections = useMemo(() => {
    const map = new Map<string, ServiceCatalogItem[]>();
    for (const item of items) {
      const key = sectionName(item);
      map.set(key, [...(map.get(key) ?? []), item]);
    }
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b, "ru"))
      .map(([name, rows]) => ({
        name,
        items: rows.sort((a, b) => a.sortOrder - b.sortOrder || b.id - a.id),
      }));
  }, [items]);

  const sectionOptions = useMemo(() => {
    const names = new Set(items.map(sectionName));
    names.add("Основное");
    return [...names].sort((a, b) => a.localeCompare(b, "ru"));
  }, [items]);

  const activeCount = useMemo(() => items.filter((item) => item.isActive).length, [items]);
  const selectableTemplates = useMemo(
    () => availableTemplates(templates, funnels),
    [templates, funnels],
  );

  useEffect(() => {
    const fallbackTemplate = selectableTemplates[0];
    if (!fallbackTemplate) return;
    setForm((prev) =>
      selectableTemplates.some((template) => template.key === prev.newFunnelTemplate)
        ? prev
        : { ...prev, newFunnelTemplate: fallbackTemplate.key },
    );
  }, [selectableTemplates]);
  const marketplaceCategories = useMemo(
    () => [
      "Все",
      ...[...new Set(marketplace.map((provider) => provider.category))].sort((a, b) =>
        a.localeCompare(b, "ru"),
      ),
    ],
    [marketplace],
  );
  const visibleMarketplace = useMemo(
    () =>
      marketplaceCategory === "Все"
        ? marketplace
        : marketplace.filter((provider) => provider.category === marketplaceCategory),
    [marketplace, marketplaceCategory],
  );
  const installedMarketplaceCount = useMemo(
    () => marketplace.filter((provider) => provider.installed).length + customProviders.length,
    [marketplace, customProviders],
  );
  const selectedExecutor =
    EXECUTOR_OPTIONS.find((option) => option.value === form.executor) ?? EXECUTOR_OPTIONS[0]!;

  async function reload() {
    setError("");
    try {
      const [catalogRes, funnelRes, templateRes, serviceRes, marketplaceRes] = await Promise.all([
        saas.listServiceCatalog(),
        saas.listFunnels(),
        saas.listFunnelTemplates().catch(() => ({ items: [] as FunnelTemplateInfo[] })),
        saas.listPartnerServices(),
        saas.listProviderMarketplace(),
      ]);
      setItems(catalogRes.items);
      setFunnels(funnelRes.items);
      setTemplates(templateRes.items);
      setPartnerServices(serviceRes.items);
      setMarketplace(marketplaceRes.items);
      setCustomProviders(marketplaceRes.customProviders);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось загрузить каталог");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  function updateForm(patch: Partial<OfferForm>) {
    setForm((prev) => {
      const next = { ...prev, ...patch };
      if ("name" in patch && !prev.newFunnelSlug.trim()) {
        next.newFunnelSlug = uniqueFunnelSlug(patch.name ?? "", funnels);
      }
      return next;
    });
  }

  function updateCustomProviderForm(patch: Partial<CustomProviderForm>) {
    setCustomProviderForm((prev) => ({ ...prev, ...patch }));
  }

  async function installProvider(provider: ProviderMarketplaceItem) {
    if (provider.installed) return;
    setInstallingProvider(provider.key);
    try {
      await saas.installMarketplaceProvider(provider.key);
      toast.success("Провайдер добавлен в каталог");
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось добавить провайдера");
    } finally {
      setInstallingProvider(null);
    }
  }

  async function createCustomProvider() {
    if (!customProviderForm.providerName.trim() || !customProviderForm.serviceName.trim()) return;
    setSavingCustomProvider(true);
    try {
      await saas.createCustomMarketplaceProvider({
        providerName: customProviderForm.providerName.trim(),
        serviceName: customProviderForm.serviceName.trim(),
        category: customProviderForm.category.trim() || "Custom offer",
        description: customProviderForm.description.trim() || null,
        commissionPct: Number(customProviderForm.commissionPct || 0),
        requiredFields: customProviderForm.requiredFields,
      });
      toast.success("Свой провайдер добавлен в каталог");
      setCustomProviderForm(EMPTY_CUSTOM_PROVIDER);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось добавить своего провайдера");
    } finally {
      setSavingCustomProvider(false);
    }
  }

  async function createOffer() {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      let routeType: ServiceCatalogRouteType = "manual";
      let funnelId: number | null = null;
      let partnerServiceId: number | null = null;
      let webhookUrl: string | null = null;

      if (form.executor === "own") {
        routeType = "funnel";
        if (form.processMode === "new") {
          const template = selectableTemplates.some((item) => item.key === form.newFunnelTemplate)
            ? form.newFunnelTemplate
            : (selectableTemplates[0]?.key ?? "skeleton");
          const slug = uniqueFunnelSlug(form.newFunnelSlug || form.name, funnels);
          const created = await saas.createFunnel({
            slug,
            template,
          });
          funnelId = created.funnelId;
        } else {
          funnelId = Number(form.existingFunnelId || 0) || null;
        }
        if (!funnelId) throw new Error("Выберите или создайте процесс обработки");
      } else if (form.executor === "partner") {
        routeType = "partner_service";
        partnerServiceId = Number(form.partnerServiceId || 0) || null;
        if (!partnerServiceId) throw new Error("Выберите провайдера");
      } else if (form.executor === "webhook") {
        routeType = "webhook";
        webhookUrl = form.webhookUrl.trim();
        if (!webhookUrl) throw new Error("Укажите webhook URL");
      }

      await saas.createServiceCatalogItem({
        name: form.name.trim(),
        category: form.section.trim() || "Основное",
        description: form.description.trim() || null,
        routeType,
        funnelId,
        partnerServiceId,
        webhookUrl,
        isActive: true,
        sortOrder: items.length * 10,
      });

      toast.success("Услуга добавлена в каталог");
      setForm({
        ...EMPTY_FORM,
        newFunnelTemplate: selectableTemplates[0]?.key ?? "skeleton",
      });
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось добавить услугу");
    } finally {
      setSaving(false);
    }
  }

  async function toggleItem(item: ServiceCatalogItem, isActive: boolean) {
    setSavingId(item.id);
    try {
      await saas.updateServiceCatalogItem(item.id, { isActive });
      setItems((prev) => prev.map((row) => (row.id === item.id ? { ...row, isActive } : row)));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось обновить услугу");
    } finally {
      setSavingId(null);
    }
  }

  async function deleteItem(item: ServiceCatalogItem) {
    if (!window.confirm(`Удалить услугу «${item.name}»?`)) return;
    setSavingId(item.id);
    try {
      await saas.deleteServiceCatalogItem(item.id);
      setItems((prev) => prev.filter((row) => row.id !== item.id));
      toast.success("Услуга удалена");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось удалить услугу");
    } finally {
      setSavingId(null);
    }
  }

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Загрузка...</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <PageHeader
          title="Каталог"
          description="Разделы и услуги, которые бот предлагает клиенту; каждая услуга ведёт в свой процесс или к провайдеру"
        />
        <Button variant="outline" size="sm" onClick={() => void reload()}>
          <RefreshCwIcon className="size-4" />
          Обновить
        </Button>
      </div>

      {error && (
        <p className="rounded-md border border-destructive/40 p-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm">
              <StoreIcon className="size-4" />
              Marketplace провайдеров
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              Добавляйте исполнителей услуг в каталог: AI будет заводить заявку, собирать поля и
              отдавать handoff провайдеру.
            </p>
          </div>
          <Badge variant="outline">{installedMarketplaceCount} installed</Badge>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex flex-wrap gap-2">
            {marketplaceCategories.map((category) => (
              <Button
                key={category}
                size="sm"
                variant={marketplaceCategory === category ? "default" : "outline"}
                onClick={() => setMarketplaceCategory(category)}
              >
                {category}
              </Button>
            ))}
          </div>

          <div className="grid gap-3 lg:grid-cols-3">
            {visibleMarketplace.map((provider) => (
              <div key={provider.key} className="rounded-md border p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <Badge variant="secondary">{provider.category}</Badge>
                    <h3 className="mt-3 text-sm font-semibold">{provider.name}</h3>
                  </div>
                  {provider.installed && (
                    <Badge variant="outline" className="gap-1 text-emerald-600">
                      <CheckCircle2Icon className="size-3" />
                      installed
                    </Badge>
                  )}
                </div>
                <p className="mt-2 min-h-[42px] text-xs leading-5 text-muted-foreground">
                  {provider.description}
                </p>
                <div className="mt-3 grid gap-2 text-xs text-muted-foreground">
                  <div className="flex justify-between gap-3">
                    <span>Coverage</span>
                    <span className="text-right text-foreground">{provider.coverage}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span>SLA</span>
                    <span className="text-right text-foreground">{provider.sla}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span>Pricing</span>
                    <span className="text-right text-foreground">{provider.pricingMode}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span>Commission</span>
                    <span className="text-right text-foreground">{provider.commissionHint}</span>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-1">
                  {provider.requiredFields.slice(0, 4).map((field) => (
                    <span
                      key={field}
                      className="rounded bg-muted px-2 py-1 text-[11px] text-muted-foreground"
                    >
                      {field}
                    </span>
                  ))}
                </div>
                <Button
                  className="mt-4 w-full"
                  size="sm"
                  variant={provider.installed ? "outline" : "default"}
                  disabled={Boolean(provider.installed) || installingProvider === provider.key}
                  onClick={() => void installProvider(provider)}
                >
                  {provider.installed
                    ? `В каталоге: /${provider.installed.serviceCatalogSlug}`
                    : installingProvider === provider.key
                      ? "Добавляем..."
                      : "Добавить в каталог"}
                </Button>
              </div>
            ))}
          </div>

          {customProviders.length > 0 && (
            <div className="rounded-md border border-dashed p-3">
              <div className="mb-2 text-xs font-medium text-muted-foreground">Свои провайдеры</div>
              <div className="flex flex-wrap gap-2">
                {customProviders.map((provider) => (
                  <Badge key={provider.key} variant="outline">
                    {provider.name} · {provider.serviceName} · /
                    {provider.installed.serviceCatalogSlug}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-md border bg-muted/20 p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">Свой провайдер</div>
                <p className="text-xs text-muted-foreground">
                  Если нужного исполнителя нет в витрине, добавьте его как partner service и сразу
                  включите в каталог.
                </p>
              </div>
              <HandshakeIcon className="size-4 text-muted-foreground" />
            </div>
            <div className="grid gap-3 lg:grid-cols-[1fr_1fr_180px]">
              <div className="space-y-1">
                <Label className="text-xs">Провайдер</Label>
                <Input
                  value={customProviderForm.providerName}
                  onChange={(e) => updateCustomProviderForm({ providerName: e.target.value })}
                  placeholder="Chef Sasha"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Услуга</Label>
                <Input
                  value={customProviderForm.serviceName}
                  onChange={(e) => updateCustomProviderForm({ serviceName: e.target.value })}
                  placeholder="Private dinner"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Комиссия, %</Label>
                <Input
                  value={customProviderForm.commissionPct}
                  onChange={(e) => updateCustomProviderForm({ commissionPct: e.target.value })}
                  inputMode="decimal"
                />
              </div>
            </div>
            <div className="mt-3 grid gap-3 lg:grid-cols-[220px_1fr]">
              <div className="space-y-1">
                <Label className="text-xs">Категория</Label>
                <Input
                  value={customProviderForm.category}
                  onChange={(e) => updateCustomProviderForm({ category: e.target.value })}
                  placeholder="Custom offer"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Поля заявки</Label>
                <Input
                  value={customProviderForm.requiredFields}
                  onChange={(e) => updateCustomProviderForm({ requiredFields: e.target.value })}
                  placeholder="date, address, budget"
                />
              </div>
            </div>
            <div className="mt-3 space-y-1">
              <Label className="text-xs">Описание</Label>
              <Textarea
                value={customProviderForm.description}
                onChange={(e) => updateCustomProviderForm({ description: e.target.value })}
                placeholder="Что делает провайдер и где оператор должен подтвердить условия"
                rows={2}
              />
            </div>
            <div className="mt-4 flex justify-end">
              <Button
                size="sm"
                onClick={() => void createCustomProvider()}
                disabled={
                  savingCustomProvider ||
                  !customProviderForm.providerName.trim() ||
                  !customProviderForm.serviceName.trim()
                }
              >
                <PlusIcon className="size-4" />
                {savingCustomProvider ? "Добавляем..." : "Добавить своего"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Добавить услугу</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-3 lg:grid-cols-[220px_1fr]">
            <div className="space-y-1">
              <Label className="text-xs">Раздел каталога</Label>
              <Input
                list="catalog-sections"
                value={form.section}
                onChange={(e) => updateForm({ section: e.target.value })}
                placeholder="Недвижимость"
              />
              <datalist id="catalog-sections">
                {sectionOptions.map((section) => (
                  <option key={section} value={section} />
                ))}
              </datalist>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Что продаём</Label>
              <Input
                value={form.name}
                onChange={(e) => updateForm({ name: e.target.value })}
                placeholder="Продажа недвижимости"
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Короткое описание</Label>
            <Textarea
              value={form.description}
              onChange={(e) => updateForm({ description: e.target.value })}
              placeholder="Что получит клиент и когда эту услугу предлагать"
              rows={3}
            />
          </div>

          <div className="space-y-2">
            <Label className="text-xs">Кто исполняет</Label>
            <div className="grid gap-2 md:grid-cols-4">
              {EXECUTOR_OPTIONS.map((option) => {
                const Icon = option.icon;
                const active = form.executor === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => updateForm({ executor: option.value })}
                    className={cn(
                      "rounded-md border p-3 text-left transition-colors",
                      active ? "border-primary bg-primary/10" : "hover:bg-muted",
                    )}
                  >
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <Icon className="size-4" />
                      {option.label}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">{option.description}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="rounded-md border p-3">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium">
              <selectedExecutor.icon className="size-4" />
              {selectedExecutor.label}: маршрут заявки
            </div>

            {form.executor === "own" && (
              <div className="space-y-3">
                <div className="grid gap-2 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => updateForm({ processMode: "new" })}
                    className={cn(
                      "rounded-md border p-3 text-left text-sm",
                      form.processMode === "new"
                        ? "border-primary bg-primary/10"
                        : "hover:bg-muted",
                    )}
                  >
                    <div className="font-medium">Создать новый процесс</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Под эту услугу будет создан отдельный процесс обработки
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => updateForm({ processMode: "existing" })}
                    className={cn(
                      "rounded-md border p-3 text-left text-sm",
                      form.processMode === "existing"
                        ? "border-primary bg-primary/10"
                        : "hover:bg-muted",
                    )}
                  >
                    <div className="font-medium">Использовать существующий</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Услуга будет вести в уже созданный процесс обработки
                    </div>
                  </button>
                </div>

                {form.processMode === "new" ? (
                  <div className="grid gap-3 md:grid-cols-[1fr_220px]">
                    <div className="space-y-1">
                      <Label className="text-xs">Шаблон процесса</Label>
                      <Select
                        value={form.newFunnelTemplate}
                        onValueChange={(value) => updateForm({ newFunnelTemplate: value })}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Выбрать шаблон" />
                        </SelectTrigger>
                        <SelectContent>
                          {selectableTemplates.map((template) => (
                            <SelectItem key={template.key} value={template.key}>
                              {template.displayName} · {template.stagesCount} стадий
                            </SelectItem>
                          ))}
                          {selectableTemplates.length === 0 && (
                            <SelectItem value="skeleton">Пустой процесс</SelectItem>
                          )}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Код процесса</Label>
                      <Input
                        value={form.newFunnelSlug}
                        onChange={(e) =>
                          updateForm({ newFunnelSlug: normalizeSlug(e.target.value) })
                        }
                        placeholder="real_estate_sales"
                      />
                    </div>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <Label className="text-xs">Процесс обработки</Label>
                    <Select
                      value={form.existingFunnelId}
                      onValueChange={(value) => updateForm({ existingFunnelId: value })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Выбрать процесс" />
                      </SelectTrigger>
                      <SelectContent>
                        {funnels.map((funnel) => (
                          <SelectItem key={funnel.id} value={String(funnel.id)}>
                            {funnelLabel(funnel)} · {funnel.stagesCount} стадий
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
            )}

            {form.executor === "partner" && (
              <div className="space-y-2">
                <div className="space-y-1">
                  <Label className="text-xs">Провайдер / партнёрская услуга</Label>
                  <Select
                    value={form.partnerServiceId}
                    onValueChange={(value) => updateForm({ partnerServiceId: value })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Выбрать провайдера" />
                    </SelectTrigger>
                    <SelectContent>
                      {partnerServices.map((service) => (
                        <SelectItem key={service.id} value={String(service.id)}>
                          {service.partnerName ? `${service.partnerName} · ` : ""}
                          {service.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {partnerServices.length === 0 && (
                  <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                    Сначала добавьте партнёра и его услугу на странице{" "}
                    <Link
                      className="text-primary underline-offset-2 hover:underline"
                      to="/partners"
                    >
                      Партнёры
                    </Link>
                    .
                  </div>
                )}
              </div>
            )}

            {form.executor === "webhook" && (
              <div className="space-y-1">
                <Label className="text-xs">Webhook URL</Label>
                <Input
                  value={form.webhookUrl}
                  onChange={(e) => updateForm({ webhookUrl: e.target.value })}
                  placeholder="https://provider.example/webhook"
                />
              </div>
            )}

            {form.executor === "manual" && (
              <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                Заявка появится у оператора без автоматической передачи. Процесс можно добавить
                позже.
              </div>
            )}
          </div>

          <div className="flex justify-end">
            <Button onClick={createOffer} disabled={saving || !form.name.trim()}>
              <PlusIcon className="size-4" />
              Добавить в каталог
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-sm">Разделы каталога</CardTitle>
          <Badge variant="outline">
            {activeCount} активных из {items.length}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-5">
          {sections.length === 0 ? (
            <div className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
              Каталог пока пуст. Добавьте первую услугу сверху.
            </div>
          ) : (
            sections.map((section) => (
              <div key={section.name} className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <h2 className="text-sm font-semibold">{section.name}</h2>
                    <p className="text-xs text-muted-foreground">
                      {section.items.length} {section.items.length === 1 ? "услуга" : "услуг"}
                    </p>
                  </div>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Услуга</TableHead>
                      <TableHead>Исполнитель</TableHead>
                      <TableHead>Куда ведёт</TableHead>
                      <TableHead>Статус</TableHead>
                      <TableHead className="w-20 text-right">Действия</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {section.items.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell className="min-w-[260px] whitespace-normal">
                          <div className="font-medium">{item.name}</div>
                          <div className="mt-1 text-xs text-muted-foreground">/{item.slug}</div>
                          {item.description && (
                            <div className="mt-1 max-w-xl text-xs text-muted-foreground">
                              {item.description}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary">{routeLabel(item.routeType)}</Badge>
                        </TableCell>
                        <TableCell className="max-w-[320px] whitespace-normal text-sm text-muted-foreground">
                          {targetLabel(item)}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Switch
                              checked={item.isActive}
                              disabled={savingId === item.id}
                              onCheckedChange={(checked) => void toggleItem(item, checked)}
                            />
                            <span className="text-xs text-muted-foreground">
                              {item.isActive ? "Активна" : "Выключена"}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            disabled={savingId === item.id}
                            onClick={() => void deleteItem(item)}
                          >
                            <Trash2Icon className="size-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

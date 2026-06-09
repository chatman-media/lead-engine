import {
  ArchiveIcon,
  MessageCircleIcon,
  PauseCircleIcon,
  PlayCircleIcon,
  PlusIcon,
  RefreshCwIcon,
  StoreIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { type ChannelItem, type RelayProvider, type RelayProviderStatus, saas } from "@/api/saas";
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
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

const STATUSES: RelayProviderStatus[] = ["active", "paused", "archived"];

function statusLabel(status: RelayProviderStatus): string {
  if (status === "active") return "active";
  if (status === "paused") return "paused";
  return "archived";
}

function statusVariant(status: RelayProviderStatus): "default" | "secondary" | "outline" {
  if (status === "active") return "secondary";
  if (status === "paused") return "outline";
  return "default";
}

function channelLabel(channel: ChannelItem): string {
  const kind = channel.kind.replace("_", " ");
  return `${kind} · ${channel.username ?? channel.externalId}`;
}

function providerIdentityLabel(identity: RelayProvider["identities"][number]): string {
  return `${identity.channelKind.replace("_", " ")} · ${identity.externalUserId}`;
}

export function SaasProviders() {
  const [providers, setProviders] = useState<RelayProvider[]>([]);
  const [channels, setChannels] = useState<ChannelItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const [name, setName] = useState("");
  const [category, setCategory] = useState("massage");
  const [serviceArea, setServiceArea] = useState("");
  const [commissionPct, setCommissionPct] = useState("20");
  const [notes, setNotes] = useState("");

  const [editName, setEditName] = useState("");
  const [editCategory, setEditCategory] = useState("");
  const [editArea, setEditArea] = useState("");
  const [editCommission, setEditCommission] = useState("");
  const [editNotes, setEditNotes] = useState("");

  const [identityChannelId, setIdentityChannelId] = useState("");
  const [identityExternalId, setIdentityExternalId] = useState("");
  const [serviceType, setServiceType] = useState("massage");
  const [serviceName, setServiceName] = useState("");
  const [serviceCommission, setServiceCommission] = useState("");
  const [serviceAreaInput, setServiceAreaInput] = useState("");
  const [saving, setSaving] = useState(false);

  const selected = useMemo(
    () => providers.find((provider) => provider.id === selectedId) ?? null,
    [providers, selectedId],
  );

  async function reload() {
    setError("");
    try {
      const [providerRes, channelRes] = await Promise.all([
        saas.listProviders(),
        saas.listChannels(),
      ]);
      setProviders(providerRes.items);
      setChannels(channelRes.items);
      if (selectedId && !providerRes.items.some((provider) => provider.id === selectedId)) {
        setSelectedId(null);
      }
      if (!identityChannelId && channelRes.items[0])
        setIdentityChannelId(String(channelRes.items[0].id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось загрузить провайдеров");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  useEffect(() => {
    if (!selected) return;
    setEditName(selected.name);
    setEditCategory(selected.category ?? "");
    setEditArea(selected.serviceArea ?? "");
    setEditCommission(String(selected.defaultCommissionPct ?? 0));
    setEditNotes(selected.notes ?? "");
    setServiceAreaInput(selected.serviceArea ?? "");
  }, [selected]);

  async function createProvider() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const res = await saas.createProvider({
        name: name.trim(),
        category: category.trim() || null,
        serviceArea: serviceArea.trim() || null,
        defaultCommissionPct: Number(commissionPct || 0),
        notes: notes.trim() || null,
      });
      setName("");
      setNotes("");
      setSelectedId(res.item.id);
      toast.success("Провайдер создан");
      await reload();
    } finally {
      setSaving(false);
    }
  }

  async function updateSelectedProvider(
    patch: Partial<RelayProvider> & { status?: RelayProviderStatus },
  ) {
    if (!selected) return;
    const res = await saas.updateProvider(selected.id, patch);
    setProviders((items) => items.map((item) => (item.id === res.item.id ? res.item : item)));
    toast.success("Провайдер обновлён");
  }

  async function saveProfile() {
    if (!selected || !editName.trim()) return;
    setSaving(true);
    try {
      await updateSelectedProvider({
        name: editName.trim(),
        category: editCategory.trim() || null,
        serviceArea: editArea.trim() || null,
        defaultCommissionPct: Number(editCommission || 0),
        notes: editNotes.trim() || null,
      });
    } finally {
      setSaving(false);
    }
  }

  async function archiveSelected() {
    if (!selected) return;
    const res = await saas.archiveProvider(selected.id);
    setProviders((items) => items.map((item) => (item.id === res.item.id ? res.item : item)));
    toast.success("Провайдер архивирован");
  }

  async function attachIdentity() {
    if (!selected || !identityChannelId || !identityExternalId.trim()) return;
    setSaving(true);
    try {
      const res = await saas.attachProviderIdentity(selected.id, {
        channelId: Number(identityChannelId),
        externalUserId: identityExternalId.trim(),
      });
      setProviders((items) => items.map((item) => (item.id === res.item.id ? res.item : item)));
      setIdentityExternalId("");
      toast.success("Identity привязана");
    } finally {
      setSaving(false);
    }
  }

  async function createService() {
    if (!selected || !serviceType.trim() || !serviceName.trim()) return;
    setSaving(true);
    try {
      const res = await saas.createProviderService(selected.id, {
        serviceType: serviceType.trim(),
        name: serviceName.trim(),
        serviceArea: serviceAreaInput.trim() || null,
        commissionPct: serviceCommission ? Number(serviceCommission) : null,
      });
      setProviders((items) => items.map((item) => (item.id === res.item.id ? res.item : item)));
      setServiceName("");
      toast.success("Услуга добавлена");
    } finally {
      setSaving(false);
    }
  }

  async function toggleService(serviceId: number, isActive: boolean) {
    const res = await saas.updateProviderService(serviceId, { isActive });
    setProviders((items) => items.map((item) => (item.id === res.item.id ? res.item : item)));
  }

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Загрузка…</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <PageHeader title="Провайдеры" description="Исполнители, каналы связи и сервисы relay" />
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
        <CardHeader>
          <CardTitle className="text-sm">Новый провайдер</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 lg:grid-cols-[1.2fr_160px_180px_120px_1.2fr_auto]">
          <div className="space-y-1">
            <Label className="text-xs">Название</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Lotus Spa" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Категория</Label>
            <Input value={category} onChange={(e) => setCategory(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Зона</Label>
            <Input
              value={serviceArea}
              onChange={(e) => setServiceArea(e.target.value)}
              placeholder="Phuket"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Комиссия, %</Label>
            <Input
              type="number"
              value={commissionPct}
              onChange={(e) => setCommissionPct(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Заметки</Label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <Button className="self-end" onClick={createProvider} disabled={!name.trim() || saving}>
            <PlusIcon className="size-4" />
            Создать
          </Button>
        </CardContent>
      </Card>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {providers.map((provider) => (
          <button
            key={provider.id}
            type="button"
            className="rounded-md border bg-card p-4 text-left shadow-xs transition hover:border-primary/60"
            onClick={() => setSelectedId(provider.id)}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <StoreIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate font-medium">{provider.name}</span>
                </div>
                <div className="mt-1 truncate text-xs text-muted-foreground">
                  {provider.category ?? "без категории"} · {provider.serviceArea ?? "без зоны"}
                </div>
              </div>
              <Badge variant={statusVariant(provider.status)}>{statusLabel(provider.status)}</Badge>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-2 text-xs text-muted-foreground">
              <span>{provider.servicesCount} услуг</span>
              <span>{provider.identities.length} identity</span>
              <span>{provider.activeOrdersCount} заказов</span>
            </div>
          </button>
        ))}
        {providers.length === 0 && (
          <div className="flex items-center gap-2 rounded-md border border-dashed p-6 text-sm text-muted-foreground">
            <StoreIcon className="size-4" />
            Провайдеров пока нет
          </div>
        )}
      </div>

      <Sheet open={!!selected} onOpenChange={(open) => !open && setSelectedId(null)}>
        <SheetContent className="w-full overflow-y-auto p-6 sm:max-w-2xl">
          {selected && (
            <div className="space-y-6">
              <div className="flex items-start justify-between gap-4 pr-8">
                <div className="min-w-0">
                  <SheetTitle className="truncate text-lg">{selected.name}</SheetTitle>
                  <div className="mt-1 text-xs text-muted-foreground">
                    #{selected.id} · contact {selected.contactId}
                  </div>
                </div>
                <Badge variant={statusVariant(selected.status)}>
                  {statusLabel(selected.status)}
                </Badge>
              </div>

              <div className="grid gap-3 sm:grid-cols-[1fr_160px_auto]">
                <div className="space-y-1">
                  <Label className="text-xs">Статус</Label>
                  <Select
                    value={selected.status}
                    onValueChange={(value) =>
                      void updateSelectedProvider({ status: value as RelayProviderStatus })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {STATUSES.map((status) => (
                        <SelectItem key={status} value={status}>
                          {statusLabel(status)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Активные услуги</Label>
                  <div className="flex h-10 items-center rounded-md border px-3 text-sm">
                    {selected.activeServicesCount}/{selected.servicesCount}
                  </div>
                </div>
                <Button
                  className="self-end"
                  variant="outline"
                  onClick={() =>
                    selected.status === "active"
                      ? void updateSelectedProvider({ status: "paused" })
                      : void updateSelectedProvider({ status: "active" })
                  }
                >
                  {selected.status === "active" ? (
                    <PauseCircleIcon className="size-4" />
                  ) : (
                    <PlayCircleIcon className="size-4" />
                  )}
                  {selected.status === "active" ? "Пауза" : "Активировать"}
                </Button>
              </div>

              <section className="space-y-3 rounded-md border p-4">
                <div className="text-sm font-medium">Профиль</div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label className="text-xs">Название</Label>
                    <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Категория</Label>
                    <Input value={editCategory} onChange={(e) => setEditCategory(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Зона</Label>
                    <Input value={editArea} onChange={(e) => setEditArea(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Комиссия, %</Label>
                    <Input
                      type="number"
                      value={editCommission}
                      onChange={(e) => setEditCommission(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1 sm:col-span-2">
                    <Label className="text-xs">Заметки</Label>
                    <Textarea value={editNotes} onChange={(e) => setEditNotes(e.target.value)} />
                  </div>
                </div>
                <div className="flex justify-between gap-2">
                  <Button
                    variant="outline"
                    onClick={archiveSelected}
                    disabled={selected.status === "archived"}
                  >
                    <ArchiveIcon className="size-4" />
                    Архив
                  </Button>
                  <Button onClick={saveProfile} disabled={!editName.trim() || saving}>
                    Сохранить
                  </Button>
                </div>
              </section>

              <section className="space-y-3 rounded-md border p-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-medium">Каналы</div>
                  <Badge variant="outline">{selected.identities.length}</Badge>
                </div>
                <div className="space-y-2">
                  {selected.identities.map((identity) => (
                    <div
                      key={identity.id}
                      className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
                    >
                      <MessageCircleIcon className="size-4 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">
                        {providerIdentityLabel(identity)}
                      </span>
                      <Badge
                        variant={identity.channelStatus === "active" ? "secondary" : "outline"}
                      >
                        {identity.channelStatus}
                      </Badge>
                    </div>
                  ))}
                  {selected.identities.length === 0 && (
                    <p className="text-sm text-muted-foreground">Identity не привязаны</p>
                  )}
                </div>
                <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                  <Select value={identityChannelId} onValueChange={setIdentityChannelId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Канал" />
                    </SelectTrigger>
                    <SelectContent>
                      {channels.map((channel) => (
                        <SelectItem key={channel.id} value={String(channel.id)}>
                          {channelLabel(channel)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    value={identityExternalId}
                    onChange={(e) => setIdentityExternalId(e.target.value)}
                    placeholder="external user id"
                  />
                  <Button
                    onClick={attachIdentity}
                    disabled={!identityChannelId || !identityExternalId.trim() || saving}
                  >
                    Привязать
                  </Button>
                </div>
              </section>

              <section className="space-y-3 rounded-md border p-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-medium">Услуги</div>
                  <Badge variant="outline">{selected.services.length}</Badge>
                </div>
                <div className="space-y-2">
                  {selected.services.map((service) => (
                    <div key={service.id} className="rounded-md border px-3 py-2">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">{service.name}</div>
                          <div className="truncate text-xs text-muted-foreground">
                            {service.serviceType} ·{" "}
                            {service.serviceArea ?? selected.serviceArea ?? "без зоны"} ·{" "}
                            {service.commissionPct ?? selected.defaultCommissionPct}%
                          </div>
                        </div>
                        <Switch
                          checked={service.isActive}
                          onCheckedChange={(checked) => void toggleService(service.id, checked)}
                        />
                      </div>
                    </div>
                  ))}
                  {selected.services.length === 0 && (
                    <p className="text-sm text-muted-foreground">Услуг пока нет</p>
                  )}
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Input
                    value={serviceType}
                    onChange={(e) => setServiceType(e.target.value)}
                    placeholder="type"
                  />
                  <Input
                    value={serviceName}
                    onChange={(e) => setServiceName(e.target.value)}
                    placeholder="Название"
                  />
                  <Input
                    value={serviceAreaInput}
                    onChange={(e) => setServiceAreaInput(e.target.value)}
                    placeholder="Зона"
                  />
                  <Input
                    type="number"
                    value={serviceCommission}
                    onChange={(e) => setServiceCommission(e.target.value)}
                    placeholder="Комиссия, %"
                  />
                </div>
                <Button
                  onClick={createService}
                  disabled={!serviceType.trim() || !serviceName.trim() || saving}
                >
                  <PlusIcon className="size-4" />
                  Добавить услугу
                </Button>
              </section>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

import { HandshakeIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  type FunnelData,
  type FunnelListItem,
  type Partner,
  type PartnerDeal,
  type PartnerService,
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
import { Textarea } from "@/components/ui/textarea";

interface StageOption {
  id: number;
  label: string;
  funnelId: number;
}

function money(value: number | null | undefined, currency = "THB") {
  if (value == null) return "—";
  return `${Number(value).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} ${currency}`;
}

function marketplaceSourceLabel(notes: string | null | undefined): string | null {
  if (!notes) return null;
  try {
    const parsed = JSON.parse(notes) as { source?: string };
    if (parsed.source === "provider_marketplace") return "Marketplace";
    if (parsed.source === "provider_marketplace_custom") return "Custom provider";
  } catch {
    return null;
  }
  return null;
}

function funnelLabel(item: Pick<FunnelListItem, "slug" | "verticalTemplateId">): string {
  const key = `${item.slug} ${item.verticalTemplateId ?? ""}`.toLowerCase();
  if (key.includes("exchange")) return "Обменка";
  if (key.includes("real_estate")) return "Недвижимость";
  if (key.includes("partner")) return "Партнёры";
  if (key.includes("saas") || key.includes("product")) return "Продукт";
  return item.slug.replace(/_/g, " ");
}

export function SaasPartners() {
  const [partners, setPartners] = useState<Partner[]>([]);
  const [services, setServices] = useState<PartnerService[]>([]);
  const [deals, setDeals] = useState<PartnerDeal[]>([]);
  const [funnels, setFunnels] = useState<FunnelListItem[]>([]);
  const [funnelData, setFunnelData] = useState<FunnelData[]>([]);
  const [loading, setLoading] = useState(true);
  const [partnerName, setPartnerName] = useState("");
  const [partnerPct, setPartnerPct] = useState("10");
  const [servicePartnerId, setServicePartnerId] = useState("");
  const [serviceName, setServiceName] = useState("");
  const [serviceStageId, setServiceStageId] = useState("");
  const [servicePct, setServicePct] = useState("10");
  const [error, setError] = useState("");

  const stageOptions = useMemo<StageOption[]>(() => {
    const byId = new Map(funnels.map((f) => [f.id, funnelLabel(f)]));
    return funnelData.flatMap((fd) =>
      fd.stages.map((s) => ({
        id: s.id,
        funnelId: fd.funnel?.id ?? s.funnelId,
        label: `${byId.get(fd.funnel?.id ?? s.funnelId) ?? "Воронка"} · ${s.displayName}`,
      })),
    );
  }, [funnelData, funnels]);

  async function reload() {
    setError("");
    try {
      const [partnerRes, serviceRes, dealRes, funnelRes] = await Promise.all([
        saas.listPartners(),
        saas.listPartnerServices(),
        saas.listPartnerDeals(),
        saas.listFunnels(),
      ]);
      setPartners(partnerRes.items);
      setServices(serviceRes.items);
      setDeals(dealRes.items);
      setFunnels(funnelRes.items);
      const loadedFunnels = await Promise.all(
        funnelRes.items.map((f) => saas.getFunnelById(f.id).catch(() => null)),
      );
      setFunnelData(loadedFunnels.filter(Boolean) as FunnelData[]);
      if (!servicePartnerId && partnerRes.items[0])
        setServicePartnerId(String(partnerRes.items[0].id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось загрузить партнёров");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function createPartner() {
    if (!partnerName.trim()) return;
    await saas.createPartner({
      name: partnerName.trim(),
      defaultCommissionPct: Number(partnerPct || 0),
      settlementCurrency: "THB",
    });
    setPartnerName("");
    toast.success("Партнёр создан");
    await reload();
  }

  async function createService() {
    const stage = stageOptions.find((s) => String(s.id) === serviceStageId);
    if (!servicePartnerId || !serviceName.trim()) return;
    await saas.createPartnerService({
      partnerId: Number(servicePartnerId),
      name: serviceName.trim(),
      funnelId: stage?.funnelId ?? null,
      stageDefinitionId: stage?.id ?? null,
      commissionPct: Number(servicePct || 0),
    });
    setServiceName("");
    setServiceStageId("");
    toast.success("Услуга создана");
    await reload();
  }

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Загрузка…</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <PageHeader title="Партнёры" description="Передача заявок, оборот партнёров и комиссия" />
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

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Новый партнёр</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-[1fr_120px_auto]">
            <div className="space-y-1">
              <Label className="text-xs">Название</Label>
              <Input
                value={partnerName}
                onChange={(e) => setPartnerName(e.target.value)}
                placeholder="Agency Phuket"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Комиссия, %</Label>
              <Input
                type="number"
                value={partnerPct}
                onChange={(e) => setPartnerPct(e.target.value)}
              />
            </div>
            <Button className="self-end" onClick={createPartner} disabled={!partnerName.trim()}>
              <PlusIcon className="size-4" />
              Создать
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Услуга партнёра</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">Партнёр</Label>
              <Select value={servicePartnerId} onValueChange={setServicePartnerId}>
                <SelectTrigger>
                  <SelectValue placeholder="Выбрать" />
                </SelectTrigger>
                <SelectContent>
                  {partners.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Название услуги</Label>
              <Input
                value={serviceName}
                onChange={(e) => setServiceName(e.target.value)}
                placeholder="Недвижимость: подбор"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Стадия handoff</Label>
              <Select value={serviceStageId} onValueChange={setServiceStageId}>
                <SelectTrigger>
                  <SelectValue placeholder="Не привязано" />
                </SelectTrigger>
                <SelectContent>
                  {stageOptions.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end gap-2">
              <div className="flex-1 space-y-1">
                <Label className="text-xs">Комиссия, %</Label>
                <Input
                  type="number"
                  value={servicePct}
                  onChange={(e) => setServicePct(e.target.value)}
                />
              </div>
              <Button onClick={createService} disabled={!servicePartnerId || !serviceName.trim()}>
                Создать
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-[360px_1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Партнёры</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {partners.map((p) => (
              <div key={p.id} className="rounded-md border p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-medium">{p.name}</div>
                  <Badge variant={p.status === "active" ? "secondary" : "outline"}>
                    {p.status}
                  </Badge>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2 text-xs text-muted-foreground">
                  <span>{p.servicesCount ?? 0} услуг</span>
                  <span>{p.dealsCount ?? 0} сделок</span>
                  <span>{money(p.commissionTotal ?? 0)}</span>
                </div>
              </div>
            ))}
            {partners.length === 0 && (
              <p className="text-sm text-muted-foreground">Партнёров пока нет</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-sm">Сделки</CardTitle>
            <Badge variant="outline">{deals.length}</Badge>
          </CardHeader>
          <CardContent className="space-y-3">
            {deals.map((deal) => (
              <DealRow key={deal.id} deal={deal} onSaved={reload} />
            ))}
            {deals.length === 0 && (
              <div className="flex items-center gap-2 rounded-md border border-dashed p-6 text-sm text-muted-foreground">
                <HandshakeIcon className="size-4" />
                Сделки появятся после перехода лида на партнёрскую стадию
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Услуги</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {services.map((s) => (
            <div key={s.id} className="rounded-md border p-3 text-sm">
              <div className="font-medium">{s.name}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {s.partnerName ?? "Партнёр"} · {s.commissionPct}%
              </div>
              <div className="mt-2 text-xs">
                {s.stageName ? `Стадия: ${s.stageName}` : "Без привязки к стадии"}
              </div>
            </div>
          ))}
          {services.length === 0 && <p className="text-sm text-muted-foreground">Услуг пока нет</p>}
        </CardContent>
      </Card>
    </div>
  );
}

function DealRow({ deal, onSaved }: { deal: PartnerDeal; onSaved: () => void | Promise<void> }) {
  const [status, setStatus] = useState(deal.status);
  const [gross, setGross] = useState(deal.grossAmount?.toString() ?? "");
  const [currency, setCurrency] = useState(deal.currency);
  const [notes, setNotes] = useState(deal.notes ?? "");
  const [saving, setSaving] = useState(false);
  const sourceLabel = marketplaceSourceLabel(deal.partnerServiceNotes);

  async function save() {
    setSaving(true);
    try {
      await saas.updatePartnerDeal(deal.id, {
        status,
        grossAmount: gross ? Number(gross) : null,
        currency,
        notes: notes.trim() || null,
      });
      toast.success("Сделка обновлена");
      await onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="font-medium">
            #{deal.id} · {deal.partnerName ?? "Партнёр не выбран"}
          </div>
          <div className="text-xs text-muted-foreground">
            {deal.serviceName ?? "Услуга"} · лид {deal.leadId ?? "—"} ·{" "}
            {deal.stageName ?? "стадия не указана"}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {sourceLabel && <Badge variant="secondary">{sourceLabel}</Badge>}
          <Badge variant={status === "completed" ? "secondary" : "outline"}>{status}</Badge>
        </div>
      </div>
      <div className="mt-3 grid gap-2 md:grid-cols-[160px_120px_120px_1fr_auto]">
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="sent">sent</SelectItem>
            <SelectItem value="accepted">accepted</SelectItem>
            <SelectItem value="rejected">rejected</SelectItem>
            <SelectItem value="completed">completed</SelectItem>
            <SelectItem value="cancelled">cancelled</SelectItem>
            <SelectItem value="disputed">disputed</SelectItem>
            <SelectItem value="settled">settled</SelectItem>
          </SelectContent>
        </Select>
        <Input
          type="number"
          value={gross}
          onChange={(e) => setGross(e.target.value)}
          placeholder="Оборот"
        />
        <Input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
        <Textarea
          rows={1}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Комментарий"
        />
        <Button onClick={save} disabled={saving}>
          {saving ? "…" : "Сохранить"}
        </Button>
      </div>
      <div className="mt-2 text-xs text-muted-foreground">
        Комиссия: {deal.commissionPct}% · {money(deal.commissionAmount, deal.currency)}
      </div>
    </div>
  );
}

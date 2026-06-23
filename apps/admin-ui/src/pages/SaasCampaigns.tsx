import { PlayIcon, PauseIcon, RocketIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { ApiError, clearToken, type DripCampaign, type LeadListItem, saas } from "@/api/saas";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "success" | "warning"> = {
  draft: "secondary",
  active: "success",
  paused: "warning",
  completed: "default",
};

/** Матчит вставленные строки (имена контактов) к загруженным лидам. */
function matchLeads(
  pasted: string[],
  leads: LeadListItem[],
): { matched: LeadListItem[]; unmatched: string[] } {
  const byName = new Map<string, LeadListItem>();
  for (const l of leads) {
    if (l.contactName) byName.set(l.contactName.trim().toLowerCase(), l);
  }
  const matched: LeadListItem[] = [];
  const seen = new Set<number>();
  const unmatched: string[] = [];
  for (const raw of pasted) {
    const key = raw.trim().toLowerCase();
    if (!key) continue;
    const hit =
      byName.get(key) ?? leads.find((l) => l.contactName?.trim().toLowerCase().includes(key));
    if (hit && !seen.has(hit.id)) {
      seen.add(hit.id);
      matched.push(hit);
    } else if (!hit) {
      unmatched.push(raw.trim());
    }
  }
  return { matched, unmatched };
}

export function SaasCampaigns() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [campaigns, setCampaigns] = useState<DripCampaign[]>([]);
  const [leads, setLeads] = useState<LeadListItem[]>([]);

  const [name, setName] = useState("");
  const [greeting, setGreeting] = useState("Здравствуйте, {name}! ");
  const [perTick, setPerTick] = useState("1");
  const [intervalSec, setIntervalSec] = useState("60");
  const [paste, setPaste] = useState("");
  const [creating, setCreating] = useState(false);

  function handle401(err: unknown) {
    if (err instanceof ApiError && err.status === 401) {
      clearToken();
      navigate("/login", { replace: true });
      return true;
    }
    return false;
  }

  async function load() {
    setLoading(true);
    try {
      const [c, l] = await Promise.all([saas.listDripCampaigns(), saas.listLeads({ limit: 500 })]);
      setCampaigns(c.campaigns);
      setLeads(l.items);
    } catch (err) {
      if (!handle401(err)) toast.error("Не удалось загрузить кампании");
    } finally {
      setLoading(false);
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: run once
  useEffect(() => {
    void load();
  }, []);

  const pastedLines = paste
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const preview = matchLeads(pastedLines, leads);

  async function create() {
    if (!name.trim()) return toast.error("Укажите название кампании");
    if (!greeting.trim()) return toast.error("Укажите приветствие");
    const leadIds = preview.matched.map((l) => l.id);
    if (leadIds.length === 0) return toast.error("Нет совпавших лидов для рассылки");
    setCreating(true);
    try {
      const r = await saas.createDripCampaign({
        name: name.trim(),
        greetingText: greeting,
        dripPerTick: Math.max(1, Number(perTick) || 1),
        dripIntervalSec: Math.max(0, Number(intervalSec) || 0),
        leadIds,
      });
      await saas.updateDripCampaign(r.id, { status: "active" });
      toast.success(
        `Кампания запущена: ${r.leadsAdded} лидов${preview.unmatched.length ? `, не найдено ${preview.unmatched.length}` : ""}`,
      );
      setName("");
      setPaste("");
      await load();
    } catch (err) {
      if (!handle401(err)) toast.error("Не удалось создать кампанию");
    } finally {
      setCreating(false);
    }
  }

  async function setStatus(id: number, status: string) {
    try {
      await saas.updateDripCampaign(id, { status });
      await load();
    } catch (err) {
      if (!handle401(err)) toast.error("Не удалось изменить статус");
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <PageHeader
          title="Капельные кампании"
          description="Рассылка лидам по одному с заданной скоростью"
        />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Капельные кампании"
        description="Вставьте список лидов — бот напишет им по одному с приветствием и заданной скоростью"
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Новая кампания</CardTitle>
          <p className="text-muted-foreground text-xs">
            Telegram-бот может писать только тем, кто уже писал боту — холодные контакты будут
            пропущены.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label className="text-xs">Название</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Напр. Весенняя рассылка"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-xs">По сколько за раз</Label>
                <Input
                  type="number"
                  min={1}
                  value={perTick}
                  onChange={(e) => setPerTick(e.target.value)}
                />
              </div>
              <div>
                <Label className="text-xs">Интервал, сек</Label>
                <Input
                  type="number"
                  min={0}
                  value={intervalSec}
                  onChange={(e) => setIntervalSec(e.target.value)}
                />
              </div>
            </div>
          </div>
          <div>
            <Label className="text-xs">Приветствие (можно использовать {"{name}"})</Label>
            <Textarea rows={3} value={greeting} onChange={(e) => setGreeting(e.target.value)} />
          </div>
          <div>
            <Label className="text-xs">Список лидов — по имени контакта, по одному в строке</Label>
            <Textarea
              rows={5}
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              placeholder={"Иван Петров\nМария Лебедева\n…"}
            />
          </div>
          {pastedLines.length > 0 && (
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant="success">Совпало: {preview.matched.length}</Badge>
              {preview.unmatched.length > 0 && (
                <Badge variant="warning">Не найдено: {preview.unmatched.length}</Badge>
              )}
            </div>
          )}
          <Button type="button" onClick={create} disabled={creating} className="gap-2">
            <RocketIcon className="size-4" />
            {creating ? "Запускаем…" : "Создать и запустить"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Кампании</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {campaigns.length === 0 && (
            <p className="text-muted-foreground text-sm">Пока нет кампаний.</p>
          )}
          {campaigns.map((c) => (
            <div
              key={c.id}
              className="flex items-center justify-between gap-3 rounded-lg border p-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{c.name}</span>
                  <Badge variant={STATUS_VARIANT[c.status] ?? "secondary"}>{c.status}</Badge>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  по {c.dripPerTick} раз в {c.dripIntervalSec}с · отправлено {c.sent}/{c.total}
                  {c.skipped > 0 ? ` · пропущено ${c.skipped}` : ""} · ждут {c.pending}
                </div>
              </div>
              <div className="flex shrink-0 gap-1">
                {c.status !== "active" && c.status !== "completed" && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1"
                    onClick={() => setStatus(c.id, "active")}
                  >
                    <PlayIcon className="size-3.5" /> Запустить
                  </Button>
                )}
                {c.status === "active" && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1"
                    onClick={() => setStatus(c.id, "paused")}
                  >
                    <PauseIcon className="size-3.5" /> Пауза
                  </Button>
                )}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

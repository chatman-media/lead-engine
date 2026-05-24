import {
  CalendarIcon,
  CheckIcon,
  ClipboardCopyIcon,
  CpuIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getToken } from "../api/saas.ts";
import { type BookingConfig, tools } from "../api/tools.ts";

const MCP_TOOLS = [
  { name: "kb_search", desc: "Поиск по базе знаний (BM25 + vector)" },
  { name: "lead_list", desc: "Список лидов с фильтром по стадии" },
  { name: "lead_get", desc: "Карточка лида по ID" },
  { name: "lead_move_stage", desc: "Сменить стадию лида" },
  { name: "conversation_history", desc: "История сообщений разговора" },
];

export function ToolsSettings() {
  const [booking, setBooking] = useState<BookingConfig | null>(null);
  const [urlInput, setUrlInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const mcpUrl = `${window.location.origin}/mcp`;
  const token = getToken() ?? "";

  async function refresh() {
    try {
      const cfg = await tools.getBookingConfig();
      setBooking(cfg);
      if (cfg.url) setUrlInput(cfg.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleSave() {
    const url = urlInput.trim();
    if (!url) return;
    setSaving(true);
    setError("");
    try {
      await tools.saveBookingUrl(url);
      await refresh();
      toast.success("Ссылка сохранена — бот начнёт предлагать её при следующем сообщении");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setConfirmDelete(false);
    setError("");
    try {
      await tools.deleteBookingUrl();
      setUrlInput("");
      await refresh();
      toast.success("Ссылка удалена — бот больше не предлагает бронирование");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function copyToClipboard(text: string, label: string) {
    navigator.clipboard.writeText(text).then(() => toast.success(`${label} скопирован`));
  }

  return (
    <div className="space-y-6 p-6">
      <PageHeader title="Инструменты бота" />

      {loading ? (
        <p className="text-muted-foreground text-sm">Загрузка...</p>
      ) : (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <CalendarIcon className="h-5 w-5 text-primary" />
                <CardTitle className="text-base">Ссылка бронирования</CardTitle>
              </div>
              {booking?.enabled ? (
                <Badge variant="default" className="bg-green-600">
                  <CheckIcon className="mr-1 h-3 w-3" />
                  Включено
                </Badge>
              ) : (
                <Badge variant="secondary">Выключено</Badge>
              )}
            </div>
            <CardDescription>
              Когда кандидат или лид просит записаться на звонок / демо, бот вызывает этот
              инструмент и вставляет ссылку в ответ. Поддерживает Calendly, Cal.com, Tidycal и
              любой другой URL.
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="booking-url">Ссылка бронирования</Label>
              <div className="flex gap-2">
                <Input
                  id="booking-url"
                  type="url"
                  placeholder="https://calendly.com/your-name/30min"
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSave()}
                  className="flex-1"
                />
                <Button onClick={handleSave} disabled={saving || !urlInput.trim()}>
                  {saving ? "Сохранение..." : "Сохранить"}
                </Button>
                {booking?.enabled && (
                  confirmDelete ? (
                    <>
                      <span className="self-center text-sm text-muted-foreground">Удалить?</span>
                      <Button size="sm" variant="destructive" onClick={handleDelete}>Да</Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>Нет</Button>
                    </>
                  ) : (
                    <Button variant="ghost" size="icon" onClick={() => setConfirmDelete(true)} title="Удалить">
                      <Trash2Icon className="h-4 w-4 text-destructive" />
                    </Button>
                  )
                )}
              </div>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <p className="text-muted-foreground text-xs">
              Бот предлагает ссылку только когда человек явно просит записаться — не навязывает
              её в каждом ответе. Требует модель с поддержкой function calling (GPT-4o, GPT-4o
              mini, Claude 3.5+).
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── MCP ────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <CpuIcon className="h-5 w-5 text-primary" />
            <CardTitle className="text-base">MCP — подключить Claude / Cursor</CardTitle>
          </div>
          <CardDescription>
            Model Context Protocol — ваши данные доступны прямо в Claude Desktop, Cursor и любом
            MCP-клиенте. Бот может искать по базе знаний, просматривать и двигать лидов.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {/* Endpoint */}
          <div className="space-y-1.5">
            <Label className="text-xs">Endpoint</Label>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded-md bg-muted px-3 py-1.5 text-xs font-mono break-all">
                POST {mcpUrl}
              </code>
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0 h-7 w-7"
                onClick={() => copyToClipboard(mcpUrl, "URL")}
              >
                <ClipboardCopyIcon className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          {/* Token */}
          <div className="space-y-1.5">
            <Label className="text-xs">Bearer токен (текущая сессия)</Label>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded-md bg-muted px-3 py-1.5 text-xs font-mono truncate">
                {token ? `${token.slice(0, 32)}…` : "не авторизован"}
              </code>
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0 h-7 w-7"
                disabled={!token}
                onClick={() => copyToClipboard(token, "Токен")}
              >
                <ClipboardCopyIcon className="h-3.5 w-3.5" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Вставьте в конфиг MCP-клиента как{" "}
              <code className="font-mono">Authorization: Bearer &lt;токен&gt;</code>
            </p>
          </div>

          {/* Config snippet */}
          <div className="space-y-1.5">
            <Label className="text-xs">Конфиг для Claude Desktop / Cursor</Label>
            <div className="relative">
              <pre className="rounded-md bg-muted px-3 py-2.5 text-xs font-mono overflow-x-auto">
{`{
  "mcpServers": {
    "lead-engine": {
      "type": "http",
      "url": "${mcpUrl}",
      "headers": {
        "Authorization": "Bearer ${token.slice(0, 32)}…"
      }
    }
  }
}`}
              </pre>
              <Button
                variant="ghost"
                size="icon"
                className="absolute top-2 right-2 h-6 w-6"
                onClick={() => copyToClipboard(
                  JSON.stringify({ mcpServers: { "lead-engine": { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
                  "Конфиг"
                )}
              >
                <ClipboardCopyIcon className="h-3 w-3" />
              </Button>
            </div>
          </div>

          {/* Tools list */}
          <div className="space-y-1.5">
            <Label className="text-xs">Доступные инструменты</Label>
            <ul className="space-y-1">
              {MCP_TOOLS.map((t) => (
                <li key={t.name} className="flex items-start gap-2 text-xs">
                  <code className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-primary font-mono">
                    {t.name}
                  </code>
                  <span className="text-muted-foreground">{t.desc}</span>
                </li>
              ))}
            </ul>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

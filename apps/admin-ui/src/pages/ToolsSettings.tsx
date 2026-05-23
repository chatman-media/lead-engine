import { CalendarIcon, CheckIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type BookingConfig, tools } from "../api/tools.ts";

export function ToolsSettings() {
  const [booking, setBooking] = useState<BookingConfig | null>(null);
  const [urlInput, setUrlInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

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
    if (!confirm("Отключить инструмент бронирования?")) return;
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
                  <Button variant="ghost" size="icon" onClick={handleDelete} title="Удалить">
                    <Trash2Icon className="h-4 w-4 text-destructive" />
                  </Button>
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
    </div>
  );
}

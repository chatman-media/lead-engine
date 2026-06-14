import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, type BotSettings, clearToken, saas } from "@/api/saas";

function minToTime(min: number | null): string {
  if (min == null) return "";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
function timeToMin(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const min = Number(m[1]) * 60 + Number(m[2]);
  return min >= 0 && min <= 1439 ? min : null;
}
function numOrNull(v: string): number | null {
  const t = v.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function SaasBotSettings() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Две «легаси»-настройки на отдельных колонках tenants.
  const [historyLimit, setHistoryLimit] = useState("");
  const [replyDelay, setReplyDelay] = useState("");
  // Остальное — единый JSON-блок bot_settings_json.
  const [s, setS] = useState<BotSettings | null>(null);
  const [savingKey, setSavingKey] = useState<string>("");
  const [savedKey, setSavedKey] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { tenant } = await saas.getTenantInfo();
        if (cancelled) return;
        setHistoryLimit(tenant.replyHistoryLimit == null ? "" : String(tenant.replyHistoryLimit));
        setReplyDelay(tenant.replyDelaySeconds == null ? "" : String(tenant.replyDelaySeconds));
        setS(tenant.botSettings);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          clearToken();
          navigate("/login", { replace: true });
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  function patch(p: Partial<BotSettings>) {
    setS((prev) => (prev ? { ...prev, ...p } : prev));
  }

  async function flash(key: string, fn: () => Promise<void>) {
    setSavingKey(key);
    setSavedKey("");
    try {
      await fn();
      setSavedKey(key);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingKey("");
    }
  }

  async function saveBot(key: string, fields: Partial<BotSettings>) {
    await flash(key, async () => {
      const { botSettings } = await saas.updateBotSettings(fields);
      setS(botSettings);
    });
  }

  const SavedMark = ({ k }: { k: string }) =>
    savedKey === k ? <span className="text-xs text-[var(--success)]">✓ Сохранено</span> : null;

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Загрузка…</div>;
  if (!s) return <div className="p-6 text-sm text-destructive">{error || "Не удалось загрузить настройки"}</div>;

  return (
    <div className="space-y-5">
      <PageHeader title="Поведение бота" description="Как бот отвечает на сообщения клиентов." />
      {error && <div className="text-sm text-destructive">{error}</div>}

      {/* Контекст бота (legacy) */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Контекст бота</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="text-xs text-muted-foreground">
            Сколько последних сообщений диалога бот учитывает как контекст. Пусто = по умолчанию (20).
            Диапазон 2–100.
          </p>
          <div className="flex items-center gap-2">
            <Input type="number" min={2} max={100} value={historyLimit}
              onChange={(e) => setHistoryLimit(e.target.value)} placeholder="20" className="h-8 w-28 text-sm" />
            <Button size="sm" disabled={savingKey === "history"}
              onClick={() => flash("history", async () => {
                await saas.setReplyHistoryLimit(numOrNull(historyLimit));
              })}>Сохранить</Button>
            <SavedMark k="history" />
          </div>
        </CardContent>
      </Card>

      {/* Пауза перед ответом (legacy) */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Пауза перед ответом</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="text-xs text-muted-foreground">
            Сколько секунд бот ждёт перед ответом. Новое сообщение или правка в окне сбрасывают таймер —
            бот ответит один раз по всей переписке. 0/пусто = сразу. Диапазон 0–120.
          </p>
          <div className="flex items-center gap-2">
            <Input type="number" min={0} max={120} value={replyDelay}
              onChange={(e) => setReplyDelay(e.target.value)} placeholder="0" className="h-8 w-28 text-sm" />
            <Button size="sm" disabled={savingKey === "delay"}
              onClick={() => flash("delay", async () => {
                await saas.setReplyDelaySeconds(numOrNull(replyDelay));
              })}>Сохранить</Button>
            <SavedMark k="delay" />
          </div>
        </CardContent>
      </Card>

      {/* Рабочие часы */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Рабочие часы</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-xs text-muted-foreground">
            Вне окна бот не отвечает (диалог ждёт оператора). Можно задать авто-сообщение «вне часов»
            (шлётся не чаще раза в 3 часа).
          </p>
          <div className="flex items-center gap-2">
            <Switch checked={s.hoursEnabled} onCheckedChange={(v) => patch({ hoursEnabled: v })} />
            <span>Включить рабочие часы</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">с</span>
            <Input type="time" value={minToTime(s.hoursStartMin)} disabled={!s.hoursEnabled}
              onChange={(e) => patch({ hoursStartMin: timeToMin(e.target.value) })} className="h-8 w-28 text-sm" />
            <span className="text-xs text-muted-foreground">до</span>
            <Input type="time" value={minToTime(s.hoursEndMin)} disabled={!s.hoursEnabled}
              onChange={(e) => patch({ hoursEndMin: timeToMin(e.target.value) })} className="h-8 w-28 text-sm" />
            <Input placeholder="Asia/Manila" value={s.hoursTz ?? ""} disabled={!s.hoursEnabled}
              onChange={(e) => patch({ hoursTz: e.target.value || null })} className="h-8 w-40 text-sm" />
          </div>
          <Textarea placeholder="Авто-сообщение вне рабочих часов (необязательно)" rows={2}
            value={s.offhoursMessage ?? ""} disabled={!s.hoursEnabled}
            onChange={(e) => patch({ offhoursMessage: e.target.value || null })} className="text-sm" />
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={savingKey === "hours"}
              onClick={() => saveBot("hours", {
                hoursEnabled: s.hoursEnabled, hoursStartMin: s.hoursStartMin, hoursEndMin: s.hoursEndMin,
                hoursTz: s.hoursTz, offhoursMessage: s.offhoursMessage,
              })}>Сохранить</Button>
            <SavedMark k="hours" />
          </div>
        </CardContent>
      </Card>

      {/* Стоп-слова */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Стоп-слова → оператор</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="text-xs text-muted-foreground">
            Если сообщение клиента содержит любое из слов — диалог сразу уходит оператору, бот не отвечает.
            По одному на строку или через запятую.
          </p>
          <Textarea placeholder={"оператор\nчеловек\nжалоба"} rows={3}
            value={s.stopWords.join("\n")}
            onChange={(e) => patch({ stopWords: e.target.value.split(/[\n,]/).map((w) => w.trim()).filter(Boolean) })}
            className="text-sm" />
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={savingKey === "stop"}
              onClick={() => saveBot("stop", { stopWords: s.stopWords })}>Сохранить</Button>
            <SavedMark k="stop" />
          </div>
        </CardContent>
      </Card>

      {/* Приветствие */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Приветствие</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="text-xs text-muted-foreground">
            Автоматическое сообщение при первом обращении клиента. Пусто = без приветствия.
          </p>
          <Textarea placeholder="Здравствуйте! Чем можем помочь?" rows={2}
            value={s.greetingText ?? ""} onChange={(e) => patch({ greetingText: e.target.value || null })}
            className="text-sm" />
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={savingKey === "greet"}
              onClick={() => saveBot("greet", { greetingText: s.greetingText })}>Сохранить</Button>
            <SavedMark k="greet" />
          </div>
        </CardContent>
      </Card>

      {/* Каденция */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Подача ответа</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex items-center gap-2">
            <Switch checked={s.splitReplies} onCheckedChange={(v) => patch({ splitReplies: v })} />
            <span>Дробить длинный ответ на несколько сообщений (по абзацам)</span>
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={s.typingIndicator} onCheckedChange={(v) => patch({ typingIndicator: v })} />
            <span>Показывать «печатает…» во время ответа</span>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={savingKey === "cadence"}
              onClick={() => saveBot("cadence", { splitReplies: s.splitReplies, typingIndicator: s.typingIndicator })}>
              Сохранить</Button>
            <SavedMark k="cadence" />
          </div>
        </CardContent>
      </Card>

      {/* Параметры генерации */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Параметры генерации</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-xs text-muted-foreground">
            Тонкая настройка ответа LLM. Пусто = значения по умолчанию (0.7 / 600 / 20).
          </p>
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="space-y-1">
              <span className="block text-xs text-muted-foreground">Температура (0–1.5)</span>
              <Input type="number" min={0} max={1.5} step={0.1} placeholder="0.7"
                value={s.temperature ?? ""} onChange={(e) => patch({ temperature: numOrNull(e.target.value) })}
                className="h-8 text-sm" />
            </div>
            <div className="space-y-1">
              <span className="block text-xs text-muted-foreground">Макс. токенов</span>
              <Input type="number" min={100} max={4000} placeholder="600"
                value={s.maxOutputTokens ?? ""} onChange={(e) => patch({ maxOutputTokens: numOrNull(e.target.value) })}
                className="h-8 text-sm" />
            </div>
            <div className="space-y-1">
              <span className="block text-xs text-muted-foreground">Сжимать после N сообщений</span>
              <Input type="number" min={5} max={100} placeholder="20"
                value={s.compactAfterMessages ?? ""} onChange={(e) => patch({ compactAfterMessages: numOrNull(e.target.value) })}
                className="h-8 text-sm" />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={savingKey === "gen"}
              onClick={() => saveBot("gen", {
                temperature: s.temperature, maxOutputTokens: s.maxOutputTokens, compactAfterMessages: s.compactAfterMessages,
              })}>Сохранить</Button>
            <SavedMark k="gen" />
          </div>
        </CardContent>
      </Card>

      {/* Авто-закрытие */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Авто-закрытие диалога</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="text-xs text-muted-foreground">
            Закрывать диалог после N часов без сообщений (оператор может переоткрыть). Пусто = не закрывать.
            Диапазон 1–720.
          </p>
          <div className="flex items-center gap-2">
            <Input type="number" min={1} max={720} placeholder="—" value={s.autocloseHours ?? ""}
              onChange={(e) => patch({ autocloseHours: numOrNull(e.target.value) })} className="h-8 w-28 text-sm" />
            <span className="text-xs text-muted-foreground">часов</span>
            <Button size="sm" disabled={savingKey === "autoclose"}
              onClick={() => saveBot("autoclose", { autocloseHours: s.autocloseHours })}>Сохранить</Button>
            <SavedMark k="autoclose" />
          </div>
        </CardContent>
      </Card>

      {/* Голос и медиа */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Голос и медиа</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex items-center gap-2">
            <Switch checked={s.voiceStt} onCheckedChange={(v) => patch({ voiceStt: v })} />
            <span>Распознавать голосовые сообщения (голос → текст)</span>
          </div>
          <div className="space-y-1">
            <span className="block text-xs text-muted-foreground">
              Ответ на медиа без подписи (фото/файл без текста). Пусто = молчать.
            </span>
            <Input placeholder="Получили, проверяем." value={s.mediaAckText ?? ""}
              onChange={(e) => patch({ mediaAckText: e.target.value || null })} className="h-8 text-sm" />
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={savingKey === "media"}
              onClick={() => saveBot("media", { voiceStt: s.voiceStt, mediaAckText: s.mediaAckText })}>Сохранить</Button>
            <SavedMark k="media" />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

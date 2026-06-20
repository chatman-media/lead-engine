import {
  ClockIcon,
  HeadphonesIcon,
  Loader2Icon,
  type LucideIcon,
  MegaphoneIcon,
  MessageSquareIcon,
  RotateCcwIcon,
  SaveIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { ApiError, type BotSettings, clearToken, saas } from "@/api/saas";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

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

/** Карточка-секция с иконкой и заголовком. */
function Section({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm">
      <div className="flex items-start gap-3 border-b bg-muted/30 px-5 py-4">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-[var(--primary)]">
          <Icon className="size-4" />
        </div>
        <div className="space-y-0.5">
          <h2 className="text-sm font-semibold leading-tight">{title}</h2>
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
      </div>
      <div className="divide-y px-5">{children}</div>
    </div>
  );
}

/** Строка настройки: подпись + подсказка слева, контрол справа (или под ними, если block). */
function Field({
  label,
  hint,
  control,
  block,
  disabled,
}: {
  label: string;
  hint?: string;
  control: ReactNode;
  block?: boolean;
  disabled?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 py-4",
        !block && "sm:flex-row sm:items-center sm:justify-between sm:gap-6",
        disabled && "opacity-55",
      )}
    >
      <div className="space-y-0.5 sm:max-w-md">
        <div className="text-sm font-medium">{label}</div>
        {hint && <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}
      </div>
      <div className={cn(block ? "w-full" : "sm:shrink-0")}>{control}</div>
    </div>
  );
}

export function SaasBotSettings() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  // «Контекст бота» живёт на отдельной колонке tenants.reply_history_limit (legacy).
  const [historyLimit, setHistoryLimit] = useState("");
  // Остальное — единый JSON-блок bot_settings_json.
  const [s, setS] = useState<BotSettings | null>(null);
  // Снимок последних сохранённых значений для трекинга «грязных» полей.
  const [orig, setOrig] = useState<{ historyLimit: string; settings: BotSettings } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { tenant } = await saas.getTenantInfo();
        if (cancelled) return;
        const hl = tenant.replyHistoryLimit == null ? "" : String(tenant.replyHistoryLimit);
        setHistoryLimit(hl);
        setS(tenant.botSettings);
        setOrig({ historyLimit: hl, settings: tenant.botSettings });
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

  const dirty = useMemo(() => {
    if (!s || !orig) return { count: 0, settings: false, history: false };
    const changed = (Object.keys(s) as (keyof BotSettings)[]).filter(
      (k) => JSON.stringify(s[k]) !== JSON.stringify(orig.settings[k]),
    ).length;
    const history = historyLimit !== orig.historyLimit;
    return { count: changed + (history ? 1 : 0), settings: changed > 0, history };
  }, [s, orig, historyLimit]);

  async function save() {
    if (!s || !orig || dirty.count === 0) return;
    setSaving(true);
    setError("");
    try {
      let nextSettings = s;
      let nextHistory = historyLimit;
      if (dirty.settings) {
        const { botSettings } = await saas.updateBotSettings(s);
        nextSettings = botSettings;
        setS(botSettings);
      }
      if (dirty.history) {
        const { replyHistoryLimit } = await saas.setReplyHistoryLimit(numOrNull(historyLimit));
        nextHistory = replyHistoryLimit == null ? "" : String(replyHistoryLimit);
        setHistoryLimit(nextHistory);
      }
      setOrig({ historyLimit: nextHistory, settings: nextSettings });
      toast.success("Настройки сохранены");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearToken();
        navigate("/login", { replace: true });
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    if (!orig) return;
    setS(orig.settings);
    setHistoryLimit(orig.historyLimit);
  }

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Загрузка…</div>;
  if (!s)
    return (
      <div className="p-6 text-sm text-destructive">
        {error || "Не удалось загрузить настройки"}
      </div>
    );

  const numInput =
    "h-9 w-24 text-sm [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none";

  return (
    <div className="pb-24">
      <PageHeader
        title="Поведение бота"
        description="Как бот отвечает клиентам: скорость, доступность, передача оператору и авто-сообщения."
      />
      {error && (
        <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <Tabs defaultValue="replies" className="gap-5">
        <TabsList className="w-full justify-start overflow-x-auto">
          <TabsTrigger value="replies">
            <MessageSquareIcon /> Ответы
          </TabsTrigger>
          <TabsTrigger value="availability">
            <ClockIcon /> Доступность
          </TabsTrigger>
          <TabsTrigger value="handoff">
            <HeadphonesIcon /> Оператор
          </TabsTrigger>
          <TabsTrigger value="messages">
            <MegaphoneIcon /> Сообщения
          </TabsTrigger>
        </TabsList>

        {/* ── Ответы ──────────────────────────────────────────────── */}
        <TabsContent value="replies" className="space-y-5">
          <Section
            icon={MessageSquareIcon}
            title="Как бот отвечает"
            description="Скорость и формат ответов на сообщения клиентов."
          >
            <Field
              label="Пауза перед ответом"
              hint="Сколько секунд бот ждёт перед ответом. Новое сообщение или правка в окне сбрасывают таймер — бот ответит один раз по всей переписке. 0 = сразу. Диапазон 0–120."
              control={
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={0}
                    max={120}
                    placeholder="0"
                    value={s.replyDelaySeconds == null ? "" : String(s.replyDelaySeconds)}
                    onChange={(e) => patch({ replyDelaySeconds: numOrNull(e.target.value) })}
                    className={numInput}
                  />
                  <span className="text-xs text-muted-foreground">сек.</span>
                </div>
              }
            />
            <Field
              label="Дробить длинный ответ"
              hint="Разбивать ответ на несколько сообщений по абзацам."
              control={
                <Switch
                  checked={s.splitReplies}
                  onCheckedChange={(v) => patch({ splitReplies: v })}
                />
              }
            />
            <Field
              label="Индикатор «печатает…»"
              hint="Показывать, что бот набирает ответ."
              control={
                <Switch
                  checked={s.typingIndicator}
                  onCheckedChange={(v) => patch({ typingIndicator: v })}
                />
              }
            />
          </Section>

          <Section
            icon={MessageSquareIcon}
            title="Параметры генерации"
            description="Тонкая настройка LLM и контекста. Пусто = значения по умолчанию."
          >
            <Field
              label="Контекст диалога"
              hint="Сколько последних сообщений бот учитывает как контекст. Пусто = 20. Диапазон 2–100."
              control={
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={2}
                    max={100}
                    placeholder="20"
                    value={historyLimit}
                    onChange={(e) => setHistoryLimit(e.target.value)}
                    className={numInput}
                  />
                  <span className="text-xs text-muted-foreground">сообщ.</span>
                </div>
              }
            />
            <Field
              label="Температура"
              hint="Креативность ответа. Выше — разнообразнее, ниже — строже. Пусто = 0.7. Диапазон 0–1.5."
              control={
                <Input
                  type="number"
                  min={0}
                  max={1.5}
                  step={0.1}
                  placeholder="0.7"
                  value={s.temperature ?? ""}
                  onChange={(e) => patch({ temperature: numOrNull(e.target.value) })}
                  className={numInput}
                />
              }
            />
            <Field
              label="Максимум токенов"
              hint="Предельная длина одного ответа бота. Пусто = 600. Диапазон 100–4000."
              control={
                <Input
                  type="number"
                  min={100}
                  max={4000}
                  placeholder="600"
                  value={s.maxOutputTokens ?? ""}
                  onChange={(e) => patch({ maxOutputTokens: numOrNull(e.target.value) })}
                  className={numInput}
                />
              }
            />
            <Field
              label="Сжимать историю после"
              hint="Сворачивать переписку в саммари после N сообщений, чтобы экономить контекст. Пусто = 20. Диапазон 5–100."
              control={
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={5}
                    max={100}
                    placeholder="20"
                    value={s.compactAfterMessages ?? ""}
                    onChange={(e) => patch({ compactAfterMessages: numOrNull(e.target.value) })}
                    className={numInput}
                  />
                  <span className="text-xs text-muted-foreground">сообщ.</span>
                </div>
              }
            />
          </Section>
        </TabsContent>

        {/* ── Доступность ─────────────────────────────────────────── */}
        <TabsContent value="availability" className="space-y-5">
          <Section
            icon={ClockIcon}
            title="Рабочие часы"
            description="Вне окна бот не отвечает — диалог ждёт оператора."
          >
            <Field
              label="Включить рабочие часы"
              hint="Ограничить время, когда бот отвечает автоматически."
              control={
                <Switch
                  checked={s.hoursEnabled}
                  onCheckedChange={(v) => patch({ hoursEnabled: v })}
                />
              }
            />
            <Field
              label="Окно работы"
              hint="Часовой пояс задаётся IANA-кодом, например Asia/Manila."
              disabled={!s.hoursEnabled}
              control={
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">с</span>
                  <Input
                    type="time"
                    value={minToTime(s.hoursStartMin)}
                    disabled={!s.hoursEnabled}
                    onChange={(e) => patch({ hoursStartMin: timeToMin(e.target.value) })}
                    className="h-9 w-28 text-sm"
                  />
                  <span className="text-xs text-muted-foreground">до</span>
                  <Input
                    type="time"
                    value={minToTime(s.hoursEndMin)}
                    disabled={!s.hoursEnabled}
                    onChange={(e) => patch({ hoursEndMin: timeToMin(e.target.value) })}
                    className="h-9 w-28 text-sm"
                  />
                  <Input
                    placeholder="Asia/Manila"
                    value={s.hoursTz ?? ""}
                    disabled={!s.hoursEnabled}
                    onChange={(e) => patch({ hoursTz: e.target.value || null })}
                    className="h-9 w-40 text-sm"
                  />
                </div>
              }
            />
            <Field
              label="Авто-сообщение вне часов"
              hint="Необязательно. Шлётся не чаще раза в 3 часа, пока бот не на связи."
              block
              disabled={!s.hoursEnabled}
              control={
                <Textarea
                  placeholder="Мы сейчас не на связи, ответим в рабочее время."
                  rows={2}
                  value={s.offhoursMessage ?? ""}
                  disabled={!s.hoursEnabled}
                  onChange={(e) => patch({ offhoursMessage: e.target.value || null })}
                  className="text-sm"
                />
              }
            />
          </Section>

          <Section
            icon={ClockIcon}
            title="Авто-закрытие диалога"
            description="Закрывать неактивные диалоги (оператор может переоткрыть)."
          >
            <Field
              label="Закрывать после тишины"
              hint="Через сколько часов без сообщений закрыть диалог. Пусто = не закрывать. Диапазон 1–720."
              control={
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={1}
                    max={720}
                    placeholder="—"
                    value={s.autocloseHours ?? ""}
                    onChange={(e) => patch({ autocloseHours: numOrNull(e.target.value) })}
                    className={numInput}
                  />
                  <span className="text-xs text-muted-foreground">ч.</span>
                </div>
              }
            />
          </Section>
        </TabsContent>

        {/* ── Оператор ────────────────────────────────────────────── */}
        <TabsContent value="handoff" className="space-y-5">
          <Section
            icon={HeadphonesIcon}
            title="Передача оператору"
            description="Когда бот уступает диалог живому оператору."
          >
            <Field
              label="Стоп-слова → оператор"
              hint="Если сообщение клиента содержит любое из слов — диалог сразу уходит оператору, бот не отвечает. Через запятую."
              block
              control={
                <Input
                  placeholder="оператор, человек, жалоба"
                  value={s.stopWords.join(", ")}
                  onChange={(e) =>
                    patch({
                      stopWords: e.target.value
                        .split(",")
                        .map((w) => w.trim())
                        .filter(Boolean),
                    })
                  }
                  className="text-sm"
                />
              }
            />
            <Field
              label="Авто-передача по фолбэкам"
              hint="Передать диалог, если бот N раз подряд ответил «уточню у оператора». Пусто = не передавать. Диапазон 1–20."
              control={
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={1}
                    max={20}
                    placeholder="—"
                    value={s.handoffAfterFallbacks ?? ""}
                    onChange={(e) => patch({ handoffAfterFallbacks: numOrNull(e.target.value) })}
                    className={numInput}
                  />
                  <span className="text-xs text-muted-foreground">подряд</span>
                </div>
              }
            />
            <Field
              label="Текст фолбэка"
              hint="Что бот пишет, когда не может ответить сам и обещает уточнить у оператора. Пусто = текст по умолчанию."
              block
              control={
                <Textarea
                  placeholder="Сейчас уточню у оператора и вернусь с ответом."
                  rows={2}
                  value={s.fallbackText ?? ""}
                  onChange={(e) => patch({ fallbackText: e.target.value || null })}
                  className="text-sm"
                />
              }
            />
          </Section>
        </TabsContent>

        {/* ── Сообщения и медиа ───────────────────────────────────── */}
        <TabsContent value="messages" className="space-y-5">
          <Section
            icon={MegaphoneIcon}
            title="Авто-сообщения и медиа"
            description="Приветствие, голосовые и реакция на вложения."
          >
            <Field
              label="Приветствие"
              hint="Автоматическое сообщение при первом обращении клиента. Пусто = без приветствия."
              block
              control={
                <Textarea
                  placeholder="Здравствуйте! Чем можем помочь?"
                  rows={2}
                  value={s.greetingText ?? ""}
                  onChange={(e) => patch({ greetingText: e.target.value || null })}
                  className="text-sm"
                />
              }
            />
            <Field
              label="Распознавать голосовые"
              hint="Переводить голосовые сообщения клиента в текст (голос → текст)."
              control={
                <Switch checked={s.voiceStt} onCheckedChange={(v) => patch({ voiceStt: v })} />
              }
            />
            <Field
              label="Ответ на медиа без подписи"
              hint="Что ответить на фото или файл без текста. Пусто = молчать."
              block
              control={
                <Input
                  placeholder="Получили, проверяем."
                  value={s.mediaAckText ?? ""}
                  onChange={(e) => patch({ mediaAckText: e.target.value || null })}
                  className="text-sm"
                />
              }
            />
          </Section>
        </TabsContent>
      </Tabs>

      {/* Плавающая панель сохранения — показывается только при изменениях. */}
      {dirty.count > 0 && (
        <div className="pointer-events-none sticky bottom-4 z-10 mt-5 flex justify-center">
          <div className="pointer-events-auto flex items-center gap-2 rounded-full border bg-card/95 py-2 pr-2 pl-4 shadow-lg backdrop-blur sm:gap-3">
            <span className="text-sm text-muted-foreground">
              {dirty.count === 1
                ? "1 несохранённое изменение"
                : `Несохранённых изменений: ${dirty.count}`}
            </span>
            <Button variant="ghost" size="sm" onClick={reset} disabled={saving}>
              <RotateCcwIcon /> Отменить
            </Button>
            <Button size="sm" onClick={save} disabled={saving}>
              {saving ? <Loader2Icon className="animate-spin" /> : <SaveIcon />}
              Сохранить
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

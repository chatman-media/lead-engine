/**
 * Bot Tester page — /test
 *
 * Allows testing the production bot directly from the admin UI.
 * Messages are processed through the full pipeline (processInbound + replyStrategy),
 * but NO messages are sent to the real Telegram bot — the response comes back
 * directly in this UI.
 *
 * Features:
 * - Free-form text input
 * - Photo/video URL input for media testing
 * - Predefined scenario runner (sends steps with delays)
 * - "Reset session" button to clear test contact + conversation
 */

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { saas, type TestOutboundPart, type TestScenario } from "@/api/saas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  BotIcon,
  ImageIcon,
  PlayIcon,
  RefreshCwIcon,
  SendIcon,
  Trash2Icon,
  UserIcon,
  VideoIcon,
  XIcon,
} from "lucide-react";

// ── Chat message types ─────────────────────────────────────────────────────

interface ChatMessage {
  id: string;
  from: "user" | "bot" | "system";
  text?: string;
  mediaUrl?: string;
  mediaType?: "photo" | "video";
  parts?: TestOutboundPart[];
  hint?: string;
  ts: number;
}

// ── Helper: format timestamp ───────────────────────────────────────────────

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// ── Bot reply renderer ─────────────────────────────────────────────────────

function BotParts({ parts }: { parts: TestOutboundPart[] }) {
  return (
    <div className="space-y-1.5">
      {parts.map((part, i) => {
        if (part.kind === "text" && part.text) {
          return (
            <p key={i} className="whitespace-pre-wrap text-sm leading-relaxed">
              {part.text}
            </p>
          );
        }
        if ((part.kind === "photo" || part.kind === "video") && part.mediaRef) {
          const src = part.mediaRef.externalRef;
          return (
            <div key={i} className="space-y-1">
              {part.caption && (
                <p className="text-xs text-muted-foreground">{part.caption}</p>
              )}
              {part.kind === "photo" ? (
                <img
                  src={src}
                  alt="photo"
                  className="max-h-64 rounded-md object-cover"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                />
              ) : (
                <video
                  src={src}
                  controls
                  className="max-h-64 w-full rounded-md"
                />
              )}
            </div>
          );
        }
        return (
          <p key={i} className="text-xs text-muted-foreground italic">
            [{part.kind}]
          </p>
        );
      })}
    </div>
  );
}

// ── Single chat message bubble ─────────────────────────────────────────────

function MessageBubble({ msg }: { msg: ChatMessage }) {
  if (msg.from === "system") {
    return (
      <div className="flex justify-center">
        <span className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
          {msg.text}
        </span>
      </div>
    );
  }

  const isUser = msg.from === "user";

  return (
    <div className={cn("flex gap-2.5", isUser ? "flex-row-reverse" : "flex-row")}>
      {/* Avatar */}
      <div
        className={cn(
          "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full",
          isUser ? "bg-primary/15 text-primary" : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
        )}
      >
        {isUser ? <UserIcon className="size-3.5" /> : <BotIcon className="size-3.5" />}
      </div>

      {/* Bubble */}
      <div className={cn("max-w-[75%] space-y-1", isUser ? "items-end" : "items-start")}>
        {msg.hint && (
          <p className={cn("text-[10px] text-muted-foreground/70", isUser ? "text-right" : "text-left")}>
            {msg.hint}
          </p>
        )}
        <div
          className={cn(
            "rounded-2xl px-3.5 py-2.5 text-sm",
            isUser
              ? "rounded-tr-sm bg-primary text-primary-foreground"
              : "rounded-tl-sm bg-muted text-foreground",
          )}
        >
          {msg.parts ? (
            <BotParts parts={msg.parts} />
          ) : msg.mediaUrl ? (
            <div className="space-y-1">
              {msg.mediaType === "video" ? (
                <VideoIcon className="size-4 opacity-60" />
              ) : (
                <ImageIcon className="size-4 opacity-60" />
              )}
              <p className="text-xs opacity-80 break-all">{msg.mediaUrl}</p>
              {msg.text && <p className="text-sm">{msg.text}</p>}
            </div>
          ) : (
            <p className="whitespace-pre-wrap leading-relaxed">{msg.text}</p>
          )}
        </div>
        <p className={cn("text-[10px] text-muted-foreground/60", isUser ? "text-right" : "text-left")}>
          {formatTime(msg.ts)}
        </p>
      </div>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────

export function SaasTestBot() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [mediaUrl, setMediaUrl] = useState("");
  const [mediaType, setMediaType] = useState<"photo" | "video">("photo");
  const [caption, setCaption] = useState("");
  const [showMedia, setShowMedia] = useState(false);
  const [sending, setSending] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [scenarios, setScenarios] = useState<TestScenario[]>([]);
  const [selectedScenario, setSelectedScenario] = useState<string>("");
  const [runningScenario, setRunningScenario] = useState(false);
  const [scenarioStep, setScenarioStep] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef(false);

  // Load scenarios on mount
  useEffect(() => {
    saas.getTestScenarios().then((r) => {
      setScenarios(r.scenarios);
      if (r.scenarios.length > 0) setSelectedScenario(r.scenarios[0]!.id);
    }).catch(() => {});
  }, []);

  // Scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function addSystemMsg(text: string) {
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), from: "system", text, ts: Date.now() },
    ]);
  }

  async function sendMessage(opts: {
    text?: string;
    mediaUrl?: string;
    mediaType?: "photo" | "video";
    caption?: string;
    hint?: string;
  }) {
    const { text = "", mediaUrl: mUrl = "", mediaType: mType = "photo", caption: cap = "", hint } = opts;
    if (!text && !mUrl) return;

    // Add user bubble
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      from: "user",
      text: text || undefined,
      mediaUrl: mUrl || undefined,
      mediaType: mUrl ? mType : undefined,
      hint,
      ts: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);

    setSending(true);
    try {
      const result = await saas.testSend({
        ...(text ? { text } : {}),
        ...(mUrl ? { mediaUrl: mUrl, mediaType: mType } : {}),
        ...(cap ? { caption: cap } : {}),
      });

      if (result.error) {
        addSystemMsg(`⚠️ Ошибка: ${result.error}`);
      } else if (result.parts.length === 0) {
        addSystemMsg("(бот не ответил)");
      } else {
        const botMsg: ChatMessage = {
          id: crypto.randomUUID(),
          from: "bot",
          parts: result.parts,
          ts: Date.now(),
        };
        setMessages((prev) => [...prev, botMsg]);
      }
    } catch (err) {
      toast.error(`Ошибка отправки: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSending(false);
    }
  }

  async function handleSend() {
    if (sending || (!input.trim() && !mediaUrl.trim())) return;
    const text = input.trim();
    const mUrl = mediaUrl.trim();
    setInput("");
    if (!mUrl) {
      setMediaUrl("");
      setCaption("");
    }
    await sendMessage({ text, mediaUrl: mUrl, mediaType, caption: caption.trim() });
    if (mUrl) {
      setMediaUrl("");
      setCaption("");
    }
  }

  async function handleReset() {
    if (resetting) return;
    setResetting(true);
    try {
      await saas.testResetSession();
      setMessages([]);
      addSystemMsg("Сессия сброшена — новый разговор");
    } catch (err) {
      toast.error(`Ошибка сброса: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setResetting(false);
    }
  }

  async function handleRunScenario() {
    if (runningScenario || !selectedScenario) return;
    const scenario = scenarios.find((s) => s.id === selectedScenario);
    if (!scenario) return;

    // Reset first
    setResetting(true);
    try {
      await saas.testResetSession();
      setMessages([]);
    } catch {
      // ignore
    }
    setResetting(false);

    abortRef.current = false;
    setRunningScenario(true);
    setScenarioStep(0);
    addSystemMsg(`▶ Сценарий: ${scenario.name}`);

    for (let i = 0; i < scenario.steps.length; i++) {
      if (abortRef.current) break;
      const step = scenario.steps[i]!;
      setScenarioStep(i + 1);

      // Small delay before sending (except first)
      if (i > 0) {
        await new Promise((r) => setTimeout(r, 1500));
      }
      if (abortRef.current) break;

      await sendMessage({ text: step.text, hint: step.hint });

      // Wait for bot response before next step
      await new Promise((r) => setTimeout(r, 800));
    }

    if (!abortRef.current) {
      addSystemMsg(`✓ Сценарий завершён (${scenario.steps.length} шагов)`);
    } else {
      addSystemMsg("⏹ Сценарий остановлен");
    }
    setRunningScenario(false);
    setScenarioStep(0);
  }

  function handleStopScenario() {
    abortRef.current = true;
  }

  const selectedScenarioObj = scenarios.find((s) => s.id === selectedScenario);

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col gap-0 rounded-xl border bg-background overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <BotIcon className="size-5 text-primary" />
          <h1 className="text-base font-semibold">Тест бота</h1>
          <Badge variant="outline" className="text-xs">
            изолированная сессия
          </Badge>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={handleReset}
          disabled={resetting || runningScenario}
        >
          <Trash2Icon className="size-3.5" />
          {resetting ? "Сброс…" : "Сбросить сессию"}
        </Button>
      </div>

      {/* Scenario runner */}
      <div className="border-b bg-muted/30 px-4 py-2.5">
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-48">
            <Label className="mb-1 text-xs text-muted-foreground">Сценарий</Label>
            <Select value={selectedScenario} onValueChange={setSelectedScenario} disabled={runningScenario}>
              <SelectTrigger className="h-8 text-sm">
                <SelectValue placeholder="Выбрать сценарий…" />
              </SelectTrigger>
              <SelectContent>
                {scenarios.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {selectedScenarioObj && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <span>{selectedScenarioObj.steps.length} шагов</span>
              {runningScenario && (
                <span className="text-primary">
                  · шаг {scenarioStep}/{selectedScenarioObj.steps.length}
                </span>
              )}
            </div>
          )}

          {runningScenario ? (
            <Button size="sm" variant="destructive" onClick={handleStopScenario}>
              <XIcon className="size-3.5" />
              Стоп
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={handleRunScenario}
              disabled={!selectedScenario || sending}
            >
              <PlayIcon className="size-3.5" />
              Запустить
            </Button>
          )}
        </div>

        {/* Step hints */}
        {selectedScenarioObj && !runningScenario && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {selectedScenarioObj.steps.map((step, i) => (
              <span
                key={i}
                className="rounded-full bg-muted border px-2 py-0.5 text-[10px] text-muted-foreground"
                title={step.text}
              >
                {i + 1}. {step.hint ?? step.text.slice(0, 20)}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Chat messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.length === 0 && (
          <div className="flex h-full items-center justify-center">
            <div className="text-center space-y-2 text-muted-foreground">
              <BotIcon className="mx-auto size-10 opacity-20" />
              <p className="text-sm">Запустите сценарий или напишите сообщение боту</p>
              <p className="text-xs opacity-60">Реальному Telegram-боту ничего не отправляется</p>
            </div>
          </div>
        )}
        {messages.map((msg) => (
          <MessageBubble key={msg.id} msg={msg} />
        ))}
        {sending && (
          <div className="flex gap-2.5">
            <div className="flex size-7 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
              <BotIcon className="size-3.5" />
            </div>
            <div className="flex items-center gap-1 rounded-2xl rounded-tl-sm bg-muted px-3.5 py-2.5">
              <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:0ms]" />
              <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:150ms]" />
              <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:300ms]" />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      <div className="border-t bg-background p-3 space-y-2">
        {/* Media row */}
        {showMedia && (
          <div className="flex flex-wrap gap-2 rounded-lg border bg-muted/30 p-2.5">
            <div className="flex items-center gap-1.5">
              <Label className="text-xs text-muted-foreground whitespace-nowrap">Тип</Label>
              <Select value={mediaType} onValueChange={(v) => setMediaType(v as "photo" | "video")}>
                <SelectTrigger className="h-7 w-24 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="photo">
                    <span className="flex items-center gap-1"><ImageIcon className="size-3" /> Фото</span>
                  </SelectItem>
                  <SelectItem value="video">
                    <span className="flex items-center gap-1"><VideoIcon className="size-3" /> Видео</span>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Input
              className="h-7 flex-1 min-w-40 text-xs"
              placeholder="URL медиафайла (https://...)"
              value={mediaUrl}
              onChange={(e) => setMediaUrl(e.target.value)}
            />
            <Input
              className="h-7 w-40 text-xs"
              placeholder="Подпись (caption)"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
            />
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-1.5"
              onClick={() => { setShowMedia(false); setMediaUrl(""); setCaption(""); }}
            >
              <XIcon className="size-3.5" />
            </Button>
          </div>
        )}

        {/* Text + send row */}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setShowMedia((v) => !v)}
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-lg border transition-colors",
              showMedia
                ? "bg-primary/10 border-primary/40 text-primary"
                : "text-muted-foreground hover:bg-muted",
            )}
            title="Прикрепить медиа"
          >
            <ImageIcon className="size-4" />
          </button>

          <Textarea
            className="min-h-9 max-h-32 flex-1 resize-none py-2 text-sm leading-relaxed"
            placeholder="Написать боту…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            disabled={sending || runningScenario}
            rows={1}
          />

          <Button
            className="h-9 w-9 shrink-0 p-0"
            onClick={handleSend}
            disabled={sending || runningScenario || (!input.trim() && !mediaUrl.trim())}
          >
            {sending ? (
              <RefreshCwIcon className="size-4 animate-spin" />
            ) : (
              <SendIcon className="size-4" />
            )}
          </Button>
        </div>

        <p className="text-[10px] text-muted-foreground/60 px-1">
          Enter — отправить · Shift+Enter — новая строка · Сообщения обрабатываются боотом, но не доставляются в Telegram
        </p>
      </div>
    </div>
  );
}

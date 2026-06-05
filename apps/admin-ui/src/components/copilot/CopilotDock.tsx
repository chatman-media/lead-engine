import {
  ArrowRightIcon,
  CheckIcon,
  ChevronRightIcon,
  KeyRoundIcon,
  SendIcon,
  SparklesIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CopilotAction } from "@/api/saas";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useCopilot } from "./CopilotProvider";

const GREETING =
  "Привет! Я ассистент по этой странице. Спросите о данных, что видите, или попросите помочь " +
  "с настройкой — например, подобрать и установить воронку.";

const KIND_LABEL: Record<string, string> = {
  intake: "Заявка",
  active: "Рабочая",
  terminal_won: "Успех",
  terminal_lost: "Отказ",
};

/** matchMedia-хук: true ниже md (768px) — там док превращается в оверлей. */
function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const on = () => setMobile(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return mobile;
}

function NudgeCard({ onSetup }: { onSetup: () => void }) {
  return (
    <div className="space-y-2 rounded-lg border border-[var(--warning)]/40 bg-[color-mix(in_oklch,var(--warning)_10%,transparent)] p-3">
      <div className="flex items-center gap-2 text-sm font-medium text-[var(--warning)]">
        <KeyRoundIcon className="size-4" />
        Нужна chat-модель
      </div>
      <p className="text-sm text-muted-foreground">
        Я подключусь, как только вы настроите chat-модель (провайдер, например OpenRouter). Это
        занимает минуту.
      </p>
      <Button size="sm" variant="outline" onClick={onSetup}>
        Настроить LLM <ArrowRightIcon className="ml-1 size-4" />
      </Button>
    </div>
  );
}

function ActionCard({
  action,
  applying,
  onConfirm,
  onDismiss,
}: {
  action: CopilotAction;
  applying: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="space-y-2 rounded-lg border border-primary/40 bg-primary/5 p-3">
      {action.type === "install_vertical" && (
        <p className="text-sm">
          Установить готовую воронку <span className="font-semibold">«{action.displayName}»</span>?
          Это настроит этапы, навыки и стили продаж.
        </p>
      )}

      {action.type === "navigate" && (
        <p className="text-sm">
          {action.to ? `Перейти на «${action.to}»?` : `Перейти к шагу ${action.step}?`}
        </p>
      )}

      {action.type === "build_funnel" && (
        <>
          <p className="text-xs font-semibold uppercase text-muted-foreground">
            Предпросмотр воронки ({action.preview.length} стадий)
          </p>
          <ol className="space-y-1.5">
            {action.preview.map((s, i) => (
              <li key={s.slug} className="rounded-md border bg-card px-2.5 py-1.5 text-sm">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground tabular-nums">{i + 1}.</span>
                  <span className="font-medium">{s.displayName}</span>
                  <Badge variant="secondary" className="text-xs">
                    {KIND_LABEL[s.kind] ?? s.kind}
                  </Badge>
                </div>
              </li>
            ))}
          </ol>
          <p className="text-xs text-muted-foreground">Заменит текущие стадии воронки.</p>
        </>
      )}

      <div className="flex gap-2">
        <Button size="sm" onClick={onConfirm} disabled={applying}>
          {action.type === "navigate" ? (
            <ArrowRightIcon className="mr-1 size-4" />
          ) : (
            <CheckIcon className="mr-1 size-4" />
          )}
          {applying
            ? "Выполняю…"
            : action.type === "install_vertical"
              ? "Установить"
              : action.type === "build_funnel"
                ? "Применить воронку"
                : "Перейти"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDismiss} disabled={applying}>
          Отмена
        </Button>
      </div>
    </div>
  );
}

/** Тело дока: шапка + лента + поле ввода. Используется и в desktop-панели, и в мобильном Sheet. */
function DockPanel({ onClose }: { onClose: () => void }) {
  const c = useCopilot();
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [c.messages, c.pendingAction, c.busy]);

  function submit() {
    const t = input.trim();
    if (!t || c.busy) return;
    setInput("");
    void c.send(t);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-sidebar-border px-3">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-primary to-chart-5 text-primary-foreground">
          <SparklesIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold leading-tight">AI-ассистент</p>
          <p className="truncate text-[11px] text-muted-foreground">{c.pageLabel}</p>
        </div>
        {c.messages.length > 0 && (
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={c.clear}>
            Очистить
          </Button>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Свернуть ассистента"
          className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground"
        >
          <ChevronRightIcon className="size-4" />
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {!c.llmReady ? (
          <NudgeCard onSetup={c.gotoLlmSetup} />
        ) : (
          c.messages.length === 0 && (
            <div className="rounded-lg bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
              {GREETING}
            </div>
          )
        )}

        {c.messages.map((m, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: append-only chat log
            key={i}
            className={cn(
              "max-w-[85%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm",
              m.role === "user" ? "ml-auto bg-primary text-primary-foreground" : "bg-muted",
            )}
          >
            {m.content}
          </div>
        ))}

        {c.busy && (
          <div className="max-w-[85%] rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
            Печатает…
          </div>
        )}

        {c.pendingAction && (
          <ActionCard
            action={c.pendingAction}
            applying={c.applying}
            onConfirm={c.confirmAction}
            onDismiss={c.dismissAction}
          />
        )}

        {c.error && <p className="text-sm text-destructive">{c.error}</p>}
      </div>

      <div className="shrink-0 border-t border-sidebar-border p-3">
        <div className="flex items-end gap-2">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={
              c.llmReady ? "Спросите по этой странице…" : "Сначала настройте chat-модель"
            }
            rows={2}
            className="resize-none text-sm"
            disabled={c.busy || !c.llmReady}
          />
          <Button
            size="icon"
            onClick={submit}
            disabled={c.busy || !c.llmReady || !input.trim()}
            aria-label="Отправить"
          >
            <SendIcon className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Свёрнутый рейл (desktop): вертикальная кнопка-лаунчер. */
function DockRail({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="flex h-full flex-col items-center py-3">
      <button
        type="button"
        onClick={onOpen}
        aria-label="Открыть AI-ассистента (⌘J)"
        className="grid size-8 cursor-pointer place-items-center rounded-lg bg-gradient-to-br from-primary to-chart-5 text-primary-foreground shadow-[0_4px_16px_-4px_var(--primary)] transition-transform hover:scale-105"
      >
        <SparklesIcon className="size-4" />
      </button>
    </div>
  );
}

/**
 * Правый док-копайлот. `underHeader` сдвигает sticky-панель под шапку онбординга
 * (там есть h-14 header); в кабинете desktop-шапки нет → панель от верха.
 */
export function CopilotDock({ underHeader = false }: { underHeader?: boolean }) {
  const c = useCopilot();
  const isMobile = useIsMobile();

  // Мобайл: плавающая кнопка + оверлей Sheet (push на узких экранах невозможен).
  if (isMobile) {
    return (
      <>
        {!c.open && (
          <button
            type="button"
            onClick={() => c.setOpen(true)}
            aria-label="Открыть AI-ассистента"
            className="fixed bottom-4 right-4 z-40 grid size-12 cursor-pointer place-items-center rounded-full bg-gradient-to-br from-primary to-chart-5 text-primary-foreground shadow-lg"
          >
            <SparklesIcon className="size-5" />
          </button>
        )}
        <Sheet open={c.open} onOpenChange={c.setOpen}>
          <SheetContent side="right" className="flex w-full flex-col p-0 sm:w-[440px]">
            <SheetTitle className="sr-only">AI-ассистент</SheetTitle>
            <DockPanel onClose={() => c.setOpen(false)} />
          </SheetContent>
        </Sheet>
      </>
    );
  }

  // Desktop: docked aside — контент ужимается (flex), не перекрывается.
  return (
    <aside
      className={cn(
        "sticky hidden shrink-0 border-l border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 md:flex md:flex-col",
        underHeader ? "top-14 h-[calc(100vh-3.5rem)]" : "top-0 h-screen",
        c.open ? "w-[400px]" : "w-[3.25rem]",
      )}
    >
      {c.open ? (
        <DockPanel onClose={() => c.setOpen(false)} />
      ) : (
        <DockRail onOpen={() => c.setOpen(true)} />
      )}
    </aside>
  );
}

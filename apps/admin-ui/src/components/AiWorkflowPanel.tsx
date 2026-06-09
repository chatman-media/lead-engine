import { CheckIcon, SendIcon, SparklesIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { saas, type WorkflowChatMessage, type WorkflowPreviewStage } from "@/api/saas";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";

const KIND_LABEL: Record<string, string> = {
  intake: "Заявка",
  active: "Рабочая",
  terminal_won: "Успех",
  terminal_lost: "Отказ",
};

const GREETING =
  "Привет! Я помогу собрать воронку под ваш бизнес. Расскажите: чем занимаетесь, " +
  "как к вам приходят клиенты и какую информацию нужно от них собрать?";
const FUNNELS_UPDATED_EVENT = "lead-engine:funnel-updated";

export function AiWorkflowPanel({
  open,
  onOpenChange,
  onApplied,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onApplied: () => void;
}) {
  const [messages, setMessages] = useState<WorkflowChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<WorkflowPreviewStage[] | null>(null);
  const [pendingStages, setPendingStages] = useState<unknown[] | null>(null);
  const [applying, setApplying] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Сброс при открытии.
  useEffect(() => {
    if (open) {
      setMessages([]);
      setInput("");
      setError("");
      setPreview(null);
      setPendingStages(null);
    }
  }, [open]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, preview]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    const next: WorkflowChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setInput("");
    setError("");
    setBusy(true);
    setPreview(null);
    setPendingStages(null);
    try {
      const res = await saas.aiWorkflowChat(next);
      setMessages([...next, { role: "assistant", content: res.reply }]);
      if (res.readyToGenerate && res.preview && res.stages) {
        setPreview(res.preview);
        setPendingStages(res.stages);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка запроса к AI");
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!pendingStages) return;
    setApplying(true);
    setError("");
    try {
      await saas.applyWorkflow(pendingStages);
      onApplied();
      window.dispatchEvent(new Event(FUNNELS_UPDATED_EVENT));
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось применить воронку");
    } finally {
      setApplying(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:w-[480px] sm:max-w-[480px] p-0">
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <SparklesIcon className="size-4 text-primary" />
          <SheetTitle>Настройка воронки с AI</SheetTitle>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          <div className="rounded-lg bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
            {GREETING}
          </div>

          {messages.map((m, i) => (
            <div
              key={i}
              className={
                m.role === "user"
                  ? "ml-auto max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground"
                  : "max-w-[85%] rounded-lg bg-muted px-3 py-2 text-sm"
              }
            >
              {m.content}
            </div>
          ))}

          {busy && (
            <div className="max-w-[85%] rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
              AI печатает…
            </div>
          )}

          {preview && (
            <div className="rounded-lg border border-primary/40 bg-primary/5 p-3 space-y-2">
              <p className="text-xs font-semibold uppercase text-muted-foreground">
                Предпросмотр воронки ({preview.length} стадий)
              </p>
              <ol className="space-y-2">
                {preview.map((s, i) => (
                  <li key={s.slug} className="rounded-md border bg-card px-2.5 py-2 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground tabular-nums">{i + 1}.</span>
                      <span className="font-medium">{s.displayName}</span>
                      <Badge variant="secondary" className="text-xs">
                        {KIND_LABEL[s.kind] ?? s.kind}
                      </Badge>
                      {s.supportMode && (
                        <Badge variant="outline" className="text-xs text-muted-foreground">
                          оператор
                        </Badge>
                      )}
                    </div>
                    {s.fields.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1 pl-5">
                        {s.fields.map((f) => (
                          <span
                            key={f.slug}
                            className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                          >
                            {f.displayName}
                            {f.required && <span className="text-destructive">*</span>}
                            {f.aiExtractable && " · AI"}
                          </span>
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ol>
              <Button className="w-full" size="sm" onClick={apply} disabled={applying}>
                <CheckIcon className="mr-1.5 size-4" />
                {applying ? "Применяю…" : "Применить воронку"}
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                Заменит текущие стадии. Можно продолжить уточнять в чате.
              </p>
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <div className="border-t p-3">
          <div className="flex items-end gap-2">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="Опишите бизнес или ответьте на вопрос…"
              rows={2}
              className="resize-none text-sm"
              disabled={busy}
            />
            <Button size="icon" onClick={send} disabled={busy || !input.trim()}>
              <SendIcon className="size-4" />
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

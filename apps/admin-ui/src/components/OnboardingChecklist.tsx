import { ArrowRightIcon, CheckIcon } from "lucide-react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { OnboardingStatus } from "../api/saas.ts";

export interface OnboardingChecklistProps {
  status: OnboardingStatus;
  alwaysShow?: boolean;
}

interface StepProps {
  done: boolean;
  title: string;
  hint: string;
}

function Step({ done, title, hint }: StepProps) {
  return (
    <li className="flex items-center gap-3 rounded-lg border bg-card/40 px-3 py-2.5">
      <span
        className={cn(
          "grid size-6 shrink-0 place-items-center rounded-full border text-xs",
          done
            ? "border-transparent bg-[color-mix(in_oklch,var(--success)_22%,transparent)] text-[var(--success)]"
            : "border-border text-muted-foreground",
        )}
      >
        {done ? <CheckIcon className="size-3.5" /> : ""}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium leading-tight">{title}</p>
        <p className="truncate text-xs text-muted-foreground">{hint}</p>
      </div>
    </li>
  );
}

export function OnboardingChecklist({ status, alwaysShow = false }: OnboardingChecklistProps) {
  if (status.done && !alwaysShow) return null;
  const channelDone = status.channelConnected;
  const llmDone =
    status.chatLlmReady ??
    (status.chatLlmConfigured &&
      (status.chatProvider === "ollama" || (status.chatHasSecret ?? false)));
  const kbDone = status.hasKbDocuments;

  return (
    <Card className="border-primary/30 bg-gradient-to-b from-primary/[0.06] to-transparent">
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle>Начало работы</CardTitle>
          <p className="text-sm text-muted-foreground">
            {status.done
              ? "Всё готово — бот принимает сообщения"
              : "Несколько шагов, чтобы бот начал отвечать клиентам"}
          </p>
        </div>
        <Button asChild size="sm">
          <Link to="/onboarding">
            Продолжить <ArrowRightIcon />
          </Link>
        </Button>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-2 sm:grid-cols-3">
          <Step
            done={channelDone}
            title="Канал"
            hint={
              channelDone && status.channelExternalId
                ? `@${status.channelExternalId}`
                : "Telegram / WhatsApp / web"
            }
          />
          <Step
            done={llmDone}
            title="API-ключи"
            hint={
              llmDone && status.chatProvider
                ? `${status.chatProvider} / ${status.chatModel ?? ""}`
                : "chat + embed"
            }
          />
          <Step
            done={kbDone}
            title="База знаний"
            hint={kbDone ? "Документы есть" : "Опционально"}
          />
        </ul>
      </CardContent>
    </Card>
  );
}

import { Link } from "react-router-dom";
import type { OnboardingStatus } from "../api/saas.ts";

/**
 * Onboarding-checklist карточка. Показывает 3 шага (канал, LLM,
 * документы) с цветовыми статусами и deep-link'ами на нужные страницы.
 * Авто-скрывается когда все три зелёные.
 */
export interface OnboardingChecklistProps {
  status: OnboardingStatus;
  /** Если true — показывать даже когда done. Default: false (скрываем). */
  alwaysShow?: boolean;
}

interface StepProps {
  done: boolean;
  title: string;
  hint: string;
  ctaLabel: string;
  ctaTo: string;
  doneText?: string;
}

function Step({ done, title, hint, ctaLabel, ctaTo, doneText }: StepProps) {
  return (
    <li className={`onboarding-step ${done ? "done" : ""}`}>
      <span className="onboarding-mark">{done ? "✓" : "○"}</span>
      <div className="onboarding-step-body">
        <strong>{title}</strong>
        <small>{done && doneText ? doneText : hint}</small>
      </div>
      {!done && (
        <Link to={ctaTo} className="nav-link onboarding-cta">
          {ctaLabel}
        </Link>
      )}
    </li>
  );
}

export function OnboardingChecklist({ status, alwaysShow = false }: OnboardingChecklistProps) {
  if (status.done && !alwaysShow) return null;

  return (
    <section className="onboarding-card">
      <div className="onboarding-header">
        <h2>Начало работы</h2>
        <small>
          {status.done ? (
            <span className="muted">Всё готово — бот принимает сообщения</span>
          ) : (
            <span className="muted">Выполните шаги ниже, чтобы бот начал отвечать клиентам</span>
          )}
        </small>
      </div>
      <ul className="onboarding-list">
        <Step
          done={status.channelConnected}
          title="1. Подключите канал"
          hint="Telegram-бот через токен @BotFather"
          ctaLabel="Подключить"
          ctaTo="/onboarding"
          {...(status.channelExternalId
            ? { doneText: `@${status.channelExternalId} активен` }
            : {})}
        />
        <Step
          done={status.chatLlmConfigured && (status.chatHasSecret ?? false)}
          title="2. Настройте LLM"
          hint="Свой OpenAI / Anthropic / Ollama ключ"
          ctaLabel="Настроить"
          ctaTo="/onboarding"
          {...(status.chatProvider
            ? { doneText: `${status.chatProvider} / ${status.chatModel ?? ""}` }
            : {})}
        />
        <Step
          done={status.hasKbDocuments}
          title="3. Загрузите документы в KB"
          hint="Опционально, но даёт RAG-ответы по своей базе"
          ctaLabel="Загрузить"
          ctaTo="/onboarding"
          {...(status.hasKbDocuments ? { doneText: "Есть документы" } : {})}
        />
      </ul>
    </section>
  );
}

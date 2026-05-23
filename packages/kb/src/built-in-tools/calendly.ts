import { z } from "zod";
import type { AnyRagTool } from "../tools.ts";

/**
 * Встроенный tool: "offer_booking_link".
 *
 * Когда лид/кандидат хочет записаться на звонок, демо или встречу — LLM
 * вызывает этот tool, получает ссылку и вставляет её в ответ.
 * Работает с любой платформой бронирования: Calendly, Cal.com, Tidycal, и т.д.
 *
 * @param schedulingUrl — публичная ссылка на страницу бронирования тенанта
 *   Пример: "https://calendly.com/your-agency/30min"
 *
 * @example
 * ```ts
 * const tool = makeBookingLinkTool("https://calendly.com/my-agency/demo");
 * const result = await answerWithRag({ ..., tools: [tool] });
 * ```
 */
export function makeBookingLinkTool(schedulingUrl: string): AnyRagTool {
  return {
    name: "offer_booking_link",
    description: [
      "Use this tool when the lead or candidate explicitly wants to book a call,",
      "schedule a demo, arrange a meeting, or talk to a human.",
      "Returns the booking page URL so you can share it in your reply.",
      "Do NOT use it proactively — only when the person asks to book/schedule.",
    ].join(" "),
    parameters: z.object({}),
    execute: async () => ({ url: schedulingUrl }),
  };
}

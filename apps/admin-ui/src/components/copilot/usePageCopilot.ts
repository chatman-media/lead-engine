import { useEffect } from "react";
import { type PageCopilotContext, useCopilot } from "./CopilotProvider";

/**
 * Публикует контекст текущей страницы в копайлот (см. CopilotProvider).
 * Вызывается из страницы; данные — компактный снапшот того, что уже загружено.
 * Переиздаём только при изменении значимых полей (pageId/label/llmReady/data),
 * `data` сериализуем для стабильной зависимости. На размонтировании — очищаем.
 *
 *   usePageCopilot({ pageId: "onboarding", label: "Онбординг", data, llmReady });
 */
export function usePageCopilot(ctx: PageCopilotContext): void {
  const { publishContext } = useCopilot();
  let dataKey = "";
  try {
    dataKey = JSON.stringify(ctx.data ?? null);
  } catch {
    dataKey = "";
  }
  useEffect(() => {
    publishContext(ctx);
    return () => publishContext(null);
  }, [ctx.pageId, ctx.label, ctx.llmReady, dataKey, publishContext]);
}

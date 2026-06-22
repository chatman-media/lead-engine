// Перевод ответа оператора (RU) на язык клиента, вынесенный из
// operator-bot-handler. Зависит только от resolveChat-резолвера + db; читает
// detected_lang диалога и переводит при необходимости. null = перевод не нужен.

import type { ChatClient } from "@chatman-media/llm-router";
import { conversations } from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import type { Db } from "./dal/types.ts";
import { asSupportedLang, type Lang } from "./language.ts";
import type { PendingOperatorDraft } from "./operator-bot-shared.ts";
import { needsTranslation, OPERATOR_LANG, translateText } from "./translation.ts";
import { withTenant } from "./with-tenant.ts";

export async function translateOperatorReply(
  resolveChat: ((tenantId: number) => ChatClient) | undefined,
  draft: PendingOperatorDraft,
  db: Db,
): Promise<{ text: string; lang: Lang } | null> {
  if (!resolveChat) return null;
  if (draft.metadata?.exchangeAction) return null;
  if (!draft.text?.trim()) return null;
  const lang = await withTenant(db, draft.tenantId, async (tx) => {
    const [conv] = await tx
      .select({ detectedLang: conversations.detectedLang })
      .from(conversations)
      .where(
        and(eq(conversations.tenantId, draft.tenantId), eq(conversations.id, draft.conversationId)),
      )
      .limit(1);
    return asSupportedLang(conv?.detectedLang);
  });
  if (!lang || !needsTranslation(OPERATOR_LANG, lang)) return null;
  const translated = await translateText({
    chat: resolveChat(draft.tenantId),
    text: draft.text,
    targetLang: lang,
    onWarn: (m) => console.warn(m),
  });
  return translated === draft.text ? null : { text: translated, lang };
}

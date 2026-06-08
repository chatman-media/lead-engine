export type ServiceIntent = "exchange" | "real_estate" | "product" | "partner_service" | "unclear";

export interface RoutableFunnel {
  id: number;
  slug: string;
  verticalTemplateId: string | null;
}

const INTENT_PATTERNS: Array<{ intent: Exclude<ServiceIntent, "unclear">; words: RegExp[] }> = [
  {
    intent: "exchange",
    words: [
      /\b(usdt|btc|eth|ton|rub|thb|usd|eur|trx|trc20|erc20)\b/i,
      /\b(exchange|swap|crypto|coin|rate|wallet|aml|kyc)\b/i,
      /(обмен|обменять|крипт|кошелек|кошелёк|курс|рубл|бат|доллар|тезер|юсдт|тон)/i,
    ],
  },
  {
    intent: "real_estate",
    words: [
      /\b(real[\s_-]?estate|property|villa|apartment|condo|rent|buy)\b/i,
      /(недвиж|квартир|вилла|вилл|дом|аренд|купить|продать|пхукет|самуи|кондо)/i,
    ],
  },
  {
    intent: "product",
    words: [
      /\b(product|demo|subscription|license|saas|software|app)\b/i,
      /(продукт|демо|подписк|лиценз|софт|приложен)/i,
    ],
  },
  {
    intent: "partner_service",
    words: [
      /\b(partner|supplier|contractor|agency|service)\b/i,
      /(партнер|партнёр|подрядчик|агентств|услуг|интеграц|подключить)/i,
    ],
  },
];

export function classifyServiceIntent(text: string): ServiceIntent {
  const value = text.trim();
  if (!value) return "unclear";
  for (const group of INTENT_PATTERNS) {
    if (group.words.some((rx) => rx.test(value))) return group.intent;
  }
  return "unclear";
}

export function chooseFunnelForIntent(
  rows: RoutableFunnel[],
  text: string,
): RoutableFunnel | null {
  if (rows.length === 0) return null;
  const intent = classifyServiceIntent(text);
  const normalized = intent === "product" ? "saas" : intent;
  const direct = rows.find((f) => funnelMatches(f, normalized));
  if (direct) return direct;
  if (intent === "partner_service") {
    const partner = rows.find((f) => funnelMatches(f, "partner"));
    if (partner) return partner;
  }
  return rows[0] ?? null;
}

function funnelMatches(funnel: RoutableFunnel, token: string): boolean {
  const haystack = `${funnel.slug} ${funnel.verticalTemplateId ?? ""}`.toLowerCase();
  return haystack.includes(token);
}

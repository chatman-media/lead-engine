export type ServiceIntent =
  | "exchange"
  | "transfer"
  | "green_corridor"
  | "real_estate"
  | "product"
  | "partner_service"
  | "unclear";

export interface RoutableFunnel {
  id: number;
  slug: string;
  verticalTemplateId: string | null;
}

export type CatalogRouteType = "manual" | "funnel" | "partner_service" | "webhook";

export interface RoutableCatalogItem {
  id: number;
  slug: string;
  name: string;
  category: string | null;
  description: string | null;
  routeType: CatalogRouteType;
  funnelId: number | null;
  partnerServiceId: number | null;
  partnerServiceFunnelId: number | null;
  partnerServiceStageDefinitionId: number | null;
  webhookUrl: string | null;
}

export interface ServiceRouteSelection {
  source: "catalog" | "intent";
  funnel: RoutableFunnel | null;
  catalogItem: RoutableCatalogItem | null;
  intent: ServiceIntent;
  /**
   * true — каталог совпал или интент прямо указал на воронку;
   * false — fallback на первую активную воронку (sticky-роутинг в
   * field-extractor вправе остаться в воронке открытого лида).
   */
  matched: boolean;
}

const INTENT_PATTERNS: Array<{
  intent: Exclude<ServiceIntent, "unclear">;
  words: RegExp[];
}> = [
  {
    intent: "exchange",
    words: [
      /\b(usdt|btc|eth|ton|rub|thb|usd|eur|trx|trc20|erc20)\b/i,
      /\b(exchange|swap|crypto|coin|rate|wallet|aml|kyc)\b/i,
      /(обмен|обменять|крипт|кошелек|кошелёк|курс|рубл|бат|доллар|тезер|юсдт|тон)/i,
    ],
  },
  {
    // ПЕРЕД transfer: vip/сопровождение/fast-track — коридор, а не такси.
    intent: "green_corridor",
    words: [
      /зел[её]н(ый|ого|ому|ым)\s+коридор/i,
      /\b(green\s*corridor|fast[\s-]?track)\b/i,
      /\bvip\s*meet/i,
      /(вип|vip)[\s-]?(встреч|сопровожд)/i,
      /сопровожден[^.!?\n]{0,40}(аэропорт|термина|рейс)/i,
      /(аэропорт|термина|рейс)[^.!?\n]{0,40}сопровожд/i,
    ],
  },
  {
    intent: "transfer",
    words: [
      /(трансфер|transfer)/i,
      /\bairport\s*(pickup|taxi|shuttle)\b/i,
      /(такси|машин[ау]|водител)[^.!?\n]{0,40}(аэропорт|встретить|подать)/i,
      // «встретьте в аэропорту» без vip/сопровождения — подача машины.
      /(встрет(ить|ьте|ите)|встреча)[^.!?\n]{0,40}(аэропорт|термина|рейс)/i,
      /(довез(ти|ите)|отвез(ти|ите)|подвез)/i,
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

/**
 * Прямое совпадение интента с воронкой (по slug/verticalTemplateId).
 * null — интент не указал на конкретную воронку (unclear или нет такой воронки).
 */
export function matchFunnelForIntent(rows: RoutableFunnel[], text: string): RoutableFunnel | null {
  if (rows.length === 0) return null;
  const intent = classifyServiceIntent(text);
  if (intent === "unclear") return null;
  const normalized = intent === "product" ? "saas" : intent;
  const direct = rows.find((f) => funnelMatches(f, normalized));
  if (direct) return direct;
  if (intent === "partner_service") {
    const partner = rows.find((f) => funnelMatches(f, "partner"));
    if (partner) return partner;
  }
  return null;
}

export function chooseFunnelForIntent(rows: RoutableFunnel[], text: string): RoutableFunnel | null {
  if (rows.length === 0) return null;
  return matchFunnelForIntent(rows, text) ?? rows[0] ?? null;
}

export function chooseServiceRoute(opts: {
  funnels: RoutableFunnel[];
  catalogItems: RoutableCatalogItem[];
  text: string;
}): ServiceRouteSelection {
  const intent = classifyServiceIntent(opts.text);
  const catalogItem = findMatchingCatalogItem(opts.catalogItems, opts.text);
  if (catalogItem) {
    return {
      source: "catalog",
      funnel: resolveCatalogFunnel(opts.funnels, catalogItem),
      catalogItem,
      intent,
      matched: true,
    };
  }

  const matchedFunnel = matchFunnelForIntent(opts.funnels, opts.text);
  return {
    source: "intent",
    funnel: matchedFunnel ?? opts.funnels[0] ?? null,
    catalogItem: null,
    intent,
    matched: matchedFunnel !== null,
  };
}

function funnelMatches(funnel: RoutableFunnel, token: string): boolean {
  // Дефисы → подчёркивания: слаг "green-corridor" должен матчить токен
  // интента "green_corridor".
  const haystack = `${funnel.slug} ${funnel.verticalTemplateId ?? ""}`
    .toLowerCase()
    .replaceAll("-", "_");
  return haystack.includes(token);
}

function resolveCatalogFunnel(
  funnels: RoutableFunnel[],
  item: RoutableCatalogItem,
): RoutableFunnel | null {
  const direct = item.funnelId ? funnels.find((f) => f.id === item.funnelId) : null;

  if (item.routeType === "partner_service" && item.partnerServiceFunnelId) {
    const partnerFunnel = funnels.find((f) => f.id === item.partnerServiceFunnelId);
    if (partnerFunnel) return partnerFunnel;
  }

  if (direct) return direct;

  return funnels[0] ?? null;
}

function findMatchingCatalogItem(
  rows: RoutableCatalogItem[],
  text: string,
): RoutableCatalogItem | null {
  const normalizedText = normalizeForSearch(text);
  if (!normalizedText) return null;
  const requestTokens = tokenize(normalizedText);

  for (const item of rows) {
    const directParts = [item.slug, item.name].map(normalizeForSearch).filter(Boolean);
    if (directParts.some((part) => part.length >= 3 && normalizedText.includes(part))) {
      return item;
    }

    const itemText = normalizeForSearch(
      [item.slug, item.name, item.category, item.description].filter(Boolean).join(" "),
    );
    const itemTokens = tokenize(itemText).filter((t) => !STOP_WORDS.has(t));
    if (itemTokens.some((token) => tokenMatches(token, requestTokens, normalizedText))) {
      return item;
    }
  }

  return null;
}

function tokenMatches(token: string, requestTokens: string[], normalizedText: string): boolean {
  if (token.length < 3) return false;
  if (normalizedText.includes(token)) return true;
  if (token.length < 5) return false;
  const stem = token.slice(0, 5);
  return requestTokens.some(
    (requestToken) => requestToken.length >= 5 && requestToken.startsWith(stem),
  );
}

function normalizeForSearch(value: string): string {
  return value
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[^a-z0-9а-я]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value: string): string[] {
  return normalizeForSearch(value)
    .split(" ")
    .filter((token) => token.length >= 3);
}

const STOP_WORDS = new Set([
  "для",
  "или",
  "как",
  "что",
  "это",
  "вам",
  "нас",
  "наш",
  "ваш",
  "service",
  "services",
  "услуга",
  "услуги",
  "основное",
]);

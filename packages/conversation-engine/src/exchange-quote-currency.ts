/**
 * Re-export котируемой валюты из @chatman-media/verticals (канонический дом —
 * там её видят и data-only вертикали, и conversation-engine).
 */
export {
  ANY_QUOTE_CURRENCY_MENTION_RE,
  KNOWN_QUOTE_CURRENCIES,
  QUOTE_CURRENCY,
  QUOTE_CURRENCY_CODES,
  type QuoteCurrency,
  resolveQuoteCurrency,
} from "@chatman-media/verticals";

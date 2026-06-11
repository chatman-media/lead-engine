/**
 * Котируемая (локальная) валюта обменника. Основной источник — per-tenant
 * настройка exchange_settings.quote_asset (правится в админке); этот модуль
 * даёт словарь валют и платформенный дефолт-фоллбэк.
 *
 * Дефолт платформы — PHP (Филиппины); env EXCHANGE_QUOTE_ASSET переопределяет
 * дефолт деплоя (например THB для таиландского стенда).
 */

export interface QuoteCurrency {
	/** ISO-код: THB, PHP, ... */
	code: string;
	/** Слово в текстах клиенту: «бат», «песо». */
	word: string;
	/** Родительный падеж мн.ч. для текстов: «батов», «песо». */
	wordGen: string;
	/** Именительный падеж мн.ч. с заглавной для табло: «Баты», «Песо». */
	tabloWord: string;
	/** Флаг для табло/сообщений. */
	flag: string;
	/** Упоминание валюты в тексте (детект котировок в reply-guard). */
	mentionRe: RegExp;
	/** Локальный банковский рельс в текстах: «тайский банк», «местный банк». */
	bankLabel: string;
}

export const KNOWN_QUOTE_CURRENCIES: Record<string, QuoteCurrency> = {
	PHP: {
		code: "PHP",
		word: "песо",
		wordGen: "песо",
		tabloWord: "Песо",
		flag: "🇵🇭",
		mentionRe: /php|песо|peso|₱/i,
		bankLabel: "местный банк (BDO/BPI/GCash)",
	},
	THB: {
		code: "THB",
		word: "бат",
		wordGen: "батов",
		tabloWord: "Баты",
		flag: "🇹🇭",
		mentionRe: /thb|бат|bhat|฿/i,
		bankLabel: "тайский банк",
	},
	VND: {
		code: "VND",
		word: "донг",
		wordGen: "донгов",
		tabloWord: "Донги",
		flag: "🇻🇳",
		mentionRe: /vnd|донг|dong|₫/i,
		bankLabel: "вьетнамский банк",
	},
	IDR: {
		code: "IDR",
		word: "рупия",
		wordGen: "рупий",
		tabloWord: "Рупии",
		flag: "🇮🇩",
		mentionRe: /idr|рупи|rupiah|rp\b/i,
		bankLabel: "индонезийский банк",
	},
};

/** Коды для UI-селекта (порядок = порядок показа). */
export const QUOTE_CURRENCY_CODES: string[] = Object.keys(KNOWN_QUOTE_CURRENCIES);

const PLATFORM_DEFAULT_CODE = "PHP";

/**
 * Резолвит валюту по коду (per-tenant настройка). Пустой/неизвестный код →
 * платформенный дефолт (env EXCHANGE_QUOTE_ASSET, иначе PHP); неизвестный, но
 * валидный ISO-код работает без локализованного слова.
 */
export function resolveQuoteCurrency(code?: string | null): QuoteCurrency {
	const normalized = (code ?? "").trim().toUpperCase();
	if (!normalized) return QUOTE_CURRENCY;
	const known = KNOWN_QUOTE_CURRENCIES[normalized];
	if (known) return known;
	return {
		code: normalized,
		word: normalized,
		wordGen: normalized,
		tabloWord: normalized,
		flag: "",
		mentionRe: new RegExp(normalized.replace(/[^A-Z]/g, ""), "i"),
		bankLabel: "местный банк",
	};
}

function resolvePlatformDefault(): QuoteCurrency {
	const code = (process.env.EXCHANGE_QUOTE_ASSET ?? PLATFORM_DEFAULT_CODE)
		.trim()
		.toUpperCase();
	return (
		KNOWN_QUOTE_CURRENCIES[code] ?? KNOWN_QUOTE_CURRENCIES[PLATFORM_DEFAULT_CODE] as QuoteCurrency
	);
}

/** Платформенный дефолт (фоллбэк, когда per-tenant настройки нет). */
export const QUOTE_CURRENCY: QuoteCurrency = resolvePlatformDefault();

/**
 * Упоминание ЛЮБОЙ известной котируемой валюты — для guard'ов, которым важно
 * поймать котировку в тексте независимо от валюты тенанта.
 */
export const ANY_QUOTE_CURRENCY_MENTION_RE: RegExp = new RegExp(
	Object.values(KNOWN_QUOTE_CURRENCIES)
		.map((c) => c.mentionRe.source)
		.join("|"),
	"i",
);

/**
 * Синхронизация банкоматов из OpenStreetMap Overpass API в exchange_payout_points.
 * Апсерт по external_id='osm:<node_id>' — повторный запуск идемпотентен.
 * Используется как из CLI-скрипта (sync-osm-atms.ts), так и из admin-endpoint.
 */

import type { Db } from "@chatman-media/conversation-engine";
import { exchangePayoutPoints } from "@chatman-media/storage";
import { and, eq, sql } from "drizzle-orm";

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

// ── Bank config ───────────────────────────────────────────────────────────────

export interface BankConfig {
  bankName: string;
  /** Denomination step for cardless withdrawal rounding. */
  denomination: number;
  /** Max per single cardless withdrawal. */
  perWithdrawalMax: number;
  /** Cardless code TTL in seconds. */
  codeTtlSec: number;
}

// Cardless limits: PHP step=100, per-txn 10k; THB step=500/1000, per-txn 20k.
// Source: reference_atm_cardless_limits.
const BANK_MAP: Array<{ pattern: RegExp; config: BankConfig }> = [
  // ── Thai banks (THB) ──────────────────────────────────────────────────────
  {
    pattern: /\bscb\b|siam commercial/i,
    config: { bankName: "SCB", denomination: 500, perWithdrawalMax: 20_000, codeTtlSec: 900 },
  },
  {
    pattern: /kasikorn|kbank|k\s*bank/i,
    config: { bankName: "KBANK", denomination: 1000, perWithdrawalMax: 20_000, codeTtlSec: 900 },
  },
  {
    pattern: /\bktb\b|krungthai|krung thai/i,
    config: { bankName: "KTB", denomination: 500, perWithdrawalMax: 20_000, codeTtlSec: 900 },
  },
  {
    pattern: /\bbbl\b|bangkok bank/i,
    config: { bankName: "BBL", denomination: 500, perWithdrawalMax: 20_000, codeTtlSec: 900 },
  },
  {
    pattern: /\bbay\b|krungsri|bank of ayudhya/i,
    config: { bankName: "BAY", denomination: 500, perWithdrawalMax: 20_000, codeTtlSec: 900 },
  },
  {
    pattern: /\bttb\b|tmb|thanachart/i,
    config: { bankName: "TTB", denomination: 500, perWithdrawalMax: 20_000, codeTtlSec: 900 },
  },
  {
    pattern: /\buob\b|united overseas/i,
    config: { bankName: "UOB", denomination: 500, perWithdrawalMax: 20_000, codeTtlSec: 900 },
  },
  {
    pattern: /\bgsb\b|government savings bank|ออมสิน/i,
    config: { bankName: "GSB", denomination: 500, perWithdrawalMax: 20_000, codeTtlSec: 900 },
  },
  {
    pattern: /\bcimb\b/i,
    config: { bankName: "CIMB", denomination: 500, perWithdrawalMax: 20_000, codeTtlSec: 900 },
  },
  {
    pattern: /\btisco\b/i,
    config: { bankName: "TISCO", denomination: 500, perWithdrawalMax: 20_000, codeTtlSec: 900 },
  },
  // ── Philippine banks (PHP) ────────────────────────────────────────────────
  {
    pattern: /\bbdo\b|banco de oro|bdo unibank/i,
    config: { bankName: "BDO", denomination: 100, perWithdrawalMax: 10_000, codeTtlSec: 1800 },
  },
  {
    pattern: /\bbpi\b|bank of the philippine islands/i,
    config: { bankName: "BPI", denomination: 100, perWithdrawalMax: 10_000, codeTtlSec: 1800 },
  },
  {
    pattern: /metrobank|metropolitan bank/i,
    config: {
      bankName: "Metrobank",
      denomination: 100,
      perWithdrawalMax: 10_000,
      codeTtlSec: 1800,
    },
  },
  {
    pattern: /unionbank|union bank of the philippines/i,
    config: {
      bankName: "UnionBank",
      denomination: 100,
      perWithdrawalMax: 10_000,
      codeTtlSec: 1800,
    },
  },
  {
    pattern: /landbank|land bank/i,
    config: { bankName: "Landbank", denomination: 100, perWithdrawalMax: 10_000, codeTtlSec: 1800 },
  },
  {
    pattern: /\bpnb\b|philippine national bank/i,
    config: { bankName: "PNB", denomination: 100, perWithdrawalMax: 10_000, codeTtlSec: 1800 },
  },
  {
    pattern: /\brcbc\b|rizal commercial/i,
    config: { bankName: "RCBC", denomination: 100, perWithdrawalMax: 10_000, codeTtlSec: 1800 },
  },
  {
    pattern: /east\s*west\s*(bank|unibank)|eastwest/i,
    config: { bankName: "EastWest", denomination: 100, perWithdrawalMax: 10_000, codeTtlSec: 1800 },
  },
  {
    pattern: /chinabank|china bank|china banking/i,
    config: {
      bankName: "Chinabank",
      denomination: 100,
      perWithdrawalMax: 10_000,
      codeTtlSec: 1800,
    },
  },
  {
    pattern: /security bank/i,
    config: {
      bankName: "Security Bank",
      denomination: 100,
      perWithdrawalMax: 10_000,
      codeTtlSec: 1800,
    },
  },
  {
    pattern: /\bpsbank\b|philippine savings bank/i,
    config: { bankName: "PSBank", denomination: 100, perWithdrawalMax: 10_000, codeTtlSec: 1800 },
  },
  {
    pattern: /\bhsbc\b/i,
    config: { bankName: "HSBC", denomination: 100, perWithdrawalMax: 10_000, codeTtlSec: 1800 },
  },
  {
    pattern: /\baub\b|asia united bank/i,
    config: { bankName: "AUB", denomination: 100, perWithdrawalMax: 10_000, codeTtlSec: 1800 },
  },
  {
    pattern: /bank of commerce/i,
    config: {
      bankName: "Bank of Commerce",
      denomination: 100,
      perWithdrawalMax: 10_000,
      codeTtlSec: 1800,
    },
  },
  {
    pattern: /\bcitibank\b/i,
    config: { bankName: "Citibank", denomination: 100, perWithdrawalMax: 10_000, codeTtlSec: 1800 },
  },
  {
    pattern: /robinsons\s*bank/i,
    config: {
      bankName: "Robinsons Bank",
      denomination: 100,
      perWithdrawalMax: 10_000,
      codeTtlSec: 1800,
    },
  },
  {
    pattern: /\bdbp\b|development bank of the philippines/i,
    config: { bankName: "DBP", denomination: 100, perWithdrawalMax: 10_000, codeTtlSec: 1800 },
  },
  {
    pattern: /\bucpb\b|united coconut planters/i,
    config: { bankName: "UCPB", denomination: 100, perWithdrawalMax: 10_000, codeTtlSec: 1800 },
  },
];

export function resolveBankConfig(tags: Record<string, string>): BankConfig | null {
  const candidates = [tags.operator, tags.brand, tags.name].filter(Boolean).join(" ");
  for (const { pattern, config } of BANK_MAP) {
    if (pattern.test(candidates)) return config;
  }
  return null;
}

// ── OSM helpers ───────────────────────────────────────────────────────────────

interface OsmNode {
  type: "node";
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}

const OVERPASS_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  "User-Agent": "lead-engine/1.0 (exchange atm sync)",
};

/** Таймаут одного запроса к Overpass (серверный [timeout:90] + запас на сеть). */
const OVERPASS_FETCH_TIMEOUT_MS = 100_000;

/**
 * Валидирует bbox "lat_min,lng_min,lat_max,lng_max" перед подстановкой в
 * Overpass-запрос: ровно 4 конечных числа в диапазонах широты/долготы и
 * не инвертированные. bbox приходит от админа — не доверяем сырой строке
 * в теле запроса (плюс понятная ошибка вместо мусорного ответа Overpass).
 */
export function validateBbox(bbox: string): void {
  const parts = bbox.split(",").map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(
      `Некорректный bbox: ожидается "lat_min,lng_min,lat_max,lng_max" из 4 чисел, получено "${bbox}"`,
    );
  }
  const [latMin, lngMin, latMax, lngMax] = parts as [number, number, number, number];
  if (
    latMin < -90 ||
    latMax > 90 ||
    lngMin < -180 ||
    lngMax > 180 ||
    latMin >= latMax ||
    lngMin >= lngMax
  ) {
    throw new Error(`bbox вне диапазона или инвертирован: "${bbox}"`);
  }
}

export async function fetchOsmAtms(bbox: string): Promise<OsmNode[]> {
  validateBbox(bbox);
  const query = `[out:json][timeout:90][bbox:${bbox}];\nnode["amenity"="atm"];\nout body;`;
  const body = `data=${encodeURIComponent(query)}`;

  const MAX_ATTEMPTS = 3;
  const BACKOFF_MS = [0, 8_000, 24_000];
  let lastStatus = 0;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (BACKOFF_MS[attempt]) {
      await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
    }
    // Свой таймаут на каждый запрос: серверный [timeout:90] не спасает от
    // зависшего TCP-соединения, а 3 ретрая повесили бы admin-эндпоинт.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OVERPASS_FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(OVERPASS_URL, {
        method: "POST",
        headers: OVERPASS_HEADERS,
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429 || res.status === 503) {
      lastStatus = res.status;
      continue;
    }
    if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
    const data = (await res.json()) as { elements: OsmNode[] };
    return data.elements.filter((e): e is OsmNode => e.type === "node");
  }

  throw new Error(
    `Overpass API перегружен (${lastStatus}) — сервер превысил квоту. Попробуйте через 5 минут.`,
  );
}

function buildLabel(bankName: string, tags: Record<string, string>): string {
  if (tags.branch) return `${bankName} ${tags.branch}`;
  const place =
    tags["addr:suburb"] ??
    tags["addr:quarter"] ??
    tags["addr:neighbourhood"] ??
    tags["addr:city"] ??
    tags["addr:municipality"];
  return place ? `${bankName} ${place}` : bankName;
}

function buildAddress(tags: Record<string, string>): string | null {
  if (tags["addr:full"]) return tags["addr:full"];
  const street = tags["addr:street"];
  const num = tags["addr:housenumber"];
  if (street) return num ? `${num} ${street}` : street;
  return null;
}

function buildCity(tags: Record<string, string>): string | null {
  return (
    tags["addr:city"] ??
    tags["addr:municipality"] ??
    tags["addr:town"] ??
    tags["addr:suburb"] ??
    null
  );
}

// ── Core sync ─────────────────────────────────────────────────────────────────

export interface OsmSyncOpts {
  /** Bounding box: "lat_min,lng_min,lat_max,lng_max". Default: Metro Manila. */
  bbox?: string;
  /** ISO-4217 quote asset stored on inserted points. Default: "PHP". */
  quoteAsset?: string;
}

export interface OsmSyncResult {
  fetched: number;
  upserted: number;
  skipped: number;
}

/** Default bbox: Metro Manila metro area. */
export const DEFAULT_PH_BBOX = "14.35,120.90,14.80,121.15";
/** Phuket island (full). */
export const DEFAULT_TH_PHUKET_BBOX = "7.75,98.20,8.20,98.45";
/** Greater Bangkok (BTS corridor + inner suburbs). */
export const DEFAULT_TH_BANGKOK_BBOX = "13.60,100.40,13.90,100.80";

export async function syncOsmAtms(
  db: Db,
  tenantId: number,
  opts: OsmSyncOpts = {},
): Promise<OsmSyncResult> {
  const bbox = opts.bbox ?? DEFAULT_PH_BBOX;
  const quoteAsset = opts.quoteAsset ?? "PHP";

  const nodes = await fetchOsmAtms(bbox);
  const now = Math.floor(Date.now() / 1000);

  let upserted = 0;
  let skipped = 0;

  for (const node of nodes) {
    const tags = node.tags ?? {};
    const bankConfig = resolveBankConfig(tags);
    if (!bankConfig) {
      skipped++;
      continue;
    }

    const externalId = `osm:${node.id}`;
    const label = buildLabel(bankConfig.bankName, tags);
    const address = buildAddress(tags);
    const city = buildCity(tags);
    const lat = node.lat;
    const lng = node.lon;
    const code = `osm_${node.id}`;

    // Partial unique index: (tenant_id, external_id) WHERE external_id IS NOT NULL
    await db.execute(sql`
      INSERT INTO exchange_payout_points (
        tenant_id, kind, code, label, bank_name, quote_asset,
        denomination, per_withdrawal_max, code_ttl_sec,
        fee_fixed, fee_pct,
        lat, lng, city, address,
        is_active, source, external_id, synced_at,
        created_at, updated_at
      ) VALUES (
        ${tenantId}, 'atm', ${code}, ${label}, ${bankConfig.bankName}, ${quoteAsset},
        ${bankConfig.denomination}, ${bankConfig.perWithdrawalMax}, ${bankConfig.codeTtlSec},
        0, 0,
        ${lat}, ${lng}, ${city ?? null}, ${address ?? null},
        true, 'feed', ${externalId}, ${now},
        ${now}, ${now}
      )
      ON CONFLICT (tenant_id, external_id) WHERE external_id IS NOT NULL
      DO UPDATE SET
        label      = EXCLUDED.label,
        bank_name  = EXCLUDED.bank_name,
        lat        = EXCLUDED.lat,
        lng        = EXCLUDED.lng,
        city       = EXCLUDED.city,
        address    = EXCLUDED.address,
        synced_at  = EXCLUDED.synced_at,
        updated_at = EXCLUDED.updated_at
    `);
    upserted++;
  }

  return { fetched: nodes.length, upserted, skipped };
}

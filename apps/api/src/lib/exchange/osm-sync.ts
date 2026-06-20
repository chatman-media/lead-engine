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

// Cardless limits: PHP step=100, per-txn 10k. Source: reference_atm_cardless_limits.
const BANK_MAP: Array<{ pattern: RegExp; config: BankConfig }> = [
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

export async function fetchOsmAtms(bbox: string): Promise<OsmNode[]> {
  const query = `[out:json][timeout:90][bbox:${bbox}];\nnode["amenity"="atm"];\nout body;`;
  const res = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `data=${encodeURIComponent(query)}`,
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  const data = (await res.json()) as { elements: OsmNode[] };
  return data.elements.filter((e): e is OsmNode => e.type === "node");
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

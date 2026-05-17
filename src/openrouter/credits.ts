/**
 * OpenRouter account balance.
 *
 * `GET {baseUrl}/credits` returns `{ data: { total_credits, total_usage } }`
 * (both USD). The remaining balance is the difference. Used by the
 * background balance monitor and surfaced on `/admin/status`.
 */

export interface OpenRouterCredits {
  /** Total credits ever purchased / granted, USD. */
  totalCredits: number;
  /** Total spent so far, USD. */
  totalUsage: number;
  /** Remaining balance, USD. */
  remaining: number;
  /** Epoch seconds when this snapshot was taken. */
  checkedAt: number;
}

/** Parse the `/credits` response body into a typed snapshot. Throws on an
 *  unexpected shape. Separated from the fetch so it can be unit-tested. */
export function parseCreditsBody(body: unknown, checkedAt: number): OpenRouterCredits {
  const data = (body as { data?: { total_credits?: unknown; total_usage?: unknown } } | null)?.data;
  const totalCredits = Number(data?.total_credits);
  const totalUsage = Number(data?.total_usage);
  if (!Number.isFinite(totalCredits) || !Number.isFinite(totalUsage)) {
    throw new Error("OpenRouter /credits: unexpected response shape");
  }
  return {
    totalCredits,
    totalUsage,
    remaining: totalCredits - totalUsage,
    checkedAt,
  };
}

/**
 * Fetch the live OpenRouter balance. Throws on missing key, network error,
 * non-2xx, or unexpected response shape.
 */
export async function fetchOpenRouterCredits(opts: {
  apiKey: string;
  baseUrl: string;
}): Promise<OpenRouterCredits> {
  if (!opts.apiKey) throw new Error("OpenRouter API key is not set");
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/credits`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${opts.apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`OpenRouter /credits returned HTTP ${res.status}`);
  }
  return parseCreditsBody(await res.json(), Math.floor(Date.now() / 1000));
}

// In-memory cache: the background monitor refreshes it on a timer; the
// /admin/status endpoint reads it so a page load never blocks on (or
// rate-limits against) the OpenRouter API.
let cached: OpenRouterCredits | null = null;

export function setCachedCredits(c: OpenRouterCredits): void {
  cached = c;
}

export function getCachedCredits(): OpenRouterCredits | null {
  return cached;
}

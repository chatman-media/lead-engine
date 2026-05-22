/**
 * Минимальная REST-обёртка над Stripe API (без stripe-node SDK).
 *
 * Покрывает три use-case'а нужных для M1b:
 *   - createCheckoutSession — POST /v1/checkout/sessions (subscription mode)
 *   - createCustomer        — POST /v1/customers
 *   - createBillingPortalSession — POST /v1/billing_portal/sessions
 *
 * Auth: Bearer <secret_key>. Form-encoded body (Stripe API standard).
 * Error mode: `StripeApiError` с code + message. Caller возвращает 502
 * в HTTP.
 */

export type StripeFetchLike = typeof fetch;

export class StripeApiError extends Error {
  constructor(
    public method: string,
    public statusCode: number,
    public code: string | undefined,
    public description: string,
  ) {
    super(`Stripe ${method} failed (${statusCode}): ${code ?? "no_code"} — ${description}`);
    this.name = "StripeApiError";
  }
}

export interface StripeApiOpts {
  secretKey: string;
  fetch?: StripeFetchLike;
  baseUrl?: string;
}

interface StripeError {
  error?: { code?: string; message?: string; type?: string };
}

/** Encode an object as application/x-www-form-urlencoded — Stripe standard. */
function formEncode(obj: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) params.set(k, String(v));
  }
  return params.toString();
}

export class StripeApi {
  private readonly secretKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: StripeFetchLike;

  constructor(opts: StripeApiOpts) {
    if (!opts.secretKey) throw new Error("StripeApi: secretKey required");
    this.secretKey = opts.secretKey;
    this.baseUrl = opts.baseUrl ?? "https://api.stripe.com";
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async call<T>(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, string | number | undefined>,
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.secretKey}`,
    };
    if (method === "POST") {
      headers["content-type"] = "application/x-www-form-urlencoded";
    }
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body ? { body: formEncode(body) } : {}),
    });
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as StripeError;
      throw new StripeApiError(
        `${method} ${path}`,
        res.status,
        errBody.error?.code,
        errBody.error?.message ?? "unknown",
      );
    }
    return (await res.json()) as T;
  }

  /**
   * Create or retrieve a Stripe Customer for tenant. Lookup by tenant.id в
   * metadata — для idempotency повторного checkout без дублей customer'ов.
   */
  async createCustomer(input: {
    email: string;
    tenantId: number;
    tenantSlug: string;
  }): Promise<{ id: string; email: string }> {
    return this.call<{ id: string; email: string }>("POST", "/v1/customers", {
      email: input.email,
      "metadata[tenant_id]": input.tenantId,
      "metadata[tenant_slug]": input.tenantSlug,
    });
  }

  /**
   * Create a Stripe Checkout Session (subscription mode).
   * client_reference_id = tenantId — webhook handler matches назад.
   */
  async createCheckoutSession(input: {
    customerId: string;
    priceId: string;
    tenantId: number;
    successUrl: string;
    cancelUrl: string;
    trialDays?: number;
  }): Promise<{ id: string; url: string }> {
    const body: Record<string, string | number> = {
      mode: "subscription",
      customer: input.customerId,
      "line_items[0][price]": input.priceId,
      "line_items[0][quantity]": 1,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      client_reference_id: String(input.tenantId),
      "metadata[tenant_id]": input.tenantId,
    };
    if (input.trialDays && input.trialDays > 0) {
      body["subscription_data[trial_period_days]"] = input.trialDays;
    }
    return this.call("POST", "/v1/checkout/sessions", body);
  }

  /**
   * Create a Billing Portal Session — UI link где tenant управляет своей
   * subscription (cancel, update card, etc.).
   */
  async createBillingPortalSession(input: {
    customerId: string;
    returnUrl: string;
  }): Promise<{ id: string; url: string }> {
    return this.call("POST", "/v1/billing_portal/sessions", {
      customer: input.customerId,
      return_url: input.returnUrl,
    });
  }
}

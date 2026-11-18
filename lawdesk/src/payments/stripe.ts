// Stripe adapter, written against Stripe's documented REST API with fetch (no SDK).
// Every endpoint and field used here is cited in docs/payments.md. It cannot be exercised
// against real Stripe from the test suite; tests use recorded-shape responses and
// signatures computed with a made-up secret.
//
// Configuration (environment only; never stored, returned or logged):
//   STRIPE_SECRET_KEY            operating account key (sk_test_... or sk_live_...)
//   STRIPE_WEBHOOK_SECRET        signing secret of the operating webhook endpoint (whsec_...)
//   STRIPE_TRUST_SECRET_KEY      a SEPARATE Stripe account whose payouts go to the trust account
//   STRIPE_TRUST_WEBHOOK_SECRET  signing secret of the trust webhook endpoint

import {
  type Account,
  type CheckoutInput,
  type CheckoutSession,
  type PayEvent,
  type PaymentProvider,
  ProviderError,
  WebhookError,
  headerValue,
  verifySignature,
} from "./provider.ts";

export const STRIPE_API = "https://api.stripe.com/v1";
/** Stripe's documented minimum charge for USD ($0.50). */
export const STRIPE_MIN_CENTS = 50;

type Fetch = typeof fetch;

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  account: Account;
  testMode: boolean;
  fetch?: Fetch;
  apiBase?: string;
}

export function stripeEnv(account: Account, env: Record<string, string | undefined> = process.env): { secretKey: string; webhookSecret: string } {
  return account === "trust"
    ? { secretKey: env.STRIPE_TRUST_SECRET_KEY ?? "", webhookSecret: env.STRIPE_TRUST_WEBHOOK_SECRET ?? "" }
    : { secretKey: env.STRIPE_SECRET_KEY ?? "", webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? "" };
}

/** Form-encode nested params the way Stripe expects: a[b][0][c]=v. */
export function formEncode(params: Record<string, unknown>, prefix = ""): string {
  const out: string[] = [];
  const walk = (v: unknown, key: string) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${key}[${i}]`));
    else if (typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, key ? `${key}[${k}]` : k);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  };
  walk(params, prefix);
  return out.join("&");
}

export class StripeProvider implements PaymentProvider {
  readonly name = "stripe" as const;
  readonly account: Account;
  private cfg: StripeConfig;

  constructor(cfg: StripeConfig) {
    this.cfg = cfg;
    this.account = cfg.account;
  }

  /** Refuse a live key in test mode and a test key in live mode, so nobody is charged by accident. */
  private key(): string {
    const k = this.cfg.secretKey;
    if (!k) throw new ProviderError(`Stripe is not set up for the ${this.account} account (no secret key in the environment)`, 409);
    const live = k.startsWith("sk_live_") || k.startsWith("rk_live_");
    const test = k.startsWith("sk_test_") || k.startsWith("rk_test_");
    if (!live && !test) throw new ProviderError("The Stripe key in the environment is not a secret key (sk_...)", 409);
    if (this.cfg.testMode && live) throw new ProviderError("Test mode is on but the Stripe key is a live key; refusing to charge real cards", 409);
    if (!this.cfg.testMode && test) throw new ProviderError("Test mode is off but the Stripe key is a test key", 409);
    return k;
  }

  async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
    if (input.amountCents < STRIPE_MIN_CENTS) throw new ProviderError("Stripe's minimum card payment is $0.50", 400);
    const params = {
      mode: "payment",
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      client_reference_id: input.reference,
      customer_email: input.customerEmail || undefined,
      line_items: [
        {
          quantity: 1,
          price_data: { currency: input.currency, unit_amount: input.amountCents, product_data: { name: input.description.slice(0, 250) } },
        },
      ],
      metadata: { lawdesk_reference: input.reference, lawdesk_account: this.account, ...(input.metadata ?? {}) },
    };
    const f = this.cfg.fetch ?? fetch;
    let res: Response;
    try {
      res = await f(`${this.cfg.apiBase ?? STRIPE_API}/checkout/sessions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.key()}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: formEncode(params),
      });
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError("Could not reach Stripe. Try again in a minute.");
    }
    let data: any = null;
    try {
      data = await res.json();
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      // Stripe's error message is safe to show (it never contains the key); keep it short.
      const msg = typeof data?.error?.message === "string" ? data.error.message.slice(0, 300) : `HTTP ${res.status}`;
      throw new ProviderError(`Stripe refused the payment page: ${msg}`);
    }
    if (typeof data?.id !== "string" || typeof data?.url !== "string") throw new ProviderError("Stripe's reply had no payment page address");
    return { sessionId: data.id, url: data.url, expiresAt: typeof data.expires_at === "number" ? new Date(data.expires_at * 1000).toISOString() : null };
  }

  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>, nowSeconds?: number): void {
    if (!this.cfg.webhookSecret) throw new WebhookError("No Stripe webhook signing secret is configured for this account");
    verifySignature(headerValue(headers, "stripe-signature"), rawBody, [this.cfg.webhookSecret], nowSeconds);
  }

  parseEvent(rawBody: string): PayEvent {
    return parseStripeEvent(rawBody);
  }
}

export function parseStripeEvent(rawBody: string): PayEvent {
  let ev: any;
  try {
    ev = JSON.parse(rawBody);
  } catch {
    throw new WebhookError("Event is not JSON");
  }
  if (!ev || typeof ev.id !== "string" || typeof ev.type !== "string") throw new WebhookError("Not an event");
  const o = ev.data?.object ?? {};
  const base: PayEvent = { id: ev.id, type: ev.type, kind: "ignored", livemode: typeof ev.livemode === "boolean" ? ev.livemode : null };
  const str = (v: unknown) => (typeof v === "string" ? v : v && typeof v === "object" && typeof (v as any).id === "string" ? (v as any).id : null);
  const num = (v: unknown) => (Number.isSafeInteger(v) ? (v as number) : null);
  switch (ev.type) {
    case "checkout.session.completed":
      return {
        ...base,
        kind: o.payment_status === "paid" ? "succeeded" : o.payment_status === "unpaid" ? "pending" : "ignored",
        sessionId: str(o.id),
        paymentRef: str(o.payment_intent),
        reference: str(o.client_reference_id),
        amountCents: num(o.amount_total),
      };
    case "checkout.session.async_payment_succeeded":
      return { ...base, kind: "succeeded", sessionId: str(o.id), paymentRef: str(o.payment_intent), reference: str(o.client_reference_id), amountCents: num(o.amount_total) };
    case "checkout.session.async_payment_failed":
      return { ...base, kind: "failed", sessionId: str(o.id), paymentRef: str(o.payment_intent), reference: str(o.client_reference_id) };
    case "checkout.session.expired":
      return { ...base, kind: "expired", sessionId: str(o.id), reference: str(o.client_reference_id) };
    case "charge.refunded":
      return { ...base, kind: "refunded", paymentRef: str(o.payment_intent), amountCents: num(o.amount), refundedCents: num(o.amount_refunded) };
    case "charge.dispute.created":
      return { ...base, kind: "disputed", paymentRef: str(o.payment_intent), amountCents: num(o.amount), disputeStatus: str(o.status) };
    case "charge.dispute.closed":
      return { ...base, kind: "dispute_closed", paymentRef: str(o.payment_intent), amountCents: num(o.amount), disputeStatus: str(o.status) };
    default:
      return base;
  }
}

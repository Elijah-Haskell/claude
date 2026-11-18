// The contract every payment processor adapter meets, plus the webhook signature scheme.
//
// A provider does three things:
//   createCheckout  ask the processor for a hosted payment page for one amount; the client
//                   is sent there and types card details on the processor's page, never ours
//   verifyWebhook   check that an incoming event really came from the processor
//   parseEvent      turn the processor's event into one of a few plain outcomes
//
// Secrets (API keys, webhook signing secrets) come from environment variables only. They
// are never stored in the database, returned by the API, or written to logs.

import { createHmac, timingSafeEqual } from "node:crypto";

export type Account = "operating" | "trust";

export interface CheckoutInput {
  amountCents: number;
  currency: "usd";
  /** Shown to the client on the payment page, e.g. "Invoice 12 — Smith & Co." */
  description: string;
  /** Our own checkout id, sent so the processor's records can be matched to ours. */
  reference: string;
  successUrl: string;
  cancelUrl: string;
  customerEmail?: string | null;
  metadata?: Record<string, string>;
}

export interface CheckoutSession {
  sessionId: string;
  url: string;
  expiresAt?: string | null;
}

export type PayEventKind = "succeeded" | "pending" | "failed" | "expired" | "refunded" | "disputed" | "dispute_closed" | "ignored";

export interface PayEvent {
  id: string;
  /** The processor's own event type, e.g. "checkout.session.completed". */
  type: string;
  kind: PayEventKind;
  sessionId?: string | null;
  paymentRef?: string | null;
  reference?: string | null;
  amountCents?: number | null;
  /** For refunds: the total refunded so far on that payment (cumulative). */
  refundedCents?: number | null;
  disputeStatus?: string | null;
  livemode?: boolean | null;
}

export interface PaymentProvider {
  readonly name: "test" | "stripe";
  readonly account: Account;
  createCheckout(input: CheckoutInput): Promise<CheckoutSession>;
  /** Throws WebhookError when the signature is missing, wrong or too old. */
  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>, nowSeconds?: number): void;
  parseEvent(rawBody: string): PayEvent;
}

export class WebhookError extends Error {
  status = 400;
}

export class ProviderError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

/** Stripe's default tolerance between the signed timestamp and now (docs/payments.md). */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * Stripe-Signature scheme: header "t=<unix seconds>,v1=<hex hmac>[,v1=...][,other=...]".
 * The signed payload is `${t}.${rawBody}`; the signature is HMAC-SHA256 with the endpoint
 * secret. Only v1 entries count (v0 and debug entries are ignored), at least one must
 * match in constant time, and the timestamp must be within the tolerance.
 * The test provider uses the same scheme so both share one verified code path.
 */
export function signPayload(secret: string, rawBody: string, t: number): string {
  return createHmac("sha256", secret).update(`${t}.${rawBody}`, "utf8").digest("hex");
}

export function signatureHeader(secret: string, rawBody: string, t: number): string {
  return `t=${t},v1=${signPayload(secret, rawBody, t)}`;
}

export function verifySignature(
  header: string | string[] | undefined,
  rawBody: string,
  secrets: string[],
  nowSeconds = Math.floor(Date.now() / 1000),
  tolerance = DEFAULT_TOLERANCE_SECONDS,
): void {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw new WebhookError("Missing signature header");
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of value.split(",")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") t = /^\d{1,12}$/.test(v) ? Number(v) : null;
    else if (k === "v1") v1.push(v);
  }
  if (t === null || !v1.length) throw new WebhookError("Signature header is not in the expected form");
  const usable = secrets.filter(Boolean);
  if (!usable.length) throw new WebhookError("No webhook signing secret is configured");
  let match = false;
  for (const s of usable) {
    const expected = Buffer.from(signPayload(s, rawBody, t), "utf8");
    for (const sig of v1) {
      const got = Buffer.from(sig, "utf8");
      if (got.length === expected.length && timingSafeEqual(got, expected)) match = true;
    }
  }
  if (!match) throw new WebhookError("Signature does not match");
  if (tolerance <= 0) throw new WebhookError("Signature tolerance must be positive");
  if (Math.abs(nowSeconds - t) > tolerance) throw new WebhookError("Signature timestamp is outside the allowed window");
}

export function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

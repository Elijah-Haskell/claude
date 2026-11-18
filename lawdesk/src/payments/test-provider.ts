// The "test" provider: a stand-in for a processor so the whole flow works in the demo.
// Its "hosted page" is public/pay-test.html, which shows the amount and two buttons,
// Pay and Decline. It never asks for a card number. Clicking a button produces an event
// shaped like Stripe's, signed the same way, and delivered through the same verified
// webhook path as a real processor's event.

import { randomBytes } from "node:crypto";
import type { DB } from "../db.ts";
import { parseStripeEvent } from "./stripe.ts";
import {
  type Account,
  type CheckoutInput,
  type CheckoutSession,
  type PayEvent,
  type PaymentProvider,
  ProviderError,
  headerValue,
  signatureHeader,
  verifySignature,
} from "./provider.ts";

/** Signing secret for simulated events. Random per process unless set (it never leaves the server). */
const TEST_SECRET = process.env.LAWDESK_TEST_PAY_SECRET || randomBytes(32).toString("hex");

export class TestProvider implements PaymentProvider {
  readonly name = "test" as const;
  readonly account: Account;
  private db: DB;
  private baseUrl: string;
  private secret: string;

  constructor(db: DB, account: Account, baseUrl: string, secret = TEST_SECRET) {
    this.db = db;
    this.account = account;
    this.baseUrl = baseUrl;
    this.secret = secret;
  }

  async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
    const id = "cs_local_" + randomBytes(12).toString("hex");
    this.db
      .prepare(
        `INSERT INTO pay_test_sessions (id, account, amount_cents, description, reference, success_url, cancel_url, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(id, this.account, input.amountCents, input.description, input.reference, input.successUrl, input.cancelUrl, new Date().toISOString());
    return { sessionId: id, url: `${this.baseUrl}/pay-test.html#s=${id}` };
  }

  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>, nowSeconds?: number): void {
    verifySignature(headerValue(headers, "stripe-signature"), rawBody, [this.secret], nowSeconds);
  }

  parseEvent(rawBody: string): PayEvent {
    return parseStripeEvent(rawBody);
  }

  /** Build and sign the event a real processor would send. Returns what the webhook receives. */
  simulate(type: string, object: Record<string, unknown>, nowSeconds = Math.floor(Date.now() / 1000)) {
    const raw = JSON.stringify({ id: "evt_local_" + randomBytes(12).toString("hex"), object: "event", type, livemode: false, created: nowSeconds, data: { object } });
    return { raw, headers: { "stripe-signature": signatureHeader(this.secret, raw, nowSeconds) } };
  }

  session(id: string): Record<string, any> {
    const s = this.db.prepare("SELECT * FROM pay_test_sessions WHERE id = ?").get(id) as Record<string, any> | undefined;
    if (!s) throw new ProviderError("That test payment page does not exist", 404);
    return s;
  }
}

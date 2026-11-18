// The Stripe adapter against recorded-shape responses and signatures computed here.
// No network: fetch is replaced. Keys are fake.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { StripeProvider, formEncode, parseStripeEvent } from "../../src/payments/stripe.ts";
import { WebhookError, signatureHeader, verifySignature } from "../../src/payments/provider.ts";
import { stripeEvent } from "./helpers.ts";

const SECRET = "whsec_test_made_up_secret_for_tests_only";

test("signature: matches an independently computed HMAC-SHA256 of `t.payload`", () => {
  const body = '{\n  "id": "evt_1",\n  "type": "x"\n}';
  const t = 1793600000;
  const hex = createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex");
  assert.equal(signatureHeader(SECRET, body, t), `t=${t},v1=${hex}`);
  verifySignature(`t=${t},v1=${hex}`, body, [SECRET], t + 10);
});

test("signature: ignores v0 and debug entries, accepts any matching v1, any order", () => {
  const body = "{}";
  const t = 1793600000;
  const good = createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex");
  const header = `v0=${good},secret=whsec_****abcd,v1=${"0".repeat(64)},t=${t},v1=${good},destination=we_1,payload=a25aefc6`;
  verifySignature(header, body, [SECRET], t);
  // v0 alone (a sandbox-only scheme) is not enough.
  assert.throws(() => verifySignature(`t=${t},v0=${good}`, body, [SECRET], t), WebhookError);
});

test("signature: rejects a changed body, a wrong secret, an old timestamp, a missing header", () => {
  const body = '{"id":"evt_1"}';
  const t = 1793600000;
  const h = signatureHeader(SECRET, body, t);
  assert.throws(() => verifySignature(h, body + " ", [SECRET], t), /does not match/);
  assert.throws(() => verifySignature(h, body, ["whsec_other"], t), /does not match/);
  assert.throws(() => verifySignature(h, body, [SECRET], t + 301), /outside the allowed window/);
  verifySignature(h, body, [SECRET], t + 300);
  assert.throws(() => verifySignature(h, body, [SECRET], t - 301), /outside/);
  assert.throws(() => verifySignature(undefined, body, [SECRET], t), /Missing/);
  assert.throws(() => verifySignature("garbage", body, [SECRET], t), /expected form/);
  assert.throws(() => verifySignature(h, body, [""], t), /No webhook signing secret/);
});

test("form encoding nests like Stripe's API expects", () => {
  assert.equal(
    formEncode({ mode: "payment", line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: 50000, product_data: { name: "Invoice 1 & co" } } }], skip: undefined }),
    "mode=payment&line_items%5B0%5D%5Bquantity%5D=1&line_items%5B0%5D%5Bprice_data%5D%5Bcurrency%5D=usd&line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=50000&line_items%5B0%5D%5Bprice_data%5D%5Bproduct_data%5D%5Bname%5D=Invoice%201%20%26%20co",
  );
});

function fakeFetch(reply: { status: number; body: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const SESSION = {
  id: "cs_test_a1b2c3",
  object: "checkout.session",
  amount_total: 50000,
  currency: "usd",
  expires_at: 1793686400,
  mode: "payment",
  payment_intent: null,
  payment_status: "unpaid",
  status: "open",
  url: "https://checkout.stripe.com/c/pay/cs_test_a1b2c3#fake",
};

const input = {
  amountCents: 50000,
  currency: "usd" as const,
  description: "Invoice 1, Test Firm",
  reference: "lawdesk-checkout-7",
  successUrl: "https://firm.test/pay.html?t=abc&done=1",
  cancelUrl: "https://firm.test/pay.html?t=abc",
  customerEmail: "client@example.test",
};

test("createCheckout posts a payment-mode Checkout Session with an inline price", async () => {
  const { f, calls } = fakeFetch({ status: 200, body: SESSION });
  const p = new StripeProvider({ secretKey: "sk_test_fake", webhookSecret: SECRET, account: "operating", testMode: true, fetch: f });
  const s = await p.createCheckout(input);
  assert.deepEqual(s, { sessionId: "cs_test_a1b2c3", url: SESSION.url, expiresAt: new Date(1793686400 * 1000).toISOString() });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.stripe.com/v1/checkout/sessions");
  assert.equal(calls[0].init.method, "POST");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer sk_test_fake");
  assert.equal(headers["Content-Type"], "application/x-www-form-urlencoded");
  const form = new URLSearchParams(String(calls[0].init.body));
  assert.equal(form.get("mode"), "payment");
  assert.equal(form.get("line_items[0][price_data][unit_amount]"), "50000");
  assert.equal(form.get("line_items[0][price_data][currency]"), "usd");
  assert.equal(form.get("line_items[0][price_data][product_data][name]"), "Invoice 1, Test Firm");
  assert.equal(form.get("line_items[0][quantity]"), "1");
  assert.equal(form.get("client_reference_id"), "lawdesk-checkout-7");
  assert.equal(form.get("success_url"), input.successUrl);
  assert.equal(form.get("cancel_url"), input.cancelUrl);
  assert.equal(form.get("customer_email"), "client@example.test");
  assert.equal(form.get("metadata[lawdesk_account]"), "operating");
  // Nothing card-related is ever sent from Lawdesk.
  assert.ok(![...form.keys()].some((k) => /card|number|cvc/.test(k)));
});

test("createCheckout refuses unsafe key/mode combinations and tiny amounts, and reports Stripe errors", async () => {
  const { f, calls } = fakeFetch({ status: 400, body: { error: { type: "invalid_request_error", message: "Invalid currency: xyz" } } });
  const live = new StripeProvider({ secretKey: "sk_live_fake", webhookSecret: SECRET, account: "operating", testMode: true, fetch: f });
  await assert.rejects(live.createCheckout(input), /live key/);
  const test = new StripeProvider({ secretKey: "sk_test_fake", webhookSecret: SECRET, account: "operating", testMode: false, fetch: f });
  await assert.rejects(test.createCheckout(input), /test key/);
  const none = new StripeProvider({ secretKey: "", webhookSecret: SECRET, account: "trust", testMode: true, fetch: f });
  await assert.rejects(none.createCheckout(input), /not set up for the trust account/);
  const ok = new StripeProvider({ secretKey: "sk_test_fake", webhookSecret: SECRET, account: "operating", testMode: true, fetch: f });
  await assert.rejects(ok.createCheckout({ ...input, amountCents: 49 }), /minimum/);
  assert.equal(calls.length, 0);
  const err: any = await ok.createCheckout(input).catch((e) => e);
  assert.match(err.message, /Invalid currency: xyz/);
  assert.ok(!err.message.includes("sk_test_fake"));
});

test("verifyWebhook reads the Stripe-Signature header", () => {
  const p = new StripeProvider({ secretKey: "sk_test_fake", webhookSecret: SECRET, account: "operating", testMode: true });
  const raw = stripeEvent("evt_1", "checkout.session.completed", SESSION);
  const t = 1793600000;
  p.verifyWebhook(raw, { "stripe-signature": signatureHeader(SECRET, raw, t) }, t);
  assert.throws(() => p.verifyWebhook(raw, { "stripe-signature": signatureHeader("whsec_wrong", raw, t) }, t), /does not match/);
  const unset = new StripeProvider({ secretKey: "sk_test_fake", webhookSecret: "", account: "operating", testMode: true });
  assert.throws(() => unset.verifyWebhook(raw, { "stripe-signature": signatureHeader(SECRET, raw, t) }, t), /No Stripe webhook signing secret/);
});

test("parseStripeEvent maps the documented event types", () => {
  const paid = { ...SESSION, payment_status: "paid", status: "complete", payment_intent: "pi_123", client_reference_id: "lawdesk-checkout-7" };
  assert.deepEqual(parseStripeEvent(stripeEvent("evt_a", "checkout.session.completed", paid)), {
    id: "evt_a",
    type: "checkout.session.completed",
    kind: "succeeded",
    livemode: false,
    sessionId: "cs_test_a1b2c3",
    paymentRef: "pi_123",
    reference: "lawdesk-checkout-7",
    amountCents: 50000,
  });
  // Bank debits complete the session before the money arrives.
  assert.equal(parseStripeEvent(stripeEvent("evt_b", "checkout.session.completed", { ...paid, payment_status: "unpaid" })).kind, "pending");
  assert.equal(parseStripeEvent(stripeEvent("evt_c", "checkout.session.async_payment_succeeded", paid)).kind, "succeeded");
  assert.equal(parseStripeEvent(stripeEvent("evt_d", "checkout.session.async_payment_failed", paid)).kind, "failed");
  assert.equal(parseStripeEvent(stripeEvent("evt_e", "checkout.session.expired", SESSION)).kind, "expired");
  const charge = { id: "ch_1", object: "charge", amount: 50000, amount_refunded: 20000, refunded: false, payment_intent: "pi_123", currency: "usd" };
  const r = parseStripeEvent(stripeEvent("evt_f", "charge.refunded", charge));
  assert.equal(r.kind, "refunded");
  assert.equal(r.paymentRef, "pi_123");
  assert.equal(r.refundedCents, 20000);
  const dispute = { id: "du_1", object: "dispute", amount: 50000, charge: "ch_1", payment_intent: "pi_123", reason: "fraudulent", status: "needs_response" };
  const d = parseStripeEvent(stripeEvent("evt_g", "charge.dispute.created", dispute));
  assert.equal(d.kind, "disputed");
  assert.equal(d.disputeStatus, "needs_response");
  assert.equal(parseStripeEvent(stripeEvent("evt_h", "charge.dispute.closed", { ...dispute, status: "won" })).kind, "dispute_closed");
  assert.equal(parseStripeEvent(stripeEvent("evt_i", "customer.created", { id: "cus_1" })).kind, "ignored");
  assert.throws(() => parseStripeEvent("not json"), WebhookError);
  assert.throws(() => parseStripeEvent('{"hello":1}'), WebhookError);
});

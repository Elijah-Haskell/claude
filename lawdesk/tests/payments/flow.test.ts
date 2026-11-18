// End-to-end payment flows through the service: links, the simulated hosted page,
// webhooks (idempotency, refunds, disputes), the trust separation, and Stripe with a fake fetch.

import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE, setup, stripeEvent, tokenOf } from "./helpers.ts";
import { activity } from "../billing/helpers.ts";
import { StripeProvider } from "../../src/payments/stripe.ts";
import { TestProvider } from "../../src/payments/test-provider.ts";
import { signatureHeader } from "../../src/payments/provider.ts";

const pending = (db: any) => db.prepare("SELECT * FROM pay_attention WHERE resolved_at IS NULL ORDER BY id").all() as any[];

test("invoice link: client pays on the test page; billing records an operating payment", async () => {
  const c = setup();
  const { url, link } = c.pay.createInvoiceLink(c.invoiceId, {}, c.atty, BASE);
  assert.match(url, /^http:\/\/lawdesk\.test\/pay\.html\?t=[A-Za-z0-9_-]{32}$/);
  assert.equal(link.account, "operating");
  assert.equal(link.amount_cents, 50000);
  // Only the hash of the token is stored.
  const token = tokenOf(url);
  assert.equal(JSON.stringify(c.db.prepare("SELECT * FROM pay_links").all()).includes(token), false);

  const view = c.pay.publicLink(token);
  assert.equal(view.amountCents, 50000);
  assert.equal(view.status, "active");
  assert.equal(view.firmName, "Test Firm");
  assert.equal((view as any).client, undefined);

  const { url: page } = await c.pay.startCheckout(token, BASE);
  const sid = /#s=(cs_local_[0-9a-f]+)$/.exec(page)![1];
  assert.equal(c.pay.testSession(sid).amountCents, 50000);
  const done = c.pay.completeTestSession(sid, "pay");
  assert.equal(done.outcome, "recorded");
  assert.equal(done.redirect, `${BASE}/pay.html?t=${token}&done=1`);

  assert.equal(c.b.balance(c.invoiceId), 0);
  const [p] = c.b.listPayments({ clientId: c.acme });
  assert.equal(p.amount_cents, 50000);
  assert.equal(p.method, "Card (online)");
  assert.match(p.reference, /^pi_local_/);
  assert.equal(c.pay.publicLink(token).status, "paid");
  await assert.rejects(c.pay.startCheckout(token, BASE), /already been paid/);
  assert.throws(() => c.pay.completeTestSession(sid, "pay"), /already been used/);
  assert.ok(activity(c.db, "payment_link_created").length === 1);
  assert.ok(activity(c.db, "payment_received").length === 1);
});

test("a re-delivered event is applied once", async () => {
  const c = setup();
  const { url } = c.pay.createInvoiceLink(c.invoiceId, { amountCents: 20000 }, c.atty, BASE);
  const { url: page } = await c.pay.startCheckout(tokenOf(url), BASE);
  const sid = page.split("#s=")[1];
  const provider = new TestProvider(c.db, "operating", BASE);
  c.db.prepare("UPDATE pay_test_sessions SET status = 'paid' WHERE id = ?").run(sid);
  const sim = provider.simulate("checkout.session.completed", { id: sid, object: "checkout.session", amount_total: 20000, payment_intent: "pi_x", payment_status: "paid" });
  const first = c.pay.handleWebhook(provider, sim.raw, sim.headers);
  const again = c.pay.handleWebhook(provider, sim.raw, sim.headers);
  assert.deepEqual([first.duplicate, again.duplicate], [false, true]);
  // A different event for the same session (e.g. async success after completed) is also a no-op.
  const other = provider.simulate("checkout.session.async_payment_succeeded", { id: sid, object: "checkout.session", amount_total: 20000, payment_intent: "pi_x" });
  assert.equal(c.pay.handleWebhook(provider, other.raw, other.headers).outcome, "already_recorded");
  assert.equal(c.b.listPayments({ clientId: c.acme }).length, 1);
  assert.equal(c.b.balance(c.invoiceId), 30000);
  assert.equal(c.pay.publicLink(tokenOf(url)).status, "active");
  assert.equal(c.db.prepare("SELECT COUNT(*) AS n FROM pay_events").get()!.n, 2);
});

test("a forged or stale webhook is refused and changes nothing", async () => {
  const c = setup();
  const { url } = c.pay.createInvoiceLink(c.invoiceId, {}, c.atty, BASE);
  const { url: page } = await c.pay.startCheckout(tokenOf(url), BASE);
  const sid = page.split("#s=")[1];
  const provider = new TestProvider(c.db, "operating", BASE, "secret-a");
  const raw = stripeEvent("evt_forged", "checkout.session.completed", { id: sid, amount_total: 50000, payment_status: "paid" });
  const t = Math.floor(Date.now() / 1000);
  assert.throws(() => c.pay.handleWebhook(provider, raw, { "stripe-signature": signatureHeader("secret-b", raw, t) }), /does not match/);
  assert.throws(() => c.pay.handleWebhook(provider, raw, { "stripe-signature": signatureHeader("secret-a", raw, t - 3600) }), /outside/);
  assert.throws(() => c.pay.handleWebhook(provider, raw, {}), /Missing/);
  assert.equal(c.b.balance(c.invoiceId), 50000);
  assert.equal(c.db.prepare("SELECT COUNT(*) AS n FROM pay_events").get()!.n, 0);
});

test("declined payment, full refund reverses billing, partial refund and dispute need a person", async () => {
  const c = setup();
  const { url } = c.pay.createInvoiceLink(c.invoiceId, {}, c.atty, BASE);
  const token = tokenOf(url);
  let page = (await c.pay.startCheckout(token, BASE)).url;
  assert.equal(c.pay.completeTestSession(page.split("#s=")[1], "decline").outcome, "failed");
  assert.equal(c.b.balance(c.invoiceId), 50000);
  assert.equal(c.pay.publicLink(token).lastPayment, "failed");

  page = (await c.pay.startCheckout(token, BASE)).url;
  c.pay.completeTestSession(page.split("#s=")[1], "pay");
  const co = c.db.prepare("SELECT * FROM pay_checkouts WHERE status = 'succeeded'").get() as any;
  assert.equal(c.pay.simulateTestEvent(co.id, "refund", 10000).outcome, "refund_flagged");
  assert.match(pending(c.db).at(-1).message, /\$100\.00 of the online payment .* was refunded\. Record the partial refund in billing/);
  assert.equal(c.b.balance(c.invoiceId), 0);
  assert.equal(c.pay.simulateTestEvent(co.id, "dispute").outcome, "dispute_flagged");
  assert.match(pending(c.db).at(-1).message, /disputed/);
  assert.equal(c.pay.simulateTestEvent(co.id, "refund", 40000).outcome, "refund_reversed");
  assert.equal(c.b.balance(c.invoiceId), 50000);
  assert.ok(c.b.payment(co.billing_payment_id).voided_on);

  const att = pending(c.db);
  assert.equal(att.length, 3);
  c.pay.resolveAttention(att[0].id, "Entered credit note", c.atty);
  assert.equal(pending(c.db).length, 2);
  assert.throws(() => c.pay.resolveAttention(att[0].id, "", c.atty), /Already/);
});

test("money for an invoice voided after the link went out stays operating client credit", async () => {
  const c = setup();
  const { url } = c.pay.createInvoiceLink(c.invoiceId, {}, c.atty, BASE);
  const page = (await c.pay.startCheckout(tokenOf(url), BASE)).url;
  c.b.void(c.invoiceId, "Billed to wrong matter", c.atty);
  assert.equal(c.pay.completeTestSession(page.split("#s=")[1], "pay").outcome, "recorded");
  assert.equal(c.b.clientCredit(c.acme), 50000);
  assert.match(pending(c.db)[0].message, /held as client credit/);
  assert.equal(c.db.prepare("SELECT COUNT(*) AS n FROM pay_trust_receipts").get()!.n, 0);
});

test("links: amount limits, cancel, expiry, a new link replaces the old one, bad tokens", async () => {
  const c = setup();
  assert.throws(() => c.pay.createInvoiceLink(c.invoiceId, { amountCents: 50001 }, c.atty, BASE), /more than/);
  assert.throws(() => c.pay.createInvoiceLink(c.invoiceId, { amountCents: 1.5 }, c.atty, BASE), /whole number/);
  const a = c.pay.createInvoiceLink(c.invoiceId, {}, c.atty, BASE);
  const b = c.pay.createInvoiceLink(c.invoiceId, {}, c.atty, BASE);
  assert.equal(c.pay.publicLink(tokenOf(a.url)).status, "cancelled");
  c.pay.cancelLink(b.link.id, c.atty);
  await assert.rejects(c.pay.startCheckout(tokenOf(b.url), BASE), /no longer active/);
  const d = c.pay.createInvoiceLink(c.invoiceId, {}, c.atty, BASE);
  c.setClock("2026-12-03T15:00:01Z"); // 30 days + 1 second
  assert.equal(c.pay.publicLink(tokenOf(d.url)).status, "expired");
  await assert.rejects(c.pay.startCheckout(tokenOf(d.url), BASE), /expired/);
  assert.throws(() => c.pay.publicLink("short"), /not valid/);
  assert.throws(() => c.pay.publicLink("A".repeat(32)), /not valid/);
  const draft = c.b.createDraft({ matterId: c.m2 });
  assert.throws(() => c.pay.createInvoiceLink(draft.id, {}, c.atty, BASE), /Only a finalized invoice/);
  c.pay.updateSettings({ provider: "off" }, c.atty);
  assert.throws(() => c.pay.createInvoiceLink(c.invoiceId, {}, c.atty, BASE), /turned off/);
  assert.throws(() => c.pay.updateSettings({ provider: "test", testMode: false }, c.atty), /only works in test mode/);
});

test("trust deposits are off by default and never touch billing when on", async () => {
  const c = setup();
  assert.equal(c.pay.trustEnabled(), false);
  assert.throws(() => c.pay.createTrustLink({ matterId: c.m1, amountCents: 250000 }, c.atty, BASE), /can't be taken online yet/);
  // A processor alone is not enough; the firm must also confirm fees go to operating.
  const on = setup({ env: { LAWDESK_TEST_TRUST_PROCESSOR: "1" } });
  assert.equal(on.pay.trustEnabled(), false);
  on.pay.updateSettings({ trustFeesConfirmed: true }, on.atty);
  assert.equal(on.pay.trustEnabled(), true);
  const { url, link } = on.pay.createTrustLink({ matterId: on.m1, amountCents: 250000 }, on.atty, BASE);
  assert.equal(link.account, "trust");
  assert.equal(link.invoice_id, null);
  const page = (await on.pay.startCheckout(tokenOf(url), BASE)).url;
  assert.equal(on.pay.completeTestSession(page.split("#s=")[1], "pay").outcome, "trust_receipt_held");
  const [r] = on.pay.trustReceipts();
  assert.equal(r.amount_cents, 250000);
  assert.equal(r.status, "awaiting_trust_entry");
  assert.equal(on.b.listPayments().length, 0); // nothing in operating
  assert.equal(on.b.clientCredit(on.acme), 0);
  assert.match(pending(on.db)[0].message, /Enter it in the trust ledger/);
  // An operating-account event cannot touch a trust checkout.
  const co = on.db.prepare("SELECT * FROM pay_checkouts").get() as any;
  const op = new TestProvider(on.db, "operating", BASE);
  const sim = op.simulate("charge.refunded", { amount: 250000, amount_refunded: 250000, payment_intent: co.payment_ref });
  assert.equal(on.pay.handleWebhook(op, sim.raw, sim.headers).outcome, "unmatched");
  // Disputes on trust money warn that the chargeback must not come out of trust.
  assert.match(String(on.pay.simulateTestEvent(co.id, "dispute").outcome), /dispute_flagged/);
  assert.match(pending(on.db).at(-1).message, /operating account, not trust/);
});

test("Stripe end to end with a fake API and a computed signature", async () => {
  const SECRET = "whsec_made_up_for_tests";
  const calls: any[] = [];
  const fakeFetch = (async (url: string, init: any) => {
    calls.push({ url, body: String(init.body) });
    return new Response(JSON.stringify({ id: "cs_test_e2e", object: "checkout.session", url: "https://checkout.stripe.com/c/pay/cs_test_e2e", expires_at: 1793686400 }), { status: 200 });
  }) as unknown as typeof fetch;
  const env = { STRIPE_SECRET_KEY: "sk_test_fake_key_value", STRIPE_WEBHOOK_SECRET: SECRET };
  const c = setup({ env, fetch: fakeFetch });
  c.pay.updateSettings({ provider: "stripe" }, c.atty);
  const s = c.pay.settings(BASE);
  assert.equal(s.stripe.operatingKey, true);
  assert.equal(s.stripe.operatingKeyMode, "test");
  assert.equal(s.webhookUrls.operating, `${BASE}/api/pay/webhooks/stripe`);
  // No secret ever comes back from the API.
  assert.ok(!JSON.stringify(s).includes("sk_test_fake_key_value") && !JSON.stringify(s).includes(SECRET));

  const { url } = c.pay.createInvoiceLink(c.invoiceId, {}, c.atty, BASE);
  const out = await c.pay.startCheckout(tokenOf(url), BASE);
  assert.equal(out.url, "https://checkout.stripe.com/c/pay/cs_test_e2e");
  const co = c.db.prepare("SELECT * FROM pay_checkouts").get() as any;
  assert.match(calls[0].body, new RegExp(`client_reference_id=lawdesk-checkout-${co.id}`));

  const provider = c.pay.provider("operating", BASE);
  assert.ok(provider instanceof StripeProvider);
  const raw = stripeEvent("evt_e2e", "checkout.session.completed", {
    id: "cs_test_e2e",
    object: "checkout.session",
    amount_total: 50000,
    payment_status: "paid",
    status: "complete",
    payment_intent: "pi_e2e",
    client_reference_id: `lawdesk-checkout-${co.id}`,
  });
  const t = Math.floor(Date.now() / 1000);
  assert.equal(c.pay.handleWebhook(provider, raw, { "stripe-signature": signatureHeader(SECRET, raw, t) }).outcome, "recorded");
  assert.equal(c.b.balance(c.invoiceId), 0);
  const refund = stripeEvent("evt_ref", "charge.refunded", { id: "ch_1", object: "charge", amount: 50000, amount_refunded: 50000, refunded: true, payment_intent: "pi_e2e" });
  assert.equal(c.pay.handleWebhook(provider, refund, { "stripe-signature": signatureHeader(SECRET, refund, t) }).outcome, "refund_reversed");
  assert.equal(c.b.balance(c.invoiceId), 50000);
  const unknown = stripeEvent("evt_other", "charge.refunded", { amount: 100, amount_refunded: 100, payment_intent: "pi_nope" });
  assert.equal(c.pay.handleWebhook(provider, unknown, { "stripe-signature": signatureHeader(SECRET, unknown, t) }).outcome, "unmatched");
});

test("matter overview lists finalized invoices with their balance and active link", () => {
  const c = setup();
  c.pay.createInvoiceLink(c.invoiceId, {}, c.atty, BASE);
  const o = c.pay.matterOverview(c.m1);
  assert.equal(o.invoices.length, 1);
  assert.equal(o.invoices[0].balance_cents, 50000);
  assert.ok(o.invoices[0].activeLink);
  assert.equal(o.trustEnabled, false);
  assert.equal(o.provider, "test");
});

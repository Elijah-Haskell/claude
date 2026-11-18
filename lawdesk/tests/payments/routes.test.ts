// The payment routes over real HTTP: the webhook signature is checked against the raw
// request body exactly as sent, and only client/processor routes are public.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { routes, configurePayments } from "../../src/payments/routes.ts";
import { openDb } from "../../src/db.ts";
import { createServer } from "../../src/server.ts";
import { Billing } from "../../src/billing/billing.ts";
import { Engine } from "../../src/engine.ts";
import { signatureHeader } from "../../src/payments/provider.ts";
import { stripeEvent } from "./helpers.ts";

test("only client pages and webhooks are public; every route is under /pay", () => {
  const pub = routes.filter((r) => r.public).map((r) => `${r.method} ${r.path}`);
  assert.deepEqual(pub, [
    "GET /pay/public/links/:token",
    "POST /pay/public/links/:token/checkout",
    "GET /pay/public/test-checkout/:id",
    "POST /pay/public/test-checkout/:id",
    "POST /pay/webhooks/stripe",
    "POST /pay/webhooks/stripe-trust",
  ]);
  for (const r of routes) assert.ok(r.path.startsWith("/pay/"));
  for (const r of routes.filter((r) => !r.public)) assert.ok(!r.path.startsWith("/pay/public/") && !r.path.startsWith("/pay/webhooks/"));
  assert.equal(new Set(routes.map((r) => `${r.method} ${r.path}`)).size, routes.length);
});

test("over HTTP: link, test checkout, signed Stripe webhook verified on the raw body", async () => {
  const SECRET = "whsec_http_test_only";
  const db = openDb();
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ id: "cs_test_http", url: "https://checkout.stripe.com/c/pay/cs_test_http" }), { status: 200 })) as unknown as typeof fetch;
  configurePayments(db, { env: { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: SECRET }, fetch: fakeFetch });
  const server = createServer(db, { today: () => "2026-11-02", log: () => {} });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const engine = new Engine(db, { today: () => "2026-11-02" });
    const b = new Billing(db, { today: () => "2026-11-02" });
    const user = engine.addUser("A", "attorney");
    const client = engine.addContact("Client (demo)");
    const m = engine.createMatter({ name: "M", clientId: client });
    b.addExpense({ matterId: m, costCents: 12345, description: "Fee" });
    const inv = b.finalize(b.createDraft({ matterId: m }).id);
    const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await fetch(base + "/api" + path, {
        method,
        headers: { "Content-Type": "application/json", "X-Lawdesk-User": String(user), ...headers },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      });
      return { status: res.status, data: await res.json() };
    };
    const made = await call("POST", `/pay/invoices/${inv.id}/links`, {});
    assert.equal(made.status, 200);
    assert.ok(made.data.url.startsWith(base + "/pay.html?t="));
    const token = new URL(made.data.url).searchParams.get("t");
    const pub = await fetch(`${base}/api/pay/public/links/${token}`).then((r) => r.json());
    assert.equal(pub.amountCents, 12345);

    // Switch to Stripe (fake API) and pay through a signed webhook with pretty-printed JSON:
    // re-serialising the parsed body would break the signature, so this proves the raw body is used.
    assert.equal((await call("PATCH", "/pay/settings", { provider: "stripe" })).status, 200);
    const start = await call("POST", `/pay/public/links/${token}/checkout`);
    assert.equal(start.data.url, "https://checkout.stripe.com/c/pay/cs_test_http");
    const raw = stripeEvent("evt_http", "checkout.session.completed", { id: "cs_test_http", object: "checkout.session", amount_total: 12345, payment_status: "paid", payment_intent: "pi_http" });
    const t = Math.floor(Date.now() / 1000);
    const bad = await call("POST", "/pay/webhooks/stripe", raw, { "Stripe-Signature": signatureHeader("whsec_wrong", raw, t) });
    assert.equal(bad.status, 400);
    const ok = await call("POST", "/pay/webhooks/stripe", raw, { "Stripe-Signature": signatureHeader(SECRET, raw, t) });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.outcome, "recorded");
    const again = await call("POST", "/pay/webhooks/stripe", raw, { "Stripe-Signature": signatureHeader(SECRET, raw, t) });
    assert.equal(again.data.duplicate, true);
    assert.equal(b.balance(inv.id), 0);
    // The trust endpoint has no secret configured, so it refuses.
    const trust = await call("POST", "/pay/webhooks/stripe-trust", raw, { "Stripe-Signature": signatureHeader(SECRET, raw, t) });
    assert.equal(trust.status, 400);
    const settings = await call("GET", "/pay/settings");
    assert.ok(!JSON.stringify(settings.data).includes("sk_test_x"));
    assert.ok(!JSON.stringify(settings.data).includes(SECRET));
  } finally {
    server.close();
  }
});

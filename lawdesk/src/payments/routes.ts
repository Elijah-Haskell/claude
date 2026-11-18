// API routes for online payments, under /api/pay.
//
// Routes marked `public: true` are used by clients and by the processor, who are not
// signed in. They are protected instead by an unguessable link token (client pages) or by
// the processor's webhook signature (webhooks). The sign-in module must let them through
// without a session; until it supports the flag, it must allow-list paths under
// /api/pay/public/ and /api/pay/webhooks/ (see docs/payments.md).

import type { DB } from "../db.ts";
import { EngineError } from "../engine.ts";
import { type Ctx, type Route, intParam } from "../http.ts";
import { Payments, type PaymentsOptions } from "./payments.ts";
import { ProviderError } from "./provider.ts";

export type PublicRoute = Route & { public?: boolean };

const instances = new WeakMap<DB, Partial<PaymentsOptions>>();

/** Tests can inject options (env, fetch, clock) per database. */
export function configurePayments(db: DB, opts: Partial<PaymentsOptions>) {
  instances.set(db, opts);
}

export function paymentsFor(ctx: Pick<Ctx, "db" | "engine">): Payments {
  return new Payments(ctx.db, { engine: ctx.engine, ...(instances.get(ctx.db) ?? {}) });
}

const HOST_RE = /^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[[0-9a-fA-F:]+\](:\d{1,5})?$/;

/**
 * The address clients reach Lawdesk at, for links and processor return pages.
 * LAWDESK_PUBLIC_URL (e.g. https://office.examplefirm.com) wins; otherwise the request's
 * Host header, which is only right on the firm's own machine.
 */
export function publicBaseUrl(ctx: Pick<Ctx, "req">, env: Record<string, string | undefined> = process.env): string {
  const set = env.LAWDESK_PUBLIC_URL;
  if (set && /^https?:\/\/[^/\s]+$/i.test(set.replace(/\/+$/, ""))) return set.replace(/\/+$/, "");
  const host = ctx.req?.headers?.host;
  if (typeof host === "string" && HOST_RE.test(host)) return `http://${host}`;
  return "http://localhost:3000";
}

function body(ctx: Ctx): Record<string, any> {
  return ctx.body && typeof ctx.body === "object" ? ctx.body : {};
}

async function viaProvider<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    // A processor problem is shown to the person (424) rather than as a server fault.
    if (err instanceof ProviderError) throw new EngineError(err.message, err.status < 500 ? err.status : 424);
    throw err;
  }
}

function webhook(account: "operating" | "trust") {
  return (ctx: Ctx) => {
    const p = paymentsFor(ctx);
    const provider = p.provider(account, publicBaseUrl(ctx), "stripe");
    return p.handleWebhook(provider, ctx.rawBody ?? "", (ctx.req?.headers ?? {}) as Record<string, string>);
  };
}

export const routes: PublicRoute[] = [
  // ------------------------------------------------------------ staff
  { method: "GET", path: "/pay/settings", handler: (ctx) => paymentsFor(ctx).settings(publicBaseUrl(ctx)) },
  { method: "PATCH", path: "/pay/settings", handler: (ctx) => paymentsFor(ctx).updateSettings(body(ctx), ctx.userId) },
  { method: "GET", path: "/pay/matters/:id", handler: (ctx) => paymentsFor(ctx).matterOverview(intParam(ctx, "id")) },
  { method: "GET", path: "/pay/invoices/:id/links", handler: (ctx) => paymentsFor(ctx).invoiceLinks(intParam(ctx, "id")) },
  {
    method: "POST",
    path: "/pay/invoices/:id/links",
    handler: (ctx) => paymentsFor(ctx).createInvoiceLink(intParam(ctx, "id"), { amountCents: body(ctx).amountCents ?? null }, ctx.userId, publicBaseUrl(ctx)),
  },
  {
    method: "POST",
    path: "/pay/trust-links",
    handler: (ctx) => {
      const b = body(ctx);
      return paymentsFor(ctx).createTrustLink({ matterId: b.matterId, amountCents: b.amountCents, description: b.description }, ctx.userId, publicBaseUrl(ctx));
    },
  },
  { method: "POST", path: "/pay/links/:id/cancel", handler: (ctx) => paymentsFor(ctx).cancelLink(intParam(ctx, "id"), ctx.userId) },
  { method: "GET", path: "/pay/attention", handler: (ctx) => paymentsFor(ctx).attention({ includeResolved: ctx.query.get("all") === "1" }) },
  { method: "POST", path: "/pay/attention/:id/done", handler: (ctx) => paymentsFor(ctx).resolveAttention(intParam(ctx, "id"), body(ctx).resolution, ctx.userId) },
  { method: "GET", path: "/pay/trust-receipts", handler: (ctx) => paymentsFor(ctx).trustReceipts() },
  {
    method: "POST",
    path: "/pay/test/checkouts/:id/simulate",
    handler: (ctx) => paymentsFor(ctx).simulateTestEvent(intParam(ctx, "id"), body(ctx).kind, body(ctx).amountCents),
  },

  // ------------------------------------------------- public: the client
  { method: "GET", path: "/pay/public/links/:token", public: true, handler: (ctx) => paymentsFor(ctx).publicLink(ctx.params.token) },
  {
    method: "POST",
    path: "/pay/public/links/:token/checkout",
    public: true,
    handler: (ctx) => viaProvider(() => paymentsFor(ctx).startCheckout(ctx.params.token, publicBaseUrl(ctx))),
  },
  // The test provider's simulated hosted page.
  { method: "GET", path: "/pay/public/test-checkout/:id", public: true, handler: (ctx) => viaProvider(() => paymentsFor(ctx).testSession(ctx.params.id)) },
  {
    method: "POST",
    path: "/pay/public/test-checkout/:id",
    public: true,
    handler: (ctx) => viaProvider(() => paymentsFor(ctx).completeTestSession(ctx.params.id, body(ctx).outcome)),
  },

  // ------------------------------------------- public: processor webhooks
  { method: "POST", path: "/pay/webhooks/stripe", public: true, csrf: false, handler: webhook("operating") },
  { method: "POST", path: "/pay/webhooks/stripe-trust", public: true, csrf: false, handler: webhook("trust") },
];

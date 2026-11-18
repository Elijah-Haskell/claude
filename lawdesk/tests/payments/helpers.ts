// Fixtures for the payment tests. Everything is made up; keys are fake test-shaped strings.

import { setup as billingSetup } from "../billing/helpers.ts";
import { Payments, type PaymentsOptions } from "../../src/payments/payments.ts";

export const BASE = "http://lawdesk.test";

/** A firm with one finalized $500 invoice on the Acme lease matter. */
export function setup(opts: Partial<PaymentsOptions> = {}) {
  const ctx = billingSetup();
  let clock = new Date("2026-11-02T15:00:00Z");
  ctx.b.addExpense({ matterId: ctx.m1, costCents: 50000, description: "Filing fee", date: "2026-11-01" });
  const draft = ctx.b.createDraft({ matterId: ctx.m1 });
  const inv = ctx.b.finalize(draft.id);
  const pay = new Payments(ctx.db, { engine: ctx.engine, today: () => "2026-11-02", now: () => clock, env: {}, ...opts });
  return { ...ctx, pay, invoiceId: inv.id as number, setClock: (iso: string) => (clock = new Date(iso)), clock: () => clock };
}

export function tokenOf(url: string): string {
  return new URL(url).searchParams.get("t")!;
}

/** Recorded-shape Stripe objects (fields as documented; values made up). */
export function stripeEvent(id: string, type: string, object: Record<string, unknown>) {
  return JSON.stringify({ id, object: "event", api_version: "2026-10-28", created: 1793600000, livemode: false, type, data: { object } }, null, 2);
}

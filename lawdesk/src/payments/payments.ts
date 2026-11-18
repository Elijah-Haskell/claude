// Online payments: payment links for invoices (operating money) and, kept separate and off
// by default, retainer/trust deposit links (trust money). See docs/payments.md for the
// legal reasoning and the processor documentation this follows.
//
// Flow:
//   1. Staff create a link for an invoice. Lawdesk shows the URL once (only its hash is stored).
//   2. The client opens /pay.html?t=<token>, sees the amount, clicks "Pay".
//   3. Lawdesk asks the processor for a hosted checkout page and sends the client there.
//      Card details are typed on the processor's page; they never touch Lawdesk.
//   4. The processor sends a signed webhook. Lawdesk verifies it, records the event id
//      (so a repeat is ignored) and records the payment in billing (operating account).
//   Refunds and disputes are recorded and put on a "needs attention" list; a full refund
//   voids the billing payment, anything else waits for a person.

import { createHash, randomBytes } from "node:crypto";
import { type DB, tx } from "../db.ts";
import { type Engine, EngineError } from "../engine.ts";
import { Billing } from "../billing/billing.ts";
import { formatCents } from "../billing/money.ts";
import type { ISODate } from "../dates.ts";
import { type Account, type PayEvent, type PaymentProvider, ProviderError, WebhookError } from "./provider.ts";
import { StripeProvider, stripeEnv } from "./stripe.ts";
import { TestProvider } from "./test-provider.ts";
import { SCHEMA } from "./schema.ts";

type Row = Record<string, any>;
type Env = Record<string, string | undefined>;

export interface PaymentsOptions {
  engine: Engine;
  today?: () => ISODate;
  now?: () => Date;
  env?: Env;
  fetch?: typeof fetch;
  /** Replace the provider (tests). */
  providerFor?: (account: Account, baseUrl: string) => PaymentProvider;
}

function bad(message: string, status = 400): never {
  throw new EngineError(message, status);
}

export const hashToken = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
const TOKEN_RE = /^[A-Za-z0-9_-]{20,100}$/;

export class Payments {
  readonly db: DB;
  private engine: Engine;
  private todayFn: () => ISODate;
  private nowFn: () => Date;
  private env: Env;
  private fetchFn?: typeof fetch;
  private override?: (account: Account, baseUrl: string) => PaymentProvider;

  constructor(db: DB, opts: PaymentsOptions) {
    this.db = db;
    db.exec(SCHEMA);
    this.engine = opts.engine;
    this.todayFn = opts.today ?? (() => opts.engine.today());
    this.nowFn = opts.now ?? (() => new Date());
    this.env = opts.env ?? process.env;
    this.fetchFn = opts.fetch;
    this.override = opts.providerFor;
  }

  private one(sql: string, ...p: any[]): Row | undefined {
    return this.db.prepare(sql).get(...p) as Row | undefined;
  }
  private all(sql: string, ...p: any[]): Row[] {
    return this.db.prepare(sql).all(...p) as Row[];
  }
  private run(sql: string, ...p: any[]): number {
    return Number(this.db.prepare(sql).run(...p).lastInsertRowid);
  }
  private nowIso() {
    return this.nowFn().toISOString();
  }
  billing(): Billing {
    return new Billing(this.db, { today: this.todayFn, now: this.nowFn });
  }

  // ---------------------------------------------------------------- settings

  private settingsRow(): Row {
    return this.one("SELECT * FROM pay_settings WHERE id = 1")!;
  }

  /** Whether a separate trust-account processor account is configured (keys present). Values are never returned. */
  private trustProcessorConfigured(provider: string): boolean {
    if (provider === "stripe") {
      const t = stripeEnv("trust", this.env);
      return Boolean(t.secretKey && t.webhookSecret);
    }
    if (provider === "test") return this.env.LAWDESK_TEST_TRUST_PROCESSOR === "1";
    return false;
  }

  /** Settings plus what is configured in the environment, as yes/no only. Never a key or secret. */
  settings(baseUrl?: string): Row {
    const s = this.settingsRow();
    const op = stripeEnv("operating", this.env);
    const tr = stripeEnv("trust", this.env);
    const mode = (k: string) => (!k ? null : /^(sk|rk)_live_/.test(k) ? "live" : /^(sk|rk)_test_/.test(k) ? "test" : "unknown");
    const trustConfigured = this.trustProcessorConfigured(s.provider);
    return {
      provider: s.provider,
      testMode: Boolean(s.test_mode),
      linkDays: s.link_days,
      trustFeesConfirmed: Boolean(s.trust_fees_confirmed),
      updatedAt: s.updated_at,
      stripe: {
        operatingKey: Boolean(op.secretKey),
        operatingKeyMode: mode(op.secretKey),
        operatingWebhookSecret: Boolean(op.webhookSecret),
        trustKey: Boolean(tr.secretKey),
        trustKeyMode: mode(tr.secretKey),
        trustWebhookSecret: Boolean(tr.webhookSecret),
      },
      trust: {
        processorConfigured: trustConfigured,
        enabled: this.trustEnabled(),
        note:
          "Retainers and other unearned money belong in the trust account. Trust deposit links stay off until a separate processor account that pays out to the trust account is set up, and the firm confirms that processing fees and chargebacks are charged to the operating account, never to trust. Deposits are then held for entry in the trust ledger (trust accounting module).",
      },
      webhookUrls: baseUrl ? { operating: `${baseUrl}/api/pay/webhooks/stripe`, trust: `${baseUrl}/api/pay/webhooks/stripe-trust` } : null,
      publicUrl: this.env.LAWDESK_PUBLIC_URL || null,
    };
  }

  updateSettings(patch: Record<string, unknown>, actor: number | null): Row {
    const s = this.settingsRow();
    let provider = s.provider;
    let testMode = s.test_mode;
    let linkDays = s.link_days;
    let feesConfirmed = s.trust_fees_confirmed;
    const changes: string[] = [];
    if (patch.provider !== undefined) {
      if (!["off", "test", "stripe"].includes(patch.provider as string)) bad("Provider must be off, test or stripe");
      provider = patch.provider;
      changes.push(`provider ${provider}`);
    }
    if (patch.testMode !== undefined) {
      if (typeof patch.testMode !== "boolean") bad("testMode must be true or false");
      testMode = patch.testMode ? 1 : 0;
      changes.push(`test mode ${testMode ? "on" : "off"}`);
    }
    if (patch.linkDays !== undefined) {
      const n = patch.linkDays as number;
      if (!Number.isInteger(n) || n < 1 || n > 180) bad("Links can last from 1 to 180 days");
      linkDays = n;
      changes.push(`links last ${n} days`);
    }
    if (patch.trustFeesConfirmed !== undefined) {
      if (typeof patch.trustFeesConfirmed !== "boolean") bad("trustFeesConfirmed must be true or false");
      feesConfirmed = patch.trustFeesConfirmed ? 1 : 0;
      changes.push(feesConfirmed ? "confirmed trust processor charges fees and chargebacks to operating" : "withdrew trust fee confirmation");
    }
    if (provider === "test" && !testMode) bad("The test provider only works in test mode");
    this.run(
      "UPDATE pay_settings SET provider = ?, test_mode = ?, link_days = ?, trust_fees_confirmed = ?, updated_at = ?, updated_by = ? WHERE id = 1",
      provider,
      testMode,
      linkDays,
      feesConfirmed,
      this.nowIso(),
      actor,
    );
    if (changes.length) this.engine.log("payments_settings", `Online payments: ${changes.join(", ")}`, { userId: actor });
    return this.settings();
  }

  trustEnabled(): boolean {
    const s = this.settingsRow();
    return s.provider !== "off" && Boolean(s.trust_fees_confirmed) && this.trustProcessorConfigured(s.provider);
  }

  provider(account: Account, baseUrl: string, name?: string): PaymentProvider {
    if (this.override) return this.override(account, baseUrl);
    const s = this.settingsRow();
    const which = name ?? s.provider;
    if (which === "test") return new TestProvider(this.db, account, baseUrl);
    if (which === "stripe") {
      const e = stripeEnv(account, this.env);
      return new StripeProvider({ ...e, account, testMode: Boolean(s.test_mode), fetch: this.fetchFn });
    }
    bad("Online payments are turned off (Settings, Online payments)", 409);
  }

  // ------------------------------------------------------------------- links

  private newToken() {
    const token = randomBytes(24).toString("base64url");
    return { token, hash: hashToken(token) };
  }

  private expiry(): string {
    return new Date(this.nowFn().getTime() + this.settingsRow().link_days * 86_400_000).toISOString();
  }

  private linkUrl(baseUrl: string, token: string) {
    return `${baseUrl}/pay.html?t=${token}`;
  }

  /** A link to pay a finalized invoice. Money goes to the operating account. Older active links for it are cancelled. */
  createInvoiceLink(invoiceId: number, input: { amountCents?: number | null }, actor: number | null, baseUrl: string) {
    if (this.settingsRow().provider === "off") bad("Online payments are turned off (Settings, Online payments)", 409);
    return tx(this.db, () => {
      const inv = this.billing().invoice(invoiceId);
      if (inv.status !== "final") bad(`Only a finalized invoice can be paid online; this one is ${inv.status === "draft" ? "a draft" : "void"}`, 409);
      const bal = inv.balance_cents;
      if (bal <= 0) bad(`Invoice ${inv.number} is already paid`, 409);
      let amount = bal;
      if (input.amountCents != null) {
        if (!Number.isSafeInteger(input.amountCents) || input.amountCents < 1) bad("Amount must be a whole number of cents");
        if (input.amountCents > bal) bad(`${formatCents(input.amountCents)} is more than the ${formatCents(bal)} owed`);
        amount = input.amountCents;
      }
      const old = this.all("SELECT id FROM pay_links WHERE invoice_id = ? AND status = 'active'", invoiceId);
      for (const o of old) this.run("UPDATE pay_links SET status = 'cancelled', cancelled_at = ? WHERE id = ?", this.nowIso(), o.id);
      const firm = this.billing().settings().firm_name;
      const { token, hash } = this.newToken();
      const id = this.run(
        `INSERT INTO pay_links (token_hash, kind, account, invoice_id, matter_id, client_id, amount_cents, description, expires_at, created_at, created_by)
         VALUES (?, 'invoice', 'operating', ?, ?, ?, ?, ?, ?, ?, ?)`,
        hash,
        invoiceId,
        inv.matter_id,
        inv.client_id,
        amount,
        firm ? `Invoice ${inv.number} from ${firm}` : `Invoice ${inv.number}`,
        this.expiry(),
        this.nowIso(),
        actor,
      );
      this.engine.log("payment_link_created", `Created an online payment link for invoice ${inv.number} (${formatCents(amount)})${old.length ? "; the earlier link no longer works" : ""}`, {
        userId: actor,
        matterId: inv.matter_id,
      });
      return { url: this.linkUrl(baseUrl, token), link: this.linkRow(id), client: inv.client };
    });
  }

  /** A retainer / trust deposit link. Refused unless a trust processor account is configured and confirmed. */
  createTrustLink(input: { matterId: number; amountCents: number; description?: string | null }, actor: number | null, baseUrl: string) {
    if (!this.trustEnabled()) {
      bad(
        "Trust deposits can't be taken online yet. They need a separate processor account that pays into the trust account and charges its fees and chargebacks to operating (Settings, Online payments). Until then, take retainers by check or wire into trust.",
        409,
      );
    }
    return tx(this.db, () => {
      const m = this.one("SELECT * FROM matters WHERE id = ?", input.matterId);
      if (!m) bad("Matter not found", 404);
      if (!m.client_id) bad("The matter has no client");
      if (!Number.isSafeInteger(input.amountCents) || input.amountCents < 1) bad("Amount must be a whole number of cents");
      const firm = this.billing().settings().firm_name;
      const desc = (typeof input.description === "string" && input.description.trim()) || (firm ? `Retainer deposit to trust with ${firm}` : "Retainer deposit to trust");
      const { token, hash } = this.newToken();
      const id = this.run(
        `INSERT INTO pay_links (token_hash, kind, account, invoice_id, matter_id, client_id, amount_cents, description, expires_at, created_at, created_by)
         VALUES (?, 'trust_deposit', 'trust', NULL, ?, ?, ?, ?, ?, ?, ?)`,
        hash,
        m.id,
        m.client_id,
        input.amountCents,
        desc.slice(0, 200),
        this.expiry(),
        this.nowIso(),
        actor,
      );
      this.engine.log("payment_link_created", `Created a trust deposit link for ${formatCents(input.amountCents)}`, { userId: actor, matterId: m.id });
      return { url: this.linkUrl(baseUrl, token), link: this.linkRow(id) };
    });
  }

  private linkRow(id: number): Row {
    const l = this.one("SELECT * FROM pay_links WHERE id = ?", id);
    if (!l) bad("Payment link not found", 404);
    const { token_hash, ...rest } = l;
    const expired = l.status === "active" && l.expires_at <= this.nowIso();
    return { ...rest, status: expired ? "expired" : l.status, checkouts: this.all("SELECT id, provider, amount_cents, status, created_at, completed_at, refunded_cents FROM pay_checkouts WHERE link_id = ? ORDER BY id", id) };
  }

  cancelLink(id: number, actor: number | null) {
    const l = this.linkRow(id);
    if (l.status !== "active") bad("That link is not active", 409);
    this.run("UPDATE pay_links SET status = 'cancelled', cancelled_at = ? WHERE id = ?", this.nowIso(), id);
    this.engine.log("payment_link_cancelled", `Cancelled the online payment link "${l.description}"`, { userId: actor, matterId: l.matter_id });
    return this.linkRow(id);
  }

  invoiceLinks(invoiceId: number) {
    return this.all("SELECT id FROM pay_links WHERE invoice_id = ? ORDER BY id DESC", invoiceId).map((r) => this.linkRow(r.id));
  }

  /** Everything payment-related on a matter, for the matter screen. */
  matterOverview(matterId: number) {
    if (!this.one("SELECT 1 FROM matters WHERE id = ?", matterId)) bad("Matter not found", 404);
    const b = this.billing();
    const invoices = this.all("SELECT id FROM billing_invoices WHERE matter_id = ? AND status = 'final' ORDER BY number", matterId).map((r) => {
      const inv = b.invoice(r.id);
      const active = this.one("SELECT id FROM pay_links WHERE invoice_id = ? AND status = 'active' AND expires_at > ? ORDER BY id DESC", r.id, this.nowIso());
      return { id: inv.id, number: inv.number, issued_on: inv.issued_on, due_on: inv.due_on, total_cents: inv.total_cents, balance_cents: inv.balance_cents, activeLink: active ? this.linkRow(active.id) : null };
    });
    const links = this.all("SELECT id FROM pay_links WHERE matter_id = ? ORDER BY id DESC LIMIT 50", matterId).map((r) => this.linkRow(r.id));
    const s = this.settingsRow();
    return { provider: s.provider, testMode: Boolean(s.test_mode), trustEnabled: this.trustEnabled(), invoices, links, attention: this.attention({ matterId }) };
  }

  // ------------------------------------------------------- the client's side

  private linkByToken(token: string): Row {
    if (typeof token !== "string" || !TOKEN_RE.test(token)) bad("This payment link is not valid", 404);
    const l = this.one("SELECT * FROM pay_links WHERE token_hash = ?", hashToken(token));
    if (!l) bad("This payment link is not valid", 404);
    return l;
  }

  /** What the client sees on the payment page. Nothing beyond the firm, the description and the amount. */
  publicLink(token: string) {
    const l = this.linkByToken(token);
    const row = this.linkRow(l.id);
    let due = l.amount_cents;
    if (l.kind === "invoice") {
      const bal = this.billing().balance(l.invoice_id);
      due = Math.min(l.amount_cents, Math.max(bal, 0));
    }
    const last = this.one("SELECT status FROM pay_checkouts WHERE link_id = ? ORDER BY id DESC LIMIT 1", l.id);
    const status = row.status === "active" && l.kind === "invoice" && due <= 0 ? "paid" : row.status;
    const s = this.settingsRow();
    return {
      firmName: this.billing().settings().firm_name || "Your law firm",
      description: l.description,
      kind: l.kind,
      // Once paid, show what the link was for rather than the $0.00 now owed.
      amountCents: status === "paid" ? l.amount_cents : due,
      status,
      expiresAt: l.expires_at,
      lastPayment: last?.status ?? null,
      testMode: Boolean(s.test_mode),
      provider: s.provider,
    };
  }

  /** Start a hosted checkout for the link and return the processor page to send the client to. */
  async startCheckout(token: string, baseUrl: string) {
    const l = this.linkByToken(token);
    const view = this.publicLink(token);
    if (view.status === "paid") bad("This has already been paid. Thank you.", 409);
    if (view.status !== "active") bad(view.status === "expired" ? "This payment link has expired. Please ask the firm for a new one." : "This payment link is no longer active.", 409);
    if (l.kind === "trust_deposit" && !this.trustEnabled()) bad("Trust deposits can't be taken online right now. Please contact the firm.", 409);
    if (l.kind === "invoice") {
      const inv = this.one("SELECT status FROM billing_invoices WHERE id = ?", l.invoice_id);
      if (inv?.status !== "final") bad("This invoice can no longer be paid online. Please contact the firm.", 409);
    }
    const account: Account = l.account;
    const provider = this.provider(account, baseUrl);
    const placeholder = "pending_" + randomBytes(8).toString("hex");
    const checkoutId = this.run(
      "INSERT INTO pay_checkouts (link_id, provider, account, session_id, amount_cents, created_at) VALUES (?,?,?,?,?,?)",
      l.id,
      provider.name,
      account,
      placeholder,
      view.amountCents,
      this.nowIso(),
    );
    const client = this.one("SELECT email FROM contacts WHERE id = ?", l.client_id);
    let session;
    try {
      session = await provider.createCheckout({
        amountCents: view.amountCents,
        currency: "usd",
        description: l.description,
        reference: `lawdesk-checkout-${checkoutId}`,
        successUrl: `${this.linkUrl(baseUrl, token)}&done=1`,
        cancelUrl: this.linkUrl(baseUrl, token),
        customerEmail: client?.email ?? null,
      });
    } catch (err) {
      this.run("UPDATE pay_checkouts SET status = 'failed', completed_at = ? WHERE id = ?", this.nowIso(), checkoutId);
      throw err;
    }
    this.run("UPDATE pay_checkouts SET session_id = ? WHERE id = ?", session.sessionId, checkoutId);
    return { url: session.url };
  }

  // ---------------------------------------------------------------- webhooks

  /**
   * Verify and apply one processor event. Safe to call any number of times with the same
   * event: the (provider, account, event id) is stored and a repeat changes nothing.
   */
  handleWebhook(provider: PaymentProvider, rawBody: string, headers: Record<string, string | string[] | undefined>, nowSeconds?: number) {
    provider.verifyWebhook(rawBody, headers, nowSeconds);
    const ev = provider.parseEvent(rawBody);
    return tx(this.db, () => {
      const seen = this.one("SELECT outcome FROM pay_events WHERE provider = ? AND account = ? AND event_id = ?", provider.name, provider.account, ev.id);
      if (seen) return { received: true, duplicate: true, outcome: seen.outcome };
      const { outcome, checkoutId } = this.apply(provider, ev);
      this.run(
        "INSERT INTO pay_events (provider, account, event_id, type, received_at, outcome, checkout_id) VALUES (?,?,?,?,?,?,?)",
        provider.name,
        provider.account,
        ev.id,
        ev.type,
        this.nowIso(),
        outcome,
        checkoutId,
      );
      return { received: true, duplicate: false, outcome };
    });
  }

  private flag(checkoutId: number | null, kind: string, message: string, amount: number | null, matterId: number | null) {
    this.run("INSERT INTO pay_attention (checkout_id, kind, message, amount_cents, created_at) VALUES (?,?,?,?,?)", checkoutId, kind, message, amount, this.nowIso());
    this.engine.log("payment_attention", message, { matterId });
  }

  private apply(provider: PaymentProvider, ev: PayEvent): { outcome: string; checkoutId: number | null } {
    if (ev.kind === "ignored") return { outcome: "ignored", checkoutId: null };
    let co: Row | undefined;
    if (ev.sessionId) co = this.one("SELECT * FROM pay_checkouts WHERE provider = ? AND account = ? AND session_id = ?", provider.name, provider.account, ev.sessionId);
    else if (ev.paymentRef) co = this.one("SELECT * FROM pay_checkouts WHERE provider = ? AND account = ? AND payment_ref = ?", provider.name, provider.account, ev.paymentRef);
    if (!co) {
      if (ev.kind === "succeeded" || ev.kind === "refunded" || ev.kind === "disputed") {
        this.flag(null, "unmatched", `A ${provider.name} ${ev.type} event (${ev.id}) did not match any Lawdesk payment; check the processor's dashboard`, ev.amountCents ?? null, null);
      }
      return { outcome: "unmatched", checkoutId: null };
    }
    const link = this.one("SELECT * FROM pay_links WHERE id = ?", co.link_id)!;
    const now = this.nowIso();
    switch (ev.kind) {
      case "pending":
        if (co.status === "open") this.run("UPDATE pay_checkouts SET status = 'pending', payment_ref = COALESCE(?, payment_ref) WHERE id = ?", ev.paymentRef ?? null, co.id);
        return { outcome: "pending", checkoutId: co.id };
      case "failed":
        if (co.status !== "succeeded") this.run("UPDATE pay_checkouts SET status = 'failed', completed_at = ? WHERE id = ?", now, co.id);
        this.engine.log("payment_failed", `Online payment of ${formatCents(co.amount_cents)} for "${link.description}" did not go through`, { matterId: link.matter_id });
        return { outcome: "failed", checkoutId: co.id };
      case "expired":
        if (co.status === "open") this.run("UPDATE pay_checkouts SET status = 'expired', completed_at = ? WHERE id = ?", now, co.id);
        return { outcome: "expired", checkoutId: co.id };
      case "succeeded":
        return { outcome: this.succeeded(co, link, ev), checkoutId: co.id };
      case "refunded":
        return { outcome: this.refunded(co, link, ev), checkoutId: co.id };
      case "disputed": {
        const amt = ev.amountCents ?? co.amount_cents;
        const where = link.account === "trust" ? " The processor must take any chargeback from the operating account, not trust; check that it did." : "";
        this.flag(co.id, "dispute", `The client disputed the online payment of ${formatCents(amt)} for "${link.description}" with their card issuer.${where} Respond in the processor's dashboard.`, amt, link.matter_id);
        return { outcome: "dispute_flagged", checkoutId: co.id };
      }
      case "dispute_closed":
        this.flag(co.id, "dispute", `The card dispute over "${link.description}" is closed (${ev.disputeStatus ?? "unknown outcome"}). Update billing if money was lost.`, ev.amountCents ?? null, link.matter_id);
        return { outcome: "dispute_closed", checkoutId: co.id };
    }
    return { outcome: "ignored", checkoutId: co.id };
  }

  private succeeded(co: Row, link: Row, ev: PayEvent): string {
    if (co.status === "succeeded") return "already_recorded";
    const amount = ev.amountCents && ev.amountCents > 0 ? ev.amountCents : co.amount_cents;
    const now = this.nowIso();
    this.run("UPDATE pay_checkouts SET status = 'succeeded', completed_at = ?, payment_ref = COALESCE(?, payment_ref), amount_cents = ? WHERE id = ?", now, ev.paymentRef ?? null, amount, co.id);
    const ref = ev.paymentRef ?? co.session_id;
    if (link.kind === "trust_deposit") {
      // Never into billing (operating). Held for the trust ledger.
      this.run(
        "INSERT INTO pay_trust_receipts (checkout_id, client_id, matter_id, amount_cents, received_at) VALUES (?,?,?,?,?)",
        co.id,
        link.client_id,
        link.matter_id,
        amount,
        now,
      );
      this.run("UPDATE pay_links SET status = 'paid' WHERE id = ?", link.id);
      this.flag(co.id, "trust_receipt", `Received ${formatCents(amount)} online for trust ("${link.description}"). Enter it in the trust ledger.`, amount, link.matter_id);
      return "trust_receipt_held";
    }
    const b = this.billing();
    const note = `Paid online (${co.provider}${co.provider === "test" ? ", test mode" : ""}), payment link ${link.id}`;
    // Checked first (not try/catch): billing joins this transaction, so a half-done payInvoice would not roll back.
    const inv = this.one("SELECT status, number FROM billing_invoices WHERE id = ?", link.invoice_id);
    let payment: Row;
    if (inv?.status === "final") {
      payment = b.payInvoice(link.invoice_id, { amountCents: amount, method: "Card (online)", reference: ref, note }, null);
      if (payment.unapplied_cents > 0)
        this.flag(co.id, "unapplied", `${formatCents(payment.unapplied_cents)} of an online payment was more than the balance of invoice ${inv.number} and is held as client credit.`, payment.unapplied_cents, link.matter_id);
    } else {
      // The invoice was voided after the link went out: keep the money as client credit (still operating).
      payment = b.recordPayment({ clientId: link.client_id, matterId: link.matter_id, amountCents: amount, method: "Card (online)", reference: ref, note }, null);
      this.flag(co.id, "unapplied", `An online payment of ${formatCents(amount)} arrived for "${link.description}" but that invoice is ${inv?.status ?? "missing"}. It is held as client credit; apply or refund it.`, amount, link.matter_id);
    }
    this.run("UPDATE pay_checkouts SET billing_payment_id = ? WHERE id = ?", payment.id, co.id);
    if (b.balance(link.invoice_id) <= 0) this.run("UPDATE pay_links SET status = 'paid' WHERE id = ?", link.id);
    return "recorded";
  }

  private refunded(co: Row, link: Row, ev: PayEvent): string {
    const total = ev.refundedCents ?? 0;
    const delta = total - co.refunded_cents;
    if (delta <= 0) return "refund_already_recorded";
    this.run("UPDATE pay_checkouts SET refunded_cents = ? WHERE id = ?", total, co.id);
    if (link.kind === "invoice" && co.billing_payment_id && total >= co.amount_cents) {
      const p = this.one("SELECT voided_on FROM billing_payments WHERE id = ?", co.billing_payment_id);
      if (p && !p.voided_on) {
        this.billing().voidPayment(co.billing_payment_id, `Refunded in full through ${co.provider}`, null);
        this.flag(co.id, "refund", `The online payment of ${formatCents(co.amount_cents)} for "${link.description}" was refunded in full; the payment was reversed in billing.`, delta, link.matter_id);
        return "refund_reversed";
      }
    }
    const where = link.kind === "trust_deposit" ? "Record the refund in the trust ledger." : "Record the partial refund in billing.";
    this.flag(co.id, "refund", `${formatCents(delta)} of the online payment for "${link.description}" was refunded. ${where}`, delta, link.matter_id);
    return "refund_flagged";
  }

  // --------------------------------------------------------------- attention

  attention(f: { matterId?: number; includeResolved?: boolean } = {}) {
    const where: string[] = [];
    const p: any[] = [];
    if (!f.includeResolved) where.push("a.resolved_at IS NULL");
    if (f.matterId) (where.push("l.matter_id = ?"), p.push(f.matterId));
    return this.all(
      `SELECT a.*, l.matter_id, l.description AS link_description FROM pay_attention a
       LEFT JOIN pay_checkouts c ON c.id = a.checkout_id LEFT JOIN pay_links l ON l.id = c.link_id
       ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY a.id DESC LIMIT 200`,
      ...p,
    );
  }

  resolveAttention(id: number, resolution: unknown, actor: number | null) {
    const a = this.one("SELECT * FROM pay_attention WHERE id = ?", id);
    if (!a) bad("Not found", 404);
    if (a.resolved_at) bad("Already marked done", 409);
    const why = typeof resolution === "string" ? resolution.trim().slice(0, 500) : "";
    this.run("UPDATE pay_attention SET resolved_at = ?, resolved_by = ?, resolution = ? WHERE id = ?", this.nowIso(), actor, why || null, id);
    const co = a.checkout_id ? this.one("SELECT l.matter_id FROM pay_checkouts c JOIN pay_links l ON l.id = c.link_id WHERE c.id = ?", a.checkout_id) : null;
    this.engine.log("payment_attention_done", `Marked done: ${a.message}${why ? ` (${why})` : ""}`, { userId: actor, matterId: co?.matter_id ?? null });
    return { ok: true };
  }

  trustReceipts() {
    return this.all("SELECT * FROM pay_trust_receipts ORDER BY id DESC");
  }

  // ------------------------------------------------------ test provider only

  testSession(id: string) {
    const p = this.provider("operating", "", "test") as TestProvider;
    const s = p.session(id);
    return { id: s.id, amountCents: s.amount_cents, description: s.description, status: s.status, account: s.account, cancelUrl: s.cancel_url, successUrl: s.success_url };
  }

  /** The Pay / Decline buttons on the simulated hosted page. */
  completeTestSession(id: string, outcome: unknown) {
    if (this.settingsRow().provider !== "test") bad("The test payment page only works with the test provider", 409);
    if (outcome !== "pay" && outcome !== "decline") bad("outcome must be pay or decline");
    const t0 = new TestProvider(this.db, "operating", "");
    const s = t0.session(id);
    if (s.status !== "open") bad("This test payment page has already been used", 409);
    const provider = new TestProvider(this.db, s.account, "");
    const pi = "pi_local_" + randomBytes(10).toString("hex");
    this.run("UPDATE pay_test_sessions SET status = ?, payment_ref = ? WHERE id = ?", outcome === "pay" ? "paid" : "declined", pi, id);
    const object = { id: s.id, object: "checkout.session", amount_total: s.amount_cents, client_reference_id: s.reference, payment_intent: pi, payment_status: outcome === "pay" ? "paid" : "unpaid" };
    const sim = outcome === "pay" ? provider.simulate("checkout.session.completed", object) : provider.simulate("checkout.session.async_payment_failed", object);
    const result = this.handleWebhook(provider, sim.raw, sim.headers);
    return { ...result, redirect: outcome === "pay" ? s.success_url : s.cancel_url };
  }

  /** Staff-only demo helper: pretend the processor refunded or the client disputed a test payment. */
  simulateTestEvent(checkoutId: number, kind: unknown, amountCents?: number) {
    if (this.settingsRow().provider !== "test") bad("Only available with the test provider", 409);
    const co = this.one("SELECT * FROM pay_checkouts WHERE id = ? AND provider = 'test'", checkoutId);
    if (!co || co.status !== "succeeded") bad("No successful test payment with that id", 404);
    const provider = new TestProvider(this.db, co.account, "");
    let sim;
    if (kind === "refund") {
      const amt = amountCents ?? co.amount_cents;
      sim = provider.simulate("charge.refunded", { id: "ch_local", object: "charge", amount: co.amount_cents, amount_refunded: Math.min(co.amount_cents, co.refunded_cents + amt), payment_intent: co.payment_ref });
    } else if (kind === "dispute") {
      sim = provider.simulate("charge.dispute.created", { id: "du_local", object: "dispute", amount: co.amount_cents, payment_intent: co.payment_ref, status: "needs_response" });
    } else bad("kind must be refund or dispute");
    return this.handleWebhook(provider, sim.raw, sim.headers);
  }
}

export { ProviderError, WebhookError };

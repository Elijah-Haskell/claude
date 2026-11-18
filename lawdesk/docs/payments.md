# Online payments

Clients pay an invoice by card from a private link. Lawdesk never sees or stores card numbers:
the client types card details only on the processor's hosted page (Stripe Checkout, or the
built-in test page in demo mode), and Lawdesk learns the outcome from a signed webhook.

This is software documentation, not legal advice. The firm should confirm the trust-account
points below with its own reading of the Kansas rules and, if in doubt, the Disciplinary
Administrator or the KBA ethics hotline.

## What it does

- **Invoice links (operating account).** On a finalized invoice, staff click *Pay online*, pick the
  amount (default: the balance), and get a private link to copy or email. The client opens it, sees
  the firm, the invoice number and the amount, and is sent to the processor's page. When the
  processor reports success, the payment is recorded in billing against that invoice as method
  "Card (online)". Making a new link for an invoice turns off the old one.
- **Trust deposit links (trust account).** A separate link type for retainers and other unearned
  money. It is **off** unless a separate processor account that pays out to the trust account is
  configured *and* the firm confirms (Settings > Online payments) that processing fees and
  chargebacks are charged to the operating account. Trust money is never recorded in billing; each
  receipt is held as "awaiting trust entry" for the trust accounting module.
- **Needs attention.** Anything that cannot be applied safely is flagged on the matter instead of
  being guessed at: a payment for an invoice that was voided meanwhile (held as client credit),
  partial refunds, disputes (chargebacks), and webhook events that match no link.
- **Full refunds** reported by the processor reverse the billing payment automatically.

## Design

| Piece | File |
| --- | --- |
| Provider interface, signature helpers | `src/payments/provider.ts` |
| Stripe adapter (REST via `fetch`, no SDK) | `src/payments/stripe.ts` |
| Test provider (simulated hosted page) | `src/payments/test-provider.ts`, `public/pay-test.html` |
| Links, checkouts, webhooks, billing hand-off | `src/payments/payments.ts` |
| Tables | `src/payments/schema.ts` |
| Routes | `src/payments/routes.ts` |
| Client page | `public/pay.html`, `public/js/public/pay.js` |
| Staff screens | `public/js/views/pay-esign.js` (matter card, invoice dialog, settings) |

- A provider does three things: `createCheckout` (returns the hosted page URL), `verifyWebhook`
  (checks the signature on the raw body) and `parseEvent` (maps to succeeded, pending, failed,
  expired, refunded, disputed, dispute_closed or ignored).
- **Operating and trust stay apart everywhere:** a schema CHECK ties invoice links to `operating`
  and trust links to `trust` with no invoice; each account has its own webhook endpoint and
  secret; checkouts are matched to events only within the same provider and account.
- **Idempotent webhooks:** every processed event id is stored in `pay_events`
  (unique per provider, account and event id). A repeated delivery returns 200 and changes
  nothing. A second success event for a checkout that is already recorded is also a no-op.
- **Tokens:** link tokens are random (24 bytes, base64url); only their SHA-256 is stored. Links
  expire (default 30 days, set in Settings).
- **Secrets** come only from environment variables. The API reports only whether each key is set
  and whether it is a test or live key, never the value. Error messages from Stripe are passed on
  truncated and never include the key. A live key is refused while test mode is on, and a test
  key while it is off.
- Money is in integer cents throughout. Everything is logged with `engine.log(...)`.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `STRIPE_SECRET_KEY` | Operating-account Stripe secret key (`sk_test_…` or `sk_live_…`) |
| `STRIPE_WEBHOOK_SECRET` | Signing secret (`whsec_…`) for the operating webhook endpoint |
| `STRIPE_TRUST_SECRET_KEY` | Secret key of the **separate** Stripe account that pays out to trust |
| `STRIPE_TRUST_WEBHOOK_SECRET` | Signing secret for the trust webhook endpoint |
| `LAWDESK_PUBLIC_URL` | The address clients reach Lawdesk at (e.g. `https://pay.examplefirm.com`). Used for links and processor redirects. Without it, the request's Host header is used, which is fine locally but should be set in production. |
| `LAWDESK_TEST_PAY_SECRET` | Optional fixed signing secret for the test provider (random per process otherwise) |
| `LAWDESK_TEST_TRUST_PROCESSOR=1` | Demo only: pretend a trust processor account exists for the test provider |

Webhook endpoints to register in the Stripe dashboard (shown in Settings > Online payments):
`<public url>/api/pay/webhooks/stripe` and, for the trust account, `<public url>/api/pay/webhooks/stripe-trust`.
Events to send: `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
`checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`,
`charge.dispute.created`, `charge.dispute.closed`.

### Routes that must be public

These are reached by clients or by the processor, who have no Lawdesk sign-in. Each is marked
`public: true` in `src/payments/routes.ts`; the sign-in module must let them through. They are
protected by the unguessable link token or by the webhook signature.

- `GET /api/pay/public/links/:token`, `POST /api/pay/public/links/:token/checkout`
- `GET|POST /api/pay/public/test-checkout/:id` (test provider only; refused unless it is active)
- `POST /api/pay/webhooks/stripe`, `POST /api/pay/webhooks/stripe-trust`

Webhook verification needs the exact bytes Stripe sent, so `src/server.ts` now keeps the raw body
and passes it to handlers as `ctx.rawBody`.

## Stripe API: what was used and where it is documented

Read in November 2026.

- Create a Checkout Session: `POST https://api.stripe.com/v1/checkout/sessions`, form-encoded, with
  `mode=payment`, `line_items[0][price_data][currency]`, `[unit_amount]` (integer cents),
  `[product_data][name]`, `line_items[0][quantity]`, `success_url`, `cancel_url`,
  `client_reference_id`, `customer_email`, `metadata[...]`. The response's `url` is the hosted
  page and `id` the session id.
  <https://docs.stripe.com/api/checkout/sessions/create>
- Session object (`payment_status` is `paid`, `unpaid` or `no_payment_required`; `payment_intent`;
  `client_reference_id`; `amount_total`): <https://docs.stripe.com/api/checkout/sessions/object>
- Fulfilment: handle `checkout.session.completed` and, for delayed payment methods,
  `checkout.session.async_payment_succeeded` / `_failed`; only fulfil when `payment_status` is
  `paid`: <https://docs.stripe.com/checkout/fulfillment>
- Event types (`charge.refunded` carries a Charge; `charge.dispute.*` carries a Dispute):
  <https://docs.stripe.com/api/events/types>
- Charge object (`amount`, `amount_refunded`, `payment_intent`): <https://docs.stripe.com/api/charges/object>
- Dispute object (`amount`, `charge`, `payment_intent`, `status`): <https://docs.stripe.com/api/disputes/object>
- Verifying signatures manually: the `Stripe-Signature` header has `t=<unix time>` and one or more
  `v1=<hex>`; the signed payload is `<t>.<raw body>`; compute HMAC-SHA256 with the endpoint's
  signing secret, compare in constant time against each `v1`, and reject timestamps outside a
  tolerance (Stripe's libraries default to 5 minutes). `v0` entries are ignored.
  <https://docs.stripe.com/webhooks> (section "Verify signatures manually"),
  <https://docs.stripe.com/events/manage-webhook-endpoints>
- Stripe may deliver an event more than once, so handlers should record event ids:
  <https://docs.stripe.com/webhooks> ("Handle duplicate events").
- The smallest US-dollar charge is $0.50 (`STRIPE_MIN_CENTS`): <https://docs.stripe.com/currencies>

The adapter is tested against fake `fetch` responses and against signatures computed with
`node:crypto` (`tests/payments/stripe.test.ts`). **It has not been run against Stripe's live test
mode**; do that once with real test keys (`sk_test_…`) and the Stripe CLI before going live.

## Card payments and the trust account (Kansas)

### Sources

1. **Kansas Rules of Professional Conduct 1.15 (Supreme Court Rule 240), Safekeeping Property.**
   <https://16jd.kscourts.gov/Rules-Orders/Rules/1-15-Client-Lawyer-Relationship-Safekeeping-Proper>,
   PDF: <https://11jd.kscourts.gov/KSCourts/media/KsCourts/Rules/RULE-1-15.pdf?ext=.pdf>
   - (d)(1): "All funds of clients paid to a lawyer or law firm, including advances for costs and
     expenses, shall be deposited in one or more identifiable accounts maintained in the State of
     Kansas … and no funds belonging to the lawyer or law firm shall be deposited therein except as
     follows: (i) Funds reasonably sufficient to pay bank charges may be deposited therein. (ii)
     Funds belonging in part to a client and in part presently or potentially to the lawyer or law
     firm must be deposited therein, but the portion belonging to the lawyer or law firm may be
     withdrawn when due unless the right of the lawyer or law firm to receive it is disputed by the
     client …"
   - (d)(2)(i): the lawyer shall "Promptly notify a client of the receipt of the client's funds …"
   - The rule does not mention credit cards or electronic payments.
2. **ABA Model Rule 1.15(b) and (c).** (b): "A lawyer may deposit the lawyer's own funds in a
   client trust account for the sole purpose of paying bank service charges on that account, but
   only in an amount necessary for that purpose." (c): "A lawyer shall deposit into a client trust
   account legal fees and expenses that have been paid in advance, to be withdrawn by the lawyer
   only as fees are earned or expenses incurred." The ABA's own page
   (<https://www.americanbar.org/groups/professional_responsibility/publications/model_rules_of_professional_conduct/rule_1_15_safekeeping_property.html>)
   could not be fetched; the wording above was read from a reproduction
   (<https://law.uh.edu/faculty/adjunct/dstevenson/2019/15.pdf>) and should be checked against the ABA text.
3. **ABA Formal Opinion 00-419 (July 7, 2000)**, "Use of Credit Cards for Payment of Legal Fees",
   withdrew Formal Opinions 320 and 338 and Informal Opinions 1120 and 1176: lawyers may accept
   credit cards without advance bar approval, subject only to the general rule that advertising not
   be false or misleading. The summaries read (<https://ezel.ai/ethics-opinions/aba/00-419-credit-card-payment-of-legal-fees>)
   say nothing about trust accounts, processing fees or chargebacks; the full opinion was not read.
4. **Illustration from another state (not Kansas law):** Patrick R. Burns, Minnesota Office of
   Lawyers Professional Responsibility, "Clients & Credit Cards", *Minnesota Lawyer*, Dec. 3, 2007
   (<https://lprb.mncourts.gov/articles/Articles/Clients%20and%20Credit%20Cards.pdf>): advance fees
   paid by card are unearned and belong in trust; the lawyer "may not deduct any credit card fees
   from those funds"; merchant agreements that let the processor pull chargebacks and fees from the
   deposit account are a problem for a trust account.
5. **Secondary source:** LeanLaw, Kansas IOLTA guide
   (<https://www.leanlaw.co/blog/kansas-iolta-trust-accounting-compliance-guide-for-small-and-mid-sized-law-firms/>)
   says "Kansas ethics guidance generally expects lawyers to ensure that credit card or electronic
   payment fees are not taken from client money", and suggests having fees pulled from operating. It
   cites no specific Kansas opinion for that point.
6. **Not read:** the Kansas Disciplinary Administrator's *Trust Account Handbook* (rev. 04-2025,
   <https://kscourts.gov/KSCourts/media/KsCourts/Attorney%20Discipline/Trust-Account-Handbook-Rev-04-2025.pdf>)
   could not be downloaded from this environment (HTTP 403). **The firm should read it** before
   turning on trust deposit links; it is the most likely place for Kansas-specific guidance on card
   payments.

### What follows for the software

- Paying a finalized invoice is paying earned fees, so it goes to **operating**. That is the only
  thing invoice links do.
- A retainer or advance fee is client money until earned (KRPC 1.15(d)(1); Model Rule 1.15(c)), so
  it must reach the **trust** account. A processor normally deducts its fee from the deposit and
  can claw back chargebacks from the account it pays into. If that account were trust, client
  money would pay the firm's processing costs, and the firm could not keep anything beyond "funds
  reasonably sufficient to pay bank charges" there to cover it. So the trust link type:
  - requires a **separate** processor account (separate keys and webhook) that pays out to trust;
  - requires the firm to confirm that fees and chargebacks are billed to operating
    (with Stripe, typically by having fees debited separately rather than netted, which must be
    arranged with Stripe; this was not verified here);
  - is off by default and never touches billing; each deposit is listed for entry in the trust ledger.
- Disputes on trust deposits are flagged with a warning that the chargeback must not come out of
  other clients' money in trust.

## Gaps

- Partial refunds and disputes are flagged for a person to handle, not applied automatically.
- Trust receipts are held for the trust accounting module; nothing posts to a trust ledger yet.
- The Stripe adapter has not been exercised against Stripe itself (see above).
- No email is sent: staff copy the link or use the *Email* button (opens their mail program).
- No surcharging: the client pays the invoice amount. Card-network and state surcharge rules were
  not researched.
- The sign-in module must honour `public: true` on the routes listed above.

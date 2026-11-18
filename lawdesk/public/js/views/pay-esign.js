// Staff screens for online payments and electronic signatures.
//
// Reusable pieces for other screens:
//   payOnlineButton(invoice, { onDone })          "Pay online" for a finalized invoice
//   sendForSignatureButton(doc, { matter, onDone }) "Send for signature" for a document
//   matterPaymentsCard(matterId) / matterSignaturesCard(matter)   cards for the matter page
//   paymentSettingsSection() / esignSettingsSection()             Settings sections
// All text goes in through dom.js helpers (textContent), never innerHTML.

import { h, select, modal, toast, fmtTime } from "../dom.js";
import { get, post, patch } from "../api.js";
import { card, field, button, pill, callout, emptyState, loadingBlock } from "../ui/components.js";
import { icon } from "../ui/icons.js";

export const money = (c) => "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function toCents(text) {
  const s = String(text).replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [d, c = ""] = s.split(".");
  return Number(d) * 100 + Number((c + "00").slice(0, 2));
}

const fail = (err) => toast(err.message, { error: true });

/** The link, with Copy and Email buttons. */
function shareBox(url, { subject, body, email }) {
  const input = h("input.share-url", { value: url, readonly: true, "aria-label": "Link", onfocus: (e) => e.target.select() });
  const mailto = `mailto:${encodeURIComponent(email || "")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(`${body}\n\n${url}\n`)}`;
  return h(
    "div.share-box",
    h("div.share-url-row", icon("lock", { size: 15, class: "share-lock" }), input),
    h(
      "div.share-actions",
      button("Copy link", {
        variant: "primary",
        icon: "copy",
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(url);
            toast("Link copied");
          } catch {
            input.select();
            toast("Press Ctrl+C (or ⌘C) to copy the selected link");
          }
        },
      }),
      button("Email to client", { href: mailto, icon: "mail" }),
    ),
  );
}

/** A card the matter page places once; later draws swap its contents in place. */
function liveCard(opts) {
  const el = card(opts);
  el.put = (next) => {
    const fresh = card({ ...opts, ...next });
    el.className = fresh.className;
    el.replaceChildren(...fresh.childNodes);
  };
  return el;
}

// ------------------------------------------------------------------ payments

export function payOnlineButton(invoice, { onDone } = {}) {
  return button("Pay online", { size: "sm", icon: "wallet", class: "pay-online", onclick: () => payOnlineDialog(invoice, onDone) });
}

export function payOnlineDialog(invoice, onDone) {
  const amount = h("input", { value: (invoice.balance_cents / 100).toFixed(2), inputmode: "decimal" });
  const err = h("p.error-text", { role: "alert" });
  const out = h("div");
  const label = invoice.number != null ? `invoice ${invoice.number}` : "this invoice";
  const form = h(
    "form.modal-body.form-grid",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = "";
        const cents = toCents(amount.value);
        if (!cents) return (err.textContent = "Enter an amount, like 250.00");
        try {
          const r = await post(`/pay/invoices/${invoice.id}/links`, { amountCents: cents });
          out.replaceChildren(
            callout({
              tone: "success",
              title: "Payment link ready",
              body: `Send it to the client. It is shown only once and works until ${new Date(r.link.expires_at).toLocaleDateString()}.`,
            }),
            shareBox(r.url, {
              subject: `Payment for ${label}`,
              body: `You can pay ${label} (${money(cents)}) online at the link below. You will enter your card details on our payment processor's secure page.`,
              email: r.client?.email,
            }),
          );
          form.querySelector("button[type=submit] .btn-label").textContent = "Make a new link";
          onDone?.();
        } catch (ex) {
          err.textContent = ex.message;
        }
      },
    },
    field("Amount to request", h("span.pay-amount-input", h("span.pay-unit", "$"), amount), { hint: `Balance due: ${money(invoice.balance_cents)}` }),
    invoice.activeLink ? callout({ tone: "warning", body: "A link for this invoice is already out. Making a new one turns the old one off." }) : null,
    err,
    out,
    h("div.form-actions", button("Close", { onclick: () => dlg.close() }), button("Create payment link", { variant: "primary", type: "submit" })),
  );
  const dlg = modal(`Pay online: ${label}`, form, {
    wide: true,
    subtitle:
      "The client pays by card on the processor's secure page. The money goes to the operating account and is recorded against this invoice automatically.",
  });
}

function trustDialog(matterId, onDone) {
  const amount = h("input", { inputmode: "decimal", required: true });
  const desc = h("input", { maxlength: 200, placeholder: "Retainer deposit to trust" });
  const err = h("p.error-text", { role: "alert" });
  const out = h("div");
  const form = h(
    "form.modal-body.form-grid",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        const cents = toCents(amount.value);
        if (!cents) return (err.textContent = "Enter an amount, like 2500.00");
        try {
          const r = await post("/pay/trust-links", { matterId, amountCents: cents, description: desc.value || null });
          out.replaceChildren(
            shareBox(r.url, { subject: "Retainer deposit", body: `You can make the retainer deposit (${money(cents)}) online at the link below.` }),
          );
          onDone?.();
        } catch (ex) {
          err.textContent = ex.message;
        }
      },
    },
    field("Amount", h("span.pay-amount-input", h("span.pay-unit", "$"), amount), { required: true }),
    field("Description shown to the client", desc, { optional: true }),
    err,
    out,
    h("div.form-actions", button("Close", { onclick: () => dlg.close() }), button("Create trust deposit link", { variant: "primary", type: "submit" })),
  );
  const dlg = modal("Retainer deposit (trust)", form, {
    wide: true,
    subtitle:
      "This money is unearned and goes to the trust account through the separate trust processor account. It is not recorded in billing; it is held for entry in the trust ledger.",
  });
}

export function matterPaymentsCard(matterId) {
  const base = { className: "pay-card", title: "Online payments", icon: "payments" };
  const el = liveCard({ ...base, body: loadingBlock("Loading online payments", "lines", 2) });
  const draw = async () => {
    let o;
    try {
      o = await get(`/pay/matters/${matterId}`);
    } catch (err) {
      el.put({ body: callout({ tone: "danger", title: "Online payments didn't load", body: err.message }) });
      return;
    }
    const due = o.invoices.filter((i) => i.balance_cents > 0);
    el.put({
      subtitle: o.provider !== "off" && o.testMode ? "Test mode: no real cards are charged" : null,
      flush: o.provider !== "off" && due.length > 0,
      body: [
        o.provider === "off"
          ? emptyState({
              icon: "wallet",
              title: "Online payments are off",
              body: "An administrator can turn them on in Settings, Online payments.",
              compact: true,
            })
          : due.length
            ? h(
                "ul.plain.pay-list",
                due.map((i) =>
                  h(
                    "li",
                    h("span.pay-what", h("span.pay-inv", `Invoice ${i.number}`), h("span.pay-due", `${money(i.balance_cents)} due`)),
                    i.activeLink ? pill("Link sent", "info") : null,
                    payOnlineButton(i, { onDone: draw }),
                  ),
                ),
              )
            : emptyState({
                icon: "circle-check",
                title: o.invoices.length ? "Every invoice is paid" : "No finalized invoices yet",
                body: o.invoices.length ? null : "Once an invoice is finalized, you can send the client a link to pay it by card.",
                compact: true,
              }),
        o.attention.length
          ? h(
              "div.pay-attention",
              callout({
                tone: "warning",
                title: "Needs attention",
                body: h(
                  "ul.plain",
                  o.attention.map((a) =>
                    h(
                      "li",
                      h("span", a.message),
                      button("Mark done", {
                        size: "sm",
                        onclick: () => post(`/pay/attention/${a.id}/done`, {}).then(() => (toast("Marked done"), draw()), fail),
                      }),
                    ),
                  ),
                ),
              }),
            )
          : null,
      ],
      footer: h(
        "div.pay-trust",
        o.trustEnabled
          ? button("Retainer deposit (trust)…", { size: "sm", icon: "landmark", onclick: () => trustDialog(matterId, draw) })
          : h("span.muted", "Retainer deposits to trust can't be taken online until a separate trust processor account is set up (Settings, Online payments)."),
      ),
    });
  };
  draw();
  return el;
}

// ---------------------------------------------------------------- signatures

const STATUS = {
  sent: ["Waiting", "info"],
  viewed: ["Opened", "info"],
  signed: ["Signed", "success"],
  declined: ["Wants paper", "warning"],
  cancelled: ["Cancelled", "neutral"],
  expired: ["Expired", "neutral"],
};

export function statusTag(status) {
  const [label, tone] = STATUS[status] ?? [status, "neutral"];
  return pill(label, tone);
}

export function sendForSignatureButton(doc, opts = {}) {
  return button("Send for signature", { size: "sm", icon: "signatures", onclick: () => sendDialog({ ...opts, doc }) });
}

/** opts: { matter: {id, client_name, client_email}, doc?: {id,name}, onDone } */
export async function sendDialog(opts) {
  const matterId = opts.matter?.id ?? opts.doc?.matterId;
  let docs = [];
  try {
    docs = (await get(`/matters/${matterId}/documents`)).documents;
  } catch (err) {
    return fail(err);
  }
  const signable = docs.filter((d) => d.mime === "application/pdf" || /wordprocessingml/.test(d.mime || ""));
  const docSel = select(
    [
      { value: "", label: signable.length ? "Choose a document…" : "No PDF or Word documents on this matter" },
      ...signable.map((d) => ({ value: d.id, label: d.folder ? `${d.folder}/${d.name}` : d.name })),
    ],
    opts.doc?.id ?? "",
    { required: true },
  );
  const name = h("input", { required: true, maxlength: 200, value: opts.matter?.client_name || "" });
  const email = h("input", { type: "email", maxlength: 200, value: opts.matter?.client_email || "" });
  const msg = h("textarea", { rows: 3, maxlength: 2000, placeholder: "Optional note shown to the signer" });
  const days = h("input", { type: "number", min: 1, max: 90, placeholder: "14" });
  const err = h("p.error-text", { role: "alert" });
  const out = h("div");
  const form = h(
    "form.modal-body.form-grid",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = "";
        try {
          const r = await post("/esign/requests", {
            documentId: Number(docSel.value),
            signerName: name.value,
            signerEmail: email.value || null,
            message: msg.value || null,
            expiresDays: days.value ? Number(days.value) : null,
          });
          out.replaceChildren(
            callout({
              tone: "success",
              title: "Signing link ready",
              body: `Send this private link to ${r.request.signer_name}. It is shown only once and works until ${new Date(r.request.expires_at).toLocaleDateString()}.`,
            }),
            shareBox(r.url, {
              subject: `Please sign: ${r.request.doc_name}`,
              body: `Please review and sign "${r.request.doc_name}" at the private link below.`,
              email: r.request.signer_email,
            }),
          );
          form.querySelector("button[type=submit]").disabled = true;
          opts.onDone?.();
        } catch (ex) {
          err.textContent = ex.message;
        }
      },
    },
    field("Document", docSel, { required: true, hint: "PDF and Word documents on this matter." }),
    h("div.form-row", field("Signer's name", name, { required: true }), field("Signer's email", email, { optional: true })),
    field("Message", msg, { optional: true }),
    field("Link works for (days)", days, { optional: true }),
    err,
    out,
    h("div.form-actions", button("Close", { onclick: () => dlg.close() }), button("Create signing link", { variant: "primary", type: "submit" })),
  );
  const dlg = modal("Send for signature", form, {
    wide: true,
    subtitle:
      "The signer opens the document, agrees to sign electronically (or asks for paper), and signs. A certificate of completion is saved to this matter's documents.",
  });
}

const EVENT_LABEL = {
  sent: "Sent for signature",
  resent: "New link sent",
  opened: "Signing page opened",
  document_viewed: "Document opened",
  consented: "Agreed to sign electronically",
  signed: "Signed",
  declined: "Asked for paper / declined",
  cancelled: "Cancelled",
  certificate_created: "Certificate saved",
};

async function saveDocument(id) {
  const f = await get(`/documents/${id}/download`);
  const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
  const a = h("a", { href: URL.createObjectURL(new Blob([bytes], { type: f.mime })), download: f.filename });
  document.body.append(a);
  a.click();
  a.remove();
}

async function requestDialog(id, onDone) {
  let r;
  try {
    r = await get(`/esign/requests/${id}`);
  } catch (err) {
    return fail(err);
  }
  const open = ["sent", "viewed", "expired"].includes(r.status);
  const out = h("div");
  const body = h(
    "div.modal-body",
    h(
      "div.sign-req-head",
      h(
        "div.cell-stack",
        h("strong", r.doc_name),
        h("span.cell-sub", `Version ${r.version} · to ${r.signer_name}`, r.signer_email ? ` <${r.signer_email}>` : ""),
      ),
      statusTag(r.status),
    ),
    r.newer_version_exists && r.status !== "signed"
      ? callout({
          tone: "warning",
          body: "A newer version of this document was uploaded after it was sent. The signer sees the version that was sent; cancel and send again if that is wrong.",
        })
      : null,
    r.closed_reason ? h("p.muted", `Reason: ${r.closed_reason}`) : null,
    h(
      "table.settings-table.audit-table",
      h("thead", h("tr", h("th", "When"), h("th", "What"), h("th", "Who / where"))),
      h(
        "tbody",
        r.events.map((e) =>
          h(
            "tr",
            h("td", { "data-label": "When" }, fmtTime(e.at)),
            h("td", { "data-label": "What" }, EVENT_LABEL[e.kind] ?? e.kind),
            h("td", { "data-label": "Who / where" }, e.user_name || [e.ip, e.user_agent].filter(Boolean).join(" · ") || "Lawdesk"),
          ),
        ),
      ),
    ),
    r.chain_intact
      ? h("p.sign-chain.ok", icon("circle-check", { size: 15 }), "Audit trail check: intact.")
      : callout({ tone: "danger", title: "Audit trail check failed", body: "An entry was changed or removed." }),
    out,
    h(
      "div.form-actions",
      r.certificate_document_id
        ? button("Download certificate", { icon: "file-text", onclick: () => saveDocument(r.certificate_document_id).catch(fail) })
        : null,
      open
        ? button("Cancel request", {
            variant: "danger",
            onclick: async () => {
              if (!confirm("Cancel this signature request? The link will stop working.")) return;
              try {
                await post(`/esign/requests/${id}/cancel`, { reason: prompt("Reason (optional)") || null });
                toast("Cancelled");
                dlg.close();
                onDone?.();
              } catch (err) {
                fail(err);
              }
            },
          })
        : null,
      open
        ? button("New link", {
            variant: "primary",
            onclick: async () => {
              try {
                const x = await post(`/esign/requests/${id}/resend`, {});
                out.replaceChildren(
                  h("p", "New link (the old one no longer works):"),
                  shareBox(x.url, {
                    subject: `Please sign: ${r.doc_name}`,
                    body: `Please review and sign "${r.doc_name}" at the private link below.`,
                    email: r.signer_email,
                  }),
                );
                onDone?.();
              } catch (err) {
                fail(err);
              }
            },
          })
        : null,
      button("Close", { onclick: () => dlg.close() }),
    ),
  );
  const dlg = modal("Signature request", body, { wide: true });
}

/** matter: { id, client_name, client_email } */
export function matterSignaturesCard(matter) {
  const base = { className: "sign-card", title: "Signatures", icon: "signatures" };
  const el = liveCard({ ...base, body: loadingBlock("Loading signatures", "lines", 2) });
  const sendBtn = () => button("Send a document for signature…", { size: "sm", icon: "plus", onclick: () => sendDialog({ matter, onDone: draw }) });
  const draw = async () => {
    let rows;
    try {
      rows = await get(`/matters/${matter.id}/esign`);
    } catch (err) {
      el.put({ body: callout({ tone: "danger", title: "Signatures didn't load", body: err.message }) });
      return;
    }
    el.put({
      flush: rows.length > 0,
      body: rows.length
        ? h(
            "ul.plain.sign-list",
            rows
              .slice(0, 12)
              .map((r) =>
                h(
                  "li",
                  h(
                    "button.linklike",
                    { type: "button", onclick: () => requestDialog(r.id, draw) },
                    h("span.sign-doc", r.doc_name),
                    h("span.sign-sub", `${r.signer_name} · ${r.signed_at ? "signed " + fmtTime(r.signed_at) : "sent " + fmtTime(r.created_at)}`),
                  ),
                  statusTag(r.status),
                ),
              ),
          )
        : emptyState({
            icon: "signatures",
            title: "Nothing sent for signature yet",
            body: "Send a PDF or Word document from this matter; the client signs from a private link.",
            compact: true,
          }),
      footer: sendBtn(),
    });
  };
  draw();
  return el;
}

// ------------------------------------------------------------------ settings

function sectionHead(ic, title, desc = null) {
  return h(
    "header.card-header",
    h("div.card-heading", h("span.card-icon", icon(ic, { size: 16 })), h("div", h("h2.card-title", title), desc ? h("p.card-subtitle", desc) : null)),
  );
}

export function paymentSettingsSection() {
  const head = () => sectionHead("payments", "Online payments", "Clients pay on the payment processor's own secure page. Card numbers never reach Lawdesk.");
  const sec = h("section.card.settings-section.pay-settings-section#s-pay", head(), loadingBlock("Loading online payment settings", "lines", 3));
  const draw = async () => {
    let s;
    try {
      s = await get("/pay/settings");
    } catch (err) {
      sec.replaceChildren(head(), callout({ tone: "danger", title: "Settings didn't load", body: err.message }));
      return;
    }
    const save = (p, msg) =>
      patch("/pay/settings", p).then(
        () => (toast(msg || "Saved"), draw()),
        (err) => (fail(err), draw()),
      );
    const yes = (b, what, env) =>
      h(
        "li.pay-check",
        icon(b ? "circle-check" : "circle-alert", { size: 15, class: b ? "ok" : "bad" }),
        h("span", b ? `${what}: set` : `${what}: not set (server setting ${env})`),
      );
    sec.replaceChildren(
      head(),
      h(
        "div.form-grid.pay-settings",
        field(
          "Payment processor",
          select(
            [
              { value: "off", label: "Off" },
              { value: "test", label: "Test (demo only, no real money)" },
              { value: "stripe", label: "Stripe" },
            ],
            s.provider,
            { onchange: (e) => save({ provider: e.target.value, ...(e.target.value === "test" ? { testMode: true } : {}) }, "Processor changed") },
          ),
        ),
        h(
          "label.check-line",
          h("input", {
            type: "checkbox",
            checked: s.testMode,
            disabled: s.provider === "test",
            onchange: (e) => save({ testMode: e.target.checked }, e.target.checked ? "Test mode on" : "Test mode off"),
          }),
          " Test mode (no real cards are charged)",
        ),
        field(
          "Payment links work for (days)",
          h("input", { type: "number", min: 1, max: 180, value: s.linkDays, onchange: (e) => save({ linkDays: Number(e.target.value) }) }),
        ),
      ),
      s.provider === "stripe"
        ? h(
            "div.pay-status",
            h("h3", "Stripe (set on the server, never shown here)"),
            h(
              "ul.plain",
              yes(s.stripe.operatingKey, `Operating account key${s.stripe.operatingKeyMode ? ` (${s.stripe.operatingKeyMode})` : ""}`, "STRIPE_SECRET_KEY"),
              yes(s.stripe.operatingWebhookSecret, "Operating webhook signing secret", "STRIPE_WEBHOOK_SECRET"),
            ),
            s.webhookUrls ? h("p.small", "Webhook address to register in Stripe: ", h("code", s.webhookUrls.operating)) : null,
            !s.publicUrl
              ? callout({
                  tone: "warning",
                  body: "Set LAWDESK_PUBLIC_URL on the server to the address clients use (https), so links and Stripe return pages point to the right place.",
                })
              : null,
          )
        : null,
      h(
        "div.pay-status",
        h("h3", "Retainers and trust deposits"),
        h("p.small", s.trust.note),
        h(
          "ul.plain",
          yes(s.trust.processorConfigured, "Separate trust processor account", "STRIPE_TRUST_SECRET_KEY and STRIPE_TRUST_WEBHOOK_SECRET"),
          h(
            "li.pay-check",
            icon(s.trust.enabled ? "circle-check" : "circle-dot", { size: 15, class: s.trust.enabled ? "ok" : "off" }),
            h("span", s.trust.enabled ? "Trust deposit links: on" : "Trust deposit links: off"),
          ),
        ),
        h(
          "label.check-line",
          h("input", {
            type: "checkbox",
            checked: s.trustFeesConfirmed,
            disabled: !s.trust.processorConfigured,
            onchange: (e) => save({ trustFeesConfirmed: e.target.checked }),
          }),
          " We confirm the trust processor account takes its fees and any chargebacks from our operating account, never from trust",
        ),
      ),
    );
  };
  draw();
  return sec;
}

export function esignSettingsSection() {
  const head = () =>
    sectionHead(
      "signatures",
      "Electronic signatures",
      "Signers see these contact details in the consent they agree to: how to ask for paper, withdraw consent, or update their email.",
    );
  const sec = h("section.card.settings-section#s-esign", head(), loadingBlock("Loading signature settings", "lines", 2));
  const draw = async () => {
    let s;
    try {
      s = await get("/esign/settings");
    } catch (err) {
      sec.replaceChildren(head(), callout({ tone: "danger", title: "Settings didn't load", body: err.message }));
      return;
    }
    const save = (p) =>
      patch("/esign/settings", p).then(
        () => toast("Saved"),
        (err) => (fail(err), draw()),
      );
    const paperFee = (e) => {
      const c = toCents(e.target.value);
      c == null ? fail(new Error("Enter an amount, like 0.00")) : save({ paperFeeCents: c });
    };
    sec.replaceChildren(
      head(),
      h(
        "div.form-grid",
        h(
          "div.form-row",
          field(
            "Contact email",
            h("input", { type: "email", value: s.contactEmail || "", maxlength: 200, onchange: (e) => save({ contactEmail: e.target.value || null }) }),
          ),
          field("Contact phone", h("input", { value: s.contactPhone || "", maxlength: 60, onchange: (e) => save({ contactPhone: e.target.value || null }) })),
        ),
        h(
          "div.form-row",
          field(
            "Fee for a paper copy",
            h(
              "span.pay-amount-input",
              h("span.pay-unit", "$"),
              h("input", { inputmode: "decimal", value: (s.paperFeeCents / 100).toFixed(2), onchange: paperFee }),
            ),
          ),
          field(
            "Signing links work for (days)",
            h("input", { type: "number", min: 1, max: 90, value: s.defaultDays, onchange: (e) => save({ defaultDays: Number(e.target.value) }) }),
          ),
        ),
      ),
    );
  };
  draw();
  return sec;
}

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
    input,
    h(
      "div.share-actions",
      h(
        "button.btn.primary",
        {
          type: "button",
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(url);
              toast("Link copied");
            } catch {
              input.select();
              toast("Press Ctrl+C (or ⌘C) to copy the selected link");
            }
          },
        },
        "Copy link",
      ),
      h("a.btn", { href: mailto }, "Email to client"),
    ),
  );
}

// ------------------------------------------------------------------ payments

export function payOnlineButton(invoice, { onDone } = {}) {
  return h("button.btn.small.pay-online", { type: "button", onclick: () => payOnlineDialog(invoice, onDone) }, "Pay online");
}

export function payOnlineDialog(invoice, onDone) {
  const amount = h("input", { value: (invoice.balance_cents / 100).toFixed(2), inputmode: "decimal", "aria-label": "Amount" });
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
            h("p", `Send this link to the client. It is shown only once; it works until ${new Date(r.link.expires_at).toLocaleDateString()}.`),
            shareBox(r.url, {
              subject: `Payment for ${label}`,
              body: `You can pay ${label} (${money(cents)}) online at the link below. You will enter your card details on our payment processor's secure page.`,
              email: r.client?.email,
            }),
          );
          form.querySelector("button[type=submit]").textContent = "Make a new link";
          onDone?.();
        } catch (ex) {
          err.textContent = ex.message;
        }
      },
    },
    h("p.muted", `Balance due on ${label}: ${money(invoice.balance_cents)}. The payment goes to the operating account and is recorded against this invoice automatically.`),
    h("label", "Amount to request", amount),
    invoice.activeLink ? h("p.note", "A link for this invoice is already out. Making a new one turns the old one off.") : null,
    err,
    out,
    h("div.form-actions", h("button.btn", { type: "button", onclick: () => dlg.close() }, "Close"), h("button.btn.primary", { type: "submit" }, "Create payment link")),
  );
  const dlg = modal(`Pay online: ${label}`, form, { wide: true });
}

function trustDialog(matterId, onDone) {
  const amount = h("input", { inputmode: "decimal", "aria-label": "Amount", required: true });
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
          out.replaceChildren(shareBox(r.url, { subject: "Retainer deposit", body: `You can make the retainer deposit (${money(cents)}) online at the link below.` }));
          onDone?.();
        } catch (ex) {
          err.textContent = ex.message;
        }
      },
    },
    h("p.muted", "This money is unearned and goes to the trust account through the separate trust processor account. It is not recorded in billing; it is held for entry in the trust ledger."),
    h("label", "Amount", amount),
    h("label", "Description shown to the client", desc),
    err,
    out,
    h("div.form-actions", h("button.btn", { type: "button", onclick: () => dlg.close() }, "Close"), h("button.btn.primary", { type: "submit" }, "Create trust deposit link")),
  );
  const dlg = modal("Retainer deposit (trust)", form, { wide: true });
}

export function matterPaymentsCard(matterId) {
  const card = h("section.card.pay-card", h("h2", "Online payments"), h("p.muted", "Loading…"));
  const draw = async () => {
    let o;
    try {
      o = await get(`/pay/matters/${matterId}`);
    } catch (err) {
      card.replaceChildren(h("h2", "Online payments"), h("p.error-text", err.message));
      return;
    }
    const due = o.invoices.filter((i) => i.balance_cents > 0);
    card.replaceChildren(
      h("h2", "Online payments"),
      o.provider === "off"
        ? h("p.muted", "Online payments are turned off. Turn them on in Settings.")
        : due.length
          ? h(
              "ul.plain.pay-list",
              due.map((i) =>
                h(
                  "li",
                  h("span.pay-what", `Invoice ${i.number}`, h("span.muted.small", ` ${money(i.balance_cents)} due`)),
                  i.activeLink ? h("span.tag", "Link sent") : null,
                  payOnlineButton(i, { onDone: draw }),
                ),
              ),
            )
          : h("p.muted", o.invoices.length ? "Every finalized invoice is paid." : "No finalized invoices yet."),
      o.provider !== "off" && o.testMode ? h("p.muted.small", "Test mode: no real cards are charged.") : null,
      o.attention.length
        ? h(
            "div.pay-attention",
            h("h3", "Needs attention"),
            h(
              "ul.plain",
              o.attention.map((a) =>
                h(
                  "li",
                  h("span", a.message),
                  h(
                    "button.btn.small",
                    { type: "button", onclick: () => post(`/pay/attention/${a.id}/done`, {}).then(() => (toast("Marked done"), draw()), fail) },
                    "Mark done",
                  ),
                ),
              ),
            ),
          )
        : null,
      h(
        "div.pay-trust",
        o.trustEnabled
          ? h("button.btn.small", { type: "button", onclick: () => trustDialog(matterId, draw) }, "Retainer deposit (trust)…")
          : h("p.muted.small", "Retainer deposits to trust can't be taken online until a separate trust processor account is set up (Settings, Online payments)."),
      ),
    );
  };
  draw();
  return card;
}

// ---------------------------------------------------------------- signatures

const STATUS = {
  sent: ["Waiting", ""],
  viewed: ["Opened", ""],
  signed: ["Signed", ".good"],
  declined: ["Wants paper", ".high"],
  cancelled: ["Cancelled", ".low"],
  expired: ["Expired", ".low"],
};

export function statusTag(status) {
  const [label, cls] = STATUS[status] ?? [status, ""];
  return h("span.tag" + cls, label);
}

export function sendForSignatureButton(doc, opts = {}) {
  return h("button.btn.small", { type: "button", onclick: () => sendDialog({ ...opts, doc }) }, "Send for signature");
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
    [{ value: "", label: signable.length ? "Choose a document…" : "No PDF or Word documents on this matter" }, ...signable.map((d) => ({ value: d.id, label: d.folder ? `${d.folder}/${d.name}` : d.name }))],
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
            h("p", `Send this private link to ${r.request.signer_name}. It is shown only once and works until ${new Date(r.request.expires_at).toLocaleDateString()}.`),
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
    h("label", "Document", docSel),
    h("div.form-row", h("label", "Signer's name", name), h("label", "Signer's email", email)),
    h("label", "Message", msg),
    h("label", "Link works for (days)", days),
    h("p.muted.small", "The signer opens the document, agrees to sign electronically (or asks for paper), and signs. A certificate of completion is saved to this matter's documents."),
    err,
    out,
    h("div.form-actions", h("button.btn", { type: "button", onclick: () => dlg.close() }, "Close"), h("button.btn.primary", { type: "submit" }, "Create signing link")),
  );
  const dlg = modal("Send for signature", form, { wide: true });
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
    h("p", h("b", r.doc_name), ` (version ${r.version}) to ${r.signer_name}`, r.signer_email ? ` <${r.signer_email}>` : "", " ", statusTag(r.status)),
    r.newer_version_exists && r.status !== "signed" ? h("p.note", "A newer version of this document was uploaded after it was sent. The signer sees the version that was sent; cancel and send again if that is wrong.") : null,
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
    h("p.muted.small", r.chain_intact ? "Audit trail check: intact." : "Audit trail check FAILED: an entry was changed or removed."),
    out,
    h(
      "div.form-actions",
      r.certificate_document_id ? h("button.btn", { type: "button", onclick: () => saveDocument(r.certificate_document_id).catch(fail) }, "Download certificate") : null,
      open
        ? h(
            "button.btn",
            {
              type: "button",
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
            },
            "Cancel request",
          )
        : null,
      open
        ? h(
            "button.btn.primary",
            {
              type: "button",
              onclick: async () => {
                try {
                  const x = await post(`/esign/requests/${id}/resend`, {});
                  out.replaceChildren(
                    h("p", "New link (the old one no longer works):"),
                    shareBox(x.url, { subject: `Please sign: ${r.doc_name}`, body: `Please review and sign "${r.doc_name}" at the private link below.`, email: r.signer_email }),
                  );
                  onDone?.();
                } catch (err) {
                  fail(err);
                }
              },
            },
            "New link",
          )
        : null,
      h("button.btn", { type: "button", onclick: () => dlg.close() }, "Close"),
    ),
  );
  const dlg = modal("Signature request", body, { wide: true });
}

/** matter: { id, client_name, client_email } */
export function matterSignaturesCard(matter) {
  const card = h("section.card.sign-card", h("h2", "Signatures"), h("p.muted", "Loading…"));
  const draw = async () => {
    let rows;
    try {
      rows = await get(`/matters/${matter.id}/esign`);
    } catch (err) {
      card.replaceChildren(h("h2", "Signatures"), h("p.error-text", err.message));
      return;
    }
    card.replaceChildren(
      h("h2", "Signatures"),
      rows.length
        ? h(
            "ul.plain.sign-list",
            rows.slice(0, 12).map((r) =>
              h(
                "li",
                h(
                  "button.linklike",
                  { type: "button", onclick: () => requestDialog(r.id, draw) },
                  h("span.sign-doc", r.doc_name),
                  h("span.muted.small", ` ${r.signer_name} · ${r.signed_at ? "signed " + fmtTime(r.signed_at) : "sent " + fmtTime(r.created_at)}`),
                ),
                statusTag(r.status),
              ),
            ),
          )
        : h("p.muted", "Nothing sent for signature yet."),
      h("button.btn.small", { type: "button", onclick: () => sendDialog({ matter, onDone: draw }) }, "Send a document for signature…"),
    );
  };
  draw();
  return card;
}

// ------------------------------------------------------------------ settings

export function paymentSettingsSection() {
  const sec = h("section.card#s-pay", h("h2", "Online payments"), h("p.muted", "Loading…"));
  const draw = async () => {
    let s;
    try {
      s = await get("/pay/settings");
    } catch (err) {
      sec.replaceChildren(h("h2", "Online payments"), h("p.error-text", err.message));
      return;
    }
    const save = (p, msg) =>
      patch("/pay/settings", p).then(
        () => (toast(msg || "Saved"), draw()),
        (err) => (fail(err), draw()),
      );
    const yes = (b, what, env) => h("li", b ? `${what}: set` : `${what}: not set (server setting ${env})`);
    sec.replaceChildren(
      h("h2", "Online payments"),
      h("p.muted", "Clients pay on the payment processor's own secure page. Card numbers never reach Lawdesk."),
      h(
        "div.form-grid.pay-settings",
        h(
          "label",
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
          h("input", { type: "checkbox", checked: s.testMode, disabled: s.provider === "test", onchange: (e) => save({ testMode: e.target.checked }, e.target.checked ? "Test mode on" : "Test mode off") }),
          " Test mode (no real cards are charged)",
        ),
        h("label", "Payment links work for (days)", h("input", { type: "number", min: 1, max: 180, value: s.linkDays, onchange: (e) => save({ linkDays: Number(e.target.value) }) })),
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
            !s.publicUrl ? h("p.note", "Set LAWDESK_PUBLIC_URL on the server to the address clients use (https), so links and Stripe return pages point to the right place.") : null,
          )
        : null,
      h(
        "div.pay-status",
        h("h3", "Retainers and trust deposits"),
        h("p.small", s.trust.note),
        h(
          "ul.plain",
          h("li", s.trust.processorConfigured ? "Separate trust processor account: set up" : "Separate trust processor account: not set up (STRIPE_TRUST_SECRET_KEY and STRIPE_TRUST_WEBHOOK_SECRET)"),
          h("li", s.trust.enabled ? "Trust deposit links: on" : "Trust deposit links: off"),
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
  const sec = h("section.card#s-esign", h("h2", "Electronic signatures"), h("p.muted", "Loading…"));
  const draw = async () => {
    let s;
    try {
      s = await get("/esign/settings");
    } catch (err) {
      sec.replaceChildren(h("h2", "Electronic signatures"), h("p.error-text", err.message));
      return;
    }
    const save = (p) => patch("/esign/settings", p).then(() => toast("Saved"), (err) => (fail(err), draw()));
    sec.replaceChildren(
      h("h2", "Electronic signatures"),
      h("p.muted", "Signers see these contact details in the consent they agree to: how to ask for paper, withdraw consent, or update their email."),
      h(
        "div.form-grid",
        h("div.form-row", h("label", "Contact email", h("input", { type: "email", value: s.contactEmail || "", maxlength: 200, onchange: (e) => save({ contactEmail: e.target.value || null }) })), h("label", "Contact phone", h("input", { value: s.contactPhone || "", maxlength: 60, onchange: (e) => save({ contactPhone: e.target.value || null }) }))),
        h(
          "div.form-row",
          h("label", "Fee for a paper copy ($)", h("input", { inputmode: "decimal", value: (s.paperFeeCents / 100).toFixed(2), onchange: (e) => { const c = toCents(e.target.value); c == null ? fail(new Error("Enter an amount, like 0.00")) : save({ paperFeeCents: c }); } })),
          h("label", "Signing links work for (days)", h("input", { type: "number", min: 1, max: 90, value: s.defaultDays, onchange: (e) => save({ defaultDays: Number(e.target.value) }) })),
        ),
      ),
    );
  };
  draw();
  return sec;
}

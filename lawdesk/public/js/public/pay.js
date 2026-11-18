// The client's payment page: /pay.html?t=<token>. Shows the amount and sends the client to
// the processor's hosted page. No card details are ever entered here.

import { h } from "../dom.js";
import { icon } from "../ui/icons.js";
import { call, money, param, frame, show } from "./common.js";

const token = param("t");
const done = param("done") === "1";
const KIND = { kind: "Secure payment" };

function summary(v) {
  return h(
    "div.pay-summary",
    h("div.pay-summary-amount", h("span.pay-summary-label", "Amount"), h("span.pay-amount", money(v.amountCents))),
    h("dl.pay-summary-facts", h("div", h("dt", "For"), h("dd", v.description)), h("div", h("dt", "Paid to"), h("dd", v.firmName))),
  );
}

async function load() {
  if (!token)
    return show(frame("", { ...KIND, tone: "warning" }, h("h1", "Payment link not found"), h("p.public-lead", "Please check the link you were sent.")));
  let v;
  try {
    v = await call("GET", `/pay/public/links/${encodeURIComponent(token)}`);
  } catch (err) {
    return show(frame("", { ...KIND, tone: "warning" }, h("h1", "Payment link not found"), h("p.public-lead", err.message)));
  }
  if (v.status === "paid") return paid(v);
  if (done) return confirming(v);
  if (v.status !== "active") {
    return show(
      frame(
        v.firmName,
        { ...KIND, tone: "neutral" },
        h("h1", v.status === "expired" ? "This link has expired" : "This link is no longer active"),
        h("p.public-lead", `Please contact ${v.firmName} for a new payment link.`),
      ),
    );
  }
  const err = h("p.error-text", { role: "alert" });
  const btn = h(
    "button.btn.primary.large.public-cta",
    {
      type: "button",
      onclick: async () => {
        btn.disabled = true;
        err.textContent = "";
        try {
          const r = await call("POST", `/pay/public/links/${encodeURIComponent(token)}/checkout`, {});
          location.assign(r.url);
        } catch (e) {
          err.textContent = e.message;
          btn.disabled = false;
        }
      },
    },
    icon("lock", { size: 16 }),
    h("span.btn-label", `Pay ${money(v.amountCents)} by card`),
  );
  show(
    frame(
      v.firmName,
      KIND,
      h("h1", "Make a payment"),
      h("p.public-lead", `${v.firmName} has asked you to pay the amount below.`),
      v.testMode ? h("p.test-banner", icon("info", { size: 15 }), h("span", "Test mode: this is a demonstration. No real card will be charged.")) : null,
      summary(v),
      v.lastPayment === "failed"
        ? h("p.note", icon("triangle-alert", { size: 15 }), h("span", "Your last attempt did not go through. You can try again."))
        : null,
      btn,
      err,
      h("p.public-fine", `You will enter your card details on our payment processor's secure page. ${v.firmName} never sees or stores your card number.`),
    ),
  );
}

function paid(v) {
  show(
    frame(
      v.firmName,
      { ...KIND, tone: "success" },
      h("h1", "Payment received. Thank you."),
      h("p.public-lead", "Your payment has been recorded. A receipt comes from the payment processor."),
      summary(v),
      h("p.public-fine", "You can close this page."),
    ),
  );
}

async function confirming(v) {
  show(frame(v.firmName, { ...KIND, tone: "neutral" }, h("h1", "Thank you"), h("p.public-lead", "Your payment is being confirmed…")));
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const x = await call("GET", `/pay/public/links/${encodeURIComponent(token)}`);
      if (x.status === "paid" || x.lastPayment === "succeeded") {
        return paid(v);
      }
      if (x.lastPayment === "failed")
        return show(
          frame(
            v.firmName,
            { ...KIND, tone: "warning" },
            h("h1", "The payment did not go through"),
            h("p.public-lead", "No money was taken."),
            h("a.btn.primary.large.public-cta", { href: `pay.html?t=${encodeURIComponent(token)}` }, "Try again"),
          ),
        );
    } catch {
      /* keep waiting */
    }
  }
  show(
    frame(
      v.firmName,
      { ...KIND, tone: "neutral" },
      h("h1", "Thank you"),
      h("p.public-lead", "Your payment was submitted. It can take a little while to be confirmed; you don't need to pay again."),
      h("p.public-fine", "You can close this page."),
    ),
  );
}

load();

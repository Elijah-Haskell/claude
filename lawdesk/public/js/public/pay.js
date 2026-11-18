// The client's payment page: /pay.html?t=<token>. Shows the amount and sends the client to
// the processor's hosted page. No card details are ever entered here.

import { h } from "../dom.js";
import { call, money, param, frame, show } from "./common.js";

const token = param("t");
const done = param("done") === "1";

async function load() {
  if (!token) return show(frame("", h("h1", "Payment link not found"), h("p", "Please check the link you were sent.")));
  let v;
  try {
    v = await call("GET", `/pay/public/links/${encodeURIComponent(token)}`);
  } catch (err) {
    return show(frame("", h("h1", "Payment link not found"), h("p", err.message)));
  }
  if (v.status === "paid") return paid(v);
  if (done) return confirming(v);
  if (v.status !== "active") {
    return show(
      frame(v.firmName, h("h1", v.status === "expired" ? "This link has expired" : "This link is no longer active"), h("p", `Please contact ${v.firmName} for a new payment link.`)),
    );
  }
  const err = h("p.error-text", { role: "alert" });
  const btn = h(
    "button.btn.primary.big",
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
    `Pay ${money(v.amountCents)} by card`,
  );
  show(
    frame(
      v.firmName,
      h("h1", "Make a payment"),
      v.testMode ? h("p.test-banner", "Test mode: this is a demonstration. No real card will be charged.") : null,
      h("dl.pay-summary", h("dt", "For"), h("dd", v.description), h("dt", "Amount"), h("dd.pay-amount", money(v.amountCents))),
      v.lastPayment === "failed" ? h("p.note", "Your last attempt did not go through. You can try again.") : null,
      btn,
      err,
      h("p.muted.small", `You will enter your card details on our payment processor's secure page. ${v.firmName} never sees or stores your card number.`),
    ),
  );
}

function paid(v) {
  show(
    frame(
      v.firmName,
      h("h1", "Payment received. Thank you."),
      h("dl.pay-summary", h("dt", "For"), h("dd", v.description), h("dt", "Amount"), h("dd.pay-amount", money(v.amountCents))),
      h("p.muted", "A receipt comes from the payment processor. You can close this page."),
    ),
  );
}

async function confirming(v) {
  show(frame(v.firmName, h("h1", "Thank you"), h("p", "Your payment is being confirmed…")));
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const x = await call("GET", `/pay/public/links/${encodeURIComponent(token)}`);
      if (x.status === "paid" || x.lastPayment === "succeeded") {
        return paid(v);
      }
      if (x.lastPayment === "failed") return show(frame(v.firmName, h("h1", "The payment did not go through"), h("p", "No money was taken. "), h("a.btn", { href: `pay.html?t=${encodeURIComponent(token)}` }, "Try again")));
    } catch {
      /* keep waiting */
    }
  }
  show(frame(v.firmName, h("h1", "Thank you"), h("p", "Your payment was submitted. It can take a little while to be confirmed; you don't need to pay again."), h("p.muted", "You can close this page.")));
}

load();

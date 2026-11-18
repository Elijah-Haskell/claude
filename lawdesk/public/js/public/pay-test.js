// The test provider's stand-in for a processor's hosted page (demo only). It never asks
// for card details: it has just a Pay and a Decline button.

import { h } from "../dom.js";
import { call, money, param, show } from "./common.js";

const id = param("s");

async function load() {
  let s;
  try {
    s = await call("GET", `/pay/public/test-checkout/${encodeURIComponent(id || "")}`);
  } catch (err) {
    return show(h("div.public-card.card", h("h1", "Test payment page"), h("p.error-text", err.message)));
  }
  const err = h("p.error-text", { role: "alert" });
  const go = (outcome) => async () => {
    for (const b of document.querySelectorAll(".test-actions button")) b.disabled = true;
    try {
      const r = await call("POST", `/pay/public/test-checkout/${encodeURIComponent(id)}`, { outcome });
      location.assign(r.redirect);
    } catch (e) {
      err.textContent = e.message;
    }
  };
  show(
    h("header.public-head", h("div.public-firm", "Payment processor (simulated)")),
    h(
      "div.public-card.card",
      h("h1", "Test payment page"),
      h("p.test-banner", "This page stands in for the card processor in the demo. No card details are asked for, and no money moves."),
      h("dl.pay-summary", h("dt", "For"), h("dd", s.description), h("dt", "Amount"), h("dd.pay-amount", money(s.amountCents))),
      s.status !== "open"
        ? h("p", "This test payment has already been completed.")
        : h(
            "div.test-actions",
            h("button.btn.primary.big", { type: "button", onclick: go("pay") }, "Pay (simulate success)"),
            h("button.btn.big", { type: "button", onclick: go("decline") }, "Decline (simulate a declined card)"),
          ),
      err,
    ),
  );
}

load();

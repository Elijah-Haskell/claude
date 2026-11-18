// The test provider's stand-in for a processor's hosted page (demo only). It never asks
// for card details: it has just a Pay and a Decline button.

import { h } from "../dom.js";
import { icon } from "../ui/icons.js";
import { call, money, param, show } from "./common.js";

const id = param("s");

function head() {
  return h(
    "header.public-head.public-head-test",
    h(
      "div.public-head-inner",
      h("div.public-brand", h("div.public-brand-text", h("span.public-firm", "Payment processor"), h("span.public-kind", "Simulated for the demo"))),
      h("span.public-secure", icon("lock", { size: 14 }), h("span", "Test page")),
    ),
  );
}

async function load() {
  let s;
  try {
    s = await call("GET", `/pay/public/test-checkout/${encodeURIComponent(id || "")}`);
  } catch (err) {
    return show(head(), h("div.public-card", h("h1", "Test payment page"), h("p.error-text", err.message)));
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
    head(),
    h(
      "div.public-card",
      h("h1", "Test payment page"),
      h(
        "p.test-banner",
        icon("info", { size: 15 }),
        h("span", "This page stands in for the card processor in the demo. No card details are asked for, and no money moves."),
      ),
      h(
        "div.pay-summary",
        h("div.pay-summary-amount", h("span.pay-summary-label", "Amount"), h("span.pay-amount", money(s.amountCents))),
        h("dl.pay-summary-facts", h("div", h("dt", "For"), h("dd", s.description))),
      ),
      s.status !== "open"
        ? h("p.public-lead", "This test payment has already been completed.")
        : h(
            "div.test-actions",
            h("button.btn.primary.large", { type: "button", onclick: go("pay") }, "Pay (simulate success)"),
            h("button.btn.large", { type: "button", onclick: go("decline") }, "Decline (simulate a declined card)"),
          ),
      err,
    ),
  );
}

load();

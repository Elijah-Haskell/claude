// Shared bits for the pages clients and signers see (no sign-in, no app shell).

import { h } from "../dom.js";
import { icon } from "../ui/icons.js";
import { initialsOf } from "../ui/components.js";

export async function call(method, path, body) {
  let res;
  try {
    res = await fetch("/api" + path, {
      method,
      headers:
        body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json", "X-Requested-With": "lawdesk" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error("We couldn't reach the server. Check your connection and try again.");
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* not JSON */
  }
  if (!res.ok) throw Object.assign(new Error((data && data.error) || `Something went wrong (${res.status})`), { status: res.status });
  return data;
}

export const money = (c) => "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function param(name) {
  const q = new URLSearchParams(location.search);
  if (q.get(name)) return q.get(name);
  return new URLSearchParams(location.hash.slice(1)).get(name);
}

/**
 * The page frame: the firm's name on a navy band, one white card, and a quiet footer.
 * opts.kind labels the band ("Secure payment", "Document signing"); opts.tone puts a status
 * icon at the top of the card ("success", "warning", "neutral").
 */
export function frame(firm, ...content) {
  let opts = {};
  if (content[0] && !(content[0] instanceof Node) && !Array.isArray(content[0]) && typeof content[0] === "object") opts = content.shift();
  const name = firm || "";
  return [
    h(
      "header.public-head",
      h(
        "div.public-head-inner",
        h(
          "div.public-brand",
          name ? h("span.public-monogram", { "aria-hidden": "true" }, initialsOf(name.replace(/[,.&]|\b(LLC|LLP|PC|PA|P\.A\.|Inc)\b/g, " "))) : null,
          h("div.public-brand-text", h("span.public-firm", name || "Secure page"), opts.kind ? h("span.public-kind", opts.kind) : null),
        ),
        h("span.public-secure", icon("lock", { size: 14 }), h("span", "Secure page")),
      ),
    ),
    h(
      "div.public-card" + (opts.tone ? ".tone-" + opts.tone : ""),
      opts.tone ? h("div.public-status", { "aria-hidden": "true" }, icon(TONE_ICON[opts.tone] || "info", { size: 26 })) : null,
      content,
    ),
    h(
      "footer.public-foot",
      h("span.public-foot-line", icon("lock", { size: 13 }), "Your connection to this page is encrypted."),
      h("span.public-powered", "Secured by", h("img", { src: "brand/lawdesk-logo.svg", alt: "Lawdesk", width: "74", height: "16" })),
    ),
  ];
}

const TONE_ICON = { success: "circle-check", warning: "triangle-alert", neutral: "info", danger: "circle-alert" };

export function show(...nodes) {
  document.getElementById("main").replaceChildren(...nodes.flat());
}

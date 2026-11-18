// Shared bits for the pages clients and signers see (no sign-in, no app shell).

import { h } from "../dom.js";

export async function call(method, path, body) {
  let res;
  try {
    res = await fetch("/api" + path, {
      method,
      headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json", "X-Requested-With": "lawdesk" },
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

/** The page frame: firm name on top, one card. */
export function frame(firm, ...content) {
  return [h("header.public-head", h("div.public-firm", firm || "")), h("div.public-card.card", content), h("footer.public-foot", "Secured by Lawdesk")];
}

export function show(...nodes) {
  document.getElementById("main").replaceChildren(...nodes.flat());
}

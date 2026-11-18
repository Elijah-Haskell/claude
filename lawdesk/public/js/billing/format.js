// Pure helpers for the billing screens: money, hours and weeks. No DOM, no imports,
// so tests/billing/format.test.ts can run them in Node.

/** 123456 -> "$1,234.56"; -5 -> "-$0.05". */
export function money(cents) {
  const n = Number(cents) || 0;
  const neg = n < 0;
  const a = Math.abs(Math.round(n));
  const dollars = Math.floor(a / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}$${dollars}.${String(a % 100).padStart(2, "0")}`;
}

/** "1,234.5", "$12", "0.05" -> cents. Returns null when it isn't an amount. */
export function parseMoney(s) {
  const m = /^\s*\$?\s*(\d{1,3}(?:,\d{3})+|\d*)(?:\.(\d{0,2}))?\s*$/.exec(String(s ?? ""));
  if (!m || (m[1] === "" && !m[2])) return null;
  const whole = Number((m[1] || "0").replace(/,/g, ""));
  const frac = Number((m[2] || "").padEnd(2, "0") || "0");
  const out = whole * 100 + frac;
  return Number.isSafeInteger(out) ? out : null;
}

/** Cents as a plain number for an input box: 25000 -> "250.00", null -> "". */
export function moneyInput(cents) {
  if (cents == null) return "";
  return (cents / 100).toFixed(2);
}

/**
 * Hours as a person types them -> minutes, or null if it can't be read.
 *   "1.5" "1,5" ".25" -> decimal hours     "1:30" -> hours:minutes
 *   "90m" "45 min"    -> minutes           "1h 30m" "2h" -> hours and minutes
 */
export function parseHours(s) {
  const t = String(s ?? "")
    .trim()
    .toLowerCase();
  if (!t) return null;
  let m = /^(\d+):([0-5]?\d)$/.exec(t);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = /^(?:(\d+(?:[.,]\d+)?)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?|s)?)?)?$/.exec(t);
  if (m && (m[1] || m[2])) return Math.round(Number((m[1] || "0").replace(",", ".")) * 60) + Number(m[2] || 0);
  m = /^(\d*(?:[.,]\d+)?|\d+[.,]?)$/.exec(t);
  if (m && /\d/.test(t)) return Math.round(Number(t.replace(",", ".")) * 60);
  return null;
}

/** Minutes -> hours for display: 90 -> "1.5", 60 -> "1.0", 20 -> "0.33". */
export function hours(minutes) {
  const hundredths = Math.round(((Number(minutes) || 0) * 100) / 60);
  const s = (hundredths / 100).toFixed(2);
  return s.endsWith("0") ? s.slice(0, -1) : s;
}

/** Minutes rounded up to the billing increment. */
export function billedMinutes(minutes, increment = 6) {
  return Math.ceil((Number(minutes) || 0) / increment) * increment;
}

/** Elapsed milliseconds -> "0:07:05" for a running timer. */
export function clock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Monday of the week containing an ISO date. */
export function weekStart(iso) {
  const d = new Date(iso + "T00:00:00Z");
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - back * 86_400_000).toISOString().slice(0, 10);
}

/** Basis points -> "7.5" (percent, for inputs); "7.5" -> 750. */
export function bpToPercent(bp) {
  return String(Math.round(Number(bp) || 0) / 100);
}
export function percentToBp(s) {
  const t = String(s ?? "")
    .trim()
    .replace(/%$/, "");
  if (t === "") return 0;
  if (!/^\d+(\.\d{0,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

/**
 * Spread a payment over invoices, oldest first. invoices: [{id, balance_cents}] in the
 * order to pay them. Returns {allocations: {id: cents}, left: cents}.
 */
export function autoApply(amountCents, invoices) {
  let left = Math.max(0, amountCents || 0);
  const allocations = {};
  for (const inv of invoices) {
    const take = Math.min(left, inv.balance_cents);
    if (take > 0) allocations[inv.id] = take;
    left -= take;
  }
  return { allocations, left };
}

// Number formatting for the overview and reports. Money is integer cents; time is minutes.
// Exports use the same rules (src/reports/format.ts), so the screen and the CSV agree.

/** 123456 -> "$1,234.56"; negative -> "−$5.00". */
export function money(cents) {
  if (cents == null) return "—";
  const neg = cents < 0;
  const a = Math.abs(Math.trunc(cents));
  const dollars = Math.floor(a / 100).toLocaleString("en-US");
  return `${neg ? "−" : ""}$${dollars}.${String(a % 100).padStart(2, "0")}`;
}

/** Whole dollars for headline tiles: 123456 -> "$1,235" (rounded half up). */
export function moneyWhole(cents) {
  if (cents == null) return "—";
  const neg = cents < 0;
  const d = Math.floor((Math.abs(cents) + 50) / 100);
  return `${neg ? "−" : ""}$${d.toLocaleString("en-US")}`;
}

/** Short axis label: 0 -> "$0", 150000 -> "$1.5k", 12_000_000 -> "$120k", 1e8 -> "$1m". */
export function moneyShort(cents) {
  const d = cents / 100;
  if (d >= 1_000_000) return `$${trim(d / 1_000_000)}m`;
  if (d >= 1000) return `$${trim(d / 1000)}k`;
  return `$${Math.round(d)}`;
}

function trim(x) {
  return x >= 100 ? String(Math.round(x)) : String(Math.round(x * 10) / 10);
}

/** Minutes as hours with 2 decimals, rounded half up: 90 -> "1.50". */
export function hours(minutes) {
  if (minutes == null) return "—";
  const neg = minutes < 0;
  const a = Math.abs(minutes);
  const h = Math.floor((a * 200 + 60) / 120);
  return `${neg && h ? "−" : ""}${Math.floor(h / 100).toLocaleString("en-US")}.${String(h % 100).padStart(2, "0")}`;
}

/** Minutes as "12.5 h" (one decimal) for charts and tiles. */
export function hoursShort(minutes) {
  if (minutes == null) return "—";
  const tenths = Math.floor((Math.abs(minutes) + 3) / 6); // tenths of an hour = minutes / 6, half up
  return `${Math.floor(tenths / 10).toLocaleString("en-US")}.${tenths % 10} h`;
}

/** A 4-decimal ratio as "92.5%". */
export function pct(r) {
  if (r == null) return "—";
  const tenths = Math.round(r * 1000);
  return `${tenths < 0 ? "−" : ""}${Math.floor(Math.abs(tenths) / 10)}.${Math.abs(tenths) % 10}%`;
}

export function int(n) {
  return n == null ? "—" : Number(n).toLocaleString("en-US");
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "Nov 18, 2026" */
export function longDate(iso) {
  if (!iso) return "";
  return `${MONTHS[Number(iso.slice(5, 7)) - 1].slice(0, 3)} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;
}

export function monthName(iso) {
  return MONTHS[Number(iso.slice(5, 7)) - 1];
}

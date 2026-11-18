// Integer money arithmetic. Every amount is integer cents; nothing here ever
// produces a fraction of a cent.
//
// Rounding rules (all tested in tests/billing/money.test.ts):
//   * Time is billed in whole increments (default 6 minutes = 0.1 h). Each entry's
//     minutes round UP to the next increment: 1-6 min -> 0.1 h, 7 min -> 0.2 h, 0 -> 0.
//   * A line amount is rate x billed hours, rounded HALF-UP to the cent
//     (half a cent rounds away from zero): $250.25/h x 0.1 h = 2502.5c -> 2503c.
//   * Percentages (markup, discount, tax) are basis points; the result is rounded
//     half-up to the cent per line (tax) or once per invoice (percent discount).

export function assertCents(n: unknown, what = "Amount"): number {
  if (typeof n !== "number" || !Number.isSafeInteger(n)) throw new RangeError(`${what} must be a whole number of cents`);
  return n;
}

/** n / d rounded half away from zero, for integers with d > 0. */
export function divRoundHalfUp(n: number, d: number): number {
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(d) || d <= 0) throw new RangeError("divRoundHalfUp needs integers and d > 0");
  const neg = n < 0;
  const a = Math.abs(n);
  const q = Math.floor(a / d);
  const r = a - q * d;
  const out = 2 * r >= d ? q + 1 : q;
  return neg ? -out : out;
}

/** Minutes rounded up to a whole number of billing increments. */
export function billedMinutes(minutes: number, incrementMinutes = 6): number {
  if (!Number.isSafeInteger(minutes) || minutes < 0) throw new RangeError("Minutes must be a whole number, 0 or more");
  if (!Number.isSafeInteger(incrementMinutes) || incrementMinutes <= 0) throw new RangeError("Increment must be positive");
  return Math.ceil(minutes / incrementMinutes) * incrementMinutes;
}

/** Amount for `minutes` (already rounded to the increment) at `rateCents` per hour. */
export function timeAmount(rateCents: number, minutes: number): number {
  const product = rateCents * minutes;
  if (!Number.isSafeInteger(product)) throw new RangeError("Amount too large");
  return divRoundHalfUp(product, 60);
}

/** cents x bp / 10000, rounded half-up. */
export function applyBp(cents: number, bp: number): number {
  const product = cents * bp;
  if (!Number.isSafeInteger(product)) throw new RangeError("Amount too large");
  return divRoundHalfUp(product, 10_000);
}

/** Billed amount of an expense: cost plus markup. */
export function expenseAmount(costCents: number, markupBp = 0): number {
  return costCents + applyBp(costCents, markupBp);
}

/** Hours for display, two decimals with one trailing zero dropped: 6 -> "0.1", 90 -> "1.5", 60 -> "1.0", 20 -> "0.33". */
export function hoursLabel(minutes: number): string {
  const hundredths = divRoundHalfUp(minutes * 100, 60);
  const s = (hundredths / 100).toFixed(2);
  return s.endsWith("0") ? s.slice(0, -1) : s;
}

/** 123456 -> "$1,234.56"; -5 -> "-$0.05". */
export function formatCents(cents: number): string {
  assertCents(cents);
  const neg = cents < 0;
  const a = Math.abs(cents);
  const dollars = Math.floor(a / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const c = (a % 100).toString().padStart(2, "0");
  return `${neg ? "-" : ""}$${dollars}.${c}`;
}

/** "1,234.5" / "$12" / "0.05" -> cents. Rejects more than two decimal places. */
export function parseDollars(s: string): number {
  const m = /^\s*(-)?\$?\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?\s*$/.exec(s);
  if (!m) throw new RangeError(`Not an amount: ${s}`);
  const whole = Number(m[2].replace(/,/g, ""));
  const frac = Number((m[3] ?? "0").padEnd(2, "0"));
  const out = whole * 100 + frac;
  if (!Number.isSafeInteger(out)) throw new RangeError("Amount too large");
  return m[1] ? -out : out;
}

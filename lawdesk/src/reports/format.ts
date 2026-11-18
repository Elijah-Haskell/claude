// Exact number formatting for exports: integer arithmetic only, no float rounding surprises.

/** 123456 -> "1234.56", -5 -> "-0.05". */
export function centsToDecimal(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new RangeError("Amount must be whole cents");
  const neg = cents < 0;
  const a = Math.abs(cents);
  return `${neg ? "-" : ""}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}

/** Minutes as decimal hours to 2 places, rounded half up: 90 -> "1.50", 7 -> "0.12", 1 -> "0.02". */
export function minutesToHours(minutes: number): string {
  if (!Number.isSafeInteger(minutes)) throw new RangeError("Minutes must be whole");
  const neg = minutes < 0;
  const a = Math.abs(minutes);
  // hundredths of an hour = minutes * 100 / 60, half up
  const h = Math.floor((a * 100 * 2 + 60) / 120);
  return `${neg && h ? "-" : ""}${Math.floor(h / 100)}.${String(h % 100).padStart(2, "0")}`;
}

/** A 4-decimal ratio as a percent with one decimal: 0.925 -> "92.5%", 1 -> "100.0%". */
export function percent(r: number): string {
  // r has at most 4 decimals, so r * 1000 is a whole number of tenths of a percent.
  const tenths = Math.round(r * 1000);
  const neg = tenths < 0;
  const a = Math.abs(tenths);
  return `${neg ? "-" : ""}${Math.floor(a / 10)}.${a % 10}%`;
}

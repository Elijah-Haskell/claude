// Sign-in with a code sent by email: the checks the form makes before asking the server (the server checks again).

/** The address as the server keys it: trimmed and lower-cased. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** One @, something before it, a dot in the domain, no spaces: enough to catch typos before sending a code. */
export function looksLikeEmail(raw: string): boolean {
  const email = normalizeEmail(raw);
  return email.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

/** The code's digits only (pasting "123 456" works); null until there are exactly six. */
export function codeDigits(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  return digits.length === 6 ? digits : null;
}

/** "Signed in with …" for the account's sign-in method. */
export function signedInWithLabel(loginMethod: string | null | undefined): string {
  if (loginMethod === "google") return "Signed in with Google";
  if (loginMethod === "email") return "Signed in with email";
  return "Signed in with Apple";
}

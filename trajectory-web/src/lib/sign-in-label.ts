/** "Signed in with …" for the account's sign-in method (Settings). */
export function signedInWithLabel(loginMethod: string | null | undefined): string {
  return loginMethod === "google" ? "Signed in with Google" : "Signed in with Apple";
}

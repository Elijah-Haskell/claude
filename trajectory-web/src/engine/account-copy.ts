/**
 * What the app says about the account, in one place: the welcome screen, Settings, the Semester tab, signing out
 * and a session that ended. Pure strings, no imports.
 *
 * A Trajectory account is required (lib/features.ts): Sign in with Apple on the first screen, the plan saved to the
 * account (lib/plan-sync-client.ts), Trajectory Pro tied to it. The plan is ALSO kept on the iPhone, where the app
 * works from it, so "saved on this iPhone" is still true. What must never come back is "only on this iPhone",
 * "no account needed", or anything about guests.
 * Keep this in step with the privacy policy (app/privacy-policy.tsx, server/legal-pages.ts).
 */
export const ACCOUNT_COPY = {
  /** Welcome screen: the one line under Continue with Apple (why there is an account at all). */
  line: "Your plan is saved to your account, so it's still there if you change or lose your iPhone.",
  /** Welcome screen, when the session ended by itself (expired, or the server no longer accepts it). */
  signedOutNotice: "You've been signed out. Sign in again and your plan picks up where you left off.",
  /** Welcome screen, signed in, while this iPhone's plan and the account's are brought together. */
  gettingPlan: "Getting your plan…",
  /** The same, once it has lasted long enough that the student is offered a way out (the quiet "Sign out" link). */
  gettingPlanSlow: "This is taking longer than usual.",
  /** Welcome screen, signed in, no plan on this iPhone and the server could not be reached. */
  unreachableTitle: "Couldn't reach your account",
  unreachableBody: "Check your connection, then try again.",
  /** Settings and the Semester tab: who is signed in (the e-mail goes under it when the account has one). */
  signedIn: "Signed in with Apple",
  signedInDetail: "Your plan is saved to your account.",
  /** The browser preview has no accounts: what its Settings, Semester tab and welcome screen say instead. */
  notSignedIn: "Not signed in",
  notSignedInDetail: "Sign in with Apple is available in the iOS Trajectory app.",
  browserPreview: "Browser preview. Sign in with Apple and the saved plan are in the iPhone app.",
  /** The "Sign out?" alert. */
  signOut: "Your plan is saved to your account. Signing out removes it from this iPhone; sign in again to get it back.",
  /** The root overlay while the plan is erased from the iPhone and the session dropped (app/_layout.tsx). */
  signingOut: "Signing out…",
  deletingAccount: "Deleting your account…",
} as const;

/** Signing out, first alert (hooks/use-sign-out.ts). */
export const SIGN_OUT_CONFIRM = {
  title: "Sign out?",
  message: ACCOUNT_COPY.signOut,
  cancel: "Cancel",
  confirm: "Sign out",
} as const;

/**
 * Signing out, second alert: only when the account does NOT have this iPhone's latest changes (offline, or the
 * server could not be reached), because signing out erases the only copy of them.
 */
export const SIGN_OUT_UNSAVED = {
  title: "Your latest changes aren't saved yet",
  message: "Trajectory couldn't reach your account just now. If you sign out now, the changes since your last save will be lost.",
  stay: "Stay signed in",
  leave: "Sign out anyway",
} as const;

/**
 * What a screen's own error says when a server call was answered "not signed in". Two cases look the same to the
 * screen: the session is gone (the app then drops it and shows the sign-in screen, lib/sign-in-prompt.ts, so this is
 * barely seen), or one call went out without the session while the student is still signed in (the Keychain could
 * not be read for a moment). So it says what is true in both, and the plan on the iPhone is kept either way.
 */
export const NOT_SIGNED_IN_COPY = {
  title: "Couldn't confirm your account",
  message: "Try again in a moment. If you've been signed out, sign in again; your plan is still on this iPhone.",
} as const;

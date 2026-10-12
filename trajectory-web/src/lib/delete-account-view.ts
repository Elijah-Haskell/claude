/**
 * Delete account (app/delete-account.tsx), as pure strings and functions: what is deleted, the note about a
 * subscription, the question the button turns into, and how the deletion ended. The lists and the sentences the
 * screen has always stated are kept here word for word (the App Store reads them too).
 */

/** What goes with the account, one row each. */
export const DELETED_WITH_ACCOUNT: readonly { icon: "user" | "layers" | "book" | "file" | "calSync" | "spark" | "cal"; text: string }[] = [
  { icon: "user", text: "Your Trajectory account and its Sign in with Apple link" },
  { icon: "layers", text: "The plan saved to your account" },
  { icon: "book", text: "Classes, tasks, schedules, and study materials on this iPhone" },
  { icon: "file", text: "Files you uploaded for AI reading that are still stored" },
  { icon: "calSync", text: "Any saved Google Calendar connection data and cached events" },
  { icon: "spark", text: "AI personalization data and app preferences stored on this iPhone" },
  { icon: "cal", text: 'The "Trajectory" calendar, if you added your plan to Apple Calendar (your other calendars are not touched)' },
];

export const DELETE_ACCOUNT_COPY = {
  sub: "This removes your account and what is in it, for good.",
  subscription: "Deleting your account does not cancel an active App Store subscription. You can manage or cancel subscriptions in iOS Settings → Apple Account → Subscriptions.",
  button: "Delete account and data",
  /** Under the button, before it is tapped. */
  asksFirst: "It asks once more before anything is deleted.",
  /** What the button turns into, with its two answers. */
  question: "Delete your Trajectory account and everything listed above, for good? This cannot be undone.",
  yes: "Delete",
  no: "Keep my account",
  /** The alert once the account is gone (the screen is gone by then). */
  deletedTitle: "Account deleted",
  deletedButton: "Done",
  /** The server did not delete it: said in an alert (the student may have left the app) and on the page. */
  failedTitle: "Couldn't delete account",
  failed: "Your account has not been deleted. Please check your connection and try again.",
  /** The browser preview has no accounts. */
  notSignedIn: "Nothing was deleted: you are not signed in here.",
} as const;

/**
 * What the "Account deleted" alert says. Apple is only said to have been asked to revoke Sign in with Apple when the
 * server reports it really did (it needs the optional Apple key and a token stored at sign-in); otherwise the
 * student is told where to do it.
 */
export function accountDeletedMessage(appleRevoked: boolean): string {
  return `Your Trajectory account, the plan saved to it, uploaded files, any Google Calendar connection data, and on-device Trajectory data have been permanently deleted. ${
    appleRevoked
      ? "Apple has been asked to remove Trajectory from Sign in with Apple."
      : "To also remove Trajectory from Sign in with Apple, open iOS Settings → Apple Account → Sign-In & Security → Sign in with Apple."
  } App Store subscription records remain with Apple and can be managed in iOS Settings.`;
}

/** What the page itself says after a deletion that did not happen; null when there is nothing to say. */
export function deletionNotice(outcome: "deleted" | "failed" | "cancelled"): string | null {
  if (outcome === "failed") return DELETE_ACCOUNT_COPY.failed;
  // The question was answered "Delete", so the only way it is called off is that nobody is signed in.
  if (outcome === "cancelled") return DELETE_ACCOUNT_COPY.notSignedIn;
  return null;
}

import { describe, expect, it } from "vitest";

import { accountDeletedMessage, DELETE_ACCOUNT_COPY, DELETED_WITH_ACCOUNT, deletionNotice } from "../../src/lib/delete-account-view";
import { runAccountDeletion } from "../../src/lib/sign-out-flow";

describe("what the screen has always stated, word for word", () => {
  it("the seven things that are deleted, in order", () => {
    expect(DELETED_WITH_ACCOUNT.map((row) => row.text)).toEqual([
      "Your Trajectory account and its Sign in with Apple link",
      "The plan saved to your account",
      "Classes, tasks, schedules, and study materials on this iPhone",
      "Files you uploaded for AI reading that are still stored",
      "Any saved Google Calendar connection data and cached events",
      "AI personalization data and app preferences stored on this iPhone",
      'The "Trajectory" calendar, if you added your plan to Apple Calendar (your other calendars are not touched)',
    ]);
    expect(DELETED_WITH_ACCOUNT.map((row) => row.icon)).toEqual(["user", "layers", "book", "file", "calSync", "spark", "cal"]);
  });

  it("that a subscription is not cancelled, and where to manage it", () => {
    expect(DELETE_ACCOUNT_COPY.subscription).toBe(
      "Deleting your account does not cancel an active App Store subscription. You can manage or cancel subscriptions in iOS Settings → Apple Account → Subscriptions.",
    );
  });
});

describe("the button and the question it turns into", () => {
  it("says it asks first, then asks with the two answers", () => {
    expect(DELETE_ACCOUNT_COPY.button).toBe("Delete account and data");
    expect(DELETE_ACCOUNT_COPY.asksFirst).toBe("It asks once more before anything is deleted.");
    expect(DELETE_ACCOUNT_COPY.question).toBe("Delete your Trajectory account and everything listed above, for good? This cannot be undone.");
    expect([DELETE_ACCOUNT_COPY.yes, DELETE_ACCOUNT_COPY.no]).toEqual(["Delete", "Keep my account"]);
  });
});

describe("how the deletion ended", () => {
  it("says Apple was asked to revoke Sign in with Apple only when it was, and otherwise where to do it", () => {
    expect(accountDeletedMessage(true)).toBe(
      "Your Trajectory account, the plan saved to it, uploaded files, any Google Calendar connection data, and on-device Trajectory data have been permanently deleted. Apple has been asked to remove Trajectory from Sign in with Apple. App Store subscription records remain with Apple and can be managed in iOS Settings.",
    );
    expect(accountDeletedMessage(false)).toBe(
      "Your Trajectory account, the plan saved to it, uploaded files, any Google Calendar connection data, and on-device Trajectory data have been permanently deleted. To also remove Trajectory from Sign in with Apple, open iOS Settings → Apple Account → Sign-In & Security → Sign in with Apple. App Store subscription records remain with Apple and can be managed in iOS Settings.",
    );
  });

  it("the page says a deletion that did not happen, and nothing once the account is gone", () => {
    expect(deletionNotice("failed")).toBe("Your account has not been deleted. Please check your connection and try again.");
    expect(deletionNotice("cancelled")).toBe("Nothing was deleted: you are not signed in here.");
    expect(deletionNotice("deleted")).toBeNull();
  });

  // The screen answers the flow's question itself ("Delete" under the red note), so these are the three ways it can end.
  const deps = (over: Partial<Parameters<typeof runAccountDeletion>[0]> = {}) => {
    const calls: string[] = [];
    return {
      calls,
      deps: {
        confirm: async () => true,
        signedIn: () => true,
        prepare: async () => void calls.push("prepare"),
        deleteAccount: async () => (calls.push("delete"), { appleRevoked: false }),
        cancel: () => void calls.push("cancel"),
        wipe: async () => void calls.push("wipe"),
        logout: async () => void calls.push("logout"),
        ...over,
      } as Parameters<typeof runAccountDeletion>[0],
    };
  };

  it("with the question answered on the page, the flow deletes, and its three endings each have their words", async () => {
    const done = deps();
    const deleted = await runAccountDeletion(done.deps);
    expect(deleted).toEqual({ outcome: "deleted", appleRevoked: false });
    expect(done.calls).toEqual(["prepare", "delete", "wipe", "logout"]);
    expect(deletionNotice(deleted.outcome)).toBeNull();

    const refused = deps({
      deleteAccount: async () => {
        throw new Error("offline");
      },
    });
    const failed = await runAccountDeletion(refused.deps);
    expect(failed).toEqual({ outcome: "failed" });
    // Nothing on the iPhone was erased, and saving goes on.
    expect(refused.calls).toEqual(["prepare", "cancel"]);
    expect(deletionNotice(failed.outcome)).toBe(DELETE_ACCOUNT_COPY.failed);

    // The browser preview: nobody is signed in, so nothing is touched.
    const preview = deps({ signedIn: () => false });
    const called = await runAccountDeletion(preview.deps);
    expect(called).toEqual({ outcome: "cancelled" });
    expect(preview.calls).toEqual([]);
    expect(deletionNotice(called.outcome)).toBe(DELETE_ACCOUNT_COPY.notSignedIn);
  });
});

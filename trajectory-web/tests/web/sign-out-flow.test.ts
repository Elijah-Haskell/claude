// lib/sign-out-flow.ts: the order of signing out and of deleting the account. The plan is saved to the account and a
// copy lives on the iPhone; leaving erases that copy, so saving has to stop first and the session goes last.
import { afterEach, describe, expect, it, vi } from "vitest";

import { createInitialState } from "../../src/engine/state-persistence";
import type { AppState } from "../../src/engine/types";
import {
  boundedPreparation,
  holdsNoPlan,
  leaveSignInMode,
  noteEmptyAtSignIn,
  runAccountDeletion,
  runSessionOnlySignOut,
  runSignOut,
  type AccountDeletionDeps,
  type SignOutDeps,
} from "../../src/lib/sign-out-flow";

function signOutDeps(over: Partial<SignOutDeps> = {}) {
  const calls: string[] = [];
  const deps: SignOutDeps = {
    confirm: async () => (calls.push("confirm"), true),
    prepare: async () => (calls.push("prepare"), "saved"),
    confirmUnsaved: async () => (calls.push("confirmUnsaved"), true),
    cancel: () => void calls.push("cancel"),
    wipe: async () => void calls.push("wipe"),
    logout: async () => void calls.push("logout"),
    setBusy: (busy) => void calls.push(busy ? "busy" : "idle"),
    ...over,
  };
  return { deps, calls };
}

describe("signing out", () => {
  it("asks first; saves and stops saving; erases the iPhone's copy; only then drops the session", async () => {
    const { deps, calls } = signOutDeps();
    expect(await runSignOut(deps)).toBe("signed-out");
    expect(calls).toEqual(["confirm", "busy", "prepare", "wipe", "logout", "idle"]);
  });

  it("Cancel on 'Sign out?' touches nothing", async () => {
    const { deps, calls } = signOutDeps({ confirm: async () => false });
    expect(await runSignOut(deps)).toBe("cancelled");
    expect(calls).toEqual([]);
  });

  it("does nothing when the session ended while the question was open (the plan stays for the next sign-in)", async () => {
    const { deps, calls } = signOutDeps({ signedIn: () => false });
    expect(await runSignOut(deps)).toBe("cancelled");
    expect(calls).toEqual(["confirm"]);
    const still = signOutDeps({ signedIn: () => true });
    expect(await runSignOut(still.deps)).toBe("signed-out");
  });

  it("warns when the account does not have the latest changes, before anything is erased", async () => {
    const { deps, calls } = signOutDeps({ prepare: async () => "unsaved" });
    deps.confirmUnsaved = async () => (calls.push("confirmUnsaved"), true);
    expect(await runSignOut(deps)).toBe("signed-out");
    // Saving HAS stopped (prepare answered): the usual order.
    expect(calls).toEqual(["confirm", "busy", "confirmUnsaved", "wipe", "logout", "idle"]);
  });

  it("'Stay signed in' starts saving again and erases nothing", async () => {
    const { deps, calls } = signOutDeps({ prepare: async () => "unsaved" });
    deps.confirmUnsaved = async () => (calls.push("confirmUnsaved"), false);
    expect(await runSignOut(deps)).toBe("stayed");
    expect(calls).toEqual(["confirm", "busy", "confirmUnsaved", "cancel", "idle"]);
    expect(calls).not.toContain("wipe");
    expect(calls).not.toContain("logout");
  });

  it("saved: no second question, and saving is never started again", async () => {
    const { deps, calls } = signOutDeps();
    await runSignOut(deps);
    expect(calls).not.toContain("confirmUnsaved");
    expect(calls).not.toContain("cancel");
  });

  it("no answer from the save (or a failure): the student is asked instead of the plan being erased", async () => {
    for (const prepare of [
      async () => "unanswered" as const,
      async () => {
        throw new Error("engine failed");
      },
    ]) {
      const { deps, calls } = signOutDeps({ prepare });
      deps.confirmUnsaved = async () => (calls.push("confirmUnsaved"), false);
      expect(await runSignOut(deps)).toBe("stayed");
      expect(calls).toEqual(["confirm", "busy", "confirmUnsaved", "cancel", "idle"]);
    }
  });

  it("no answer and 'Sign out anyway': the session goes BEFORE the iPhone is erased (saving may still be running)", async () => {
    for (const prepare of [
      async () => "unanswered" as const,
      async () => {
        throw new Error("engine failed");
      },
    ]) {
      const { deps, calls } = signOutDeps({ prepare });
      deps.confirmUnsaved = async () => (calls.push("confirmUnsaved"), true);
      expect(await runSignOut(deps)).toBe("signed-out");
      // The emptied plan the wipe leaves in memory must never meet a live session whose saving was not stopped.
      expect(calls).toEqual(["confirm", "busy", "confirmUnsaved", "logout", "wipe", "idle"]);
    }
  });

  it("a wipe that fails still ends in a sign-out (saving is stopped and the plan in memory is already emptied)", async () => {
    const { deps, calls } = signOutDeps({
      wipe: async () => {
        throw new Error("storage error");
      },
    });
    expect(await runSignOut(deps)).toBe("signed-out");
    expect(calls).toEqual(["confirm", "busy", "prepare", "logout", "idle"]);
    expect(calls).not.toContain("cancel");
  });

  it("is never left 'busy', whatever fails", async () => {
    const { deps, calls } = signOutDeps({
      logout: async () => {
        throw new Error("boom");
      },
    });
    await expect(runSignOut(deps)).rejects.toThrow("boom");
    expect(calls[calls.length - 1]).toBe("idle");
  });
});

describe("'there is no plan on this iPhone'", () => {
  const state = (over: Partial<AppState> = {}): AppState => ({ ...createInitialState(), ...over });
  const some = [{ id: "x" }] as never[];

  it("a fresh install holds none, whether or not the welcome screen was passed, and whatever the settings say", () => {
    expect(holdsNoPlan(createInitialState())).toBe(true);
    expect(holdsNoPlan(state({ onboardingComplete: true }))).toBe(true);
    expect(holdsNoPlan(state({ healthPrefs: { ...createInitialState().healthPrefs, bedtime: "01:00" } }))).toBe(true);
    // Events read from the iPhone's own calendars are not the student's plan.
    expect(holdsNoPlan(state({ deviceCalendarEvents: some }))).toBe(true);
  });

  it("anything the student made, imported or was graded on is a plan", () => {
    for (const key of ["classes", "tasks", "recurringEvents", "syllabusImports", "examPreps", "studyGuides", "practiceExams", "grades"] as const) {
      expect(holdsNoPlan(state({ [key]: some })), key).toBe(false);
    }
    expect(holdsNoPlan(state({ semester: { name: "Fall", startDate: "2026-09-01", endDate: "2026-12-18" } as AppState["semester"] }))).toBe(false);
  });

  it("an event the student put on the calendar is one; the planner's own sleep and buffer blocks are not", () => {
    const block = (type: string) => ({ id: type, type, title: type, date: "2026-10-05", startTime: "09:00", endTime: "10:00", locked: false, accepted: true }) as AppState["scheduleBlocks"][number];
    expect(holdsNoPlan(state({ scheduleBlocks: [block("sleep"), block("buffer")] }))).toBe(true);
    for (const type of ["class", "study", "work", "recurring", "free"]) {
      expect(holdsNoPlan(state({ scheduleBlocks: [block("sleep"), block(type)] })), type).toBe(false);
    }
  });

  it("does not trip over lists an older save does not have", () => {
    expect(holdsNoPlan({ ...createInitialState(), syllabusImports: undefined, scheduleBlocks: undefined as never, grades: undefined as never })).toBe(true);
  });

  it("agrees with the saved plan's own rule for an iPhone it loads a plan onto without asking (isBlankPlan), where that code is present", async () => {
    // The saved-plan code lands separately (lib/plan-snapshot.ts). Until it is there, there is nothing to compare.
    const module = "../lib/plan-snapshot";
    const snapshot: { isBlankPlan?: (contents: { state: AppState }) => boolean } | null = await import(/* @vite-ignore */ module).catch(() => null);
    if (!snapshot?.isBlankPlan) return;
    const block = (type: string) => ({ id: type, type, title: type, date: "2026-10-05", startTime: "09:00", endTime: "10:00", locked: false, accepted: true }) as AppState["scheduleBlocks"][number];
    const samples: AppState[] = [
      createInitialState(),
      state({ onboardingComplete: true }),
      state({ deviceCalendarEvents: some }),
      state({ semester: { name: "Fall", startDate: "2026-09-01", endDate: "2026-12-18" } as AppState["semester"] }),
      state({ scheduleBlocks: [block("sleep"), block("buffer")] }),
      ...["class", "study", "work", "recurring", "free"].map((type) => state({ scheduleBlocks: [block(type)] })),
      ...(["classes", "tasks", "recurringEvents", "syllabusImports", "examPreps", "studyGuides", "practiceExams", "grades"] as const).map((key) => state({ [key]: some })),
    ];
    for (const sample of samples) {
      expect(holdsNoPlan(sample)).toBe(snapshot.isBlankPlan({ state: sample }));
    }
  });
});

describe("what the welcome screen's 'Sign out' may erase", () => {
  type Facts = Parameters<typeof noteEmptyAtSignIn>[1];
  const facts = (over: Partial<Facts> = {}): Facts => ({ account: "signed-in", hydrated: true, empty: true, planReady: false, ...over });
  /** Feeds the facts in order, as the root hook does at each change. */
  const after = (...steps: Facts[]) => steps.reduce<boolean | null>((noted, step) => noteEmptyAtSignIn(noted, step), null);

  it("erases only an iPhone that held no plan at sign-in; anything else, or not knowing, keeps everything", () => {
    expect(leaveSignInMode(true)).toBe("erase");
    expect(leaveSignInMode(false)).toBe("session-only");
    expect(leaveSignInMode(null)).toBe("session-only");
  });

  it("an iPhone without a plan signs in: empty, and still 'empty' when the account's plan lands on it before the plan is ready", () => {
    expect(after(facts())).toBe(true);
    // The saved plan arrives (the state is no longer empty) while "Getting your plan…" is still up: it is the
    // account's, not something the student made here.
    expect(after(facts(), facts({ empty: false }))).toBe(true);
  });

  it("an iPhone that held a plan at sign-in (made before accounts, or kept through a session that ended) never counts as empty", () => {
    expect(after(facts({ empty: false }))).toBe(false);
    // Not even if the plan on it is emptied later.
    expect(after(facts({ empty: false }), facts({ empty: true }))).toBe(false);
  });

  it("is noted only from a state that was loaded from disk: before that every iPhone looks empty", () => {
    expect(after(facts({ hydrated: false }))).toBeNull();
    expect(after(facts({ hydrated: false }), facts({ empty: false }))).toBe(false); // the real plan, once loaded
    expect(after(facts({ account: "loading" }))).toBeNull();
  });

  it("once the saved plan has been ready the student is inside the app: never 'empty' again while signed in", () => {
    expect(after(facts(), facts({ planReady: true }))).toBe(false);
    // Later the plan stops being settled again (the student is asked which plan to keep): what is on the iPhone
    // now may be theirs, whatever it looked like at sign-in.
    expect(after(facts(), facts({ planReady: true }), facts({ planReady: false }))).toBe(false);
    expect(after(facts(), facts({ planReady: true }), facts({ planReady: false, empty: true }))).toBe(false);
    // A launch that goes straight to "ready" (the usual one) never counts either.
    expect(after(facts({ planReady: true }))).toBe(false);
  });

  it("is forgotten at sign-out and noted anew at the next sign-in; signing out itself (account 'loading') keeps it", () => {
    expect(after(facts(), facts({ account: "signed-out" }))).toBeNull();
    expect(after(facts({ empty: false }), facts({ account: "signed-out" }), facts())).toBe(true);
    expect(after(facts(), facts({ account: "loading" }))).toBe(true);
    expect(after(facts({ empty: false }), facts({ account: "loading", empty: true }))).toBe(false);
  });
});

describe("signing out of a sign-in that cannot finish (the welcome screen's waiting states)", () => {
  it("only the session goes: nothing is asked, nothing is saved first, and nothing on the iPhone is erased", async () => {
    const calls: string[] = [];
    const outcome = await runSessionOnlySignOut({
      signedIn: () => true,
      logout: async () => void calls.push("logout"),
      setBusy: (busy) => void calls.push(busy ? "busy" : "idle"),
    });
    expect(outcome).toBe("signed-out");
    // (It is not even handed the means to erase or save: its dependencies are the session and the busy flag.)
    expect(calls).toEqual(["busy", "logout", "idle"]);
  });

  it("does nothing without a session, and is never left 'busy'", async () => {
    const calls: string[] = [];
    expect(await runSessionOnlySignOut({ signedIn: () => false, logout: async () => void calls.push("logout"), setBusy: (busy) => void calls.push(busy ? "busy" : "idle") })).toBe("cancelled");
    expect(calls).toEqual([]);
    await expect(
      runSessionOnlySignOut({
        logout: async () => {
          throw new Error("boom");
        },
        setBusy: (busy) => void calls.push(busy ? "busy" : "idle"),
      }),
    ).rejects.toThrow("boom");
    expect(calls).toEqual(["busy", "idle"]);
  });
});

function deletionDeps(over: Partial<AccountDeletionDeps> = {}) {
  const calls: string[] = [];
  const deps: AccountDeletionDeps = {
    confirm: async () => (calls.push("confirm"), true),
    prepare: async () => void calls.push("prepare"),
    deleteAccount: async () => (calls.push("delete"), { appleRevoked: true }),
    cancel: () => void calls.push("cancel"),
    wipe: async () => void calls.push("wipe"),
    logout: async () => void calls.push("logout"),
    setBusy: (busy) => void calls.push(busy ? "busy" : "idle"),
    ...over,
  };
  return { deps, calls };
}

describe("deleting the account", () => {
  it("asks first; stops saving; deletes on the server; erases the iPhone; drops the session", async () => {
    const { deps, calls } = deletionDeps();
    expect(await runAccountDeletion(deps)).toEqual({ outcome: "deleted", appleRevoked: true });
    expect(calls).toEqual(["confirm", "busy", "prepare", "delete", "wipe", "logout", "idle"]);
  });

  it("Cancel touches nothing", async () => {
    const { deps, calls } = deletionDeps({ confirm: async () => false });
    expect(await runAccountDeletion(deps)).toEqual({ outcome: "cancelled" });
    expect(calls).toEqual([]);
  });

  it("does nothing when the session ended while the question was open", async () => {
    const { deps, calls } = deletionDeps({ signedIn: () => false });
    expect(await runAccountDeletion(deps)).toEqual({ outcome: "cancelled" });
    expect(calls).toEqual(["confirm"]);
  });

  it("when the server did not delete the account: saving starts again, nothing is erased, the student stays signed in", async () => {
    const { deps, calls } = deletionDeps({
      deleteAccount: async () => {
        calls.push("delete");
        throw new TypeError("Network request failed");
      },
    });
    expect(await runAccountDeletion(deps)).toEqual({ outcome: "failed" });
    expect(calls).toEqual(["confirm", "busy", "prepare", "delete", "cancel", "idle"]);
    expect(calls).not.toContain("wipe");
    expect(calls).not.toContain("logout");
  });

  it("only claims the Apple revocation the server reports", async () => {
    for (const answer of [{ appleRevoked: false }, {}, null, undefined, { appleRevoked: "yes" as unknown as boolean }]) {
      const { deps } = deletionDeps({ deleteAccount: async () => answer });
      expect(await runAccountDeletion(deps)).toEqual({ outcome: "deleted", appleRevoked: false });
    }
  });

  it("an account the server deleted is signed out of even if the wipe or the save-stop failed", async () => {
    const { deps, calls } = deletionDeps({
      prepare: async () => {
        throw new Error("engine failed");
      },
      wipe: async () => {
        throw new Error("storage error");
      },
    });
    expect(await runAccountDeletion(deps)).toEqual({ outcome: "deleted", appleRevoked: true });
    expect(calls).toEqual(["confirm", "busy", "delete", "logout", "idle"]);
  });
});

describe("the save before leaving never keeps the app waiting for good", () => {
  afterEach(() => vi.useRealTimers());

  /** A prepareSignOut() that answers only when the test says so. */
  function slowPrepare() {
    let answer: (value: "saved" | "unsaved") => void = () => undefined;
    let fail: (error: unknown) => void = () => undefined;
    const calls: string[] = [];
    const bounded = boundedPreparation({
      prepare: () =>
        new Promise<"saved" | "unsaved">((resolve, reject) => {
          calls.push("prepare");
          answer = resolve;
          fail = reject;
        }),
      cancel: () => void calls.push("cancel"),
      timeoutMs: 20_000,
    });
    return { bounded, calls, answer: (value: "saved" | "unsaved") => answer(value), fail: (error: unknown) => fail(error) };
  }

  it("passes the answer through when it comes in time", async () => {
    vi.useFakeTimers();
    const saved = slowPrepare();
    const first = saved.bounded.prepare();
    saved.answer("saved");
    expect(await first).toBe("saved");

    const unsaved = slowPrepare();
    const second = unsaved.bounded.prepare();
    await vi.advanceTimersByTimeAsync(19_000);
    unsaved.answer("unsaved");
    expect(await second).toBe("unsaved");
  });

  it("says 'unanswered' when no answer came in time: not saved, and saving not known to have stopped", async () => {
    vi.useFakeTimers();
    const { bounded } = slowPrepare();
    const pending = bounded.prepare();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await pending).toBe("unanswered");
  });

  it("'Stay signed in' starts saving again once, when the answer came in time", async () => {
    vi.useFakeTimers();
    const { bounded, calls, answer } = slowPrepare();
    const pending = bounded.prepare();
    answer("unsaved");
    await pending;
    await vi.advanceTimersByTimeAsync(60_000);
    bounded.cancel();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toEqual(["prepare", "cancel"]);
  });

  it("after a late answer saving is started again once more (the late answer stopped it after the student chose to stay)", async () => {
    vi.useFakeTimers();
    const { bounded, calls, answer } = slowPrepare();
    const pending = bounded.prepare();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await pending).toBe("unanswered");
    bounded.cancel(); // "Stay signed in"
    expect(calls).toEqual(["prepare", "cancel"]);
    answer("saved"); // the save finishes now, and with it saving stops
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["prepare", "cancel", "cancel"]);
  });

  it("a late failure is handled the same way, and a failure in time is passed on", async () => {
    vi.useFakeTimers();
    const late = slowPrepare();
    const pending = late.bounded.prepare();
    await vi.advanceTimersByTimeAsync(20_000);
    await pending;
    late.bounded.cancel();
    late.fail(new Error("engine failed"));
    await vi.advanceTimersByTimeAsync(0);
    expect(late.calls).toEqual(["prepare", "cancel", "cancel"]);

    const early = slowPrepare();
    const failing = early.bounded.prepare();
    early.fail(new Error("engine failed"));
    await expect(failing).rejects.toThrow("engine failed");
  });

  it("the whole sign-out with a save that never answers: asked, then session first, then the wipe", async () => {
    vi.useFakeTimers();
    const { bounded } = slowPrepare();
    const calls: string[] = [];
    const running = runSignOut({
      confirm: async () => true,
      prepare: bounded.prepare,
      confirmUnsaved: async () => (calls.push("confirmUnsaved"), true),
      cancel: bounded.cancel,
      wipe: async () => void calls.push("wipe"),
      logout: async () => void calls.push("logout"),
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await running).toBe("signed-out");
    expect(calls).toEqual(["confirmUnsaved", "logout", "wipe"]);
  });
});

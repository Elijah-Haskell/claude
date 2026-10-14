// The rules of the plan saved to the account (lib/plan-sync.ts): the bookkeeping, the decision for every combination
// of "what this iPhone holds" and "what the account holds", and the words shown to the student.
import { describe, expect, it } from "vitest";

import {
  PLAN_SAFETY_COPY_STORAGE_KEY,
  PLAN_SYNC_COPY,
  PLAN_SYNC_STORAGE_KEY,
  PlanNoSessionError,
  PlanTooLargeError,
  SAME_SAVE_TOLERANCE_MS,
  classifyPlanSyncError,
  compareOutcome,
  decideSync,
  errorLabel,
  freshBookkeeping,
  newPlanDeviceId,
  ownUnansweredSave,
  parseBookkeeping,
  planSavedRowModel,
  rememberSentSave,
  retryDelayMs,
  savedTimeLabel,
  savedWhenPhrase,
  serializeBookkeeping,
  type PlanSyncBookkeeping,
  type PlanSyncStatus,
  type SyncFacts,
} from "../../src/lib/plan-sync";
import { APP_STORAGE_KEYS, isAppStorageKey } from "../../src/lib/account-deletion-utils";
import { PLAN_DEVICE_ID_PATTERN, type PlanHeader } from "../../src/shared/plan-sync";

const ME = "apple:001234.abcdef.0123";
const OTHER = "apple:009999.zzzzzz.9999";
const MY_DEVICE = "my-device-AAAAAAAAAAAAAA";
const THEIR_DEVICE = "their-device-BBBBBBBBBBB";
const T0 = "2026-10-05T15:00:00.000Z";
const later = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();

const header = (revision: number, overrides: Partial<PlanHeader> = {}): PlanHeader => ({ revision, savedAt: T0, deviceId: MY_DEVICE, chars: 15_000, ...overrides });

/** An iPhone whose plan is this account's, at revision 5, saved by itself at T0, nothing changed since. */
const mine = (overrides: Partial<SyncFacts> = {}): SyncFacts => ({
  account: ME, owner: ME, revision: 5, dirty: false, edited: false, savedBy: MY_DEVICE, serverSavedAt: T0,
  header: header(5), blank: false, ...overrides,
});
/** An iPhone that was never tied to an account. */
const untied = (overrides: Partial<SyncFacts> = {}): SyncFacts => ({
  account: ME, owner: null, revision: 0, dirty: false, edited: false, savedBy: null, serverSavedAt: null,
  header: null, blank: true, ...overrides,
});

const SETTLE_KEEP = { do: "settle", account: "keep" };
const SETTLE_EMPTY = { do: "settle", account: "empty" };
const ADOPT = { do: "save", over: "nothing" };
const SAVE = { do: "save", over: "revision" };
const ASK = { do: "compare", mine: "plan", whenDifferent: "ask", restore: false };
const LOAD_QUIETLY = { do: "compare", mine: "plan", whenDifferent: "load", restore: false };

describe("the bookkeeping", () => {
  it("lives under keys the device wipe removes", () => {
    for (const key of [PLAN_SYNC_STORAGE_KEY, PLAN_SAFETY_COPY_STORAGE_KEY]) {
      expect(key.startsWith("trajectory_")).toBe(true);
      expect(isAppStorageKey(key)).toBe(true);
      expect(APP_STORAGE_KEYS).toContain(key);
    }
  });

  it("a device id is random, made to the server's pattern, and different each time", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newPlanDeviceId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(PLAN_DEVICE_ID_PATTERN);
    expect(newPlanDeviceId(() => 0)).toMatch(PLAN_DEVICE_ID_PATTERN);
    expect(newPlanDeviceId(() => 0.999999)).toMatch(PLAN_DEVICE_ID_PATTERN);
    expect(newPlanDeviceId()).toHaveLength(24);
  });

  it("a fresh one belongs to no account and has nothing to save", () => {
    expect(freshBookkeeping(() => 0.5)).toEqual({ v: 1, owner: null, revision: 0, dirty: false, edited: false, lastSavedAt: null, deviceId: expect.stringMatching(PLAN_DEVICE_ID_PATTERN), hash: null, sent: [], savedBy: null, serverSavedAt: null });
  });

  it("round-trips", () => {
    const book: PlanSyncBookkeeping = { v: 1, owner: ME, revision: 12, dirty: true, edited: true, lastSavedAt: later(-60_000), deviceId: MY_DEVICE, hash: "abc-0123456789abcdef", sent: [{ hash: "abd-0123456789abcdee", chars: 15_004 }], savedBy: THEIR_DEVICE, serverSavedAt: T0 };
    expect(parseBookkeeping(serializeBookkeeping(book))).toEqual(book);
  });

  it("anything missing or damaged reads as an iPhone that was never tied to an account (the careful reading)", () => {
    for (const raw of [null, undefined, "", "{not json", "[]", "null", "42", JSON.stringify({ v: 2, owner: ME, revision: 9, deviceId: MY_DEVICE })]) {
      const book = parseBookkeeping(raw);
      expect(book, String(raw)).toMatchObject({ v: 1, owner: null, revision: 0, dirty: false, edited: false, lastSavedAt: null, hash: null, sent: [], savedBy: null, serverSavedAt: null });
      expect(book.deviceId).toMatch(PLAN_DEVICE_ID_PATTERN);
    }
  });

  it("keeps its device id, and drops what cannot be right", () => {
    const stored = { v: 1, owner: ME, revision: 3, dirty: "yes", edited: 1, lastSavedAt: 5, deviceId: MY_DEVICE, hash: 7, sent: "x", savedBy: null, serverSavedAt: T0 };
    expect(parseBookkeeping(JSON.stringify(stored))).toEqual({ v: 1, owner: ME, revision: 3, dirty: false, edited: false, lastSavedAt: null, deviceId: MY_DEVICE, hash: null, sent: [], savedBy: null, serverSavedAt: T0 });
    // A revision without an owner means nothing; nor does a revision that is not a positive whole number.
    expect(parseBookkeeping(JSON.stringify({ v: 1, owner: null, revision: 8, deviceId: MY_DEVICE, hash: "h", lastSavedAt: T0, savedBy: MY_DEVICE }))).toMatchObject({ owner: null, revision: 0, hash: null, lastSavedAt: null, savedBy: null });
    for (const revision of [-1, 2.5, "4", null]) expect(parseBookkeeping(JSON.stringify({ v: 1, owner: ME, revision, deviceId: MY_DEVICE })).revision).toBe(0);
    // An id the server would refuse is replaced.
    for (const deviceId of ["short", "has spaces in it!!", 12345678, "x".repeat(65)]) {
      const book = parseBookkeeping(JSON.stringify({ v: 1, owner: ME, revision: 3, deviceId }));
      expect(book.deviceId).not.toBe(deviceId);
      expect(book.deviceId).toMatch(PLAN_DEVICE_ID_PATTERN);
    }
    // Unanswered saves: only well-formed ones, a few at most.
    const sent = [{ hash: "a", chars: 10 }, { hash: "", chars: 10 }, { hash: "b", chars: 0 }, { hash: "c" }, "d", { hash: "e", chars: 12.5 }, { hash: "f", chars: 11 }, { hash: "g", chars: 12 }, { hash: "h", chars: 13 }, { hash: "i", chars: 14 }];
    expect(parseBookkeeping(JSON.stringify({ v: 1, owner: ME, revision: 3, deviceId: MY_DEVICE, sent })).sent).toEqual([{ hash: "a", chars: 10 }, { hash: "f", chars: 11 }, { hash: "g", chars: 12 }, { hash: "h", chars: 13 }]);
  });

  it("remembers the saves that left without an answer, newest first, the same plan once", () => {
    let sent = rememberSentSave([], { hash: "a", chars: 10 });
    sent = rememberSentSave(sent, { hash: "b", chars: 11 });
    sent = rememberSentSave(sent, { hash: "a", chars: 10 });
    expect(sent).toEqual([{ hash: "a", chars: 10 }, { hash: "b", chars: 11 }]);
    for (const hash of ["c", "d", "e"]) sent = rememberSentSave(sent, { hash, chars: 1 });
    expect(sent.map((save) => save.hash)).toEqual(["e", "d", "c", "a"]);
  });
});

describe("trying again", () => {
  it("waits 15 s, 30 s, 60 s, 2 min, then every 5 min", () => {
    expect([1, 2, 3, 4, 5, 6, 40].map(retryDelayMs)).toEqual([15_000, 30_000, 60_000, 120_000, 300_000, 300_000, 300_000]);
    expect(retryDelayMs(0)).toBe(15_000);
  });

  it("reads what went wrong from a tRPC client error", () => {
    const trpc = (code: string, httpStatus: number) => Object.assign(new Error(code), { name: "TRPCClientError", data: { code, httpStatus } });
    expect(classifyPlanSyncError(trpc("UNAUTHORIZED", 401))).toBe("unauthorized"); // expired session, or the account was deleted meanwhile
    expect(classifyPlanSyncError(trpc("FORBIDDEN", 403))).toBe("unauthorized"); // a guest session: no saved plan
    expect(classifyPlanSyncError(new PlanNoSessionError())).toBe("unauthorized");
    expect(classifyPlanSyncError(trpc("TOO_MANY_REQUESTS", 429))).toBe("rate-limited");
    expect(classifyPlanSyncError(trpc("PAYLOAD_TOO_LARGE", 413))).toBe("too-large");
    // The server itself failing (its database is down) is "could not reach it", never "nothing is saved".
    expect(classifyPlanSyncError(trpc("INTERNAL_SERVER_ERROR", 500))).toBe("unreachable");
    expect(classifyPlanSyncError(trpc("BAD_REQUEST", 400))).toBe("unreachable");
    expect(classifyPlanSyncError(trpc("TIMEOUT", 408))).toBe("unreachable");
    expect(classifyPlanSyncError(new TypeError("Network request failed"))).toBe("unreachable");
    expect(classifyPlanSyncError(Object.assign(new Error("Aborted"), { name: "AbortError" }))).toBe("unreachable");
    for (const odd of [null, undefined, "boom", 42, {}]) expect(classifyPlanSyncError(odd)).toBe("unreachable");
  });

  it("recognises a body the web server refused as too large before tRPC saw it (a plain HTTP 413)", () => {
    // As the transport names it (lib/plan-sync-client.ts), wrapped by the tRPC client as the cause.
    const wrapped = Object.assign(new Error("Too large."), { name: "TRPCClientError", cause: new PlanTooLargeError() });
    expect(classifyPlanSyncError(wrapped)).toBe("too-large");
    expect(classifyPlanSyncError(new PlanTooLargeError())).toBe("too-large");
    // As the tRPC client reports an answer it could not read: no code, only the response.
    const unreadable = Object.assign(new Error("Unable to transform response from server"), { name: "TRPCClientError", meta: { response: { status: 413 } } });
    expect(classifyPlanSyncError(unreadable)).toBe("too-large");
    expect(classifyPlanSyncError(Object.assign(new Error("x"), { meta: { response: { status: 401 } } }))).toBe("unauthorized");
    expect(classifyPlanSyncError(Object.assign(new Error("x"), { meta: { response: { status: 429 } } }))).toBe("rate-limited");
    expect(classifyPlanSyncError(Object.assign(new Error("x"), { meta: { response: { status: 502 } } }))).toBe("unreachable");
  });

  it("a log line names the error, never quotes it", () => {
    expect(errorLabel(Object.assign(new Error("snapshot H4sIA... was refused"), { name: "TRPCClientError", data: { code: "PAYLOAD_TOO_LARGE" } }))).toBe("PAYLOAD_TOO_LARGE");
    expect(errorLabel(new TypeError("Network request failed for https://api…?token=secret"))).toBe("TypeError");
    expect(errorLabel("boom")).toBe("unknown error");
    expect(errorLabel(null)).toBe("unknown error");
  });
});

describe("the rules: an iPhone that holds another account's plan", () => {
  it("never uploads it: the student is asked, whatever the account holds", () => {
    for (const facts of [mine({ owner: OTHER }), mine({ owner: OTHER, header: null }), mine({ owner: OTHER, dirty: true, edited: true }), mine({ owner: OTHER, header: header(9, { deviceId: THEIR_DEVICE }) })]) {
      expect(decideSync(facts)).toEqual({ do: "ask-other-account" });
    }
  });
});

describe("the rules: an iPhone that was never tied to an account (first sign-in on it)", () => {
  it("nothing saved, nothing here: done", () => {
    expect(decideSync(untied())).toEqual(SETTLE_EMPTY);
  });

  it("nothing saved, a plan here (made before accounts existed): it becomes the account's plan", () => {
    expect(decideSync(untied({ blank: false }))).toEqual(ADOPT);
  });

  it("a plan saved, nothing here: it is loaded (a new iPhone, a reinstall)", () => {
    expect(decideSync(untied({ header: header(7, { deviceId: THEIR_DEVICE }) }))).toEqual({ do: "compare", mine: "nothing", whenDifferent: "load", restore: true });
  });

  it("a plan on both sides: the student chooses (after the two were compared)", () => {
    expect(decideSync(untied({ blank: false, header: header(7, { deviceId: THEIR_DEVICE }) }))).toEqual({ do: "compare", mine: "plan", whenDifferent: "ask", restore: true });
  });

  it("flags left over in the bookkeeping make no difference", () => {
    expect(decideSync(untied({ dirty: true, edited: true }))).toEqual(SETTLE_EMPTY);
    expect(decideSync(untied({ blank: false, dirty: true, edited: true }))).toEqual(ADOPT);
  });
});

describe("the rules: an iPhone whose plan is this account's", () => {
  it("nothing saved (any more): this iPhone's plan is saved as the first one, unless there is none", () => {
    expect(decideSync(mine({ header: null }))).toEqual(ADOPT);
    expect(decideSync(mine({ header: null, dirty: true, edited: true }))).toEqual(ADOPT);
    expect(decideSync(mine({ header: null, blank: true }))).toEqual(SETTLE_EMPTY);
    expect(decideSync(mine({ header: null, revision: 0, blank: true, savedBy: null, serverSavedAt: null }))).toEqual(SETTLE_EMPTY);
  });

  it("the account is at this iPhone's revision: saved if anything changed, otherwise nothing to do", () => {
    expect(decideSync(mine())).toEqual(SETTLE_KEEP);
    expect(decideSync(mine({ dirty: true }))).toEqual(SAVE);
    expect(decideSync(mine({ dirty: true, edited: true }))).toEqual(SAVE);
    // A semester the student reset is an edit like any other: the emptied plan is saved.
    expect(decideSync(mine({ dirty: true, edited: true, blank: true }))).toEqual(SAVE);
    // But a plan that is empty without the student having emptied it is never saved over the account's: the
    // account's plan is compared with it, and comes back unless it is just as empty.
    expect(decideSync(mine({ dirty: true, edited: false, blank: true }))).toEqual({ do: "compare", mine: "nothing", whenDifferent: "load", restore: false });
    // The two times the server gives for one save may differ a little (rounding, two clocks).
    expect(decideSync(mine({ dirty: true, header: header(5, { savedAt: later(1_500) }) }))).toEqual(SAVE);
    expect(decideSync(mine({ header: header(5, { savedAt: "2026-10-05T15:00:00Z" }) }))).toEqual(SETTLE_KEEP);
    expect(decideSync(mine({ header: header(5, { savedAt: later(-SAME_SAVE_TOLERANCE_MS) }) }))).toEqual(SETTLE_KEEP);
    // A time that cannot be read proves nothing either way.
    expect(decideSync(mine({ dirty: true, header: header(5, { savedAt: "not a date" }) }))).toEqual(SAVE);
    expect(decideSync(mine({ dirty: true, serverSavedAt: null }))).toEqual(SAVE);
  });

  it("the same revision number but not the same save: the account's plan was started over elsewhere, so the two are compared", () => {
    for (const other of [header(5, { deviceId: THEIR_DEVICE }), header(5, { savedAt: later(SAME_SAVE_TOLERANCE_MS + 1) }), header(5, { savedAt: later(-3 * 3600_000) })]) {
      expect(decideSync(mine({ header: other }))).toEqual(ASK);
      expect(decideSync(mine({ header: other, dirty: true, edited: true }))).toEqual(ASK);
      expect(decideSync(mine({ header: other, dirty: true }))).toEqual(ASK); // never saved over on a number alone
      expect(decideSync(mine({ header: other, blank: true }))).toEqual({ do: "compare", mine: "nothing", whenDifferent: "load", restore: false });
      expect(decideSync(mine({ header: other, blank: true, dirty: true, edited: true }))).toEqual(ASK); // the student emptied it: their call
    }
  });

  it("the account is ahead: loaded quietly, unless the student changed something here", () => {
    const ahead = header(8, { deviceId: THEIR_DEVICE, savedAt: later(3600_000) });
    expect(decideSync(mine({ header: ahead }))).toEqual(LOAD_QUIETLY);
    // What the app re-planned by itself (dirty, not edited) gives way too: it is derived again from the loaded plan.
    expect(decideSync(mine({ header: ahead, dirty: true }))).toEqual(LOAD_QUIETLY);
    expect(decideSync(mine({ header: ahead, dirty: true, edited: true }))).toEqual(ASK);
    expect(decideSync(mine({ header: ahead, blank: true, dirty: true, edited: true }))).toEqual(ASK);
    expect(decideSync(mine({ header: ahead, blank: true }))).toEqual({ do: "compare", mine: "nothing", whenDifferent: "load", restore: false });
    // An iPhone that never had anything and receives the account's first plan: a plan coming back.
    expect(decideSync(mine({ header: header(1, { deviceId: THEIR_DEVICE }), revision: 0, blank: true, savedBy: null, serverSavedAt: null }))).toEqual({ do: "compare", mine: "nothing", whenDifferent: "load", restore: true });
    // Saved under this iPhone's own id: still compared (lib/plan-sync.ts ownUnansweredSave is asked first by the engine).
    expect(decideSync(mine({ header: header(6, { savedAt: later(60_000) }), dirty: true, edited: true }))).toEqual(ASK);
  });

  it("the account is behind (the server lost history): this iPhone's plan is saved over it, unless there is none", () => {
    const behind = header(3, { deviceId: THEIR_DEVICE, savedAt: later(-24 * 3600_000) });
    const TAKE_OVER = { do: "compare", mine: "plan", whenDifferent: "save", restore: false };
    expect(decideSync(mine({ header: behind }))).toEqual(TAKE_OVER);
    expect(decideSync(mine({ header: behind, dirty: true, edited: true }))).toEqual(TAKE_OVER);
    expect(decideSync(mine({ header: header(4, { savedAt: later(-60_000) }) }))).toEqual(TAKE_OVER);
    expect(decideSync(mine({ header: behind, blank: true }))).toEqual(SETTLE_KEEP);
    expect(decideSync(mine({ header: behind, blank: true, dirty: true, edited: true }))).toEqual(SETTLE_KEEP);
  });

  it("a lower revision that was saved AFTER the save this iPhone last saw is not lost history: someone started over, so the student is asked", () => {
    for (const restarted of [header(2, { deviceId: THEIR_DEVICE, savedAt: later(2 * 3600_000) }), header(1, { savedAt: later(SAME_SAVE_TOLERANCE_MS + 1) }), header(2, { savedAt: "not a date" })]) {
      expect(decideSync(mine({ header: restarted }))).toEqual(ASK);
      expect(decideSync(mine({ header: restarted, dirty: true, edited: true }))).toEqual(ASK);
      expect(decideSync(mine({ header: restarted, blank: true }))).toEqual({ do: "compare", mine: "nothing", whenDifferent: "load", restore: false });
    }
    expect(decideSync(mine({ header: header(2, { savedAt: later(-60_000) }), serverSavedAt: null }))).toEqual(ASK);
  });

  it("no rule ever saves over a revision this iPhone has not seen, and none asks for force", () => {
    const headers = [null, header(5), header(5, { deviceId: THEIR_DEVICE }), header(8, { deviceId: THEIR_DEVICE, savedAt: later(3600_000) }), header(3, { savedAt: later(-3600_000) }), header(3, { deviceId: THEIR_DEVICE, savedAt: later(3600_000) })];
    for (const owner of [null, ME]) for (const h of headers) for (const blank of [true, false]) for (const dirty of [true, false]) for (const edited of [true, false]) {
      if (edited && !dirty) continue;
      const facts = owner === null ? untied({ header: h, blank, dirty, edited }) : mine({ header: h, blank, dirty, edited });
      const step = decideSync(facts);
      expect(JSON.stringify(step)).not.toContain("force");
      // An empty plan is only ever sent when the student emptied it, and never as an account's first plan.
      if (step.do === "save" && blank) expect(edited && h !== null, JSON.stringify(facts)).toBe(true);
      if (step.do !== "save") continue;
      if (step.over === "nothing") expect(h, JSON.stringify(facts)).toBeNull();
      else expect(h?.revision === facts.revision && h.deviceId === facts.savedBy, JSON.stringify(facts)).toBe(true);
    }
  });
});

describe("a save whose answer was lost (the account's plan is this iPhone's own)", () => {
  const book = { deviceId: MY_DEVICE, revision: 5, sent: [{ hash: "plan-x", chars: 15_004 }] };

  it("is recognised: this iPhone's id, the next revision, the length of what it sent", () => {
    expect(ownUnansweredSave(header(6, { chars: 15_004, savedAt: later(5_000) }), book)).toEqual({ hash: "plan-x", chars: 15_004 });
  });

  it("is not assumed on the id alone (an iPhone set up from a backup carries the id of the one it was copied from)", () => {
    expect(ownUnansweredSave(header(6, { chars: 15_004 }), { ...book, sent: [] })).toBeNull(); // nothing of mine is unanswered
    expect(ownUnansweredSave(header(7, { chars: 15_004 }), book)).toBeNull(); // more than one save happened
    expect(ownUnansweredSave(header(5, { chars: 15_004 }), book)).toBeNull();
    expect(ownUnansweredSave(header(6, { chars: 15_100 }), book)).toBeNull(); // not what I sent
    expect(ownUnansweredSave(header(6, { chars: 15_004, deviceId: THEIR_DEVICE }), book)).toBeNull();
  });

  it("picks the right one of several unanswered saves, and none when the length cannot tell them apart", () => {
    const several = { ...book, sent: [{ hash: "plan-y", chars: 15_010 }, { hash: "plan-x", chars: 15_004 }] };
    expect(ownUnansweredSave(header(6, { chars: 15_004 }), several)?.hash).toBe("plan-x");
    expect(ownUnansweredSave(header(6, { chars: 15_010 }), several)?.hash).toBe("plan-y");
    expect(ownUnansweredSave(header(6, { chars: 15_004 }), { ...book, sent: [{ hash: "plan-z", chars: 15_004 }, { hash: "plan-x", chars: 15_004 }] })).toBeNull();
  });

  it("the first save of all (over nothing) counts too", () => {
    expect(ownUnansweredSave(header(1, { chars: 900 }), { deviceId: MY_DEVICE, revision: 0, sent: [{ hash: "first", chars: 900 }] })?.hash).toBe("first");
  });
});

describe("comparing the two plans (compareOutcome)", () => {
  const base = { serverHash: "server", localHash: "local", syncedHash: "synced", sentHashes: [] as string[], mine: "plan" as const };

  it("the same plan on both sides is never a question", () => {
    for (const whenDifferent of ["ask", "load", "save"] as const) for (const kind of ["plan", "nothing"] as const) {
      expect(compareOutcome({ ...base, localHash: "server", mine: kind, whenDifferent })).toBe("same");
    }
  });

  it("an iPhone with nothing of its own takes the account's plan", () => {
    for (const whenDifferent of ["ask", "load", "save"] as const) {
      expect(compareOutcome({ ...base, mine: "nothing", whenDifferent })).toBe("load");
      // Even when the account holds exactly what this iPhone last had: a lost copy is not a newer plan.
      expect(compareOutcome({ ...base, mine: "nothing", syncedHash: "server", sentHashes: ["server"], whenDifferent })).toBe("load");
    }
  });

  it("when the account holds a plan this iPhone already had (or sent), this iPhone's is the newer one: saved over it, no question", () => {
    for (const whenDifferent of ["ask", "load", "save"] as const) {
      expect(compareOutcome({ ...base, syncedHash: "server", whenDifferent })).toBe("save");
      expect(compareOutcome({ ...base, sentHashes: ["older", "server"], whenDifferent })).toBe("save");
    }
  });

  it("otherwise each side holds something the other has not seen, and the rule that led here decides", () => {
    expect(compareOutcome({ ...base, whenDifferent: "ask" })).toBe("ask");
    expect(compareOutcome({ ...base, whenDifferent: "load" })).toBe("load");
    expect(compareOutcome({ ...base, whenDifferent: "save" })).toBe("save");
    expect(compareOutcome({ ...base, syncedHash: null, sentHashes: ["something else"], whenDifferent: "ask" })).toBe("ask");
  });
});

describe("the words", () => {
  const now = new Date(2026, 9, 5, 15, 30, 0); // Mon 5 Oct 2026, 3:30 PM on the iPhone
  const at = (y: number, m: number, d: number, h: number, min: number) => new Date(y, m - 1, d, h, min).toISOString();

  it("says how long ago the plan was saved", () => {
    expect(savedTimeLabel(new Date(now.getTime() - 5_000).toISOString(), now)).toBe("Just now");
    expect(savedTimeLabel(new Date(now.getTime() - 59_000).toISOString(), now)).toBe("Just now");
    expect(savedTimeLabel(new Date(now.getTime() + 90_000).toISOString(), now)).toBe("Just now"); // the two clocks disagree
    expect(savedTimeLabel(new Date(now.getTime() - 60_000).toISOString(), now)).toBe("1 min ago");
    expect(savedTimeLabel(new Date(now.getTime() - 2 * 60_000 - 30_000).toISOString(), now)).toBe("2 min ago");
    expect(savedTimeLabel(new Date(now.getTime() - 59 * 60_000).toISOString(), now)).toBe("59 min ago");
    expect(savedTimeLabel(at(2026, 10, 5, 9, 5), now)).toBe("Today at 9:05 AM");
    expect(savedTimeLabel(at(2026, 10, 4, 23, 59), now)).toBe("Yesterday at 11:59 PM");
    expect(savedTimeLabel(at(2026, 10, 3, 12, 0), now)).toBe("Oct 3 at 12:00 PM");
    expect(savedTimeLabel(at(2026, 1, 9, 0, 7), now)).toBe("Jan 9 at 12:07 AM");
    expect(savedTimeLabel(at(2025, 12, 31, 18, 30), now)).toBe("Dec 31, 2025 at 6:30 PM");
    expect(savedTimeLabel(null, now)).toBeNull();
    expect(savedTimeLabel("not a date", now)).toBeNull();
  });

  it("asks the question with the date and time of the saved plan", () => {
    expect(savedWhenPhrase(at(2026, 10, 5, 14, 12), now)).toBe("today at 2:12 PM");
    expect(savedWhenPhrase(at(2026, 10, 4, 8, 0), now)).toBe("yesterday at 8:00 AM");
    expect(savedWhenPhrase(at(2026, 9, 28, 17, 45), now)).toBe("on Sep 28 at 5:45 PM");
    expect(savedWhenPhrase("nonsense", now)).toBe("");
    expect(PLAN_SYNC_COPY.chooseTitle).toBe("Which plan do you want to keep?");
    expect(PLAN_SYNC_COPY.chooseMessage(at(2026, 10, 3, 9, 30), now)).toBe("This iPhone has a plan, and your account has a different one, saved on Oct 3 at 9:30 AM. The other one will be replaced.");
    expect(PLAN_SYNC_COPY.chooseMessage("nonsense", now)).toBe("This iPhone has a plan, and your account has a different one. The other one will be replaced.");
    expect([PLAN_SYNC_COPY.useSavedPlan, PLAN_SYNC_COPY.keepThisPlan]).toEqual(["Use the saved plan", "Keep this iPhone's plan"]);
    expect(PLAN_SYNC_COPY.otherAccountMessage).toBe("This iPhone still holds the plan of another Trajectory account. Continuing replaces it with yours.");
    expect([PLAN_SYNC_COPY.otherAccountContinue, PLAN_SYNC_COPY.otherAccountSignOut]).toEqual(["Continue", "Sign out"]);
    expect([PLAN_SYNC_COPY.newerVersionTitle, PLAN_SYNC_COPY.newerVersionMessage]).toEqual(["Reload Trajectory", "Your account's plan was saved by a newer version of Trajectory. Reload this page to get the newest version and keep your plan saved."]);
    expect(PLAN_SYNC_COPY.feedsTitle).toBe("Your plan is back");
    expect(PLAN_SYNC_COPY.feedsMessage).toContain("One thing stays on each iPhone");
    expect(PLAN_SYNC_COPY.feedsMessage).toContain("under Calendars, then Course feeds");
    // No emoji, no exclamation marks, no em dashes in anything the student reads.
    for (const text of Object.values(PLAN_SYNC_COPY).map((value) => (typeof value === "function" ? value(T0, now) : value))) expect(text).not.toMatch(/[!—]|\p{Extended_Pictographic}/u);
  });

  it("the Settings row says where the saved plan stands", () => {
    const status = (overrides: Partial<PlanSyncStatus>): PlanSyncStatus => ({ phase: "ready", save: "saved", lastSavedAt: new Date(now.getTime() - 2 * 60_000).toISOString(), restoredFromAccount: false, ...overrides });
    expect(planSavedRowModel(status({ phase: "off" }), null, now)).toBeNull();
    expect(planSavedRowModel(status({}), null, now)).toEqual({ title: "Your plan", status: "Saved to your account · 2 min ago", tone: "ok", canRetry: false });
    expect(planSavedRowModel(status({ lastSavedAt: now.toISOString() }), null, now)?.status).toBe("Saved to your account · Just now");
    expect(planSavedRowModel(status({ lastSavedAt: at(2026, 10, 3, 12, 0) }), null, now)?.status).toBe("Saved to your account · Oct 3 at 12:00 PM");
    expect(planSavedRowModel(status({ lastSavedAt: null }), null, now)).toMatchObject({ status: "Nothing to save yet", tone: "ok" });
    expect(planSavedRowModel(status({ save: "saving" }), null, now)).toMatchObject({ status: "Saving…", tone: "busy", canRetry: false });
    expect(planSavedRowModel(status({ save: "waiting" }), null, now)).toMatchObject({ status: "Saving…", tone: "busy" });
    expect(planSavedRowModel(status({ save: "offline" }), null, now)).toMatchObject({ status: "Not saved yet · you're offline", tone: "attention", canRetry: true });
    expect(planSavedRowModel(status({ save: "too-large" }), null, now)).toMatchObject({ status: "Too large to save", tone: "attention", canRetry: false });
    expect(planSavedRowModel(status({ save: "offline" }), "newer-version", now)).toMatchObject({ status: "Update Trajectory to keep saving", tone: "attention" });
    expect(planSavedRowModel(status({ save: "offline" }), "unreadable", now)).toMatchObject({ tone: "attention" });
    expect(planSavedRowModel(status({ phase: "checking" }), null, now)).toMatchObject({ status: "Getting your plan…", tone: "busy" });
    expect(planSavedRowModel(status({ phase: "choose" }), null, now)).toMatchObject({ tone: "attention", canRetry: false });
    expect(planSavedRowModel(status({ phase: "unreachable" }), null, now)).toMatchObject({ tone: "attention", canRetry: true });
  });
});

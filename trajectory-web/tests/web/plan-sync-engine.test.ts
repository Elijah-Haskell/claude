// The engine of the plan saved to the account (lib/plan-sync-engine.ts), against a stand-in server that follows
// the contract of shared/plan-sync.ts, an in-memory iPhone and fake timers. No real server, no database.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decodePlanSnapshot, encodePlanSnapshot, isPristineState, preparePlan, stateForLoadedPlan, type PlanContents } from "../../src/lib/plan-snapshot";
import {
  PLAN_RATE_LIMIT_WAIT_MS,
  PLAN_SAFETY_COPY_STORAGE_KEY,
  PLAN_SAVE_MIN_INTERVAL_MS,
  PLAN_SAVE_QUIET_MS,
  PLAN_SIGN_OUT_WAIT_MS,
  PLAN_SYNC_STORAGE_KEY,
  PlanTooLargeError,
  parseBookkeeping,
  type PlanSafetyCopy,
  type PlanSyncBookkeeping,
} from "../../src/lib/plan-sync";
import { createPlanSyncEngine, type PlanSyncDevice, type PlanSyncEngine, type PlanSyncTransport } from "../../src/lib/plan-sync-engine";
import { createInitialState } from "../../src/engine/state-persistence";
import type { AppState, Task } from "../../src/engine/types";
import { PLAN_DEVICE_ID_PATTERN, type PlanHeader, type PlanSaveInput, type SavedPlan } from "../../src/shared/plan-sync";

const ME = "apple:001234.abcdef.0123";
const SOMEONE_ELSE = "apple:009999.zzzzzz.9999";
const OTHER_DEVICE = "other-iphone-BBBBBBBBBBBB";
const START = new Date("2026-10-05T15:00:00.000Z");

const SECOND = 1000;
const MINUTE = 60 * SECOND;

// ── Plans ─────────────────────────────────────────────────────

const task = (id: string, name = `Task ${id}`): Task => ({ id, name, courseId: "", courseName: "General", dueDate: "2026-10-20", estimatedMinutes: 60, difficulty: 3, requiresOnCampus: false, status: "pending", createdAt: "2026-09-01T00:00:00.000Z" });
const planWith = (...ids: string[]): AppState => ({ ...createInitialState(), onboardingComplete: true, tasks: ids.map((id) => task(id)) });
const contents = (state: AppState, extra: Partial<PlanContents> = {}): PlanContents => ({ state, feedLinks: {}, feedCount: 0, ...extra });
const hashOf = (state: AppState, extra: Partial<PlanContents> = {}) => preparePlan(contents(state, extra)).hash;
function snapshotOf(state: AppState, extra: Partial<PlanContents> = {}): string {
  const encoded = encodePlanSnapshot(preparePlan(contents(state, extra)).json);
  if (!encoded.ok) throw new Error("too large");
  return encoded.snapshot;
}
/** The task ids in a snapshot (what plan the account holds). */
function tasksIn(snapshot: string | undefined): string[] {
  const decoded = decodePlanSnapshot(snapshot);
  if (decoded.kind !== "plan") throw new Error(`not a plan: ${decoded.kind}`);
  return decoded.plan.state.tasks.map((t) => t.id);
}

const trpcError = (code: string, httpStatus: number) => Object.assign(new Error(code), { name: "TRPCClientError", data: { code, httpStatus } });
const offlineError = () => new TypeError("Network request failed");

// ── A stand-in server ─────────────────────────────────────────

function fakeServer() {
  let saved: SavedPlan | null = null;
  const calls: string[] = [];
  const saves: PlanSaveInput[] = [];
  let down: (() => unknown) | null = null;
  /** One-off behaviours, consumed by the next calls of that kind. */
  const nextSave: { fail?: () => unknown; loseAnswer?: boolean; before?: () => void; hold?: boolean }[] = [];
  const held: (() => void)[] = [];
  /** Kinds of call whose next one waits for release(). */
  const holding = new Set<string>();
  const maybeHold = async (kind: string) => {
    if (!holding.delete(kind)) return;
    await new Promise<void>((resolve) => held.push(resolve));
  };

  const store = (snapshot: string, deviceId: string): PlanHeader => {
    const header: PlanHeader = { revision: (saved?.header.revision ?? 0) + 1, savedAt: new Date(Date.now()).toISOString(), deviceId, chars: snapshot.length };
    saved = { header, snapshot };
    return header;
  };

  const transport: PlanSyncTransport = {
    async header() {
      calls.push("header");
      await maybeHold("header");
      if (down) throw down();
      return saved ? { ...saved.header } : null;
    },
    async load() {
      calls.push("load");
      await maybeHold("load");
      if (down) throw down();
      return saved ? { header: { ...saved.header }, snapshot: saved.snapshot } : null;
    },
    async save(input) {
      calls.push("save");
      saves.push(input);
      const special = nextSave.shift();
      if (special?.hold) await new Promise<void>((resolve) => held.push(resolve));
      if (down) throw down();
      if (special?.fail) throw special.fail();
      special?.before?.();
      expect(input.deviceId).toMatch(PLAN_DEVICE_ID_PATTERN);
      // The contract: stored only over the revision the device says it saw (0 = nothing saved yet).
      const current = saved?.header.revision ?? 0;
      if (!input.force && input.baseRevision !== current) {
        if (!saved) throw trpcError("INTERNAL_SERVER_ERROR", 500);
        return { saved: false, header: { ...saved.header } };
      }
      const header = store(input.snapshot, input.deviceId);
      if (special?.loseAnswer) throw offlineError();
      return { saved: true, header: { ...header } };
    },
  };

  return {
    transport,
    calls,
    saves,
    get saved() {
      return saved;
    },
    get revision() {
      return saved?.header.revision ?? 0;
    },
    /** Another device saves `state` (over whatever is there). */
    put(state: AppState, extra: Partial<PlanContents> = {}, deviceId = OTHER_DEVICE): PlanHeader {
      return store(snapshotOf(state, extra), deviceId);
    },
    putRaw(snapshot: string, deviceId = OTHER_DEVICE): PlanHeader {
      return store(snapshot, deviceId);
    },
    restore(plan: SavedPlan | null) {
      saved = plan;
    },
    goDown(error: () => unknown = offlineError) {
      down = error;
    },
    comeBack() {
      down = null;
    },
    onNextSave(special: (typeof nextSave)[number]) {
      nextSave.push(special);
    },
    /** The next call of that kind does not answer until release(). */
    holdNext(kind: "header" | "load") {
      holding.add(kind);
    },
    release() {
      held.splice(0).forEach((resolve) => resolve());
    },
    count(kind: string) {
      return calls.filter((call) => call === kind).length;
    },
  };
}

// ── An in-memory iPhone ───────────────────────────────────────

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const writes: string[] = [];
  let failing = false;
  let gate: Promise<void> | null = null;
  return {
    data,
    writes,
    failWrites(on: boolean) {
      failing = on;
    },
    /** Writes take their time: none lands until the returned function is called. */
    holdWrites(): () => void {
      let open: () => void = () => undefined;
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      return () => {
        gate = null;
        open();
      };
    },
    async getItem(key: string) {
      return data.get(key) ?? null;
    },
    async setItem(key: string, value: string) {
      if (gate) await gate;
      if (failing) throw new Error("disk full");
      writes.push(key);
      data.set(key, value);
    },
    book(): PlanSyncBookkeeping {
      return parseBookkeeping(data.get(PLAN_SYNC_STORAGE_KEY));
    },
    safetyCopy(): PlanSafetyCopy | null {
      const raw = data.get(PLAN_SAFETY_COPY_STORAGE_KEY);
      return raw ? (JSON.parse(raw) as PlanSafetyCopy) : null;
    },
  };
}

function fakePhone(storage: ReturnType<typeof fakeStorage>, initial: AppState) {
  const phone = {
    state: initial,
    feedLinks: {} as Record<string, string>,
    feedCount: 0,
    applied: 0,
    wipes: 0,
    failApply: false,
    /** The feed links cannot be read from storage. */
    failRead: false,
    /** Writing a loaded plan takes until releaseApply() is called. */
    holdApply: false,
    applying: false,
    releaseApply: (() => undefined) as () => void,
    /** The student tapped something React has not rendered yet. */
    editing: false,
    device: null as unknown as PlanSyncDevice,
  };
  phone.device = {
    state: () => phone.state,
    editing: () => phone.editing,
    read: async () => {
      if (phone.failRead) throw new Error("storage unavailable");
      return { state: phone.state, feedLinks: phone.feedLinks, feedCount: phone.feedCount };
    },
    apply: async (plan) => {
      if (phone.failApply) throw new Error("disk full");
      // As on the iPhone: the state is replaced at once, the stores and the disk take a moment.
      phone.state = stateForLoadedPlan(phone.state, plan);
      if (phone.holdApply) {
        phone.applying = true;
        await new Promise<void>((resolve) => {
          phone.releaseApply = resolve;
        });
        phone.applying = false;
      }
      phone.feedLinks = plan.feedLinks;
      phone.applied++;
      return { feedCount: phone.feedCount };
    },
    wipe: async () => {
      // Everything the app keeps, except the safety copy (components/plan-sync.tsx).
      phone.wipes++;
      phone.state = createInitialState();
      phone.feedLinks = {};
      phone.feedCount = 0;
      for (const key of [...storage.data.keys()]) if (key !== PLAN_SAFETY_COPY_STORAGE_KEY) storage.data.delete(key);
    },
  };
  return phone;
}

interface World {
  engine: PlanSyncEngine;
  server: ReturnType<typeof fakeServer>;
  storage: ReturnType<typeof fakeStorage>;
  phone: ReturnType<typeof fakePhone>;
  log: string[];
  idleWaits: () => number;
  pauses: () => number;
  /** The student changes the plan. */
  edit(state: AppState): void;
  /** The app changes it by itself (a re-plan). */
  replan(state: AppState): void;
  settle(): Promise<void>;
  wait(ms: number): Promise<void>;
}

function world(options: { state?: AppState; storage?: Record<string, string>; server?: ReturnType<typeof fakeServer> } = {}): World {
  const server = options.server ?? fakeServer();
  const storage = fakeStorage(options.storage);
  const phone = fakePhone(storage, options.state ?? createInitialState());
  const log: string[] = [];
  let idleWaits = 0;
  let pauses = 0;
  const engine = createPlanSyncEngine({
    transport: server.transport,
    storage,
    whenIdle: async () => {
      idleWaits++;
    },
    pause: async () => {
      pauses++;
    },
    log: (what, label) => log.push(`${what}: ${label}`),
  });
  const settle = async () => {
    await vi.advanceTimersByTimeAsync(0);
    await engine.idle();
    await vi.advanceTimersByTimeAsync(0);
  };
  return {
    engine, server, storage, phone, log,
    idleWaits: () => idleWaits,
    pauses: () => pauses,
    edit(state) {
      phone.state = state;
      engine.planChanged({ edited: true });
    },
    replan(state) {
      phone.state = state;
      engine.planChanged({ edited: false });
    },
    settle,
    async wait(ms) {
      await vi.advanceTimersByTimeAsync(ms);
      await engine.idle();
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

/** Signs in on a fresh world and waits until the engine has done what it does at that point. */
async function signIn(w: World, account = ME): Promise<void> {
  w.engine.attach(w.phone.device);
  w.engine.setAccount(account);
  await w.settle();
}

/**
 * An iPhone already in step with its account: the account holds `state` at revision `revision`, saved by this
 * iPhone, and the bookkeeping says so. The normal launch.
 */
function inStep(state: AppState, overrides: Partial<PlanSyncBookkeeping> = {}, revision = 3): World {
  const server = fakeServer();
  let header: PlanHeader | null = null;
  const deviceId = overrides.deviceId ?? "this-iphone-AAAAAAAAAAAA";
  for (let i = 0; i < revision; i++) header = server.put(state, {}, deviceId);
  const book: PlanSyncBookkeeping = {
    v: 1, owner: ME, revision, dirty: false, edited: false, lastSavedAt: START.toISOString(), deviceId,
    hash: hashOf(state), sent: [], savedBy: header!.deviceId, serverSavedAt: header!.savedAt, ...overrides,
  };
  return world({ state, server, storage: { [PLAN_SYNC_STORAGE_KEY]: JSON.stringify(book) } });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
});

// ───────────────────────────────────────────────────────────────

describe("nobody is signed in", () => {
  it("is off: nothing is asked of the server and nothing is sent, whatever changes", async () => {
    const w = world({ state: planWith("a") });
    w.engine.attach(w.phone.device);
    await w.settle();
    expect(w.engine.getStatus()).toMatchObject({ phase: "off", save: "saved", lastSavedAt: null, restoredFromAccount: false });
    w.edit(planWith("a", "b"));
    w.engine.appLeftForeground();
    w.engine.appBecameActive();
    w.engine.retry();
    await w.wait(10 * MINUTE);
    expect(w.server.calls).toEqual([]);
    expect(w.engine.getStatus().phase).toBe("off");
  });

  it("the status is the same object until something in it changes", async () => {
    const w = world();
    const before = w.engine.getStatus();
    let notified = 0;
    const off = w.engine.subscribe(() => notified++);
    w.engine.attach(w.phone.device);
    await w.settle();
    expect(w.engine.getStatus()).toBe(before);
    expect(notified).toBe(0);
    w.engine.setAccount(ME);
    expect(w.engine.getStatus()).not.toBe(before);
    expect(w.engine.getStatus().phase).toBe("checking");
    expect(notified).toBe(1);
    off();
    await w.settle();
    expect(notified).toBe(1);
  });
});

describe("first sign-in on an iPhone", () => {
  it("nothing here, nothing saved: ready, and the first plan the student makes is saved as the account's first", async () => {
    const w = world();
    await signIn(w);
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", save: "saved", lastSavedAt: null, restoredFromAccount: false });
    expect(w.server.calls).toEqual(["header"]);
    expect(w.storage.book()).toMatchObject({ owner: ME, revision: 0, dirty: false });

    w.edit(planWith("a"));
    expect(w.engine.getStatus().save).toBe("waiting");
    await w.wait(PLAN_SAVE_QUIET_MS);
    expect(w.server.saves).toHaveLength(1);
    expect(w.server.saves[0]).toMatchObject({ baseRevision: 0 });
    expect(w.server.saves[0]!.force).toBeUndefined();
    expect(tasksIn(w.server.saved?.snapshot)).toEqual(["a"]);
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", save: "saved", lastSavedAt: new Date(Date.now()).toISOString() });
    expect(w.storage.book()).toMatchObject({ owner: ME, revision: 1, dirty: false, edited: false, hash: hashOf(planWith("a")), sent: [] });
  });

  it("a plan here (made before accounts existed), nothing saved: it becomes the account's plan at once", async () => {
    const w = world({ state: planWith("a", "b") });
    await signIn(w);
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", save: "saved", restoredFromAccount: false });
    expect(w.server.calls).toEqual(["header", "save"]);
    expect(w.server.saves[0]).toMatchObject({ baseRevision: 0 });
    expect(tasksIn(w.server.saved?.snapshot)).toEqual(["a", "b"]);
    expect(w.storage.book()).toMatchObject({ owner: ME, revision: 1, dirty: false });
    expect(w.phone.applied).toBe(0);
  });

  it("nothing here, a plan saved: it is loaded (a new iPhone, a reinstall) and the student is told nothing", async () => {
    const server = fakeServer();
    const header = server.put(planWith("a", "b", "c"));
    const w = world({ server });
    await signIn(w);
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", save: "saved", restoredFromAccount: true, lastSavedAt: new Date(Date.now()).toISOString() });
    expect(w.phone.state.tasks.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(w.phone.state.onboardingComplete).toBe(true);
    expect(w.server.calls).toEqual(["header", "load"]);
    expect(w.storage.book()).toMatchObject({ owner: ME, revision: 1, dirty: false, hash: hashOf(planWith("a", "b", "c")), savedBy: OTHER_DEVICE, serverSavedAt: header.savedAt });
    expect(w.engine.getPrompt()).toEqual({ question: null, notice: null, blocked: null });
    expect(w.storage.safetyCopy()).toBeNull(); // nothing was replaced
    // And it is not saved straight back.
    await w.wait(5 * MINUTE);
    expect(w.server.count("save")).toBe(0);
  });

  it("a restored plan that had a course feed, on an iPhone without one: the student is told once to add the link again", async () => {
    const server = fakeServer();
    server.put(planWith("a"), { feedLinks: { "event-1": "a" }, feedCount: 1 });
    const w = world({ server });
    await signIn(w);
    const notice = w.engine.getPrompt().notice;
    expect(notice).toEqual({ kind: "feeds" });
    expect(w.phone.feedLinks).toEqual({ "event-1": "a" }); // the links came along, so adding the feed again imports nothing twice
    w.engine.dismissNotice(notice!);
    expect(w.engine.getPrompt().notice).toBeNull();

    // Not when this iPhone has a feed of its own, and not when the saved plan had none.
    const server2 = fakeServer();
    server2.put(planWith("a"), { feedCount: 1 });
    const w2 = world({ server: server2 });
    w2.phone.feedCount = 1;
    await signIn(w2);
    expect(w2.engine.getStatus().restoredFromAccount).toBe(true);
    expect(w2.engine.getPrompt().notice).toBeNull();
  });

  it("a plan on both sides: the student is asked, and until they answer nothing is replaced, sent or tried again", async () => {
    const server = fakeServer();
    const theirs = server.put(planWith("x", "y"));
    const w = world({ server, state: planWith("a") });
    await signIn(w);
    expect(w.engine.getStatus()).toMatchObject({ phase: "choose", restoredFromAccount: false });
    expect(w.engine.getPrompt().question).toEqual({ kind: "choose", savedAt: theirs.savedAt });
    expect(w.server.calls).toEqual(["header", "load"]);

    // Left unanswered for a day, with the app going away and coming back and changes still happening underneath.
    const savedBefore = w.server.saved;
    w.replan(planWith("a"));
    w.engine.appLeftForeground();
    w.engine.appBecameActive();
    w.engine.retry();
    await w.wait(24 * 60 * MINUTE);
    expect(w.server.calls).toEqual(["header", "load"]);
    expect(w.server.saved).toBe(savedBefore);
    expect(w.phone.state.tasks.map((t) => t.id)).toEqual(["a"]);
    expect(w.phone.applied).toBe(0);
    expect(w.storage.book().owner).toBeNull();
    expect(w.engine.getStatus().phase).toBe("choose");
  });

  it('"Use the saved plan": this iPhone\'s plan is kept as a safety copy first, then replaced', async () => {
    const server = fakeServer();
    server.put(planWith("x", "y"));
    const w = world({ server, state: planWith("a") });
    await signIn(w);
    const question = w.engine.getPrompt().question!;
    await w.wait(90 * SECOND);
    w.engine.answer(question, "use-saved");
    expect(w.engine.getPrompt().question).toBeNull();
    await w.settle();

    expect(w.phone.state.tasks.map((t) => t.id)).toEqual(["x", "y"]);
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", save: "saved", restoredFromAccount: true });
    expect(w.storage.book()).toMatchObject({ owner: ME, revision: 1, dirty: false, edited: false, hash: hashOf(planWith("x", "y")) });
    const copy = w.storage.safetyCopy()!;
    expect(copy).toMatchObject({ v: 1, why: "saved-plan-chosen", owner: null, at: new Date(Date.now()).toISOString() });
    expect(tasksIn(copy.snapshot)).toEqual(["a"]);
    // The account's plan was not touched.
    expect(w.server.count("save")).toBe(0);
    expect(tasksIn(w.server.saved?.snapshot)).toEqual(["x", "y"]);
  });

  it('"Keep this iPhone\'s plan": it is saved over exactly the plan the student was asked about, without force', async () => {
    const server = fakeServer();
    server.put(planWith("x", "y"));
    const w = world({ server, state: planWith("a") });
    await signIn(w);
    w.engine.answer(w.engine.getPrompt().question!, "keep-mine");
    await w.settle();

    expect(w.server.saves).toHaveLength(1);
    expect(w.server.saves[0]).toMatchObject({ baseRevision: 1 });
    expect(w.server.saves[0]!.force).toBeUndefined();
    expect(tasksIn(w.server.saved?.snapshot)).toEqual(["a"]);
    expect(w.server.revision).toBe(2);
    expect(w.phone.state.tasks.map((t) => t.id)).toEqual(["a"]);
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", save: "saved", restoredFromAccount: false });
    expect(w.storage.book()).toMatchObject({ owner: ME, revision: 2, dirty: false, edited: false });
    expect(w.storage.safetyCopy()).toBeNull();
  });

  it("\"Keep this iPhone's plan\" while yet another save arrived: that one was never looked at, so it is not overwritten and the student is asked again", async () => {
    const server = fakeServer();
    server.put(planWith("x"));
    const w = world({ server, state: planWith("a") });
    await signIn(w);
    const first = w.engine.getPrompt().question!;
    const newer = server.put(planWith("x", "z")); // a third save, after the question was put
    w.engine.answer(first, "keep-mine");
    await w.settle();

    expect(w.server.revision).toBe(2);
    expect(tasksIn(w.server.saved?.snapshot)).toEqual(["x", "z"]);
    expect(w.engine.getStatus().phase).toBe("choose");
    const second = w.engine.getPrompt().question!;
    expect(second).not.toBe(first);
    expect(second).toEqual({ kind: "choose", savedAt: newer.savedAt });
    // An answer to the old question does nothing.
    w.engine.answer(first, "use-saved");
    await w.settle();
    expect(w.phone.state.tasks.map((t) => t.id)).toEqual(["a"]);
    w.engine.answer(second, "keep-mine");
    await w.settle();
    expect(tasksIn(w.server.saved?.snapshot)).toEqual(["a"]);
    expect(w.engine.getStatus().phase).toBe("ready");
  });

  it("\"Keep this iPhone's plan\" while offline: the choice holds, and the plan is saved when the server is back", async () => {
    const server = fakeServer();
    server.put(planWith("x"));
    const w = world({ server, state: planWith("a") });
    await signIn(w);
    server.goDown();
    w.engine.answer(w.engine.getPrompt().question!, "keep-mine");
    await w.settle();
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", save: "offline" });
    expect(w.storage.book()).toMatchObject({ owner: ME, revision: 1, dirty: true, edited: true });
    server.comeBack();
    await w.wait(15 * SECOND);
    expect(tasksIn(w.server.saved?.snapshot)).toEqual(["a"]);
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", save: "saved" });
    expect(w.engine.getPrompt().question).toBeNull();
  });

  it('"Use the saved plan" tapped just as signing out begins: the plan is not replaced after the fact', async () => {
    const server = fakeServer();
    server.put(planWith("saved"));
    const w = world({ server, state: planWith("mine") });
    await signIn(w);
    const question = w.engine.getPrompt().question!;
    expect(question.kind).toBe("choose");
    const release = w.storage.holdWrites(); // the safety copy is still being written…
    w.engine.answer(question, "use-saved");
    await vi.advanceTimersByTimeAsync(0);
    expect(await w.engine.prepareSignOut({ save: false })).toBe("saved"); // …when signing out begins
    release();
    await w.wait(MINUTE);
    expect(w.phone.applied).toBe(0);
    expect(w.phone.state.tasks.map((t) => t.id)).toEqual(["mine"]);
  });

  it("the same plan on both sides is not a question", async () => {
    const server = fakeServer();
    server.put(planWith("a", "b"));
    const w = world({ server, state: planWith("a", "b") });
    await signIn(w);
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", save: "saved", restoredFromAccount: false });
    expect(w.engine.getPrompt().question).toBeNull();
    expect(w.server.calls).toEqual(["header", "load"]);
    expect(w.phone.applied).toBe(0);
    expect(w.storage.book()).toMatchObject({ owner: ME, revision: 1, dirty: false });
  });

  it("the plan on this iPhone could not be written: nothing is recorded as loaded, and it is tried again", async () => {
    const server = fakeServer();
    server.put(planWith("x"));
    const w = world({ server });
    w.phone.failApply = true;
    await signIn(w);
    expect(w.engine.getStatus().phase).toBe("unreachable");
    expect(w.storage.book()).toMatchObject({ owner: null, revision: 0 });
    w.phone.failApply = false;
    await w.wait(15 * SECOND);
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", restoredFromAccount: true });
    expect(w.phone.state.tasks.map((t) => t.id)).toEqual(["x"]);
  });
});

describe("the server cannot be reached at the first check", () => {
  it("an iPhone without a plan waits: a new plan must not be started over a saved one nobody could look at", async () => {
    const server = fakeServer();
    server.put(planWith("x"));
    server.goDown();
    const w = world({ server });
    await signIn(w);
    expect(w.engine.getStatus()).toMatchObject({ phase: "unreachable", restoredFromAccount: false });
    expect(w.storage.book().owner).toBeNull();

    // retry() asks again; still down.
    w.engine.retry();
    expect(w.engine.getStatus().phase).toBe("checking");
    await w.settle();
    expect(w.engine.getStatus().phase).toBe("unreachable");

    server.comeBack();
    w.engine.retry();
    await w.settle();
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", restoredFromAccount: true });
    expect(w.phone.state.tasks.map((t) => t.id)).toEqual(["x"]);
  });

  it("it also asks again by itself, and when the app comes back", async () => {
    const server = fakeServer();
    server.goDown();
    const w = world({ server });
    await signIn(w);
    expect(w.server.count("header")).toBe(1);
    await w.wait(15 * SECOND);
    expect(w.server.count("header")).toBe(2);
    expect(w.engine.getStatus().phase).toBe("unreachable");
    w.engine.appBecameActive();
    await w.settle();
    expect(w.server.count("header")).toBe(3);
    server.comeBack();
    await w.wait(60 * SECOND);
    expect(w.engine.getStatus().phase).toBe("ready");
  });

  it("the server itself failing (its database is down) is the same: never read as \"nothing is saved\"", async () => {
    const server = fakeServer();
    server.put(planWith("x"));
    server.goDown(() => trpcError("INTERNAL_SERVER_ERROR", 500));
    const w = world({ server });
    await signIn(w);
    expect(w.engine.getStatus().phase).toBe("unreachable");
    expect(w.storage.book().owner).toBeNull(); // not "tied to an empty account"
    expect(w.phone.state.tasks).toEqual([]);

    const w2 = world({ server, state: planWith("a") });
    await signIn(w2);
    expect(w2.engine.getStatus()).toMatchObject({ phase: "ready", save: "offline" });
    expect(w2.server.count("save")).toBe(0); // not adopted over a plan it could not look at
  });

  it("an iPhone with a plan of its own carries on, and the plan becomes the account's when the server answers", async () => {
    const server = fakeServer();
    server.goDown();
    const w = world({ server, state: planWith("a") });
    await signIn(w);
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", save: "offline", lastSavedAt: null });
    w.edit(planWith("a", "b"));
    await w.wait(20 * SECOND);
    expect(w.server.count("save")).toBe(0);
    server.comeBack();
    await w.wait(30 * SECOND);
    expect(tasksIn(w.server.saved?.snapshot)).toEqual(["a", "b"]);
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", save: "saved" });
    expect(w.storage.book()).toMatchObject({ owner: ME, revision: 1 });
  });

  it("…and if the account turns out to hold a different plan, the student is asked then", async () => {
    const server = fakeServer();
    server.put(planWith("x"));
    server.goDown();
    const w = world({ server, state: planWith("a") });
    await signIn(w);
    expect(w.engine.getStatus().phase).toBe("ready");
    server.comeBack();
    await w.wait(15 * SECOND);
    expect(w.engine.getStatus().phase).toBe("choose");
    expect(w.server.count("save")).toBe(0);
    expect(tasksIn(w.server.saved?.snapshot)).toEqual(["x"]);
  });
});

describe("a normal launch (this iPhone's plan is the account's)", () => {
  it("is ready at once, before the server has said anything", async () => {
    const w = inStep(planWith("a"));
    let answer: (() => void) | null = null;
    const header = w.server.transport.header;
    w.server.transport.header = () => new Promise((resolve, reject) => {
      answer = () => header().then(resolve, reject);
    });
    w.engine.attach(w.phone.device);
    w.engine.setAccount(ME);
    await vi.advanceTimersByTimeAsync(0); // only the bookkeeping has been read
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", save: "saved", lastSavedAt: START.toISOString() });
    expect(answer).not.toBeNull();
    answer!();
    await w.settle();
    expect(w.server.calls).toEqual(["header"]);
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", save: "saved" });
  });

  it("stays ready when the server cannot be reached, and says so only if something is unsaved", async () => {
    const w = inStep(planWith("a"));
    w.server.goDown();
    await signIn(w);
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", save: "saved" });
    w.edit(planWith("a", "b"));
    await w.wait(15 * SECOND);
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", save: "offline" });
  });

  it("changes left unsaved by the last run are saved right away", async () => {
    const w = inStep(planWith("a"), { dirty: true, edited: true });
    w.phone.state = planWith("a", "b"); // what the last run left on disk
    await signIn(w);
    expect(w.server.calls).toEqual(["header", "save"]);
    expect(w.server.saves[0]).toMatchObject({ baseRevision: 3 });
    expect(tasksIn(w.server.saved?.snapshot)).toEqual(["a", "b"]);
    expect(w.storage.book()).toMatchObject({ revision: 4, dirty: false, edited: false });
  });

  it("a change that leaves the plan as the account already has it is not sent", async () => {
    const w = inStep(planWith("a"));
    await signIn(w);
    w.replan({ ...planWith("a") }); // the launch re-plan produced the same plan again
    expect(w.engine.getStatus().save).toBe("waiting");
    expect(w.storage.book().dirty).toBe(true);
    await w.wait(PLAN_SAVE_QUIET_MS);
    expect(w.server.calls).toEqual(["header"]);
    expect(w.engine.getStatus()).toMatchObject({ save: "saved", lastSavedAt: START.toISOString() });
    expect(w.storage.book()).toMatchObject({ dirty: false, revision: 3 });
  });

  it("the first change is written to the bookkeeping at once, so a kill before the save loses nothing", async () => {
    const w = inStep(planWith("a"));
    await signIn(w);
    const writesBefore = w.storage.writes.length;
    w.edit(planWith("a", "b"));
    w.edit(planWith("a", "b", "c"));
    w.replan(planWith("a", "b", "c"));
    await vi.advanceTimersByTimeAsync(0);
    expect(w.storage.book()).toMatchObject({ dirty: true, edited: true });
    expect(w.storage.writes.length - writesBefore).toBe(1); // once, not at every change
    expect(w.server.count("save")).toBe(0);
  });

  it("a change made before the bookkeeping was read is not forgotten", async () => {
    const w = inStep(planWith("a"));
    w.engine.attach(w.phone.device);
    w.edit(planWith("a", "b")); // the very first moments of a launch
    w.engine.setAccount(ME);
    await w.settle();
    expect(tasksIn(w.server.saved?.snapshot)).toEqual(["a", "b"]);
    expect(w.server.revision).toBe(4);
  });
});

describe("when a change is saved", () => {
  it("after 8 seconds without another change, once", async () => {
    const w = inStep(planWith("a"));
    await signIn(w);
    w.edit(planWith("a", "b"));
    await w.wait(3 * SECOND);
    w.edit(planWith("a", "b", "c"));
    await w.wait(3 * SECOND);
    w.edit(planWith("a", "b", "c", "d"));
    await w.wait(PLAN_SAVE_QUIET_MS - 1);
    expect(w.server.count("save")).toBe(0);
    await w.wait(1);
    expect(w.server.count("save")).toBe(1);
    expect(tasksIn(w.server.saved?.snapshot)).toEqual(["a", "b", "c", "d"]);
    expect(w.server.saves[0]).toMatchObject({ baseRevision: 3 });
    await w.wait(5 * MINUTE);
    expect(w.server.count("save")).toBe(1);
    // The heavy work waited for a quiet moment, and the compression let the app breathe.
    expect(w.idleWaits()).toBeGreaterThan(0);
  });

  it("not more often than once in 45 seconds while the app stays open", async () => {
    const w = inStep(planWith("a"));
    await signIn(w);
    w.edit(planWith("a", "b"));
    await w.wait(PLAN_SAVE_QUIET_MS);
    expect(w.server.count("save")).toBe(1);
    const savedAt = Date.now();
    w.edit(planWith("a", "b", "c"));
    await w.wait(PLAN_SAVE_QUIET_MS);
    expect(w.server.count("save")).toBe(1); // 8 s of quiet, but too soon after the last save
    expect(w.engine.getStatus().save).toBe("waiting");
    await w.wait(savedAt + PLAN_SAVE_MIN_INTERVAL_MS - Date.now() - 1);
    expect(w.server.count("save")).toBe(1);
    await w.wait(1);
    expect(w.server.count("save")).toBe(2);
    expect(tasksIn(w.server.saved?.snapshot)).toEqual(["a", "b", "c"]);
  });

  it("changes that keep coming do not keep a save waiting for ever", async () => {
    const w = inStep(planWith("a"));
    await signIn(w);
    const ids = ["a"];
    for (let i = 0; i < 20; i++) {
      ids.push(`n${i}`);
      w.edit(planWith(...ids));
      await w.wait(5 * SECOND); // never 8 quiet seconds
    }
    expect(w.server.count("save")).toBeGreaterThanOrEqual(1);
    expect(w.server.count("save")).toBeLessThanOrEqual(2);
  });

  it("at once when the app goes to the background, without waiting for a quiet moment", async () => {
    const w = inStep(planWith("a"));
    await signIn(w);
    w.edit(planWith("a", "b"));
    await w.wait(1 * SECOND);
    const idleBefore = w.idleWaits();
    w.engine.appLeftForeground(); // "inactive"
    w.engine.appLeftForeground(); // then "background"
    await w.settle();
    expect(w.server.count("save")).toBe(1);
    expect(tasksIn(w.server.saved?.snapshot)).toEqual(["a", "b"]);
    expect(w.idleWaits()).toBe(idleBefore);
    expect(w.pauses()).toBe(0);
    // Nothing more when the timer would have fired.
    await w.wait(PLAN_SAVE_QUIET_MS);
    expect(w.server.count("save")).toBe(1);
  });

  it("the row says what is going on: waiting, saving, saved", async () => {
    const w = inStep(planWith("a"));
    await signIn(w);
    const seen: string[] = [];
    w.engine.subscribe(() => seen.push(w.engine.getStatus().save));
    w.server.onNextSave({ hold: true });
    w.edit(planWith("a", "b"));
    await vi.advanceTimersByTimeAsync(PLAN_SAVE_QUIET_MS);
    expect(w.engine.getStatus().save).toBe("saving");
    // A change while the save is on its way is not lost: it is saved next.
    w.edit(planWith("a", "b", "c"));
    w.server.release();
    await w.settle();
    expect(seen).toEqual(["waiting", "saving", "waiting"]);
    expect(w.storage.book()).toMatchObject({ revision: 4, dirty: true, edited: true });
    await w.wait(PLAN_SAVE_MIN_INTERVAL_MS);
    expect(tasksIn(w.server.saved?.snapshot)).toEqual(["a", "b", "c"]);
    expect(w.engine.getStatus().save).toBe("saved");
    expect(w.storage.book()).toMatchObject({ revision: 5, dirty: false, edited: false });
  });
});

describe("the server cannot be reached while saving", () => {
  it("says offline and tries again after 15 s, 30 s, 60 s, 2 min, then every 5 min", async () => {
    const w = inStep(planWith("a"));
    await signIn(w);
    w.server.goDown();
    w.edit(planWith("a", "b"));
    await w.wait(PLAN_SAVE_QUIET_MS);
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", save: "offline" });
    const attempts = () => w.server.calls.length;
    const base = attempts();
    const gaps = [15, 30, 60, 120, 300, 300];
    for (let i = 0; i < gaps.length; i++) {
      await w.wait(gaps[i]! * SECOND - 1);
      expect(attempts() - base, `before retry ${i + 1}`).toBe(i);
      await w.wait(1);
      expect(attempts() - base, `retry ${i + 1}`).toBe(i + 1);
    }
    // More changes meanwhile do not add attempts of their own.
    w.edit(planWith("a", "b", "c"));
    await w.wait(60 * SECOND);
    expect(attempts() - base).toBe(gaps.length);

    w.server.comeBack();
    await w.wait(300 * SECOND);
    expect(tasksIn(w.server.saved?.snapshot)).toEqual(["a", "b", "c"]);
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", save: "saved" });
    expect(w.log.every((line) => /^(save|header|load): /.test(line))).toBe(true);
  });

  it("coming back to the app, or tapping the row, tries at once", async () => {
    const w = inStep(planWith("a"));
    await signIn(w);
    w.server.goDown();
    w.edit(planWith("a", "b"));
    await w.wait(PLAN_SAVE_QUIET_MS);
    expect(w.engine.getStatus().save).toBe("offline");
    w.server.comeBack();
    w.engine.appBecameActive();
    await w.settle();
    expect(w.engine.getStatus().save).toBe("saved");
    expect(tasksIn(w.server.saved?.snapshot)).toEqual(["a", "b"]);

    w.server.goDown();
    w.edit(planWith("a", "b", "c"));
    await w.wait(PLAN_SAVE_MIN_INTERVAL_MS);
    expect(w.engine.getStatus().save).toBe("offline");
    w.server.comeBack();
    w.engine.retry();
    await w.settle();
    expect(w.engine.getStatus().save).toBe("saved");
    expect(tasksIn(w.server.saved?.snapshot)).toEqual(["a", "b", "c"]);
  });
});

describe("a save whose answer never arrived", () => {
  it("unchanged since: the plan the account holds is recognised as this iPhone's own. One more request, no question", async () => {
    const w = inStep(planWith("a"));
    await signIn(w);
    w.server.onNextSave({ loseAnswer: true });
    w.edit(planWith("a", "b"));
    await w.wait(PLAN_SAVE_QUIET_MS);
    // The server stored it; the iPhone only knows the request failed.
    expect(w.server.revision).toBe(4);
    expect(w.engine.getStatus().save).toBe("offline");
    expect(w.storage.book()).toMatchObject({ revision: 3, dirty: true, sent: [{ hash: hashOf(planWith("a", "b")), chars: w.server.saved!.header.chars }] });

    const before = w.server.calls.length;
    await w.wait(15 * SECOND);
    expect(w.server.calls.slice(before)).toEqual(["header"]); // one more request, and it is not a save
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", save: "saved" });
    expect(w.engine.getPrompt().question).toBeNull();
    expect(w.server.revision).toBe(4);
    expect(w.storage.book()).toMatchObject({ revision: 4, dirty: false, edited: false, hash: hashOf(planWith("a", "b")), sent: [] });
    await w.wait(10 * MINUTE);
    expect(w.server.calls.length).toBe(before + 1);
  });

  it("the student edits before the retry: saved again over it, at the next revision, and never a question", async () => {
    const w = inStep(planWith("a"));
    await signIn(w);
    const questions: unknown[] = [];
    w.engine.subscribe(() => questions.push(w.engine.getPrompt().question));
    w.server.onNextSave({ loseAnswer: true });
    w.edit(planWith("a", "b"));
    await w.wait(PLAN_SAVE_QUIET_MS);
    expect(w.server.revision).toBe(4);
    w.edit(planWith("a", "b", "c"));

    const before = w.server.calls.length;
    await w.wait(15 * SECOND);
    expect(w.server.calls.slice(before)).toEqual(["header", "save"]);
    expect(w.server.saves.at(-1)).toMatchObject({ baseRevision: 4 });
    expect(w.server.saves.at(-1)!.force).toBeUndefined();
    expect(w.server.revision).toBe(5);
    expect(tasksIn(w.server.saved?.snapshot)).toEqual(["a", "b", "c"]);
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", save: "saved" });
    expect(questions.every((q) => q === null)).toBe(true);
    expect(w.storage.book()).toMatchObject({ revision: 5, dirty: false, edited: false, sent: [] });
  });

  it("found out through a refused save (the lost one landed late): this iPhone's own id on the account's plan is not another device", async () => {
    const w = inStep(planWith("a"));
    await signIn(w);
    // The first save hangs past the transport's patience, and is given up as failed…
    const first = snapshotOf(planWith("a", "b"));
    w.server.onNextSave({ fail: offlineError });
    w.edit(planWith("a", "b"));
    await w.wait(PLAN_SAVE_QUIET_MS);
    expect(w.server.revision).toBe(3);
    w.edit(planWith("a", "b", "c"));
    // …the retry finds the account unchanged and sends the newer plan, but the first request reaches the server just
    // before it: the newer one is refused, and the plan now there carries this iPhone's own id.
    const myId = w.storage.book().deviceId;
    w.server.onNextSave({ before: () => void w.server.putRaw(first, myId) });
    await w.wait(15 * SECOND);

    expect(w.server.calls.slice(-3)).toEqual(["header", "save", "save"]);
    expect(w.server.saves.at(-2)).toMatchObject({ baseRevision: 3 });
    expect(w.server.saves.at(-1)).toMatchObject({ baseRevision: 4 });
    expect(w.server.count("load")).toBe(0);
    expect(w.server.revision).toBe(5);
    expect(tasksIn(w.server.saved?.snapshot)).toEqual(["a", "b", "c"]);
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", save: "saved" });
    expect(w.engine.getPrompt().question).toBeNull();
  });

  it("the same, found out by a refused retry of the unchanged plan: saved, with that one request", async () => {
    const w = inStep(planWith("a"));
    await signIn(w);
    const first = snapshotOf(planWith("a", "b"));
    w.server.onNextSave({ fail: offlineError });
    w.edit(planWith("a", "b"));
    await w.wait(PLAN_SAVE_QUIET_MS);
    const myId = w.storage.book().deviceId;
    w.server.onNextSave({ before: () => void w.server.putRaw(first, myId) });
    const before = w.server.calls.length;
    await w.wait(15 * SECOND);
    expect(w.server.calls.slice(before)).toEqual(["header", "save"]);
    expect(w.server.revision).toBe(4);
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", save: "saved" });
    expect(w.engine.getPrompt().question).toBeNull();
    expect(w.storage.book()).toMatchObject({ revision: 4, dirty: false, sent: [] });
  });

  it("after the app was killed in between: the next launch recognises it from the bookkeeping", async () => {
    const first = inStep(planWith("a"));
    await signIn(first);
    first.server.onNextSave({ loseAnswer: true });
    first.edit(planWith("a", "b"));
    await first.wait(PLAN_SAVE_QUIET_MS);
    // A new launch: same server, same storage, the plan as it was left on disk.
    const w = world({ server: first.server, state: planWith("a", "b"), storage: Object.fromEntries(first.storage.data) });
    const before = w.server.calls.length;
    await signIn(w);
    expect(w.server.calls.slice(before)).toEqual(["header"]);
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", save: "saved" });
    expect(w.storage.book()).toMatchObject({ revision: 4, dirty: false, sent: [] });
  });

  it("but this iPhone's id alone proves nothing: an iPhone set up from another's backup has the same id, and the other one's newer plan is loaded, not passed over", async () => {
    // The backup was taken at revision 3. The old iPhone (same id, as the backup copied it) went on to save revision 4.
    const w = inStep(planWith("a"));
    const sharedId = "this-iphone-AAAAAAAAAAAA";
    w.server.put(planWith("a", "made-on-the-old-iphone"), {}, sharedId);
    await signIn(w);
    expect(w.server.calls).toEqual(["header", "load"]);
    expect(w.phone.state.tasks.map((t) => t.id)).toEqual(["a", "made-on-the-old-iphone"]);
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", save: "saved", restoredFromAccount: false });
    expect(w.storage.book()).toMatchObject({ revision: 4, dirty: false });
    expect(w.server.count("save")).toBe(0);

    // And with a change of the student's own on the copy, it is a question like for any other device.
    const w2 = inStep(planWith("a"), { dirty: true, edited: true });
    w2.phone.state = planWith("a", "made-on-the-new-iphone");
    w2.server.put(planWith("a", "made-on-the-old-iphone"), {}, sharedId);
    await signIn(w2);
    expect(w2.engine.getStatus().phase).toBe("choose");
    expect(w2.server.count("save")).toBe(0);
  });
});

describe("another device saved in the meantime", () => {
  it("nothing of the student's changed here: the newer plan is loaded quietly, also over what the app re-planned by itself", async () => {
    const w = inStep(planWith("a"));
    await signIn(w);
    w.replan({ ...planWith("a"), tasks: [{ ...task("a"), priorityScore: 71 }] }); // the launch re-plan
    w.server.put(planWith("a", "from-the-other-device"));
    await w.wait(40 * SECOND);
    w.engine.appBecameActive();
    await w.settle();
    expect(w.phone.state.tasks.map((t) => t.id)).toEqual(["a", "from-the-other-device"]);
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", save: "saved", restoredFromAccount: false });
    expect(w.engine.getPrompt()).toEqual({ question: null, notice: null, blocked: null });
    expect(w.storage.safetyCopy()).toBeNull();
    expect(w.storage.book()).toMatchObject({ revision: 4, dirty: false, edited: false, savedBy: OTHER_DEVICE });
    expect(tasksIn(w.server.saved?.snapshot)).toEqual(["a", "from-the-other-device"]);
  });

  it("a tap that is still on its way through React counts as a change: the newer plan is not loaded over it without asking", async () => {
    const w = inStep(planWith("a"));
    await signIn(w);
    w.server.put(planWith("a", "from-the-other-device"));
    w.phone.editing = true; // dispatched a moment ago: not in the state yet, and nobody was told
    await w.wait(40 * SECOND);
    w.engine.appBecameActive();
    await w.settle();
    expect(w.engine.getStatus().phase).toBe("choose");
    expect(w.phone.applied).toBe(0);
    expect(w.phone.state.tasks.map((t) => t.id)).toEqual(["a"]);
  });

  it("the automatic save of a re-plan runs into it: refused, and the newer plan is loaded instead (no question)", async () => {
    const w = inStep(planWith("a"));
    await signIn(w);
    w.server.put(planWith("a", "from-the-other-device"));
    w.replan({ ...planWith("a"), tasks: [{ ...task("a"), priorityScore: 71 }] });
    await w.wait(PLAN_SAVE_QUIET_MS);
    expect(w.server.calls.slice(-2)).toEqual(["save", "load"]);
    expect(w.server.revision).toBe(4);
    expect(w.phone.state.tasks.map((t) => t.id)).toEqual(["a", "from-the-other-device"]);
    expect(w.engine.getStatus().phase).toBe("ready");
  });

  it("the student changed something here too: the save is refused, nothing is overwritten, and they choose", async () => {
    const w = inStep(planWith("a"));
    await signIn(w);
    const theirs = w.server.put(planWith("a", "from-the-other-device"));
    w.edit(planWith("a", "mine"));
    await w.wait(PLAN_SAVE_QUIET_MS);
    expect(w.server.calls.slice(-2)).toEqual(["save", "load"]);
    expect(w.server.saves.at(-1)).toMatchObject({ baseRevision: 3 });
    expect(w.engine.getStatus().phase).toBe("choose");
    expect(w.engine.getPrompt().question).toEqual({ kind: "choose", savedAt: theirs.savedAt });
    expect(tasksIn(w.server.saved?.snapshot)).toEqual(["a", "from-the-other-device"]);
    expect(w.phone.state.tasks.map((t) => t.id)).toEqual(["a", "mine"]);
    // Unanswered, it does not keep sending saves (refused saves count toward the server's limit).
    await w.wait(60 * MINUTE);
    expect(w.server.count("save")).toBe(1);

    w.engine.answer(w.engine.getPrompt().question!, "use-saved");
    await w.settle();
    expect(w.phone.state.tasks.map((t) => t.id)).toEqual(["a", "from-the-other-device"]);
    expect(tasksIn(w.storage.safetyCopy()?.snapshot)).toEqual(["a", "mine"]);
    expect(w.storage.safetyCopy()).toMatchObject({ owner: ME, why: "saved-plan-chosen" });
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", restoredFromAccount: true });
  });

  it("found at launch, with changes of the student's waiting: they choose before anything is sent", async () => {
    const w = inStep(planWith("a"), { dirty: true, edited: true });
    w.phone.state = planWith("a", "mine");
    w.server.put(planWith("a", "theirs"));
    await signIn(w);
    expect(w.engine.getStatus().phase).toBe("choose");
    expect(w.server.calls).toEqual(["header", "load"]);
  });

  it("a server that keeps refusing is not hammered", async () => {
    const w = inStep(planWith("a"));
    await signIn(w);
    // Every save is refused, and each time the account's plan is one this iPhone already has: a server gone wrong.
    const refuse = w.server.transport.save;
    w.server.transport.save = async (input) => {
      await refuse({ ...input, baseRevision: -1 }).catch(() => undefined);
      return { saved: false, header: { ...w.server.saved!.header } };
    };
    w.edit(planWith("a", "b"));
    await w.wait(PLAN_SAVE_QUIET_MS);
    expect(w.server.count("save")).toBeLessThanOrEqual(3);
    expect(w.engine.getStatus().save).toBe("offline");
    const after = w.server.count("save");
    await w.wait(14 * SECOND);
    expect(w.server.count("save")).toBe(after);
  });
});

describe("the server lost history (the account is behind what this iPhone has seen)", () => {
  it("this iPhone's plan is saved over it, over the revision it found and without force", async () => {
    const w = inStep(planWith("a", "b"), {}, 5);
    const old: SavedPlan = { header: { revision: 2, savedAt: new Date(START.getTime() - 24 * 60 * MINUTE).toISOString(), deviceId: OTHER_DEVICE, chars: 1 }, snapshot: snapshotOf(planWith("a")) };
    w.server.restore({ ...old, header: { ...old.header, chars: old.snapshot.length } });
    await signIn(w);
    expect(w.server.calls).toEqual(["header", "load", "save"]);
    expect(w.server.saves[0]).toMatchObject({ baseRevision: 2 });
    expect(w.server.saves[0]!.force).toBeUndefined();
    expect(tasksIn(w.server.saved?.snapshot)).toEqual(["a", "b"]);
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", save: "saved" });
    expect(w.storage.book()).toMatchObject({ revision: 3, dirty: false });
  });

  it("but a lower revision saved after this iPhone's last one is someone starting over: the student is asked", async () => {
    const w = inStep(planWith("a", "b"), {}, 5);
    w.server.restore(null);
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    w.server.put(planWith("fresh-start")); // revision 1, an hour later
    await signIn(w);
    expect(w.engine.getStatus().phase).toBe("choose");
    expect(w.server.count("save")).toBe(0);
    expect(tasksIn(w.server.saved?.snapshot)).toEqual(["fresh-start"]);
  });

  it("the account's plan is gone altogether: this iPhone's becomes its first again", async () => {
    const w = inStep(planWith("a", "b"), {}, 5);
    w.server.restore(null);
    await signIn(w);
    expect(w.server.saves[0]).toMatchObject({ baseRevision: 0 });
    expect(w.server.revision).toBe(1);
    expect(w.storage.book()).toMatchObject({ revision: 1, dirty: false });
  });
});

describe("this iPhone lost its own copy (a state as new as a fresh install's, with a revision on record)", () => {
  it("is not ready at once: the account's plan comes back first", async () => {
    const w = inStep(planWith("a", "b"), { dirty: true, edited: true });
    w.phone.state = createInitialState();
    w.engine.attach(w.phone.device);
    w.engine.setAccount(ME);
    await vi.advanceTimersByTimeAsync(0);
    expect(w.engine.getStatus().phase).not.toBe("off");
    await w.settle();
    expect(w.phone.state.tasks.map((t) => t.id)).toEqual(["a", "b"]);
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", restoredFromAccount: true });
    expect(w.server.count("save")).toBe(0);
    expect(tasksIn(w.server.saved?.snapshot)).toEqual(["a", "b"]);
  });

  it("and without the server it waits, instead of letting a new plan be started over the saved one", async () => {
    const w = inStep(planWith("a", "b"));
    w.phone.state = createInitialState();
    w.server.goDown();
    await signIn(w);
    expect(w.engine.getStatus().phase).toBe("unreachable");
  });

  it("onboarding being finished again before the server answers does not turn the lost copy into an emptied plan to save", async () => {
    const w = inStep(planWith("a", "b"));
    w.phone.state = createInitialState();
    w.server.holdNext("header");
    w.engine.attach(w.phone.device);
    w.engine.setAccount(ME);
    await vi.advanceTimersByTimeAsync(0);
    expect(w.engine.getStatus().phase).toBe("checking");
    // The state is no longer the one a fresh install starts from, and it was the student's doing.
    w.edit({ ...createInitialState(), onboardingComplete: true });
    w.server.release();
    await w.settle();
    expect(w.phone.state.tasks.map((t) => t.id)).toEqual(["a", "b"]);
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", restoredFromAccount: true });
    await w.wait(10 * MINUTE);
    expect(w.server.count("save")).toBe(0);
    expect(tasksIn(w.server.saved?.snapshot)).toEqual(["a", "b"]);
  });

  it("nor when that happened before the session even started (what counts is the state the app started with)", async () => {
    const w = inStep(planWith("a", "b"));
    w.phone.state = createInitialState();
    w.engine.attach(w.phone.device);
    w.edit({ ...createInitialState(), onboardingComplete: true, userPrefs: { ...createInitialState().userPrefs, scheduleIntensity: 80 } });
    w.engine.setAccount(ME);
    await w.settle();
    expect(w.phone.state.tasks.map((t) => t.id)).toEqual(["a", "b"]);
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", restoredFromAccount: true });
    expect(w.server.count("save")).toBe(0);
  });

  it("a plan the student built in the meantime is theirs, though: then it is a question, not a silent load", async () => {
    const w = inStep(planWith("a", "b"));
    w.phone.state = createInitialState();
    w.server.goDown();
    await signIn(w);
    w.edit(planWith("started-over"));
    w.server.comeBack();
    w.engine.retry();
    await w.settle();
    expect(w.engine.getStatus().phase).toBe("choose");
    expect(w.phone.state.tasks.map((t) => t.id)).toEqual(["started-over"]);
    expect(w.server.count("save")).toBe(0);
  });
});

describe("what a wipe leaves behind is never saved", () => {
  it("the pristine state is not sent, whatever led to a save", async () => {
    const w = inStep(planWith("a"));
    await signIn(w);
    // A wipe that nobody announced (prepareSignOut was not called): the state is suddenly a fresh install's.
    w.edit(createInitialState());
    await w.wait(10 * MINUTE);
    w.engine.appLeftForeground();
    await w.settle();
    expect(w.server.count("save")).toBe(0);
    expect(tasksIn(w.server.saved?.snapshot)).toEqual(["a"]);
    expect(isPristineState(w.phone.state)).toBe(true);
  });

  it("an emptied plan is not saved as an account's first plan either", async () => {
    const w = world({ state: { ...createInitialState(), onboardingComplete: true } });
    await signIn(w);
    w.edit({ ...createInitialState(), onboardingComplete: true, userPrefs: { ...createInitialState().userPrefs, scheduleIntensity: 80 } });
    await w.wait(5 * MINUTE);
    expect(w.server.count("save")).toBe(0);
    expect(w.engine.getStatus().save).toBe("saved");
  });

  it("a plan that became empty without the student emptying it is not saved over the account's: the account's plan comes back", async () => {
    const w = inStep(planWith("a", "b"));
    await signIn(w);
    w.replan({ ...createInitialState(), onboardingComplete: true }); // empty, by no doing of the student's
    await w.wait(PLAN_SAVE_QUIET_MS);
    expect(w.server.count("save")).toBe(0);
    expect(tasksIn(w.server.saved?.snapshot)).toEqual(["a", "b"]);
    expect(w.phone.state.tasks.map((t) => t.id)).toEqual(["a", "b"]);
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", save: "saved" });
    // Also when the app goes to the background right away.
    const w2 = inStep(planWith("a", "b"));
    await signIn(w2);
    w2.replan({ ...createInitialState(), onboardingComplete: true });
    w2.engine.appLeftForeground();
    await w2.settle();
    expect(w2.server.count("save")).toBe(0);
    expect(w2.phone.state.tasks.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("but a semester the student reset is their decision: the emptied plan is saved", async () => {
    const w = inStep(planWith("a", "b"));
    await signIn(w);
    w.edit({ ...createInitialState(), onboardingComplete: true }); // Reset Semester
    await w.wait(PLAN_SAVE_QUIET_MS);
    expect(w.server.revision).toBe(4);
    expect(tasksIn(w.server.saved?.snapshot)).toEqual([]);
  });
});

describe("signing out", () => {
  it("first saves what the account does not have yet, then stops everything", async () => {
    const w = inStep(planWith("a"));
    await signIn(w);
    w.edit(planWith("a", "b"));
    const answer = w.engine.prepareSignOut();
    await w.settle();
    expect(await answer).toBe("saved");
    expect(tasksIn(w.server.saved?.snapshot)).toEqual(["a", "b"]);
    expect(w.server.revision).toBe(4);

    // The wipe: the state is emptied, storage is cleared. Nothing of it may reach the account, and nothing is written.
    const callsBefore = w.server.calls.length;
    const writesBefore = w.storage.writes.length;
    w.storage.data.clear();
    w.edit(createInitialState());
    w.edit({ ...createInitialState(), onboardingComplete: true });
    w.edit(planWith("someone-typing-during-the-wipe"));
    w.engine.appLeftForeground();
    w.engine.appBecameActive();
    w.engine.retry();
    await w.wait(30 * MINUTE);
    expect(w.server.calls.length).toBe(callsBefore);
    expect(w.storage.writes.length).toBe(writesBefore);
    expect(w.storage.data.size).toBe(0);
    expect(tasksIn(w.server.saved?.snapshot)).toEqual(["a", "b"]);
    expect(await w.engine.prepareSignOut()).toBe("saved"); // asked twice: the same answer, still stopped

    w.engine.setAccount(null);
    expect(w.engine.getStatus()).toMatchObject({ phase: "off", lastSavedAt: null });
    await w.wait(30 * MINUTE);
    expect(w.server.calls.length).toBe(callsBefore);
    expect(w.storage.writes.length).toBe(writesBefore);
  });

  it("offline: \"unsaved\" after a few seconds at most, so the student can be warned", async () => {
    const w = inStep(planWith("a"));
    await signIn(w);
    w.edit(planWith("a", "b"));
    w.server.onNextSave({ hold: true });
    let answer: string | null = null;
    void w.engine.prepareSignOut().then((value) => {
      answer = value;
    });
    await vi.advanceTimersByTimeAsync(PLAN_SIGN_OUT_WAIT_MS - 1);
    expect(answer).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(answer).toBe("unsaved");
    // The save arrives after all, while the device is being wiped: its answer is not written anywhere.
    const writesBefore = w.storage.writes.length;
    w.storage.data.clear();
    w.server.release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(w.storage.writes.length).toBe(writesBefore);
    expect(w.storage.data.size).toBe(0);
  });

  it("a check that was on its way when signing out began does nothing when its answer arrives after the wipe", async () => {
    // Without this, the emptied iPhone would look like one that lost its copy, and the plan would be loaded right
    // back onto a signed-out iPhone.
    for (const save of [true, false]) {
      const w = inStep(planWith("a", "b"));
      w.server.holdNext("header");
      w.engine.attach(w.phone.device);
      w.engine.setAccount(ME);
      await vi.advanceTimersByTimeAsync(0);
      expect(w.engine.getStatus().phase).toBe("ready");
      const answer = w.engine.prepareSignOut({ save });
      await vi.advanceTimersByTimeAsync(PLAN_SIGN_OUT_WAIT_MS);
      expect(await answer).toBe("saved");
      await w.phone.device.wipe();
      const writesBefore = w.storage.writes.length;
      w.server.release();
      await vi.advanceTimersByTimeAsync(10 * MINUTE);
      expect(w.server.calls).toEqual(["header"]);
      expect(w.phone.applied).toBe(0);
      expect(isPristineState(w.phone.state)).toBe(true);
      expect(w.storage.writes.length).toBe(writesBefore);
      expect(w.storage.data.size).toBe(0);
      expect(tasksIn(w.server.saved?.snapshot)).toEqual(["a", "b"]);
    }
  });

  it("a plan that was being loaded when signing out began is not recorded, and nothing follows it", async () => {
    const w = inStep(planWith("a"));
    w.server.put(planWith("a", "from-the-other-device"));
    w.server.holdNext("load");
    w.engine.attach(w.phone.device);
    w.engine.setAccount(ME);
    await vi.advanceTimersByTimeAsync(0);
    expect(w.server.calls).toEqual(["header", "load"]);
    expect(await w.engine.prepareSignOut({ save: false })).toBe("saved");
    await w.phone.device.wipe();
    w.server.release();
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(w.phone.applied).toBe(0);
    expect(isPristineState(w.phone.state)).toBe(true);
    expect(w.storage.data.size).toBe(0);
    expect(w.server.count("save")).toBe(0);
  });

  it("a plan that is being written to this iPhone when signing out begins is let finish first: prepareSignOut answers only then", async () => {
    // Whoever asked is about to wipe the iPhone. A plan still being written would land after that wipe, and stay
    // on an iPhone nobody is signed in on (the next account to sign in on it would be handed it).
    for (const save of [true, false]) {
      const server = fakeServer();
      server.put(planWith("saved"));
      const w = world({ server });
      w.phone.holdApply = true;
      w.engine.attach(w.phone.device);
      w.engine.setAccount(ME);
      await vi.advanceTimersByTimeAsync(0);
      expect(w.phone.applying).toBe(true);
      let answer: string | null = null;
      void w.engine.prepareSignOut({ save }).then((value) => {
        answer = value;
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(answer, String(save)).toBeNull();
      w.phone.releaseApply();
      await vi.advanceTimersByTimeAsync(0);
      expect(answer, String(save)).toBe("saved");
      expect(w.phone.applied).toBe(1);
      // Deleting the account stopped everything at once: the load that finished afterwards is not recorded.
      if (!save) expect(w.storage.book()).toMatchObject({ owner: null, revision: 0 });
    }
  });

  it("…but not for ever: storage that hangs does not hang signing out", async () => {
    const server = fakeServer();
    server.put(planWith("saved"));
    const w = world({ server });
    w.phone.holdApply = true;
    w.engine.attach(w.phone.device);
    w.engine.setAccount(ME);
    await vi.advanceTimersByTimeAsync(0);
    let answer: string | null = null;
    void w.engine.prepareSignOut({ save: false }).then((value) => {
      answer = value;
    });
    await vi.advanceTimersByTimeAsync(PLAN_SIGN_OUT_WAIT_MS - 1);
    expect(answer).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(answer).toBe("saved");
    // Asked again while it still hangs: the same patience, the same answer.
    let again: string | null = null;
    void w.engine.prepareSignOut({ save: false }).then((value) => {
      again = value;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(again).toBeNull();
    w.phone.releaseApply();
    await vi.advanceTimersByTimeAsync(0);
    expect(again).toBe("saved");
  });

  it("nothing at all is written between prepareSignOut and the next sign-in, not even a first bookkeeping record", async () => {
    const w = world();
    expect(await w.engine.prepareSignOut({ save: false })).toBe("saved"); // nobody signed in: still stops everything
    w.engine.attach(w.phone.device);
    w.edit(planWith("a"));
    w.engine.appLeftForeground();
    await w.wait(10 * MINUTE);
    expect(w.storage.writes).toEqual([]);
    expect(w.server.calls).toEqual([]);
    // The next sign-in ends it.
    w.engine.setAccount(ME);
    await w.settle();
    expect(w.storage.writes.length).toBeGreaterThan(0);
    expect(w.engine.getStatus().phase).toBe("ready");
    expect(tasksIn(w.server.saved?.snapshot)).toEqual(["a"]);
  });

  it("\"unsaved\" at once when the server is known to be unreachable, and \"saved\" when only the app's own re-plan is unsaved", async () => {
    const w = inStep(planWith("a"));
    await signIn(w);
    w.server.goDown();
    w.edit(planWith("a", "b"));
    const answer = w.engine.prepareSignOut();
    await w.settle();
    expect(await answer).toBe("unsaved");

    const w2 = inStep(planWith("a"));
    await signIn(w2);
    w2.server.goDown();
    w2.replan({ ...planWith("a"), tasks: [{ ...task("a"), priorityScore: 12 }] });
    const answer2 = w2.engine.prepareSignOut();
    await w2.settle();
    expect(await answer2).toBe("saved"); // nothing of the student's would be lost
  });

  it("deleting the account ({ save: false }): nothing is sent, the answer is \"saved\"", async () => {
    const w = inStep(planWith("a"));
    await signIn(w);
    w.edit(planWith("a", "b"));
    expect(await w.engine.prepareSignOut({ save: false })).toBe("saved");
    await w.wait(10 * MINUTE);
    expect(w.server.count("save")).toBe(0);
  });

  it("a plan that was never the account's (not adopted yet) is \"unsaved\"", async () => {
    const server = fakeServer();
    server.goDown();
    const w = world({ server, state: planWith("a") });
    await signIn(w);
    const answer = w.engine.prepareSignOut();
    await w.settle();
    expect(await answer).toBe("unsaved");
  });

  it("the student stays after all (cancelSignOut): saving starts again, with what changed meanwhile", async () => {
    const w = inStep(planWith("a"));
    await signIn(w);
    w.server.goDown();
    w.edit(planWith("a", "b"));
    const answer = w.engine.prepareSignOut();
    await w.settle();
    expect(await answer).toBe("unsaved");
    const callsWhenPaused = w.server.calls.length; // the one attempt signing out made, which failed
    w.edit(planWith("a", "b", "c"));
    w.server.comeBack();
    await w.wait(10 * MINUTE);
    expect(w.server.calls.length).toBe(callsWhenPaused);
    expect(tasksIn(w.server.saved?.snapshot)).toEqual(["a"]);

    w.engine.cancelSignOut();
    await w.wait(PLAN_SAVE_QUIET_MS);
    expect(tasksIn(w.server.saved?.snapshot)).toEqual(["a", "b", "c"]);
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", save: "saved" });
    expect(w.storage.book()).toMatchObject({ dirty: false, edited: false });
  });

  it("cancelSignOut after a save that arrived unnoticed: recognised as this iPhone's own", async () => {
    const w = inStep(planWith("a"));
    await signIn(w);
    w.edit(planWith("a", "b"));
    w.server.onNextSave({ hold: true });
    const answer = w.engine.prepareSignOut();
    await vi.advanceTimersByTimeAsync(PLAN_SIGN_OUT_WAIT_MS);
    expect(await answer).toBe("unsaved");
    w.server.release(); // stored while paused: the answer is ignored
    await vi.advanceTimersByTimeAsync(100);
    expect(w.server.revision).toBe(4);
    w.engine.cancelSignOut();
    await w.settle();
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", save: "saved" });
    expect(w.engine.getPrompt().question).toBeNull();
    expect(w.server.revision).toBe(4);
    expect(w.storage.book()).toMatchObject({ revision: 4, dirty: false });
  });

  it("signing in again on the wiped iPhone brings the plan back", async () => {
    const w = inStep(planWith("a", "b"));
    await signIn(w);
    expect(await w.engine.prepareSignOut()).toBe("saved");
    await w.phone.device.wipe();
    w.engine.setAccount(null);
    await w.settle();
    expect(w.engine.getStatus().phase).toBe("off");

    w.engine.setAccount(ME);
    await w.settle();
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", restoredFromAccount: true });
    expect(w.phone.state.tasks.map((t) => t.id)).toEqual(["a", "b"]);
    expect(w.server.count("save")).toBe(0);
    // Saving works again after the sign-in.
    w.edit(planWith("a", "b", "c"));
    await w.wait(PLAN_SAVE_QUIET_MS);
    expect(tasksIn(w.server.saved?.snapshot)).toEqual(["a", "b", "c"]);
  });

  it("the session ends by itself (expired) without a wipe: changes are still noted, and saved after the next sign-in", async () => {
    const w = inStep(planWith("a"));
    await signIn(w);
    w.engine.setAccount(null); // no prepareSignOut: the plan stays on this iPhone
    w.edit(planWith("a", "b"));
    await w.wait(10 * MINUTE);
    expect(w.server.count("save")).toBe(0);
    expect(w.storage.book()).toMatchObject({ owner: ME, dirty: true, edited: true });
    w.engine.setAccount(ME);
    await w.settle();
    expect(tasksIn(w.server.saved?.snapshot)).toEqual(["a", "b"]);
  });
});

describe("this iPhone holds the plan of another account", () => {
  const theirBook = (state: AppState): Record<string, string> => ({
    [PLAN_SYNC_STORAGE_KEY]: JSON.stringify({ v: 1, owner: SOMEONE_ELSE, revision: 9, dirty: true, edited: true, lastSavedAt: START.toISOString(), deviceId: "this-iphone-AAAAAAAAAAAA", hash: hashOf(state), sent: [], savedBy: "this-iphone-AAAAAAAAAAAA", serverSavedAt: START.toISOString() } satisfies PlanSyncBookkeeping),
  });

  it("a saved plan that lands just as the session ends WITHOUT a wipe is recorded as that account's, so the next account is asked", async () => {
    // A plan from before accounts (never tied to one), an account whose saved plan the student chose to use...
    const server = fakeServer();
    server.put(planWith("x", "y"));
    const w = world({ server, state: planWith("a") });
    await signIn(w);
    w.phone.holdApply = true;
    w.engine.answer(w.engine.getPrompt().question!, "use-saved");
    await vi.advanceTimersByTimeAsync(0);
    expect(w.phone.applying).toBe(true);

    // ...and, while it is being put in place, the welcome screen's "Sign out": only the session goes, nothing is
    // wiped (lib/sign-out-flow.ts leaveSignInMode "session-only").
    w.engine.setAccount(null);
    w.phone.releaseApply();
    await w.settle();
    expect(w.phone.state.tasks.map((t) => t.id)).toEqual(["x", "y"]);
    expect(w.phone.wipes).toBe(0);
    expect(w.storage.book()).toMatchObject({ owner: ME, revision: 1, dirty: false, edited: false, hash: hashOf(planWith("x", "y")) });

    // Someone else signs in on this iPhone: the plan here is not theirs, is never sent, and they are asked.
    w.server.calls.length = 0;
    w.engine.setAccount(SOMEONE_ELSE);
    await w.settle();
    expect(w.engine.getPrompt().question).toEqual({ kind: "other-account" });
    expect(w.server.calls).toEqual([]);
  });

  it("it is never uploaded: the student is asked, and until then the server is not even contacted", async () => {
    const w = world({ state: planWith("theirs"), storage: theirBook(planWith("theirs")) });
    await signIn(w);
    expect(w.engine.getStatus().phase).toBe("choose");
    expect(w.engine.getPrompt().question).toEqual({ kind: "other-account" });
    w.replan(planWith("theirs"));
    w.engine.appLeftForeground();
    w.engine.appBecameActive();
    await w.wait(60 * MINUTE);
    expect(w.server.calls).toEqual([]);
    expect(w.phone.wipes).toBe(0);
    expect(w.storage.book()).toMatchObject({ owner: SOMEONE_ELSE, revision: 9 });
  });

  it('"Continue": a safety copy, the iPhone is emptied, and this account\'s plan is loaded', async () => {
    const server = fakeServer();
    server.put(planWith("mine-1", "mine-2"));
    const w = world({ server, state: planWith("theirs"), storage: theirBook(planWith("theirs")) });
    await signIn(w);
    w.engine.answer(w.engine.getPrompt().question!, "continue");
    expect(w.engine.getStatus().phase).toBe("checking");
    await w.settle();
    expect(w.phone.wipes).toBe(1);
    expect(w.phone.state.tasks.map((t) => t.id)).toEqual(["mine-1", "mine-2"]);
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", restoredFromAccount: true });
    expect(w.storage.book()).toMatchObject({ owner: ME, revision: 1, dirty: false });
    expect(w.storage.book().deviceId).not.toBe("this-iphone-AAAAAAAAAAAA"); // a wiped iPhone is a new one to the server
    expect(w.storage.safetyCopy()).toMatchObject({ why: "other-account", owner: SOMEONE_ELSE });
    expect(tasksIn(w.storage.safetyCopy()?.snapshot)).toEqual(["theirs"]);
    expect(w.server.count("save")).toBe(0);
  });

  it('"Continue" with nothing saved in this account: a blank start, and the other plan is not adopted', async () => {
    const w = world({ state: planWith("theirs"), storage: theirBook(planWith("theirs")) });
    await signIn(w);
    w.engine.answer(w.engine.getPrompt().question!, "continue");
    await w.settle();
    expect(w.phone.state.tasks).toEqual([]);
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", restoredFromAccount: false });
    await w.wait(10 * MINUTE);
    expect(w.server.count("save")).toBe(0);
  });

  it('"Continue" tapped just as signing out begins: this iPhone is not emptied after the fact', async () => {
    const w = world({ state: planWith("theirs"), storage: theirBook(planWith("theirs")) });
    await signIn(w);
    const question = w.engine.getPrompt().question!;
    const release = w.storage.holdWrites(); // the safety copy is still being written…
    w.engine.answer(question, "continue");
    await vi.advanceTimersByTimeAsync(0);
    expect(await w.engine.prepareSignOut({ save: false })).toBe("saved"); // …when signing out begins
    release();
    await w.wait(MINUTE);
    expect(w.phone.wipes).toBe(0);
    expect(w.phone.state.tasks.map((t) => t.id)).toEqual(["theirs"]);
    expect(w.server.calls).toEqual([]);
  });

  it('"Sign out" touches nothing; if the sign-out does not happen, the question comes back', async () => {
    const w = world({ state: planWith("theirs"), storage: theirBook(planWith("theirs")) });
    await signIn(w);
    const question = w.engine.getPrompt().question!;
    w.engine.answer(question, "sign-out");
    await w.settle();
    expect(w.engine.getPrompt().question).toBe(question);
    expect(w.phone.wipes).toBe(0);
    w.engine.askAgain();
    expect(w.engine.getPrompt().question).not.toBe(question);
    expect(w.engine.getPrompt().question).toEqual({ kind: "other-account" });
    // The session ends: the question goes, the plan and its record stay for the account they belong to.
    w.engine.setAccount(null);
    expect(w.engine.getStatus().phase).toBe("off");
    expect(w.engine.getPrompt().question).toBeNull();
    w.engine.askAgain();
    expect(w.engine.getPrompt().question).toBeNull();
    expect(w.phone.state.tasks.map((t) => t.id)).toEqual(["theirs"]);
    expect(w.storage.book()).toMatchObject({ owner: SOMEONE_ELSE, revision: 9, dirty: true });
    expect(w.server.calls).toEqual([]);
  });

  it("when no plan of theirs is left here there is nothing to ask: what else they left is cleared and the sign-in goes on", async () => {
    const server = fakeServer();
    server.put(planWith("mine"));
    const w = world({ server, state: createInitialState(), storage: theirBook(planWith("theirs")) });
    await signIn(w);
    expect(w.phone.wipes).toBe(1);
    expect(w.engine.getPrompt().question).toBeNull();
    expect(w.phone.state.tasks.map((t) => t.id)).toEqual(["mine"]);
    expect(w.storage.safetyCopy()).toBeNull();
  });
});

describe("the account's plan was saved by a newer version of Trajectory", () => {
  const newer = (state: AppState) => JSON.stringify({ ...JSON.parse(snapshotOf(state)), v: 2 });

  it("is never loaded and never saved over: the student keeps working here and is told once", async () => {
    const w = inStep(planWith("a"));
    w.server.putRaw(newer(planWith("a", "future")));
    await signIn(w);
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", save: "offline" });
    expect(w.engine.getPrompt()).toEqual({ question: null, notice: { kind: "newer-version" }, blocked: "newer-version" });
    expect(w.phone.applied).toBe(0);
    const notice = w.engine.getPrompt().notice!;
    w.engine.dismissNotice(notice);

    const kept = w.server.saved;
    w.edit(planWith("a", "b"));
    w.engine.appLeftForeground();
    await w.wait(10 * MINUTE);
    w.engine.appBecameActive();
    w.engine.retry();
    await w.wait(10 * MINUTE);
    expect(w.server.count("save")).toBe(0);
    expect(w.server.saved).toBe(kept);
    expect(w.server.count("load")).toBe(1); // looked at once, not at every check
    expect(w.engine.getPrompt()).toEqual({ question: null, notice: null, blocked: "newer-version" }); // told once
    expect(await (async () => {
      const answer = w.engine.prepareSignOut();
      await w.settle();
      return answer;
    })()).toBe("unsaved");
  });

  it("on a new iPhone: no plan comes back, and nothing started here is saved over it", async () => {
    const server = fakeServer();
    server.putRaw(newer(planWith("future")));
    const w = world({ server });
    await signIn(w);
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", restoredFromAccount: false });
    expect(w.engine.getPrompt().blocked).toBe("newer-version");
    w.edit(planWith("started-here"));
    await w.wait(10 * MINUTE);
    expect(w.server.count("save")).toBe(0);
    expect(w.storage.book().owner).toBeNull();
  });

  it("once the app can read it (after the update, or a readable save from another device) things go on as usual", async () => {
    const w = inStep(planWith("a"));
    w.server.putRaw(newer(planWith("a", "future")));
    await signIn(w);
    expect(w.engine.getPrompt().blocked).toBe("newer-version");
    w.server.put(planWith("a", "readable"));
    await w.wait(40 * SECOND);
    w.engine.appBecameActive();
    await w.settle();
    expect(w.engine.getPrompt().blocked).toBeNull();
    expect(w.phone.state.tasks.map((t) => t.id)).toEqual(["a", "readable"]);
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", save: "saved" });
  });

  it("a plan that cannot be read at all is treated with the same care", async () => {
    const w = inStep(planWith("a"));
    w.server.putRaw(JSON.stringify({ format: "trajectory-plan", v: 1, encoding: "gzip-base64", data: "AAAAnot-a-gzip-fileAAAA" }));
    await signIn(w);
    expect(w.engine.getPrompt()).toMatchObject({ notice: { kind: "unreadable" }, blocked: "unreadable" });
    w.edit(planWith("a", "b"));
    await w.wait(10 * MINUTE);
    expect(w.server.count("save")).toBe(0);
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", save: "offline" });
  });
});

describe("what the server may answer to a save", () => {
  it("too many saves: waits about two minutes, without calling it offline", async () => {
    const w = inStep(planWith("a"));
    await signIn(w);
    w.server.onNextSave({ fail: () => trpcError("TOO_MANY_REQUESTS", 429) });
    w.edit(planWith("a", "b"));
    await w.wait(PLAN_SAVE_QUIET_MS);
    expect(w.server.count("save")).toBe(1);
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", save: "waiting" });
    expect(w.storage.book().sent).toEqual([]); // refused: not a save to look out for
    await w.wait(PLAN_RATE_LIMIT_WAIT_MS - 1);
    w.engine.appLeftForeground(); // not even when the app goes away
    await w.settle();
    expect(w.server.count("save")).toBe(1);
    await w.wait(1);
    expect(w.server.count("save")).toBe(2);
    expect(w.engine.getStatus().save).toBe("saved");
  });

  it("the server itself fails while saving (its database is down): offline, tried again with the same patience, then saved", async () => {
    const w = inStep(planWith("a"));
    await signIn(w);
    w.server.onNextSave({ fail: () => trpcError("INTERNAL_SERVER_ERROR", 500) });
    w.edit(planWith("a", "b"));
    await w.wait(PLAN_SAVE_QUIET_MS);
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", save: "offline" });
    expect(w.storage.book()).toMatchObject({ revision: 3, dirty: true, edited: true });
    await w.wait(15 * SECOND - 1);
    expect(w.server.count("save")).toBe(1);
    await w.wait(1);
    expect(tasksIn(w.server.saved?.snapshot)).toEqual(["a", "b"]);
    expect(w.engine.getStatus().save).toBe("saved");
    expect(w.engine.getPrompt().question).toBeNull();
  });

  it("the server fails while the saved plan is being fetched: nothing is concluded about the account", async () => {
    const server = fakeServer();
    server.put(planWith("x"));
    const w = world({ server });
    const load = server.transport.load;
    let failing = true;
    server.transport.load = async () => {
      if (failing) {
        server.calls.push("load");
        throw trpcError("INTERNAL_SERVER_ERROR", 500);
      }
      return load();
    };
    await signIn(w);
    expect(w.engine.getStatus().phase).toBe("unreachable");
    expect(w.storage.book().owner).toBeNull();
    failing = false;
    await w.wait(15 * SECOND);
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", restoredFromAccount: true });
    expect(w.phone.state.tasks.map((t) => t.id)).toEqual(["x"]);
  });

  it("the session is gone (expired, or the account was deleted while the save was on its way): stops quietly", async () => {
    const w = inStep(planWith("a"));
    await signIn(w);
    w.server.onNextSave({ fail: () => trpcError("UNAUTHORIZED", 401) });
    w.edit(planWith("a", "b"));
    await w.wait(PLAN_SAVE_QUIET_MS);
    const calls = w.server.calls.length;
    w.edit(planWith("a", "b", "c"));
    await w.wait(60 * MINUTE);
    expect(w.server.calls.length).toBe(calls); // no retries, no loop
    // Quietly, but honestly: the row says the plan is not saved, not that it is on its way.
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", save: "offline" });
    expect(w.engine.getPrompt()).toEqual({ question: null, notice: null, blocked: null });
    // The app coming back (a refreshed session, perhaps) is worth one more try.
    w.engine.appBecameActive();
    await w.settle();
    expect(tasksIn(w.server.saved?.snapshot)).toEqual(["a", "b", "c"]);
  });

  it("the first check is refused as unauthorized: nothing is assumed about the account", async () => {
    const server = fakeServer();
    server.put(planWith("x"));
    server.goDown(() => trpcError("UNAUTHORIZED", 401));
    const w = world({ server });
    await signIn(w);
    expect(w.engine.getStatus().phase).toBe("unreachable");
    await w.wait(60 * MINUTE);
    expect(w.server.count("header")).toBe(1);
  });

  it("an HTTP 413 from the web server (no tRPC error in it) is \"too large\", not \"offline\", and is not retried until the plan changes", async () => {
    const w = inStep(planWith("a"));
    await signIn(w);
    w.server.onNextSave({ fail: () => Object.assign(new Error("Too large."), { name: "TRPCClientError", cause: new PlanTooLargeError() }) });
    w.edit(planWith("a", "b"));
    await w.wait(PLAN_SAVE_QUIET_MS);
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", save: "too-large" });
    await w.wait(30 * MINUTE);
    w.engine.appBecameActive();
    await w.wait(30 * MINUTE);
    expect(w.server.count("save")).toBe(1);
    expect(w.engine.getStatus().save).toBe("too-large");
    // A different plan is worth another try.
    w.edit(planWith("a"));
    w.edit(planWith("a", "c"));
    await w.wait(PLAN_SAVE_MIN_INTERVAL_MS);
    expect(w.server.count("save")).toBe(2);
    expect(w.engine.getStatus().save).toBe("saved");
  });

  it("a plan whose snapshot would be longer than the server stores is not sent at all", async () => {
    const w = inStep(planWith("a"));
    await signIn(w);
    // About 4.4 million characters that do not compress.
    let seed = 0x9e3779b9;
    const next = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed >>> 0;
    };
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const chars: string[] = [];
    for (let i = 0; i < 4_400_000; i++) chars.push(alphabet[next() >>> 26]!);
    w.edit({ ...planWith("a"), tasks: [{ ...task("a"), name: chars.join("") }] });
    await w.wait(PLAN_SAVE_QUIET_MS);
    expect(w.server.count("save")).toBe(0);
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", save: "too-large" });
  });
});

describe("this iPhone's own plan cannot be read (its storage does not answer)", () => {
  it("while saving: nothing is sent (feed links that could not be read are not taken for none), and it is tried again", async () => {
    const w = inStep(planWith("a"));
    await signIn(w);
    w.phone.failRead = true;
    w.edit(planWith("a", "b"));
    await w.wait(PLAN_SAVE_QUIET_MS);
    expect(w.server.count("save")).toBe(0);
    expect(w.engine.getStatus()).toMatchObject({ phase: "ready", save: "offline" });
    expect(w.log).toContain("read: Error");
    expect(w.storage.book()).toMatchObject({ revision: 3, dirty: true, edited: true });
    w.phone.failRead = false;
    await w.wait(15 * SECOND);
    expect(tasksIn(w.server.saved?.snapshot)).toEqual(["a", "b"]);
    expect(w.engine.getStatus().save).toBe("saved");
  });

  it("at the first check: no saved plan is loaded over it and nothing is saved from it, and it is tried again", async () => {
    const server = fakeServer();
    server.put(planWith("saved"));
    const w = world({ server, state: planWith("mine") });
    w.phone.failRead = true;
    await signIn(w);
    expect(w.engine.getStatus().phase).toBe("unreachable");
    expect(w.engine.getPrompt().question).toBeNull();
    expect(w.phone.applied).toBe(0);
    expect(w.server.count("save")).toBe(0);
    expect(w.server.count("load")).toBe(0);
    w.phone.failRead = false;
    await w.wait(15 * SECOND);
    // What it should have been all along: a plan on both sides, so the student chooses.
    expect(w.engine.getStatus().phase).toBe("choose");
    expect(w.phone.state.tasks.map((t) => t.id)).toEqual(["mine"]);
  });

  it("when the saved plan has arrived and is about to be compared: neither loaded nor passed over", async () => {
    const w = inStep(planWith("a"));
    w.server.put(planWith("a", "from-the-other-device"));
    w.server.holdNext("load");
    w.engine.attach(w.phone.device);
    w.engine.setAccount(ME);
    await vi.advanceTimersByTimeAsync(0);
    expect(w.server.calls).toEqual(["header", "load"]);
    w.phone.failRead = true;
    w.server.release();
    await w.settle();
    expect(w.phone.applied).toBe(0);
    expect(w.storage.book().revision).toBe(3);
    w.phone.failRead = false;
    await w.wait(15 * SECOND);
    expect(w.phone.state.tasks.map((t) => t.id)).toEqual(["a", "from-the-other-device"]);
    expect(w.storage.book().revision).toBe(4);
  });

  it("the plan of another account that cannot be read is not taken for 'nothing of theirs is left here'", async () => {
    const book: PlanSyncBookkeeping = { v: 1, owner: SOMEONE_ELSE, revision: 9, dirty: false, edited: false, lastSavedAt: START.toISOString(), deviceId: "this-iphone-AAAAAAAAAAAA", hash: hashOf(planWith("theirs")), sent: [], savedBy: "this-iphone-AAAAAAAAAAAA", serverSavedAt: START.toISOString() };
    const w = world({ state: planWith("theirs"), storage: { [PLAN_SYNC_STORAGE_KEY]: JSON.stringify(book) } });
    w.phone.failRead = true;
    await signIn(w);
    // Not wiped on a guess, and not asked about either: it is simply not known yet.
    expect(w.phone.wipes).toBe(0);
    expect(w.engine.getStatus().phase).toBe("unreachable");
    expect(w.server.calls).toEqual([]);
    w.phone.failRead = false;
    await w.wait(15 * SECOND);
    expect(w.engine.getPrompt().question).toEqual({ kind: "other-account" });
    expect(w.phone.wipes).toBe(0);
  });
});

describe("it never asks the server to force a save, and never logs a plan", () => {
  it("across everything above", async () => {
    const w = inStep(planWith("a"));
    const spy = vi.spyOn(w.server.transport, "save");
    await signIn(w);
    w.server.put(planWith("a", "theirs"));
    w.edit(planWith("a", "a-secret-task-name"));
    await w.wait(PLAN_SAVE_QUIET_MS);
    w.engine.answer(w.engine.getPrompt().question!, "keep-mine");
    await w.settle();
    w.server.goDown();
    w.edit(planWith("a", "another-secret"));
    await w.wait(5 * MINUTE);
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const [input] of spy.mock.calls) expect(input.force).toBeUndefined();
    expect(w.log.length).toBeGreaterThan(0);
    for (const line of w.log) {
      expect(line).not.toContain("secret");
      expect(line).not.toContain("trajectory-plan");
      expect(line.length).toBeLessThan(60);
    }
  });
});

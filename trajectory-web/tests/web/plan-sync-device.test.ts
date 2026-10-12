// Replacing the plan on this iPhone (lib/plan-sync-device.ts): the one step of the saved plan that writes over a
// student's plan, with the app's real reducer and snapshot writer, an in-memory storage, and React played by hand.
// Also how the app tells a change the student made from one it derived itself (lib/app-context.tsx).
import { describe, expect, it, vi } from "vitest";



vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));

import { isStudentAction, lastStudentActionTime, noteDispatched, reducer, stateReplacementsIn, studentActionCount, studentEditsIn } from "../../src/engine/app-context";
import { decodePlanSnapshot, encodePlanSnapshot, isPristineState, preparePlan, type PlanContents } from "../../src/lib/plan-snapshot";
import { PLAN_SAFETY_COPY_STORAGE_KEY, PLAN_SYNC_STORAGE_KEY, parseBookkeeping, type PlanSyncBookkeeping } from "../../src/lib/plan-sync";
import { createPlanDevice, type PlanDeviceDeps } from "../../src/lib/plan-sync-device";
import { createPlanSyncEngine, type PlanSyncTransport } from "../../src/lib/plan-sync-engine";
import type { SavedPlan } from "../../src/shared/plan-sync";
import { APP_STATE_STORAGE_KEY, createInitialState, createStatePersister, parsePersistedState } from "../../src/engine/state-persistence";
import type { AppState, GoogleCalendarEventLocal, Task } from "../../src/engine/types";
import { UNDO_SNAPSHOT_STORAGE_KEY } from "../../src/engine/undo-persistence";

type Action = Parameters<typeof reducer>[1];

const task = (id: string): Task => ({ id, name: `Task ${id}`, courseId: "", courseName: "General", dueDate: "2026-10-20", estimatedMinutes: 60, difficulty: 3, requiresOnCampus: false, status: "pending", createdAt: "2026-09-01T00:00:00.000Z" });
const planWith = (...ids: string[]): AppState => ({ ...createInitialState(), onboardingComplete: true, tasks: ids.map(task) });
const myEvent: GoogleCalendarEventLocal = { id: "mine@1", calendarId: "home", title: "My dentist", startDate: "2026-10-09", isAllDay: true, isRecurring: false, status: "active", syncedAt: "x", source: "device" };

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const failing = new Set<string>();
  return {
    data,
    /** Writes of this key fail from now on. */
    failWritesOf(key: string) {
      failing.add(key);
    },
    async getItem(key: string) {
      return data.get(key) ?? null;
    },
    async setItem(key: string, value: string) {
      if (failing.has(key)) throw new Error("disk full");
      data.set(key, value);
    },
    async removeItem(key: string) {
      if (failing.has(key)) throw new Error("disk full");
      data.delete(key);
    },
    async getAllKeys() {
      return [...data.keys()];
    },
    async multiRemove(keys: string[]) {
      for (const key of keys) data.delete(key);
    },
  };
}

/** An iPhone: the state React has rendered, actions waiting to be rendered, the feeds' store and the snapshot writer. */
function iphone(initial: AppState, stored: Record<string, string> = {}, overrides: Partial<PlanDeviceDeps> = {}) {
  const storage = memoryStorage(stored);
  const persister = createStatePersister({ storage });
  const phone = {
    storage,
    persister,
    rendered: initial,
    waiting: [] as Action[],
    feeds: { feeds: [{ url: "https://school.example/feed.ics" }] as unknown[], links: { old: "t-old" } as Record<string, string> },
    failLinks: false,
    wipedOutside: 0,
    remindersCancelled: 0,
    order: [] as string[],
    /** React renders what was dispatched. */
    render() {
      phone.rendered = phone.waiting.splice(0).reduce(reducer, phone.rendered);
    },
    /**
     * React renders a tap ahead of what was dispatched before it from a timer or a promise (a higher priority):
     * first the tap alone, on the state as it was, and only at the next render everything in the order it was
     * dispatched.
     */
    renderAhead(action: Action) {
      phone.rendered = reducer(phone.rendered, action);
      phone.waiting.push(action);
    },
    onDisk(): AppState | null {
      return parsePersistedState(storage.data.get(APP_STATE_STORAGE_KEY));
    },
  };
  const device = createPlanDevice({
    rendered: () => phone.rendered,
    dispatch: (action) => {
      phone.order.push(`dispatch ${action.type}`);
      phone.waiting.push(action);
    },
    reduce: reducer,
    replacements: stateReplacementsIn,
    editing: () => false,
    persister,
    storage,
    loadFeeds: async () => phone.feeds,
    replaceFeedLinks: (links) => {
      phone.order.push("feed links asked");
      return (async () => {
        await Promise.resolve(); // a store write never finishes in the same tick
        if (phone.failLinks) throw new Error("disk full");
        phone.order.push("feed links");
        phone.feeds = { feeds: phone.feeds.feeds, links };
        return phone.feeds.feeds.length;
      })();
    },
    beforeWipe: async () => {
      phone.wipedOutside++;
    },
    cancelReminders: async () => {
      phone.remindersCancelled++;
    },
    ...overrides,
  });
  return { phone, device };
}

const saved = (state: AppState, extra: Partial<PlanContents> = {}): PlanContents => ({ state, feedLinks: { "event-1": "x" }, feedCount: 2, ...extra });

describe("reading this iPhone's plan", () => {
  it("is the rendered state with the feed links and the number of feeds", async () => {
    const { device, phone } = iphone(planWith("a"));
    expect(device.state()).toBe(phone.rendered);
    expect(await device.read()).toEqual({ state: phone.rendered, feedLinks: { old: "t-old" }, feedCount: 1 });
  });

  it("passes on whether the student is in the middle of a change", () => {
    let editing = false;
    const { device } = iphone(planWith("a"), {}, { editing: () => editing });
    expect(device.editing?.()).toBe(false);
    editing = true;
    expect(device.editing?.()).toBe(true);
  });
});

describe("putting a loaded plan in place", () => {
  it("replaces the plan in every place it lives, and has it on disk before it says so", async () => {
    const undo = JSON.stringify({ label: "Plan updated", at: "2026-10-05T10:00:00.000Z", scheduleBlocks: [], tasks: [] });
    const { device, phone } = iphone({ ...planWith("old"), deviceCalendarEvents: [myEvent], notificationSettings: { enabled: true, leadTimeHours: 6 } }, { [UNDO_SNAPSHOT_STORAGE_KEY]: undo });

    const result = await device.apply(saved(planWith("x", "y")));

    expect(result).toEqual({ feedCount: 1 }); // this iPhone's own feed stays; the saved plan's count is not its own
    expect(phone.feeds).toEqual({ feeds: [{ url: "https://school.example/feed.ics" }], links: { "event-1": "x" } });
    expect(phone.storage.data.has(UNDO_SNAPSHOT_STORAGE_KEY)).toBe(false); // that Undo belonged to the replaced plan
    // On disk already, though React has not rendered it yet.
    expect(phone.onDisk()?.tasks.map((t) => t.id)).toEqual(["x", "y"]);
    expect(phone.rendered.tasks.map((t) => t.id)).toEqual(["old"]);
    // What is this iPhone's own was kept.
    expect(phone.onDisk()?.deviceCalendarEvents?.map((e) => e.title)).toEqual(["My dentist"]);
    expect(phone.onDisk()?.notificationSettings).toEqual({ enabled: true, leadTimeHours: 6, reminders: [{ id: "default", leadTimeHours: 24 }] });
  });

  it("the state is replaced, and feed refreshes are told, before anything is awaited: nothing can slip in between", () => {
    const { device, phone } = iphone(planWith("old"));
    void device.apply(saved(planWith("x")));
    // Not a single tick has passed since the decision to load.
    expect(phone.order).toEqual(["dispatch LOAD_STATE", "feed links asked"]);
    expect(device.state().tasks.map((t) => t.id)).toEqual(["x"]);
    expect(device.isApplying()).toBe(true);
  });

  it("the engine sees the loaded plan at once, not the one React still shows (it would save the replaced plan otherwise)", async () => {
    const { device, phone } = iphone(planWith("old"));
    await device.apply(saved(planWith("x")));
    expect(phone.rendered.tasks.map((t) => t.id)).toEqual(["old"]);
    expect(device.state().tasks.map((t) => t.id)).toEqual(["x"]);
    expect((await device.read()).state.tasks.map((t) => t.id)).toEqual(["x"]);

    // Once React has rendered the load, the device follows the app again, later edits included.
    phone.render();
    expect(phone.rendered.tasks.map((t) => t.id)).toEqual(["x"]);
    expect(device.state()).toBe(phone.rendered);
    phone.waiting.push({ type: "ADD_TASK", payload: task("added-later") });
    phone.render();
    expect(device.state().tasks.map((t) => t.id)).toEqual(["x", "added-later"]);
  });

  it("a change the student makes in the same breath as the load is not hidden from the engine", async () => {
    const { device, phone } = iphone(planWith("old"));
    await device.apply(saved(planWith("x")));
    // Tapped before React rendered the load: both arrive in one render.
    phone.waiting.push({ type: "ADD_TASK", payload: task("tapped-right-away") });
    phone.render();
    expect(device.state().tasks.map((t) => t.id)).toEqual(["x", "tapped-right-away"]);
    expect((await device.read()).state).toBe(phone.rendered);
  });

  it("a render that does not include the load yet (a tap, rendered ahead of it) is not taken for the loaded plan", async () => {
    const { device, phone } = iphone(planWith("old"));
    const applying = device.apply(saved(planWith("x")));
    phone.renderAhead({ type: "ADD_TASK", payload: task("tapped") });
    // What React shows for a moment: the old plan with the tap. The engine must not read that as this iPhone's plan…
    expect(phone.rendered.tasks.map((t) => t.id)).toEqual(["old", "tapped"]);
    expect(device.state().tasks.map((t) => t.id)).toEqual(["x"]);
    await applying;
    // …and it must never be what goes to disk as the loaded plan.
    expect(phone.onDisk()?.tasks.map((t) => t.id)).toEqual(["x"]);
    expect(device.state().tasks.map((t) => t.id)).toEqual(["x"]);
    // The next render has both, in the order they were dispatched: the tap lands on the loaded plan.
    phone.render();
    expect(phone.rendered.tasks.map((t) => t.id)).toEqual(["x", "tapped"]);
    expect(device.state()).toBe(phone.rendered);
  });

  it("a change the student makes while the loaded plan is being written goes to disk with it, not behind it", async () => {
    const { device, phone } = iphone(planWith("old"));
    const applying = device.apply(saved(planWith("x")));
    // Before the stores have been written: React renders the load, the student adds something, and the provider
    // queues that state for the disk (usePersistAppState).
    phone.render();
    phone.waiting.push({ type: "ADD_TASK", payload: task("added-meanwhile") });
    phone.render();
    phone.persister.schedule(phone.rendered);
    await applying;
    // Writing the plan as it was loaded would have put it on disk after, and without, the student's change.
    expect(phone.onDisk()?.tasks.map((t) => t.id)).toEqual(["x", "added-meanwhile"]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(phone.onDisk()?.tasks.map((t) => t.id)).toEqual(["x", "added-meanwhile"]);
  });

  it("when the state is replaced once more while the plan is being loaded (signing out wiped it), nothing more is written", async () => {
    const { device, phone } = iphone(planWith("old"));
    const applying = device.apply(saved(planWith("x")));
    phone.waiting.push({ type: "LOGOUT" }); // hooks/use-wipe-local-data.ts, the first step of the wipe
    phone.render();
    await expect(applying).rejects.toThrow();
    expect(isPristineState(device.state())).toBe(true);
    // The account's plan is not left on an iPhone that was just wiped.
    expect(phone.onDisk()).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(phone.onDisk()).toBeNull();
  });

  it("the copy on disk is exactly what the provider renders, so it is written once", async () => {
    const { device, phone } = iphone(planWith("old"));
    await device.apply(saved(planWith("x")));
    const written = phone.storage.data.get(APP_STATE_STORAGE_KEY)!;
    phone.render();
    const setItem = vi.spyOn(phone.storage, "setItem");
    phone.persister.schedule(phone.rendered); // what usePersistAppState does after the render
    expect(await phone.persister.flush()).toBe(true);
    expect(setItem).not.toHaveBeenCalled();
    expect(phone.storage.data.get(APP_STATE_STORAGE_KEY)).toBe(written);
  });

  it("an older snapshot still waiting to be written never lands after the loaded plan", async () => {
    const { device, phone } = iphone(planWith("old"));
    phone.persister.schedule(planWith("old", "typed-a-moment-ago")); // debounced, not written yet
    await device.apply(saved(planWith("x")));
    await new Promise((resolve) => setTimeout(resolve, 500)); // well past the writer's quiet period
    expect(phone.onDisk()?.tasks.map((t) => t.id)).toEqual(["x"]);
  });

  it("when the feed links or the state cannot be written, it is reported: nothing is recorded as loaded", async () => {
    for (const failure of ["links", "state", "undo"] as const) {
      const { device, phone } = iphone(planWith("old"));
      if (failure === "links") phone.failLinks = true;
      if (failure === "state") phone.storage.failWritesOf(APP_STATE_STORAGE_KEY);
      if (failure === "undo") phone.storage.failWritesOf(UNDO_SNAPSHOT_STORAGE_KEY);
      await expect(device.apply(saved(planWith("x"))), failure).rejects.toThrow();
      expect(device.isApplying(), failure).toBe(false);
      // The state on disk is only ever the loaded plan when every part of the load went through.
      expect(phone.onDisk(), failure).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 0)); // no rejection left unhandled
    }
  });

  it("says it is applying while the stores are written, and not afterwards", async () => {
    const { device } = iphone(planWith("old"));
    expect(device.isApplying()).toBe(false);
    const apply = device.apply(saved(planWith("x")));
    await Promise.resolve();
    expect(device.isApplying()).toBe(true);
    await apply;
    expect(device.isApplying()).toBe(false);
  });
});

describe("emptying this iPhone (the plan of another account is being replaced)", () => {
  it("resets the state, removes everything the app stored except the safety copy, and what lives outside storage", async () => {
    const { device, phone } = iphone({ ...planWith("theirs"), deviceCalendarEvents: [myEvent] }, {
      [APP_STATE_STORAGE_KEY]: JSON.stringify(planWith("theirs")),
      [UNDO_SNAPSHOT_STORAGE_KEY]: "{}",
      [PLAN_SYNC_STORAGE_KEY]: "{}",
      [PLAN_SAFETY_COPY_STORAGE_KEY]: "the copy made a moment ago",
      "@trajectory/courseFeeds": JSON.stringify({ feeds: [{ url: "https://their-school.example/private.ics" }], links: {} }),
      "@trajectory/gradeScores": "{}", // what the removed Grades screen stored (lib/retired-data.ts)
      "@trajectory/aiMemory": "{}",
      "trajectory.ai-data-sharing-consent.v1": "granted",
      "expo.installation.id": "not ours",
    });
    phone.persister.schedule(planWith("theirs", "typed-a-moment-ago")); // must not come back after the wipe

    await device.wipe();

    expect([...phone.storage.data.keys()].sort()).toEqual(["expo.installation.id", PLAN_SAFETY_COPY_STORAGE_KEY].sort());
    expect(phone.wipedOutside).toBe(1);
    expect(phone.remindersCancelled).toBe(1);
    expect(phone.waiting.map((action) => action.type)).toEqual(["LOGOUT"]);
    // Pristine for the engine at once, before React has rendered it.
    expect(isPristineState(device.state())).toBe(true);
    expect(phone.rendered.tasks.map((t) => t.id)).toEqual(["theirs"]);
    phone.render();
    expect(isPristineState(phone.rendered)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(phone.storage.data.has(APP_STATE_STORAGE_KEY)).toBe(false);
  });

  it("goes on when the calendar on the iPhone cannot be removed", async () => {
    const { device, phone } = iphone(planWith("theirs"), { [APP_STATE_STORAGE_KEY]: "{}" }, {
      beforeWipe: async () => {
        throw new Error("no calendar access");
      },
    });
    await device.wipe();
    expect(phone.storage.data.size).toBe(0);
  });

  it("a wipe and then a load (Continue, then this account's plan) ends with that plan", async () => {
    const { device, phone } = iphone(planWith("theirs"), { [APP_STATE_STORAGE_KEY]: JSON.stringify(planWith("theirs")) });
    await device.wipe();
    phone.render();
    await device.apply(saved(planWith("mine")));
    expect(device.state().tasks.map((t) => t.id)).toEqual(["mine"]);
    phone.render();
    expect(phone.rendered.tasks.map((t) => t.id)).toEqual(["mine"]);
    expect(phone.onDisk()?.tasks.map((t) => t.id)).toEqual(["mine"]);
  });
});

describe("the engine and this device together (a stand-in account, everything else as in the app)", () => {
  const ME = "apple:001234.abcdef.0123";
  const snapshotOf = (plan: PlanContents): string => {
    const encoded = encodePlanSnapshot(preparePlan(plan).json);
    if (!encoded.ok) throw new Error("too large");
    return encoded.snapshot;
  };
  /** An account that holds `plan` at `revision`, saved by another iPhone, and follows the contract for saves. */
  function account(plan: PlanContents, revision = 1) {
    const calls: string[] = [];
    const first = snapshotOf(plan);
    let held: SavedPlan = { header: { revision, savedAt: new Date().toISOString(), deviceId: "other-iphone-BBBBBBBBBBBB", chars: first.length }, snapshot: first };
    const transport: PlanSyncTransport = {
      header: async () => {
        calls.push("header");
        return { ...held.header };
      },
      load: async () => {
        calls.push("load");
        return { header: { ...held.header }, snapshot: held.snapshot };
      },
      save: async (input) => {
        calls.push("save");
        if (input.baseRevision !== held.header.revision) return { saved: false, header: { ...held.header } };
        held = { header: { revision: held.header.revision + 1, savedAt: new Date().toISOString(), deviceId: input.deviceId, chars: input.snapshot.length }, snapshot: input.snapshot };
        return { saved: true, header: { ...held.header } };
      },
    };
    const tasks = () => {
      const decoded = decodePlanSnapshot(held.snapshot);
      return decoded.kind === "plan" ? decoded.plan.state.tasks.map((t) => t.id) : [];
    };
    return { transport, calls, tasks, revision: () => held.header.revision, saves: () => calls.filter((call) => call === "save").length };
  }
  const record = (phone: ReturnType<typeof iphone>["phone"]) => parseBookkeeping(phone.storage.data.get(PLAN_SYNC_STORAGE_KEY));

  it("a new iPhone: the account's plan is put in place, on disk and on record, and is not saved back", async () => {
    const { device, phone } = iphone(createInitialState());
    const server = account(saved(planWith("x", "y")));
    const engine = createPlanSyncEngine({ transport: server.transport, storage: phone.storage });
    engine.attach(device);
    engine.setAccount(ME);
    await engine.idle();
    expect(engine.getStatus()).toMatchObject({ phase: "ready", save: "saved", restoredFromAccount: true });
    expect(phone.onDisk()?.tasks.map((t) => t.id)).toEqual(["x", "y"]);
    expect(phone.feeds.links).toEqual({ "event-1": "x" });
    expect(record(phone)).toMatchObject({ owner: ME, revision: 1, dirty: false, edited: false });
    // React renders the loaded plan. <PlanSync /> reports that as a change (it cannot tell), and the app is left.
    phone.render();
    expect(phone.rendered.tasks.map((t) => t.id)).toEqual(["x", "y"]);
    engine.planChanged({ edited: false });
    engine.appLeftForeground();
    await engine.idle();
    // What the provider's reducer made of the loaded plan is, to the letter, the plan the account holds.
    expect(server.saves()).toBe(0);
    expect(engine.getStatus().save).toBe("saved");
    expect(record(phone)).toMatchObject({ revision: 1, dirty: false });
  });

  it("another iPhone saved a newer plan: it is loaded, and what the student taps in that very moment lands on it and is saved as its successor", async () => {
    const { device, phone } = iphone(planWith("a"));
    const mine: PlanContents = { state: planWith("a"), feedLinks: phone.feeds.links, feedCount: 1 };
    const inStep: PlanSyncBookkeeping = { v: 1, owner: ME, revision: 1, dirty: false, edited: false, lastSavedAt: "2026-10-05T10:00:00.000Z", deviceId: "this-iphone-AAAAAAAAAAAA", hash: preparePlan(mine).hash, sent: [], savedBy: "this-iphone-AAAAAAAAAAAA", serverSavedAt: "2026-10-05T10:00:00.000Z" };
    phone.storage.data.set(PLAN_SYNC_STORAGE_KEY, JSON.stringify(inStep));
    const server = account(saved(planWith("a", "b"), { feedLinks: phone.feeds.links }), 2);
    const engine = createPlanSyncEngine({ transport: server.transport, storage: phone.storage });
    engine.attach(device);
    engine.setAccount(ME);
    await engine.idle();
    expect(engine.getStatus()).toMatchObject({ phase: "ready", restoredFromAccount: false });
    expect(record(phone)).toMatchObject({ revision: 2, dirty: false });
    expect(phone.onDisk()?.tasks.map((t) => t.id)).toEqual(["a", "b"]);
    // Tapped before React had rendered the load: both arrive in one render, the tap on top of the loaded plan.
    phone.waiting.push({ type: "ADD_TASK", payload: task("c") });
    phone.render();
    phone.persister.schedule(phone.rendered); // usePersistAppState
    engine.planChanged({ edited: true });
    engine.appLeftForeground();
    await engine.idle();
    expect(server.tasks()).toEqual(["a", "b", "c"]);
    expect(server.revision()).toBe(3);
    expect(record(phone)).toMatchObject({ revision: 3, dirty: false, edited: false });
    expect(await phone.persister.flush()).toBe(true);
    expect(phone.onDisk()?.tasks.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("the plan of another account, Continue: this iPhone is emptied but for the safety copy, and this account's plan is put in place", async () => {
    const { device, phone } = iphone(planWith("theirs"), { [APP_STATE_STORAGE_KEY]: JSON.stringify(planWith("theirs")), "@trajectory/aiMemory": "{}" });
    const theirs: PlanSyncBookkeeping = { v: 1, owner: "apple:009999.zzzzzz.9999", revision: 4, dirty: true, edited: true, lastSavedAt: null, deviceId: "this-iphone-AAAAAAAAAAAA", hash: null, sent: [], savedBy: null, serverSavedAt: null };
    phone.storage.data.set(PLAN_SYNC_STORAGE_KEY, JSON.stringify(theirs));
    const server = account(saved(planWith("mine")));
    const engine = createPlanSyncEngine({ transport: server.transport, storage: phone.storage });
    engine.attach(device);
    engine.setAccount(ME);
    await engine.idle();
    const question = engine.getPrompt().question!;
    expect(question).toEqual({ kind: "other-account" });
    expect(server.calls).toEqual([]);
    engine.answer(question, "continue");
    await engine.idle();
    expect(engine.getStatus()).toMatchObject({ phase: "ready", restoredFromAccount: true });
    phone.render();
    expect(phone.rendered.tasks.map((t) => t.id)).toEqual(["mine"]);
    expect(phone.onDisk()?.tasks.map((t) => t.id)).toEqual(["mine"]);
    expect(record(phone)).toMatchObject({ owner: ME, revision: 1 });
    expect(phone.storage.data.has("@trajectory/aiMemory")).toBe(false);
    // The plan that was replaced is kept, readable, and it is the other account's.
    const copy = JSON.parse(phone.storage.data.get(PLAN_SAFETY_COPY_STORAGE_KEY)!) as { why: string; owner: string; snapshot: string };
    expect(copy).toMatchObject({ why: "other-account", owner: "apple:009999.zzzzzz.9999" });
    const kept = decodePlanSnapshot(copy.snapshot);
    expect(kept.kind === "plan" && kept.plan.state.tasks.map((t) => t.id)).toEqual(["theirs"]);
    expect(server.saves()).toBe(0);
  });
});

describe("telling the student's own changes from the app's (lib/app-context.tsx)", () => {
  it("what the app derives by itself, or what is not part of the saved plan, is not the student's change", () => {
    for (const type of ["LOAD_STATE", "LOGOUT", "AUTO_REPLAN", "BATCH_UPDATE_TASK_SCORES", "BUILD_WEEK_FOR", "UPDATE_NOTIFICATION_SETTINGS", "SET_DEVICE_CALENDAR_EVENTS", "CLEAR_DEVICE_CALENDAR_EVENTS", "SET_GOOGLE_CALENDAR_EVENTS", "SET_GOOGLE_CALENDAR_CONNECTED", "CLEAR_GOOGLE_CALENDAR"]) {
      expect(isStudentAction({ type }), type).toBe(false);
    }
  });

  it("everything else is, including anything added later", () => {
    for (const type of ["ADD_TASK", "UPDATE_TASK", "DELETE_TASK", "COMPLETE_TASK", "COMPLETE_BLOCK", "SKIP_BLOCK", "UPDATE_BLOCK", "ADD_BLOCK", "ACCEPT_BLOCK", "ADD_CLASS", "SET_SEMESTER", "APPLY_REPLAN", "UNDO_REPLAN", "REGENERATE_WEEK", "AUTO_BUILD_WEEK", "RESET_SEMESTER", "APPLY_SYLLABUS_IMPORT", "UPDATE_HEALTH_PREFS", "UPDATE_USER_PREFS", "COMPLETE_ONBOARDING", "ADD_EXAM_PREP", "AN_ACTION_NOBODY_HAS_WRITTEN_YET"]) {
      expect(isStudentAction({ type }), type).toBe(true);
    }
  });

  it("every state knows how many of the student's actions went into it, so their changes are told from the app's", () => {
    const start = planWith("a");
    const base = studentEditsIn(start);
    // What the app does by itself adds nothing.
    const replanned = reducer(start, { type: "AUTO_REPLAN", payload: { now: new Date(2026, 9, 5, 9, 0) } });
    expect(replanned).not.toBe(start);
    expect(studentEditsIn(replanned)).toBe(base);
    const scored = reducer(replanned, { type: "BATCH_UPDATE_TASK_SCORES", payload: [{ ...task("a"), priorityScore: 70 }] });
    expect(studentEditsIn(scored)).toBe(base);
    const withEvents = reducer(scored, { type: "SET_DEVICE_CALENDAR_EVENTS", payload: [myEvent] });
    expect(studentEditsIn(withEvents)).toBe(base);
    // What the student does adds one, and it stays in every state that follows.
    const edited = reducer(withEvents, { type: "ADD_TASK", payload: task("b") });
    expect(studentEditsIn(edited)).toBe(base + 1);
    const after = reducer(edited, { type: "AUTO_REPLAN", payload: { now: new Date(2026, 9, 5, 9, 0) } });
    expect(studentEditsIn(after)).toBe(base + 1);
    const again = reducer(after, { type: "COMPLETE_TASK", payload: "a", now: new Date(2026, 9, 5, 9, 0) });
    expect(studentEditsIn(again)).toBe(base + 2);
    // Each state also knows how many times the whole state had been replaced when it was made.
    expect([start, replanned, edited, again].map(stateReplacementsIn)).toEqual([0, 0, 0, 0]);
    const loaded = reducer(again, { type: "LOAD_STATE", payload: planWith("x") });
    expect(stateReplacementsIn(loaded)).toBe(1);
    expect(stateReplacementsIn(reducer(loaded, { type: "ADD_TASK", payload: task("y") }))).toBe(1);
    expect(stateReplacementsIn(reducer(loaded, { type: "LOGOUT" }))).toBe(2);
    // Loading a plan, and a wipe, are not the student's changes either.
    expect(studentEditsIn(reducer(again, { type: "LOAD_STATE", payload: planWith("x") }))).toBe(base + 2);
    expect(studentEditsIn(reducer(again, { type: "LOGOUT" }))).toBe(base + 2);
    // The same state reduced twice (React does that) gives two states that agree.
    expect(studentEditsIn(reducer(withEvents, { type: "ADD_TASK", payload: task("b") }))).toBe(base + 1);
    // An action that changes nothing gives the same state back, and however often the reducer runs it, the count of
    // that state stays what it was (it would otherwise run ahead of the actions really dispatched).
    const changesNothing = { type: "AN_ACTION_NOBODY_HAS_WRITTEN_YET" } as unknown as Action;
    expect(reducer(again, changesNothing)).toBe(again);
    expect(reducer(again, changesNothing)).toBe(again);
    expect(studentEditsIn(again)).toBe(base + 2);
    // The count is beside the state, never in it: nothing of it is persisted or saved.
    expect(Object.keys(again).some((key) => /student/i.test(key))).toBe(false);
    expect(JSON.stringify(again)).not.toMatch(/studentEdits|studentActions/);
  });

  it("an action is counted the moment it is dispatched, before React has rendered it", () => {
    const before = studentActionCount();
    noteDispatched({ type: "AUTO_REPLAN" }, 1_000);
    noteDispatched({ type: "SET_DEVICE_CALENDAR_EVENTS" }, 2_000);
    expect(studentActionCount()).toBe(before);
    noteDispatched({ type: "COMPLETE_BLOCK" }, 3_000);
    expect(studentActionCount()).toBe(before + 1);
    expect(lastStudentActionTime()).toBe(3_000);
    noteDispatched({ type: "AUTO_REPLAN" }, 4_000);
    expect(lastStudentActionTime()).toBe(3_000);
  });
});

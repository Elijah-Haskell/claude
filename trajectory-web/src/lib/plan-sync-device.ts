/**
 * This iPhone's plan as the engine reads and replaces it (the PlanSyncDevice of lib/plan-sync-engine.ts). Everything
 * it touches is handed in, so the one step that replaces a student's plan runs in tests; components/plan-sync.tsx
 * hands it the real state, stores and snapshot writer.
 *
 * Replacing the plan changes three things that no transaction ties together (the state, the Undo copy, the feed
 * links). Three rules make that safe:
 *  - the state is replaced first and in the same breath as the decision to replace it, so nothing the student does
 *    can slip in between and be written over;
 *  - what goes to disk at the end is the newest state that holds the loaded plan: the loaded plan itself, or what
 *    the student has made of it while the stores were being written. Never an older one;
 *  - the engine only records "this iPhone holds revision N" after all of it is on disk. Until then the record still
 *    describes the old plan, and the next check (or the next launch) simply loads the account's plan again.
 */
import { wipeAllLocalAppData, type KeyValueStore } from "./account-deletion-utils";
import type { FeedLinks } from "./lms-feed";
import { stateForLoadedPlan } from "./plan-snapshot";
import { PLAN_SAFETY_COPY_STORAGE_KEY } from "./plan-sync";
import type { PlanSyncDevice } from "./plan-sync-engine";
import type { StatePersister } from "../engine/state-persistence";
import type { AppState } from "../engine/types";
import { UNDO_SNAPSHOT_STORAGE_KEY } from "../engine/undo-persistence";

/** The two actions that replace the whole state (lib/app-context.tsx). */
export type PlanDeviceAction = { type: "LOAD_STATE"; payload: AppState } | { type: "LOGOUT" };

export interface PlanDeviceDeps {
  /** The state React last rendered. */
  rendered: () => AppState;
  dispatch: (action: PlanDeviceAction) => void;
  /** The app's reducer (pure): what the provider will make of an action. */
  reduce: (state: AppState, action: PlanDeviceAction) => AppState;
  /**
   * How many times the whole state had been replaced when `state` was made (lib/app-context.tsx
   * stateReplacementsIn): one more in every state that includes a replacement dispatched here.
   */
  replacements: (state: AppState) => number;
  /** The student did something React has not rendered yet (lib/app-context.tsx counts their actions at the dispatch). */
  editing: () => boolean;
  /** The app's one snapshot writer (lib/use-state-persistence.ts): no older snapshot can land after what goes through it. */
  persister: Pick<StatePersister, "schedule" | "flush" | "cancel" | "idle">;
  storage: KeyValueStore & { removeItem(key: string): Promise<void> };
  /** Throws when storage could not be read: a plan that could not be read is never taken for an empty one. */
  loadFeeds: () => Promise<{ feeds: readonly unknown[]; links: FeedLinks }>;
  /**
   * Keeps this iPhone's feeds, replaces the links, resolves with the number of feeds; rejects when it could not be
   * written. From the moment it is called, a feed refresh that was under way reports nothing (lib/lms-feed-store.ts).
   */
  replaceFeedLinks: (links: FeedLinks) => Promise<number>;
  /** Before a wipe, what is not in storage (the "Trajectory" calendar on the iPhone). Best effort. */
  beforeWipe?: () => Promise<void>;
  cancelReminders?: () => Promise<void>;
}

export interface PlanDevice extends PlanSyncDevice {
  /** True while a loaded plan is being written: what the stores report in that time is the load itself, not a change. */
  isApplying(): boolean;
}

export function createPlanDevice(deps: PlanDeviceDeps): PlanDevice {
  /**
   * A loaded plan (or a wipe) has been dispatched, and this is what the state will be once React has rendered it.
   * Until it has, this is the state the engine must see: it would otherwise read the plan that was just replaced, and
   * could save it. `generation`: the replacement count of that state. A render that does not include the dispatch yet
   * has a lower one (React renders a tap ahead of it), and every render that does include it has at least this one.
   */
  let ahead: { state: AppState; generation: number } | null = null;
  let applying = 0;

  function current(): AppState {
    const rendered = deps.rendered();
    if (ahead && deps.replacements(rendered) < ahead.generation) return ahead.state;
    ahead = null; // React has caught up: from here on the app's own state, later changes included
    return rendered;
  }

  /** Dispatches an action that replaces the state and remembers what the state will be. */
  function replaceState(action: PlanDeviceAction): AppState {
    const next = deps.reduce(current(), action);
    ahead = { state: next, generation: deps.replacements(next) };
    deps.dispatch(action);
    return next;
  }

  return {
    state: current,
    editing: deps.editing,

    async read() {
      const feeds = await deps.loadFeeds();
      return { state: current(), feedLinks: feeds.links, feedCount: feeds.feeds.length };
    },

    async apply(plan) {
      applying++;
      try {
        // Everything up to the first `await` happens in one go, right after the engine decided to load: the state in
        // memory is the loaded plan (with exactly what the provider's reducer makes of it), and a feed refresh that
        // was under way can no longer add its deadlines to it.
        const loaded = replaceState({ type: "LOAD_STATE", payload: stateForLoadedPlan(current(), plan) });
        const generation = deps.replacements(loaded);
        const linksWritten = deps.replaceFeedLinks(plan.feedLinks);
        linksWritten.catch(() => undefined); // reported below; never an unhandled rejection if an earlier step fails
        // The Undo copy on disk belongs to the plan that is being replaced.
        await deps.storage.removeItem(UNDO_SNAPSHOT_STORAGE_KEY);
        const feedCount = await linksWritten;
        // The state on disk, through the app's one snapshot writer (so no older write can land after it): the loaded
        // plan, or what it has become if the student changed something while the stores were being written. Writing
        // the plan as it was loaded would put it on disk without that change.
        const newest = current();
        // Replaced once more in the meantime (the student is signing out, and the wipe has begun): not this load's
        // to write any more.
        if (deps.replacements(newest) !== generation) throw new Error("The plan was replaced again while it was being loaded.");
        deps.persister.schedule(newest);
        if (!(await deps.persister.flush())) throw new Error("The loaded plan could not be written.");
        return { feedCount };
      } finally {
        applying--;
      }
    },

    async wipe() {
      // The same steps as signing out (hooks/use-wipe-local-data.ts): memory first, so the snapshot writer cannot
      // put the old plan back, then everything on disk. Only the safety copy stays.
      replaceState({ type: "LOGOUT" });
      deps.persister.cancel();
      await deps.persister.idle();
      await deps.beforeWipe?.().catch(() => undefined);
      await wipeAllLocalAppData({ storage: deps.storage, cancelReminders: deps.cancelReminders, keep: [PLAN_SAFETY_COPY_STORAGE_KEY] });
    },

    isApplying: () => applying > 0,
  };
}

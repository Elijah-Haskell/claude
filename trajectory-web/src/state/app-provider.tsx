// The app's state for the web: the mobile app's reducer (src/engine/app-context.ts) wrapped in a React provider that
// loads and saves the plan in this browser through the engine's one snapshot writer (so the plan saved to the account
// can be written through the same writer, src/lib/plan-sync-device.ts), rolls the plan forward on a new day and runs
// the automatic whole-semester re-plan whenever something the plan is built from changes.

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";

import { initialState, noteDispatched, reducer, runReplan, type Action, type ReplanRequest, type ScopedReplanPreview } from "../engine/app-context";
import { planInputsKey } from "../engine/plan-inputs";
import { scoreTasks } from "../engine/priority-engine";
import { APP_STATE_STORAGE_KEY, createStatePersister, parsePersistedState, toLocalPersistedState, type StatePersister } from "../engine/state-persistence";
import type { AppState } from "../engine/types";
import { UNDO_SNAPSHOT_STORAGE_KEY, parsePersistedUndo, toPersistedUndo } from "../engine/undo-persistence";
import { localDateKey } from "../engine/utils";
import { appStorage, readLocal, writeLocal } from "../lib/storage";

/** A burst of edits costs one plan. */
const AUTO_REPLAN_DELAY_MS = 1200;

interface AppContextValue {
  state: AppState;
  dispatch: (action: Action) => void;
  isHydrated: boolean;
  /** Preview one Replan request against the CURRENT state (nothing is applied). */
  runReplan: (request: ReplanRequest) => ScopedReplanPreview;
  /** Write the plan now (before an export). */
  flush: () => void;
  /** Replace everything with a plan from a backup file (LOAD_STATE after parsing). */
  importState: (raw: string) => boolean;
  /** The plan as the backup file holds it. */
  exportState: () => string;
}

const AppContext = createContext<AppContextValue | null>(null);

let sharedPersister: StatePersister | null = null;

/**
 * The app's one snapshot writer. Shared, so a wipe can wait for it (`appStatePersister().idle()`), and so a plan
 * loaded from the account is written through it too: with one writer, an older snapshot can never land after it.
 */
export function appStatePersister(): StatePersister {
  sharedPersister ??= createStatePersister({ storage: appStorage });
  return sharedPersister;
}

/** The saved plan (with its undo snapshot), or the pristine state on a first visit. */
function loadInitialState(): AppState {
  const saved = parsePersistedState(readLocal(APP_STATE_STORAGE_KEY));
  if (!saved) return initialState;
  const undo = parsePersistedUndo(readLocal(UNDO_SNAPSHOT_STORAGE_KEY));
  return reducer(initialState, { type: "LOAD_STATE", payload: undo ? { ...saved, undoSnapshots: [undo] } : saved });
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, rawDispatch] = useReducer(reducer, undefined, loadInitialState);
  // The reducer counts the student's own actions per state (the saved plan tells an edit from a re-plan by it).
  const dispatch = useCallback((action: Action) => {
    noteDispatched(action);
    rawDispatch(action);
  }, []);
  // Loaded synchronously from localStorage, so the first render already shows the plan.
  const [isHydrated] = useState(true);
  const stateRef = useRef(state);
  stateRef.current = state;

  // ── Save the plan through the one writer (debounced; at once when the page is hidden) ──
  useEffect(() => {
    const persister = appStatePersister();
    if (state === initialState) {
      // RESET / a wipe / a sign-out: nothing may reappear on the next visit.
      persister.cancel();
      writeLocal(APP_STATE_STORAGE_KEY, null);
      writeLocal(UNDO_SNAPSHOT_STORAGE_KEY, null);
      return;
    }
    persister.schedule(state);
    if (document.visibilityState !== "visible") void persister.flush();
  }, [state]);
  useEffect(() => {
    const flush = () => void appStatePersister().flush();
    const onHide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flush);
    };
  }, []);

  // The newest undo snapshot under its own key (dropping one is written at once: an Undo must never erase an edit).
  const latestUndo = state.undoSnapshots?.[0];
  useEffect(() => {
    if (!latestUndo) {
      writeLocal(UNDO_SNAPSHOT_STORAGE_KEY, null);
      return;
    }
    const timer = setTimeout(() => writeLocal(UNDO_SNAPSHOT_STORAGE_KEY, toPersistedUndo(latestUndo)), 300);
    return () => clearTimeout(timer);
  }, [latestUndo]);

  // ── A new calendar day: the plan rolls forward ──
  const [dayKey, setDayKey] = useState(() => localDateKey(new Date()));
  useEffect(() => {
    const check = () => setDayKey((current) => {
      const next = localDateKey(new Date());
      return next === current ? current : next;
    });
    const interval = setInterval(check, 60_000);
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
    };
  }, []);

  // ── The automatic re-plan: whenever something the plan is built from changes ──
  const lastPlannedKeyRef = useRef("");
  const planTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const current = state;
    if (current.classes.length + current.recurringEvents.length + current.tasks.length + current.scheduleBlocks.length === 0) return;
    if (planInputsKey(current, dayKey) === lastPlannedKeyRef.current) return;
    if (planTimerRef.current) clearTimeout(planTimerRef.current);
    planTimerRef.current = setTimeout(() => {
      planTimerRef.current = null;
      const latest = stateRef.current;
      lastPlannedKeyRef.current = planInputsKey(latest, dayKey);
      const changedScores = scoreTasks(latest.tasks).filter((task) => task.priorityScore !== latest.tasks.find((candidate) => candidate.id === task.id)?.priorityScore);
      if (changedScores.length > 0) dispatch({ type: "BATCH_UPDATE_TASK_SCORES", payload: changedScores });
      dispatch({ type: "AUTO_REPLAN" });
    }, AUTO_REPLAN_DELAY_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.tasks, state.classes, state.recurringEvents, state.semester, state.healthPrefs, state.userPrefs, state.googleCalendarEvents, dayKey]);
  useEffect(() => () => {
    if (planTimerRef.current) clearTimeout(planTimerRef.current);
  }, []);

  const runReplanNow = useCallback((request: ReplanRequest) => runReplan(stateRef.current, request, new Date()), []);
  const flush = useCallback(() => {
    void appStatePersister().flush();
  }, []);
  const exportState = useCallback(() => JSON.stringify(toLocalPersistedState(stateRef.current), null, 2), []);
  const importState = useCallback((raw: string) => {
    const parsed = parsePersistedState(raw);
    if (!parsed) return false;
    dispatch({ type: "LOAD_STATE", payload: parsed });
    return true;
  }, [dispatch]);

  const value = useMemo<AppContextValue>(
    () => ({ state, dispatch, isHydrated, runReplan: runReplanNow, flush, importState, exportState }),
    [state, dispatch, isHydrated, runReplanNow, flush, importState, exportState],
  );
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}

export function useAppState(): AppState {
  return useApp().state;
}

export function useAppDispatch(): (action: Action) => void {
  return useApp().dispatch;
}

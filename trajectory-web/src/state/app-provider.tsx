// The app's state for the web: the mobile app's reducer (src/engine/app-context.ts) wrapped in a React provider that
// loads and saves the plan in this browser (localStorage), rolls the plan forward on a new day and runs the automatic
// whole-semester re-plan whenever something the plan is built from changes. Nothing leaves the browser.

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";

import { initialState, reducer, runReplan, type Action, type ReplanRequest, type ScopedReplanPreview } from "../engine/app-context";
import { planInputsKey } from "../engine/plan-inputs";
import { scoreTasks } from "../engine/priority-engine";
import { APP_STATE_STORAGE_KEY, parsePersistedState, toLocalPersistedState } from "../engine/state-persistence";
import type { AppState } from "../engine/types";
import { UNDO_SNAPSHOT_STORAGE_KEY, parsePersistedUndo, toPersistedUndo } from "../engine/undo-persistence";
import { localDateKey } from "../engine/utils";

export const PERSIST_DEBOUNCE_MS = 400;
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

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): boolean {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** The saved plan (with its undo snapshot), or the pristine state on a first visit. */
function loadInitialState(): AppState {
  const saved = parsePersistedState(readStorage(APP_STATE_STORAGE_KEY));
  if (!saved) return initialState;
  const undo = parsePersistedUndo(readStorage(UNDO_SNAPSHOT_STORAGE_KEY));
  return reducer(initialState, { type: "LOAD_STATE", payload: undo ? { ...saved, undoSnapshots: [undo] } : saved });
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, loadInitialState);
  // Loaded synchronously from localStorage, so the first render already shows the plan.
  const [isHydrated] = useState(true);
  const stateRef = useRef(state);
  stateRef.current = state;

  // ── Save the plan (debounced, and at once when the page is hidden) ──
  const lastWrittenRef = useRef<string | null>(null);
  const writeNow = useCallback(() => {
    const current = stateRef.current;
    if (current === initialState) return; // a fresh install (or a wipe) writes nothing
    const json = JSON.stringify(toLocalPersistedState(current));
    if (json !== lastWrittenRef.current && writeStorage(APP_STATE_STORAGE_KEY, json)) lastWrittenRef.current = json;
  }, []);
  useEffect(() => {
    if (state === initialState) {
      // RESET / a wipe: nothing may reappear on the next visit.
      writeStorage(APP_STATE_STORAGE_KEY, null);
      writeStorage(UNDO_SNAPSHOT_STORAGE_KEY, null);
      lastWrittenRef.current = null;
      return;
    }
    const timer = setTimeout(writeNow, PERSIST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [state, writeNow]);
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") writeNow();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", writeNow);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", writeNow);
    };
  }, [writeNow]);

  // The newest undo snapshot under its own key (dropping one is written at once: an Undo must never erase an edit).
  const latestUndo = state.undoSnapshots?.[0];
  useEffect(() => {
    if (!latestUndo) {
      writeStorage(UNDO_SNAPSHOT_STORAGE_KEY, null);
      return;
    }
    const timer = setTimeout(() => writeStorage(UNDO_SNAPSHOT_STORAGE_KEY, toPersistedUndo(latestUndo)), 300);
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
  const exportState = useCallback(() => JSON.stringify(toLocalPersistedState(stateRef.current), null, 2), []);
  const importState = useCallback((raw: string) => {
    const parsed = parsePersistedState(raw);
    if (!parsed) return false;
    dispatch({ type: "LOAD_STATE", payload: parsed });
    return true;
  }, []);

  const value = useMemo<AppContextValue>(
    () => ({ state, dispatch, isHydrated, runReplan: runReplanNow, flush: writeNow, importState, exportState }),
    [state, isHydrated, runReplanNow, writeNow, importState, exportState],
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

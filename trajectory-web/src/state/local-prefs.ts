// Small per-browser preferences that are not part of the plan (the remembered week view, the flexible-sessions tip,
// the setup recap, the syllabus nudge). Each lives under its own localStorage key with a change notice, so every
// screen that reads one updates when another writes it.

import { useCallback, useSyncExternalStore } from "react";

type Listener = () => void;
const listeners = new Map<string, Set<Listener>>();

function notify(key: string) {
  listeners.get(key)?.forEach((listener) => listener());
}

export function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writePref(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the preference lives for this page only, through the listeners.
    memory.set(key, value);
  }
  notify(key);
}

const memory = new Map<string, string | null>();

function subscribe(key: string, listener: Listener): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === key) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    set!.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** A string preference: its current value (null when unset) and a setter. */
export function useLocalPref(key: string): [string | null, (value: string | null) => void] {
  const value = useSyncExternalStore(
    (listener) => subscribe(key, listener),
    () => (memory.has(key) ? memory.get(key)! : readPref(key)),
    () => null,
  );
  const set = useCallback((next: string | null) => writePref(key, next), [key]);
  return [value, set];
}

/** A boolean flag preference ("1" = on). */
export function useLocalFlag(key: string): [boolean, (on: boolean) => void] {
  const [value, set] = useLocalPref(key);
  return [value === "1", (on) => set(on ? "1" : null)];
}

export const PREF_KEYS = {
  weekView: "trajectory_web_week_view",
  flexibleTipSeen: "trajectory_web_flexible_tip_seen",
  setupRecap: "trajectory_web_setup_recap",
  setupListHidden: "trajectory_web_setup_list_hidden",
  semesterNudgeDismissed: "trajectory_web_semester_nudge_dismissed",
  welcomeSeen: "trajectory_web_welcome_seen",
  geminiKey: "trajectory_web_gemini_key",
  aiModel: "trajectory_web_ai_model",
  /** The local day ("YYYY-MM-DD") the School Year pass banner was last hidden (components/pass-expiry-banner.tsx). */
  passBannerHiddenOn: "trajectory_web_pass_banner_hidden_on",
} as const;

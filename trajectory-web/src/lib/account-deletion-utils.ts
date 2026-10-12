/**
 * Local-data wipe used by Sign out and Delete Account (and when the plan of another account is replaced on this
 * iPhone, lib/plan-sync-engine.ts). The plan itself stays saved in the account unless the account is deleted.
 * Pure module (no React Native imports) so it can be tested against an in-memory AsyncStorage.
 */
import { RETIRED_STORAGE_KEYS } from "../engine/retired-data";

/**
 * Every AsyncStorage key the app writes (including legacy keys from older builds).
 * Add new keys here when a feature starts persisting something new.
 */
export const APP_STORAGE_KEYS: readonly string[] = [
  "trajectory_app_state_v1", // plans, tasks, classes, settings (lib/state-persistence)
  "trajectory_plan_sync_v1", // which account this iPhone's plan belongs to and what was last saved (lib/plan-sync)
  "trajectory_plan_safety_copy_v1", // the plan this iPhone held before a saved plan replaced it (lib/plan-sync)
  "trajectory_sync_metadata_v1", // legacy: version stamp of the original cloud sync (removed; not the saved plan above)
  "trajectory.ai-data-sharing-consent.v1", // AI data-sharing consent
  "@trajectory/aiMemory", // AI personalisation memory
  "@trajectory/onboarding_draft", // legacy onboarding draft
  "trajectory_gcal_token", // legacy client-side Google token
  "semesterNudgeDismissed", // Today-tab "upload your syllabus" nudge
  ...RETIRED_STORAGE_KEYS, // legacy: what removed features stored (lib/retired-data.ts)
];

/** Prefixes that mark a key as belonging to Trajectory (catches keys added later or by older builds). */
const APP_STORAGE_PREFIXES = ["trajectory_", "trajectory.", "@trajectory/"] as const;

/** Whether a stored key belongs to Trajectory. */
export function isAppStorageKey(key: string): boolean {
  return APP_STORAGE_KEYS.includes(key) || APP_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** Keys that belong to Trajectory and are safe to erase during sign-out / account deletion. */
export function getTrajectoryStorageKeys(storageKeys: readonly string[]): string[] {
  return storageKeys.filter(isAppStorageKey);
}

export interface KeyValueStore {
  getAllKeys(): Promise<readonly string[]>;
  multiRemove(keys: string[]): Promise<void>;
}

/**
 * Erase everything Trajectory persisted on this device and cancel scheduled reminders.
 * Known keys are removed even if they are not listed (so a partial listing cannot leave data behind).
 * Reminder cancellation is best-effort (it must not block the wipe); storage errors propagate.
 * `keep` spares the named keys: only for the safety copy written just before another account's plan is replaced on
 * this iPhone. Signing out and deleting the account keep nothing.
 * Returns the keys that were requested for removal.
 */
export async function wipeAllLocalAppData(deps: {
  storage: KeyValueStore;
  cancelReminders?: () => Promise<void>;
  keep?: readonly string[];
}): Promise<string[]> {
  try {
    await deps.cancelReminders?.();
  } catch {
    // Best effort: an OS notification failure must not leave app data on the device.
  }
  const present = await deps.storage.getAllKeys();
  const kept = new Set(deps.keep ?? []);
  const keys = Array.from(new Set([...APP_STORAGE_KEYS, ...getTrajectoryStorageKeys(present)])).filter((key) => !kept.has(key));
  await deps.storage.multiRemove(keys);
  return keys;
}

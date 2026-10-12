// The newest undo snapshot survives an app restart (pure helpers): Undo stays available until the next change.
// It is kept under its OWN storage key, next to the app state: the main snapshot stays small and never contains
// undo copies (see state-persistence.ts), and only the newest change is kept (one copy of the schedule at most).
// Any later edit removes the key at once (lib/app-context.tsx), so a restored snapshot never erases an edit.
// It is this iPhone's own: never part of the plan saved to the account, and removed when a saved plan is loaded
// (lib/plan-sync-device.ts), because it holds the schedule of the plan that was replaced.

import type { ReplanSnapshot } from "./types";

/** AsyncStorage key holding the newest undo snapshot (JSON), or nothing. */
export const UNDO_SNAPSHOT_STORAGE_KEY = "trajectory_undo_snapshot_v1";

/** What is written for a snapshot (OS notification ids never survive a restart). */
export function toPersistedUndo(snapshot: ReplanSnapshot): string {
  return JSON.stringify({
    ...snapshot,
    scheduleBlocks: snapshot.scheduleBlocks.map((block) => ({ ...block, notificationId: undefined })),
  });
}

/** The saved snapshot when it is well-formed; otherwise null. `_now` is kept for existing callers. */
export function parsePersistedUndo(raw: string | null | undefined, _now?: Date): ReplanSnapshot | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const snapshot = value as Partial<ReplanSnapshot>;
  if (typeof snapshot.label !== "string" || typeof snapshot.at !== "string") return null;
  if (!Array.isArray(snapshot.scheduleBlocks) || !Array.isArray(snapshot.tasks)) return null;
  if (!Number.isFinite(new Date(snapshot.at).getTime())) return null;
  return snapshot as ReplanSnapshot;
}

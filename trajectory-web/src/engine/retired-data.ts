/**
 * What an earlier build kept on the iPhone for a feature that is no longer in the app. The app reads none of it; it
 * is removed once at launch, after the app's own state has loaded (lib/app-context.tsx), and by the wipe that signing
 * out and deleting the account run (lib/account-deletion-utils.ts).
 * Pure module (no React Native imports) so it can be tested against an in-memory AsyncStorage.
 */

/** AsyncStorage keys of removed features. A key listed here must never be written again. */
export const RETIRED_STORAGE_KEYS: readonly string[] = [
  "@trajectory/gradeScores", // the scores and targets typed into the Grades screen of earlier builds
];

export interface RetiredDataStorage {
  removeItem(key: string): Promise<void>;
}

/**
 * Removes every retired key. Best effort and never throws: a key that could not be removed is tried again at the
 * next launch, and nothing reads it in the meantime.
 */
export async function removeRetiredData(storage: RetiredDataStorage): Promise<void> {
  for (const key of RETIRED_STORAGE_KEYS) {
    try {
      await storage.removeItem(key);
    } catch {
      // Tried again at the next launch.
    }
  }
}

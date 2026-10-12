import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  APP_STORAGE_KEYS,
  getTrajectoryStorageKeys,
  isAppStorageKey,
  wipeAllLocalAppData,
} from "../../src/lib/account-deletion-utils";

/** Minimal in-memory stand-in for @react-native-async-storage/async-storage. */
class MemoryAsyncStorage {
  private data = new Map<string, string>();
  async setItem(key: string, value: string) { this.data.set(key, value); }
  async getItem(key: string) { return this.data.get(key) ?? null; }
  async getAllKeys() { return Array.from(this.data.keys()); }
  async multiRemove(keys: string[]) { keys.forEach((k) => this.data.delete(k)); }
}

/** Every key the app writes, plus keys that must survive (other apps / Expo internals). */
async function populate(storage: MemoryAsyncStorage) {
  for (const key of APP_STORAGE_KEYS) await storage.setItem(key, "secret-user-data");
  await storage.setItem("trajectory_future_feature_v2", "x"); // a key added by a later build
  await storage.setItem("expo.installation.id", "keep-me");
  await storage.setItem("unrelated.application.key", "keep-me");
}

describe("account-deletion local data cleanup", () => {
  it("selects only Trajectory-owned AsyncStorage keys", () => {
    expect(
      getTrajectoryStorageKeys([
        "trajectory_app_state_v1",
        "trajectory_gcal_token",
        "trajectory.ai-data-sharing-consent.v1",
        "@trajectory/aiMemory",
        "@trajectory/onboarding_draft",
        "semesterNudgeDismissed",
        "unrelated.application.key",
        "expo.installation.id",
      ]),
    ).toEqual([
      "trajectory_app_state_v1",
      "trajectory_gcal_token",
      "trajectory.ai-data-sharing-consent.v1",
      "@trajectory/aiMemory",
      "@trajectory/onboarding_draft",
      "semesterNudgeDismissed",
    ]);
  });
});

// Signing out wipes the iPhone like deleting the account does: the plan stays saved in the account and comes back at
// the next sign-in (lib/plan-sync-client.ts).
describe("wipeAllLocalAppData (sign out / delete account)", () => {
  it("removes what the saved plan keeps on the iPhone: which account the plan belongs to, and the safety copy", async () => {
    const storage = new MemoryAsyncStorage();
    await populate(storage);
    expect(await storage.getItem("trajectory_plan_sync_v1")).not.toBeNull();
    expect(await storage.getItem("trajectory_plan_safety_copy_v1")).not.toBeNull();

    await wipeAllLocalAppData({ storage });

    expect(await storage.getItem("trajectory_plan_sync_v1")).toBeNull();
    expect(await storage.getItem("trajectory_plan_safety_copy_v1")).toBeNull();
  });

  it("can spare named keys: only for the safety copy made just before another account's plan is replaced", async () => {
    const storage = new MemoryAsyncStorage();
    await populate(storage);

    const removed = await wipeAllLocalAppData({ storage, keep: ["trajectory_plan_safety_copy_v1"] });

    expect(await storage.getAllKeys()).toEqual(["trajectory_plan_safety_copy_v1", "expo.installation.id", "unrelated.application.key"]);
    expect(removed).not.toContain("trajectory_plan_safety_copy_v1");
    expect(removed).toContain("trajectory_plan_sync_v1");
    expect(removed).toContain("trajectory_app_state_v1");
  });

  it("removes every persisted app key, including the AI consent and nudge keys the old cleanup missed", async () => {
    const storage = new MemoryAsyncStorage();
    await populate(storage);

    await wipeAllLocalAppData({ storage });

    expect(await storage.getAllKeys()).toEqual(["expo.installation.id", "unrelated.application.key"]);
  });

  it("cancels scheduled reminders", async () => {
    const storage = new MemoryAsyncStorage();
    let cancelled = 0;

    await wipeAllLocalAppData({ storage, cancelReminders: async () => { cancelled += 1; } });

    expect(cancelled).toBe(1);
  });

  it("still wipes the data when cancelling reminders fails", async () => {
    const storage = new MemoryAsyncStorage();
    await populate(storage);

    await wipeAllLocalAppData({ storage, cancelReminders: async () => { throw new Error("notifications unavailable"); } });

    expect(await storage.getItem("trajectory_app_state_v1")).toBeNull();
    expect(await storage.getItem("trajectory.ai-data-sharing-consent.v1")).toBeNull();
  });

  it("removes known keys even if the storage listing does not include them", async () => {
    const removed: string[][] = [];
    const storage = {
      getAllKeys: async () => [] as string[],
      multiRemove: async (keys: string[]) => { removed.push(keys); },
    };

    await wipeAllLocalAppData({ storage });

    expect(removed[0]).toEqual(expect.arrayContaining([...APP_STORAGE_KEYS]));
  });

  it("propagates a storage failure so deletion is never reported as successful", async () => {
    const storage = {
      getAllKeys: async () => ["trajectory_app_state_v1"],
      multiRemove: async () => { throw new Error("disk full"); },
    };

    await expect(wipeAllLocalAppData({ storage })).rejects.toThrow("disk full");
  });
});

describe("every key the app persists is covered by the wipe", () => {
  const ROOT = resolve(__dirname, "../..");

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return sourceFiles(full);
      return /\.(ts|tsx)$/.test(name) ? [full] : [];
    });
  }

  /**
   * Keys the wipe leaves alone on purpose: the session (src/lib/session.ts; logout() removes it last, after the wipe)
   * and the appearance setting (this browser's, not the student's data).
   */
  const KEPT_ON_PURPOSE = new Set(["app_session_token", "app_session_user", "trajectory_web_theme"]);

  it("string-literal storage keys and *_KEY constants in the client are all wiped", () => {
    const keys = new Set<string>();
    for (const dir of ["src/screens", "src/components", "src/state", "src/lib"]) {
      for (const file of sourceFiles(join(ROOT, dir))) {
        const text = readFileSync(file, "utf8");
        for (const m of text.matchAll(/(?:appStorage|localStorage)\s*\.\s*(?:getItem|setItem|removeItem)\(\s*["']([^"']+)["']/g)) keys.add(m[1]);
        for (const m of text.matchAll(/(?:STORAGE_KEY|_KEY)\s*=\s*["']([^"']+)["']/g)) keys.add(m[1]);
        // The per-browser preferences table (src/state/local-prefs.ts PREF_KEYS).
        for (const m of text.matchAll(/^\s+[a-zA-Z]+:\s*"(trajectory_web_[^"]+)",?$/gm)) keys.add(m[1]);
      }
    }
    for (const key of KEPT_ON_PURPOSE) keys.delete(key);

    expect(keys.size).toBeGreaterThanOrEqual(3); // the scan itself finds the app-state, AI-memory and nudge keys
    const uncovered = Array.from(keys).filter((key) => !isAppStorageKey(key));
    expect(uncovered).toEqual([]);
  });
});

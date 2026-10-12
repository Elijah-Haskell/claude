/**
 * The browser's localStorage as the asynchronous key-value store the ported modules expect (AsyncStorage on the
 * iPhone): the plan's snapshot writer, the saved plan's bookkeeping, the course feeds, the AI memory. Reads and
 * writes THROW when storage is unavailable (a private window with storage blocked, quota exceeded): the saved plan
 * must never take "could not read" for "empty".
 */
export interface AsyncKeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  getAllKeys(): Promise<readonly string[]>;
  multiRemove(keys: readonly string[]): Promise<void>;
}

function store(): Storage {
  if (typeof localStorage === "undefined") throw new Error("Storage is unavailable.");
  return localStorage;
}

export const appStorage: AsyncKeyValueStore = {
  async getItem(key) {
    return store().getItem(key);
  },
  async setItem(key, value) {
    store().setItem(key, value);
  },
  async removeItem(key) {
    store().removeItem(key);
  },
  async getAllKeys() {
    const s = store();
    const keys: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const key = s.key(i);
      if (key !== null) keys.push(key);
    }
    return keys;
  },
  async multiRemove(keys) {
    const s = store();
    for (const key of keys) s.removeItem(key);
  },
};

/** Synchronous reads for code that runs before React (never throws: null when unavailable). */
export function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Synchronous writes (null removes). Returns false when storage refused. */
export function writeLocal(key: string, value: string | null): boolean {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

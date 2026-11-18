// Shared app state: firm set-up (people, stages, date fields...), who we're working as,
// and the open matters (for quick-add's #matter lookups).

import { get, setActingUser } from "./api.js";

export const state = {
  setup: null,
  matters: [],
  me: null,
};

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(value));
  } catch {
    /* private mode etc. */
  }
  return null;
}

export const prefs = {
  get: (k, fallback = null) => store("lawdesk." + k) ?? fallback,
  set: (k, v) => store("lawdesk." + k, v),
};

export async function loadSetup() {
  state.setup = await get("/setup");
  const saved = Number(prefs.get("me"));
  const users = state.setup.users;
  if (!users.some((u) => u.id === state.me)) state.me = users.some((u) => u.id === saved) ? saved : users[0]?.id ?? null;
  setActingUser(state.me);
  return state.setup;
}

export async function loadMatters() {
  state.matters = await get("/matters?status=open");
  return state.matters;
}

export function setMe(id) {
  state.me = id;
  prefs.set("me", id);
  setActingUser(id);
}

export const today = () => state.setup?.today;
export const users = () => state.setup?.users ?? [];
export const userName = (id) => state.setup?.allUsers.find((u) => u.id === id)?.name ?? null;
export const dateFieldLabel = (key) => state.setup?.dateFields.find((f) => f.key === key)?.label ?? key;

export function initials(name) {
  return String(name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join("");
}

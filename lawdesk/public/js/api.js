// Fetch wrapper for /api. Sends who the app is "working as" so the activity log can
// name them (attribution only; there is no sign-in yet).

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

let actingUser = null;

export function setActingUser(id) {
  actingUser = id || null;
}

export async function api(method, path, body) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (actingUser) headers["X-Lawdesk-User"] = String(actingUser);
  let res;
  try {
    res = await fetch("/api" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError("Can't reach the Lawdesk server. Is it running?", 0);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty or non-JSON reply */
  }
  if (!res.ok) throw new ApiError((data && data.error) || `Request failed (${res.status})`, res.status);
  return data;
}

export const get = (p) => api("GET", p);
export const post = (p, b = {}) => api("POST", p, b);
export const put = (p, b = {}) => api("PUT", p, b);
export const patch = (p, b = {}) => api("PATCH", p, b);
export const del = (p) => api("DELETE", p);

// Fetch wrapper for /api. The session is an HttpOnly cookie the browser sends by itself;
// every request also carries X-Requested-With, which the server requires on changes so
// another website can't make them on your behalf.

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function api(method, path, body) {
  const headers = { Accept: "application/json", "X-Requested-With": "lawdesk" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch("/api" + path, { method, headers, credentials: "same-origin", body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError("Can't reach the Lawdesk server. Is it running?", 0);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty or non-JSON reply */
  }
  // Signed out (session expired, or signed out on another device): back to sign-in.
  if (res.status === 401 && !path.startsWith("/auth/")) window.dispatchEvent(new Event("lawdesk:signed-out"));
  if (!res.ok) throw new ApiError((data && data.error) || `Request failed (${res.status})`, res.status);
  return data;
}

export const get = (p) => api("GET", p);
export const post = (p, b = {}) => api("POST", p, b);
export const put = (p, b = {}) => api("PUT", p, b);
export const patch = (p, b = {}) => api("PATCH", p, b);
export const del = (p) => api("DELETE", p);

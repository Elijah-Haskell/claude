/**
 * Google Calendar through Trajectory's server, for a connection made before connecting was retired
 * (lib/config.ts GOOGLE_CALENDAR_CONNECT_OFFERED): the REST routes of server/google-calendar.ts, called with the
 * session's Bearer token (lib/api.ts restCall), and the server's events as the plan holds them. Every call answers
 * "not connected" / null when the server cannot be reached, so the screen says so instead of throwing.
 */
import type { Action } from "../engine/app-context";
import type { GoogleCalendarEventLocal } from "../engine/types";
import { restCall } from "./api";

export interface GCalStatus {
  connected: boolean;
  syncEnabled: boolean;
  channelActive: boolean;
  lastSync: string | null;
}

export const NO_GCAL_STATUS: GCalStatus = { connected: false, syncEnabled: false, channelActive: false, lastSync: null };

/** An event as GET /api/gcal/events returns it. */
export interface ServerGoogleEvent {
  id?: string;
  googleEventId?: string;
  calendarId?: string | null;
  title: string;
  description?: string | null;
  startDate: string;
  endDate?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  isAllDay?: boolean | null;
  isRecurring?: boolean | null;
  status?: string | null;
  syncedAt?: string | null;
}

export interface GCalEventsResult {
  connected: boolean;
  lastSync: string | null;
  events: GoogleCalendarEventLocal[];
}

export const NO_GCAL_EVENTS: GCalEventsResult = { connected: false, lastSync: null, events: [] };

/** The server's event as the plan keeps it (the same mapping as the iPhone app's screen and hooks/use-gcal-auto-sync.ts). */
export function googleEventFromServer(e: ServerGoogleEvent, now: Date): GoogleCalendarEventLocal {
  return {
    id: e.googleEventId ?? e.id ?? "",
    calendarId: e.calendarId ?? "primary",
    title: e.title,
    description: e.description ?? undefined,
    startDate: e.startDate,
    endDate: e.endDate ?? undefined,
    startTime: e.startTime ?? undefined,
    endTime: e.endTime ?? undefined,
    isAllDay: e.isAllDay ?? false,
    isRecurring: e.isRecurring ?? false,
    status: e.status === "cancelled" ? "cancelled" : "active",
    syncedAt: e.syncedAt ?? now.toISOString(),
    source: "google",
  };
}

/** GET /api/gcal/status. Not connected when the server does not answer. */
export async function fetchGCalStatus(): Promise<GCalStatus> {
  try {
    const data = await restCall<Partial<GCalStatus> | null>("/api/gcal/status");
    return {
      connected: data?.connected === true,
      syncEnabled: data?.syncEnabled === true,
      channelActive: data?.channelActive === true,
      lastSync: typeof data?.lastSync === "string" ? data.lastSync : null,
    };
  } catch {
    return NO_GCAL_STATUS;
  }
}

/** GET /api/gcal/events: the synced events, as the plan holds them. */
export async function fetchGCalEvents(now: Date = new Date()): Promise<GCalEventsResult> {
  try {
    const data = await restCall<{ connected?: boolean; lastSync?: string | null; events?: ServerGoogleEvent[] } | null>("/api/gcal/events");
    return {
      connected: data?.connected === true,
      lastSync: typeof data?.lastSync === "string" ? data.lastSync : null,
      events: (data?.events ?? []).map((event) => googleEventFromServer(event, now)),
    };
  } catch {
    return NO_GCAL_EVENTS;
  }
}

/** POST /api/gcal/sync: how many events the server synced, or null when the sync did not go through (so the screen can say so). */
export async function triggerManualSync(): Promise<number | null> {
  try {
    const data = await restCall<{ synced?: number } | null>("/api/gcal/sync", { method: "POST" });
    return typeof data?.synced === "number" ? data.synced : 0;
  } catch {
    return null;
  }
}

/** POST /api/gcal/disconnect. Best effort: the app clears its copy either way. */
export async function disconnectGCal(): Promise<void> {
  try {
    await restCall("/api/gcal/disconnect", { method: "POST" });
  } catch {
    // The app clears its copy either way (the server's own cleanup runs on the next sync or sign-in).
  }
}

/** POST /api/gcal/connect: the Google consent URL, or the server's reason when it refused. Only while connecting is offered. */
export async function startGCalConnect(): Promise<{ url: string } | { error: string }> {
  try {
    const data = await restCall<{ url?: string; error?: string } | null>("/api/gcal/connect", { method: "POST" });
    return data?.url ? { url: data.url } : { error: data?.error ?? "" };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "" };
  }
}

/** The action that puts synced events into the plan (as the iPhone app dispatches them). */
export function gcalEventsAction(result: GCalEventsResult, now: Date = new Date()): Extract<Action, { type: "SET_GOOGLE_CALENDAR_EVENTS" }> {
  return {
    type: "SET_GOOGLE_CALENDAR_EVENTS",
    payload: { events: result.events, connected: result.connected, lastSync: result.lastSync ?? now.toISOString() },
  };
}

/** The foreground re-sync of a connection made before runs at most this often (hooks/use-gcal-auto-sync.ts). */
export const GCAL_AUTO_SYNC_MIN_INTERVAL_MS = 5 * 60 * 1000;

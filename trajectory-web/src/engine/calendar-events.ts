import type { AppState, GoogleCalendarEventLocal } from "./types";

/** Where an outside calendar event came from. Older saved Google events have no source. */
export type CalendarEventSource = "google" | "device";

/**
 * Every outside calendar event the plan must work around: synced Google Calendar events plus, when the student turned
 * it on, the events read from the calendars on this iPhone. The planner, conflict checks and plan alerts read busy time
 * through this one function, so a new source is added here and nowhere else.
 * One empty source returns the other array itself (no copy), so memoised callers keep a stable reference.
 */
export function busyCalendarEvents(
  state: Partial<Pick<AppState, "googleCalendarEvents" | "deviceCalendarEvents">>,
): GoogleCalendarEventLocal[] {
  const google = state.googleCalendarEvents ?? [];
  const device = state.deviceCalendarEvents ?? [];
  if (device.length === 0) return google;
  if (google.length === 0) return device;
  return [...google, ...device];
}

/** True for an event read from this iPhone's calendars (as opposed to a synced Google event). */
export function isDeviceCalendarEvent(event: Pick<GoogleCalendarEventLocal, "source">): boolean {
  return event.source === "device";
}

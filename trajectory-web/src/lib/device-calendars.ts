/**
 * The pure part of the iPhone app's lib/device-calendars.ts: the shape of a calendar on the device, the calendars
 * grouped by account, and the line that says when they were last read. A browser cannot read the iPhone's calendars,
 * so nothing here reads anything: the Calendars view (lib/calendars-view.ts) keeps these so its wording stays one
 * module with the iPhone app's, and its tests run unchanged.
 */

/** Device calendar events are read this far ahead. */
export const DEVICE_CALENDAR_WEEKS = 16;

/** One calendar in the checklist. */
export interface DeviceCalendar {
  id: string;
  title: string;
  color?: string;
  /** EventKit calendar type: local | caldav | exchange | subscribed | birthdays. */
  type?: string;
  /** The account it belongs to ("iCloud", "student@gmail.com", "On My iPhone"). */
  account: string;
}

export interface CalendarGroup {
  account: string;
  calendars: DeviceCalendar[];
}

/** The calendars by account, in the order they come (each account's calendars are already together). */
export function groupByAccount(calendars: readonly DeviceCalendar[]): CalendarGroup[] {
  const groups: CalendarGroup[] = [];
  for (const calendar of calendars) {
    const last = groups[groups.length - 1];
    if (last && last.account === calendar.account) last.calendars.push(calendar);
    else groups.push({ account: calendar.account, calendars: [calendar] });
  }
  return groups;
}

/** "Updated 2 min ago · 38 events in the next 16 weeks", or that the calendars are still being read. */
export function deviceCalendarStatus(input: { lastReadAt?: string; upcoming: number; now: Date }): string {
  const read = input.lastReadAt ? new Date(input.lastReadAt).getTime() : NaN;
  if (!Number.isFinite(read)) return "Reading your calendars…";
  const minutes = Math.max(0, Math.floor((input.now.getTime() - read) / 60_000));
  const when = minutes < 1
    ? "just now"
    : minutes < 60
      ? `${minutes} min ago`
      : minutes < 24 * 60
        ? `${Math.floor(minutes / 60)} h ago`
        : `on ${new Date(read).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
  return `Updated ${when} · ${input.upcoming} event${input.upcoming === 1 ? "" : "s"} in the next ${DEVICE_CALENDAR_WEEKS} weeks`;
}

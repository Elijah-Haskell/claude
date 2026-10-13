// Google Calendar through the server, for a connection made before (src/lib/gcal-sync.ts): the server's events as
// the plan holds them, the action that puts them there, and what each route answers when the server does not.
import { afterEach, describe, expect, it, vi } from "vitest";

import { disconnectGCal, fetchGCalEvents, fetchGCalStatus, gcalEventsAction, googleEventFromServer, NO_GCAL_STATUS, triggerManualSync } from "../../src/lib/gcal-sync";

const NOW = new Date("2030-03-13T12:00:00.000Z");

function answer(status: number, body: unknown) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("googleEventFromServer", () => {
  it("maps the server's row to the plan's event, the way the iPhone app does", () => {
    const event = googleEventFromServer(
      { googleEventId: "g1", id: "row-1", calendarId: null, title: "Shift", description: null, startDate: "2030-03-14", endDate: null, startTime: "17:00", endTime: "21:00", isAllDay: null, isRecurring: true, status: "active", syncedAt: null },
      NOW,
    );
    expect(event).toEqual({
      id: "g1",
      calendarId: "primary",
      title: "Shift",
      description: undefined,
      startDate: "2030-03-14",
      endDate: undefined,
      startTime: "17:00",
      endTime: "21:00",
      isAllDay: false,
      isRecurring: true,
      status: "active",
      syncedAt: NOW.toISOString(),
      source: "google",
    });
    // Without a Google id the row's id serves; a cancelled status stays cancelled, anything else is active.
    expect(googleEventFromServer({ id: "row-2", title: "x", startDate: "2030-03-14", status: "cancelled" }, NOW)).toMatchObject({ id: "row-2", status: "cancelled" });
    expect(googleEventFromServer({ id: "row-3", title: "x", startDate: "2030-03-14", status: "confirmed" }, NOW).status).toBe("active");
  });

  it("the action carries the events, the connection and when it synced (now, when the server did not say)", () => {
    const action = gcalEventsAction({ connected: true, lastSync: null, events: [] }, NOW);
    expect(action).toEqual({ type: "SET_GOOGLE_CALENDAR_EVENTS", payload: { events: [], connected: true, lastSync: NOW.toISOString() } });
    expect(gcalEventsAction({ connected: true, lastSync: "2030-03-13T11:00:00.000Z", events: [] }, NOW).payload.lastSync).toBe("2030-03-13T11:00:00.000Z");
  });
});

describe("the routes", () => {
  it("GET /api/gcal/status and /events read the server's answer", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api/gcal/status") return new Response(JSON.stringify({ connected: true, syncEnabled: true, channelActive: false, lastSync: "2030-03-13T11:00:00.000Z" }), { status: 200 });
      if (path === "/api/gcal/events") return new Response(JSON.stringify({ connected: true, lastSync: "2030-03-13T11:00:00.000Z", events: [{ googleEventId: "g1", title: "Shift", startDate: "2030-03-14" }] }), { status: 200 });
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchGCalStatus()).toEqual({ connected: true, syncEnabled: true, channelActive: false, lastSync: "2030-03-13T11:00:00.000Z" });
    const events = await fetchGCalEvents(NOW);
    expect(events.connected).toBe(true);
    expect(events.events.map((e) => e.id)).toEqual(["g1"]);
    expect(fetchMock.mock.calls.map((call) => new URL(String(call[0])).pathname).sort()).toEqual(["/api/gcal/events", "/api/gcal/status"]);
  });

  it("says 'not connected' / null instead of throwing when the server refuses or cannot be reached", async () => {
    vi.stubGlobal("fetch", answer(401, { error: "Not authenticated" }));
    expect(await fetchGCalStatus()).toEqual(NO_GCAL_STATUS);
    expect(await fetchGCalEvents(NOW)).toEqual({ connected: false, lastSync: null, events: [] });
    expect(await triggerManualSync()).toBeNull();
    await expect(disconnectGCal()).resolves.toBeUndefined();

    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    expect(await fetchGCalStatus()).toEqual(NO_GCAL_STATUS);
    expect(await triggerManualSync()).toBeNull();
  });

  it("POST /api/gcal/sync answers how many events came in", async () => {
    const fetchMock = answer(200, { synced: 7 });
    vi.stubGlobal("fetch", fetchMock);
    expect(await triggerManualSync()).toBe(7);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
  });
});

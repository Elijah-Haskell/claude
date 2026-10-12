/**
 * Headless (renders nothing): the iPhone app's hooks/use-gcal-auto-sync.ts for the browser.
 *
 * Re-syncs Google Calendar events whenever the tab comes back into view, for students who connected Google Calendar
 * before connecting was retired (lib/config.ts GOOGLE_CALENDAR_CONNECT_OFFERED). Nobody else calls the server:
 * without a connection in the plan the hook does nothing. Throttled to once every 5 minutes.
 *
 * Mounted from components/headless/course-feed-refresher.tsx (the other "keep outside dates current when the tab
 * comes back" component), since src/app.tsx mounts the headless pieces by name and is not touched by the screen ports.
 */
import { useEffect, useRef } from "react";

import { fetchGCalEvents, GCAL_AUTO_SYNC_MIN_INTERVAL_MS, gcalEventsAction } from "../../lib/gcal-sync";
import { useApp } from "../../state/app-provider";

export function useGCalAutoSync(): void {
  const { state, dispatch } = useApp();
  const connectedRef = useRef(state.googleCalendarConnected);
  connectedRef.current = state.googleCalendarConnected;
  const lastSyncRef = useRef<number>(0);

  useEffect(() => {
    let active = true;
    const onVisible = async () => {
      if (document.visibilityState !== "visible") return;
      // Only a connection made before connecting was retired is kept in sync.
      if (!connectedRef.current) return;
      const now = Date.now();
      if (now - lastSyncRef.current < GCAL_AUTO_SYNC_MIN_INTERVAL_MS) return;
      const result = await fetchGCalEvents();
      if (!active || !result.connected) return;
      lastSyncRef.current = now;
      dispatch(gcalEventsAction(result));
    };
    const listener = () => void onVisible();
    document.addEventListener("visibilitychange", listener);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", listener);
    };
  }, [dispatch]);
}

export function GCalAutoSync(): null {
  useGCalAutoSync();
  return null;
}

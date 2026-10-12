// A clock for the "now" line and the date across midnight: ticks every half minute and whenever the tab comes back.

import { useEffect, useState } from "react";

import { localDateKey } from "../engine/utils";

export interface Clock {
  minutes: number;
  dateKey: string;
}

export function readClock(now: Date = new Date()): Clock {
  return { minutes: now.getHours() * 60 + now.getMinutes(), dateKey: localDateKey(now) };
}

export function useClock(tickMs = 30_000): Clock {
  const [clock, setClock] = useState<Clock>(() => readClock());
  useEffect(() => {
    const tick = () =>
      setClock((previous) => {
        const next = readClock();
        return next.minutes === previous.minutes && next.dateKey === previous.dateKey ? previous : next;
      });
    const interval = setInterval(tick, tickMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", tick);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", tick);
    };
  }, [tickMs]);
  return clock;
}

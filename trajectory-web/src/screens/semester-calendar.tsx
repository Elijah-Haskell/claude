/**
 * The month view lives in the Week screen ("3 days / Week / Month", src/components/month-view.tsx), as in the iPhone
 * app (app/semester-calendar.tsx). This route stays for links from OUTSIDE the app (an old notification, a saved
 * bookmark): it opens Week on its Month view, replacing itself in the history so the back button never returns here.
 * In-app links go straight to "#/week?view=month".
 */
import { useEffect } from "react";

import { navigate } from "../router";

/** Where this route sends: Week, on the month. */
export const SEMESTER_CALENDAR_TARGET = "week?view=month";

export function SemesterCalendarScreen(): null {
  useEffect(() => {
    navigate(SEMESTER_CALENDAR_TARGET, { replace: true });
  }, []);
  return null;
}

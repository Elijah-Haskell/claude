/**
 * Headless (renders nothing), mounted once in src/app.tsx inside AppProvider.
 *
 * Refreshes the student's course calendar feeds (Canvas / LMS) after launch and whenever the tab comes back into
 * view, at most every 6 hours per feed, and applies the changes: new deadlines become tasks, moved due dates move
 * their tasks (the reactive planner then replans). All in this browser; the feed links never reach the server.
 */
import { useEffect, useRef } from "react";

import { feedChangeActions } from "../../lib/lms-feed";
import { refreshCourseFeeds } from "../../lib/lms-feed-store";
import type { Task } from "../../engine/types";
import { useApp } from "../../state/app-provider";

/**
 * Apply a feed refresh through the normal task actions (shared with the Course site link screen), onto the tasks as
 * they are NOW (see feedChangeActions: the refresh was computed from an older snapshot).
 */
export function applyFeedChanges(
  dispatch: ReturnType<typeof useApp>["dispatch"],
  changes: { add: readonly Task[]; update: readonly Task[] },
  currentTasks: readonly Task[],
): void {
  for (const action of feedChangeActions(changes, currentTasks)) dispatch(action);
}

/** After launch, the launch replan settles first. */
const INITIAL_DELAY_MS = 4000;

export function CourseFeedRefresher(): null {
  const { state, dispatch, isHydrated } = useApp();
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (!isHydrated) return;
    let active = true;
    const refresh = async () => {
      const latest = stateRef.current;
      const result = await refreshCourseFeeds({ tasks: latest.tasks, classes: latest.classes }).catch(() => null);
      if (active && result) applyFeedChanges(dispatch, result, stateRef.current.tasks);
    };
    const initial = setTimeout(() => void refresh(), INITIAL_DELAY_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      clearTimeout(initial);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [isHydrated, dispatch]);

  return null;
}

/**
 * Headless (renders nothing), mounted once in src/app.tsx inside the providers.
 *
 * If a syllabus reading was still running on the server when the page was closed or reloaded
 * (src/lib/pending-extraction.ts), open the syllabus screen once the app is open so it picks the result up instead of
 * the student uploading (and paying) again.
 */
import { useEffect, useRef } from "react";

import { loadPendingExtraction } from "../../lib/pending-extraction";
import { startRoute } from "../../lib/start-route";
import { navigate, useRoute } from "../../router";
import { useGateInput } from "../../state/account-gate";

export function ResumePendingExtraction(): null {
  // Only once the app itself is open: signed in, the saved plan settled, the welcome screen done
  // (src/lib/start-route.ts). Before that the syllabus screen would open over the sign-in or the waiting screen.
  const appIsOpen = startRoute(useGateInput()) === "/(tabs)";
  const checkedRef = useRef(false);
  // The syllabus screen picks a pending reading up by itself. When it is already open (a link straight to it, the
  // welcome screen's way in for an empty plan), opening it again would only reload it, asking about the same job.
  const route = useRoute();
  const routeRef = useRef(route.name);
  useEffect(() => {
    routeRef.current = route.name;
  }, [route.name]);

  useEffect(() => {
    if (!appIsOpen || checkedRef.current) return;
    checkedRef.current = true;
    let active = true;
    // Let the start route (the root -> Today / the welcome screen) settle first, then open the syllabus screen on top of it.
    const timer = setTimeout(() => {
      loadPendingExtraction()
        .then((pending) => {
          if (active && pending && routeRef.current !== "syllabus") navigate("syllabus");
        })
        .catch(() => undefined);
    }, 800);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [appIsOpen]);

  return null;
}

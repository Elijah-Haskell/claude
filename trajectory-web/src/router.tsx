// A small hash router: the app is one page, served from any static host, and every screen has a link
// (#/today, #/week, #/tasks, #/study, #/classes, #/exam/<key>, #/activities, #/settings, #/syllabus, #/exam-prep,
// #/exam-prep/<id>, #/imports, #/welcome, #/ai, #/study-guides[/<id>], #/practice[-exam/<id>], #/test-review, #/course-feeds,
// #/calendars, #/reminders, #/semester-calendar, #/paywall, #/delete-account, #/privacy-policy). `useRoute` reads it; `navigate` changes it; `back` goes back when the app
// opened the previous page, otherwise to the tab the page belongs to.

import { useCallback, useEffect, useMemo, useState } from "react";

export interface Route {
  /** The first segment ("today", "exam", ...), "today" when the hash is empty. */
  name: string;
  /** The rest of the path, decoded ("exam/<key>" -> ["<key>"]). */
  segments: string[];
  /** The query after "?", decoded. */
  query: Record<string, string>;
  /** The whole hash path, for comparisons. */
  path: string;
}

export const TAB_ROUTES = ["today", "week", "tasks", "study", "classes"] as const;
export type TabName = (typeof TAB_ROUTES)[number];

/** The tab the bar lights for a route: one exam is part of Study, work and activities and Settings of Classes. */
export function litTabFor(name: string): TabName | null {
  switch (name) {
    case "today":
    case "week":
    case "tasks":
    case "study":
    case "classes":
      return name;
    case "exam":
    case "exam-prep":
    case "study-guides":
    case "study-guide":
    case "practice":
    case "practice-exam":
    case "test-review":
      return "study";
    case "activities":
    case "settings":
    case "imports":
    case "syllabus":
    case "course-feeds":
    case "calendars":
    case "reminders":
    case "semester-calendar":
    case "delete-account":
    case "privacy-policy":
      return "classes";
    default:
      return null;
  }
}

function parse(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  const [pathPart, queryPart] = raw.split("?");
  const parts = (pathPart ?? "").split("/").filter(Boolean).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
  const query: Record<string, string> = {};
  if (queryPart) {
    for (const pair of queryPart.split("&")) {
      const [key, value = ""] = pair.split("=");
      if (key) query[decodeURIComponent(key)] = decodeURIComponent(value);
    }
  }
  const name = parts[0] ?? "today";
  return { name, segments: parts.slice(1), query, path: `/${parts.join("/")}` };
}

export function hrefFor(path: string): string {
  return `#/${path.replace(/^\/+/, "")}`;
}

let historyDepth = 0;

export function navigate(path: string, options: { replace?: boolean } = {}): void {
  const href = hrefFor(path);
  if (options.replace) {
    window.location.replace(href);
    return;
  }
  historyDepth += 1;
  window.location.hash = href;
}

/** Back to the previous page the app opened, else to `fallback`. */
export function goBack(fallback: string): void {
  if (historyDepth > 0) {
    historyDepth -= 1;
    window.history.back();
  } else {
    navigate(fallback, { replace: true });
  }
}

export function useRoute(): Route {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return useMemo(() => parse(hash), [hash]);
}

export function useNavigate() {
  return useCallback((path: string, options?: { replace?: boolean }) => navigate(path, options), []);
}

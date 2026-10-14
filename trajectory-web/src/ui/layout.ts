// Layout helpers for the computer layout (src/styles.css): whether the window is wide enough for the sidebar, and for
// pages laid out in two columns. The phone layout never changes.

import { useEffect, useState } from "react";

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return matches;
}

/** The sidebar is showing (a computer or a tablet held sideways). */
export function useDesktop(): boolean {
  return useMediaQuery("(min-width: 900px)");
}

/** Room for a page's main column and a rail beside it. */
export function useWideLayout(): boolean {
  return useMediaQuery("(min-width: 1180px)");
}

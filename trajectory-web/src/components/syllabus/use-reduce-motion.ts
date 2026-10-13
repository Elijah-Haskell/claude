// Whether the student asked for less motion (the iPhone app's hooks/use-reduce-motion.ts): the browser's
// prefers-reduced-motion setting, followed live.
import { useEffect, useState } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

export function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(() => typeof matchMedia === "function" && matchMedia(QUERY).matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia(QUERY);
    const onChange = () => setReduce(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduce;
}

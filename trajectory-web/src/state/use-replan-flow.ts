// Preview -> Apply (with an undo snapshot) -> Cancel for any plan change: a re-plan, Fit the rest of today, Move to
// tomorrow, a task edit. The mobile app's hooks/use-replan-flow.ts, unchanged in what it guarantees:
//  - open(rebuild) computes the preview from the CURRENT state (nothing is applied);
//  - apply() dispatches APPLY_REPLAN (undoable). If the plan changed while the preview was open (the automatic plan
//    ran), the preview is recomputed and shown again instead of applying a stale one; apply then returns false;
//  - cancel() closes the preview and changes nothing.

import { useCallback, useRef, useState } from "react";

import { changeSummary, type ScopedReplanPreview } from "../engine/app-context";
import type { ReplanPreview } from "../engine/replan";
import type { AppState } from "../engine/types";
import { useApp } from "./app-provider";

interface Pending<P extends ReplanPreview> {
  preview: P;
  base: AppState;
  rebuild: (state: AppState, now: Date) => P;
}

export function useReplanFlow<P extends ReplanPreview = ReplanPreview>() {
  const { state, dispatch } = useApp();
  const stateRef = useRef(state);
  stateRef.current = state;
  const [pending, setPending] = useState<Pending<P> | null>(null);

  const open = useCallback((rebuild: (state: AppState, now: Date) => P) => {
    const base = stateRef.current;
    setPending({ preview: rebuild(base, new Date()), base, rebuild });
  }, []);

  const cancel = useCallback(() => setPending(null), []);

  const apply = useCallback((): boolean => {
    if (!pending) return false;
    const current = stateRef.current;
    if (current.scheduleBlocks !== pending.base.scheduleBlocks || current.tasks !== pending.base.tasks) {
      setPending({ preview: pending.rebuild(current, new Date()), base: current, rebuild: pending.rebuild });
      return false;
    }
    if ((pending.preview as ScopedReplanPreview).needsConfirmation) return false;
    const now = new Date();
    dispatch({
      type: "APPLY_REPLAN",
      payload: {
        label: pending.preview.label,
        at: now.toISOString(),
        next: pending.preview.next,
        summary: changeSummary(current, pending.preview, now) || undefined,
      },
    });
    setPending(null);
    return true;
  }, [pending, dispatch]);

  return { pending, preview: pending?.preview ?? null, open, apply, cancel };
}

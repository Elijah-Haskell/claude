// The sheets that exist once for the whole app: the Add sheet (the add button at the end of the tab bar), the Replan
// sheet (Today's Replan link and notices, Tasks' "Catch up", Settings), a task's sheet and a session's sheet (a
// deadline or a block tapped anywhere opens it in place).

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

import type { AddKind } from "../engine/add-item";
import type { ReplanScope, TodayReplanMode } from "../engine/app-context";

export interface ReplanSheetPreset {
  scope: ReplanScope;
  mode?: TodayReplanMode;
  /** Week scope: the Monday of the week to rebuild (defaults to this week). */
  weekStart?: string;
}

export interface AddSheetPreset {
  kind: AddKind;
  date?: string;
  /** An event that opens with "every week" already on. */
  weekly?: boolean;
}

interface ModalState {
  add: AddSheetPreset | null;
  replan: ReplanSheetPreset | null;
  taskId: string | null;
  blockId: string | null;
}

interface ModalContextValue {
  state: ModalState;
  openAdd: (preset?: Partial<AddSheetPreset>) => void;
  closeAdd: () => void;
  /** Week says which day it is showing, so an event added from there starts on that day. */
  setEventDay: (dateKey: string | null) => void;
  openReplan: (preset?: ReplanSheetPreset) => void;
  closeReplan: () => void;
  openTask: (taskId: string) => void;
  closeTask: () => void;
  openBlock: (blockId: string) => void;
  closeBlock: () => void;
}

const ModalContext = createContext<ModalContextValue | null>(null);

export function ModalProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ModalState>({ add: null, replan: null, taskId: null, blockId: null });
  const eventDay = useRef<string | null>(null);

  const setEventDay = useCallback((dateKey: string | null) => {
    eventDay.current = dateKey;
  }, []);
  const openAdd = useCallback((preset?: Partial<AddSheetPreset>) => {
    const kind = preset?.kind ?? "task";
    setState((prev) => ({ ...prev, add: { kind, date: preset?.date ?? (kind === "event" ? eventDay.current ?? undefined : undefined), weekly: preset?.weekly } }));
  }, []);
  const closeAdd = useCallback(() => setState((prev) => ({ ...prev, add: null })), []);
  const openReplan = useCallback((preset?: ReplanSheetPreset) => setState((prev) => ({ ...prev, replan: preset ?? { scope: "today" } })), []);
  const closeReplan = useCallback(() => setState((prev) => ({ ...prev, replan: null })), []);
  const openTask = useCallback((taskId: string) => setState((prev) => ({ ...prev, taskId, blockId: null })), []);
  const closeTask = useCallback(() => setState((prev) => ({ ...prev, taskId: null })), []);
  const openBlock = useCallback((blockId: string) => setState((prev) => ({ ...prev, blockId, taskId: null })), []);
  const closeBlock = useCallback(() => setState((prev) => ({ ...prev, blockId: null })), []);

  const value = useMemo<ModalContextValue>(
    () => ({ state, openAdd, closeAdd, setEventDay, openReplan, closeReplan, openTask, closeTask, openBlock, closeBlock }),
    [state, openAdd, closeAdd, setEventDay, openReplan, closeReplan, openTask, closeTask, openBlock, closeBlock],
  );
  return <ModalContext.Provider value={value}>{children}</ModalContext.Provider>;
}

export function useGlobalModal(): ModalContextValue {
  const ctx = useContext(ModalContext);
  if (!ctx) throw new Error("useGlobalModal must be used within ModalProvider");
  return ctx;
}

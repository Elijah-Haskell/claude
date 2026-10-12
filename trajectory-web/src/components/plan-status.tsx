// The plan status (lib/plan-alerts.ts planStatusFor), the ONE place Today says the plan needs the student, as a card
// with its fixes; Week shows it as a "N to review" pill. Both open the review sheet: every item with its own fix.
// Also the Undo bar after a replan or an automatic "Plan updated" (a snackbar for 8 seconds, then a quiet row).

import { useCallback, useEffect, useMemo, useState } from "react";

import { alpha } from "../engine/design";
import type { PlanStatus, PlanStatusItem, PlanStatusItemKind } from "../engine/plan-alerts";
import { CATCH_UP, planReview, type PlanFixButton, type PlanReviewRow } from "../engine/plan-review-view";
import { undoAlsoRestores, undoableChange } from "../engine/replan";
import type { ReplanNotice, ReplanSnapshot } from "../engine/types";
import { navigate } from "../router";
import { useApp } from "../state/app-provider";
import { useGlobalModal } from "../state/modal-context";
import { Icon, IconWell, type IconName } from "../ui/icon";
import { Chip, FieldGroup, MONO_FONT, PrimaryButton } from "../ui/primitives";
import { Sheet, SheetBody, SheetHead } from "../ui/sheet";
import { useColors } from "../ui/theme";

export interface PlanFixHandlers {
  editTask: (taskId: string) => void;
  markDone: (taskId: string) => void;
  markSkipped: (taskId: string) => void;
  catchUp: () => void;
  replan: () => void;
  viewTasks: () => void;
}

const KIND_ICON: Record<PlanStatusItemKind, IconName> = { overdue: "warning", missed: "clock", short: "gauge", record: "flag", unplanned: "cal", heavyWeek: "layers" };

export function usePlanItemLook(kind: PlanStatusItemKind): { icon: IconName; color: string } {
  const colors = useColors();
  const color = kind === "overdue" ? colors.error : kind === "unplanned" || kind === "heavyWeek" ? colors.peri : colors.gold;
  return { icon: KIND_ICON[kind], color };
}

/** The usual handler for each fix: the task's sheet, COMPLETE_TASK / UPDATE_TASK for a quiz that took place, the Replan sheet. */
export function usePlanFixHandlers(): PlanFixHandlers {
  const { state, dispatch } = useApp();
  const { openReplan, openTask } = useGlobalModal();
  const tasks = state.tasks;
  return useMemo<PlanFixHandlers>(() => ({
    editTask: (taskId) => openTask(taskId),
    markDone: (taskId) => dispatch({ type: "COMPLETE_TASK", payload: taskId }),
    markSkipped: (taskId) => {
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (task) dispatch({ type: "UPDATE_TASK", payload: { ...task, status: "skipped" } });
    },
    catchUp: () => openReplan({ scope: "semester" }),
    replan: () => openReplan({ scope: "semester" }),
    viewTasks: () => navigate("tasks"),
  }), [dispatch, openReplan, openTask, tasks]);
}

function PlanFixActions({ item, handlers, hideCatchUp }: { item: PlanStatusItem; handlers: PlanFixHandlers; hideCatchUp?: boolean }) {
  const fix = item.fix;
  switch (fix.kind) {
    case "editTask":
      return <Chip icon="edit" label="Edit task" ariaLabel={`Edit ${item.title}: move its deadline or trim its estimate`} onPress={() => handlers.editTask(fix.taskId)} />;
    case "record":
      return (
        <>
          <Chip icon="check" label="Done" ariaLabel={`Mark ${item.title} done`} onPress={() => handlers.markDone(fix.taskId)} />
          <Chip label="Skipped" ariaLabel={`Mark ${item.title} skipped`} onPress={() => handlers.markSkipped(fix.taskId)} />
        </>
      );
    case "catchUp":
      return hideCatchUp ? null : <Chip tone="gold" icon="bolt" label="Catch up" ariaLabel="Catch up: preview replanning the semester" onPress={handlers.catchUp} />;
    case "replan":
      return <Chip icon="bolt" label="Replan" ariaLabel="Replan the semester: preview it first" onPress={handlers.replan} />;
    case "viewTasks":
      return <Chip icon="list" label="View tasks" ariaLabel="View your tasks" onPress={handlers.viewTasks} />;
  }
}

function planStatusLine(status: PlanStatus): { text: string; mono: boolean } {
  const only = status.items.length === 1 ? status.items[0]! : null;
  if (!only) return { text: status.summary, mono: true };
  return { text: status.headline.includes(only.title) ? only.detail : `${only.title} · ${only.detail}`, mono: false };
}

export function PlanStatusCard({ status, handlers, onReview }: { status: PlanStatus; handlers: PlanFixHandlers; onReview: () => void }) {
  const colors = useColors();
  const critical = status.severity === "critical";
  const accent = critical ? colors.error : colors.gold;
  const only = status.items.length === 1 ? status.items[0]! : null;
  const icon: IconName = critical || !only ? "warning" : KIND_ICON[only.kind];
  const line = planStatusLine(status);
  const count = status.items.length;
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 14, padding: "11px 14px", borderRadius: 14, border: `1px solid ${critical ? alpha(colors.error, 0.35) : colors.border}`, background: alpha(colors.peri, 0.07) }}>
      <IconWell name={icon} color={accent} background={alpha(accent, 0.15)} size={36} radius={11} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, lineHeight: "19px", fontWeight: 600, color: colors.foreground }}>{status.headline}</div>
        <div style={line.mono ? { fontFamily: MONO_FONT, fontSize: 10.5, lineHeight: "15px", marginTop: 3, color: colors.muted } : { fontSize: 12.5, lineHeight: "17px", marginTop: 1, color: colors.muted }}>{line.text}</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
          {status.canCatchUp ? <Chip tone={critical ? "red" : "gold"} icon="bolt" label="Catch up" ariaLabel="Catch up: preview replanning the semester around what you missed" onPress={handlers.catchUp} /> : null}
          {only ? (
            <PlanFixActions item={only} handlers={handlers} hideCatchUp={status.canCatchUp} />
          ) : (
            <Chip
              label={<>Review <span style={{ fontFamily: MONO_FONT, color: accent }}>{count}</span></>}
              ariaLabel={`Review ${count} things in your plan, each with its fix`}
              onPress={onReview}
              right={<Icon name="chevronRight" size={13} color={colors.muted} />}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ── The review sheet ──────────────────────────────────────────

function runFix(button: PlanFixButton, handlers: PlanFixHandlers) {
  switch (button.action) {
    case "editTask":
      if (button.taskId) handlers.editTask(button.taskId);
      return;
    case "markDone":
      if (button.taskId) handlers.markDone(button.taskId);
      return;
    case "markSkipped":
      if (button.taskId) handlers.markSkipped(button.taskId);
      return;
    case "catchUp":
      return handlers.catchUp();
    case "replan":
      return handlers.replan();
    case "viewTasks":
      return handlers.viewTasks();
  }
}

function ReviewRow({ row, onFix }: { row: PlanReviewRow; onFix: (button: PlanFixButton) => void }) {
  const colors = useColors();
  const look = usePlanItemLook(row.kind);
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "12px 14px" }}>
      <div className="well" style={{ background: alpha(look.color, 0.14) }}>
        <Icon name={look.icon} size={18} color={look.color} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="row-label">{row.title}</div>
        <div className="row-detail">{row.detail}</div>
        {row.buttons.length > 0 ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
            {row.buttons.map((button) => (
              <button key={button.action} type="button" aria-label={button.accessibilityLabel} onClick={() => onFix(button)} className="pressable" style={{ minHeight: 44, minWidth: 44, padding: "0 14px", borderRadius: 12, border: `1px solid ${colors.borderStrong}`, background: colors.panel, fontSize: 14, fontWeight: 600, color: colors.foreground }}>
                {button.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function PlanReviewSheet({ visible, status, onClose }: { visible: boolean; status: PlanStatus | null; onClose: () => void }) {
  const colors = useColors();
  const handlers = usePlanFixHandlers();
  useEffect(() => {
    if (visible && status === null) onClose();
  }, [visible, status, onClose]);
  const onFix = useCallback((button: PlanFixButton) => {
    if (button.closesSheet) onClose();
    runFix(button, handlers);
  }, [handlers, onClose]);
  if (!visible || !status) return null;
  const review = planReview(status);
  const accent = review.tone === "red" ? colors.error : colors.gold;
  return (
    <Sheet open onClose={onClose} ariaLabel="Plan status">
      <SheetBody>
        <SheetHead eyebrow="Plan status" eyebrowColor={accent} title={review.headline} onClose={onClose} closeLabel="Close the plan review" />
        <div style={{ fontFamily: MONO_FONT, fontSize: 12.5, lineHeight: "18px", fontWeight: 500, marginTop: -8, color: colors.muted }}>{review.summary}</div>
        {review.catchUp ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <PrimaryButton size="lg" fullWidth label={CATCH_UP.label} left={<Icon name="bolt" size={18} color="#fff" />} ariaLabel={CATCH_UP.accessibilityLabel} onPress={() => onFix({ action: "catchUp", label: CATCH_UP.label, accessibilityLabel: CATCH_UP.accessibilityLabel, closesSheet: true })} />
            <p style={{ margin: 0, fontSize: 13, lineHeight: "18px", textAlign: "center", color: colors.muted }}>{CATCH_UP.hint}</p>
          </div>
        ) : null}
        <FieldGroup>
          {review.rows.map((row) => (
            <ReviewRow key={row.key} row={row} onFix={onFix} />
          ))}
        </FieldGroup>
      </SheetBody>
    </Sheet>
  );
}

// ── The Undo bar ──────────────────────────────────────────────

export const SNACKBAR_MS = 8000;
export const UNDO_ROW_MS = 30 * 60 * 1000;
const NO_UNDO_DETAIL = "Your calendar changed, so this update has no Undo";
const time = (iso: string) => new Date(iso).getTime();

interface BarContent {
  at: string;
  headline: string;
  detail: string | null;
  undoLabel: string | null;
}

function barContent(snapshot: ReplanSnapshot | undefined, notice: ReplanNotice | undefined): BarContent | null {
  if (notice && (!snapshot || time(notice.at) >= time(snapshot.at))) {
    return { at: notice.at, headline: `${notice.label}${notice.summary ? ` — ${notice.summary}` : ""}`, detail: NO_UNDO_DETAIL, undoLabel: null };
  }
  if (!snapshot) return null;
  return {
    at: snapshot.at,
    headline: snapshot.source === "auto" ? `${snapshot.label}${snapshot.summary ? ` — ${snapshot.summary}` : ""}` : `${snapshot.label} applied.`,
    detail: undoAlsoRestores(snapshot) ?? (snapshot.source === "auto" ? null : snapshot.summary ?? null),
    undoLabel: snapshot.label,
  };
}

export function UndoReplanBar({ variant }: { variant: "snackbar" | "row" }) {
  const { state, dispatch } = useApp();
  const colors = useColors();
  const shown = barContent(undoableChange(state), state.replanNotice);
  const shownAt = shown?.at;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!shownAt) return;
    const applied = time(shownAt);
    setNow(Date.now());
    const timers = [SNACKBAR_MS, UNDO_ROW_MS]
      .map((ms) => applied + ms - Date.now() + 50)
      .filter((delay) => delay > 0)
      .map((delay) => setTimeout(() => setNow(Date.now()), delay));
    return () => timers.forEach(clearTimeout);
  }, [shownAt]);

  if (!shown) return null;
  const age = now - time(shown.at);
  const isSnackbar = age >= 0 && age < SNACKBAR_MS;
  if (variant === "snackbar" ? !isSnackbar : isSnackbar || !(age < UNDO_ROW_MS)) return null;

  const check = (size: number) => (
    <span style={{ width: size, height: size, borderRadius: size / 2, display: "inline-flex", alignItems: "center", justifyContent: "center", background: alpha(colors.success, 0.15), border: `1px solid ${alpha(colors.success, 0.4)}`, flexShrink: 0 }}>
      <Icon name="check" size={Math.round(size * 0.5)} color={colors.success} strokeWidth={2.2} />
    </span>
  );
  const undoButton = shown.undoLabel === null ? null : (
    <button type="button" aria-label={`Undo ${shown.undoLabel}`} onClick={() => dispatch({ type: "UNDO_REPLAN" })} style={{ display: "inline-flex", alignItems: "center", gap: 6, minHeight: 36, padding: "0 12px", borderRadius: 10, border: `1px solid ${colors.borderStrong}`, background: alpha(colors.peri, 0.08), color: colors.foreground, fontSize: 13, fontWeight: 600, flexShrink: 0 }}>
      <Icon name="undo" size={14} color={colors.foreground} />
      Undo
    </button>
  );
  const text = (
    <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
      <div className="clamp2" style={{ fontSize: variant === "snackbar" ? 14 : 13.5, lineHeight: "19px", fontWeight: 600, color: colors.foreground }}>{shown.headline}</div>
      <div className="clamp2" style={{ fontFamily: MONO_FONT, fontSize: 11, lineHeight: "15px", color: colors.muted }}>{shown.detail ?? "Undo stays until your next change"}</div>
    </div>
  );
  if (variant === "snackbar") {
    return (
      <div className="snack-wrap">
        <div className="snack" role="status" aria-live="polite">
          {check(34)}
          {text}
          {undoButton}
        </div>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 10px 9px 12px", borderRadius: 14, border: `1px solid ${colors.border}`, background: "var(--row-tint)" }}>
      {check(30)}
      {text}
      {undoButton}
    </div>
  );
}

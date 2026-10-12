// A block's sheet (the mobile app's block-detail-sheet): opened with a block ID and read from the CURRENT state on
// every render, so it never acts on a stale copy. The class as a tag and what kind of thing it is, the name, when it
// is and which deadline it works toward; Mark done and Skip; Move (30 min later, pick a time, pick a day, move the
// rest of the day) and "Keep at this time"; Delete as a quiet red line. Moving the rest of the day previews first.

import { useEffect, useState } from "react";

import { runReplan, type ScopedReplanPreview } from "../engine/app-context";
import { alpha, brand, radius } from "../engine/design";
import { blockDueLabel } from "../engine/due-label";
import type { ScheduleBlock } from "../engine/types";
import { formatDuration, formatTime, getDurationMinutes, localDateKey, timeToMinutes, weekStartKeyOf } from "../engine/utils";
import { blockCourseLabel, blockTypeLabel, isFlexibleSession, lockTogglePatch, moveDayPatch, sessionDisplayTitle, timeEditPatch, weekDateKeys, weekdayName } from "../engine/week-layout";
import { findPushedBlock } from "../engine/week-planner";
import { useApp } from "../state/app-provider";
import { PREF_KEYS, useLocalFlag } from "../state/local-prefs";
import { useReplanFlow } from "../state/use-replan-flow";
import { Icon, type IconName } from "../ui/icon";
import { AppSwitch, CourseChip, InlineConfirm, Pill, PrimaryButton, Segmented, TimeInput } from "../ui/primitives";
import { Sheet, SheetBody, SheetHead } from "../ui/sheet";
import { useColors } from "../ui/theme";
import { DeferralConfirm, ReplanPreviewBody } from "./replan-preview";

const DAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function BlockSheet({ blockId, onClose }: { blockId: string | null; onClose: () => void }) {
  const { state } = useApp();
  const block = blockId ? state.scheduleBlocks.find((candidate) => candidate.id === blockId) : undefined;
  // The block disappeared (deleted, re-planned away): the sheet closes itself.
  useEffect(() => {
    if (blockId && !block) onClose();
  }, [blockId, block, onClose]);
  return (
    <Sheet open={Boolean(block)} onClose={onClose} ariaLabel="Session details">
      {block ? <SheetContent key={block.id} block={block} onClose={onClose} /> : null}
    </Sheet>
  );
}

function OptionRow({ icon, label, detail, onPress, danger }: { icon: IconName; label: string; detail?: string; onPress: () => void; danger?: boolean }) {
  const colors = useColors();
  return (
    <button type="button" onClick={onPress} className="pressable" aria-label={detail ? `${label}. ${detail}` : label} style={{ display: "flex", alignItems: "center", gap: 12, minHeight: 48, padding: "10px 12px", borderRadius: radius.md, border: `1px solid ${danger ? alpha(colors.error, 0.4) : colors.borderStrong}`, background: danger ? alpha(colors.error, 0.08) : alpha(colors.peri, 0.06), width: "100%" }}>
      <Icon name={icon} size={17} color={danger ? colors.error : colors.peri} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: danger ? colors.error : colors.foreground }}>{label}</div>
        {detail ? <div style={{ fontSize: 13, lineHeight: "18px", color: colors.muted, marginTop: 1 }}>{detail}</div> : null}
      </div>
    </button>
  );
}

function SheetContent({ block, onClose }: { block: ScheduleBlock; onClose: () => void }) {
  const colors = useColors();
  const { state, dispatch } = useApp();
  const deferFlow = useReplanFlow<ScopedReplanPreview>();
  const [editMode, setEditMode] = useState<"none" | "time" | "day">("none");
  const [moveOpen, setMoveOpen] = useState(false);
  const [editStart, setEditStart] = useState(block.startTime);
  const [editEnd, setEditEnd] = useState(block.endTime);
  const [timeError, setTimeError] = useState<string | null>(null);
  const [pushError, setPushError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const todayKey = localDateKey(new Date());
  const weekDays = weekDateKeys(weekStartKeyOf(block.date)).map((date, index) => ({ label: DAY_SHORT[index]!, date }));
  const duration = getDurationMinutes(block.startTime, block.endTime);
  const isLocked = block.locked && block.type === "class";
  const courseLabel = blockCourseLabel(block, state);
  const isStudy = block.type === "study";
  const canBeMoved = !block.locked && block.completionStatus === "pending";
  const task = block.taskId ? state.tasks.find((candidate) => candidate.id === block.taskId) : undefined;
  const dueText = blockDueLabel(block, task, todayKey);
  const flexible = isFlexibleSession(block);
  const kept = isStudy && block.completionStatus === "pending" && !flexible;
  const canKeep = isStudy && block.completionStatus === "pending";
  const canPush = isStudy && canBeMoved;
  const canMoveRestOfDay = isStudy && block.completionStatus === "pending";
  const restOfDayLabel = block.date === todayKey ? "Move the rest of today to tomorrow" : `Move the rest of ${weekdayName(block.date)} to the next day`;
  const kindWord = isStudy ? "Study session" : block.type === "class" ? "Class" : block.type === "recurring" || block.type === "work" ? "Every week" : blockTypeLabel(block.type);
  const title = isStudy ? sessionDisplayTitle(block.title, task?.courseName) : block.title;
  const dayWord = block.date === todayKey ? "Today" : weekdayName(block.date);
  const showTools = editMode === "none" && !isLocked;

  function deferDay(acceptLate: boolean) {
    const date = block.date;
    deferFlow.open((current, now) => runReplan(current, { scope: "today", mode: "defer", date, acceptLate }, now));
  }
  function pushThirty() {
    if (!findPushedBlock(block, state.scheduleBlocks, 30)) {
      setPushError("No room to move this later: something else follows it, or it would run past your bedtime. Try Pick a time or Pick a day.");
      return;
    }
    dispatch({ type: "PUSH_BLOCK", payload: { blockId: block.id, minutes: 30 } });
    onClose();
  }
  function saveTime() {
    if (!editStart || !editEnd || timeToMinutes(editEnd) <= timeToMinutes(editStart)) {
      setTimeError("The end must be after the start.");
      return;
    }
    dispatch({ type: "UPDATE_BLOCK", payload: timeEditPatch(block, editStart, editEnd) });
    onClose();
  }
  function moveToDay(date: string) {
    if (date !== block.date) dispatch({ type: "UPDATE_BLOCK", payload: moveDayPatch(block, date) });
    setEditMode("none");
    if (date !== block.date) onClose();
  }
  function keepToggle(next: boolean) {
    if (next) dispatch({ type: "ACCEPT_BLOCK", payload: block.id });
    else dispatch({ type: "UPDATE_BLOCK", payload: { id: block.id, accepted: false, userEdited: false, locked: false } });
  }

  if (deferFlow.preview?.needsConfirmation) {
    return <DeferralConfirm risk={deferFlow.preview.needsConfirmation} onKeep={deferFlow.cancel} onMoveAnyway={() => deferDay(true)} />;
  }
  if (deferFlow.preview) {
    return (
      <ReplanPreviewBody
        next={deferFlow.preview.next}
        title={block.date === todayKey ? "Move the rest of today?" : `Move ${weekdayName(block.date)}'s remaining study?`}
        summary={deferFlow.preview.summary}
        diff={deferFlow.preview.diff}
        shortfalls={deferFlow.preview.shortfalls}
        applyLabel={block.date === todayKey ? "Move to tomorrow" : "Move to the next day"}
        onApply={() => { if (deferFlow.apply()) onClose(); }}
        onCancel={deferFlow.cancel}
      />
    );
  }

  return (
    <SheetBody>
      <div className="sheet-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, paddingTop: 6 }}>
            {courseLabel ? <CourseChip label={courseLabel} color={block.color} /> : null}
            <span className="truncate" style={{ fontSize: 13, color: colors.muted }}>{kindWord}</span>
          </div>
          <h2 className="sheet-title" style={{ paddingTop: 0 }}>{title}</h2>
        </div>
        <button type="button" aria-label="Close" onClick={onClose} className="pressable" style={{ width: 44, height: 44, borderRadius: 13, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: colors.surface, border: `1px solid ${colors.borderStrong}` }}>
          <Icon name="close" size={18} color={colors.muted} strokeWidth={2} />
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
          <Icon name="clock" size={18} color={colors.peri} />
          <span style={{ flex: 1, fontSize: 15, lineHeight: "20px", color: colors.foreground }}>
            {dayWord}, {formatTime(block.startTime)} – {formatTime(block.endTime)} · {formatDuration(duration)}
          </span>
        </div>
        {dueText && task ? (
          <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
            <Icon name="flag" size={18} color={colors.gold} />
            <span style={{ flex: 1, fontSize: 15, lineHeight: "20px", color: colors.foreground }}>
              For {task.name}, <span style={{ color: colors.gold }}>{dueText}</span>
            </span>
          </div>
        ) : null}
      </div>

      {block.completionStatus === "done" || block.completionStatus === "skipped" || block.locked ? (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {block.completionStatus === "done" ? <Pill label="Done" tone="green" size="md" left={<Icon name="check" size={13} color={colors.success} strokeWidth={2.4} />} /> : null}
          {block.completionStatus === "skipped" ? <Pill label="Skipped" tone="neutral" size="md" /> : null}
          {block.locked ? <Pill label="Never moves" tone="peri" size="md" left={<Icon name="lock" size={13} color={colors.peri} />} /> : null}
        </div>
      ) : null}

      {block.schedulingReason && isStudy ? (
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: 12, borderRadius: radius.md, border: `1px solid ${alpha(colors.violet, 0.35)}`, background: alpha(colors.violet, 0.1) }}>
          <Icon name="spark" size={16} color={colors.violet} />
          <span style={{ flex: 1, fontSize: 13, lineHeight: "18px", color: colors.foreground }}>{block.schedulingReason}</span>
        </div>
      ) : null}

      {editMode === "time" ? (
        <div style={{ padding: 14, borderRadius: radius.lg, border: `1px solid ${colors.border}`, background: colors.surface, display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 15, fontWeight: 600 }}>
            <Icon name="clock" size={16} color={colors.peri} /> Pick a time
          </div>
          <div style={{ display: "flex", gap: 12 }}>
            <label style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="eyebrow" style={{ fontSize: 10, color: colors.muted }}>Start</span>
              <TimeInput value={editStart} onChange={(value) => { setEditStart(value); setTimeError(null); }} ariaLabel="Start time" style={{ width: "100%" }} />
            </label>
            <label style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="eyebrow" style={{ fontSize: 10, color: colors.muted }}>End</span>
              <TimeInput value={editEnd} onChange={(value) => { setEditEnd(value); setTimeError(null); }} ariaLabel="End time" style={{ width: "100%" }} />
            </label>
          </div>
          {timeError ? <div role="alert" style={{ fontSize: 14, fontWeight: 600, color: colors.gold, textAlign: "center" }}>{timeError}</div> : null}
          <div style={{ display: "flex", gap: 10 }}>
            <PrimaryButton label="Cancel" tone="ghost" style={{ flex: 1 }} onPress={() => { setEditStart(block.startTime); setEditEnd(block.endTime); setEditMode("none"); }} />
            <PrimaryButton label="Save time" style={{ flex: 1 }} onPress={saveTime} />
          </div>
        </div>
      ) : null}

      {editMode === "day" ? (
        <div style={{ padding: 14, borderRadius: radius.lg, border: `1px solid ${colors.border}`, background: colors.surface, display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 15, fontWeight: 600 }}>
            <Icon name="cal" size={16} color={colors.peri} /> Pick a day
          </div>
          <Segmented
            scroll
            value={block.date}
            onChange={moveToDay}
            options={weekDays.map(({ label, date }) => ({ value: date, label: date === todayKey ? "Today" : `${label} ${Number(date.slice(8, 10))}`, ariaLabel: `${weekdayName(date)}${date === todayKey ? ", today" : ""}${date === block.date ? ", current day" : ""}` }))}
          />
          <PrimaryButton label="Cancel" tone="ghost" fullWidth size="sm" onPress={() => setEditMode("none")} />
        </div>
      ) : null}

      {editMode === "none" ? (
        <div style={{ display: "flex", gap: 10 }}>
          {block.completionStatus !== "done" ? (
            <PrimaryButton label="Mark done" size="lg" left={<Icon name="check" size={18} color={brand.white} strokeWidth={2.4} />} style={{ flex: 2 }} onPress={() => { dispatch({ type: "COMPLETE_BLOCK", payload: block.id }); onClose(); }} />
          ) : (
            <PrimaryButton label="Mark not done" tone="ghost" size="lg" left={<Icon name="undo" size={17} color={colors.foreground} />} style={{ flex: 2 }} onPress={() => { dispatch({ type: "UNCOMPLETE_BLOCK", payload: block.id }); onClose(); }} />
          )}
          {block.completionStatus !== "skipped" && block.completionStatus !== "done" ? (
            <PrimaryButton label="Skip" tone="ghost" size="lg" style={{ flex: 1 }} onPress={() => { dispatch({ type: "SKIP_BLOCK", payload: block.id }); onClose(); }} />
          ) : null}
        </div>
      ) : null}

      {showTools ? (
        <div className="group">
          <button type="button" className="row pressable" aria-expanded={moveOpen} aria-label="Move: 30 minutes later, pick a time or pick a day" onClick={() => setMoveOpen((open) => !open)}>
            <div className="well" style={{ background: alpha(colors.peri, 0.12) }}>
              <Icon name="clock" size={18} color={colors.peri} />
            </div>
            <div className="row-text row-label">Move</div>
            <Icon name={moveOpen ? "chevronDown" : "chevronRight"} size={18} color={colors.muted} />
          </button>
          {canKeep ? (
            <div className="row">
              <div className="well" style={{ background: alpha(colors.peri, 0.12) }}>
                <Icon name="pin" size={18} color={colors.peri} />
              </div>
              <div className="row-text">
                <div className="row-label">Keep at this time</div>
                <div className="row-detail">{kept ? "The plan works around it" : "Off: the plan may move it"}</div>
              </div>
              <AppSwitch value={kept} onValueChange={keepToggle} ariaLabel="Keep at this time" />
            </div>
          ) : null}
        </div>
      ) : null}

      {showTools && moveOpen ? (
        <div style={{ padding: 14, borderRadius: radius.lg, border: `1px solid ${colors.border}`, background: colors.surface, display: "flex", flexDirection: "column", gap: 10 }}>
          {canPush ? <OptionRow icon="arrow" label="30 min later" detail="Or the next free time after that, the same day" onPress={pushThirty} /> : null}
          {pushError ? <div role="alert" style={{ fontSize: 13, lineHeight: "18px", color: colors.gold }}>{pushError}</div> : null}
          <OptionRow icon="clock" label="Pick a time" detail="Choose the start and end" onPress={() => setEditMode("time")} />
          <OptionRow icon="cal" label="Pick a day" detail="Move it to another day of this week" onPress={() => setEditMode("day")} />
          {canMoveRestOfDay ? <OptionRow icon="moon" label={restOfDayLabel} detail="Shows what moves before anything changes" onPress={() => deferDay(false)} /> : null}
          <OptionRow icon="lock" label={block.locked ? "Allow moving" : "Never move this session"} detail={block.locked ? undefined : "Not even when you replan"} onPress={() => { dispatch({ type: "UPDATE_BLOCK", payload: lockTogglePatch(block) }); onClose(); }} />
        </div>
      ) : null}

      {showTools ? (
        confirmingDelete ? (
          <InlineConfirm
            question={isStudy && block.taskId ? `Remove "${block.title}"? The task still needs this time, so it may be planned again.` : `Remove "${block.title}" from your schedule?`}
            confirmLabel="Delete"
            onConfirm={() => { dispatch({ type: "DELETE_BLOCK", payload: block.id }); onClose(); }}
            onCancel={() => setConfirmingDelete(false)}
          />
        ) : (
          <button type="button" className="link danger" onClick={() => setConfirmingDelete(true)} style={{ alignSelf: "center", minHeight: 44, fontSize: 15 }}>
            {isStudy ? "Delete session" : "Delete"}
          </button>
        )
      ) : null}
    </SheetBody>
  );
}

/**
 * The one-time tip the first time Today or Week shows a flexible (dashed) session: what "flexible" means and how to
 * pin one. `visible` = the screen shows at least one flexible session right now.
 */
export function FlexibleSessionsTip({ visible }: { visible: boolean }) {
  const colors = useColors();
  const [seen, setSeen] = useLocalFlag(PREF_KEYS.flexibleTipSeen);
  if (!visible || seen) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, paddingLeft: 12, borderRadius: 14, border: `1px solid ${alpha(colors.gold, 0.35)}`, background: alpha(colors.gold, 0.07) }}>
      <span style={{ width: 22, height: 16, borderRadius: 5, border: `1.5px dashed ${colors.gold}`, background: alpha(colors.peri, 0.12), flexShrink: 0 }} />
      <span style={{ flex: 1, fontSize: 13, lineHeight: "18px", padding: "10px 0", color: colors.foreground }}>
        Dashed sessions are flexible: Trajectory may move them when your plan changes. Open one and turn on Keep at this time to pin it.
      </span>
      <button type="button" aria-label="Got it, hide this tip" onClick={() => setSeen(true)} style={{ width: 44, minHeight: 44, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Icon name="close" size={15} color={colors.dim} />
      </button>
    </div>
  );
}

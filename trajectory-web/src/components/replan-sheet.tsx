// THE one place to replan ("Replan" is the one name). Step 1: a scope and, for Today, what to do; step 2: the preview.
// Nothing changes until Apply; afterwards the Undo bar restores it. Every preview comes from runReplan (the engine's
// single seam). While the last change can still be undone the sheet opens with an "Undo last change" row.

import { useEffect, useMemo, useState } from "react";

import { runReplan, type ReplanRequest, type ReplanScope, type ScopedReplanPreview } from "../engine/app-context";
import { busyCalendarEvents } from "../engine/calendar-events";
import { calendarConflicts, doNotScheduleConflicts } from "../engine/day-conflicts";
import { alpha } from "../engine/design";
import { planStatusFor } from "../engine/plan-alerts";
import { undoableChange } from "../engine/replan";
import { BEDTIME_SWITCH, behindLine, blocksLeftLine, chosenTodayMode, KEPT_SWITCH, presetChoice, PREVIEW_TITLE, previewOffersKeptSwitch, REPLAN_HINT, REPLAN_QUIET_NOTE, REPLAN_SUB, semesterOption, todayOptions, todayRequestMode, undoRow, weekOption, type TodayChoice } from "../engine/replan-view";
import { localDateKey, weekStartKeyOf } from "../engine/utils";
import { useApp } from "../state/app-provider";
import type { ReplanSheetPreset } from "../state/modal-context";
import { useReplanFlow } from "../state/use-replan-flow";
import { Icon, type IconName } from "../ui/icon";
import { AppSwitch, FieldGroup, FieldRow, MONO_FONT, PrimaryButton, Segmented } from "../ui/primitives";
import { Sheet, SheetBody, SheetHead } from "../ui/sheet";
import { useColors } from "../ui/theme";
import { DeferralConfirm, ReplanPreviewBody } from "./replan-preview";

function OptionRow({ icon, title, range, detail }: { icon: IconName; title: string; range?: string; detail: string }) {
  const colors = useColors();
  return (
    <div className="row" style={{ alignItems: "flex-start", padding: "10px 14px" }}>
      <div className="well" style={{ background: alpha(colors.peri, 0.12), marginTop: 2 }}>
        <Icon name={icon} size={18} color={colors.peri} />
      </div>
      <div className="row-text">
        <div className="row-label">{title}</div>
        {range ? <div style={{ fontFamily: MONO_FONT, fontSize: 13, lineHeight: "18px", fontWeight: 500, marginTop: 1, color: colors.peri }}>{range}</div> : null}
        <div className="row-detail">{detail}</div>
      </div>
    </div>
  );
}

export function ReplanSheet({ preset, onClose }: { preset: ReplanSheetPreset | null; onClose: () => void }) {
  const colors = useColors();
  const { state, dispatch } = useApp();
  const flow = useReplanFlow<ScopedReplanPreview>();
  const [scope, setScope] = useState<ReplanScope>("today");
  const [mode, setMode] = useState<TodayChoice>("protect_sleep");
  const [untilBedtime, setUntilBedtime] = useState(false);
  const [moveAccepted, setMoveAccepted] = useState(false);
  const [step, setStep] = useState<"options" | "preview">("options");
  const visible = preset !== null;

  useEffect(() => {
    if (!preset) return;
    const opening = presetChoice(preset);
    setScope(opening.scope);
    setMode(opening.mode);
    setUntilBedtime(opening.untilBedtime);
    setMoveAccepted(false);
    setStep("options");
    flow.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset]);

  const today = localDateKey(new Date());
  const weekStart = preset?.weekStart ?? weekStartKeyOf(today);
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  const facts = useMemo(() => {
    if (!visible) return null;
    const pendingStudy = state.scheduleBlocks.filter((b) => b.date === today && b.type === "study" && b.completionStatus === "pending" && b.taskId).length;
    const remaining = state.scheduleBlocks.filter((b) => b.date === today && b.completionStatus === "pending" && !b.locked && b.type !== "sleep" && b.type !== "buffer").length;
    const calendarClashes = calendarConflicts(state.scheduleBlocks, busyCalendarEvents(state), today, nowMinutes).length;
    const zoneClashes = doNotScheduleConflicts(state.scheduleBlocks, state.recurringEvents, today).length;
    const status = planStatusFor(state, now);
    return { pendingStudy, remaining, calendarClashes, zoneClashes, status };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, state.scheduleBlocks, state.recurringEvents, state.tasks, state.planAlerts, state.userPrefs, today]);

  if (!visible || !facts) return null;

  const options = todayOptions(facts, preset?.mode);
  const chosen = chosenTodayMode(options, mode);
  const behind = facts.status?.canCatchUp === true;
  const week = weekOption(weekStart);
  const semester = semesterOption(behind);

  const request = (move = moveAccepted, acceptLate = false): ReplanRequest =>
    scope === "today"
      ? { scope, mode: todayRequestMode(chosen, untilBedtime), acceptLate }
      : scope === "week"
        ? { scope, weekStart }
        : { scope, moveAccepted: move, reason: semester.reason };

  function preview(move = moveAccepted, acceptLate = false) {
    const next = request(move, acceptLate);
    flow.open((s, at) => runReplan(s, next, at));
    setStep("preview");
  }
  function apply() {
    if (flow.apply()) onClose();
  }
  function backToOptions() {
    flow.cancel();
    setStep("options");
  }

  const current = flow.preview;
  const lastChange = undoableChange(state);
  const undo = undoRow(lastChange);

  return (
    <Sheet open onClose={onClose} ariaLabel="Replan">
      {step === "preview" && current?.needsConfirmation ? (
        <DeferralConfirm risk={current.needsConfirmation} onKeep={backToOptions} onMoveAnyway={() => preview(moveAccepted, true)} onClose={onClose} />
      ) : step === "preview" && current ? (
        <ReplanPreviewBody
          next={current.next}
          title={PREVIEW_TITLE[scope]}
          summary={current.summary}
          diff={current.diff}
          shortfalls={current.shortfalls}
          unplaced={current.unplaced}
          applyLabel="Apply changes"
          applyDisabled={!current.diff.changed}
          onApply={apply}
          onCancel={backToOptions}
          onClose={onClose}
        >
          {previewOffersKeptSwitch(scope, current.shortfalls.length, moveAccepted) ? (
            <FieldGroup>
              <FieldRow first icon="lock" label={KEPT_SWITCH.label} detail={KEPT_SWITCH.detail}>
                <AppSwitch ariaLabel={`${KEPT_SWITCH.label}. ${KEPT_SWITCH.detail}`} value={moveAccepted} onValueChange={(value) => { setMoveAccepted(value); preview(value); }} />
              </FieldRow>
            </FieldGroup>
          ) : null}
        </ReplanPreviewBody>
      ) : (
        <SheetBody>
          <SheetHead title="Replan" onClose={onClose} closeLabel="Close Replan" />
          <p className="sheet-sub">{REPLAN_SUB}</p>

          {undo && lastChange ? (
            <FieldGroup>
              <div className="row">
                <div className="well" style={{ background: alpha(colors.peri, 0.12) }}>
                  <Icon name="undo" size={18} color={colors.peri} />
                </div>
                <div className="row-text">
                  <div className="row-label">{undo.label}</div>
                  <div className="row-detail">{undo.detail}</div>
                </div>
                <button type="button" className="link" aria-label={undo.accessibilityLabel} onClick={() => { dispatch({ type: "UNDO_REPLAN" }); onClose(); }} style={{ minHeight: 44, padding: "0 8px", fontSize: 15 }}>
                  Undo
                </button>
              </div>
            </FieldGroup>
          ) : null}

          <Segmented
            value={scope}
            onChange={(value) => setScope(value)}
            options={[
              { value: "today", label: "Today", ariaLabel: "Replan today" },
              { value: "week", label: "This week", ariaLabel: "Replan this week" },
              { value: "semester", label: "Semester", ariaLabel: "Replan the whole semester" },
            ]}
          />

          {scope === "today" ? (
            <>
              <FieldGroup>
                <div role="radiogroup">
                  {options.map((option, index) => {
                    const selected = chosen === option.mode;
                    return (
                      <button key={option.mode} type="button" role="radio" aria-checked={selected} aria-label={`${option.title}. ${option.detail}`} onClick={() => setMode(option.mode)} className="row pressable" style={{ padding: "10px 14px", borderTop: index > 0 ? `1px solid ${colors.border}` : undefined }}>
                        <span style={{ width: 24, height: 24, borderRadius: 12, border: `1.5px solid ${selected ? colors.accent : alpha(colors.muted, 0.75)}`, display: "inline-flex", alignItems: "center", justifyContent: "center", margin: "0 5px", flexShrink: 0 }}>
                          {selected ? <span style={{ width: 12, height: 12, borderRadius: 6, background: colors.accent }} /> : null}
                        </span>
                        <span className="row-text">
                          <span className="row-label" style={{ display: "block" }}>{option.title}</span>
                          <span className="row-detail" style={{ display: "block" }}>{option.detail}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </FieldGroup>
              {chosen === "protect_sleep" ? (
                <FieldGroup>
                  <FieldRow first icon="moon" label={BEDTIME_SWITCH.label} detail={BEDTIME_SWITCH.detail}>
                    <AppSwitch ariaLabel={`${BEDTIME_SWITCH.label}. ${BEDTIME_SWITCH.detail}`} value={untilBedtime} onValueChange={setUntilBedtime} />
                  </FieldRow>
                </FieldGroup>
              ) : null}
              <div style={{ fontFamily: MONO_FONT, fontSize: 12.5, lineHeight: "17px", fontWeight: 500, padding: "0 2px", marginTop: -4, color: colors.muted }}>{blocksLeftLine(facts.remaining)}</div>
            </>
          ) : scope === "week" ? (
            <FieldGroup>
              <OptionRow icon="cal" title={week.title} range={week.range} detail={week.detail} />
            </FieldGroup>
          ) : (
            <>
              {behind && facts.status ? <div style={{ fontFamily: MONO_FONT, fontSize: 12.5, lineHeight: "17px", fontWeight: 500, padding: "0 2px", marginTop: -4, color: colors.gold }}>{behindLine(facts.status.summary)}</div> : null}
              <FieldGroup>
                <OptionRow icon="refresh" title={semester.title} detail={semester.detail} />
                <FieldRow icon="lock" label={KEPT_SWITCH.label} detail={KEPT_SWITCH.detail}>
                  <AppSwitch ariaLabel={`${KEPT_SWITCH.label}. ${KEPT_SWITCH.detail}`} value={moveAccepted} onValueChange={setMoveAccepted} />
                </FieldRow>
              </FieldGroup>
            </>
          )}

          <PrimaryButton size="lg" fullWidth label="Preview changes" onPress={() => preview()} />
          <div>
            <p style={{ margin: 0, fontSize: 13, lineHeight: "18px", textAlign: "center", color: colors.muted }}>{REPLAN_HINT}</p>
            <p style={{ margin: 0, fontSize: 13, lineHeight: "18px", textAlign: "center", color: colors.muted }}>{REPLAN_QUIET_NOTE}</p>
          </div>
        </SheetBody>
      )}
    </Sheet>
  );
}

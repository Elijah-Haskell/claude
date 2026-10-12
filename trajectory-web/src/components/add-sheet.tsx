// The one Add sheet, opened by the add button at the end of the tab bar (or the sidebar) on every screen: a task, an
// event or an exam, chosen on the switch at the top. Each form is the few things the planner needs and nothing else;
// what is missing is said in words above the button (never an alert). Rendered once at the root (src/app.tsx) so it
// sits above every screen. What each form becomes: src/engine/add-item.ts.

import { useEffect, useMemo, useState } from "react";

import {
  blockFromEventForm,
  defaultEventForm,
  defaultExamForm,
  defaultTaskForm,
  eventFormError,
  examFormError,
  examFromForm,
  EXAM_STUDY_MINUTE_OPTIONS,
  minutesChoiceLabel,
  recurringFromEventForm,
  taskFormError,
  taskFromForm,
  TASK_MINUTE_OPTIONS,
  type AddKind,
} from "../engine/add-item";
import { legibleOn, parseHexColor } from "../engine/contrast";
import { alpha } from "../engine/design";
import { generateId, localDateKey } from "../engine/utils";
import { classShortName, weekdayName } from "../engine/week-layout";
import { useApp } from "../state/app-provider";
import type { AddSheetPreset } from "../state/modal-context";
import { DateInput, FieldGroup, FieldLabel, FieldRow, MONO_FONT, PrimaryButton, Segmented, TimeInput } from "../ui/primitives";
import { Sheet, SheetBody, SheetHead } from "../ui/sheet";
import { useColors } from "../ui/theme";

const KIND_OPTIONS: { value: AddKind; label: string; ariaLabel: string }[] = [
  { value: "task", label: "Task", ariaLabel: "Add a task" },
  { value: "event", label: "Event", ariaLabel: "Add an event" },
  { value: "exam", label: "Exam", ariaLabel: "Add an exam" },
];

/** The student's classes as short tags, plus "None". The class colour is an outline and the text, never a fill. */
export function ClassPicker({ value, onChange }: { value: string; onChange: (courseId: string) => void }) {
  const colors = useColors();
  const { state } = useApp();
  const options = [
    ...state.classes.map((cls) => ({ id: cls.id, label: classShortName(cls) || cls.name, name: cls.name, color: cls.color as string | undefined })),
    { id: "", label: "None", name: "No class", color: undefined },
  ];
  return (
    <div role="radiogroup" className="hidden-scrollbar" style={{ display: "flex", gap: 6, overflowX: "auto", paddingRight: 4 }}>
      {options.map((option) => {
        const selected = value === option.id;
        const base = option.color && parseHexColor(option.color) ? option.color : null;
        return (
          <button
            key={option.id || "none"}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={option.name}
            onClick={() => onChange(option.id)}
            style={{
              height: 44,
              minWidth: 56,
              padding: "0 12px",
              borderRadius: 12,
              flexShrink: 0,
              background: selected ? alpha(base ?? colors.primary, 0.18) : colors.panel,
              border: `${selected ? 1.5 : 1}px solid ${selected ? (base ?? colors.accent) : colors.borderStrong}`,
              color: base ? legibleOn(base, colors.panel) : selected ? colors.foreground : colors.muted,
              fontFamily: base ? MONO_FONT : undefined,
              fontSize: base ? 13 : 14,
              fontWeight: 600,
              letterSpacing: base ? 0.4 : undefined,
              whiteSpace: "nowrap",
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function AddSheet({ preset, onClose }: { preset: AddSheetPreset | null; onClose: () => void }) {
  const colors = useColors();
  const { state, dispatch } = useApp();
  const visible = preset !== null;
  const todayKey = localDateKey(new Date());

  const [kind, setKind] = useState<AddKind>("task");
  const [task, setTask] = useState(() => defaultTaskForm(todayKey));
  const [event, setEvent] = useState(() => defaultEventForm(todayKey));
  const [exam, setExam] = useState(() => defaultExamForm(todayKey));
  // The reason shows only after the student has tried to add: an empty form is not an error yet.
  const [tried, setTried] = useState(false);

  // Every opening starts clean, on the form it was opened for.
  useEffect(() => {
    if (!preset) return;
    const today = localDateKey(new Date());
    setKind(preset.kind);
    setTask(defaultTaskForm(today));
    setEvent({ ...defaultEventForm(today, preset.date), repeatsWeekly: preset.weekly ?? false });
    setExam(defaultExamForm(today));
    setTried(false);
  }, [preset]);

  const error = useMemo(
    () => (kind === "task" ? taskFormError(task, todayKey) : kind === "exam" ? examFormError(exam, todayKey) : eventFormError(event, todayKey)),
    [kind, task, exam, event, todayKey],
  );

  if (!visible) return null;

  function handleAdd() {
    if (error) {
      setTried(true);
      return;
    }
    const id = generateId();
    if (kind === "task") {
      dispatch({ type: "ADD_TASK", payload: taskFromForm(task, state.classes, id, new Date().toISOString()) });
      // Plan it now (not after the automatic re-plan's short delay); the screens show "Plan updated · Undo".
      dispatch({ type: "AUTO_REPLAN" });
    } else if (kind === "exam") {
      dispatch({ type: "ADD_TASK", payload: examFromForm(exam, state.classes, id, new Date().toISOString()) });
      dispatch({ type: "AUTO_REPLAN" });
    } else if (event.repeatsWeekly) {
      dispatch({ type: "ADD_RECURRING_EVENT", payload: recurringFromEventForm(event, id) });
      dispatch({ type: "AUTO_REPLAN" });
    } else {
      dispatch({ type: "ADD_BLOCK", payload: blockFromEventForm(event, id) });
    }
    onClose();
  }

  const weekday = weekdayName(event.date);
  const label = kind === "task" ? "Add task" : kind === "exam" ? "Add exam" : "Add event";

  return (
    <Sheet open onClose={onClose} ariaLabel="Add">
      <SheetBody>
        <SheetHead title="Add" onClose={onClose} />
        <Segmented options={KIND_OPTIONS} value={kind} onChange={(next) => { setKind(next); setTried(false); }} />

        {kind === "task" ? (
          <>
            <div>
              <FieldLabel>What is it?</FieldLabel>
              <input className="input" value={task.name} onChange={(e) => setTask((form) => ({ ...form, name: e.target.value }))} placeholder="Problem Set 7" aria-label="Task name" autoFocus />
            </div>
            <div>
              <FieldLabel>Class</FieldLabel>
              <ClassPicker value={task.courseId} onChange={(courseId) => setTask((form) => ({ ...form, courseId }))} />
            </div>
            <FieldGroup>
              <FieldRow first icon="cal" label="Due">
                <DateInput ariaLabel="Due date" value={task.dueDate} onChange={(dueDate) => setTask((form) => ({ ...form, dueDate }))} />
              </FieldRow>
              <FieldRow icon="clock" label="Time needed" stacked>
                <Segmented
                  scroll
                  options={TASK_MINUTE_OPTIONS.map((minutes) => ({ value: String(minutes), label: minutesChoiceLabel(minutes), ariaLabel: `${minutesChoiceLabel(minutes)} needed` }))}
                  value={String(task.minutes)}
                  onChange={(value) => setTask((form) => ({ ...form, minutes: Number(value) }))}
                />
              </FieldRow>
            </FieldGroup>
            <p className="caption" style={{ margin: 0 }}>Trajectory finds the time for it and tells you what moved.</p>
          </>
        ) : null}

        {kind === "event" ? (
          <>
            <div>
              <FieldLabel>What is it?</FieldLabel>
              <input className="input" value={event.name} onChange={(e) => setEvent((form) => ({ ...form, name: e.target.value }))} placeholder="Work shift" aria-label="Event name" autoFocus />
            </div>
            <FieldGroup>
              <FieldRow first icon="cal" label="Day">
                <DateInput ariaLabel="Day" value={event.date} onChange={(date) => setEvent((form) => ({ ...form, date }))} />
              </FieldRow>
              <FieldRow icon="clock" label="Time" stacked>
                <div style={{ display: "flex", gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <FieldLabel style={{ marginBottom: 4 }}>Starts</FieldLabel>
                    <TimeInput ariaLabel="Starts" value={event.startTime} onChange={(startTime) => setEvent((form) => ({ ...form, startTime }))} style={{ width: "100%" }} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <FieldLabel style={{ marginBottom: 4 }}>Ends</FieldLabel>
                    <TimeInput ariaLabel="Ends" value={event.endTime} onChange={(endTime) => setEvent((form) => ({ ...form, endTime }))} style={{ width: "100%" }} />
                  </div>
                </div>
              </FieldRow>
              <FieldRow icon="repeat" label="Repeats" stacked>
                <Segmented
                  options={[
                    { value: "once", label: "One time", ariaLabel: "One time only" },
                    { value: "weekly", label: `Every ${weekday}`, ariaLabel: `Every week on ${weekday}` },
                  ]}
                  value={event.repeatsWeekly ? "weekly" : "once"}
                  onChange={(value) => setEvent((form) => ({ ...form, repeatsWeekly: value === "weekly" }))}
                />
              </FieldRow>
            </FieldGroup>
            <p className="caption" style={{ margin: 0 }}>Study sessions are planned around it.</p>
          </>
        ) : null}

        {kind === "exam" ? (
          <>
            <div>
              <FieldLabel>What is it?</FieldLabel>
              <input className="input" value={exam.name} onChange={(e) => setExam((form) => ({ ...form, name: e.target.value }))} placeholder="Midterm" aria-label="Exam name" autoFocus />
            </div>
            <div>
              <FieldLabel>Class</FieldLabel>
              <ClassPicker value={exam.courseId} onChange={(courseId) => setExam((form) => ({ ...form, courseId }))} />
            </div>
            <FieldGroup>
              <FieldRow first icon="flag" label="Date">
                <DateInput ariaLabel="Exam date" value={exam.date} onChange={(date) => setExam((form) => ({ ...form, date }))} />
              </FieldRow>
              <FieldRow icon="clock" label="Starts at" detail={exam.time ? undefined : "Not set"}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <TimeInput ariaLabel="Start time" value={exam.time} onChange={(time) => setExam((form) => ({ ...form, time }))} unsetTone={!exam.time} />
                  {exam.time ? (
                    <button type="button" className="link" style={{ fontSize: 13 }} onClick={() => setExam((form) => ({ ...form, time: "" }))} aria-label="Clear the start time">
                      Clear
                    </button>
                  ) : null}
                </div>
              </FieldRow>
              <FieldRow icon="book" label="Study time before it" stacked>
                <Segmented
                  scroll
                  options={EXAM_STUDY_MINUTE_OPTIONS.map((minutes) => ({ value: String(minutes), label: minutesChoiceLabel(minutes), ariaLabel: `${minutesChoiceLabel(minutes)} of study` }))}
                  value={String(exam.studyMinutes)}
                  onChange={(value) => setExam((form) => ({ ...form, studyMinutes: Number(value) }))}
                />
              </FieldRow>
            </FieldGroup>
            <p className="caption" style={{ margin: 0 }}>Trajectory plans that study time in the days before the exam.</p>
          </>
        ) : null}

        {tried && error ? <p role="alert" style={{ margin: 0, fontSize: 14, lineHeight: "19px", fontWeight: 600, textAlign: "center", color: colors.gold }}>{error}</p> : null}
        <PrimaryButton size="lg" fullWidth label={label} onPress={handleAdd} ariaLabel={label} />
      </SheetBody>
    </Sheet>
  );
}

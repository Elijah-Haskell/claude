// Work and activities: what repeats every week besides classes (a shift, a club, practice), reached from Classes and
// Settings. One row each, with its colour as a bar, when it happens and how the planner treats it; a row opens the
// same sheet that adds one. What is missing is said in words over the button, and deleting asks first, inside the
// sheet. Classes stays lit in the tab bar while it is open (src/router.tsx litTabFor).

import { useState } from "react";

import { activityFormError, activityPlanLine, classScheduleLine } from "../engine/classes-view";
import type { DayOfWeek, RecurringEvent } from "../engine/types";
import { generateId } from "../engine/utils";
import { AddTile, DesktopPageHead, MetaLine, WeekDots } from "../components/desktop-panels";
import { alpha } from "../engine/design";
import { goBack } from "../router";
import { useApp } from "../state/app-provider";
import { Icon } from "../ui/icon";
import { useDesktop } from "../ui/layout";
import { AppSwitch, Card, DayToggles, FieldGroup, FieldLabel, FieldRow, HeaderIconButton, InlineConfirm, PrimaryButton, ScreenHeader, Swatches, TimeInput } from "../ui/primitives";
import { Sheet, SheetBody, SheetHead } from "../ui/sheet";
import { useColors } from "../ui/theme";

// Colours the student picks for their own commitments (they stay as chosen).
const COLORS = ["#06B6D4", "#8B5CF6", "#EC4899", "#F59E0B", "#22C55E", "#EF4444"];
const ORDER: DayOfWeek[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function ActivitiesScreen() {
  const colors = useColors();
  const { state, dispatch } = useApp();
  const events = state.recurringEvents;
  const desktop = useDesktop();

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [days, setDays] = useState<DayOfWeek[]>([]);
  const [color, setColor] = useState(COLORS[0]!);
  const [locked, setLocked] = useState(true);
  const [doNotSchedule, setDoNotSchedule] = useState(false);
  const [tried, setTried] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const editing = editingId ? events.find((event) => event.id === editingId) ?? null : null;

  function openSheet(event: RecurringEvent | null) {
    setEditingId(event?.id ?? null);
    setTitle(event?.title ?? "");
    // A new one has no times yet: the fields say so rather than show a time nobody picked.
    setStartTime(event?.startTime ?? "");
    setEndTime(event?.endTime ?? "");
    setDays(event ? [...event.days] : []);
    setColor(event?.color ?? COLORS[events.length % COLORS.length]!);
    setLocked(event?.locked ?? true);
    setDoNotSchedule(event?.doNotSchedule ?? false);
    setTried(false);
    setConfirmingDelete(false);
    setOpen(true);
  }

  const error = activityFormError({ title, days, startTime, endTime });
  const toggleDay = (day: DayOfWeek) => setDays((current) => (current.includes(day) ? current.filter((d) => d !== day) : ORDER.filter((d) => d === day || current.includes(d))));

  function save() {
    setTried(true);
    if (error) return;
    const event: RecurringEvent = {
      // Whatever else it carries (a description) stays as it is.
      ...(editing ?? {}),
      id: editing?.id ?? generateId(),
      title: title.trim(),
      startTime,
      endTime,
      days,
      color,
      locked,
      doNotSchedule,
    };
    dispatch(editing ? { type: "UPDATE_RECURRING_EVENT", payload: event } : { type: "ADD_RECURRING_EVENT", payload: event });
    // The plan is built around it: rebuild now (undoable: "Plan updated · Undo").
    dispatch({ type: "AUTO_REPLAN" });
    setOpen(false);
  }

  function remove() {
    if (!editing) return;
    dispatch({ type: "DELETE_RECURRING_EVENT", payload: editing.id });
    dispatch({ type: "AUTO_REPLAN" });
    setOpen(false);
  }

  const close = () => setOpen(false);
  const subtitle = events.length > 0 ? `${events.length} each week. Study time is planned around ${events.length === 1 ? "it" : "them"}.` : "A shift, a club, practice: study time is planned around them.";

  const sheet = (
      <Sheet open={open} onClose={close} ariaLabel={editing ? "Edit work or an activity" : "Work or an activity"}>
        <SheetBody gap={16}>
          <SheetHead title={editing ? "Edit it" : "Work or an activity"} onClose={close} />

          <div>
            <FieldLabel>Name</FieldLabel>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Work shift, club meeting" maxLength={120} aria-label="Name" autoFocus={!editing} />
          </div>

          <div>
            <FieldLabel>Days</FieldLabel>
            <DayToggles days={days} onToggle={toggleDay} />
          </div>

          <FieldGroup>
            <FieldRow first icon="clock" label="Starts">
              <TimeInput ariaLabel="Start time" value={startTime} onChange={setStartTime} unsetTone={!startTime} />
            </FieldRow>
            <FieldRow icon="clock" label="Ends">
              <TimeInput ariaLabel="End time" value={endTime} onChange={setEndTime} unsetTone={!endTime} />
            </FieldRow>
            <FieldRow icon="lock" label="Keep it at this time" detail="The planner never moves it">
              <AppSwitch value={locked} onValueChange={setLocked} ariaLabel="Keep it at this time: the planner never moves it" />
            </FieldRow>
            <FieldRow icon="shield" label="Only keep the time clear" detail="No study is planned in it, and it is not drawn as a block">
              <AppSwitch value={doNotSchedule} onValueChange={setDoNotSchedule} ariaLabel="Only keep the time clear: no study is planned in it, and it is not drawn as a block" />
            </FieldRow>
          </FieldGroup>

          <div>
            <FieldLabel>Colour</FieldLabel>
            <Swatches options={COLORS} value={color} onChange={setColor} />
          </div>

          {tried && error ? <p role="alert" style={{ margin: 0, fontSize: 14, lineHeight: "19px", fontWeight: 600, textAlign: "center", color: colors.gold }}>{error}</p> : null}
          <PrimaryButton size="lg" fullWidth label={editing ? "Save" : "Add"} onPress={save} ariaLabel={editing ? "Save it" : "Add it"} />

          {editing ? (
            confirmingDelete ? (
              <InlineConfirm question="Delete this? It leaves every week of your plan." confirmLabel="Delete" onConfirm={remove} onCancel={() => setConfirmingDelete(false)} />
            ) : (
              <button type="button" className="link" onClick={() => setConfirmingDelete(true)} aria-label="Delete it" style={{ minHeight: 44, alignSelf: "center", color: colors.error, fontSize: 15, fontWeight: 600, marginTop: -6 }}>Delete</button>
            )
          ) : null}
        </SheetBody>
      </Sheet>
  );

  if (desktop) {
    return (
      <div className="screen medium" style={{ gap: 22 }}>
        <DesktopPageHead back={{ onPress: () => goBack("classes"), ariaLabel: "Back" }} eyebrow="Every week" title="Work and activities" subtitle={subtitle} />

        {events.length === 0 ? (
          <Card tone="surface" padded={false} radiusSize={18} style={{ padding: "26px 28px", display: "flex", alignItems: "center", gap: 22, flexWrap: "wrap" }}>
            <span style={{ width: 56, height: 56, borderRadius: 16, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", background: alpha(colors.peri, 0.14) }}>
              <Icon name="work" size={26} color={colors.peri} />
            </span>
            <div style={{ flex: "1 1 260px", minWidth: 0 }}>
              <h2 style={{ margin: 0, fontSize: 19, lineHeight: "24px", fontWeight: 700, letterSpacing: -0.3, color: colors.foreground }}>Nothing that repeats yet</h2>
              <p style={{ margin: "6px 0 0", fontSize: 14, lineHeight: "20px", color: colors.muted }}>Add a shift, a club or practice and Trajectory plans your study time around it.</p>
            </div>
            <PrimaryButton size="lg" label="Add work or an activity" left={<Icon name="plus" size={18} color="#FFFFFF" />} onPress={() => openSheet(null)} />
          </Card>
        ) : (
          <div className="card-grid" style={{ ["--card-min" as string]: "280px", gap: 16 }}>
            {events.map((event) => {
              const when = classScheduleLine(event);
              const note = activityPlanLine(event);
              return (
                <button key={event.id} type="button" className="card lift" onClick={() => openSheet(event)} aria-label={`${event.title}. ${when}${note ? `. ${note}` : ""}. Open it`} style={{ position: "relative", overflow: "hidden", display: "flex", flexDirection: "column", alignItems: "stretch", gap: 16, padding: "20px 18px 18px", width: "100%", textAlign: "left", color: "inherit", background: `linear-gradient(180deg, ${alpha(event.color, 0.1)} 0%, ${alpha(event.color, 0)} 58%), ${colors.surface}` }}>
                  <span aria-hidden="true" style={{ position: "absolute", left: 0, right: 0, top: 0, height: 3, background: event.color }} />
                  <span style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                    <span className="clamp2" style={{ flex: 1, minWidth: 0, fontSize: 16.5, lineHeight: "22px", fontWeight: 600, letterSpacing: -0.2, color: colors.foreground }}>{event.title}</span>
                    <Icon name="chevronRight" size={18} color={colors.muted} style={{ marginTop: 2 }} />
                  </span>
                  <WeekDots days={event.days} color={event.color} />
                  <span style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: "auto" }}>
                    <MetaLine icon="clock" color={colors.foreground}>{when}</MetaLine>
                    {note ? <MetaLine icon="shield">{note}</MetaLine> : null}
                  </span>
                </button>
              );
            })}
            <AddTile label="Add another" ariaLabel="Add work or an activity" onPress={() => openSheet(null)} minHeight={150} />
          </div>
        )}

        {sheet}
      </div>
    );
  }

  return (
    <div className="screen">
      <div style={{ paddingTop: 4 }}>
        <HeaderIconButton onPress={() => goBack("classes")} ariaLabel="Back">
          <Icon name="chevronLeft" size={20} color={colors.foreground} />
        </HeaderIconButton>
      </div>
      <ScreenHeader
        eyebrow="Every week"
        title="Work and activities"
        subtitle={subtitle}
      />

      {events.length === 0 ? (
        <Card tone="surface" radiusSize={18} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <h2 style={{ margin: 0, fontSize: 19, lineHeight: "24px", fontWeight: 700, letterSpacing: -0.3, color: colors.foreground }}>Nothing that repeats yet</h2>
          <p style={{ margin: "0 0 6px", fontSize: 14, lineHeight: "20px", color: colors.muted }}>Add a shift, a club or practice and Trajectory plans your study time around it.</p>
          <PrimaryButton size="lg" fullWidth label="Add work or an activity" left={<Icon name="plus" size={18} color="#FFFFFF" />} onPress={() => openSheet(null)} />
        </Card>
      ) : (
        <>
          <FieldGroup>
            {events.map((event) => {
              const when = classScheduleLine(event);
              const note = activityPlanLine(event);
              return (
                <button key={event.id} type="button" className="row pressable" onClick={() => openSheet(event)} aria-label={`${event.title}. ${when}${note ? `. ${note}` : ""}. Open it`} style={{ minHeight: 64, padding: "12px 14px" }}>
                  <span style={{ width: 4, alignSelf: "stretch", borderRadius: 2, background: event.color, flexShrink: 0 }} />
                  <span className="row-text">
                    <span className="clamp2" style={{ display: "block", fontSize: 16, lineHeight: "21px", fontWeight: 600, color: colors.foreground }}>{event.title}</span>
                    <span className="clamp2" style={{ display: "block", fontSize: 13, lineHeight: "18px", color: colors.muted }}>{when}</span>
                    {note ? <span className="clamp2" style={{ display: "block", fontSize: 13, lineHeight: "18px", color: colors.muted }}>{note}</span> : null}
                  </span>
                  <Icon name="chevronRight" size={18} color={colors.muted} />
                </button>
              );
            })}
          </FieldGroup>
          <button type="button" className="pressable" aria-label="Add work or an activity" onClick={() => openSheet(null)} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, minHeight: 52, borderRadius: 16, border: `1px solid ${colors.borderStrong}`, background: colors.panel, color: colors.foreground, fontSize: 16, fontWeight: 600 }}>
            <Icon name="plus" size={18} color={colors.foreground} strokeWidth={2} />
            Add another
          </button>
        </>
      )}

      {sheet}
    </div>
  );
}

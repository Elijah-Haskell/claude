// Classes — the fifth screen. The term over the title, the gear to Settings, then the classes themselves: each a row
// with its short name on its colour, when it meets, and how many deadlines it has in the plan. A row opens the
// class's sheet. Under them: "Add a class" (from its syllabus, or by hand), and the two things that belong to the
// classes as a whole: the term's dates and breaks, and the syllabi imported.

import { useEffect, useState } from "react";

import { classFormError, classPlanLine, classScheduleLine, defaultTerm, latestImportFor, suggestBreak, termEyebrow, termRowLine } from "../engine/classes-view";
import { legibleOn, parseHexColor } from "../engine/contrast";
import { alpha } from "../engine/design";
import { validateSemester } from "../engine/semester";
import { COURSE_COLORS, type ClassBlock, type DayOfWeek, type Semester, type SemesterBreak } from "../engine/types";
import { generateId, localDateKey } from "../engine/utils";
import { classShortName, courseShortName, normalizeShortName, SHORT_NAME_MAX } from "../engine/week-layout";
import { DesktopPageHead, MetaLine, useMinWidth, WeekDots } from "../components/desktop-panels";
import { useNavigate, useRoute } from "../router";
import { useApp } from "../state/app-provider";
import { Icon } from "../ui/icon";
import { useDesktop } from "../ui/layout";
import { AppSwitch, Card, DateInput, DayToggles, FieldGroup, FieldLabel, FieldPickRow, FieldRow, HeaderIconButton, InlineConfirm, MONO_FONT, PrimaryButton, ScreenHeader, Swatches, TimeInput } from "../ui/primitives";
import { Sheet, SheetBody, SheetHead } from "../ui/sheet";
import { useColors } from "../ui/theme";

/** The class's short name on its colour: a tinted square with the colour as a bar on its left edge. */
export function ClassTag({ cls, size = 48 }: { cls: Pick<ClassBlock, "name" | "shortName" | "color">; size?: number }) {
  const colors = useColors();
  const base = parseHexColor(cls.color) ? cls.color : colors.peri;
  const tag = classShortName(cls) || "?";
  return (
    <span style={{ width: size, height: size, borderRadius: 12, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "0 2px", background: alpha(base, 0.14), border: `1px solid ${alpha(base, 0.4)}`, borderLeft: `3px solid ${base}` }}>
      <span className="clamp2" style={{ fontFamily: MONO_FONT, fontSize: 12, fontWeight: 600, textAlign: "center", lineHeight: "15px", color: legibleOn(base, colors.surface, 5.5) }}>{tag}</span>
    </span>
  );
}

/** A class as a card (the computer's Classes): its colour, name, when and where it meets, and its deadlines. */
function ClassCard({ cls, planLine, onOpen }: { cls: ClassBlock; planLine: string; onOpen: () => void }) {
  const colors = useColors();
  const base = parseHexColor(cls.color) ? cls.color : colors.peri;
  const schedule = classScheduleLine(cls);
  return (
    <button
      type="button"
      className="card lift"
      onClick={onOpen}
      aria-label={`${cls.name}. ${schedule}. ${planLine}. Open the class`}
      style={{ position: "relative", overflow: "hidden", display: "flex", flexDirection: "column", alignItems: "stretch", gap: 16, padding: "20px 18px 18px", width: "100%", textAlign: "left", color: "inherit", background: `linear-gradient(180deg, ${alpha(base, 0.11)} 0%, ${alpha(base, 0)} 58%), ${colors.surface}` }}
    >
      <span aria-hidden="true" style={{ position: "absolute", left: 0, right: 0, top: 0, height: 3, background: base }} />
      <span style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <ClassTag cls={cls} size={46} />
        <span className="clamp2" style={{ flex: 1, minWidth: 0, fontSize: 16.5, lineHeight: "22px", fontWeight: 600, letterSpacing: -0.2, color: colors.foreground }}>{cls.name}</span>
        <Icon name="chevronRight" size={18} color={colors.muted} />
      </span>
      <WeekDots days={cls.isAsynchronous ? [] : cls.days} color={base} />
      <span style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: "auto" }}>
        <MetaLine icon="clock" color={colors.foreground}>{schedule}</MetaLine>
        {cls.location ? <MetaLine icon="pin">{cls.location}</MetaLine> : null}
        <MetaLine icon="list">{planLine}</MetaLine>
      </span>
    </button>
  );
}

// ── A class's sheet ───────────────────────────────────────────

/**
 * Add a class by hand, or open one from the list to change it. Its name and short name, the days and times it meets
 * (or "No set class time"), where, its colour, and for a class that exists its syllabus and the way to delete it.
 * What is missing is said in words over Save, and deleting asks first inside the sheet. Saving re-plans around the
 * new times.
 */
export function ClassSheet({ open, classId, onClose, onAddSyllabus }: { open: boolean; classId: string | null; onClose: () => void; onAddSyllabus: (cls: ClassBlock) => void }) {
  const colors = useColors();
  const { state, dispatch } = useApp();
  const existing = classId ? state.classes.find((cls) => cls.id === classId) ?? null : null;

  const [name, setName] = useState("");
  const [shortName, setShortName] = useState("");
  const [location, setLocation] = useState("");
  const [isAsynchronous, setIsAsynchronous] = useState(false);
  const [days, setDays] = useState<DayOfWeek[]>([]);
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [color, setColor] = useState<string>(COURSE_COLORS[0]!);
  const [tried, setTried] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Every opening starts from the class as it is saved (or an empty form for a new one).
  useEffect(() => {
    if (!open) return;
    const cls = classId ? state.classes.find((candidate) => candidate.id === classId) : undefined;
    setName(cls?.name ?? "");
    setShortName(cls?.shortName ?? "");
    setLocation(cls?.location ?? "");
    setIsAsynchronous(Boolean(cls?.isAsynchronous));
    setDays(cls ? [...cls.days] : []);
    setStartTime(cls?.startTime ?? "");
    setEndTime(cls?.endTime ?? "");
    setColor(cls?.color ?? COURSE_COLORS[state.classes.length % COURSE_COLORS.length]!);
    setTried(false);
    setConfirmingDelete(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, classId]);

  if (!open) return null;

  const error = classFormError({ name, isAsynchronous, days, startTime, endTime });
  const ORDER: DayOfWeek[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const toggleDay = (day: DayOfWeek) => setDays((current) => (current.includes(day) ? current.filter((d) => d !== day) : ORDER.filter((d) => d === day || current.includes(d))));

  function save() {
    setTried(true);
    if (error) return;
    const cls: ClassBlock = {
      // Whatever else the class carries stays as it is.
      ...(existing ?? {}),
      id: existing?.id ?? generateId(),
      name: name.trim(),
      days: isAsynchronous ? [] : days,
      startTime: isAsynchronous ? "" : startTime,
      endTime: isAsynchronous ? "" : endTime,
      color,
    };
    // Empty = the tag is made from the name (src/engine/week-layout.ts classShortName).
    const tag = normalizeShortName(shortName);
    if (tag) cls.shortName = tag;
    else delete cls.shortName;
    if (location.trim()) cls.location = location.trim();
    else delete cls.location;
    if (isAsynchronous) cls.isAsynchronous = true;
    else delete cls.isAsynchronous;

    dispatch(existing ? { type: "UPDATE_CLASS", payload: cls } : { type: "ADD_CLASS", payload: cls });
    // The plan is built around class times: rebuild it now (undoable: "Plan updated · Undo").
    dispatch({ type: "AUTO_REPLAN" });
    onClose();
  }

  function remove() {
    if (!existing) return;
    dispatch({ type: "REMOVE_CLASS", payload: existing.id });
    dispatch({ type: "AUTO_REPLAN" });
    onClose();
  }

  const latest = existing ? latestImportFor(existing.id, state.syllabusImports) : undefined;
  const syllabusLine = latest
    ? `Added ${new Date(latest.importedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })} · ${latest.itemCount} item${latest.itemCount === 1 ? "" : "s"}`
    : "None yet. Its deadlines come from it";

  return (
    <Sheet open onClose={onClose} ariaLabel={existing ? "Edit class" : "Add a class"}>
      <SheetBody gap={16}>
        <SheetHead title={existing ? "Edit class" : "Add a class"} onClose={onClose} />

        <div>
          <FieldLabel>Class</FieldLabel>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Calculus II" maxLength={200} aria-label="Class name" autoFocus={!existing} />
        </div>
        <div>
          <FieldLabel>Short name</FieldLabel>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <input
              className="input"
              style={{ width: 124, fontFamily: MONO_FONT, textTransform: "uppercase" }}
              value={shortName}
              onChange={(e) => setShortName(e.target.value.toUpperCase().slice(0, SHORT_NAME_MAX))}
              onBlur={() => setShortName((current) => normalizeShortName(current))}
              placeholder={courseShortName(name) || "CALC"}
              maxLength={SHORT_NAME_MAX}
              autoCapitalize="characters"
              autoCorrect="off"
              aria-label="Short name"
              title="The tag shown on small blocks and next to a session's name. Leave it empty to use the one made from the class's name"
            />
            <span style={{ flex: 1, fontSize: 13, lineHeight: "18px", color: colors.muted }}>The tag on small blocks and next to a session&apos;s name.</span>
          </div>
        </div>

        {isAsynchronous ? null : (
          <div>
            <FieldLabel>Class days</FieldLabel>
            <DayToggles days={days} onToggle={toggleDay} />
          </div>
        )}

        <FieldGroup>
          {isAsynchronous ? null : (
            <>
              <FieldRow first icon="clock" label="Starts">
                <TimeInput ariaLabel="Class start time" value={startTime} onChange={setStartTime} unsetTone={!startTime} />
              </FieldRow>
              <FieldRow icon="clock" label="Ends">
                <TimeInput ariaLabel="Class end time" value={endTime} onChange={setEndTime} unsetTone={!endTime} />
              </FieldRow>
            </>
          )}
          <FieldRow first={isAsynchronous} icon="phone" label="No set class time" detail="Online or self-paced">
            <AppSwitch value={isAsynchronous} onValueChange={setIsAsynchronous} ariaLabel="No set class time" />
          </FieldRow>
          <FieldRow icon="pin" label="Where">
            <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Optional" maxLength={120} aria-label="Room or link, optional" style={{ minWidth: 130, width: "100%", height: 44, fontSize: 15, textAlign: "right", background: "transparent", border: "none", outline: "none", color: colors.foreground }} />
          </FieldRow>
        </FieldGroup>

        <div>
          <FieldLabel>Colour</FieldLabel>
          <Swatches options={COURSE_COLORS} value={color} onChange={setColor} />
        </div>

        {existing ? (
          <FieldGroup>
            <FieldPickRow first icon="file" label="Syllabus" detail={syllabusLine} value={latest ? "Add again" : "Add"} onPress={() => onAddSyllabus(existing)} ariaLabel={latest ? `Syllabus. ${syllabusLine}. Add it again` : "Syllabus: none yet. Add this class's syllabus"} />
          </FieldGroup>
        ) : null}

        {tried && error ? <p role="alert" style={{ margin: 0, fontSize: 14, lineHeight: "19px", fontWeight: 600, textAlign: "center", color: colors.gold }}>{error}</p> : null}
        <PrimaryButton size="lg" fullWidth label={existing ? "Save" : "Add class"} onPress={save} ariaLabel={existing ? "Save the class" : "Add the class"} />

        {existing ? (
          confirmingDelete ? (
            <InlineConfirm question="Delete this class? Its meetings leave your plan. Its tasks stay in Tasks." confirmLabel="Delete" onConfirm={remove} onCancel={() => setConfirmingDelete(false)} />
          ) : (
            <button type="button" className="link" onClick={() => setConfirmingDelete(true)} aria-label="Delete this class" style={{ minHeight: 44, alignSelf: "center", color: colors.error, fontSize: 15, fontWeight: 600, marginTop: -6 }}>Delete class</button>
          )
        ) : null}
      </SheetBody>
    </Sheet>
  );
}

// ── The term's sheet ──────────────────────────────────────────

/**
 * The term the plan is built around: its name, first and last day, and its breaks. Class meetings are only planned
 * between the two dates and never during a break. Saving re-plans the semester (undoable: "Plan updated · Undo").
 */
export function TermSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const colors = useColors();
  const { state, dispatch } = useApp();
  const saved = state.semester ?? null;
  const [draft, setDraft] = useState<Semester>(() => saved ?? defaultTerm(localDateKey(new Date()), state.user?.currentSemester ?? ""));
  const [error, setError] = useState<string | null>(null);

  // Every opening starts from the term as it is saved.
  useEffect(() => {
    if (!open) return;
    setDraft(state.semester ?? defaultTerm(localDateKey(new Date()), state.user?.currentSemester ?? ""));
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const edit = (patch: Partial<Semester>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setError(null);
  };
  const editBreak = (index: number, patch: Partial<SemesterBreak>) => edit({ breaks: draft.breaks.map((item, i) => (i === index ? { ...item, ...patch } : item)) });

  function save() {
    const checked = validateSemester(draft);
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    dispatch({ type: "SET_SEMESTER", payload: checked.semester });
    // Rebuild the whole plan around the new dates right away.
    dispatch({ type: "AUTO_REPLAN" });
    onClose();
  }

  return (
    <Sheet open onClose={onClose} ariaLabel="Term dates and breaks">
      <SheetBody gap={16}>
        <SheetHead title="Term dates and breaks" onClose={onClose} />
        <p className="sheet-sub" style={{ marginTop: -8 }}>Your classes go on the calendar only between these dates, and never during a break.</p>

        <div>
          <FieldLabel>Name</FieldLabel>
          <input className="input" value={draft.name} onChange={(e) => edit({ name: e.target.value })} placeholder="Fall 2026" maxLength={80} aria-label="Term name" />
        </div>

        <FieldGroup>
          <FieldRow first icon="cal" label="First day">
            <DateInput ariaLabel="Term start date" value={draft.startDate} onChange={(startDate) => edit({ startDate })} />
          </FieldRow>
          <FieldRow icon="cal" label="Last day">
            <DateInput ariaLabel="Term end date" value={draft.endDate} min={draft.startDate} onChange={(endDate) => edit({ endDate })} />
          </FieldRow>
        </FieldGroup>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <FieldLabel style={{ marginBottom: -3 }}>Breaks</FieldLabel>
          {draft.breaks.length === 0 ? <p className="caption" style={{ margin: 0, fontSize: 14 }}>None. Add spring break, reading week, or any stretch without classes.</p> : null}
          {draft.breaks.map((item, index) => (
            <FieldGroup key={index}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 6px 0 14px", minHeight: 56 }}>
                <input value={item.name} onChange={(e) => editBreak(index, { name: e.target.value })} placeholder="Break" maxLength={60} aria-label={`Break ${index + 1}, name`} style={{ flex: 1, minWidth: 0, height: 44, fontSize: 16, fontWeight: 600, background: "transparent", border: "none", outline: "none", color: colors.foreground }} />
                <button type="button" aria-label={`Remove ${item.name || "this break"}`} onClick={() => edit({ breaks: draft.breaks.filter((_, i) => i !== index) })} style={{ width: 44, height: 44, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                  <Icon name="trash" size={18} color={colors.error} />
                </button>
              </div>
              <FieldRow icon="cal" label="From">
                <DateInput ariaLabel={`${item.name || "Break"}, first day`} value={item.startDate} min={draft.startDate} onChange={(startDate) => editBreak(index, { startDate })} />
              </FieldRow>
              <FieldRow icon="cal" label="Through">
                <DateInput ariaLabel={`${item.name || "Break"}, last day`} value={item.endDate} min={item.startDate} onChange={(endDate) => editBreak(index, { endDate })} />
              </FieldRow>
            </FieldGroup>
          ))}
          <button type="button" className="pressable" aria-label="Add a break" onClick={() => edit({ breaks: [...draft.breaks, suggestBreak(draft)] })} style={{ minHeight: 48, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, borderRadius: 12, border: `1px solid ${colors.borderStrong}`, background: alpha(colors.peri, 0.08), color: colors.foreground, fontSize: 15, fontWeight: 600 }}>
            <Icon name="plus" size={18} color={colors.foreground} strokeWidth={2} />
            Add a break
          </button>
        </div>

        {error ? <p role="alert" style={{ margin: 0, fontSize: 14, lineHeight: "19px", fontWeight: 600, textAlign: "center", color: colors.gold }}>{error}</p> : null}
        <PrimaryButton size="lg" fullWidth label={saved ? "Save" : "Set the term"} onPress={save} ariaLabel={saved ? "Save the term and re-plan around it" : "Set the term and plan around it"} />
      </SheetBody>
    </Sheet>
  );
}

// ── The screen ────────────────────────────────────────────────

export function ClassesScreen() {
  const colors = useColors();
  const navigate = useNavigate();
  const route = useRoute();
  const { state } = useApp();
  const desktop = useDesktop();
  // Room for the term, the imports and the activities side by side, each on one or two lines.
  const threeUp = useMinWidth(1320);

  // The class sheet: `id` null adds a new class. "?add=class" (Today's "Add a class by hand") opens it empty;
  // "?edit=<id>" (the import history) opens a class.
  const [sheet, setSheet] = useState<{ id: string | null } | null>(() => (route.query.add === "class" ? { id: null } : route.query.edit && state.classes.some((cls) => cls.id === route.query.edit) ? { id: route.query.edit } : null));
  const [choosingHow, setChoosingHow] = useState(false);
  const [termOpen, setTermOpen] = useState(false);
  useEffect(() => {
    if (route.query.add === "class" || route.query.edit) navigate("classes", { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const imports = state.syllabusImports ?? [];
  function addSyllabus(cls?: ClassBlock) {
    setSheet(null);
    setChoosingHow(false);
    navigate(cls ? `syllabus?classId=${encodeURIComponent(cls.id)}` : "syllabus");
  }
  const hasClasses = state.classes.length > 0;

  // The sheets, the same on a phone and a computer.
  const sheets = (
    <>
      <ClassSheet open={sheet !== null} classId={sheet?.id ?? null} onClose={() => setSheet(null)} onAddSyllabus={(cls) => addSyllabus(cls)} />
      <TermSheet open={termOpen} onClose={() => setTermOpen(false)} />

      {/* "Add a class": from its syllabus (the class, its times and its deadlines at once), or by hand */}
      <Sheet open={choosingHow} onClose={() => setChoosingHow(false)} ariaLabel="Add a class">
        <SheetBody>
          <SheetHead title="Add a class" onClose={() => setChoosingHow(false)} />
          <FieldGroup>
            <FieldPickRow first icon="file" label="From its syllabus" detail="The class, when it meets and its deadlines, read from it" onPress={() => addSyllabus()} ariaLabel="From its syllabus: the class, when it meets and its deadlines are read from it" />
            <FieldPickRow
              icon="edit"
              label="By hand"
              detail="Its name, days and times"
              onPress={() => {
                setChoosingHow(false);
                setSheet({ id: null });
              }}
            />
          </FieldGroup>
        </SheetBody>
      </Sheet>
    </>
  );
  const termRow = <FieldPickRow first icon="cal" label="Term dates and breaks" detail={termRowLine(state.semester)} onPress={() => setTermOpen(true)} />;
  const importsRow = imports.length > 0 ? <FieldPickRow icon="file" label="Imported syllabi" detail={`${imports.length} imported. See what each added, or undo one`} onPress={() => navigate("imports")} /> : null;
  const activitiesRow = <FieldPickRow icon="work" label="Work and activities" detail={state.recurringEvents.length > 0 ? `${state.recurringEvents.length} every week. Study time is planned around them` : "A shift, a club, practice: study time is planned around them"} onPress={() => navigate("activities")} />;

  if (desktop) {
    const classWide = [termRow, importsRow, activitiesRow].filter((row) => row !== null);
    const settingsButton = (
      <HeaderIconButton onPress={() => navigate("settings")} ariaLabel="Settings">
        <Icon name="settings" size={20} color={colors.foreground} />
      </HeaderIconButton>
    );
    return (
      <div className="screen full" style={{ gap: 22 }}>
        <DesktopPageHead
          eyebrow={termEyebrow(state.semester)}
          title="Classes"
          right={
            <>
              {hasClasses ? <PrimaryButton label="Add a class" left={<Icon name="plus" size={18} color="#FFFFFF" strokeWidth={2.2} />} onPress={() => setChoosingHow(true)} ariaLabel="Add a class: from its syllabus or by hand" style={{ minHeight: 40 }} /> : null}
              {settingsButton}
            </>
          }
        />

        {hasClasses ? (
          <div className="card-grid" style={{ ["--card-min" as string]: "264px", gap: 16 }}>
            {state.classes.map((cls) => (
              <ClassCard key={cls.id} cls={cls} planLine={classPlanLine({ classId: cls.id, className: cls.name, tasks: state.tasks, imports })} onOpen={() => setSheet({ id: cls.id })} />
            ))}
          </div>
        ) : (
          <Card tone="surface" padded={false} radiusSize={18} style={{ padding: "28px 30px", display: "flex", alignItems: "center", gap: 22, flexWrap: "wrap" }}>
            <span style={{ width: 60, height: 60, borderRadius: 18, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", background: alpha(colors.primary, 0.18) }}>
              <Icon name="file" size={30} color={colors.peri} />
            </span>
            <div style={{ flex: "1 1 260px", minWidth: 0 }}>
              <h2 style={{ margin: 0, fontSize: 21, lineHeight: "27px", fontWeight: 600, letterSpacing: -0.3, color: colors.foreground }}>Start with your syllabus</h2>
              <p style={{ margin: "6px 0 0", fontSize: 15, lineHeight: "21px", color: colors.muted }}>Trajectory reads the class, when it meets and its deadlines from it.</p>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              <button type="button" className="link" onClick={() => setSheet({ id: null })} aria-label="Add a class by hand" style={{ minHeight: 44, padding: "0 14px", fontSize: 15, fontWeight: 600, color: colors.peri }}>Add a class by hand</button>
              <PrimaryButton label="Add a syllabus" size="lg" onPress={() => addSyllabus()} left={<Icon name="file" size={18} color="#FFFFFF" />} />
            </div>
          </Card>
        )}

        {/* What belongs to the classes as a whole: the term, the syllabi imported, what else fills the week. Side by
            side when there is room for them, a list otherwise. */}
        {threeUp ? (
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${classWide.length}, minmax(0, 1fr))`, gap: 16, marginTop: 10 }}>
            {classWide.map((row, index) => (
              <div key={index} className="card lift" style={{ overflow: "hidden", display: "flex", alignItems: "stretch" }}>
                {row}
              </div>
            ))}
          </div>
        ) : (
          <FieldGroup style={{ marginTop: 10 }}>
            {termRow}
            {importsRow}
            {activitiesRow}
          </FieldGroup>
        )}

        {sheets}
      </div>
    );
  }

  return (
    <div className="screen">
      <ScreenHeader
        eyebrow={termEyebrow(state.semester)}
        title="Classes"
        right={
          <HeaderIconButton onPress={() => navigate("settings")} ariaLabel="Settings">
            <Icon name="settings" size={20} color={colors.foreground} />
          </HeaderIconButton>
        }
      />

      {hasClasses ? (
        <FieldGroup>
          {state.classes.map((cls) => (
            <button key={cls.id} type="button" className="row pressable" onClick={() => setSheet({ id: cls.id })} aria-label={`${cls.name}. ${classScheduleLine(cls)}. ${classPlanLine({ classId: cls.id, className: cls.name, tasks: state.tasks, imports })}. Open the class`} style={{ minHeight: 78, padding: "10px 14px" }}>
              <ClassTag cls={cls} />
              <span className="row-text">
                <span className="clamp2" style={{ display: "block", fontSize: 16, lineHeight: "21px", fontWeight: 600, color: colors.foreground }}>{cls.name}</span>
                <span className="clamp2" style={{ display: "block", fontSize: 14, lineHeight: "19px", marginTop: 1, color: colors.muted }}>{classScheduleLine(cls)}</span>
                <span className="clamp2" style={{ display: "block", fontSize: 13, lineHeight: "18px", color: colors.muted }}>{classPlanLine({ classId: cls.id, className: cls.name, tasks: state.tasks, imports })}</span>
              </span>
              <Icon name="chevronRight" size={18} color={colors.muted} />
            </button>
          ))}
        </FieldGroup>
      ) : (
        <Card tone="surface" padded={false} radiusSize={18} style={{ padding: "24px 20px", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
          <span style={{ width: 56, height: 56, borderRadius: 16, display: "inline-flex", alignItems: "center", justifyContent: "center", background: alpha(colors.primary, 0.18) }}>
            <Icon name="file" size={28} color={colors.peri} />
          </span>
          <h2 style={{ margin: "14px 0 0", fontSize: 20, lineHeight: "26px", fontWeight: 600, color: colors.foreground }}>Start with your syllabus</h2>
          <p style={{ margin: "6px 0 0", fontSize: 15, lineHeight: "21px", color: colors.muted }}>Trajectory reads the class, when it meets and its deadlines from it.</p>
          <PrimaryButton label="Add a syllabus" fullWidth size="lg" onPress={() => addSyllabus()} style={{ marginTop: 18 }} />
          <button type="button" className="link" onClick={() => setSheet({ id: null })} aria-label="Add a class by hand" style={{ minHeight: 44, marginTop: 4, padding: "0 12px", fontSize: 15, fontWeight: 600, color: colors.peri }}>Add a class by hand</button>
        </Card>
      )}

      {hasClasses ? <PrimaryButton tone="ghost" size="lg" fullWidth label="Add a class" left={<Icon name="plus" size={20} color={colors.foreground} strokeWidth={2} />} onPress={() => setChoosingHow(true)} ariaLabel="Add a class: from its syllabus or by hand" /> : null}

      <FieldGroup>
        {termRow}
        {importsRow}
        {activitiesRow}
      </FieldGroup>

      {sheets}
    </div>
  );
}

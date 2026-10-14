// One exam (or quiz), opened from Study: its class and date with the countdown, how much of its study time is done,
// and the study plan as a list of the sessions the planner placed for it, each with its tick box. A session opens
// its own sheet; "Add time" and the pencil open the exam's task sheet, where its date and the time it needs are
// changed. At the bottom, the exam's prep (topics, flashcards and a practice quiz). Study stays lit in the tab bar
// while it is open, and Back returns to Study.

import { useEffect, useMemo, useState } from "react";

import { alpha } from "../engine/design";
import { buildFreeStudyView, prettyExamDate } from "../engine/study-free-view";
import { buildStudyHub } from "../engine/study-hub";
import { examBadge, examLinks, examProgress, examSessions, resolveStudyExam, sessionWhen, type ExamSession } from "../engine/study-view";
import { dateKeyOf, formatTime, localDateKey } from "../engine/utils";
import { classOfTask, classShortName, sessionDisplayTitle } from "../engine/week-layout";
import { goBack, useNavigate } from "../router";
import { useApp } from "../state/app-provider";
import { useGlobalModal } from "../state/modal-context";
import { Icon } from "../ui/icon";
import { useDesktop, useWideLayout } from "../ui/layout";
import { Card, CheckBox, CourseChip, DateBadge, FieldGroup, HeaderIconButton, MONO_FONT, Note, SectionLabel } from "../ui/primitives";
import { useColors } from "../ui/theme";
import { ThinBar } from "./study";

export function ExamScreen({ examKey }: { examKey: string }) {
  const colors = useColors();
  const navigate = useNavigate();
  const { state, dispatch } = useApp();
  const { openBlock, openTask } = useGlobalModal();
  const desktop = useDesktop();
  const wide = useWideLayout();
  const key = examKey || undefined;

  const today = localDateKey(new Date());
  const hub = useMemo(() => buildStudyHub(state, today), [state, today]);
  const view = useMemo(() => buildFreeStudyView(hub, state.scheduleBlocks ?? [], today), [hub, state.scheduleBlocks, today]);
  // The list knows an exam as its task until an exam prep is made for it, and as that prep from then on: the screen
  // follows the exam across that change (and back, when the prep is deleted) instead of calling it gone.
  const [known, setKnown] = useState<{ key: string | undefined; taskId: string } | null>(null);
  const exam = resolveStudyExam(view, key, state.examPreps ?? [], known && known.key === key ? known.taskId : null);
  const resolvedKey = exam?.key ?? key;
  const links = useMemo(() => examLinks(resolvedKey, state.examPreps ?? []), [resolvedKey, state.examPreps]);
  const linkedTaskId = links?.taskId ?? null;
  useEffect(() => {
    if (linkedTaskId && !(known && known.key === key && known.taskId === linkedTaskId)) setKnown({ key, taskId: linkedTaskId });
  }, [key, linkedTaskId, known]);
  const sessions = useMemo(() => (links ? examSessions(state.scheduleBlocks ?? [], links.sessionTaskIds) : []), [links, state.scheduleBlocks]);

  const backButton = (
    <HeaderIconButton onPress={() => goBack("study")} ariaLabel="Back to Study">
      <Icon name="chevronLeft" size={20} color={colors.foreground} strokeWidth={2} />
    </HeaderIconButton>
  );

  // The exam was finished, deleted or its link is stale: say so, with the way back.
  if (!exam || !links) {
    return (
      <div className="screen">
        <div style={{ paddingTop: 4 }}>{backButton}</div>
        <div style={{ padding: "40px 8px", display: "flex", flexDirection: "column", gap: 8 }}>
          <h1 style={{ margin: 0, fontSize: 22, lineHeight: "28px", fontWeight: 700, letterSpacing: -0.3, color: colors.foreground }}>This exam is no longer in your plan</h1>
          <p style={{ margin: 0, fontSize: 15, lineHeight: "21px", color: colors.muted }}>It was marked done or removed. Study lists everything that is still ahead.</p>
        </div>
      </div>
    );
  }

  const task = links.taskId ? state.tasks.find((candidate) => candidate.id === links.taskId) : undefined;
  const prep = links.prepId ? (state.examPreps ?? []).find((candidate) => candidate.id === links.prepId) : undefined;
  const cls = task ? classOfTask(task, state.classes) : prep ? state.classes.find((candidate) => candidate.id === prep.classId) : undefined;
  const tag = classShortName(cls, exam.courseName);
  const badge = examBadge(exam.timing);
  const progress = examProgress(sessions);
  const nextSession = sessions.find((session) => session.status !== "done" && session.status !== "skipped" && session.date >= today);

  const toggle = (session: ExamSession) => {
    dispatch({ type: session.status === "done" ? "UNCOMPLETE_BLOCK" : "COMPLETE_BLOCK", payload: session.id });
  };

  function openPrep() {
    if (prep) navigate(`exam-prep/${encodeURIComponent(prep.id)}`);
    // taskId links the new prep to this exam: class, date, time and syllabus topics are filled in from it.
    else if (task) navigate(`exam-prep?new=1&classId=${encodeURIComponent(task.courseId)}&date=${dateKeyOf(task.dueDate)}&taskId=${encodeURIComponent(task.id)}`);
  }

  const link = { fontSize: 14, lineHeight: "19px", fontWeight: 600, color: colors.peri } as const;

  const topBar = (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingTop: 4 }}>
      {backButton}
      {task ? (
        <HeaderIconButton onPress={() => openTask(task.id)} ariaLabel={`Edit ${exam.name}: its date and the time it needs`}>
          <Icon name="edit" size={19} color={colors.foreground} />
        </HeaderIconButton>
      ) : null}
    </div>
  );

  const head = (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "0 4px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {tag ? <CourseChip label={tag} color={cls?.color} /> : null}
        <span style={{ fontSize: 14, lineHeight: "19px", color: colors.muted }}>{exam.kind === "quiz" ? "Quiz" : "Exam"}</span>
      </div>
      <h1 style={{ margin: 0, fontSize: desktop ? 34 : 30, lineHeight: desktop ? "40px" : "35px", fontWeight: 800, letterSpacing: desktop ? -1 : -0.75, color: colors.foreground }}>{exam.name}</h1>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 15, lineHeight: "21px", color: colors.muted }}>{prettyExamDate(exam.date)}{exam.time ? ` at ${formatTime(exam.time)}` : ""}</span>
        <DateBadge label={badge.label} tone={badge.tone} />
      </div>
    </div>
  );

  const progressCard = (
    <Card tone="surface" padded={false} radiusSize={18} style={{ padding: desktop ? "18px 20px" : "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <span className="clamp2" style={{ flex: 1, fontSize: 16, lineHeight: "21px", fontWeight: 600, color: progress.total > 0 ? colors.foreground : colors.muted }}>{progress.line}</span>
        {progress.doneLine ? <span style={{ fontFamily: MONO_FONT, fontSize: 12.5, fontWeight: 500, color: colors.muted, flexShrink: 0 }}>{progress.doneLine}</span> : null}
      </div>
      {progress.total > 0 ? <ThinBar fraction={progress.fraction} style={{ marginTop: 10 }} /> : null}
    </Card>
  );

  const plan = (
    <section style={{ display: "flex", flexDirection: "column", gap: desktop ? 10 : 8 }}>
      <SectionLabel
        title="Study plan"
        right={
          task ? (
            <button type="button" className="link" onClick={() => openTask(task.id)} aria-label="Add study time for this exam" style={{ ...link, display: "inline-flex", alignItems: "center", gap: 5, minHeight: 28 }}>
              <Icon name="plus" size={16} color={colors.peri} strokeWidth={2.2} />
              Add time
            </button>
          ) : undefined
        }
      />
      {sessions.length === 0 ? (
        <Note tone="plain" icon="clock">
          {exam.timing.status === "past" ? "Nothing more is planned: this one is over." : "No study time is planned for this yet. The plan adds it as the date gets closer, or add time yourself."}
        </Note>
      ) : (
        <FieldGroup style={desktop ? { borderRadius: 18 } : undefined}>
          {sessions.map((session) => {
            const done = session.status === "done";
            const skipped = session.status === "skipped";
            const name = sessionDisplayTitle(session.title, exam.courseName || undefined);
            const note = skipped ? " · Skipped" : session.status === "missed" ? " · Missed" : "";
            return (
              <div key={session.id} className="row" style={{ paddingLeft: desktop ? 8 : 2, paddingRight: 0, gap: 0, minHeight: 64 }}>
                <CheckBox checked={done} onPress={skipped ? undefined : () => toggle(session)} ariaLabel={done ? `${name}, done. Tick to undo` : `Mark ${name} done`} />
                <button type="button" className="pressable" onClick={() => openBlock(session.id)} aria-label={`${name}, ${sessionWhen(session)}${note}. Open the session`} style={{ flex: 1, minWidth: 0, minHeight: 64, display: "flex", alignItems: "center", gap: 10, padding: "9px 14px 9px 8px", textAlign: "left" }}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span className="clamp2" style={{ display: "block", fontSize: 16, lineHeight: "21px", fontWeight: 500, color: done || skipped ? colors.muted : colors.foreground, textDecoration: done || skipped ? "line-through" : "none" }}>{name}</span>
                    <span className="truncate" style={{ display: "block", fontSize: 13, lineHeight: "18px", marginTop: 1, color: colors.muted }}>{sessionWhen(session)}{note}</span>
                  </span>
                  <Icon name="chevronRight" size={18} color={colors.muted} />
                </button>
              </div>
            );
          })}
        </FieldGroup>
      )}
      {sessions.length > 0 ? (
        <button type="button" className="link" onClick={() => navigate(`week?week=${nextSession?.date ?? exam.date}`)} aria-label="See these sessions in Week" style={{ ...link, minHeight: 44, alignSelf: "flex-start", padding: "0 4px", margin: "-6px 0" }}>See them in Week</button>
      ) : null}
    </section>
  );

  const prepRow = prep || task ? (
    <FieldGroup>
      <button type="button" className="row pressable" onClick={openPrep} aria-label={`${prep ? "Open the exam prep" : "Build an exam prep"}. Topics, flashcards and a practice quiz`} style={{ minHeight: 62 }}>
        <span className="well" style={{ background: alpha(colors.violet, 0.16) }}>
          <Icon name="layers" size={18} color={colors.violet} />
        </span>
        <span className="row-text">
          <span className="row-label" style={{ display: "block" }}>{prep ? "Open the exam prep" : "Build an exam prep"}</span>
          <span className="row-detail" style={{ display: "block" }}>Topics, flashcards and a practice quiz</span>
        </span>
        <Icon name="chevronRight" size={18} color={colors.muted} />
      </button>
    </FieldGroup>
  ) : null;

  /** The exam prep as a card of the rail on a wide screen. */
  const prepCard = prep || task ? (
    <button type="button" className="card lift" onClick={openPrep} aria-label={`${prep ? "Open the exam prep" : "Build an exam prep"}. Topics, flashcards and a practice quiz`} style={{ display: "flex", flexDirection: "column", alignItems: "stretch", gap: 12, padding: 20, textAlign: "left", background: `linear-gradient(140deg, ${alpha(colors.violet, 0.16)}, ${colors.surface} 70%)`, borderColor: alpha(colors.violet, 0.4) }}>
      <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ width: 44, height: 44, borderRadius: 13, display: "inline-flex", alignItems: "center", justifyContent: "center", background: alpha(colors.violet, 0.2) }}>
          <Icon name="layers" size={21} color={colors.violet} />
        </span>
        <Icon name="arrow" size={18} color={colors.muted} />
      </span>
      <span>
        <span style={{ display: "block", fontSize: 17, lineHeight: "22px", fontWeight: 600, color: colors.foreground }}>{prep ? "Open the exam prep" : "Build an exam prep"}</span>
        <span style={{ display: "block", marginTop: 4, fontSize: 13.5, lineHeight: "19px", color: colors.muted }}>Topics, flashcards and a practice quiz</span>
      </span>
    </button>
  ) : null;

  if (desktop && wide) {
    return (
      <div className="screen medium" style={{ gap: 20 }}>
        {topBar}
        {head}
        <div className="split" style={{ marginTop: 4 }}>
          <div className="split-main">{plan}</div>
          <aside className="split-rail">
            {progressCard}
            {prepCard}
          </aside>
        </div>
      </div>
    );
  }

  return (
    <div className={desktop ? "screen medium" : "screen"} style={{ gap: 16 }}>
      {topBar}
      {head}
      {progressCard}
      {plan}
      {prepRow}
    </div>
  );
}

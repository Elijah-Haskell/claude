// Study — the fourth screen. Top to bottom: how much is ahead and "Study"; the next exam as one card (its countdown,
// its class and date, the study time planned for it and how much is done, "Open study plan"); the exams after it as
// plain rows; quizzes and what is over folded away; and the study tools, labelled "Pro" once, at the bottom.
// The exams are the same for every student (src/engine/study-view.ts): those from a syllabus, those added with the
// add button, and exam preps. An exam opens its own screen (src/screens/exam.tsx). The four tools are Pro: with Pro a
// row opens the tool, without it the row opens Trajectory Pro. Gating waits until it is known whether there is Pro.

import { useEffect, useMemo, useState } from "react";

import { alpha } from "../engine/design";
import { examPrepsToRelink } from "../engine/exam-prep-link";
import { buildFreeStudyView, prettyExamDate, type FreeExam } from "../engine/study-free-view";
import { buildPracticeList, buildStudyHub } from "../engine/study-hub";
import { comingUpShown, examBadge, examLinks, examProgress, examSessions, STUDY_TOOLS, studyEyebrow, type StudyToolKey } from "../engine/study-view";
import { formatTime, localDateKey } from "../engine/utils";
import { classOfTask, classShortName } from "../engine/week-layout";
import { decideSyllabusUpload } from "../lib/subscription-plans";
import { useNavigate } from "../router";
import { useApp } from "../state/app-provider";
import { useGlobalModal } from "../state/modal-context";
import { useProGate } from "../state/use-pro-gate";
import { useProStatus } from "../state/subscription-context";
import { Icon } from "../ui/icon";
import { Card, CourseChip, DateBadge, FieldGroup, MONO_FONT, PrimaryButton, ScreenHeader, SectionLabel } from "../ui/primitives";
import { useColors } from "../ui/theme";

export function FoldLink({ open, onPress, what }: { open: boolean; onPress: () => void; what: string }) {
  const colors = useColors();
  return (
    <button type="button" className="link" onClick={onPress} aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} ${what}`} style={{ fontSize: 14, lineHeight: "19px", fontWeight: 600, color: colors.peri, minHeight: 28 }}>
      {open ? "Hide" : "Show"}
    </button>
  );
}

/** A thin progress bar: how much of something is done. Decoration for a count that is also said in words. */
export function ThinBar({ fraction, style }: { fraction: number; style?: React.CSSProperties }) {
  const colors = useColors();
  return (
    <div aria-hidden style={{ height: 6, borderRadius: 3, overflow: "hidden", background: alpha(colors.peri, 0.14), ...style }}>
      <div style={{ height: 6, borderRadius: 3, background: colors.accent, width: `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%` }} />
    </div>
  );
}

export function StudyScreen() {
  const colors = useColors();
  const navigate = useNavigate();
  const { openAdd } = useGlobalModal();
  const requirePro = useProGate();
  const { isPro, isLoading: isProLoading } = useProStatus();
  const { state, dispatch } = useApp();
  const [showAll, setShowAll] = useState(false);
  const [showQuizzes, setShowQuizzes] = useState(false);
  const [showPast, setShowPast] = useState(false);

  const today = localDateKey(new Date());
  const hub = useMemo(() => buildStudyHub(state, today), [state, today]);
  const view = useMemo(() => buildFreeStudyView(hub, state.scheduleBlocks ?? [], today), [hub, state.scheduleBlocks, today]);

  // Save each exam prep's link to its exam task and that exam's current date, so screens that read the saved date
  // (Today, the month) agree with this one after the exam moves (or an undo moves it back).
  useEffect(() => {
    for (const exam of examPrepsToRelink(state.examPreps, state.tasks)) dispatch({ type: "UPDATE_EXAM_PREP", payload: exam });
  }, [state.examPreps, state.tasks, dispatch]);

  /** The class an exam belongs to (for its tag), through its task or its prep. */
  const classOf = (exam: FreeExam) => {
    const links = examLinks(exam.key, state.examPreps ?? []);
    const task = links?.taskId ? state.tasks.find((candidate) => candidate.id === links.taskId) : undefined;
    if (task) return classOfTask(task, state.classes);
    const prep = links?.prepId ? (state.examPreps ?? []).find((candidate) => candidate.id === links.prepId) : undefined;
    return prep ? state.classes.find((cls) => cls.id === prep.classId) : undefined;
  };
  const tagOf = (exam: FreeExam) => {
    const cls = classOf(exam);
    return { label: classShortName(cls, exam.courseName), color: cls?.color };
  };
  const openExam = (exam: FreeExam) => navigate(`exam/${encodeURIComponent(exam.key)}`);

  function addSyllabus() {
    const decision = decideSyllabusUpload({ isPro, isLoading: isProLoading, syllabusCount: state.syllabusImports?.length ?? 0 });
    if (decision === "wait") return;
    navigate(decision === "allow" ? "syllabus" : "paywall");
  }

  // The tools: each has its own screen (what you have made with it, and the way to make more).
  const practiceCount = useMemo(() => buildPracticeList(state).length, [state]);
  function openTool(key: StudyToolKey) {
    if (!requirePro()) return;
    if (key === "prep") navigate("exam-prep");
    else if (key === "guide") navigate("study-guides");
    else if (key === "practice") navigate("practice");
    else navigate("test-review");
  }
  /** What a Pro student already has of a tool, said at the right of its row. */
  const toolCount = (key: StudyToolKey): string => {
    const n = key === "prep" ? hub.stats.exams : key === "guide" ? hub.guides.length : key === "practice" ? practiceCount : 0;
    return n > 0 ? String(n) : "";
  };
  // "Pro" is said once, on the section's label, and only to a student known not to have it.
  const showProTag = !isProLoading && !isPro;

  const hero = view.exams[0] ?? view.quizzes[0];
  const comingUp = view.exams.filter((exam) => exam !== hero);
  const folded = comingUpShown(comingUp.length);
  const shownComingUp = showAll ? comingUp : comingUp.slice(0, folded);
  const quizzes = view.quizzes.filter((exam) => exam !== hero);

  /** Counted from the sessions the exam's own screen lists, so the two always agree. */
  const progressOf = (exam: FreeExam) => examProgress(examSessions(state.scheduleBlocks ?? [], examLinks(exam.key, state.examPreps ?? [])?.sessionTaskIds ?? []));
  const count = (n: number) => <span style={{ fontFamily: MONO_FONT, fontSize: 12.5, lineHeight: "17px", fontWeight: 600, color: colors.muted }}>{n}</span>;

  function row(exam: FreeExam, muted = false) {
    const badge = examBadge(exam.timing);
    const tag = tagOf(exam);
    return (
      <button key={exam.key} type="button" className="row pressable" onClick={() => openExam(exam)} aria-label={`${exam.courseName ? `${exam.courseName}, ` : ""}${exam.name}, ${prettyExamDate(exam.date)}, ${badge.label}. ${progressOf(exam).line}`} style={{ minHeight: 62 }}>
        <span className="well" style={{ background: alpha(muted ? colors.muted : colors.gold, 0.14) }}>
          <Icon name="flag" size={18} color={muted ? colors.muted : colors.gold} />
        </span>
        <span className="row-text">
          <span className="row-label clamp2" style={{ display: "block" }}>{exam.name}</span>
          <span style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 3 }}>
            {tag.label ? <CourseChip label={tag.label} color={tag.color} /> : null}
            <span className="truncate" style={{ fontSize: 14, lineHeight: "19px", color: colors.muted }}>{prettyExamDate(exam.date)}</span>
          </span>
        </span>
        <DateBadge label={badge.label} tone={badge.tone} />
      </button>
    );
  }

  function heroCard(exam: FreeExam) {
    const badge = examBadge(exam.timing);
    const tag = tagOf(exam);
    const progress = progressOf(exam);
    return (
      <Card tone="surface" padded={false} radiusSize={18} style={{ padding: "14px 16px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <span className="eyebrow" style={{ color: colors.peri }}>{exam.kind === "quiz" ? "Next quiz" : "Next exam"}</span>
          <DateBadge label={badge.label} tone={badge.tone} />
        </div>
        <h2 style={{ margin: "8px 0 0", fontSize: 22, lineHeight: "28px", fontWeight: 700, letterSpacing: -0.3, color: colors.foreground }}>{exam.name}</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 4 }}>
          {tag.label ? <CourseChip label={tag.label} color={tag.color} /> : null}
          <span className="truncate" style={{ fontSize: 14, lineHeight: "19px", color: colors.muted }}>
            {prettyExamDate(exam.date)}{exam.time ? ` at ${formatTime(exam.time)}` : ""}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 12 }}>
          <span className="clamp2" style={{ flex: 1, fontSize: 14, lineHeight: "19px", color: progress.total > 0 ? colors.foreground : colors.muted }}>{progress.line}</span>
          {progress.doneLine ? <span style={{ fontFamily: MONO_FONT, fontSize: 12.5, fontWeight: 500, color: colors.muted, flexShrink: 0 }}>{progress.doneLine}</span> : null}
        </div>
        {progress.total > 0 ? <ThinBar fraction={progress.fraction} style={{ marginTop: 8 }} /> : null}
        <PrimaryButton label="Open study plan" fullWidth size="lg" onPress={() => openExam(exam)} ariaLabel={`Open the study plan for ${exam.name}`} style={{ marginTop: 12 }} />
      </Card>
    );
  }

  /** Nothing ahead: one card with the next step. */
  function emptyCard() {
    const noSyllabus = hub.emptyState === "no_syllabus";
    return (
      <Card tone="surface" padded={false} radiusSize={18} style={{ padding: "24px 20px", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
        <span style={{ width: 56, height: 56, borderRadius: 16, display: "inline-flex", alignItems: "center", justifyContent: "center", background: alpha(colors.primary, 0.18) }}>
          <Icon name={noSyllabus ? "file" : "flag"} size={28} color={colors.peri} />
        </span>
        <h2 style={{ margin: "14px 0 0", fontSize: 20, lineHeight: "26px", fontWeight: 600, color: colors.foreground }}>{noSyllabus ? "Start with your syllabus" : "No exams ahead"}</h2>
        <p style={{ margin: "6px 0 0", fontSize: 15, lineHeight: "21px", color: colors.muted }}>
          {noSyllabus ? "Trajectory finds your exams in it and plans study time before each one." : "Exams from a syllabus appear here by themselves. Add one for anything else, and study time is planned before it."}
        </p>
        <PrimaryButton label={noSyllabus ? "Add a syllabus" : "Add an exam"} fullWidth size="lg" onPress={noSyllabus ? addSyllabus : () => openAdd({ kind: "exam" })} style={{ marginTop: 18 }} />
        {noSyllabus ? <button type="button" className="link" onClick={() => openAdd({ kind: "exam" })} aria-label="Add an exam by hand" style={{ minHeight: 44, marginTop: 4, fontSize: 15, fontWeight: 600, color: colors.peri }}>Add an exam by hand</button> : null}
      </Card>
    );
  }

  return (
    <div className="screen" style={{ gap: 14 }}>
      <ScreenHeader eyebrow={studyEyebrow(view)} title="Study" />

      {hero ? heroCard(hero) : emptyCard()}

      {comingUp.length > 0 ? (
        <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <SectionLabel title="Coming up" right={count(comingUp.length)} />
          <FieldGroup>{shownComingUp.map((exam) => row(exam))}</FieldGroup>
          {comingUp.length > folded ? (
            <button type="button" className="link" onClick={() => setShowAll((value) => !value)} aria-label={showAll ? "Show fewer exams" : `Show all ${comingUp.length} exams`} style={{ minHeight: 44, alignSelf: "center", fontSize: 14, fontWeight: 600, color: colors.peri, margin: "-6px 0" }}>
              {showAll ? "Show fewer" : `Show all ${comingUp.length}`}
            </button>
          ) : null}
        </section>
      ) : null}

      {quizzes.length > 0 ? (
        <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <SectionLabel title={`Quizzes · ${quizzes.length}`} right={<FoldLink open={showQuizzes} onPress={() => setShowQuizzes((value) => !value)} what="the quizzes" />} />
          {showQuizzes ? <FieldGroup>{quizzes.map((exam) => row(exam))}</FieldGroup> : null}
        </section>
      ) : null}

      <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <SectionLabel
          title="Study tools"
          right={
            showProTag ? (
              <span aria-label="Part of Trajectory Pro" style={{ display: "inline-flex", alignItems: "center", gap: 5, height: 22, padding: "0 7px", borderRadius: 6, border: `1px solid ${alpha(colors.violet, 0.5)}`, background: alpha(colors.violet, 0.16) }}>
                <Icon name="crown" size={13} color={colors.violet} />
                <span style={{ fontFamily: MONO_FONT, fontSize: 12, lineHeight: "16px", fontWeight: 600, letterSpacing: 1, textTransform: "uppercase", color: colors.violet }}>Pro</span>
              </span>
            ) : undefined
          }
        />
        <FieldGroup>
          {STUDY_TOOLS.map((tool) => {
            const have = showProTag ? "" : toolCount(tool.key);
            return (
              <button key={tool.key} type="button" className="row pressable" onClick={() => openTool(tool.key)} aria-label={`${tool.title}. ${tool.sub}${showProTag ? ". Part of Trajectory Pro" : have ? `. ${have} saved` : ""}`} style={{ minHeight: 62 }}>
                <span className="well" style={{ background: alpha(colors.violet, 0.16) }}>
                  <Icon name={tool.icon} size={18} color={colors.violet} />
                </span>
                <span className="row-text">
                  <span className="row-label" style={{ display: "block" }}>{tool.title}</span>
                  <span className="row-detail" style={{ display: "block" }}>{tool.sub}</span>
                </span>
                {have ? count(Number(have)) : null}
                <Icon name="chevronRight" size={18} color={colors.muted} />
              </button>
            );
          })}
        </FieldGroup>
        {showProTag && hub.guides.length > 0 ? (
          <p style={{ margin: 0, padding: "0 2px", fontSize: 13, lineHeight: "18px", color: colors.muted }}>
            Your {hub.guides.length === 1 ? "study guide is still saved and opens" : `${hub.guides.length} study guides are still saved and open`} again with Pro.
          </p>
        ) : null}
      </section>

      {view.past.length > 0 ? (
        <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <SectionLabel title={`Over · ${view.past.length}`} color={colors.muted} right={<FoldLink open={showPast} onPress={() => setShowPast((value) => !value)} what="the exams that are over" />} />
          {showPast ? <FieldGroup>{view.past.map((exam) => row(exam, true))}</FieldGroup> : null}
        </section>
      ) : null}
    </div>
  );
}

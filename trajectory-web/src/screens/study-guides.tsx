// Study guide, one of the study tools (opened from the Study tab): the study guides the student has made, one row each,
// and "New study guide", which opens the sheet that builds one from a syllabus already added or from pasted text
// (src/components/study-guide-new-sheet.tsx). A row opens the guide (StudyGuideScreen below): its class and title, what
// it was built from, the topics by how much they matter (a row opens in place to its description and key terms), the
// study tips, and at the bottom its practice exam: take it, or make one. Deleting the guide is behind the "more" button
// and asks first (src/components/study-guide-more-sheet.tsx).
// Pro only, as the study tools are everywhere: opened without Pro it leads to Trajectory Pro. What the rows, the sheet
// and the guide say is src/engine/study-tools-view.ts; the mobile app's app/study-guides.tsx and app/study-guide.tsx.

import { useMemo, useState } from "react";

import { alpha } from "../engine/design";
import { studyGuideExcerpt } from "../engine/study-guides";
import { guideTextForExam } from "../engine/study-source";
import { savedTruncationNotice } from "../engine/study-text";
import { guideClass, guideMetaLine, guidePracticeAction, guideRows, importanceOptions, importanceTag, PRACTICE_EXAM_QUESTIONS, practiceFocusTopics, STUDY_GUIDES_EMPTY, STUDY_GUIDES_HEAD, topicsFor, type ImportanceFilter } from "../engine/study-tools-view";
import type { SyllabusStudyGuide } from "../engine/types";
import { generateId } from "../engine/utils";
import { classShortName } from "../engine/week-layout";
import { generatePracticeExam } from "../lib/study-api";
import { describeStudyError, type StudyErrorInfo } from "../lib/study-errors";
import { decideSyllabusUpload } from "../lib/subscription-plans";
import { goBack, useNavigate } from "../router";
import { useApp } from "../state/app-provider";
import { AiContentLabel } from "../components/ai-content-label";
import { useRedirectToPaywallIfNotPro } from "../state/use-pro-gate";
import { useProStatus } from "../state/subscription-context";
import { StudyGuideMoreSheet } from "../components/study-guide-more-sheet";
import { StudyGuideNewSheet } from "../components/study-guide-new-sheet";
import { Chips, FlowFooter, FoldRow, FoldText, LeadText, MonoCount, SmallLabel, Tag, ToolError, ToolHead, ToolIconButton, ToolTop } from "../components/study-parts";
import { Icon } from "../ui/icon";
import { useDesktop, useWideLayout } from "../ui/layout";
import { Card, CourseChip, FieldGroup, MONO_FONT, Note, PrimaryButton, SectionLabel, Segmented } from "../ui/primitives";
import { useColors } from "../ui/theme";

// ── The list ──────────────────────────────────────────────────

export function StudyGuidesScreen() {
  const colors = useColors();
  const navigate = useNavigate();
  const { state } = useApp();
  const { isPro, isLoading: isProLoading } = useProStatus();
  const desktop = useDesktop();
  const [sheetOpen, setSheetOpen] = useState(false);

  // Building a guide uses the AI: Pro only (waits until it is known whether there is Pro before redirecting).
  useRedirectToPaywallIfNotPro();

  const rows = useMemo(() => guideRows(state.studyGuides, state.practiceExams), [state.studyGuides, state.practiceExams]);

  const openGuide = (guideId: string) => navigate(`study-guide/${encodeURIComponent(guideId)}`);
  const afterSheet = (action: () => void) => {
    setSheetOpen(false);
    action();
  };

  /** The one syllabus import, by the same rule as everywhere: a free student over the limit sees Trajectory Pro. */
  function openImport() {
    const decision = decideSyllabusUpload({ isPro, isLoading: isProLoading, syllabusCount: state.syllabusImports?.length ?? 0 });
    if (decision === "wait") return;
    afterSheet(() => navigate(decision === "allow" ? "syllabus" : "paywall"));
  }

  const sheet = (
    <StudyGuideNewSheet
      open={sheetOpen}
      onClose={() => setSheetOpen(false)}
      onBuilt={(guideId) => afterSheet(() => openGuide(guideId))}
      onOpenGuide={(guideId) => afterSheet(() => openGuide(guideId))}
      onUpload={openImport}
    />
  );

  // A computer: the guides as cards side by side, "New study guide" beside the title.
  if (desktop) {
    return (
      <div className="screen full" style={{ gap: 22 }}>
        <ToolTop onBack={() => goBack("study")} backLabel="Back" />
        <ToolHead eyebrow={STUDY_GUIDES_HEAD.eyebrow} title={STUDY_GUIDES_HEAD.title} sub={STUDY_GUIDES_HEAD.sub} right={<PrimaryButton size="md" label="New study guide" left={<Icon name="plus" size={18} color="#FFFFFF" strokeWidth={2.2} />} onPress={() => setSheetOpen(true)} />} />
        {rows.length > 0 ? (
          <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <SectionLabel title="Your study guides" right={<MonoCount>{rows.length}</MonoCount>} />
            <div className="card-grid" style={{ ["--card-min" as string]: "280px", gap: 16 }}>
              {rows.map((row) => (
                <button key={row.id} type="button" className="card lift" onClick={() => openGuide(row.id)} aria-label={`Study guide: ${row.title}. ${row.line}`} style={{ display: "flex", flexDirection: "column", alignItems: "stretch", gap: 14, padding: 18, minHeight: 150, textAlign: "left" }}>
                  <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ width: 42, height: 42, borderRadius: 12, display: "inline-flex", alignItems: "center", justifyContent: "center", background: alpha(colors.violet, 0.16) }}>
                      <Icon name="file" size={20} color={colors.violet} />
                    </span>
                    <Icon name="arrow" size={18} color={colors.muted} />
                  </span>
                  <span>
                    <span className="clamp2" style={{ display: "block", fontSize: 17, lineHeight: "22px", fontWeight: 600, color: colors.foreground }}>{row.title}</span>
                    <span className="clamp2" style={{ display: "block", marginTop: 4, fontSize: 13.5, lineHeight: "19px", color: colors.muted }}>{row.line}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        ) : (
          <Card tone="surface" padded={false} radiusSize={20} style={{ padding: 28, display: "flex", alignItems: "flex-start", gap: 20 }}>
            <span style={{ width: 56, height: 56, borderRadius: 16, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", background: alpha(colors.violet, 0.16) }}>
              <Icon name="file" size={26} color={colors.violet} />
            </span>
            <div style={{ flex: 1, minWidth: 0, maxWidth: 560 }}>
              <h2 style={{ margin: 0, fontSize: 21, lineHeight: "27px", fontWeight: 700, letterSpacing: -0.3, color: colors.foreground }}>{STUDY_GUIDES_EMPTY.title}</h2>
              <p style={{ margin: "6px 0 0", fontSize: 15, lineHeight: "22px", color: colors.muted }}>{STUDY_GUIDES_EMPTY.body}</p>
            </div>
          </Card>
        )}
        {sheet}
      </div>
    );
  }

  return (
    <div className="screen" style={{ gap: 16, maxWidth: 640 }}>
      <ToolTop onBack={() => goBack("study")} backLabel="Back" />
      <ToolHead eyebrow={STUDY_GUIDES_HEAD.eyebrow} title={STUDY_GUIDES_HEAD.title} sub={STUDY_GUIDES_HEAD.sub} />

      {rows.length > 0 ? (
        <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <SectionLabel title="Your study guides" right={<MonoCount>{rows.length}</MonoCount>} />
          <FieldGroup>
            {rows.map((row) => (
              <button key={row.id} type="button" className="row pressable" onClick={() => openGuide(row.id)} aria-label={`Study guide: ${row.title}. ${row.line}`} style={{ minHeight: 64, padding: "10px 14px" }}>
                <span className="well" style={{ width: 36, height: 36, borderRadius: 11, background: alpha(colors.violet, 0.16) }}>
                  <Icon name="file" size={18} color={colors.violet} />
                </span>
                <span className="row-text">
                  <span className="clamp2" style={{ display: "block", fontSize: 16, lineHeight: "21px", fontWeight: 600, color: colors.foreground }}>{row.title}</span>
                  <span className="row-detail clamp2" style={{ display: "block" }}>{row.line}</span>
                </span>
                <Icon name="chevronRight" size={18} color={colors.muted} />
              </button>
            ))}
          </FieldGroup>
        </section>
      ) : (
        <Card tone="surface" radiusSize={18} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <h2 style={{ margin: 0, fontSize: 19, lineHeight: "24px", fontWeight: 700, letterSpacing: -0.3, color: colors.foreground }}>{STUDY_GUIDES_EMPTY.title}</h2>
          <p style={{ margin: 0, fontSize: 14, lineHeight: "20px", color: colors.muted }}>{STUDY_GUIDES_EMPTY.body}</p>
        </Card>
      )}

      <FlowFooter>
        <PrimaryButton size="lg" fullWidth label="New study guide" left={<Icon name="plus" size={20} color="#FFFFFF" strokeWidth={2} />} onPress={() => setSheetOpen(true)} />
      </FlowFooter>

      {sheet}
    </div>
  );
}

// ── One study guide ───────────────────────────────────────────

export function StudyGuideScreen({ guideId }: { guideId: string }) {
  const colors = useColors();
  const navigate = useNavigate();
  const { state, dispatch } = useApp();
  const desktop = useDesktop();
  const wide = useWideLayout();
  const [openTopics, setOpenTopics] = useState<number[]>([]);
  const [filter, setFilter] = useState<ImportanceFilter>("all");
  const [examError, setExamError] = useState<StudyErrorInfo | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [making, setMaking] = useState(false);
  // The guide as it was when it was deleted: the screen keeps showing it while it goes.
  const [leaving, setLeaving] = useState<SyllabusStudyGuide | null>(null);

  // Making a practice exam uses the AI: Pro only (waits until it is known whether there is Pro before redirecting).
  // Reading a saved guide or taking a saved practice exam is local.
  useRedirectToPaywallIfNotPro();

  const guide = (state.studyGuides || []).find((candidate) => candidate.id === guideId) ?? leaving ?? undefined;
  const existingExam = (state.practiceExams || []).find((exam) => exam.studyGuideId === guideId);

  if (!guide) {
    return (
      <div className="screen" style={{ maxWidth: 640 }}>
        <ToolTop onBack={() => goBack("study-guides")} />
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, padding: "80px 24px" }}>
          <h1 style={{ margin: 0, fontSize: 20, lineHeight: "26px", fontWeight: 600, textAlign: "center", color: colors.foreground }}>Study guide not found.</h1>
          <PrimaryButton label="Go back" tone="ghost" onPress={() => goBack("study-guides")} />
        </div>
      </div>
    );
  }

  const topics = Array.isArray(guide.topics) ? guide.topics : [];
  const tips = Array.isArray(guide.studyTips) ? guide.studyTips : [];
  const shown = topicsFor(topics, filter);
  const cls = guideClass(guide, state.classes, state.syllabusImports);
  const meta = guideMetaLine(guide);
  const truncation = savedTruncationNotice(guide);
  const action = guidePracticeAction(Boolean(existingExam), making);

  const toggleTopic = (index: number) => setOpenTopics((current) => (current.includes(index) ? current.filter((i) => i !== index) : [...current, index]));

  async function openPracticeExam() {
    if (!guide || making) return;
    if (existingExam) {
      navigate(`practice-exam/${encodeURIComponent(guide.id)}`);
      return;
    }
    setExamError(null);
    setMaking(true);
    try {
      const exam = await generatePracticeExam({
        syllabusText: guideTextForExam(guide),
        courseName: guide.courseTitle,
        questionCount: PRACTICE_EXAM_QUESTIONS,
        focusTopics: practiceFocusTopics(topics),
      });
      dispatch({
        type: "ADD_PRACTICE_EXAM",
        payload: {
          id: generateId(),
          studyGuideId: guide.id,
          courseTitle: exam.courseTitle,
          // The number of questions that survived validation, not the number that was asked for.
          totalQuestions: exam.questions.length,
          estimatedMinutes: exam.estimatedMinutes,
          questions: exam.questions,
          createdAt: new Date().toISOString(),
          sourceTruncated: guide.sourceTruncated || undefined,
        },
      });
      navigate(`practice-exam/${encodeURIComponent(guide.id)}`);
    } catch (error) {
      setExamError(describeStudyError(error, "generate the practice exam"));
    } finally {
      setMaking(false);
    }
  }

  function deleteGuide() {
    if (!guide) return;
    const id = guide.id;
    setLeaving(guide);
    setMoreOpen(false);
    // Its practice exams go with it (the reducer removes them).
    dispatch({ type: "DELETE_STUDY_GUIDE", payload: id });
    goBack("study-guides");
  }

  const top = <ToolTop onBack={() => goBack("study-guides")} right={<ToolIconButton icon="more" onPress={() => setMoreOpen(true)} ariaLabel="More: delete this study guide" />} />;

  const head = (
    <>
      <ToolHead
        lead={
          <>
            {cls ? <CourseChip label={classShortName(cls)} color={cls.color} /> : null}
            <LeadText>Study guide</LeadText>
          </>
        }
        title={guide.courseTitle}
        sub={meta || null}
      >
        {truncation ? <p style={{ margin: "6px 0 0", fontSize: 13, lineHeight: "18px", color: colors.gold }}>{truncation}</p> : null}
        {guide.overview ? <p style={{ margin: "10px 0 0", fontSize: 15, lineHeight: "22px", color: colors.foreground, maxWidth: desktop ? 760 : undefined }}>{guide.overview}</p> : null}
      </ToolHead>

      <AiContentLabel surface="study guide" content={() => studyGuideExcerpt(guide)} style={{ padding: "0 4px", marginTop: -6 }} />
    </>
  );

  const filterBar = <Segmented<ImportanceFilter> options={importanceOptions(topics).map((option) => ({ value: option.value, label: option.label, ariaLabel: option.accessibilityLabel }))} value={filter} onChange={setFilter} scroll style={desktop ? { alignSelf: "flex-start", maxWidth: "100%" } : undefined} />;

  const topicList = (
    <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <SectionLabel title="Topics" right={<MonoCount>{shown.length}</MonoCount>} />
      {shown.length > 0 ? (
        <FieldGroup>
          {shown.map(({ topic, index }) => {
            const tag = importanceTag(topic.importance);
            const terms = Array.isArray(topic.keyTerms) ? topic.keyTerms : [];
            return (
              <FoldRow
                key={index}
                open={openTopics.includes(index)}
                onToggle={() => toggleTopic(index)}
                title={topic.title}
                sub={topic.week || null}
                right={<Tag label={tag.label} tone={tag.strong ? "blue" : "neutral"} />}
                ariaLabel={`${topic.title}, ${tag.label} importance${topic.week ? `, ${topic.week}` : ""}`}
              >
                {topic.description ? <FoldText>{topic.description}</FoldText> : null}
                {terms.length > 0 ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <SmallLabel>Key terms</SmallLabel>
                    <Chips items={terms} />
                  </div>
                ) : null}
              </FoldRow>
            );
          })}
        </FieldGroup>
      ) : (
        <Note tone="plain">{topics.length === 0 ? "This guide has no topics." : `No topics of ${filter} importance in this guide.`}</Note>
      )}
    </section>
  );

  const tipList = tips.length > 0 ? (
    <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <SectionLabel title="Study tips" />
      <FieldGroup>
        {tips.map((tip, index) => (
          <div key={index} style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "12px 14px" }}>
            <span style={{ fontFamily: MONO_FONT, fontSize: 13, lineHeight: "21px", fontWeight: 600, width: 18, flexShrink: 0, color: colors.muted }}>{index + 1}</span>
            <span style={{ flex: 1, fontSize: 15, lineHeight: "21px", color: colors.foreground }}>{tip}</span>
          </div>
        ))}
      </FieldGroup>
    </section>
  ) : null;

  const examErrorNote = examError ? <ToolError info={examError} onRetry={() => void openPracticeExam()} onDismiss={() => setExamError(null)} /> : undefined;
  const practiceButton = <PrimaryButton size="lg" fullWidth label={action.label} loading={making} disabled={making} onPress={() => void openPracticeExam()} ariaLabel={action.label} />;

  // A wide computer screen: the topics in the main column; the practice exam and the study tips in the rail beside them.
  if (desktop && wide) {
    return (
      <div className="screen full" style={{ gap: 18 }}>
        {top}
        {head}
        <div className="split" style={{ marginTop: 6 }}>
          <div className="split-main">
            {filterBar}
            {topicList}
          </div>
          <aside className="split-rail">
            <Card tone="surface" padded={false} radiusSize={18} style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12, background: `linear-gradient(140deg, ${alpha(colors.primary, 0.14)}, ${colors.surface} 70%)` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ width: 42, height: 42, borderRadius: 12, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", background: alpha(colors.violet, 0.16) }}>
                  <Icon name="test" size={20} color={colors.violet} />
                </span>
                <span style={{ fontSize: 17, lineHeight: "22px", fontWeight: 600, color: colors.foreground }}>Practice exam</span>
              </div>
              {examErrorNote}
              {action.wait ? <p style={{ margin: 0, fontSize: 13.5, lineHeight: "18px", color: colors.muted }}>{action.wait}</p> : null}
              {practiceButton}
            </Card>
            {tipList}
          </aside>
        </div>
        <StudyGuideMoreSheet open={moreOpen} title={guide.courseTitle} onClose={() => setMoreOpen(false)} onDelete={deleteGuide} />
      </div>
    );
  }

  return (
    <div className={desktop ? "screen medium" : "screen"} style={{ gap: 16, maxWidth: desktop ? undefined : 640 }}>
      {top}
      {head}
      {filterBar}
      {topicList}
      {tipList}

      {/* A failure is said over the button that failed: the footer is always on screen, the end of the guide is not. */}
      <FlowFooter hint={action.wait} above={examErrorNote}>
        {practiceButton}
      </FlowFooter>

      <StudyGuideMoreSheet open={moreOpen} title={guide.courseTitle} onClose={() => setMoreOpen(false)} onDelete={deleteGuide} />
    </div>
  );
}

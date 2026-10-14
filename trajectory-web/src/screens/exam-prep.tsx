// Exam prep, the study tool. Without an exam it is the tool's own list: the preps you have made (each with its class,
// date, how many topics are mastered and the countdown), then the exams that have none yet (clicking one starts a
// prep filled in from it), with quizzes and the preps of exams that are over folded behind a link. With an exam id it
// is that prep: its class, name, date and countdown; how many topics are mastered, with the study time planned for it
// and the link that plans or replans that time; the two ways to practise (flashcards and the quiz); then the reading,
// on a switch: the topics, or the study guide. Exam study time is ONE task handed to the same planner as every other
// task (src/engine/exam-runway.ts); before anything changes, the link asks the real planner whether the time fits
// and says what it found. The study guide, flashcards and quiz are written by the server's AI (ai.generateExamContent
// through src/lib/study-api.ts, validated by the engine's parsers), as the mobile app's components/study/exam-prep-*.tsx
// do; until then, definitions and flashcards lifted from the student's own notes stand in (newExamPrep). Pro only.

import { useEffect, useMemo, useRef, useState } from "react";

import { legibleOn, parseHexColor } from "../engine/contrast";
import { alpha } from "../engine/design";
import { examPrepsToRelink, findExamTask, withLinkedExam } from "../engine/exam-prep-link";
import {
  blocksAfterPrepDelete,
  buildExamPrepList,
  cardStep,
  definitionsTitle,
  deletePrepFacts,
  EMPTY_PREP_FORM,
  examWhen,
  foldTitle,
  guideIntro,
  linkedExamLine,
  linkedExamTask,
  MASTERY_LEVELS,
  masteryTag,
  newExamPrep,
  planDoneNote,
  planOfferNote,
  practiceButtons,
  PREP_COPY,
  prepFormCheck,
  prepName,
  prepPrefill,
  QUIZ_START,
  quizFinished,
  quizMark,
  quizResult,
  shouldWriteMaterial,
  stepFraction,
  stepLabel,
  studyTimeLine,
  topicCounts,
  topicReviewLine,
  topicRowTitle,
  withMaterial,
  type PlanNote,
  type PrepForm,
  type PrepRow,
  type QuizState,
  type SyllabusRow,
} from "../engine/exam-prep-view";
import { buildExamRunway, examTiming, previewRunway, runwayScheduleSummary, runwayTaskId } from "../engine/exam-runway";
import { sessionLengthFor } from "../engine/intelligent-scheduler";
import { prettyExamDate } from "../engine/study-free-view";
import { examStudyGuideExcerpt } from "../engine/study-guides";
import { MAX_REVIEW_IMAGES } from "../engine/study-images";
import { EXAM_MATERIAL_CHAR_LIMIT, formatCount } from "../engine/study-text";
import { comingUpShown, examBadge } from "../engine/study-view";
import type { ExamPrep, ExamStudyGuide, ExamTopic, MasteryLevel, Task } from "../engine/types";
import { generateId, localDateKey } from "../engine/utils";
import { classOfTask, classShortName } from "../engine/week-layout";
import { extractDocxText, generateExamContent, readFileAsBase64, readPickedImage, tooLargeFileError, uploadMaterialFile } from "../lib/study-api";
import { describeStudyError, type StudyErrorInfo } from "../lib/study-errors";
import { goBack, useNavigate, useRoute } from "../router";
import { useApp } from "../state/app-provider";
import { AiContentLabel } from "../components/ai-content-label";
import { ToolError, ToolLink } from "../components/study-parts";
import { useRedirectToPaywallIfNotPro } from "../state/use-pro-gate";
import { Icon, type IconName } from "../ui/icon";
import { useDesktop, useWideLayout } from "../ui/layout";
import { Card, CourseChip, DateBadge, DateInput, FieldGroup, FieldLabel, FieldPickRow, FieldRow, HeaderIconButton, MONO_FONT, Note, PrimaryButton, ScreenHeader, SectionLabel, Segmented, TimeInput } from "../ui/primitives";
import { Sheet, SheetBody, SheetHead } from "../ui/sheet";
import { useColors } from "../ui/theme";
import { FoldLink, ThinBar } from "./study";

// ── Small parts ───────────────────────────────────────────────

function SmallCaps({ children, color }: { children: string; color?: string }) {
  const colors = useColors();
  return <span className="truncate" style={{ display: "block", fontFamily: MONO_FONT, fontSize: 12, lineHeight: "16px", fontWeight: 600, letterSpacing: 1.2, textTransform: "uppercase", color: color ?? colors.muted }}>{children}</span>;
}

type TagTone = "green" | "gold" | "red" | "violet";
function StateTag({ label, tone, icon }: { label: string; tone: TagTone; icon?: IconName }) {
  const colors = useColors();
  const base = tone === "green" ? colors.success : tone === "gold" ? colors.gold : tone === "red" ? colors.error : colors.violet;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, height: 22, padding: "0 7px", borderRadius: 6, border: `1px solid ${alpha(base, 0.5)}`, background: alpha(base, 0.14), flexShrink: 0 }}>
      {icon ? <Icon name={icon} size={13} color={base} /> : null}
      <span className="truncate" style={{ fontFamily: MONO_FONT, fontSize: 12, lineHeight: "16px", fontWeight: 600, letterSpacing: 1, textTransform: "uppercase", color: base }}>{label}</span>
    </span>
  );
}

function TextLink({ label, onPress, color, ariaLabel, style }: { label: string; onPress: () => void; color?: string; ariaLabel?: string; style?: React.CSSProperties }) {
  const colors = useColors();
  return (
    <button type="button" className="link" onClick={onPress} aria-label={ariaLabel ?? label} style={{ minHeight: 44, padding: "0 12px", fontSize: 14, lineHeight: "19px", fontWeight: 600, color: color ?? colors.peri, ...style }}>
      {label}
    </button>
  );
}

/** A full step over the prep (flashcards, the quiz): where you are in the middle and the bar under it, the content, the buttons. */
function StepSheet({ open, onClose, where, fraction, closeLabel, children, footer }: { open: boolean; onClose: () => void; where: string; fraction: number; closeLabel: string; children: React.ReactNode; footer: React.ReactNode }) {
  const colors = useColors();
  return (
    <Sheet open={open} onClose={onClose} ariaLabel={where} wide>
      <SheetBody>
        <SheetHead eyebrow={where} eyebrowColor={colors.peri} title="" onClose={onClose} closeLabel={closeLabel} />
        <ThinBar fraction={fraction} style={{ marginTop: -18 }} />
        <div style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 240 }}>{children}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{footer}</div>
      </SheetBody>
    </Sheet>
  );
}

// ── Flashcards and the quiz ───────────────────────────────────

function FlashcardsViewer({ open, onClose, cards, aiGenerated, chip }: { open: boolean; onClose: () => void; cards: readonly { front: string; back: string }[]; aiGenerated?: boolean; chip?: { label: string; color?: string } | null }) {
  const colors = useColors();
  const [index, setIndex] = useState(0);
  const [showBack, setShowBack] = useState(false);
  useEffect(() => {
    if (open) {
      setIndex(0);
      setShowBack(false);
    }
  }, [open]);
  const at = Math.min(index, Math.max(cards.length - 1, 0));
  const card = cards[at];
  if (!card) return null;
  const go = (by: 1 | -1) => {
    setShowBack(false);
    setIndex(cardStep(at, by, cards.length));
  };
  const side = showBack ? "Answer" : "Question";
  const text = showBack ? card.back : card.front;
  const hint = showBack ? "Click the card to see the question" : "Click the card to see the answer";
  const size = text.length > 220 ? 17 : text.length > 110 ? 20 : 24;
  return (
    <StepSheet
      open={open}
      onClose={onClose}
      closeLabel="Close the flashcards"
      where={stepLabel("Card", at, cards.length)}
      fraction={stepFraction(at, cards.length)}
      footer={
        <div style={{ display: "flex", gap: 10 }}>
          <PrimaryButton label="Previous" tone="ghost" size="lg" style={{ flex: 1 }} left={<Icon name="chevronLeft" size={18} color={colors.foreground} strokeWidth={2} />} onPress={() => go(-1)} disabled={at === 0} ariaLabel="Previous card" />
          <PrimaryButton label="Next" size="lg" style={{ flex: 1 }} right={<Icon name="chevronRight" size={18} color="#FFFFFF" strokeWidth={2} />} onPress={() => go(1)} disabled={at === cards.length - 1} ariaLabel="Next card" />
        </div>
      }
    >
      <button type="button" onClick={() => setShowBack((value) => !value)} aria-label={`${side}: ${text}. ${hint}`} style={{ minHeight: 340, borderRadius: 20, border: `1px solid ${showBack ? alpha(colors.accent, 0.7) : colors.border}`, background: colors.surface, padding: 22, display: "flex", flexDirection: "column", justifyContent: "space-between", gap: 18, textAlign: "left" }}>
        <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <SmallCaps color={showBack ? colors.peri : colors.muted}>{side}</SmallCaps>
          {chip?.label ? <CourseChip label={chip.label} color={chip.color} /> : null}
        </span>
        <span style={{ flexGrow: 1, display: "flex", alignItems: "center", fontSize: size, lineHeight: 1.3, fontWeight: size > 20 ? 600 : 500, color: colors.foreground, whiteSpace: "pre-wrap" }}>{text}</span>
        <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, fontSize: 13, color: colors.muted }}>
          <Icon name="refresh" size={16} color={colors.muted} />
          {hint}
        </span>
      </button>
      {/* The cards are the AI's, or "term: definition" lines lifted from the student's notes, which carry no AI label. */}
      {aiGenerated ? <AiContentLabel surface="exam prep" content={() => `Flashcard\nQ: ${card.front}\nA: ${card.back}`} /> : null}
    </StepSheet>
  );
}

function QuizViewer({ open, onClose, questions, over }: { open: boolean; onClose: () => void; questions: readonly { question: string; answer: string }[]; over: string }) {
  const colors = useColors();
  const [quiz, setQuiz] = useState<QuizState>(QUIZ_START);
  useEffect(() => {
    if (open) setQuiz(QUIZ_START);
  }, [open]);
  const total = questions.length;
  const question = questions[Math.min(quiz.index, Math.max(total - 1, 0))];
  if (!question) return null;

  if (quizFinished(quiz, total)) {
    const result = quizResult(quiz.score, total);
    return (
      <StepSheet
        open={open}
        onClose={onClose}
        closeLabel="Close the quiz"
        where="Quiz result"
        fraction={1}
        footer={
          <div style={{ display: "flex", gap: 10 }}>
            <PrimaryButton label="Try again" tone="ghost" size="lg" style={{ flex: 1 }} onPress={() => setQuiz(QUIZ_START)} ariaLabel="Try the quiz again" />
            <PrimaryButton label="Done" size="lg" style={{ flex: 1 }} onPress={onClose} ariaLabel="Done, close the quiz" />
          </div>
        }
      >
        <div aria-label={`${result.headline}. ${result.sentence}`} style={{ flexGrow: 1, display: "flex", flexDirection: "column", justifyContent: "center", gap: 8 }}>
          <SmallCaps>{over}</SmallCaps>
          <h2 style={{ margin: 0, fontSize: 30, lineHeight: "36px", fontWeight: 800, letterSpacing: -0.75, color: colors.foreground }}>{result.headline}</h2>
          <p style={{ margin: 0, fontSize: 15, lineHeight: "21px", color: colors.muted }}>{result.sentence}</p>
        </div>
      </StepSheet>
    );
  }

  const mark = (knew: boolean) => setQuiz((state) => quizMark(state, knew, total));
  return (
    <StepSheet
      open={open}
      onClose={onClose}
      closeLabel="Close the quiz"
      where={stepLabel("Question", quiz.index, total)}
      fraction={stepFraction(quiz.index, total)}
      footer={
        quiz.revealed ? (
          <>
            <p className="caption" style={{ margin: 0, textAlign: "center" }}>You mark it yourself</p>
            <div style={{ display: "flex", gap: 10 }}>
              <PrimaryButton label="Didn't know" tone="ghost" size="lg" style={{ flex: 1 }} onPress={() => mark(false)} />
              <PrimaryButton label="I knew it" size="lg" style={{ flex: 1 }} left={<Icon name="check" size={18} color="#FFFFFF" strokeWidth={2.4} />} onPress={() => mark(true)} />
            </div>
          </>
        ) : (
          <PrimaryButton label="Show answer" size="lg" fullWidth onPress={() => setQuiz((state) => ({ ...state, revealed: true }))} />
        )
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <SmallCaps>{over}</SmallCaps>
        <h2 style={{ margin: 0, fontSize: 21, lineHeight: "28px", fontWeight: 600, letterSpacing: -0.2, color: colors.foreground }}>{question.question}</h2>
      </div>
      {quiz.revealed ? (
        <div style={{ borderRadius: 16, border: `1px solid ${colors.borderStrong}`, background: colors.surface, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
          <SmallCaps>Answer</SmallCaps>
          <p style={{ margin: 0, fontSize: 15, lineHeight: "22px", color: colors.foreground, whiteSpace: "pre-wrap" }}>{question.answer}</p>
        </div>
      ) : null}
      {/* Every question of the quiz is written by the AI. */}
      <AiContentLabel surface="practice exam" content={() => `Practice question\nQ: ${question.question}\nA: ${question.answer}`} />
    </StepSheet>
  );
}

// ── Topics and the study guide ────────────────────────────────

function MasteryControl({ topic, onMark }: { topic: ExamTopic; onMark: (level: MasteryLevel) => void }) {
  const colors = useColors();
  return (
    <div role="radiogroup" style={{ display: "flex", gap: 4, padding: 4, borderRadius: 14, border: `1px solid ${colors.border}`, background: colors.panel }}>
      {MASTERY_LEVELS.map((level) => {
        const on = topic.mastery === level;
        const { label } = masteryTag(level);
        return (
          <button key={level} type="button" role="radio" aria-checked={on} aria-label={`${topic.title}: ${label}`} onClick={() => onMark(level)} style={{ flex: 1, minHeight: 44, padding: "0 4px", borderRadius: 10, border: `1px solid ${on ? alpha(colors.accent, 0.7) : "transparent"}`, background: on ? alpha(colors.primary, 0.22) : "transparent", color: on ? colors.foreground : colors.muted, fontSize: 14, fontWeight: 600 }}>
            {label}
          </button>
        );
      })}
    </div>
  );
}

function ExamPrepTopics({ topics, aiWritten, onMark }: { topics: readonly ExamTopic[]; aiWritten: boolean; onMark: (topicId: string, level: MasteryLevel) => void }) {
  const colors = useColors();
  const [openId, setOpenId] = useState<string | null>(null);
  if (topics.length === 0) return <Note tone="plain" icon="list">This exam prep has no topics.</Note>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {/* The topics' descriptions were written by the AI study guide. */}
      {aiWritten ? <AiContentLabel surface="exam prep" content={() => topics.filter((topic) => topic.description).slice(0, 8).map((topic) => `${topic.title}: ${topic.description}`).join("\n")} /> : null}
    <FieldGroup>
      {topics.map((topic, index) => {
        const open = openId === topic.id;
        const tag = masteryTag(topic.mastery);
        return (
          <div key={topic.id}>
            <button type="button" className="row pressable" aria-expanded={open} aria-label={`Topic ${index + 1}, ${topic.title}, ${tag.label}`} onClick={() => setOpenId(open ? null : topic.id)} style={{ minHeight: 62, gap: 10 }}>
              <span className="row-text">
                <SmallCaps>{`Topic ${index + 1}`}</SmallCaps>
                <span style={{ display: "block", fontSize: 16, lineHeight: "21px", fontWeight: 600, color: colors.foreground }}>{topicRowTitle(topic.title)}</span>
              </span>
              {open ? null : <StateTag label={tag.label} tone={tag.tone} />}
              <span style={{ display: "inline-flex", transform: open ? "rotate(180deg)" : undefined }}>
                <Icon name="chevronDown" size={18} color={colors.muted} />
              </span>
            </button>
            {open ? (
              <div style={{ padding: "0 14px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
                {topic.description ? <p style={{ margin: 0, fontSize: 14, lineHeight: "21px", color: colors.muted }}>{topic.description}</p> : null}
                <span style={{ fontSize: 13, lineHeight: "18px", color: colors.muted }}>{topicReviewLine(topic)}</span>
                <FieldLabel style={{ marginTop: 6, marginBottom: -1 }}>How well do you know it?</FieldLabel>
                <MasteryControl topic={topic} onMark={(level) => onMark(topic.id, level)} />
              </div>
            ) : null}
          </div>
        );
      })}
    </FieldGroup>
    </div>
  );
}

function ExamPrepGuide({ guide, writing, onGenerate }: { guide: ExamStudyGuide | undefined; writing: boolean; onGenerate: () => void }) {
  const colors = useColors();
  const intro = guideIntro(guide, writing);
  const expansions = guide?.topicExpansions ?? [];
  const concepts = guide?.keyConcepts ?? [];
  const definitions = guide?.importantDefinitions ?? [];
  const body = { margin: 0, fontSize: 14, lineHeight: "21px", color: colors.muted } as const;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {intro ? (
        <Card tone="surface" padded={false} radiusSize={18} style={{ padding: 16, display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", marginBottom: 4 }}>
            <StateTag label="AI study guide" tone="violet" icon="spark" />
          </div>
          <h2 style={{ margin: 0, fontSize: 19, lineHeight: "24px", fontWeight: 700, letterSpacing: -0.3, color: colors.foreground }}>{intro.title}</h2>
          <p style={body}>{intro.body}</p>
          {intro.action ? <PrimaryButton label={intro.action} size="lg" fullWidth onPress={onGenerate} style={{ marginTop: 10 }} /> : null}
        </Card>
      ) : null}

      {guide ? (
        <>
          {guide.aiGenerated ? <AiContentLabel surface="study guide" content={() => examStudyGuideExcerpt(guide)} /> : null}
          {guide.bigPictureSummary ? (
            <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <SectionLabel title="Big picture" />
              <Card tone="surface" padded={false} radiusSize={16} style={{ padding: "14px 16px" }}>
                <p style={{ margin: 0, fontSize: 15, lineHeight: "23px", color: colors.foreground, whiteSpace: "pre-wrap" }}>{guide.bigPictureSummary}</p>
              </Card>
            </section>
          ) : null}
          {expansions.length > 0 ? (
            <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <SectionLabel title="Topic deep dives" />
              <FieldGroup>
                {expansions.map((expansion, index) => (
                  <div key={`${index}-${expansion.title}`} style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 8, borderTop: index > 0 ? `1px solid ${colors.border}` : undefined }}>
                    <h3 style={{ margin: 0, fontSize: 16, lineHeight: "21px", fontWeight: 600, color: colors.foreground }}>{expansion.title}</h3>
                    <p style={body}>{expansion.explanation}</p>
                    {expansion.keyPoints?.length > 0 ? (
                      <ul style={{ margin: 0, padding: "0 0 0 18px", display: "flex", flexDirection: "column", gap: 6 }}>
                        {expansion.keyPoints.map((point, at) => <li key={at} style={{ ...body, color: colors.foreground }}>{point}</li>)}
                      </ul>
                    ) : null}
                    {expansion.commonMistakes ? (
                      <div style={{ border: `1px solid ${alpha(colors.error, 0.45)}`, borderRadius: 12, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 4, marginTop: 2 }}>
                        <SmallCaps color={colors.error}>Common mistake</SmallCaps>
                        <p style={{ ...body, color: colors.foreground }}>{expansion.commonMistakes}</p>
                      </div>
                    ) : null}
                  </div>
                ))}
              </FieldGroup>
            </section>
          ) : null}
          {concepts.length > 0 ? (
            <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <SectionLabel title="Key concepts" />
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {concepts.map((concept, index) => (
                  <span key={`${index}-${concept}`} style={{ minHeight: 30, display: "inline-flex", alignItems: "center", padding: "5px 10px", borderRadius: 9, border: `1px solid ${colors.borderStrong}`, background: colors.panel, fontSize: 13, lineHeight: "18px", fontWeight: 500, color: colors.foreground }}>{concept}</span>
                ))}
              </div>
            </section>
          ) : null}
          {definitions.length > 0 ? (
            <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <SectionLabel title={definitionsTitle(guide)} />
              <FieldGroup>
                {definitions.map((definition, index) => (
                  <div key={`${index}-${definition.term}`} style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 3, borderTop: index > 0 ? `1px solid ${colors.border}` : undefined }}>
                    <span style={{ fontSize: 15, lineHeight: "20px", fontWeight: 600, color: colors.foreground }}>{definition.term}</span>
                    <p style={body}>{definition.definition}</p>
                  </div>
                ))}
              </FieldGroup>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

// ── The sheet that starts a prep ──────────────────────────────

const MAX_NOTES_CHARS = 200_000;

interface PrepPrefill {
  classId?: string;
  date?: string;
  taskId?: string;
}

function ExamPrepCreateSheet({ open, onClose, prefill, onCreated }: { open: boolean; onClose: () => void; prefill?: PrepPrefill; onCreated: (examId: string) => void }) {
  const colors = useColors();
  const { state, dispatch } = useApp();
  const [form, setForm] = useState<PrepForm>(EMPTY_PREP_FORM);
  const [fileName, setFileName] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<StudyErrorInfo | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  // What the sheet was last opened for: the same exam again keeps what was typed, another one starts clean.
  const openedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const key = prefill?.taskId ? `task:${prefill.taskId}` : prefill?.classId || prefill?.date ? `link:${prefill.classId ?? ""}:${prefill.date ?? ""}` : "";
    const patch = prepPrefill(prefill, state.tasks, state.classes);
    if (openedFor.current !== key) {
      // Another exam (or none): nothing an earlier one left in the sheet carries over.
      setForm({ ...EMPTY_PREP_FORM, ...patch });
      setFileName("");
      setUploadError(null);
      setNotesOpen(false);
    } else {
      setForm((current) => ({ ...current, ...patch }));
    }
    openedFor.current = key;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, prefill?.classId, prefill?.date, prefill?.taskId]);

  const todayKey = localDateKey(new Date());
  const linkedTask = linkedExamTask(form, state.tasks);
  const check = prepFormCheck(form, { todayKey, uploading: isUploading, linked: Boolean(linkedTask) });
  const showNotes = notesOpen || form.notes.length > 0;
  const patch = (changes: Partial<PrepForm>) => setForm((current) => ({ ...current, ...changes }));

  function appendNotes(text: string) {
    setForm((current) => ({ ...current, notes: (current.notes ? `${current.notes}\n\n${text}` : text).slice(0, MAX_NOTES_CHARS) }));
  }

  /** A PDF is uploaded for the AI to read; a Word file's text (read by the server) and a text file go into the notes. */
  async function handlePickFile(file: File | undefined) {
    if (!file) return;
    setUploadError(null);
    const name = file.name.toLowerCase();
    const isPlainText = file.type === "text/plain" || file.type === "text/markdown" || name.endsWith(".txt") || name.endsWith(".md");
    setIsUploading(true);
    try {
      if (isPlainText) {
        // Plain text never needs the server: it goes straight into the notes box.
        appendNotes((await file.text()).trim());
        setFileName(`${file.name} (added to your notes)`);
        setNotesOpen(true);
        return;
      }
      const base64 = await readFileAsBase64(file);
      const tooLarge = tooLargeFileError(base64);
      if (tooLarge) {
        setUploadError(tooLarge);
        return;
      }
      if (name.endsWith(".docx") || file.type.includes("wordprocessingml")) {
        appendNotes(await extractDocxText(base64));
        setFileName(`${file.name} (text extracted)`);
        setNotesOpen(true);
      } else if (name.endsWith(".pdf") || file.type === "application/pdf") {
        const uploaded = await uploadMaterialFile({ base64Data: base64, fileName: file.name, mimeType: "application/pdf" });
        patch({ fileUrl: uploaded.url });
        setFileName(file.name);
      } else {
        setUploadError({ kind: "unsupported", title: "File type not supported", message: "Use a PDF, a Word (.docx) file or a .txt file, or paste the text.", retryable: false });
      }
    } catch (e) {
      setUploadError(describeStudyError(e, "upload that file"));
    } finally {
      setIsUploading(false);
    }
  }

  /** Up to six photos of class material, each checked against the server's rules and uploaded one by one. */
  async function handlePickImages(files: readonly File[]) {
    setUploadError(null);
    const already = form.imageUrls;
    const room = MAX_REVIEW_IMAGES - already.length;
    if (room <= 0) {
      setUploadError({ kind: "invalid", title: "Photo limit reached", message: `You can add up to ${MAX_REVIEW_IMAGES} photos. Remove one to add another.`, retryable: false });
      return;
    }
    if (files.length === 0) return;
    setIsUploading(true);
    const urls: string[] = [];
    let firstProblem: StudyErrorInfo | null = null;
    try {
      for (const file of files.slice(0, room)) {
        const picked = await readPickedImage(file);
        if (!picked.ok) {
          firstProblem = firstProblem ?? { kind: picked.reason === "too_large" ? "too_large" : "unsupported", title: "Photo skipped", message: picked.message, retryable: false };
          continue;
        }
        try {
          const uploaded = await uploadMaterialFile({ base64Data: picked.base64, fileName: `photo_${generateId()}.jpg`, mimeType: picked.mimeType });
          urls.push(uploaded.url);
        } catch (e) {
          firstProblem = firstProblem ?? describeStudyError(e, "upload that photo");
        }
      }
    } finally {
      setIsUploading(false);
    }
    if (urls.length > 0) {
      const all = [...already, ...urls];
      patch({ imageUrls: all });
      setFileName(`${all.length} photo${all.length > 1 ? "s" : ""} ready`);
    }
    if (firstProblem) setUploadError(firstProblem);
  }

  function clearMaterial() {
    patch({ fileUrl: "", imageUrls: [] });
    setFileName("");
  }

  function handleCreate() {
    if (!check.canBuild) return;
    const exam = newExamPrep(form, { classes: state.classes, tasks: state.tasks, id: generateId, now: new Date() });
    dispatch({ type: "ADD_EXAM_PREP", payload: exam });
    setForm(EMPTY_PREP_FORM);
    setFileName("");
    setUploadError(null);
    setNotesOpen(false);
    openedFor.current = null;
    onClose();
    onCreated(exam.id);
  }

  const classOptions = [...state.classes.map((cls) => ({ id: cls.id, label: classShortName(cls) || cls.name, name: cls.name, color: cls.color as string | undefined })), { id: "", label: "None", name: "No class", color: undefined as string | undefined }];
  const linkedLine = linkedExamLine(linkedTask);

  return (
    <Sheet open={open} onClose={onClose} ariaLabel={PREP_COPY.newPrep}>
      <SheetBody gap={16}>
        <SheetHead title={PREP_COPY.newPrep} onClose={onClose} />
        {linkedLine ? <p className="sheet-sub" style={{ marginTop: -8 }}>{linkedLine}</p> : null}

        <div>
          <FieldLabel>Class · optional</FieldLabel>
          {state.classes.length === 0 ? (
            <span style={{ fontSize: 13, lineHeight: "18px", color: colors.muted }}>No classes yet: the exam will be saved as General</span>
          ) : (
            <div role="radiogroup" className="hidden-scrollbar" style={{ display: "flex", gap: 6, overflowX: "auto" }}>
              {classOptions.map((option) => {
                const selected = form.classId === option.id;
                const base = option.color && parseHexColor(option.color) ? option.color : null;
                return (
                  <button key={option.id || "none"} type="button" role="radio" aria-checked={selected} aria-label={option.id ? `Class ${option.name}` : "No class: saved as General"} onClick={() => patch({ classId: option.id })} style={{ minHeight: 44, minWidth: 56, padding: "0 12px", borderRadius: 12, flexShrink: 0, background: selected ? alpha(base ?? colors.primary, 0.18) : colors.panel, border: `${selected ? 1.5 : 1}px solid ${selected ? (base ?? colors.accent) : colors.borderStrong}`, color: base ? legibleOn(base, colors.panel) : selected ? colors.foreground : colors.muted, fontFamily: base ? MONO_FONT : undefined, fontSize: base ? 13 : 14, fontWeight: 600, whiteSpace: "nowrap" }}>
                    {option.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <FieldGroup>
            <FieldRow first icon="cal" label="Exam date" tint={form.dateKey ? undefined : colors.gold}>
              <DateInput ariaLabel="Exam date" value={form.dateKey} min={todayKey} onChange={(dateKey) => patch({ dateKey })} />
            </FieldRow>
            <FieldRow icon="clock" label="Starts" detail={form.time ? undefined : "Optional"}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <TimeInput ariaLabel="Start time, optional" value={form.time} onChange={(time) => patch({ time })} />
                {form.time ? <button type="button" className="link" style={{ fontSize: 13 }} onClick={() => patch({ time: "" })} aria-label="Clear the start time">Clear</button> : null}
              </div>
            </FieldRow>
          </FieldGroup>
          {check.advice ? <span style={{ fontSize: 13, lineHeight: "18px", color: colors.muted }}>{check.advice.message}</span> : null}
        </div>

        <div>
          <FieldLabel>What is on the exam? One topic per line</FieldLabel>
          <textarea className="input" value={form.topics} onChange={(e) => patch({ topics: e.target.value })} placeholder={"GAAP vs Non-GAAP Accounting\nRevenue Recognition\nBalance Sheet Analysis"} rows={4} maxLength={20000} aria-label="Exam topics, one per line" />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <FieldLabel style={{ marginBottom: -2 }}>Class material · optional</FieldLabel>
          <div style={{ display: "flex", gap: 8 }}>
            <PrimaryButton tone="ghost" size="md" label="Add a file" left={<Icon name="file" size={17} color={colors.foreground} />} onPress={() => fileInput.current?.click()} disabled={isUploading} ariaLabel="Add a file: PDF, Word or text" style={{ flex: 1 }} />
            <PrimaryButton tone="ghost" size="md" label="Add photos" left={<Icon name="image" size={17} color={colors.foreground} />} onPress={() => photoInput.current?.click()} disabled={isUploading} ariaLabel={`Add photos, up to ${MAX_REVIEW_IMAGES}`} style={{ flex: 1 }} />
          </div>
          <input ref={fileInput} type="file" accept=".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown" style={{ display: "none" }} aria-hidden tabIndex={-1} onChange={(e) => { void handlePickFile(e.target.files?.[0]); e.target.value = ""; }} />
          <input ref={photoInput} type="file" accept="image/jpeg,image/png,image/webp" multiple style={{ display: "none" }} aria-hidden tabIndex={-1} onChange={(e) => { void handlePickImages(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
          {isUploading ? (
            <div role="status" aria-live="polite" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="spinner" />
              <span style={{ fontSize: 13, lineHeight: "18px", color: colors.muted }}>Uploading</span>
            </div>
          ) : null}
          {uploadError ? <ToolError info={uploadError} onDismiss={() => setUploadError(null)} /> : null}
          {fileName ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 44, paddingLeft: 12, borderRadius: 12, border: `1px solid ${alpha(colors.success, 0.45)}`, background: alpha(colors.success, 0.1) }}>
              <Icon name="check" size={16} color={colors.success} />
              <span className="clamp2" style={{ flex: 1, minWidth: 0, fontSize: 14, lineHeight: "19px", fontWeight: 500, color: colors.foreground }}>{fileName}</span>
              <button type="button" onClick={clearMaterial} aria-label="Remove uploaded material" style={{ width: 44, height: 44, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <Icon name="close" size={16} color={colors.muted} />
              </button>
            </div>
          ) : null}
          {showNotes ? (
            <textarea className="input" value={form.notes} onChange={(e) => patch({ notes: e.target.value.slice(0, MAX_NOTES_CHARS) })} placeholder="Paste your class notes, definitions and key terms here" rows={5} aria-label="Class notes" />
          ) : (
            <TextLink label="Paste notes instead" onPress={() => setNotesOpen(true)} style={{ alignSelf: "center", margin: "-6px 0" }} />
          )}
          {form.notes.length > EXAM_MATERIAL_CHAR_LIMIT ? <span style={{ fontSize: 13, lineHeight: "18px", color: colors.gold }}>Long material: the AI reads only the first {formatCount(EXAM_MATERIAL_CHAR_LIMIT)} characters of your notes.</span> : null}
        </div>

        {check.reason ? <p role="alert" style={{ margin: 0, fontSize: 14, lineHeight: "19px", fontWeight: 600, textAlign: "center", color: colors.gold }}>{check.reason}</p> : null}
        <PrimaryButton size="lg" fullWidth label={PREP_COPY.build} disabled={!check.canBuild} onPress={handleCreate} ariaLabel={check.reason ? `${PREP_COPY.build}. ${check.reason}` : PREP_COPY.build} />
      </SheetBody>
    </Sheet>
  );
}

// ── The list ──────────────────────────────────────────────────

export function ExamPrepListScreen() {
  const colors = useColors();
  const navigate = useNavigate();
  const route = useRoute();
  const { state, dispatch } = useApp();
  const desktop = useDesktop();

  // Pro only, as the study tools are everywhere (waits until it is known whether there is Pro before redirecting).
  useRedirectToPaywallIfNotPro();
  const [showAll, setShowAll] = useState(false);
  const [showQuizzes, setShowQuizzes] = useState(false);
  const [showPast, setShowPast] = useState(false);
  const [creating, setCreating] = useState<{ prefill?: PrepPrefill } | null>(() => (route.query.new === "1" ? { prefill: { classId: route.query.classId, date: route.query.date, taskId: route.query.taskId } } : null));

  // Each prep as it is now; the link and date are saved so screens reading the saved date agree.
  useEffect(() => {
    for (const exam of examPrepsToRelink(state.examPreps, state.tasks)) dispatch({ type: "UPDATE_EXAM_PREP", payload: exam });
  }, [state.examPreps, state.tasks, dispatch]);
  useEffect(() => {
    if (route.query.new === "1") navigate("exam-prep", { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const todayKey = localDateKey(new Date());
  const list = useMemo(() => buildExamPrepList(state, todayKey), [state, todayKey]);
  const tagOf = (courseId: string, courseName: string, fallbackName: string) => {
    const cls = classOfTask({ courseId, courseName }, state.classes);
    return { label: classShortName(cls, fallbackName), color: cls?.color };
  };
  const count = (n: number) => <span style={{ fontFamily: MONO_FONT, fontSize: 12.5, lineHeight: "17px", fontWeight: 600, color: colors.muted }}>{n}</span>;
  const meta = { display: "flex", alignItems: "center", gap: 7, marginTop: 3 } as const;

  function prepRow(row: PrepRow) {
    const tag = tagOf(row.classId, row.className, row.courseName);
    return (
      <button key={row.id} type="button" className="row pressable" onClick={() => navigate(`exam-prep/${encodeURIComponent(row.id)}`)} aria-label={`${row.spoken}. Open it`} style={{ alignItems: "flex-start", padding: "12px 14px 14px" }}>
        <span className="well" style={{ background: alpha(row.past ? colors.muted : colors.violet, 0.16) }}>
          <Icon name="layers" size={18} color={row.past ? colors.muted : colors.violet} />
        </span>
        <span className="row-text">
          <span className="clamp2" style={{ display: "block", fontSize: 16, lineHeight: "21px", fontWeight: 600, color: row.past ? colors.muted : colors.foreground }}>{row.name}</span>
          <span style={meta}>
            {tag.label ? <CourseChip label={tag.label} color={tag.color} /> : null}
            <span className="truncate" style={{ fontSize: 14, lineHeight: "19px", color: colors.muted }}>{row.when}</span>
          </span>
          <span style={{ display: "block", fontSize: 13, lineHeight: "18px", marginTop: 8, color: colors.muted }}>{row.counts.line}</span>
          {row.counts.total > 0 ? <ThinBar fraction={row.counts.fraction} style={{ marginTop: 6 }} /> : null}
        </span>
        <DateBadge label={row.badge.label} tone={row.badge.tone} />
      </button>
    );
  }

  function syllabusRow(row: SyllabusRow) {
    const tag = tagOf(row.courseId, row.courseName, row.courseName);
    return (
      <button key={row.taskId} type="button" className="row pressable" onClick={() => setCreating({ prefill: { taskId: row.taskId } })} aria-label={row.spoken} style={{ minHeight: 62 }}>
        <span className="well" style={{ background: alpha(colors.gold, 0.14) }}>
          <Icon name="flag" size={18} color={colors.gold} />
        </span>
        <span className="row-text">
          <span className="clamp2" style={{ display: "block", fontSize: 16, lineHeight: "21px", fontWeight: 600, color: colors.foreground }}>{row.name}</span>
          <span style={meta}>
            {tag.label ? <CourseChip label={tag.label} color={tag.color} /> : null}
            <span className="truncate" style={{ fontSize: 14, lineHeight: "19px", color: colors.muted }}>{row.when}</span>
          </span>
        </span>
        <DateBadge label={row.badge.label} tone={row.badge.tone} />
      </button>
    );
  }

  const folded = comingUpShown(list.exams.length);
  const shownExams = showAll ? list.exams : list.exams.slice(0, folded);
  const onlyPast = list.preps.length === 0 && list.exams.length === 0 && list.quizzes.length === 0;
  const pastOpen = showPast || onlyPast;

  // ── The computer layout: the same sections as cards side by side, the button in the header ──

  function prepCard(row: PrepRow) {
    const tag = tagOf(row.classId, row.className, row.courseName);
    return (
      <button key={row.id} type="button" className="card lift" onClick={() => navigate(`exam-prep/${encodeURIComponent(row.id)}`)} aria-label={`${row.spoken}. Open it`} style={{ display: "flex", flexDirection: "column", alignItems: "stretch", gap: 10, padding: 18, minHeight: 168, textAlign: "left", opacity: row.past ? 0.8 : 1 }}>
        <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <span style={{ width: 40, height: 40, borderRadius: 12, display: "inline-flex", alignItems: "center", justifyContent: "center", background: alpha(row.past ? colors.muted : colors.violet, 0.16) }}>
            <Icon name="layers" size={19} color={row.past ? colors.muted : colors.violet} />
          </span>
          <DateBadge label={row.badge.label} tone={row.badge.tone} />
        </span>
        <span className="clamp2" style={{ fontSize: 17, lineHeight: "22px", fontWeight: 600, color: row.past ? colors.muted : colors.foreground }}>{row.name}</span>
        <span style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
          {tag.label ? <CourseChip label={tag.label} color={tag.color} /> : null}
          <span className="truncate" style={{ fontSize: 13.5, lineHeight: "19px", color: colors.muted }}>{row.when}</span>
        </span>
        <span style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 7 }}>
          <span className="truncate" style={{ fontSize: 13, lineHeight: "18px", color: colors.muted }}>{row.counts.line}</span>
          {row.counts.total > 0 ? <ThinBar fraction={row.counts.fraction} /> : null}
        </span>
      </button>
    );
  }

  function syllabusCard(row: SyllabusRow) {
    const tag = tagOf(row.courseId, row.courseName, row.courseName);
    return (
      <button key={row.taskId} type="button" className="card lift" onClick={() => setCreating({ prefill: { taskId: row.taskId } })} aria-label={row.spoken} style={{ display: "flex", flexDirection: "column", alignItems: "stretch", gap: 10, padding: 16, minHeight: 128, textAlign: "left" }}>
        <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <span className="well" style={{ background: alpha(colors.gold, 0.14) }}>
            <Icon name="flag" size={18} color={colors.gold} />
          </span>
          <DateBadge label={row.badge.label} tone={row.badge.tone} />
        </span>
        <span className="clamp2" style={{ fontSize: 16, lineHeight: "21px", fontWeight: 600, color: colors.foreground }}>{row.name}</span>
        <span style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0, marginTop: "auto" }}>
          {tag.label ? <CourseChip label={tag.label} color={tag.color} /> : null}
          <span className="truncate" style={{ fontSize: 13.5, lineHeight: "19px", color: colors.muted }}>{row.when}</span>
        </span>
      </button>
    );
  }

  if (desktop) {
    const grid = (min: string, children: React.ReactNode) => <div className="card-grid" style={{ ["--card-min" as string]: min, gap: 16 }}>{children}</div>;
    const section = { display: "flex", flexDirection: "column", gap: 12 } as const;
    return (
      <div className="screen full" style={{ gap: 22 }}>
        <div style={{ paddingTop: 4 }}>
          <HeaderIconButton onPress={() => goBack("study")} ariaLabel="Back to Study">
            <Icon name="chevronLeft" size={20} color={colors.foreground} strokeWidth={2} />
          </HeaderIconButton>
        </div>
        <ScreenHeader eyebrow={PREP_COPY.eyebrow} title={PREP_COPY.title} subtitle={PREP_COPY.sub} right={<PrimaryButton size="md" label={PREP_COPY.newPrep} left={<Icon name="plus" size={18} color="#FFFFFF" strokeWidth={2.2} />} onPress={() => setCreating({})} />} />

        {list.empty ? (
          <Card tone="surface" padded={false} radiusSize={20} style={{ padding: "28px 28px", display: "flex", alignItems: "flex-start", gap: 20 }}>
            <span style={{ width: 56, height: 56, borderRadius: 16, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", background: alpha(colors.violet, 0.16) }}>
              <Icon name="layers" size={26} color={colors.violet} />
            </span>
            <div style={{ flex: 1, minWidth: 0, maxWidth: 560 }}>
              <h2 style={{ margin: 0, fontSize: 21, lineHeight: "27px", fontWeight: 700, letterSpacing: -0.3, color: colors.foreground }}>{PREP_COPY.emptyTitle}</h2>
              <p style={{ margin: "6px 0 0", fontSize: 15, lineHeight: "22px", color: colors.muted }}>{PREP_COPY.emptySub}</p>
            </div>
          </Card>
        ) : null}

        {list.preps.length > 0 ? (
          <section style={section}>
            <SectionLabel title={PREP_COPY.yours} right={count(list.preps.length)} />
            {grid("280px", list.preps.map(prepCard))}
          </section>
        ) : null}
        {list.exams.length > 0 ? (
          <section style={section}>
            <SectionLabel title={PREP_COPY.without} right={count(list.exams.length)} />
            {grid("240px", shownExams.map(syllabusCard))}
            {list.exams.length > folded ? <TextLink label={showAll ? "Show fewer" : `Show all ${list.exams.length}`} onPress={() => setShowAll((value) => !value)} style={{ alignSelf: "center" }} /> : null}
          </section>
        ) : null}
        {list.quizzes.length > 0 ? (
          <section style={section}>
            <SectionLabel title={foldTitle("Quizzes", list.quizzes.length)} right={<FoldLink open={showQuizzes} onPress={() => setShowQuizzes((value) => !value)} what="the quizzes that have no exam prep yet" />} />
            {showQuizzes ? grid("240px", list.quizzes.map(syllabusCard)) : null}
          </section>
        ) : null}
        {list.past.length > 0 ? (
          <section style={section}>
            <SectionLabel title={foldTitle("Past", list.past.length)} color={colors.muted} right={onlyPast ? undefined : <FoldLink open={showPast} onPress={() => setShowPast((value) => !value)} what="the exam preps of exams that are over" />} />
            {pastOpen ? grid("280px", list.past.map(prepCard)) : null}
          </section>
        ) : null}

        <ExamPrepCreateSheet open={creating !== null} onClose={() => setCreating(null)} prefill={creating?.prefill} onCreated={(id) => navigate(`exam-prep/${encodeURIComponent(id)}`)} />
      </div>
    );
  }

  return (
    <div className="screen" style={{ gap: 14 }}>
      <div style={{ paddingTop: 4 }}>
        <HeaderIconButton onPress={() => goBack("study")} ariaLabel="Back to Study">
          <Icon name="chevronLeft" size={20} color={colors.foreground} strokeWidth={2} />
        </HeaderIconButton>
      </div>
      <ScreenHeader eyebrow={PREP_COPY.eyebrow} title={PREP_COPY.title} subtitle={PREP_COPY.sub} />

      {list.empty ? (
        <Card tone="surface" padded={false} radiusSize={18} style={{ padding: 18, display: "flex", flexDirection: "column", gap: 6 }}>
          <h2 style={{ margin: 0, fontSize: 19, lineHeight: "24px", fontWeight: 700, letterSpacing: -0.3, color: colors.foreground }}>{PREP_COPY.emptyTitle}</h2>
          <p style={{ margin: 0, fontSize: 14, lineHeight: "20px", color: colors.muted }}>{PREP_COPY.emptySub}</p>
        </Card>
      ) : null}

      {list.preps.length > 0 ? (
        <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <SectionLabel title={PREP_COPY.yours} right={count(list.preps.length)} />
          <FieldGroup>{list.preps.map(prepRow)}</FieldGroup>
        </section>
      ) : null}
      {list.exams.length > 0 ? (
        <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <SectionLabel title={PREP_COPY.without} right={count(list.exams.length)} />
          <FieldGroup>{shownExams.map(syllabusRow)}</FieldGroup>
          {list.exams.length > folded ? <TextLink label={showAll ? "Show fewer" : `Show all ${list.exams.length}`} onPress={() => setShowAll((value) => !value)} style={{ alignSelf: "center", margin: "-6px 0" }} /> : null}
        </section>
      ) : null}
      {list.quizzes.length > 0 ? (
        <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <SectionLabel title={foldTitle("Quizzes", list.quizzes.length)} right={<FoldLink open={showQuizzes} onPress={() => setShowQuizzes((value) => !value)} what="the quizzes that have no exam prep yet" />} />
          {showQuizzes ? <FieldGroup>{list.quizzes.map(syllabusRow)}</FieldGroup> : null}
        </section>
      ) : null}
      {list.past.length > 0 ? (
        <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <SectionLabel title={foldTitle("Past", list.past.length)} color={colors.muted} right={onlyPast ? undefined : <FoldLink open={showPast} onPress={() => setShowPast((value) => !value)} what="the exam preps of exams that are over" />} />
          {pastOpen ? <FieldGroup>{list.past.map(prepRow)}</FieldGroup> : null}
        </section>
      ) : null}

      <div className="flow-footer">
        <PrimaryButton size="lg" fullWidth label={PREP_COPY.newPrep} left={<Icon name="plus" size={20} color="#FFFFFF" strokeWidth={2} />} onPress={() => setCreating({})} />
      </div>

      <ExamPrepCreateSheet open={creating !== null} onClose={() => setCreating(null)} prefill={creating?.prefill} onCreated={(id) => navigate(`exam-prep/${encodeURIComponent(id)}`)} />
    </div>
  );
}

// ── One prep ──────────────────────────────────────────────────

/** Preps whose material has already been asked for in this session: a failure is retried by the student, not in a loop. */
const askedFor = new Set<string>();

function PlanNoteCard({ note, onAccept, onDismiss }: { note: PlanNote; onAccept: () => void; onDismiss: () => void }) {
  const colors = useColors();
  return (
    <Note tone={note.tone} icon={note.tone === "green" ? "check" : note.tone === "gold" ? "warning" : "calPlus"} role="alert">
      {note.title ? <div style={{ fontSize: 15, lineHeight: "20px", fontWeight: 600, color: colors.foreground }}>{note.title}</div> : null}
      {note.body ? <div style={{ fontSize: 14, lineHeight: "20px", marginTop: 2, color: colors.muted }}>{note.body}</div> : null}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
        {note.confirm ? <PrimaryButton size="sm" label={note.confirm} onPress={onAccept} /> : null}
        <PrimaryButton size="sm" tone="ghost" label={note.dismiss} onPress={onDismiss} />
      </div>
    </Note>
  );
}

export function ExamPrepDetailScreen({ examId }: { examId: string }) {
  const { state } = useApp();
  // Pro only (waits until it is known whether there is Pro before redirecting).
  useRedirectToPaywallIfNotPro();
  const exam = useMemo(() => {
    const found = (state.examPreps ?? []).find((candidate) => candidate.id === examId);
    return found ? withLinkedExam(found, state.tasks) : null;
  }, [state.examPreps, state.tasks, examId]);
  const colors = useColors();
  if (!exam) {
    return (
      <div className="screen">
        <div style={{ paddingTop: 4 }}>
          <HeaderIconButton onPress={() => goBack("exam-prep")} ariaLabel="Back to Exam prep">
            <Icon name="chevronLeft" size={20} color={colors.foreground} strokeWidth={2} />
          </HeaderIconButton>
        </div>
        <h1 style={{ margin: "40px 0 0", fontSize: 22, lineHeight: "28px", fontWeight: 700, color: colors.foreground }}>This exam prep is gone</h1>
        <p style={{ margin: 0, fontSize: 15, color: colors.muted }}>It was deleted. Exam prep lists the ones you still have.</p>
      </div>
    );
  }
  return <ExamPrepDetail key={exam.id} exam={exam} />;
}

function ExamPrepDetail({ exam }: { exam: ExamPrep }) {
  const colors = useColors();
  const desktop = useDesktop();
  const wide = useWideLayout();
  const route = useRoute();
  const { state, dispatch } = useApp();
  const questions = exam.studyGuide?.practiceQuestions ?? [];
  const cards = exam.studyGuide?.flashcards ?? [];

  const [tab, setTab] = useState<"topics" | "guide">("topics");
  const [cardsOpen, setCardsOpen] = useState(false);
  const [quizOpen, setQuizOpen] = useState(false);
  // Each opening of the quiz is a new run: nothing of the last one is kept.
  const [quizRun, setQuizRun] = useState(0);
  const [moreOpen, setMoreOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [isWriting, setIsWriting] = useState(false);
  const [aiError, setAiError] = useState<StudyErrorInfo | null>(null);

  // "Arrive on the quiz" (the Practice list's link, ?tab=quiz): once, as soon as the questions are there.
  const openQuiz = route.query.tab === "quiz";
  const arrivalDone = useRef(false);
  useEffect(() => {
    if (!openQuiz || arrivalDone.current || questions.length === 0) return;
    // Marked done only once it has opened: a wait that was cut short (the questions changed meanwhile) starts over.
    const pending = setTimeout(() => {
      arrivalDone.current = true;
      setQuizRun((run) => run + 1);
      setQuizOpen(true);
    }, 350);
    return () => clearTimeout(pending);
  }, [openQuiz, questions.length]);
  const [plan, setPlan] = useState<{ note: PlanNote; task: Task | null; update: boolean; replanning: boolean } | null>(null);

  const examRef = useRef(exam);
  useEffect(() => {
    examRef.current = exam;
  });
  const writing = useRef(false);

  const todayKey = localDateKey(new Date());
  const timing = examTiming(exam.examDate, todayKey);
  const isPast = timing.status === "past";

  async function writeMaterial() {
    if (writing.current) return;
    writing.current = true;
    askedFor.add(examRef.current.id);
    setIsWriting(true);
    setAiError(null);
    try {
      const source = examRef.current;
      const result = await generateExamContent({
        topics: source.topics.map((topic) => topic.title),
        rawInput: source.rawInput || undefined,
        pdfUrl: source.uploadedFileUrl || undefined,
        imageUrls: source.uploadedImageUrls || undefined,
        className: source.className,
        examDate: source.examDate,
        today: localDateKey(new Date()),
      });
      // Merged into the LATEST version of the prep, so what was marked meanwhile is kept.
      dispatch({ type: "UPDATE_EXAM_PREP", payload: withMaterial(examRef.current, result, new Date()) });
    } catch (error) {
      setAiError(describeStudyError(error, "generate your study materials"));
    } finally {
      writing.current = false;
      setIsWriting(false);
    }
  }

  // Written once when a prep is first opened (never for an exam that is over, never in a retry loop).
  useEffect(() => {
    if (shouldWriteMaterial(exam, { past: isPast, alreadyAsked: askedFor.has(exam.id) })) void writeMaterial();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exam.id]);

  const runwayId = runwayTaskId(exam.id);
  const summary = useMemo(() => runwayScheduleSummary(state.scheduleBlocks, exam.id, todayKey, exam.examTaskId), [state.scheduleBlocks, exam.id, exam.examTaskId, todayKey]);
  const hasPlan = state.tasks.some((task) => task.id === runwayId && task.status !== "done");
  const hasAiGuide = Boolean(exam.studyGuide?.aiGenerated);

  const named = prepName(exam);
  const cls = classOfTask({ courseId: exam.classId, courseName: exam.className }, state.classes);
  const tag = classShortName(cls, named.courseName);
  const badge = examBadge(timing);
  const counts = topicCounts(exam.topics);
  const time = studyTimeLine(summary, { hasPlan, past: isPast });
  const buttons = practiceButtons(exam.studyGuide, { writing: isWriting, hasAiGuide });

  function markTopic(topicId: string, mastery: MasteryLevel) {
    dispatch({ type: "UPDATE_EXAM_TOPIC_MASTERY", payload: { examId: exam.id, topicId, mastery } });
    setPlan(null);
  }

  /** Builds the exam's study task and asks the real planner whether it fits. Nothing is added yet. */
  function offerPlan() {
    const now = new Date();
    const existing = state.tasks.find((task) => task.id === runwayId);
    const runway = buildExamRunway(exam, { todayKey: localDateKey(now), now, existing, examTask: findExamTask(exam, state.tasks), maxSessionMinutes: sessionLengthFor(state.userPrefs) });
    const replanning = Boolean(existing && existing.status !== "done");
    setPlan({ note: planOfferNote(runway, previewRunway(runway, state, now), replanning), task: runway.status === "ready" ? runway.task : null, update: Boolean(existing), replanning });
  }
  function acceptPlan() {
    if (!plan?.task) return;
    dispatch({ type: plan.update ? "UPDATE_TASK" : "ADD_TASK", payload: plan.task });
    dispatch({ type: "AUTO_REPLAN" });
    setPlan({ note: planDoneNote(plan.replanning), task: null, update: false, replanning: plan.replanning });
  }
  function deletePrep() {
    if (state.tasks.some((task) => task.id === runwayId)) dispatch({ type: "DELETE_TASK", payload: runwayId });
    dispatch({ type: "SET_SCHEDULE_BLOCKS", payload: blocksAfterPrepDelete(state.scheduleBlocks, exam.id) });
    dispatch({ type: "DELETE_EXAM_PREP", payload: exam.id });
    setMoreOpen(false);
    goBack("exam-prep");
  }

  const deleteFacts = deletePrepFacts(exam);

  const topBar = (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingTop: 4 }}>
      <HeaderIconButton onPress={() => goBack("exam-prep")} ariaLabel="Back to Exam prep">
        <Icon name="chevronLeft" size={20} color={colors.foreground} strokeWidth={2} />
      </HeaderIconButton>
      <HeaderIconButton onPress={() => setMoreOpen(true)} ariaLabel={hasAiGuide ? "More: make the material again, or delete this exam prep" : "More: delete this exam prep"}>
        <Icon name="more" size={20} color={colors.foreground} strokeWidth={2} />
      </HeaderIconButton>
    </div>
  );

  const head = (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "0 4px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {tag ? <CourseChip label={tag} color={cls?.color} /> : null}
        <span style={{ fontSize: 14, lineHeight: "19px", color: colors.muted }}>Exam prep</span>
      </div>
      <h1 style={{ margin: 0, fontSize: desktop ? 34 : 30, lineHeight: desktop ? "40px" : "35px", fontWeight: 800, letterSpacing: desktop ? -1 : -0.75, color: colors.foreground }}>{named.name}</h1>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 15, lineHeight: "21px", color: colors.muted }}>{examWhen(exam.examDate, exam.examTime)}</span>
        <DateBadge label={badge.label} tone={badge.tone} />
      </div>
    </div>
  );

  const progressCard = (
    <Card tone="surface" padded={false} radiusSize={18} style={{ padding: desktop ? "18px 20px 6px" : "14px 16px 4px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <span className="clamp2" style={{ flex: 1, fontSize: 16, lineHeight: "21px", fontWeight: 600, color: counts.total > 0 ? colors.foreground : colors.muted }}>{counts.line}</span>
        {counts.reviewLine ? <span style={{ fontFamily: MONO_FONT, fontSize: 12.5, fontWeight: 500, color: colors.muted, flexShrink: 0 }}>{counts.reviewLine}</span> : null}
      </div>
      {counts.total > 0 ? <ThinBar fraction={counts.fraction} style={{ marginTop: 10 }} /> : null}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, minHeight: 44, padding: "6px 0" }}>
        <div style={{ flex: 1, minWidth: 0, fontSize: 13, lineHeight: "18px", color: colors.muted }}>
          <div>{time.text}</div>
          {time.next ? <div>{time.next}</div> : null}
        </div>
        {time.link ? <TextLink label={time.link} onPress={offerPlan} ariaLabel={`${time.link}: see what the plan would place before anything changes`} style={{ padding: "0 0 0 8px", flexShrink: 0 }} /> : null}
      </div>
    </Card>
  );

  const planNote = plan ? <PlanNoteCard note={plan.note} onAccept={acceptPlan} onDismiss={() => setPlan(null)} /> : null;

  const cardsButton = <PrimaryButton tone="ghost" label={buttons.cards.label} left={<Icon name="layers" size={18} color={colors.foreground} />} disabled={isWriting || buttons.cards.count === 0} onPress={() => setCardsOpen(true)} ariaLabel={buttons.cards.count > 0 ? `Flashcards, ${buttons.cards.count}` : "Flashcards: none yet"} style={{ flex: 1 }} />;
  const quizButton = <PrimaryButton tone="ghost" label={buttons.quiz.label} left={<Icon name="test" size={18} color={colors.foreground} />} disabled={isWriting || buttons.quiz.count === 0} onPress={() => { setQuizRun((run) => run + 1); setQuizOpen(true); }} ariaLabel={buttons.quiz.count > 0 ? `Quiz, ${buttons.quiz.count} questions` : "Quiz: no questions yet"} style={{ flex: 1 }} />;
  const practice = (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 8 }}>
        {cardsButton}
        {quizButton}
      </div>
      {buttons.reason ? <span style={{ fontSize: 13, lineHeight: "18px", color: colors.muted }}>{buttons.reason}</span> : null}
    </div>
  );

  const status = (
    <>
      {isWriting ? (
        <div role="status" aria-live="polite" style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 4px" }}>
          <span className="spinner" style={{ width: 18, height: 18 }} />
          <span style={{ fontSize: 14, lineHeight: "19px", fontWeight: 500, color: colors.foreground }}>{PREP_COPY.writing}</span>
        </div>
      ) : null}
      {aiError ? <ToolError info={aiError} onRetry={() => void writeMaterial()} onDismiss={() => setAiError(null)} retryLabel="Retry" /> : null}
      {exam.studyGuide?.inputTruncated ? <Note tone="gold" icon="info">{`Your pasted material was long, so only its first ${formatCount(EXAM_MATERIAL_CHAR_LIMIT)} characters were used. Anything after that isn't covered.`}</Note> : null}
    </>
  );

  const reading = (
    <>
      <Segmented
        value={tab}
        onChange={setTab}
        options={[
          { value: "topics", label: "Topics" },
          { value: "guide", label: "Study guide" },
        ]}
        style={desktop ? { maxWidth: 360 } : undefined}
      />
      {tab === "topics" ? <ExamPrepTopics topics={exam.topics} aiWritten={hasAiGuide && exam.topics.some((topic) => topic.description)} onMark={markTopic} /> : <ExamPrepGuide guide={exam.studyGuide} writing={isWriting} onGenerate={() => void writeMaterial()} />}
    </>
  );

  return (
    <div className={desktop ? (wide ? "screen full" : "screen medium") : "screen"} style={{ gap: desktop ? 18 : 14 }}>
      {topBar}
      {head}
      {desktop && wide ? (
        <div className="split" style={{ marginTop: 6 }}>
          <div className="split-main">
            {status}
            {reading}
          </div>
          <aside className="split-rail">
            {progressCard}
            {planNote}
            {practice}
          </aside>
        </div>
      ) : (
        <>
          {progressCard}
          {planNote}
          {practice}
          {status}
          {reading}
        </>
      )}

      {/* The "more" sheet: make the material again, delete the prep */}
      <Sheet open={moreOpen} onClose={() => { setMoreOpen(false); setConfirmingDelete(false); }} ariaLabel="This exam prep">
        <SheetBody>
          <SheetHead title="This exam prep" onClose={() => { setMoreOpen(false); setConfirmingDelete(false); }} />
          {/* "Make the material again" is absent until an AI study guide exists (there is nothing to make again before that). */}
          {hasAiGuide ? (
            <FieldGroup>
              {isWriting ? (
                <div style={{ minHeight: 58, display: "flex", flexDirection: "column", justifyContent: "center", padding: "8px 14px" }}>
                  <span style={{ fontSize: 16, lineHeight: "21px", fontWeight: 500, color: colors.muted }}>Make the material again</span>
                  <span style={{ fontSize: 13, lineHeight: "18px", color: colors.muted }}>It is being written right now.</span>
                </div>
              ) : (
                <FieldPickRow icon="refresh" label="Make the material again" detail="The study guide, flashcards and quiz are written again. What you marked on topics is kept." onPress={() => { setMoreOpen(false); void writeMaterial(); }} chevron={false} />
              )}
            </FieldGroup>
          ) : null}
          {confirmingDelete ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <Note tone="red" icon="warning" role="alert">
                <div style={{ fontSize: 15, lineHeight: "20px", fontWeight: 600, color: colors.foreground }}>{deleteFacts.title}</div>
                <div style={{ fontSize: 14, lineHeight: "20px", marginTop: 2, color: colors.foreground }}>{deleteFacts.body}</div>
              </Note>
              <div style={{ display: "flex", justifyContent: "center", gap: 18 }}>
                <ToolLink label="Delete" color={colors.error} onPress={deletePrep} ariaLabel="Delete this exam prep" />
                <ToolLink label="Keep" onPress={() => setConfirmingDelete(false)} ariaLabel="Keep this exam prep" />
              </div>
            </div>
          ) : (
            <ToolLink label="Delete this exam prep" color={colors.error} onPress={() => setConfirmingDelete(true)} style={{ alignSelf: "center" }} />
          )}
        </SheetBody>
      </Sheet>

      <FlashcardsViewer open={cardsOpen} onClose={() => setCardsOpen(false)} cards={cards} aiGenerated={hasAiGuide} chip={tag ? { label: tag, color: cls?.color } : null} />
      <QuizViewer key={quizRun} open={quizOpen} onClose={() => setQuizOpen(false)} questions={questions} over={named.name} />
    </div>
  );
}

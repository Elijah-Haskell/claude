// Practice exam, one of the study tools (opened from the Study tab): everything there is to practise with in one
// list (PracticeScreen). A practice exam built from a study guide opens PracticeExamScreen below; the practice quiz
// that comes with an exam prep opens that exam prep on its quiz. With nothing yet, the way to make some: build a study
// guide. The list is Pro only, as the study tools are everywhere; taking a saved exam is local, so it is not gated.
//
// A practice exam is taken one question at a time: where you are, the question, the answers as lettered rows, what
// was right and why after Submit, and at the bottom "Prev" and the one main button, which says why when it cannot be
// pressed. At the end the result (src/components/practice-result.tsx). Multiple choice and true or false are graded by
// src/engine/practice-exam-scoring.ts (the answerIndex contract, with back-compat for exams saved with letter or text
// answers); a short answer is marked by the student. A question with no usable answer key is shown, said to be
// unscored, and passed over. What the screens say is src/engine/study-tools-view.ts; the mobile app's
// app/practice.tsx and app/practice-exam.tsx.

import { useEffect, useMemo, useState } from "react";

import { alpha } from "../engine/design";
import { gradeResponse, identityOrder, isGradable, optionDisplayText, optionLabel, shuffledOrder, type QuestionResponse } from "../engine/practice-exam-scoring";
import { buildPracticeList, type PracticeEntry } from "../engine/study-hub";
import { savedTruncationNotice } from "../engine/study-text";
import { DIFFICULTY_LABEL, feedbackHeadline, NOT_SCORED_COPY, PRACTICE_EMPTY, PRACTICE_HEAD, practiceQuestionExcerpt, practiceRowLine, questionCounter, questionMetaLine, questionStep, selfMarkLine, SHORT_ANSWER_COPY } from "../engine/study-tools-view";
import type { PracticeQuestion } from "../engine/types";
import { goBack, useNavigate } from "../router";
import { useApp } from "../state/app-provider";
import { AiContentLabel } from "../components/ai-content-label";
import { PracticeResult } from "../components/practice-result";
import { useRedirectToPaywallIfNotPro } from "../state/use-pro-gate";
import { ChoiceRow, ExamTop, FlowFooter, FoldText, MonoCount, SmallLabel, Tag, ToolHead, ToolTop, type ChoiceState } from "../components/study-parts";
import { Icon } from "../ui/icon";
import { Card, FieldGroup, Note, PrimaryButton, SectionLabel } from "../ui/primitives";
import { useColors } from "../ui/theme";

// ── The list ──────────────────────────────────────────────────

export function PracticeScreen() {
  const colors = useColors();
  const navigate = useNavigate();
  const { state } = useApp();

  // Pro only (waits until it is known whether there is Pro before redirecting).
  useRedirectToPaywallIfNotPro();

  const entries = useMemo(() => buildPracticeList(state), [state]);

  function open(entry: PracticeEntry) {
    if (entry.kind === "practice_exam") navigate(`practice-exam/${encodeURIComponent(entry.guideId)}`);
    // An exam prep's quiz lives inside the exam prep: it opens there, on the quiz.
    else navigate(`exam-prep/${encodeURIComponent(entry.examId)}?tab=quiz`);
  }

  return (
    <div className="screen" style={{ gap: 16, maxWidth: 640 }}>
      <ToolTop onBack={() => goBack("study")} backLabel="Back" />
      <ToolHead eyebrow={PRACTICE_HEAD.eyebrow} title={PRACTICE_HEAD.title} sub={PRACTICE_HEAD.sub} />

      {entries.length > 0 ? (
        <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <SectionLabel title="Practice" right={<MonoCount>{entries.length}</MonoCount>} />
          <FieldGroup>
            {entries.map((entry) => {
              const quiz = entry.kind === "exam_quiz";
              const line = practiceRowLine(entry);
              // An exam's quiz carries the exam's gold; a practice exam the violet of what the AI made.
              const tint = quiz ? colors.gold : colors.violet;
              return (
                <button key={entry.key} type="button" className="row pressable" onClick={() => open(entry)} aria-label={`${entry.title}. ${line}`} style={{ minHeight: 64, padding: "10px 14px" }}>
                  <span className="well" style={{ width: 36, height: 36, borderRadius: 11, background: alpha(tint, quiz ? 0.14 : 0.16) }}>
                    <Icon name={quiz ? "flag" : "test"} size={18} color={tint} />
                  </span>
                  <span className="row-text">
                    <span className="clamp2" style={{ display: "block", fontSize: 16, lineHeight: "21px", fontWeight: 600, color: colors.foreground }}>{entry.title}</span>
                    <span className="row-detail clamp2" style={{ display: "block" }}>{line}</span>
                  </span>
                  <Icon name="chevronRight" size={18} color={colors.muted} />
                </button>
              );
            })}
          </FieldGroup>
        </section>
      ) : (
        <Card tone="surface" radiusSize={18} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <h2 style={{ margin: 0, fontSize: 19, lineHeight: "24px", fontWeight: 700, letterSpacing: -0.3, color: colors.foreground }}>{PRACTICE_EMPTY.title}</h2>
          <p style={{ margin: "0 0 6px", fontSize: 14, lineHeight: "20px", color: colors.muted }}>{PRACTICE_EMPTY.body}</p>
          <PrimaryButton size="lg" fullWidth label={PRACTICE_EMPTY.action} onPress={() => navigate("study-guides")} />
        </Card>
      )}
    </div>
  );
}

// ── One practice exam ─────────────────────────────────────────

type AnswerState = QuestionResponse & { submitted: boolean; revealed?: boolean };

const optionCount = (question: PracticeQuestion | undefined) => (question && Array.isArray(question.options) ? question.options.length : 0);

/** The route carries the study guide's id (as the mobile app's does); an exam's own id opens it too. */
export function PracticeExamScreen({ examId }: { examId: string }) {
  const colors = useColors();
  const { state } = useApp();
  const exams = state.practiceExams || [];
  const exam = exams.find((candidate) => candidate.studyGuideId === examId) ?? exams.find((candidate) => candidate.id === examId);

  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<number, AnswerState>>({});
  const [examDone, setExamDone] = useState(false);
  // Every retake draws the options in a new order, so the student learns the answer, not its position. The first
  // time through they are in the order they were written.
  const [shuffled, setShuffled] = useState<number[][] | null>(null);

  // A new question starts at its top.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [currentIndex, examDone]);

  const question = exam?.questions[currentIndex];
  if (!exam || !question) {
    return (
      <div className="screen" style={{ maxWidth: 640 }}>
        <ToolTop onBack={() => goBack("practice")} />
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, padding: "80px 24px" }}>
          <h1 style={{ margin: 0, fontSize: 20, lineHeight: "26px", fontWeight: 600, textAlign: "center", color: colors.foreground }}>{exam ? "This practice exam has no questions." : "Practice exam not found."}</h1>
          <PrimaryButton label="Go back" tone="ghost" onPress={() => goBack("practice")} />
        </div>
      </div>
    );
  }

  const total = exam.questions.length;
  const orderOf = (index: number) => shuffled?.[index] ?? identityOrder(optionCount(exam.questions[index]));

  function patch(index: number, next: Partial<AnswerState>) {
    setAnswers((prev) => ({ ...prev, [index]: { ...(prev[index] ?? { submitted: false }), ...next } }));
  }

  function restartExam() {
    if (!exam) return;
    setShuffled(exam.questions.map((q) => shuffledOrder(optionCount(q))));
    setCurrentIndex(0);
    setAnswers({});
    setExamDone(false);
  }

  if (examDone) {
    return <PracticeResult exam={exam} answers={answers} orderOf={orderOf} onRetake={restartExam} onDone={() => goBack("practice")} />;
  }

  const answer = answers[currentIndex];
  const submitted = Boolean(answer?.submitted);
  const gradable = isGradable(question);
  const order = orderOf(currentIndex);
  const hasChoice = question.type === "multiple_choice" ? typeof answer?.selectedIndex === "number" : question.type === "true_false" ? typeof answer?.selectedBoolean === "boolean" : false;
  const step = questionStep({ type: question.type, gradable, submitted, hasChoice, isLast: currentIndex === total - 1 });
  // True / false once a choice has been submitted for a question that can be graded; null otherwise.
  const result = submitted && question.type !== "short_answer" && gradable ? gradeResponse(question, answer) : null;
  const truncation = currentIndex === 0 ? savedTruncationNotice({ sourceTruncated: exam.sourceTruncated }) : null;

  function next() {
    if (currentIndex < total - 1) setCurrentIndex((i) => i + 1);
    else setExamDone(true);
  }
  const onMain = () => {
    if (!step.enabled) return;
    if (step.action === "submit") patch(currentIndex, { submitted: true });
    else next();
  };

  const choiceState = (selected: boolean, right: boolean): ChoiceState => {
    if (submitted && gradable && right) return "right";
    if (submitted && gradable && selected) return "wrong";
    return selected ? "selected" : "idle";
  };
  const spoken = (look: ChoiceState) => (look === "right" ? ". The right answer" : look === "wrong" ? ". Your answer, incorrect" : "");
  const noteTitle = { fontSize: 15, lineHeight: "20px", fontWeight: 600 } as const;
  const noteText = { fontSize: 14, lineHeight: "20px", marginTop: 4, color: colors.foreground } as const;

  return (
    <div className="screen" style={{ gap: 14, maxWidth: 640 }}>
      <ExamTop onClose={() => goBack("practice")} label={questionCounter(currentIndex, total)} fraction={(currentIndex + 1) / total} />

      <div key={currentIndex} style={{ display: "flex", flexDirection: "column", gap: 14, padding: "6px 4px 0" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* An older save may carry no difficulty: then none is claimed. */}
          {DIFFICULTY_LABEL[question.difficulty] ? <Tag label={DIFFICULTY_LABEL[question.difficulty]} /> : null}
          <span className="clamp2" style={{ flex: 1, fontSize: 13, lineHeight: "18px", color: colors.muted }}>{questionMetaLine(question)}</span>
        </div>
        <AiContentLabel surface="practice exam" content={() => practiceQuestionExcerpt(question)} />
        <h1 style={{ margin: 0, fontSize: 19, lineHeight: "26px", fontWeight: 600, letterSpacing: -0.2, color: colors.foreground }}>{question.question}</h1>
        {truncation ? <p style={{ margin: 0, fontSize: 13, lineHeight: "18px", color: colors.gold }}>{truncation}</p> : null}

        {question.type === "multiple_choice" && Array.isArray(question.options) ? (
          <div role="radiogroup" aria-label="Answers" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {order.map((originalIndex, position) => {
              const text = optionDisplayText(question.options![originalIndex]!);
              const selected = answer?.selectedIndex === originalIndex;
              const look = choiceState(selected, gradeResponse(question, { selectedIndex: originalIndex }) === true);
              const letter = optionLabel(position);
              return (
                <ChoiceRow
                  key={originalIndex}
                  badge={letter}
                  text={text}
                  state={look}
                  selected={selected}
                  onPress={() => patch(currentIndex, { selectedIndex: originalIndex })}
                  disabled={submitted}
                  ariaLabel={`Option ${letter}: ${text}${spoken(look)}`}
                />
              );
            })}
          </div>
        ) : null}

        {question.type === "true_false" ? (
          <div role="radiogroup" aria-label="Answers" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {([true, false] as const).map((value) => {
              const selected = answer?.selectedBoolean === value;
              const look = choiceState(selected, gradeResponse(question, { selectedBoolean: value }) === true);
              const text = value ? "True" : "False";
              return (
                <ChoiceRow
                  key={text}
                  badge={value ? "T" : "F"}
                  text={text}
                  state={look}
                  selected={selected}
                  onPress={() => patch(currentIndex, { selectedBoolean: value })}
                  disabled={submitted}
                  ariaLabel={`${text}${spoken(look)}`}
                />
              );
            })}
          </div>
        ) : null}

        {question.type === "short_answer" ? (
          !answer?.revealed && !submitted ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <p style={{ margin: 0, fontSize: 14, lineHeight: "20px", color: colors.muted }}>{SHORT_ANSWER_COPY.hint}</p>
              <PrimaryButton label={SHORT_ANSWER_COPY.show} tone="ghost" size="lg" fullWidth onPress={() => patch(currentIndex, { revealed: true })} />
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ borderRadius: 14, border: `1px solid ${colors.borderStrong}`, background: colors.surface, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
                <SmallLabel>Model answer</SmallLabel>
                <FoldText strong>{question.answer}</FoldText>
                {question.explanation ? <FoldText>{question.explanation}</FoldText> : null}
              </div>
              {submitted ? (
                <p style={{ margin: 0, fontSize: 14, lineHeight: "20px", color: colors.muted }}>{selfMarkLine(answer?.selfRating)}</p>
              ) : (
                <div style={{ display: "flex", gap: 10 }}>
                  <PrimaryButton label={SHORT_ANSWER_COPY.missed} tone="ghost" size="lg" style={{ flex: 1 }} left={<Icon name="close" size={17} color={colors.error} strokeWidth={2.2} />} onPress={() => patch(currentIndex, { selfRating: "missed", submitted: true })} />
                  <PrimaryButton label={SHORT_ANSWER_COPY.gotIt} tone="ghost" size="lg" style={{ flex: 1 }} left={<Icon name="check" size={17} color={colors.success} strokeWidth={2.4} />} onPress={() => patch(currentIndex, { selfRating: "got_it", submitted: true })} />
                </div>
              )}
            </div>
          )
        ) : null}

        {!gradable && question.type !== "short_answer" ? (
          <Note tone="gold" icon="info">
            <div style={{ ...noteTitle, color: colors.gold }}>{NOT_SCORED_COPY.title}</div>
            <div style={noteText}>{NOT_SCORED_COPY.body}</div>
            {question.explanation ? <div style={noteText}>{question.explanation}</div> : null}
          </Note>
        ) : null}

        {result !== null ? (
          <Note tone={result ? "green" : "red"} icon={result ? "check" : "close"} role="alert">
            <div style={{ ...noteTitle, color: result ? colors.success : colors.error }}>{feedbackHeadline(question, result, order)}</div>
            {question.explanation ? <div style={noteText}>{question.explanation}</div> : null}
          </Note>
        ) : null}
      </div>

      <FlowFooter hint={step.reason} hintTone="gold">
        <div style={{ display: "flex", gap: 10 }}>
          <PrimaryButton
            label="Prev"
            tone="ghost"
            size="lg"
            left={<Icon name="chevronLeft" size={18} color={colors.foreground} strokeWidth={2} />}
            onPress={() => setCurrentIndex((i) => Math.max(0, i - 1))}
            disabled={currentIndex === 0}
            ariaLabel="Previous question"
          />
          <PrimaryButton label={step.label} size="lg" style={{ flex: 1 }} onPress={onMain} disabled={!step.enabled} />
        </div>
      </FlowFooter>
    </div>
  );
}

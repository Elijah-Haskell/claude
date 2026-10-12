// What a test review gives back (the mobile app's components/study/test-review-result.tsx). A graded test: how many
// mistakes there are to learn from (and the score, when the test shows one), the concepts to review, each marked
// mistake as a row that opens in place to the student's answer, the right one and why, and problems to practise with
// their answers. A test that is not graded yet, or pages that could not be read: said in a gold note, with the way to
// choose other photos. A review is not saved: "Review another test" asks first, in place. The words are
// src/engine/study-tools-view.ts.

import { useState } from "react";

import { mistakeTitle, NO_MISTAKES_BODY, notReviewedTitle, REVIEW_RESET_COPY, reviewCourseLabel, reviewExcerpt, reviewHeadline, reviewScoreLine, TEST_REVIEW_HEAD, type TestReviewResult } from "../engine/study-tools-view";
import { CourseChip, FieldGroup, Note, PrimaryButton, SectionLabel } from "../ui/primitives";
import { useColors } from "../ui/theme";
import { AiContentLabel } from "./ai-content-label";
import { Chips, ConfirmNote, FoldRow, FoldText, LeadText, MonoCount, SmallLabel, ToolHead, ToolLink } from "./study-parts";

function Answer({ label, text, strong }: { label: string; text: string; strong?: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <SmallLabel>{label}</SmallLabel>
      <FoldText strong={strong}>{text}</FoldText>
    </div>
  );
}

/** The question before "Review another test" erases this review, or the link that asks it. */
function ResetAsk({ asking, onAsk, onReset, onKeep }: { asking: boolean; onAsk: () => void; onReset: () => void; onKeep: () => void }) {
  if (asking) {
    return <ConfirmNote question={REVIEW_RESET_COPY.question} confirmLabel={REVIEW_RESET_COPY.confirm} cancelLabel={REVIEW_RESET_COPY.cancel} onConfirm={onReset} onCancel={onKeep} confirmAriaLabel="Start a new review" cancelAriaLabel="Keep this review" />;
  }
  return <ToolLink label={REVIEW_RESET_COPY.action} onPress={onAsk} style={{ alignSelf: "center" }} />;
}

interface Props {
  result: TestReviewResult;
  /** The student's class this test belongs to, when its name is one of theirs. */
  cls?: { label: string; color?: string };
  /** Where the question "Start a new review?" is being asked: under the top bar (the header button) or at the end (the link). */
  asking: "top" | "end" | null;
  onAsk: (where: "top" | "end") => void;
  onKeep: () => void;
  onReset: () => void;
  /** Back to the pages, with the photos still there. */
  onChooseDifferent: () => void;
}

export function TestReviewResultView({ result, cls, asking, onAsk, onKeep, onReset, onChooseDifferent }: Props) {
  const colors = useColors();
  const [openMistake, setOpenMistake] = useState<number | null>(null);
  const [openProblem, setOpenProblem] = useState<number | null>(null);
  const ai = { padding: "0 4px", marginTop: -6 } as const;

  if (result.gradedStatus !== "graded") {
    return (
      <>
        <ToolHead eyebrow={TEST_REVIEW_HEAD.eyebrow} title={TEST_REVIEW_HEAD.title} />
        <AiContentLabel surface="test review" content={() => reviewExcerpt(result)} style={ai} />
        <Note tone="gold" icon="warning" role="alert">
          <div style={{ fontSize: 16, lineHeight: "21px", fontWeight: 600, color: colors.foreground }}>{notReviewedTitle(result.gradedStatus)}</div>
          <div style={{ fontSize: 14, lineHeight: "20px", marginTop: 4, color: colors.foreground }}>{result.encouragement}</div>
        </Note>
        <PrimaryButton label="Choose different photos" size="lg" fullWidth onPress={onChooseDifferent} />
      </>
    );
  }

  const course = reviewCourseLabel(result.courseTitle);
  const score = reviewScoreLine(result.score);
  const mistakes = result.mistakes;
  const problems = result.practiceProblems;
  const concepts = result.conceptsToReview;
  const body = { margin: "8px 0 0", fontSize: 15, lineHeight: "21px" } as const;

  return (
    <>
      {asking === "top" ? <ResetAsk asking onAsk={() => onAsk("top")} onReset={onReset} onKeep={onKeep} /> : null}

      <ToolHead
        lead={
          <>
            {cls ? <CourseChip label={cls.label} color={cls.color} /> : null}
            <LeadText>{cls || !course ? "Test review" : `Test review · ${course}`}</LeadText>
          </>
        }
        title={reviewHeadline(mistakes.length)}
        sub={score}
      >
        {mistakes.length === 0 ? <p style={{ ...body, color: colors.muted }}>{NO_MISTAKES_BODY}</p> : null}
        {result.encouragement ? <p style={{ ...body, color: colors.foreground }}>{result.encouragement}</p> : null}
      </ToolHead>

      <AiContentLabel surface="test review" content={() => reviewExcerpt(result)} style={ai} />

      {concepts.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "0 4px" }}>
          <SmallLabel>Concepts to review</SmallLabel>
          <Chips items={concepts} />
        </div>
      ) : null}

      {mistakes.length > 0 ? (
        <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <SectionLabel title="Mistakes" right={<MonoCount>{mistakes.length}</MonoCount>} />
          <FieldGroup>
            {mistakes.map((mistake, index) => {
              const title = mistakeTitle(mistake.questionNumber);
              return (
                <FoldRow
                  key={index}
                  open={openMistake === index}
                  onToggle={() => setOpenMistake(openMistake === index ? null : index)}
                  title={title}
                  sub={mistake.concept || null}
                  ariaLabel={`${title}${mistake.concept ? `: ${mistake.concept}` : ""}`}
                >
                  {mistake.studentAnswer ? <Answer label="Your answer" text={mistake.studentAnswer} /> : null}
                  {mistake.correctAnswer ? <Answer label="Correct" text={mistake.correctAnswer} strong /> : null}
                  {mistake.explanation ? <FoldText>{mistake.explanation}</FoldText> : null}
                </FoldRow>
              );
            })}
          </FieldGroup>
        </section>
      ) : null}

      {problems.length > 0 ? (
        <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <SectionLabel title="Practice problems" right={<MonoCount>{problems.length}</MonoCount>} />
          <FieldGroup>
            {problems.map((problem, index) => (
              <FoldRow
                key={index}
                open={openProblem === index}
                onToggle={() => setOpenProblem(openProblem === index ? null : index)}
                title={problem.question}
                sub={problem.concept || null}
                ariaLabel={`Practice problem ${index + 1}: ${problem.question}`}
              >
                <Answer label="Answer" text={problem.answer} strong />
              </FoldRow>
            ))}
          </FieldGroup>
        </section>
      ) : null}

      <ResetAsk asking={asking === "end"} onAsk={() => onAsk("end")} onReset={onReset} onKeep={onKeep} />
    </>
  );
}

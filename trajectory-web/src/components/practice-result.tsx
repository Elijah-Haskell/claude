// The end of a practice exam (the mobile app's components/study/practice-result.tsx): the count first ("11 of 15
// correct"), the percentage and letter under it with a thin bar, where the points went, and every question as a row
// that opens in place to what was answered, what is right and why. "Retake" starts again with the answers in a new
// order; "Done" goes back to where the exam was opened. The numbers are src/engine/practice-exam-scoring.ts; the
// words are src/engine/study-tools-view.ts.

import { useState } from "react";

import { scoreExam, type QuestionResponse } from "../engine/practice-exam-scoring";
import { savedTruncationNotice } from "../engine/study-text";
import { examResultView, practiceQuestionExcerpt, reviewDetail, reviewTitle, statusTag } from "../engine/study-tools-view";
import type { SyllabusPracticeExam } from "../engine/types";
import { useDesktop, useWideLayout } from "../ui/layout";
import { FieldGroup, MONO_FONT, PrimaryButton, SectionLabel } from "../ui/primitives";
import { useColors } from "../ui/theme";
import { AiContentLabel } from "./ai-content-label";
import { FlowFooter, FoldRow, FoldText, MonoCount, SmallLabel, Tag, ThinBar, ToolHead, ToolTop } from "./study-parts";

function Answer({ label, text, strong }: { label: string; text: string; strong?: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <SmallLabel>{label}</SmallLabel>
      <FoldText strong={strong}>{text}</FoldText>
    </div>
  );
}

export function PracticeResult({ exam, answers, orderOf, onRetake, onDone }: {
  exam: SyllabusPracticeExam;
  answers: Record<number, QuestionResponse | undefined>;
  /** The order a question's options were drawn in (letters in the review are the letters the student saw). */
  orderOf: (index: number) => number[];
  onRetake: () => void;
  onDone: () => void;
}) {
  const colors = useColors();
  const desktop = useDesktop();
  const wide = useWideLayout();
  const [open, setOpen] = useState<number[]>([]);
  const score = scoreExam(exam.questions, answers);
  const view = examResultView(score);
  const truncation = savedTruncationNotice({ sourceTruncated: exam.sourceTruncated });
  const toggle = (index: number) => setOpen((current) => (current.includes(index) ? current.filter((i) => i !== index) : [...current, index]));
  const under = { margin: "-6px 0 0", padding: "0 4px", fontSize: 13, lineHeight: "18px" } as const;

  const head = (
    <>
      <ToolTop onBack={onDone} backLabel="Close" />
      <ToolHead eyebrow={`Practice exam · ${exam.courseTitle}`} title={view.headline} sub={view.sub}>
        {view.fraction !== null ? <ThinBar fraction={view.fraction} style={{ marginTop: 12, maxWidth: desktop ? 520 : undefined }} /> : null}
      </ToolHead>
      <AiContentLabel surface="practice exam" content={() => exam.questions.slice(0, 5).map(practiceQuestionExcerpt).join("\n\n")} style={{ padding: "0 4px", marginTop: -6 }} />
    </>
  );

  const scoreRows = view.rows.length > 0 ? (
    <FieldGroup>
      {view.rows.map((row) => (
        <div key={row.title} aria-label={`${row.title}: ${row.value}`} style={{ display: "flex", alignItems: "center", gap: 12, minHeight: 50, padding: "10px 14px" }}>
          <span style={{ flex: 1, fontSize: 16, lineHeight: "21px", fontWeight: 500, color: colors.foreground }}>{row.title}</span>
          <span style={{ fontFamily: MONO_FONT, fontSize: 15, lineHeight: "20px", fontWeight: 600, color: colors.foreground }}>{row.value}</span>
        </div>
      ))}
    </FieldGroup>
  ) : null;
  const notes = (
    <>
      {view.notScored ? <p style={{ ...under, color: colors.muted }}>{view.notScored}</p> : null}
      {truncation ? <p style={{ ...under, color: colors.gold }}>{truncation}</p> : null}
    </>
  );

  const review = (
    <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <SectionLabel title="Question review" right={<MonoCount>{exam.questions.length}</MonoCount>} />
      <FieldGroup>
        {exam.questions.map((question, index) => {
          const status = score.perQuestion[index]!.status;
          const tag = statusTag(status);
          const detail = reviewDetail(question, answers[index], orderOf(index), status);
          const title = reviewTitle(question);
          return (
            <FoldRow
              key={index}
              open={open.includes(index)}
              onToggle={() => toggle(index)}
              lead={<span style={{ fontFamily: MONO_FONT, fontSize: 13, lineHeight: "18px", fontWeight: 600, width: 22, flexShrink: 0, color: colors.muted }}>{index + 1}</span>}
              title={title}
              right={<Tag label={tag.label} tone={tag.tone} />}
              ariaLabel={`Question ${index + 1}: ${title}. ${tag.label}`}
            >
              <FoldText strong>{question.question}</FoldText>
              {detail.yourAnswer ? <Answer label="Your answer" text={detail.yourAnswer} /> : null}
              {detail.correct ? <Answer label="Correct" text={detail.correct} strong /> : null}
              {detail.modelAnswer ? <Answer label="Model answer" text={detail.modelAnswer} strong /> : null}
              {detail.explanation ? <FoldText>{detail.explanation}</FoldText> : null}
            </FoldRow>
          );
        })}
      </FieldGroup>
    </section>
  );

  const buttons = (
    <div style={{ display: "flex", gap: 10 }}>
      <PrimaryButton label="Retake" tone="ghost" size="lg" style={{ flex: 1 }} onPress={onRetake} ariaLabel="Retake the practice exam" />
      {/* Opened from the study guide, the practice list or the Study tab: back to wherever that was. */}
      <PrimaryButton label="Done" size="lg" style={{ flex: 1 }} onPress={onDone} ariaLabel="Done, go back" />
    </div>
  );

  // A wide computer screen: the review in the main column, the score and the two buttons in the rail beside it.
  if (desktop && wide) {
    return (
      <div className="screen full" style={{ gap: 18 }}>
        {head}
        <div className="split" style={{ marginTop: 6 }}>
          <div className="split-main">{review}</div>
          <aside className="split-rail">
            {scoreRows}
            {notes}
            {buttons}
          </aside>
        </div>
      </div>
    );
  }

  return (
    <div className={desktop ? "screen medium" : "screen"} style={{ gap: 16, maxWidth: desktop ? 760 : 640 }}>
      {head}
      {scoreRows}
      {notes}
      {review}
      <FlowFooter>{buttons}</FlowFooter>
    </div>
  );
}

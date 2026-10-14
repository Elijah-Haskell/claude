// Test review, one of the study tools (opened from the Study tab). The student adds photos of a GRADED test or quiz;
// the review explains each marked mistake and writes problems to practise. A test that has not been graded is not
// answered. The mobile app's app/test-review.tsx, with a file picker where the iPhone has its camera and photo library.
//
// Every photo is checked against the server's upload rules (type, 10 MB) before it is uploaded; a failed upload or a
// failed review never throws away the student's photos, class or question. The main button stays off, with the reason
// over it, until there is a page that uploaded. What comes back is src/components/test-review-result.tsx.
// Pro only. What the screen says is src/engine/study-tools-view.ts.

import { useEffect, useRef, useState } from "react";

import { MAX_REVIEW_IMAGES } from "../engine/study-images";
import { classByName, EXTRA_PAGES_NOTICE, GRADED_ONLY_NOTE, pageOptionLines, pagesCountLabel, questionCountLine, REVIEW_QUESTION_EXAMPLE, REVIEW_QUESTION_MAX, reviewClassValue, reviewQuestionDetail, reviewStep, TEST_REVIEW_HEAD, type TestReviewResult } from "../engine/study-tools-view";
import { generateId } from "../engine/utils";
import { classShortName } from "../engine/week-layout";
import { readPickedImage, reviewTest, uploadReviewImage } from "../lib/study-api";
import { describeStudyError, type StudyErrorInfo } from "../lib/study-errors";
import { goBack } from "../router";
import { useApp } from "../state/app-provider";
import { BigOption, FlowFooter, MonoCount, ToolError, ToolHead, ToolIconButton, ToolTop } from "../components/study-parts";
import { useRedirectToPaywallIfNotPro } from "../state/use-pro-gate";
import { ReviewPages, type ReviewPage } from "../components/test-review-pages";
import { TestReviewResultView } from "../components/test-review-result";
import { ReviewTextSheet } from "../components/test-review-text-sheet";
import { alpha } from "../engine/design";
import { Icon } from "../ui/icon";
import { useDesktop, useWideLayout } from "../ui/layout";
import { FieldGroup, FieldPickRow, Note, PrimaryButton, SectionLabel } from "../ui/primitives";
import { useColors } from "../ui/theme";

/** What the picker offers: the image types the server takes. */
const IMAGE_TYPES = "image/jpeg,image/png,image/webp";

export function TestReviewScreen() {
  const colors = useColors();
  const { state } = useApp();
  const desktop = useDesktop();
  const wide = useWideLayout();
  const [dragging, setDragging] = useState(false);

  // Photos are uploaded and reviewed by the AI: Pro only (waits until it is known whether there is Pro).
  useRedirectToPaywallIfNotPro();

  const [pages, setPages] = useState<ReviewPage[]>([]);
  const [courseName, setCourseName] = useState("");
  const [userQuestion, setUserQuestion] = useState("");
  const [result, setResult] = useState<TestReviewResult | null>(null);
  const [notices, setNotices] = useState<string[]>([]);
  const [reviewError, setReviewError] = useState<StudyErrorInfo | null>(null);
  const [isReviewing, setIsReviewing] = useState(false);
  const [sheet, setSheet] = useState<"class" | "question" | null>(null);
  const [asking, setAsking] = useState<"top" | "end" | null>(null);
  const reviewing = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // The thumbnails are object URLs of the picked files: freed when a page goes, and when the screen does.
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  useEffect(() => () => pagesRef.current.forEach((page) => URL.revokeObjectURL(page.uri)), []);

  // The pages and what came back are two different lists: each starts at its top.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [result]);

  const isUploading = pages.some((page) => page.status === "uploading");
  const readyUrls = pages.flatMap((page) => (page.status === "ready" && page.url ? [page.url] : []));
  const hasFailed = pages.some((page) => page.status === "failed");
  const slotsLeft = Math.max(0, MAX_REVIEW_IMAGES - pages.length);
  const pickDisabled = isUploading || isReviewing || slotsLeft === 0;
  const lines = pageOptionLines(slotsLeft);
  const step = reviewStep({ pages: pages.length, ready: readyUrls.length, uploading: isUploading, failed: hasFailed, reviewing: isReviewing });

  function updatePage(id: string, patch: Partial<ReviewPage>) {
    setPages((prev) => prev.map((page) => (page.id === id ? { ...page, ...patch } : page)));
  }

  function removePage(id: string) {
    setPages((prev) => {
      const gone = prev.find((page) => page.id === id);
      if (gone) URL.revokeObjectURL(gone.uri);
      return prev.filter((page) => page.id !== id);
    });
  }

  async function uploadPage(page: ReviewPage) {
    if (!page.base64 || !page.mimeType) return;
    updatePage(page.id, { status: "uploading", error: undefined });
    try {
      const { url } = await uploadReviewImage({ base64: page.base64, mimeType: page.mimeType });
      updatePage(page.id, { status: "ready", url, base64: undefined, error: undefined });
    } catch (error) {
      updatePage(page.id, { status: "failed", error: describeStudyError(error, "upload that photo").message });
    }
  }

  /** Checks each picked photo against the server's rules, then uploads the good ones one by one. */
  async function addFiles(files: readonly File[]) {
    const notes: string[] = [];
    const room = Math.max(0, MAX_REVIEW_IMAGES - pagesRef.current.length);
    const accepted: ReviewPage[] = [];
    for (const file of files) {
      if (accepted.length >= room) {
        notes.push(EXTRA_PAGES_NOTICE);
        break;
      }
      const picked = await readPickedImage(file);
      if (!picked.ok) {
        notes.push(picked.message);
        continue;
      }
      accepted.push({ id: generateId(), uri: URL.createObjectURL(file), status: "uploading", base64: picked.base64, mimeType: picked.mimeType });
    }
    setNotices(notes);
    if (accepted.length === 0) return;
    setPages((prev) => [...prev, ...accepted]);
    setReviewError(null);
    for (const page of accepted) await uploadPage(page);
  }

  function pickImages() {
    if (pickDisabled) return;
    fileInput.current?.click();
  }

  async function review() {
    if (reviewing.current || readyUrls.length === 0 || isUploading) return;
    reviewing.current = true;
    setIsReviewing(true);
    setReviewError(null);
    try {
      const reply = await reviewTest({
        imageUrls: readyUrls,
        courseName: courseName.trim() || undefined,
        userQuestion: userQuestion.trim() || undefined,
      });
      setResult(reply);
    } catch (error) {
      // Photos, class and question stay put; the note offers "Try again".
      setReviewError(describeStudyError(error, "review the test"));
    } finally {
      reviewing.current = false;
      setIsReviewing(false);
    }
  }

  function reset() {
    pagesRef.current.forEach((page) => URL.revokeObjectURL(page.uri));
    setPages([]);
    setCourseName("");
    setUserQuestion("");
    setResult(null);
    setNotices([]);
    setReviewError(null);
    setAsking(null);
  }

  /** "Review another test": a written review is not saved, so it asks first; with no review there is nothing to lose. */
  function askReset(where: "top" | "end") {
    if (result?.gradedStatus !== "graded") {
      reset();
      return;
    }
    setAsking(where);
    // Asked from the header, the question is drawn at the top: bring it into view.
    if (where === "top") window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const cls = result ? classByName(courseName, state.classes) ?? classByName(result.courseTitle, state.classes) : undefined;
  const failedPages = pages.filter((page) => page.status === "failed" && page.error);
  const line = { margin: 0, padding: "0 2px", fontSize: 13, lineHeight: "18px" } as const;

  const fileField = (
    <input
      ref={fileInput}
      type="file"
      accept={IMAGE_TYPES}
      multiple
      style={{ display: "none" }}
      aria-hidden
      tabIndex={-1}
      onChange={(event) => {
        const files = Array.from(event.target.files ?? []);
        event.target.value = "";
        if (files.length > 0) void addFiles(files);
      }}
    />
  );

  /** On a computer: "Choose photos" as a large dashed area that also takes photos dropped on it. */
  const dropArea = (
    <button
      type="button"
      onClick={pickImages}
      disabled={pickDisabled}
      aria-label={`Choose photos. ${lines.photos}`}
      aria-busy={isUploading || undefined}
      className="pressable"
      onDragOver={(event) => {
        if (pickDisabled) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (pickDisabled) return;
        const files = Array.from(event.dataTransfer.files ?? []);
        if (files.length > 0) void addFiles(files);
      }}
      style={{ width: "100%", minHeight: pages.length > 0 ? 150 : 230, borderRadius: 20, border: `1.5px dashed ${dragging ? colors.accent : colors.borderStrong}`, background: dragging ? alpha(colors.primary, 0.12) : alpha(colors.surface, 0.6), display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 24, textAlign: "center", opacity: pickDisabled && !isUploading ? 0.55 : 1, transition: "border-color 120ms ease, background 120ms ease" }}
    >
      <span style={{ width: 56, height: 56, borderRadius: 16, display: "inline-flex", alignItems: "center", justifyContent: "center", background: alpha(colors.primary, 0.18) }}>
        {isUploading ? <span className="spinner" /> : <Icon name="image" size={26} color={colors.peri} />}
      </span>
      <span>
        <span style={{ display: "block", fontSize: 18, lineHeight: "24px", fontWeight: 600, color: colors.foreground }}>Choose photos</span>
        <span style={{ display: "block", marginTop: 4, fontSize: 13.5, lineHeight: "19px", color: colors.muted }}>{lines.photos}</span>
      </span>
    </button>
  );

  const pagesSection = (
    <section style={{ display: "flex", flexDirection: "column", gap: desktop ? 12 : 10 }}>
      <SectionLabel title="Pages" right={<MonoCount>{pagesCountLabel(pages.length)}</MonoCount>} />
      {pages.length > 0 ? <ReviewPages pages={pages} onRemove={removePage} onRetry={(page) => void uploadPage(page)} /> : null}
      {failedPages.map((page) => (
        <p key={page.id} role="alert" style={{ ...line, color: colors.error }}>{page.error}</p>
      ))}
      {notices.map((notice, index) => (
        <p key={index} role="alert" style={{ ...line, color: colors.gold }}>{notice}</p>
      ))}
      {/* The iPhone has its camera here; this browser has the file picker (a phone's offers its camera too). */}
      {desktop ? dropArea : <BigOption icon="image" title="Choose photos" sub={lines.photos} onPress={pickImages} disabled={pickDisabled} busy={isUploading} ariaLabel={`Choose photos. ${lines.photos}`} />}
      {fileField}
      <Note tone="plain">{GRADED_ONLY_NOTE}</Note>
    </section>
  );

  const optionalSection = (
    <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <SectionLabel title="Optional" />
      <FieldGroup>
        <FieldPickRow icon="book" label="Class" value={reviewClassValue(courseName)} onPress={() => setSheet("class")} ariaLabel={`Class, optional: ${reviewClassValue(courseName)}`} />
        <FieldPickRow icon="text" label="Ask about your test" detail={reviewQuestionDetail(userQuestion)} onPress={() => setSheet("question")} />
      </FieldGroup>
    </section>
  );

  const reviewErrorNote = reviewError ? <ToolError info={reviewError} onRetry={() => void review()} onDismiss={() => setReviewError(null)} /> : undefined;
  const reviewButton = <PrimaryButton size="lg" fullWidth label={step.label} loading={step.busy} disabled={!step.enabled} onPress={() => void review()} ariaLabel="Review my test" />;
  const top = <ToolTop onBack={() => goBack("study")} right={result ? <ToolIconButton icon="refresh" onPress={() => askReset("top")} ariaLabel="Review another test" /> : undefined} />;
  const resultView = result ? (
    <TestReviewResultView
      result={result}
      cls={cls ? { label: classShortName(cls), color: cls.color } : undefined}
      asking={asking}
      onAsk={askReset}
      onKeep={() => setAsking(null)}
      onReset={reset}
      onChooseDifferent={() => setResult(null)}
    />
  ) : null;

  const sheets = (
    <>
      <ReviewTextSheet
        open={sheet === "class"}
        title="Class"
        label="Class · optional"
        value={courseName}
        onChange={setCourseName}
        onClose={() => setSheet(null)}
        placeholder="e.g. Organic Chemistry"
        maxLength={100}
        ariaLabel="Class, optional"
        suggestions={state.classes.map((candidate) => candidate.name)}
        suggestionsLabel="Your classes"
      />
      <ReviewTextSheet
        open={sheet === "question"}
        title="Ask about your test"
        label="Your question · optional"
        value={userQuestion}
        onChange={setUserQuestion}
        onClose={() => setSheet(null)}
        placeholder={`e.g. ${REVIEW_QUESTION_EXAMPLE}`}
        maxLength={REVIEW_QUESTION_MAX}
        ariaLabel="Ask about your graded test, optional"
        multiline
        countLine={questionCountLine(userQuestion.length)}
      />
    </>
  );

  // A wide computer screen: the pages in the main column, the optional details and the main button in the rail.
  if (desktop && wide && !result) {
    return (
      <div className="screen full" style={{ gap: 20 }}>
        {top}
        <ToolHead eyebrow={TEST_REVIEW_HEAD.eyebrow} title={TEST_REVIEW_HEAD.title} sub={TEST_REVIEW_HEAD.sub} />
        <div className="split" style={{ marginTop: 6 }}>
          <div className="split-main">{pagesSection}</div>
          <aside className="split-rail">
            {optionalSection}
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 4 }}>
              {reviewErrorNote}
              {step.reason ? (
                <p role={step.reasonTone === "quiet" ? undefined : "alert"} style={{ margin: 0, fontSize: 13.5, lineHeight: "18px", textAlign: "center", color: step.reasonTone === "quiet" ? colors.muted : step.reasonTone === "gold" ? colors.gold : colors.error, fontWeight: step.reasonTone === "quiet" ? 400 : 600 }}>{step.reason}</p>
              ) : null}
              {reviewButton}
            </div>
          </aside>
        </div>
        {sheets}
      </div>
    );
  }

  return (
    <div className={desktop ? (result && wide ? "screen full" : "screen medium") : "screen"} style={{ gap: 16, maxWidth: desktop ? undefined : 640 }}>
      {top}

      {result ? (
        resultView
      ) : (
        <>
          <ToolHead eyebrow={TEST_REVIEW_HEAD.eyebrow} title={TEST_REVIEW_HEAD.title} sub={TEST_REVIEW_HEAD.sub} />
          {pagesSection}
          {optionalSection}
        </>
      )}

      {result ? null : (
        // A failure is said over the button that failed (the footer is always on screen).
        <FlowFooter hint={step.reason} hintTone={step.reasonTone} above={reviewErrorNote}>
          {reviewButton}
        </FlowFooter>
      )}

      {sheets}
    </div>
  );
}

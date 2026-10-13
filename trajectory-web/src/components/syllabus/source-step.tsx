// Step 1 - add the syllabus: one headline and two big buttons (a file, photos), with pasting the text as a link under
// them. Photos lead to the page list ("scan"); the link to the text box ("paste"). The browser has no camera step:
// its file pickers stand in for the iPhone's camera (a phone's browser offers the camera from the picker itself).
// A failure is shown here in words, with the way forward as its buttons; nothing picked is lost to it.

import { useRef, useState, type CSSProperties, type ReactNode } from "react";

import { alpha } from "../../engine/design";
import { PASTE_PICTURE_NOTE, type IntakeFailure } from "../../engine/syllabus-messages";
import { FILE_ACCEPT, PHOTO_ACCEPT, type ExtractionSource, type LocalFile, type ScannedPage } from "../../lib/syllabus-source";
import { Icon } from "../../ui/icon";
import { FieldLabel, MONO_FONT, Note, PrimaryButton } from "../../ui/primitives";
import { useColors } from "../../ui/theme";
import { BigOption, FlowFooter, FlowTitle, TextLink } from "./shared";

export type SourceMode = "pick" | "paste" | "scan";

/** Pages that have been picked are always shown as the page list. */
export function effectiveSourceMode(mode: SourceMode, pages: number): SourceMode {
  return mode === "pick" && pages > 0 ? "scan" : mode;
}

interface Props {
  mode: SourceMode;
  onMode: (mode: SourceMode) => void;
  /** The line under "Add your syllabus". */
  lead: string;
  isBusy: boolean;
  failure: IntakeFailure | null;
  /** The last input that failed, so "Try again" can re-run it. */
  canRetryLast: boolean;
  onRetry: () => void;
  onDismissFailure: () => void;
  /** Shown with a failure that the paywall resolves (the free syllabus is used). */
  onOpenPaywall: () => void;
  onFilePicked: (file: File | undefined) => void;
  onPhotosPicked: (files: File[]) => void;
  /** A picked file that has not been read yet (a failed upload or a failed reading). */
  pendingFile: LocalFile | null;
  onContinuePending: () => void;
  onRemovePending: () => void;
  scannedPages: ScannedPage[];
  onRemovePage: (index: number) => void;
  onSubmitScan: () => void;
  onSubmit: (source: ExtractionSource) => void;
  /** The class the syllabus is for, as a hint for the reader (optional). */
  courseHint: string;
  onCourseHint: (value: string) => void;
  /** Where the syllabus is read. */
  note?: string;
}

const FILE_HELP = "PDF, Word (.docx), image or .txt. A PDF is read as a picture too, so schedules saved as images work. Word files and pasted text only carry their text.";

export function SourceStep(props: Props) {
  const colors = useColors();
  const [pasted, setPasted] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const { failure, isBusy } = props;
  const pages = props.scannedPages;
  const mode = effectiveSourceMode(props.mode, pages.length);

  const box = (border: string, background: string, style?: CSSProperties): CSSProperties => ({ display: "flex", flexDirection: "column", gap: 12, padding: 14, borderRadius: 14, border: `1px solid ${border}`, background, ...style });
  const quiet = (label: string, onClick: () => void, ariaLabel?: string, disabled?: boolean) => (
    <button type="button" className="link" onClick={onClick} disabled={disabled} aria-label={ariaLabel ?? label} style={{ minHeight: 44, padding: "0 12px", fontSize: 14, fontWeight: 600, color: colors.muted }}>
      {label}
    </button>
  );

  const failureCard = (style?: CSSProperties) =>
    failure ? (
      <div role="alert" style={box(alpha(colors.error, 0.45), alpha(colors.error, 0.08), style)}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
          <Icon name="warning" size={20} color={colors.error} style={{ marginTop: 1 }} />
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 3 }}>
            <span style={{ fontSize: 16, lineHeight: "21px", fontWeight: 600, color: colors.foreground }}>{failure.title}</span>
            <span style={{ fontSize: 14, lineHeight: "20px", color: colors.muted }}>{failure.message}</span>
          </div>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          {failure.openPaywall ? <PrimaryButton size="sm" label="See plans" onPress={props.onOpenPaywall} ariaLabel="See Trajectory Pro plans" /> : null}
          {failure.offerPaste ? (
            <PrimaryButton
              size="sm"
              label="Paste the text instead"
              onPress={() => {
                props.onDismissFailure();
                props.onMode("paste");
              }}
              ariaLabel="Paste the text instead"
            />
          ) : null}
          {failure.canRetry && props.canRetryLast ? <PrimaryButton size="sm" tone="ghost" label="Try again" onPress={props.onRetry} ariaLabel="Try again" /> : null}
          {quiet("Dismiss", props.onDismissFailure)}
        </div>
      </div>
    ) : null;

  // A picked file that still needs reading: one click sends it again, nothing has to be picked twice.
  const pendingCard = props.pendingFile ? (
    <div style={box(colors.borderStrong, colors.surface)}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <Icon name="file" size={20} color={colors.peri} style={{ marginTop: 1 }} />
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
          <span className="truncate" style={{ fontSize: 16, lineHeight: "21px", fontWeight: 600, color: colors.foreground }}>{props.pendingFile.name}</span>
          <span style={{ fontSize: 14, lineHeight: "20px", color: colors.muted }}>{props.pendingFile.file ? "Picked, but not read yet. Continue to read it." : "Picked before the page was reloaded. Choose it again to read it."}</span>
        </div>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        {props.pendingFile.file ? (
          <PrimaryButton size="sm" label="Continue" onPress={props.onContinuePending} disabled={isBusy} loading={isBusy} ariaLabel={`Continue with ${props.pendingFile.name}`} />
        ) : (
          <PrimaryButton size="sm" label="Choose the file again" onPress={() => fileInput.current?.click()} disabled={isBusy} ariaLabel="Choose the file again" />
        )}
        {quiet("Remove", props.onRemovePending, "Remove the picked file", isBusy)}
      </div>
    </div>
  ) : null;

  const courseField = (
    <div>
      <FieldLabel>Which class is it for? · optional</FieldLabel>
      <input className="input" value={props.courseHint} onChange={(e) => props.onCourseHint(e.target.value)} placeholder="Principles of Finance" maxLength={300} aria-label="Course name, optional" disabled={isBusy} />
    </div>
  );

  // The pickers: hidden inputs the big buttons click. The value is cleared after each pick so the same file can be picked again.
  const pickers: ReactNode = (
    <>
      <input
        ref={fileInput}
        type="file"
        accept={FILE_ACCEPT}
        style={{ display: "none" }}
        aria-hidden
        tabIndex={-1}
        onChange={(e) => {
          props.onFilePicked(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <input
        ref={photoInput}
        type="file"
        accept={PHOTO_ACCEPT}
        multiple
        style={{ display: "none" }}
        aria-hidden
        tabIndex={-1}
        onChange={(e) => {
          props.onPhotosPicked(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
    </>
  );

  // ── Paste ────────────────────────────────────────────────
  if (mode === "paste") {
    return (
      <>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <FlowTitle title="Paste the text" sub={PASTE_PICTURE_NOTE} />
          {failureCard()}
          <div style={{ borderRadius: 16, border: `1px solid ${colors.borderStrong}`, background: colors.panel, overflow: "hidden" }}>
            <textarea
              className="input"
              value={pasted}
              onChange={(e) => setPasted(e.target.value.slice(0, 200_000))}
              placeholder="Paste your whole syllabus here, including the schedule and the grading section."
              maxLength={200_000}
              rows={12}
              aria-label="Syllabus text"
              disabled={isBusy}
              style={{ display: "block", width: "100%", minHeight: 260, padding: 16, fontSize: 16, lineHeight: "23px", border: "none", borderRadius: 0, background: "transparent", resize: "vertical" }}
            />
            <div style={{ fontFamily: MONO_FONT, fontSize: 12, fontWeight: 500, padding: "0 16px 10px", textAlign: "right", color: colors.muted }}>{pasted.length.toLocaleString("en-US")} characters</div>
          </div>
          {courseField}
        </div>
        <FlowFooter>
          <PrimaryButton size="lg" fullWidth label="Read it" onPress={() => props.onSubmit({ kind: "paste", input: { rawText: pasted } })} disabled={isBusy || !pasted.trim()} loading={isBusy} ariaLabel="Read the pasted syllabus" />
        </FlowFooter>
        {pickers}
      </>
    );
  }

  // ── Scan: the pages ──────────────────────────────────────
  if (mode === "scan") {
    const pageWord = `${pages.length} page${pages.length !== 1 ? "s" : ""}`;
    const thumb: CSSProperties = { position: "relative", aspectRatio: "0.75", borderRadius: 12, border: `1px solid ${colors.borderStrong}`, background: colors.surface, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, overflow: "hidden" };
    const thumbLabel: CSSProperties = { fontFamily: MONO_FONT, fontSize: 12, fontWeight: 600, letterSpacing: 1, textTransform: "uppercase", color: colors.muted };
    return (
      <>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <FlowTitle title="Your pages" sub={`${pageWord} so far. Add every page of the syllabus, then read them together.`} />
          {failureCard()}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 12 }}>
            {pages.map((page, index) => (
              <div key={page.uri} style={thumb}>
                {page.file ? (
                  <img src={page.uri} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity: 0.85 }} />
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 7, width: "70%" }}>
                    {[88, 100, 72, 94, 60].map((w, i) => (
                      <span key={i} style={{ height: 4, width: `${w}%`, borderRadius: 2, background: alpha(colors.muted, 0.25) }} />
                    ))}
                  </div>
                )}
                <span style={{ ...thumbLabel, position: "absolute", left: 10, bottom: 10, padding: "3px 7px", borderRadius: 6, background: alpha(colors.panel, 0.9) }}>Page {index + 1}</span>
                {page.url === null ? <span style={{ ...thumbLabel, position: "absolute", right: 10, bottom: 10, padding: "3px 7px", borderRadius: 6, background: alpha(colors.panel, 0.9), color: colors.gold }}>Not sent yet</span> : null}
                <button type="button" className="pressable" onClick={() => props.onRemovePage(index)} aria-label={`Remove page ${index + 1}`} style={{ position: "absolute", top: 8, right: 8, width: 30, height: 30, borderRadius: 9, display: "inline-flex", alignItems: "center", justifyContent: "center", border: `1px solid ${alpha(colors.error, 0.6)}`, background: colors.panel }}>
                  <Icon name="close" size={15} color={colors.error} strokeWidth={2.2} />
                </button>
              </div>
            ))}
            <button type="button" className="pressable" onClick={() => photoInput.current?.click()} disabled={isBusy} aria-label="Add pages from photos" style={{ ...thumb, border: `1.5px dashed ${alpha(colors.peri, 0.55)}`, background: "transparent" }}>
              {isBusy ? <span className="spinner" /> : <Icon name="image" size={26} color={colors.peri} />}
              <span style={{ fontSize: 15, fontWeight: 600, color: colors.peri }}>Photos</span>
            </button>
          </div>
        </div>
        <FlowFooter>
          <PrimaryButton size="lg" fullWidth label={`Read ${pageWord}`} onPress={props.onSubmitScan} disabled={pages.length === 0 || isBusy} loading={isBusy} />
        </FlowFooter>
        {pickers}
      </>
    );
  }

  // ── Pick: one headline, two big buttons ──────────────────
  return (
    <>
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <FlowTitle title="Add your syllabus" sub={props.lead} />

        {failureCard()}
        {pendingCard}

        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 4 }}>
          <BigOption icon="file" title="Choose a file" sub="PDF or Word" onPress={() => fileInput.current?.click()} disabled={isBusy} busy={isBusy} ariaLabel="Choose a PDF or Word file" hint={FILE_HELP} />
          <BigOption icon="image" title="Choose photos" sub="Screenshots or pictures of the pages" onPress={() => photoInput.current?.click()} disabled={isBusy} ariaLabel="Choose photos of the pages" />
        </div>

        <TextLink label="Paste the text instead" onPress={() => props.onMode("paste")} style={{ alignSelf: "center", marginTop: -8 }} />

        {courseField}

        {props.note ? <Note tone="plain" icon="shield">{props.note}</Note> : null}
      </div>
      {pickers}
    </>
  );
}

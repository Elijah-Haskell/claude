// "New study guide": the sheet that builds one, from a syllabus the student has already added or from text they
// paste (the mobile app's components/study/study-guide-new-sheet.tsx). It is not a second upload: the one syllabus
// import is src/screens/syllabus.tsx. What is missing is said in words over the button; a failure is said in the sheet
// and nothing typed or chosen is lost to it. While the guide is being built the sheet stays (the wait is 15 to 30
// seconds, and the guide opens when it is done).

import { useEffect, useMemo, useRef, useState } from "react";

import { guideCourseName, sortGuidesNewestFirst, studyGuideFromAnalysis } from "../engine/study-guides";
import { buildImportSource, buildPastedSource, listStudySources } from "../engine/study-source";
import { prepareStudyText } from "../engine/study-text";
import { chosenSourceId, guideBuildBlocker, GUIDE_SHEET_COPY, noSyllabusCopy, pastedCountLine, sourceRows, type GuideMode } from "../engine/study-tools-view";
import { generateId } from "../engine/utils";
import { analyzeSyllabus } from "../lib/study-api";
import { describeStudyError, type StudyErrorInfo } from "../lib/study-errors";
import { useApp } from "../state/app-provider";
import { Icon } from "../ui/icon";
import { FieldGroup, FieldLabel, FieldPickRow, MONO_FONT, Note, PrimaryButton, Segmented } from "../ui/primitives";
import { Sheet, SheetBody, SheetHead } from "../ui/sheet";
import { useColors } from "../ui/theme";
import { ToolError } from "./study-parts";

interface Props {
  open: boolean;
  onClose: () => void;
  /** A guide was built and saved: the caller closes the sheet and opens it. */
  onBuilt: (guideId: string) => void;
  /** "You already have a study guide from this syllabus": open that one. */
  onOpenGuide: (guideId: string) => void;
  /** "Upload your syllabus": the caller checks the plan's limit and opens the import. */
  onUpload: () => void;
}

export function StudyGuideNewSheet({ open, onClose, onBuilt, onOpenGuide, onUpload }: Props) {
  const colors = useColors();
  const { state, dispatch } = useApp();

  const [mode, setMode] = useState<GuideMode | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [courseName, setCourseName] = useState("");
  const [pasted, setPasted] = useState("");
  const [error, setError] = useState<StudyErrorInfo | null>(null);
  const [busy, setBusy] = useState(false);

  const sources = useMemo(() => listStudySources(state.syllabusImports), [state.syllabusImports]);
  const rows = useMemo(() => sourceRows(sources, sortGuidesNewestFirst(state.studyGuides)), [sources, state.studyGuides]);
  const usable = rows.filter((row) => row.selectable).length;
  // With no syllabus to build from there is only the paste box.
  const effectiveMode: GuideMode = usable === 0 ? "paste" : mode ?? "imported";
  const chosenId = effectiveMode === "imported" ? chosenSourceId(rows, picked) : null;
  const chosen = chosenId ? rows.find((row) => row.id === chosenId) ?? null : null;

  const source = useMemo(() => (chosenId ? buildImportSource(state.syllabusImports, chosenId) : null), [chosenId, state.syllabusImports]);
  const pastedPrep = useMemo(() => prepareStudyText(pasted), [pasted]);
  const pastedSource = useMemo(() => (effectiveMode === "paste" ? buildPastedSource(pasted) : null), [effectiveMode, pasted]);
  const built = effectiveMode === "imported" ? source : pastedSource;
  const blocker = guideBuildBlocker({ mode: effectiveMode, sourceChosen: Boolean(source), pastedChars: pastedPrep.originalChars, pastedUsable: Boolean(pastedSource) });
  const empty = noSyllabusCopy(sources.length);

  // The sheet can be left while a guide is being built: the build goes on and the guide joins the list. Only a sheet
  // that is still open goes on to the new guide, and a failure nobody saw is not kept for the next opening.
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
    if (open) return;
    setError(null);
  }, [open]);

  async function build() {
    if (!built || busy) return;
    setError(null);
    setBusy(true);
    const importId = effectiveMode === "imported" ? chosenId ?? undefined : undefined;
    try {
      const analysis = await analyzeSyllabus({ syllabusText: built.text, courseName: guideCourseName(courseName, built, importId) });
      const guide = studyGuideFromAnalysis(analysis, { id: generateId(), now: new Date(), typedCourseName: courseName, source: built, importId });
      dispatch({ type: "ADD_STUDY_GUIDE", payload: guide });
      // The next new guide starts from an empty sheet.
      setPicked(null);
      setPasted("");
      setCourseName("");
      if (openRef.current) onBuilt(guide.id);
    } catch (e) {
      // What was chosen, pasted and typed stays exactly as it was.
      if (openRef.current) setError(describeStudyError(e, "build the study guide"));
    } finally {
      setBusy(false);
    }
  }

  const under = { margin: "8px 0 0", fontSize: 13, lineHeight: "18px", color: colors.gold } as const;

  return (
    <Sheet open={open} onClose={onClose} ariaLabel={GUIDE_SHEET_COPY.title}>
      <SheetBody gap={16}>
        <SheetHead title={GUIDE_SHEET_COPY.title} onClose={onClose} closeLabel={busy ? "Close. The study guide keeps being built" : "Close"} />

        {usable > 0 ? (
          <Segmented<GuideMode>
            options={[
              { value: "imported", label: GUIDE_SHEET_COPY.fromSyllabus },
              { value: "paste", label: GUIDE_SHEET_COPY.paste },
            ]}
            value={effectiveMode}
            onChange={(value) => {
              setMode(value);
              setError(null);
            }}
          />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <Note tone="plain" icon="file">
              <div style={{ fontSize: 15, lineHeight: "20px", fontWeight: 600, color: colors.foreground }}>{empty.title}</div>
              <div style={{ fontSize: 14, lineHeight: "20px", marginTop: 2, color: colors.muted }}>{empty.body}</div>
            </Note>
            <FieldGroup>
              <FieldPickRow icon="upload" label={GUIDE_SHEET_COPY.upload} detail={GUIDE_SHEET_COPY.uploadSub} onPress={onUpload} ariaLabel={`${GUIDE_SHEET_COPY.upload}. ${GUIDE_SHEET_COPY.uploadSub}`} />
            </FieldGroup>
          </div>
        )}

        {effectiveMode === "imported" ? (
          <div>
            <FieldLabel>{GUIDE_SHEET_COPY.which}</FieldLabel>
            <FieldGroup>
              <div role="radiogroup" aria-label={GUIDE_SHEET_COPY.which}>
                {rows.map((row, index) => {
                  const on = row.id === chosenId;
                  return (
                    <button
                      key={row.id}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      aria-label={`${row.title}. ${row.line}`}
                      disabled={!row.selectable}
                      onClick={() => {
                        setPicked(row.id);
                        setError(null);
                      }}
                      className="row pressable"
                      style={{ minHeight: 58, padding: "9px 14px", borderTop: index > 0 ? `1px solid ${colors.border}` : undefined, opacity: row.selectable ? 1 : 0.55 }}
                    >
                      <span style={{ width: 24, height: 24, borderRadius: 12, border: `1.5px solid ${on ? colors.accent : colors.borderStrong}`, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                        {on ? <span style={{ width: 12, height: 12, borderRadius: 6, background: colors.accent }} /> : null}
                      </span>
                      <span className="row-text">
                        <span className="row-label clamp2" style={{ display: "block" }}>{row.title}</span>
                        <span className="row-detail clamp2" style={{ display: "block" }}>{row.line}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </FieldGroup>
            {source?.caveat ? <p style={under}>{source.caveat}</p> : null}
            {source?.truncationNotice ? <p style={under}>{source.truncationNotice}</p> : null}
            {chosen?.existingGuideId ? (
              <button type="button" className="link" onClick={() => onOpenGuide(chosen.existingGuideId!)} disabled={busy} aria-label={`Open your study guide for ${chosen.title}`} style={{ display: "flex", alignItems: "flex-start", gap: 8, minHeight: 44, padding: "8px 0", marginTop: 4, textAlign: "left", width: "100%" }}>
                <Icon name="book" size={18} color={colors.peri} style={{ marginTop: 1 }} />
                <span style={{ flex: 1, fontSize: 14, lineHeight: "20px", fontWeight: 500, color: colors.peri, whiteSpace: "normal" }}>{GUIDE_SHEET_COPY.existing}</span>
              </button>
            ) : null}
          </div>
        ) : (
          <div>
            <FieldLabel>{GUIDE_SHEET_COPY.pasteLabel}</FieldLabel>
            <div style={{ borderRadius: 12, border: `1px solid ${colors.borderStrong}`, background: colors.panel, padding: "10px 14px 8px" }}>
              <textarea
                value={pasted}
                onChange={(event) => {
                  setPasted(event.target.value);
                  setError(null);
                }}
                placeholder="Paste the text here"
                maxLength={200000}
                aria-label="Syllabus text"
                rows={7}
                style={{ display: "block", width: "100%", minHeight: 150, border: 0, background: "transparent", color: colors.foreground, fontSize: 15, lineHeight: "21px", padding: 0, resize: "vertical" }}
              />
              <div style={{ fontFamily: MONO_FONT, fontSize: 12, lineHeight: "16px", fontWeight: 500, textAlign: "right", marginTop: 6, color: colors.muted }}>{pastedCountLine(pastedPrep.originalChars)}</div>
            </div>
            {pastedSource?.truncationNotice ? <p style={under}>{pastedSource.truncationNotice}</p> : null}
          </div>
        )}

        <div>
          <FieldLabel>{GUIDE_SHEET_COPY.courseName}</FieldLabel>
          <input className="input" type="text" placeholder="e.g. CHEM 101" value={courseName} onChange={(event) => setCourseName(event.target.value)} maxLength={100} aria-label="Course name, optional" />
        </div>

        {error ? <ToolError info={error} onRetry={() => void build()} onDismiss={() => setError(null)} /> : null}

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {blocker && !busy ? <p role="alert" style={{ margin: 0, fontSize: 14, lineHeight: "19px", fontWeight: 600, textAlign: "center", color: colors.gold }}>{blocker}</p> : null}
          <PrimaryButton size="lg" fullWidth label={busy ? GUIDE_SHEET_COPY.building : GUIDE_SHEET_COPY.build} loading={busy} disabled={Boolean(blocker) || busy} onPress={() => void build()} ariaLabel={GUIDE_SHEET_COPY.build} />
          {busy ? <p aria-live="polite" style={{ margin: 0, fontSize: 13, lineHeight: "18px", textAlign: "center", color: colors.muted }}>{GUIDE_SHEET_COPY.wait}</p> : null}
        </div>
      </SheetBody>
    </Sheet>
  );
}

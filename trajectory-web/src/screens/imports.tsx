// Imported syllabi, opened from Classes (the iPhone app's app/syllabus-history.tsx): one row per import (the class's
// tag, its name, when it was added and how many tasks it added). A row opens that import's sheet: what it added,
// whether Ask AI can read it, the class it belongs to, "Add it again", and the two ways to take it away, each asking
// first inside the sheet ("Undo this import" takes its tasks out of the plan; "Remove from this list" only forgets
// the import). What every line says is src/engine/imports-view.ts.

import { useState } from "react";

import { alpha } from "../engine/design";
import { hasNewerReadableImport, importRowFlag, importRowLine, importSheetView } from "../engine/imports-view";
import type { SyllabusImport } from "../engine/types";
import { classShortName } from "../engine/week-layout";
import { AddTile, DesktopPageHead, MetaLine } from "../components/desktop-panels";
import { goBack, useNavigate } from "../router";
import { useApp } from "../state/app-provider";
import { Icon, type IconName } from "../ui/icon";
import { useDesktop } from "../ui/layout";
import { Card, FieldGroup, FieldPickRow, HeaderIconButton, InlineConfirm, Note, PrimaryButton, ScreenHeader } from "../ui/primitives";
import { Sheet, SheetBody, SheetHead } from "../ui/sheet";
import { useColors } from "../ui/theme";
import { ClassTag } from "./classes";

/** One thing the import did: an icon in a well, what it is, and the quiet lines under it. Gold = something is missing. */
function Fact({ icon, label, details, tone = "default" }: { icon: IconName; label: string; details: string[]; tone?: "default" | "violet" | "gold" }) {
  const colors = useColors();
  const tint = tone === "gold" ? colors.gold : tone === "violet" ? colors.violet : colors.peri;
  return (
    <div className="row" style={{ alignItems: "flex-start" }}>
      <span className="well" style={{ background: alpha(tint, tone === "default" ? 0.12 : 0.16) }}>
        <Icon name={icon} size={18} color={tint} />
      </span>
      <span className="row-text">
        <span className="row-label" style={{ display: "block", color: tone === "gold" ? colors.gold : colors.foreground }}>{label}</span>
        {details.map((line) => (
          <span key={line} className="row-detail" style={{ display: "block" }}>{line}</span>
        ))}
      </span>
    </div>
  );
}

export function ImportsScreen() {
  const colors = useColors();
  const navigate = useNavigate();
  const { state, dispatch } = useApp();
  const desktop = useDesktop();
  const imports = [...(state.syllabusImports ?? [])].sort((a, b) => b.importedAt.localeCompare(a.importedAt));
  // The sheet of one import, and the question it is asking (undo its tasks, or only forget it).
  const [openId, setOpenId] = useState<string | null>(null);
  const [asking, setAsking] = useState<"undo" | "remove" | null>(null);

  const classOf = (entry: SyllabusImport) => state.classes.find((cls) => cls.id === entry.linkedClassId);
  const viewOf = (entry: SyllabusImport) => importSheetView(entry, classOf(entry), new Date(), { newerReadable: hasNewerReadableImport(entry, imports) });
  const item = openId ? imports.find((entry) => entry.id === openId) ?? null : null;
  const itemClass = item ? classOf(item) : undefined;
  const view = item ? viewOf(item) : null;
  const close = () => {
    setOpenId(null);
    setAsking(null);
  };
  const addSyllabus = (cls?: { id: string }) => navigate(cls ? `syllabus?classId=${encodeURIComponent(cls.id)}` : "syllabus");

  const sheet = (
      <Sheet open={item !== null} onClose={close} ariaLabel="Imported syllabus">
        {item && view ? (
          <SheetBody>
            <SheetHead eyebrow={view.addedLine} title={item.linkedClassName} onClose={close} />

            {/* What it added */}
            <FieldGroup>
              <Fact icon="list" label={view.added} details={view.addedDetails} />
              <Fact icon="book" label={view.classLine} details={view.classDetails} />
              <Fact icon="spark" tone={view.aiReadable ? "violet" : "gold"} label={view.aiLine} details={view.aiDetail ? [view.aiDetail] : []} />
            </FieldGroup>

            {/* What can be done with it */}
            <FieldGroup>
              {view.openClass ? (
                <FieldPickRow
                  first
                  icon="book"
                  label="Open the class"
                  detail={view.openClass.detail || undefined}
                  value={view.openClass.missing ? "Set days" : undefined}
                  unset={view.openClass.missing}
                  onPress={() => {
                    close();
                    navigate(`classes?edit=${encodeURIComponent(item.linkedClassId)}`);
                  }}
                  ariaLabel={view.openClass.missing ? "Open the class. It has no class days yet: set when it meets" : "Open the class"}
                />
              ) : null}
              <FieldPickRow
                first={!view.openClass}
                icon="upload"
                label="Add it again"
                detail={view.addAgain.detail}
                unset={view.addAgain.missing}
                onPress={() => {
                  close();
                  addSyllabus(itemClass);
                }}
                ariaLabel={`Add this syllabus again. ${view.addAgain.detail}`}
              />
            </FieldGroup>

            {/* Undo: its tasks, the class it made and their sessions leave the plan. It asks first, here. */}
            {view.undo ? (
              asking === "undo" ? (
                <InlineConfirm question={view.undo.question} confirmLabel="Undo import" cancelLabel="Keep it" onConfirm={() => { dispatch({ type: "UNDO_SYLLABUS_IMPORT", payload: item.id }); close(); }} onCancel={() => setAsking(null)} />
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <PrimaryButton tone="danger" fullWidth label="Undo this import" onPress={() => setAsking("undo")} ariaLabel={`Undo this import for ${item.linkedClassName}. It asks first`} />
                  <p className="caption" style={{ margin: 0, textAlign: "center" }}>{view.undo.caption}</p>
                </div>
              )
            ) : (
              <p className="caption" style={{ margin: 0, textAlign: "center" }}>{view.undoUnavailable}</p>
            )}

            {/* Forget the import only: the tasks stay. It asks first, here. */}
            {asking === "remove" ? (
              <InlineConfirm question={view.removeQuestion} confirmLabel="Remove" cancelLabel="Keep" onConfirm={() => { dispatch({ type: "DELETE_SYLLABUS_IMPORT", payload: item.id }); close(); }} onCancel={() => setAsking(null)} />
            ) : (
              <button type="button" className="link" onClick={() => setAsking("remove")} aria-label="Remove from this list, keep the tasks. It asks first" style={{ minHeight: 44, alignSelf: "center", padding: "0 12px", marginTop: -6, fontSize: 15, lineHeight: "20px", fontWeight: 500, color: colors.muted }}>
                Remove from this list, keep the tasks
              </button>
            )}
          </SheetBody>
        ) : (
          <SheetBody>
            <Note tone="plain" icon="info">This import is gone.</Note>
          </SheetBody>
        )}
      </Sheet>
  );

  const openImport = (entry: SyllabusImport) => {
    setOpenId(entry.id);
    setAsking(null);
  };

  if (desktop) {
    return (
      <div className="screen medium" style={{ gap: 22 }}>
        <DesktopPageHead back={{ onPress: () => goBack("classes"), ariaLabel: "Back to Classes" }} eyebrow="Classes" title="Imported syllabi" subtitle="What each syllabus added to your plan." />

        {imports.length === 0 ? (
          <Card tone="surface" padded={false} radiusSize={18} style={{ padding: "26px 28px", display: "flex", alignItems: "center", gap: 22, flexWrap: "wrap" }}>
            <span style={{ width: 56, height: 56, borderRadius: 16, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", background: alpha(colors.primary, 0.18) }}>
              <Icon name="file" size={26} color={colors.peri} />
            </span>
            <div style={{ flex: "1 1 260px", minWidth: 0 }}>
              <h2 style={{ margin: 0, fontSize: 19, lineHeight: "24px", fontWeight: 700, letterSpacing: -0.3, color: colors.foreground }}>No imports yet</h2>
              <p style={{ margin: "6px 0 0", fontSize: 14, lineHeight: "20px", color: colors.muted }}>Add a syllabus and Trajectory reads the class, when it meets and its deadlines from it.</p>
            </div>
            <PrimaryButton size="lg" label="Add a syllabus" onPress={() => addSyllabus()} />
          </Card>
        ) : (
          <div className="card-grid" style={{ ["--card-min" as string]: "280px", gap: 16 }}>
            {imports.map((entry) => {
              const cls = classOf(entry);
              const line = importRowLine(entry);
              const flag = importRowFlag(viewOf(entry));
              return (
                <button key={entry.id} type="button" className="card lift" onClick={() => openImport(entry)} aria-label={`${entry.linkedClassName}. ${line}. ${flag ? `${flag}. ` : ""}See what it added`} style={{ display: "flex", flexDirection: "column", alignItems: "stretch", gap: 16, padding: "18px 18px 18px", width: "100%", textAlign: "left", color: "inherit" }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 14 }}>
                    <ClassTag cls={cls ?? { name: entry.linkedClassName, color: "" }} size={46} />
                    <span className="clamp2" style={{ flex: 1, minWidth: 0, fontSize: 16.5, lineHeight: "22px", fontWeight: 600, letterSpacing: -0.2, color: colors.foreground }}>{entry.linkedClassName}</span>
                    <Icon name="chevronRight" size={18} color={colors.muted} />
                  </span>
                  <span style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: "auto" }}>
                    <MetaLine icon="list" color={colors.foreground}>{line}</MetaLine>
                    {flag ? <MetaLine icon="warning" color={colors.gold} tint={colors.gold}>{flag}</MetaLine> : null}
                  </span>
                </button>
              );
            })}
            <AddTile label="Add another syllabus" onPress={() => addSyllabus()} minHeight={124} />
          </div>
        )}

        {sheet}
      </div>
    );
  }

  return (
    <div className="screen">
      <div style={{ paddingTop: 4 }}>
        <HeaderIconButton onPress={() => goBack("classes")} ariaLabel="Back to Classes">
          <Icon name="chevronLeft" size={20} color={colors.foreground} strokeWidth={2} />
        </HeaderIconButton>
      </div>
      <ScreenHeader eyebrow="Classes" title="Imported syllabi" subtitle="What each syllabus added to your plan." />

      {imports.length === 0 ? (
        <Card tone="surface" radiusSize={18} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <h2 style={{ margin: 0, fontSize: 19, lineHeight: "24px", fontWeight: 700, letterSpacing: -0.3, color: colors.foreground }}>No imports yet</h2>
          <p style={{ margin: "0 0 6px", fontSize: 14, lineHeight: "20px", color: colors.muted }}>Add a syllabus and Trajectory reads the class, when it meets and its deadlines from it.</p>
          <PrimaryButton size="lg" fullWidth label="Add a syllabus" onPress={() => addSyllabus()} />
        </Card>
      ) : (
        <>
          <FieldGroup>
            {imports.map((entry) => {
              const cls = classOf(entry);
              const line = importRowLine(entry);
              // What this import still needs, said on its row so the student need not open each one to find out.
              const flag = importRowFlag(viewOf(entry));
              return (
                <button key={entry.id} type="button" className="row pressable" onClick={() => { setOpenId(entry.id); setAsking(null); }} aria-label={`${entry.linkedClassName}. ${line}. ${flag ? `${flag}. ` : ""}See what it added`} style={{ minHeight: 72 }}>
                  <ClassTag cls={cls ?? { name: entry.linkedClassName, color: "" }} />
                  <span className="row-text">
                    <span className="row-label clamp2" style={{ display: "block" }}>{entry.linkedClassName}</span>
                    <span className="row-detail" style={{ display: "block" }}>{line}</span>
                    {flag ? <span className="row-detail clamp2" style={{ display: "block", color: colors.gold }}>{flag}</span> : null}
                  </span>
                  <Icon name="chevronRight" size={18} color={colors.muted} />
                </button>
              );
            })}
          </FieldGroup>
          <PrimaryButton tone="ghost" size="lg" fullWidth label="Add another syllabus" left={<Icon name="plus" size={20} color={colors.foreground} strokeWidth={2} />} onPress={() => addSyllabus()} />
        </>
      )}

      {sheet}
    </div>
  );
}

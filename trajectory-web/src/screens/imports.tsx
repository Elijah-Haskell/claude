// Imported syllabi, opened from Classes: one row per import (the class's tag, its name, when it was added and how
// many tasks it added). A row opens that import's sheet: what it added, the class it belongs to, "Add it again", and
// the two ways to take it away, each asking first inside the sheet ("Undo this import" takes its tasks out of the
// plan; "Remove from this list" only forgets the import). What every line says is src/engine/imports-view.ts.

import { useState } from "react";

import { alpha } from "../engine/design";
import { importRowFlag, importRowLine, importSheetView } from "../engine/imports-view";
import type { SyllabusImport } from "../engine/types";
import { classShortName } from "../engine/week-layout";
import { goBack, useNavigate } from "../router";
import { useApp } from "../state/app-provider";
import { Icon, type IconName } from "../ui/icon";
import { FieldGroup, FieldPickRow, HeaderIconButton, InlineConfirm, Note, PrimaryButton, ScreenHeader } from "../ui/primitives";
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
  const imports = [...(state.syllabusImports ?? [])].sort((a, b) => b.importedAt.localeCompare(a.importedAt));
  const [openId, setOpenId] = useState<string | null>(null);
  const [asking, setAsking] = useState<"undo" | "remove" | null>(null);

  const classOf = (entry: SyllabusImport) => state.classes.find((cls) => cls.id === entry.linkedClassId);
  const item = openId ? imports.find((entry) => entry.id === openId) ?? null : null;
  const view = item ? importSheetView(item, classOf(item), new Date(), { newerReadable: false }) : null;
  const close = () => {
    setOpenId(null);
    setAsking(null);
  };

  return (
    <div className="screen">
      <div style={{ paddingTop: 4 }}>
        <HeaderIconButton onPress={() => goBack("classes")} ariaLabel="Back to Classes">
          <Icon name="chevronLeft" size={20} color={colors.foreground} strokeWidth={2} />
        </HeaderIconButton>
      </div>
      <ScreenHeader eyebrow={`${imports.length} imported`} title="Imported syllabi" subtitle="What each one added, and the way to undo it." />

      {imports.length === 0 ? (
        <Note tone="plain" icon="file">No syllabus has been imported yet.</Note>
      ) : (
        <FieldGroup>
          {imports.map((entry) => {
            const cls = classOf(entry);
            const flag = importRowFlag(importSheetView(entry, cls, new Date(), { newerReadable: false }));
            return (
              <button key={entry.id} type="button" className="row pressable" onClick={() => setOpenId(entry.id)} aria-label={`${entry.linkedClassName}. ${importRowLine(entry)}. Open it`} style={{ minHeight: 72 }}>
                <ClassTag cls={cls ?? { name: entry.linkedClassName, color: "" }} />
                <span className="row-text">
                  <span className="row-label clamp2" style={{ display: "block" }}>{cls?.name ?? entry.linkedClassName}</span>
                  <span className="row-detail" style={{ display: "block" }}>{importRowLine(entry)}</span>
                  {flag ? <span className="row-detail" style={{ display: "block", color: colors.gold }}>{flag}</span> : null}
                </span>
                <Icon name="chevronRight" size={18} color={colors.muted} />
              </button>
            );
          })}
        </FieldGroup>
      )}

      <Sheet open={item !== null} onClose={close} ariaLabel="Imported syllabus">
        {item && view ? (
          <SheetBody>
            <SheetHead eyebrow={view.addedLine} title={classOf(item)?.name ?? item.linkedClassName} onClose={close} />
            <FieldGroup>
              <Fact icon="list" label={view.added} details={view.addedDetails} />
              <Fact icon="book" label={view.classLine} details={view.classDetails} tone={view.openClass?.missing ? "gold" : "default"} />
            </FieldGroup>
            <FieldGroup>
              {view.openClass ? <FieldPickRow first icon="edit" label="Open the class" detail={view.openClass.detail} unset={view.openClass.missing} onPress={() => { close(); navigate(`classes?edit=${encodeURIComponent(item.linkedClassId)}`); }} /> : null}
              <FieldPickRow icon="upload" label="Add it again" detail={view.addAgain.detail} unset={view.addAgain.missing} onPress={() => { close(); navigate(item.linkedClassId && classOf(item) ? `syllabus?classId=${encodeURIComponent(item.linkedClassId)}` : "syllabus"); }} />
            </FieldGroup>

            {asking === "undo" && view.undo ? (
              <InlineConfirm question={view.undo.question} confirmLabel="Undo the import" onConfirm={() => { dispatch({ type: "UNDO_SYLLABUS_IMPORT", payload: item.id }); close(); }} onCancel={() => setAsking(null)} />
            ) : asking === "remove" ? (
              <InlineConfirm question={view.removeQuestion} confirmLabel="Remove" onConfirm={() => { dispatch({ type: "DELETE_SYLLABUS_IMPORT", payload: item.id }); close(); }} onCancel={() => setAsking(null)} />
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {view.undo ? (
                  <>
                    <PrimaryButton tone="danger" size="lg" fullWidth label="Undo this import" onPress={() => setAsking("undo")} />
                    <p className="caption" style={{ margin: "-4px 0 0", textAlign: "center" }}>{view.undo.caption}</p>
                  </>
                ) : (
                  <p className="caption" style={{ margin: 0, textAlign: "center" }}>{view.undoUnavailable}</p>
                )}
                <button type="button" className="link" onClick={() => setAsking("remove")} style={{ minHeight: 44, alignSelf: "center", fontSize: 14, fontWeight: 600, color: colors.muted }}>Remove from this list, keep the tasks</button>
              </div>
            )}
          </SheetBody>
        ) : (
          <SheetBody>
            <p className="caption">This import is gone.</p>
          </SheetBody>
        )}
      </Sheet>
    </div>
  );
}

// "Here is exactly what will change" before any replan is applied (the mobile app's replan-preview-sheet): one
// outlined group of rows (what moves, with the old slot struck through; what is added, removed or released; what fits
// nowhere), over them in red the work that still will not fit, under them the counts and the buttons. Nothing changes
// until the main button. Also the "Move to tomorrow would miss a deadline" question (DeferralConfirm).

import { useMemo, type ReactNode } from "react";

import { countPlanConflicts, describeConflicts, type ScopedReplanPreview } from "../engine/app-context";
import { alpha } from "../engine/design";
import type { TaskShortfall } from "../engine/intelligent-scheduler";
import type { BlockRef, PlanPatch, ReplanDiff } from "../engine/replan";
import { courseTagOf, DEFERRAL_COPY, deferralRows, previewHeadline, previewIsEmpty, previewRows, PREVIEW_UNDO_HINT, shortfallLines, STILL_WONT_FIT, unchangedLine, type PreviewRow } from "../engine/replan-view";
import type { ScheduleBlock } from "../engine/types";
import { localDateKey } from "../engine/utils";
import { useApp } from "../state/app-provider";
import { Icon } from "../ui/icon";
import { CloseButton, CourseChip, FieldGroup, Note, PrimaryButton } from "../ui/primitives";
import { SheetBody, SheetHead } from "../ui/sheet";
import { useColors } from "../ui/theme";

export interface ReplanPreviewProps {
  title: string;
  summary: string;
  diff: ReplanDiff;
  shortfalls?: Pick<TaskShortfall, "taskId" | "taskName" | "dueDate" | "missingMinutes">[];
  unplaced?: { block: BlockRef; reason: string }[];
  applyLabel?: string;
  applyDisabled?: boolean;
  onApply: () => void;
  onCancel: () => void;
  onClose?: () => void;
  children?: ReactNode;
  next?: Pick<PlanPatch, "classes" | "recurringEvents"> & { scheduleBlocks: ScheduleBlock[] };
}

function ChangeRow({ row, tag }: { row: PreviewRow; tag: { label: string; color?: string } | null }) {
  const colors = useColors();
  const arrow = row.kind !== "missed" && row.kind !== "unplaced";
  return (
    <div aria-label={row.spoken} style={{ minHeight: 68, padding: "12px 14px", display: "flex", flexDirection: "column", justifyContent: "center" }}>
      <div className="clamp2" style={{ fontSize: 16, lineHeight: "21px", fontWeight: 500, color: colors.foreground }}>{row.name}</div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: 7, rowGap: 3, marginTop: 4 }}>
        {tag ? <CourseChip label={tag.label} color={tag.color} /> : null}
        {row.from ? <span style={{ fontSize: 14, color: colors.muted, textDecoration: "line-through" }}>{row.from}</span> : null}
        {row.at ? <span style={{ fontSize: 14, color: colors.muted }}>{row.at}</span> : null}
        {arrow ? <Icon name="arrow" size={14} color={colors.peri} strokeWidth={2} /> : row.at ? <span style={{ fontSize: 14, color: colors.muted }}>·</span> : null}
        {row.to ? <span style={{ fontSize: 14, color: colors.foreground, fontWeight: 600 }}>{row.to}</span> : null}
        {row.outcome ? <span style={row.kind === "unplaced" ? { fontSize: 14, color: colors.error, fontWeight: 600 } : { fontSize: 14, color: colors.muted }}>{row.outcome}</span> : null}
      </div>
      {row.reason ? <div style={{ fontSize: 13, lineHeight: "18px", marginTop: 3, color: row.reasonTone === "gold" ? colors.gold : colors.muted }}>{row.reason}</div> : null}
      {row.note ? <div className="clamp2" style={{ fontSize: 13, lineHeight: "18px", marginTop: 3, color: colors.muted }}>{row.note}</div> : null}
    </div>
  );
}

export function ReplanPreviewBody({ title, summary, diff, shortfalls = [], unplaced = [], applyLabel = "Apply", applyDisabled = false, onApply, onCancel, onClose, children, next }: ReplanPreviewProps) {
  const colors = useColors();
  const { state } = useApp();
  const today = localDateKey(new Date());
  const nothing = previewIsEmpty(diff, shortfalls.length, unplaced.length);
  const rows = previewRows(diff, unplaced, today);
  const short = shortfallLines(shortfalls, today);
  const stays = nothing ? "" : unchangedLine(diff);
  const classes = next?.classes ?? state.classes;
  const conflicts = useMemo(() => (next ? countPlanConflicts(state, next) : null), [next, state]);

  return (
    <SheetBody gap={10}>
      <div className="sheet-head">
        <h2 className="sheet-title">{title}</h2>
        <CloseButton onPress={onClose ?? onCancel} ariaLabel={onClose ? "Close" : "Close the preview, keep my schedule as it is"} />
      </div>
      <p className="sheet-sub" style={{ marginTop: -4 }}>{summary}</p>

      <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingTop: 4 }}>
        {children}
        {short.length > 0 ? (
          <Note tone="red" icon="warning" role="alert">
            <div style={{ fontSize: 14, lineHeight: "20px", fontWeight: 600, color: colors.foreground }}>{STILL_WONT_FIT}</div>
            {short.map((line) => (
              <div key={line.key} style={{ fontSize: 14, lineHeight: "20px", color: colors.foreground }}>{line.text}</div>
            ))}
          </Note>
        ) : null}
        {rows.length > 0 ? (
          <FieldGroup>
            {rows.map((row) => (
              <ChangeRow key={row.key} row={row} tag={courseTagOf(row.taskId, state.tasks, classes)} />
            ))}
          </FieldGroup>
        ) : null}
        {stays ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 2px" }}>
            <Icon name="check" size={18} color={colors.success} strokeWidth={2.2} />
            <span style={{ flex: 1, fontSize: 14, lineHeight: "20px", color: colors.muted }}>{stays}</span>
          </div>
        ) : null}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 2 }}>
        <p style={{ margin: 0, fontSize: 14, lineHeight: "20px", color: colors.muted }}>
          <span style={{ color: colors.foreground, fontWeight: 600 }}>{previewHeadline(diff)}</span>
          {conflicts !== null && !nothing ? <span style={{ color: conflicts === 0 ? colors.success : colors.gold, fontWeight: 600 }}>{` ${describeConflicts(conflicts)}.`}</span> : null}
          {nothing ? "" : " Nothing changes until you say so."}
        </p>
        <PrimaryButton size="lg" fullWidth label={applyLabel} ariaLabel={applyDisabled ? `${applyLabel}: nothing to change` : applyLabel} onPress={onApply} disabled={applyDisabled} />
        <PrimaryButton tone="ghost" size="lg" fullWidth label="Cancel" ariaLabel="Cancel, keep my schedule as it is" onPress={onCancel} />
        <p style={{ margin: 0, fontSize: 13, lineHeight: "18px", textAlign: "center", color: colors.muted }}>{PREVIEW_UNDO_HINT}</p>
      </div>
    </SheetBody>
  );
}

/**
 * "Move to tomorrow" would miss a deadline: nothing has changed yet. Say which work is at risk and let the student keep
 * the sessions or move them anyway.
 */
export function DeferralConfirm({ risk, onKeep, onMoveAnyway, onClose }: { risk: NonNullable<ScopedReplanPreview["needsConfirmation"]>; onKeep: () => void; onMoveAnyway: () => void; onClose?: () => void }) {
  const colors = useColors();
  const rows = deferralRows(risk.atRisk, localDateKey(new Date()));
  return (
    <SheetBody>
      <SheetHead eyebrow={DEFERRAL_COPY.label} eyebrowColor={colors.gold} title={DEFERRAL_COPY.title} onClose={onClose ?? onKeep} />
      <p className="sheet-sub">{risk.summary}</p>
      <FieldGroup>
        {rows.map((row) => (
          <div key={row.key} className="row" aria-label={row.spoken} style={{ minHeight: 58 }}>
            <div className="well" style={{ background: alpha(colors.gold, 0.16) }}>
              <Icon name={row.assessment ? "flag" : "file"} size={18} color={colors.gold} />
            </div>
            <div className="row-text">
              <div className="row-label clamp2">{row.name}</div>
              <div className="row-detail">{row.detail}</div>
            </div>
          </div>
        ))}
      </FieldGroup>
      <PrimaryButton size="lg" fullWidth label={DEFERRAL_COPY.keep} ariaLabel="Keep the sessions where they are" onPress={onKeep} />
      <PrimaryButton tone="ghost" size="lg" fullWidth label={DEFERRAL_COPY.move} ariaLabel="Move anyway, knowing it will be late" onPress={onMoveAnyway} />
      <p style={{ margin: 0, fontSize: 13, lineHeight: "18px", textAlign: "center", color: colors.muted }}>{DEFERRAL_COPY.hint}</p>
    </SheetBody>
  );
}

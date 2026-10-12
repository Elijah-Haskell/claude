// The small sheet behind a study guide's "more" button (the mobile app's components/study/study-guide-more-sheet.tsx).
// It holds the one thing that is not done every day: deleting the guide. Deleting asks first, in the sheet, and says
// what goes with it.

import { useEffect, useState } from "react";

import { alpha } from "../engine/design";
import { GUIDE_DELETE_COPY } from "../engine/study-tools-view";
import { Icon } from "../ui/icon";
import { FieldGroup } from "../ui/primitives";
import { Sheet, SheetBody, SheetHead } from "../ui/sheet";
import { useColors } from "../ui/theme";
import { ConfirmNote } from "./study-parts";

export function StudyGuideMoreSheet({ open, title, onClose, onDelete }: { open: boolean; title: string; onClose: () => void; onDelete: () => void }) {
  const colors = useColors();
  const [confirming, setConfirming] = useState(false);

  // Every opening starts from the row, not from the question.
  useEffect(() => {
    if (open) setConfirming(false);
  }, [open]);

  return (
    <Sheet open={open} onClose={onClose} ariaLabel={title}>
      <SheetBody gap={16}>
        <SheetHead title={title} onClose={onClose} />
        {confirming ? (
          <ConfirmNote
            question={GUIDE_DELETE_COPY.question}
            confirmLabel="Delete"
            cancelLabel="Keep"
            onConfirm={() => {
              setConfirming(false);
              onDelete();
            }}
            onCancel={() => setConfirming(false)}
            confirmAriaLabel={`Delete the study guide ${title}`}
            cancelAriaLabel="Keep the study guide"
          />
        ) : (
          <FieldGroup>
            <button type="button" className="row pressable" onClick={() => setConfirming(true)} aria-label={GUIDE_DELETE_COPY.row}>
              <span className="well" style={{ background: alpha(colors.error, 0.14) }}>
                <Icon name="trash" size={18} color={colors.error} />
              </span>
              <span className="row-label" style={{ flex: 1, color: colors.error }}>{GUIDE_DELETE_COPY.row}</span>
            </button>
          </FieldGroup>
        )}
      </SheetBody>
    </Sheet>
  );
}

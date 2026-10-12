// The one sheet shape of the redesign: `panel` background, a handle, a 44pt close button at the top right, the
// content, the main button at the bottom. A bottom sheet on a phone, a centred dialog on a wide screen (src/styles.css).

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { CloseButton } from "./primitives";

interface SheetProps {
  open: boolean;
  onClose: () => void;
  /** Said to screen readers; the visible title is the children's business (SheetHead). */
  ariaLabel: string;
  wide?: boolean;
  children: ReactNode;
}

let openSheets = 0;

export function Sheet({ open, onClose, ariaLabel, wide, children }: SheetProps) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Escape closes; the page under the sheet does not scroll while one is open.
  useEffect(() => {
    if (!open) return;
    openSheets += 1;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        closeRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      openSheets -= 1;
      if (openSheets === 0) document.body.style.overflow = "";
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className="sheet-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={ariaLabel} className={`sheet${wide ? " wide" : ""}`}>
        <div className="sheet-handle" />
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** The sheet's title row: an optional mono line over the title, the title, and the close button. */
export function SheetHead({ eyebrow, eyebrowColor, title, onClose, closeLabel }: { eyebrow?: string; eyebrowColor?: string; title: string; onClose: () => void; closeLabel?: string }) {
  return (
    <div className="sheet-head">
      <div style={{ flex: 1, minWidth: 0 }}>
        {eyebrow ? <div className="eyebrow" style={{ marginBottom: 4, paddingTop: 8, color: eyebrowColor }}>{eyebrow}</div> : null}
        <h2 className="sheet-title" style={eyebrow ? { paddingTop: 0 } : undefined}>{title}</h2>
      </div>
      <CloseButton onPress={onClose} ariaLabel={closeLabel} />
    </div>
  );
}

export function SheetBody({ children, gap = 14 }: { children: ReactNode; gap?: number }) {
  return (
    <div className="sheet-body" style={{ gap }}>
      {children}
    </div>
  );
}

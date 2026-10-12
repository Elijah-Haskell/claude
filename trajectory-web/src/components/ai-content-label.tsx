// AI content label + Report (App Store 2026 AI guideline): every AI-generated surface (chat replies, study
// guides, practice exams, test review, AI-proposed plan changes, parsed tasks) shows a small
// "AI-generated · may be inaccurate" line with a Report action. Report opens a sheet with reasons and an optional
// note, then hands a pre-filled e-mail to the student's mail app (they see it before anything is sent). The e-mail
// carries only the reason, the note and an excerpt of the AI content: no account or device data.
// The mobile app's components/ui/ai-content-label.tsx, written for the DOM.

import { useState, type CSSProperties } from "react";

import { alpha, brand, radius } from "../engine/design";
import { APP_VERSION } from "../lib/config";
import { AI_REPORT_REASONS, SUPPORT_EMAIL, buildAiReportMailto, type AiReportReason, type AiSurface } from "../lib/support-links";
import { Icon } from "../ui/icon";
import { PrimaryButton, eyebrowStyle } from "../ui/primitives";
import { Sheet, SheetBody } from "../ui/sheet";
import { useColors } from "../ui/theme";

export type { AiSurface } from "../lib/support-links";

interface AiContentLabelProps {
  /** What kind of AI output this is (goes into the report's subject). */
  surface: AiSurface;
  /** The AI text the report is about (an excerpt is included in the e-mail). A function is only called on Report. */
  content: string | (() => string);
  style?: CSSProperties;
  /** Smaller type for use inside chat bubbles and dense cards. */
  compact?: boolean;
}

/** The small "AI-generated · may be inaccurate · Report" line. Renders its own report sheet. */
export function AiContentLabel({ surface, content, style, compact }: AiContentLabelProps) {
  const colors = useColors();
  const [open, setOpen] = useState(false);
  // Nothing in the app is under 12px: "compact" only tightens the line.
  const size = compact ? 12 : 13;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", ...style }}>
      <Icon name="spark" size={compact ? 13 : 14} color={colors.violet} />
      <span className="truncate" aria-label="AI-generated content. It may be inaccurate." style={{ fontSize: size, lineHeight: `${size + 5}px`, color: colors.muted, flexShrink: 1 }}>
        AI-generated · may be inaccurate
      </span>
      <button type="button" aria-label={`Report this ${surface}`} onClick={() => setOpen(true)} style={{ minHeight: 32, padding: "0 4px", fontSize: size, lineHeight: `${size + 5}px`, fontWeight: 600, color: colors.peri }}>
        Report
      </button>
      {open ? <AiReportSheet visible surface={surface} content={typeof content === "function" ? content() : content} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

/** The report sheet on its own (for surfaces that put "Report" in a line of their own). */
export function AiReportSheet({ visible, surface, content, onClose }: { visible: boolean; surface: AiSurface; content: string; onClose: () => void }) {
  const colors = useColors();
  const [reason, setReason] = useState<AiReportReason | null>(null);
  const [note, setNote] = useState("");

  function send() {
    if (!reason) return;
    const url = buildAiReportMailto({ surface, reason, excerpt: content, note, appVersion: APP_VERSION });
    // The browser hands a mailto: link to the mail app it knows; the page stays as it is.
    window.location.href = url;
    onClose();
  }

  return (
    <Sheet open={visible} onClose={onClose} ariaLabel="Report AI content">
      <SheetBody>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={eyebrowStyle(colors.violet, 12)}>Report AI content</div>
          <h2 style={{ margin: 0, fontSize: 22, lineHeight: "28px", fontWeight: 800, letterSpacing: -0.5, color: colors.foreground }}>What's wrong with it?</h2>
          <p style={{ margin: 0, fontSize: 13, lineHeight: "18px", color: colors.muted }}>
            Your mail app opens with the reason and this {surface} filled in. Nothing is sent until you press send there.
          </p>
        </div>
        <div role="radiogroup" aria-label="What's wrong with it?" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {AI_REPORT_REASONS.map((option) => {
            const selected = reason === option;
            return (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={option}
                onClick={() => setReason(option)}
                style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 46, padding: "0 14px", borderRadius: 12, border: `1px solid ${selected ? colors.accent : colors.border}`, background: selected ? alpha(colors.primary, 0.16) : "rgba(143,179,245,0.07)", width: "100%" }}
              >
                <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: colors.foreground, textAlign: "left" }}>{option}</span>
                <span style={{ width: 20, height: 20, borderRadius: 10, border: `2px solid ${selected ? colors.accent : colors.borderStrong}`, background: selected ? colors.primary : "transparent", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  {selected ? <Icon name="check" size={11} color={brand.white} strokeWidth={2.4} /> : null}
                </span>
              </button>
            );
          })}
        </div>
        <textarea
          className="input"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Anything to add? (optional)"
          maxLength={600}
          aria-label="Optional note"
          style={{ minHeight: 76, height: 76, borderRadius: radius.md, border: `1px solid ${colors.borderStrong}`, padding: "10px 12px", fontSize: 14, lineHeight: "20px", background: colors.background, color: colors.foreground, resize: "vertical" }}
        />
        <div style={{ display: "flex", gap: 10 }}>
          <PrimaryButton label="Write report" ariaLabel="Write report e-mail" disabled={!reason} left={<Icon name="mail" size={16} color={brand.white} />} style={{ flex: 2 }} onPress={send} />
          <PrimaryButton tone="ghost" label="Cancel" style={{ flex: 1 }} onPress={onClose} />
        </div>
        {/* A browser cannot tell whether a mail app answered the link, so the address is said here too. */}
        <p className="caption" style={{ margin: 0 }}>No mail app here? Send your report to {SUPPORT_EMAIL}.</p>
      </SheetBody>
    </Sheet>
  );
}

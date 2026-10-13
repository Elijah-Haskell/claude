// The small sheet behind each of a test review's two optional rows (the mobile app's
// components/study/test-review-text-sheet.tsx): "Class" (one line, with the student's own classes offered to fill it
// in) and "Ask about your test" (a few lines, counted). What is typed is kept as it is typed; "Done" closes the sheet.

import { alpha } from "../engine/design";
import { FieldLabel, MONO_FONT, PrimaryButton } from "../ui/primitives";
import { Sheet, SheetBody, SheetHead } from "../ui/sheet";
import { useColors } from "../ui/theme";

interface Props {
  open: boolean;
  title: string;
  label: string;
  value: string;
  onChange: (text: string) => void;
  onClose: () => void;
  placeholder: string;
  maxLength: number;
  ariaLabel: string;
  /** Several lines (a question) instead of one (a name). */
  multiline?: boolean;
  /** Under a multiline box, at its right end ("120 of 500"). */
  countLine?: string;
  /** Names to fill the field in with one press (the student's classes). */
  suggestions?: readonly string[];
  suggestionsLabel?: string;
}

export function ReviewTextSheet({ open, title, label, value, onChange, onClose, placeholder, maxLength, ariaLabel, multiline, countLine, suggestions = [], suggestionsLabel }: Props) {
  const colors = useColors();

  return (
    <Sheet open={open} onClose={onClose} ariaLabel={title}>
      <SheetBody gap={16}>
        <SheetHead title={title} onClose={onClose} />

        <div>
          <FieldLabel>{label}</FieldLabel>
          {multiline ? (
            <textarea className="input" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} maxLength={maxLength} aria-label={ariaLabel} rows={4} style={{ minHeight: 120 }} />
          ) : (
            <input
              className="input"
              type="text"
              value={value}
              onChange={(event) => onChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") onClose();
              }}
              placeholder={placeholder}
              maxLength={maxLength}
              aria-label={ariaLabel}
            />
          )}
          {countLine ? <div style={{ fontFamily: MONO_FONT, fontSize: 12, lineHeight: "16px", fontWeight: 500, textAlign: "right", marginTop: 6, color: colors.muted }}>{countLine}</div> : null}
        </div>

        {suggestions.length > 0 ? (
          <div>
            {suggestionsLabel ? <FieldLabel>{suggestionsLabel}</FieldLabel> : null}
            <div role="radiogroup" aria-label={suggestionsLabel ?? label} style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {suggestions.map((name) => {
                const on = name.trim().toLowerCase() === value.trim().toLowerCase();
                return (
                  <button
                    key={name}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    aria-label={name}
                    onClick={() => onChange(on ? "" : name)}
                    style={{ minHeight: 44, maxWidth: "100%", padding: "0 12px", borderRadius: 12, border: `1px solid ${on ? colors.accent : colors.borderStrong}`, background: on ? alpha(colors.primary, 0.2) : colors.panel, display: "inline-flex", alignItems: "center" }}
                  >
                    <span className="truncate" style={{ fontSize: 14, lineHeight: "19px", fontWeight: 600, color: on ? colors.foreground : colors.muted }}>{name}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        <PrimaryButton size="lg" fullWidth label="Done" onPress={onClose} />
      </SheetBody>
    </Sheet>
  );
}

// The week as a strip of seven dates at the top of Today: click a day to look at it. The day on screen has an
// outline, days gone by are dimmer, and a gold dot marks a day with something due (gold = deadlines, as everywhere).

import type { StripDay } from "../engine/day-strip";
import { alpha } from "../engine/design";
import { MONO_FONT } from "../ui/primitives";
import { useColors } from "../ui/theme";

export function WeekStrip({ days, selectedKey, onSelect }: { days: readonly StripDay[]; selectedKey: string; onSelect: (key: string) => void }) {
  const colors = useColors();
  return (
    <div role="tablist" aria-label="This week" style={{ display: "flex", gap: 4 }}>
      {days.map((day) => {
        const selected = day.key === selectedKey;
        return (
          <button
            key={day.key}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-label={day.label}
            onClick={() => onSelect(day.key)}
            className="pressable"
            style={{
              flex: 1,
              height: 60,
              borderRadius: 12,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 1,
              border: `1px solid ${selected ? alpha(colors.accent, 0.7) : "transparent"}`,
              background: selected ? alpha(colors.primary, 0.18) : "transparent",
            }}
          >
            <span style={{ fontFamily: MONO_FONT, fontSize: 12, lineHeight: "16px", fontWeight: 600, letterSpacing: 0.6, color: selected || day.isToday ? colors.peri : colors.muted }}>{day.letter}</span>
            {/* Today keeps its own colour while another day is being looked at */}
            <span style={{ fontSize: 17, lineHeight: "22px", fontWeight: 600, color: selected ? colors.foreground : day.isToday ? colors.peri : day.isPast ? colors.muted : colors.foreground }}>{day.dayOfMonth}</span>
            <span style={{ width: 5, height: 5, borderRadius: 2.5, marginTop: 1, background: day.dueCount > 0 ? colors.gold : "transparent" }} />
          </button>
        );
      })}
    </div>
  );
}

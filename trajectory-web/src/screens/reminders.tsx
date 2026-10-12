// PLACEHOLDER: ported in a following step (see the task list). Keep the export names; the route is wired in src/app.tsx.
import { goBack } from "../router";
import { Icon } from "../ui/icon";
import { HeaderIconButton, Note, ScreenHeader } from "../ui/primitives";
import { useColors } from "../ui/theme";

export function RemindersScreen() {
  const colors = useColors();
  return (
    <div className="screen" style={{ maxWidth: 560 }}>
      <div style={{ display: "flex", paddingTop: 4 }}>
        <HeaderIconButton onPress={() => goBack("today")} ariaLabel="Back">
          <Icon name="chevronLeft" size={20} color={colors.foreground} strokeWidth={2} />
        </HeaderIconButton>
      </div>
      <ScreenHeader title="Reminders" />
      <Note tone="plain" icon="info">This screen is being ported.</Note>
    </div>
  );
}

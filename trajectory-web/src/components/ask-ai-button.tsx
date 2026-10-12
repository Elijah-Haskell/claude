// The Ask AI button in the header of Today and Week: violet, like everything AI. It is a button, not a tab; the page
// it opens is titled "Trajectory AI" (src/screens/ai.tsx). The mobile app's components/ask-ai-button.tsx.

import { legibleOn } from "../engine/contrast";
import { alpha } from "../engine/design";
import { navigate } from "../router";
import { Icon } from "../ui/icon";
import { useColors } from "../ui/theme";

export function AskAiButton() {
  const colors = useColors();
  const ink = legibleOn(colors.violet, colors.background, 7);
  return (
    <button
      type="button"
      aria-label="Ask AI. Tell Trajectory what changed and review the proposed schedule change"
      onClick={() => navigate("ai")}
      style={{ display: "inline-flex", alignItems: "center", gap: 7, height: 40, padding: "0 13px 0 11px", borderRadius: 12, border: `1px solid ${alpha(colors.violet, 0.55)}`, background: alpha(colors.violet, 0.16), color: ink, fontSize: 14, lineHeight: "19px", fontWeight: 600, flexShrink: 0 }}
    >
      <Icon name="spark" size={17} color={ink} />
      Ask AI
    </button>
  );
}

// The pages added to a test review, as thumbnails (the mobile app's components/study/test-review-pages.tsx): the page's
// number, a remove button (44px to the touch), a spinner while the page uploads, and for an upload that failed a red
// outline with "Retry upload" under it.

import { alpha } from "../engine/design";
import type { AllowedImageMime } from "../engine/study-images";
import { Icon } from "../ui/icon";
import { MONO_FONT } from "../ui/primitives";
import { useColors } from "../ui/theme";

export interface ReviewPage {
  id: string;
  /** An object URL of the picked file, for the thumbnail (revoked when the page goes). */
  uri: string;
  status: "uploading" | "ready" | "failed";
  url?: string;
  /** Kept only while an upload has failed, so "Retry upload" does not need the picker again. */
  base64?: string;
  mimeType?: AllowedImageMime;
  error?: string;
}

export function ReviewPages({ pages, onRemove, onRetry }: { pages: readonly ReviewPage[]; onRemove: (id: string) => void; onRetry: (page: ReviewPage) => void }) {
  const colors = useColors();
  const scrim = alpha(colors.panel, 0.88);
  const cover = { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: alpha(colors.background, 0.6), pointerEvents: "none" } as const;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
      {pages.map((page, index) => {
        const number = index + 1;
        const failed = page.status === "failed";
        return (
          <div key={page.id} style={{ width: 104 }}>
            <div style={{ position: "relative", width: 104, height: 104, borderRadius: 12, border: `1px solid ${failed ? colors.error : colors.borderStrong}`, background: colors.panel, overflow: "hidden" }}>
              <img src={page.uri} alt={`Test page ${number}${failed ? ", upload failed" : page.status === "uploading" ? ", uploading" : ""}`} style={{ width: 104, height: 104, objectFit: "cover", display: "block" }} />
              {page.status === "uploading" ? (
                <div style={cover}>
                  <span className="spinner" />
                </div>
              ) : null}
              {failed ? (
                <div style={cover}>
                  <Icon name="warning" size={22} color={colors.error} />
                </div>
              ) : null}
              <div style={{ position: "absolute", left: 6, bottom: 6, minWidth: 24, height: 22, padding: "0 6px", borderRadius: 7, border: `1px solid ${colors.borderStrong}`, background: scrim, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
                <span style={{ fontFamily: MONO_FONT, fontSize: 12, lineHeight: "16px", fontWeight: 600, color: colors.foreground }}>{number}</span>
              </div>
              <button type="button" onClick={() => onRemove(page.id)} aria-label={`Remove page ${number}`} style={{ position: "absolute", top: 0, right: 0, width: 44, height: 44, display: "flex", alignItems: "flex-start", justifyContent: "flex-end", padding: 6 }}>
                <span style={{ width: 26, height: 26, borderRadius: 13, border: `1px solid ${colors.borderStrong}`, background: scrim, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                  <Icon name="close" size={14} color={colors.foreground} strokeWidth={2.4} />
                </span>
              </button>
            </div>
            {failed ? (
              <button type="button" className="link" onClick={() => onRetry(page)} aria-label={`Retry uploading page ${number}`} style={{ minHeight: 44, gap: 5, fontSize: 13, lineHeight: "18px", fontWeight: 600, color: colors.error }}>
                <Icon name="refresh" size={14} color={colors.error} />
                Retry upload
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

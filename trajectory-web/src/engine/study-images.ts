/**
 * Client-side checks for photos and files that are about to be uploaded for the study features
 * (test review, exam-prep material). They mirror the server's rules in server/upload-policy.ts so a
 * doomed upload is refused BEFORE it uses data, with a message that says how to fix it.
 * tests/study-images.test.ts asserts these constants equal the server's.
 */

/** Same as server/upload-policy.ts MAX_UPLOAD_BYTES (decoded bytes). */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Image types the upload endpoints accept (the server also checks the real bytes). */
export const ALLOWED_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type AllowedImageMime = (typeof ALLOWED_IMAGE_MIME_TYPES)[number];
/** Most pages a test review takes. */
export const MAX_REVIEW_IMAGES = 6;
/** Picker quality that keeps a phone photo well under the size cap without hurting handwriting legibility. */
export const PICKER_QUALITY = 0.7;

/** Bytes a base64 string decodes to (no decoding). */
export function decodedBytesFromBase64(base64: string): number {
  const len = base64.length;
  if (len === 0) return 0;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((len * 3) / 4) - padding;
}

export function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Best guess at an image's MIME type from what the picker reports. */
export function inferImageMime(asset: { mimeType?: string | null; uri?: string | null; fileName?: string | null }): string {
  const declared = asset.mimeType?.toLowerCase().trim();
  if (declared && declared.startsWith("image/")) return declared === "image/jpg" ? "image/jpeg" : declared;
  const name = `${asset.fileName ?? ""} ${asset.uri ?? ""}`.toLowerCase().split(/[?#]/)[0] ?? "";
  if (/\.png\b/.test(name)) return "image/png";
  if (/\.webp\b/.test(name)) return "image/webp";
  if (/\.(heic|heif)\b/.test(name)) return "image/heic";
  if (/\.(gif)\b/.test(name)) return "image/gif";
  return "image/jpeg";
}

export type ImageCheck =
  | { ok: true; mimeType: AllowedImageMime; bytes: number }
  | { ok: false; reason: "missing" | "unsupported" | "too_large"; message: string };

export function checkImageForUpload(asset: {
  base64?: string | null;
  mimeType?: string | null;
  uri?: string | null;
  fileName?: string | null;
}): ImageCheck {
  if (!asset.base64) {
    return { ok: false, reason: "missing", message: "That photo couldn't be read. Please pick it again." };
  }
  const mimeType = inferImageMime(asset);
  if (!(ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType)) {
    return {
      ok: false,
      reason: "unsupported",
      message: "That photo format isn't supported. Choose a JPEG or PNG photo, or take a new picture with the camera.",
    };
  }
  const bytes = decodedBytesFromBase64(asset.base64);
  if (bytes > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      reason: "too_large",
      message: `That photo is ${formatMegabytes(bytes)}, over the ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB limit. Take it again from a little further away or choose a smaller image.`,
    };
  }
  return { ok: true, mimeType: mimeType as AllowedImageMime, bytes };
}

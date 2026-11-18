// Sending files to the server as bytes, with progress. fetch() can't report upload
// progress, so this uses XMLHttpRequest. The file is the request body; its name and the
// other fields go in the query string.

import { ApiError } from "./api.js";
import { state } from "./state.js";

/**
 * POST a File to /api<path>?name=...&<fields>. onProgress(fraction 0..1) is called as it sends.
 * Resolves with the server's JSON reply; rejects with ApiError (status 409 = name already used).
 */
export function sendFile(path, file, fields = {}, { onProgress, name } = {}) {
  const q = new URLSearchParams({ name: name || file.name });
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null && v !== "") q.set(k, Array.isArray(v) ? v.join(",") : String(v));
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api" + path + "?" + q.toString());
    xhr.setRequestHeader("Accept", "application/json");
    if (file.type) xhr.setRequestHeader("Content-Type", file.type);
    else xhr.setRequestHeader("Content-Type", "application/octet-stream");
    if (state.me) xhr.setRequestHeader("X-Lawdesk-User", String(state.me));
    xhr.responseType = "text";
    if (onProgress) {
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    }
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(1);
        resolve(data);
      } else reject(new ApiError((data && data.error) || `Upload failed (${xhr.status})`, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError("The upload didn't reach the server. Check the connection and try again.", 0));
    xhr.onabort = () => reject(new ApiError("Upload cancelled", 0));
    xhr.send(file);
  });
}

/** "1.2 MB" */
export function fmtSize(n) {
  if (n == null) return "";
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} bytes`;
}

const KINDS = [
  [/^application\/pdf$/, "PDF"],
  [/wordprocessingml|msword|rtf/, "Word"],
  [/spreadsheetml|ms-excel|text\/csv/, "Excel"],
  [/presentationml/, "Slides"],
  [/^image\//, "Image"],
  [/^message\//, "Email"],
  [/^text\/html/, "Web page"],
  [/^text\//, "Text"],
  [/zip/, "Zip"],
];

/** A plain word for a file type: PDF, Word, Image... */
export function kindOf(mime) {
  for (const [re, label] of KINDS) if (re.test(mime || "")) return label;
  return "File";
}

/** Can the browser show it in the page? (The server only serves these inline.) */
export function previewKind(mime) {
  if (mime === "application/pdf") return "pdf";
  if (/^image\/(png|jpeg|gif)$/.test(mime || "")) return "image";
  if (/wordprocessingml|^text\/|^message\//.test(mime || "")) return "text";
  return null;
}

export const fileUrl = (id, { version, inline } = {}) => {
  const q = new URLSearchParams();
  if (version) q.set("version", String(version));
  if (inline) q.set("inline", "1");
  const s = q.toString();
  return `/api/documents/${id}/file${s ? "?" + s : ""}`;
};

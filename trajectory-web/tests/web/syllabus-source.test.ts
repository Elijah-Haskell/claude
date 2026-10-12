import { describe, expect, it } from "vitest";

import { classifyPickedFile, decodeBase64Text, DOCX_MIME, FILE_ACCEPT, fileTooLarge, imageMime, MAX_UPLOAD_BYTES, pendingSourceOf, PHOTO_ACCEPT, sourceWords, uploadMimeFor } from "../../src/lib/syllabus-source";

describe("what kind of file was picked", () => {
  it("by type first, then by the name", () => {
    expect(classifyPickedFile("application/pdf", "syllabus")).toBe("pdf");
    expect(classifyPickedFile("", "FINC 3100.PDF")).toBe("pdf");
    expect(classifyPickedFile(DOCX_MIME, "syllabus")).toBe("docx");
    expect(classifyPickedFile("application/msword", "old.doc")).toBe("docx");
    expect(classifyPickedFile("", "syllabus.docx")).toBe("docx");
    expect(classifyPickedFile("text/plain", "notes")).toBe("text");
    expect(classifyPickedFile("", "notes.txt")).toBe("text");
    expect(classifyPickedFile("image/png", "page.png")).toBe("image");
    expect(classifyPickedFile(undefined, undefined)).toBe("image");
  });

  it("is uploaded as a PDF or as the image it is (the server sniffs the content anyway)", () => {
    expect(uploadMimeFor({ kind: "pdf", mimeType: "application/pdf" })).toBe("application/pdf");
    expect(uploadMimeFor({ kind: "image", mimeType: "image/png" })).toBe("image/png");
    expect(uploadMimeFor({ kind: "image", mimeType: "image/webp" })).toBe("image/webp");
    expect(uploadMimeFor({ kind: "image", mimeType: "image/heic" })).toBe("image/jpeg");
    expect(imageMime(undefined)).toBe("image/jpeg");
  });

  it("the pickers offer what the server reads, plus Word and text which are read here", () => {
    expect(FILE_ACCEPT).toContain("application/pdf");
    expect(FILE_ACCEPT).toContain(DOCX_MIME);
    expect(FILE_ACCEPT).toContain("text/plain");
    expect(PHOTO_ACCEPT.split(",")).toEqual(expect.arrayContaining(["image/jpeg", "image/png", "image/webp"]));
    expect(PHOTO_ACCEPT).not.toContain("pdf");
  });
});

describe("the server's size limit", () => {
  it("is 10 MB per file, checked before anything is read or sent", () => {
    expect(MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
    expect(fileTooLarge(MAX_UPLOAD_BYTES)).toBe(false);
    expect(fileTooLarge(MAX_UPLOAD_BYTES + 1)).toBe(true);
    expect(fileTooLarge(0)).toBe(false);
  });
});

describe("text files are read in the browser", () => {
  it("decodes UTF-8 text from base64", () => {
    const base64 = Buffer.from("Quiz 1 – 2026-11-03\nCafé", "utf8").toString("base64");
    expect(decodeBase64Text(base64)).toBe("Quiz 1 – 2026-11-03\nCafé");
  });
});

describe("what is remembered while a reading runs", () => {
  it("keeps the uploaded URL(s) and the file's name, never the text or the File itself", () => {
    const file = new Blob(["%PDF-1.4"], { type: "application/pdf" }) as unknown as File;
    const pending = pendingSourceOf({ kind: "file", input: { pdfUrl: "https://files.test/a.pdf", rawText: "secret" }, local: { uri: "blob:a", name: "a.pdf", mimeType: "application/pdf", kind: "pdf", file } });
    expect(pending).toEqual({ kind: "file", input: { pdfUrl: "https://files.test/a.pdf", pdfUrls: undefined }, local: { uri: "blob:a", name: "a.pdf", mimeType: "application/pdf", kind: "pdf" } });
    expect(JSON.stringify(pending)).not.toContain("secret");
    expect("file" in pending.local!).toBe(false);
    expect(pendingSourceOf({ kind: "scan", input: { pdfUrls: ["u1", "u2"] }, pageUris: ["blob:1", "blob:2"] })).toEqual({ kind: "scan", input: { pdfUrl: undefined, pdfUrls: ["u1", "u2"] }, pageUris: ["blob:1", "blob:2"] });
    expect(pendingSourceOf({ kind: "paste", input: { rawText: "the syllabus" } })).toEqual({ kind: "paste", input: { pdfUrl: undefined, pdfUrls: undefined } });
  });
});

describe("what the wait says it is reading", () => {
  it("names the file, the pages or the pasted text", () => {
    expect(sourceWords({ kind: "paste", file: null, pageCount: 0, textLength: 12345 })).toEqual({ name: "Pasted text", detail: "12,345 characters" });
    expect(sourceWords({ kind: "scan", file: null, pageCount: 1, textLength: 0 })).toEqual({ name: "1 page", detail: "Photos of the pages" });
    expect(sourceWords({ kind: "scan", file: null, pageCount: 3, textLength: 0 })).toEqual({ name: "3 pages", detail: "Photos of the pages" });
    expect(sourceWords({ kind: "file", file: { name: "FINC 3100.pdf", kind: "pdf" }, pageCount: 0, textLength: 0 })).toEqual({ name: "FINC 3100.pdf", detail: "PDF" });
    expect(sourceWords({ kind: "file", file: { name: "notes.docx", kind: "docx" }, pageCount: 0, textLength: 0 })).toEqual({ name: "notes.docx", detail: "Word file" });
    expect(sourceWords({ kind: "file", file: null, pageCount: 0, textLength: 0 })).toEqual({ name: "Your syllabus", detail: "Syllabus" });
  });
});

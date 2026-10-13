// Getting the syllabus into the app: a file (PDF / Word / image / text) or photos of the pages, picked in the browser.
// Picks first (in the browser), then makes sure there is a session (the account's), then reads and uploads, and hands
// ONE ready-to-extract source to the screen. A picked file or page is never lost to a failure: it stays on screen
// until the reading succeeds, and "Try again" sends it again (uploading it again when the server may already have
// deleted the earlier copy). Failures are described honestly (src/engine/syllabus-messages.ts) and never leave the
// screen stuck. The pure part (what kind of file, the type it is sent as, the size limit) is src/lib/syllabus-source.ts.

import { useCallback, useRef, useState } from "react";

import { describeIntakeFailure, type IntakeFailure, type IntakeStage } from "../../engine/syllabus-messages";
import { mutate, NetworkError } from "../../lib/api";
import {
  classifyPickedFile,
  decodeBase64Text,
  FILE_TOO_LARGE_MESSAGE,
  fileTooLarge,
  imageMime,
  PHOTO_SELECTION_LIMIT,
  readFileAsBase64,
  uploadMimeFor,
  type ExtractionSource,
  type LocalFile,
  type ScannedPage,
  type UploadMime,
} from "../../lib/syllabus-source";

export type { ExtractionInput, ExtractionSource, LocalFile, ScannedPage } from "../../lib/syllabus-source";

/** A stage error carries which stage failed so the message can be specific. */
class StageError extends Error {
  constructor(
    readonly stage: IntakeStage,
    readonly original: unknown,
  ) {
    super(original instanceof Error ? original.message : String(original));
  }
}

/** A file over the server's limit is refused here, before anything is read or sent. */
const TOO_LARGE_FAILURE: IntakeFailure = { title: "This file is too large", message: FILE_TOO_LARGE_MESSAGE, canRetry: false, offerPaste: true };

/** A file remembered from before a reload: the browser no longer holds it, so it cannot be sent again. */
const FILE_GONE_FAILURE: IntakeFailure = { title: "Choose the file again", message: "The page was reloaded, so this browser no longer holds that file. Choose it again to read it, or paste the text.", canRetry: false, offerPaste: true };

/**
 * What went wrong, in words a student can act on. The API client's "could not reach" error is described as the
 * connection problem it is (the engine's messages recognise the iPhone's wording for it).
 */
export function describeFailure(error: unknown, stage: IntakeStage): IntakeFailure {
  const described = error instanceof NetworkError ? new TypeError(`Network request failed: ${error.message}`) : error;
  return describeIntakeFailure(described, stage);
}

interface Options {
  /**
   * Whether the server calls below have a session (the account's: an account is required here, and the gate above
   * every route shows the sign-in screen when it goes). On false nothing is sent and the picked file / pages stay.
   */
  ensureSession: () => Promise<boolean>;
}

export function useSyllabusSource(onSource: (source: ExtractionSource) => void, { ensureSession }: Options) {
  const [isUploading, setIsUploading] = useState(false);
  // A picked file is on its way to the server right now (not: a picker is open, and not: an unread file is remembered).
  const [isSendingFile, setIsSendingFile] = useState(false);
  const [scannedPages, setScannedPagesState] = useState<ScannedPage[]>([]);
  const pagesRef = useRef<ScannedPage[]>([]);
  const [pendingFile, setPendingFile] = useState<LocalFile | null>(null);
  const [failure, setFailure] = useState<IntakeFailure | null>(null);
  const busy = useRef(false);

  const setScannedPages = useCallback((next: ScannedPage[] | ((pages: ScannedPage[]) => ScannedPage[])) => {
    pagesRef.current = typeof next === "function" ? next(pagesRef.current) : next;
    setScannedPagesState(pagesRef.current);
  }, []);

  const fail = useCallback((error: unknown) => {
    const stage = error instanceof StageError ? error.stage : "upload";
    setFailure(describeFailure(error instanceof StageError ? error.original : error, stage));
  }, []);

  const guarded = useCallback(
    async (work: () => Promise<void>) => {
      if (busy.current) return; // ignore a second click while a file is being read / uploaded
      busy.current = true;
      setFailure(null);
      setIsUploading(true);
      try {
        await work();
      } catch (error) {
        fail(error);
      } finally {
        setIsUploading(false);
        busy.current = false;
      }
    },
    [fail],
  );

  const upload = useCallback(async (file: Blob, mimeType: UploadMime): Promise<string> => {
    let base64: string;
    try {
      base64 = await readFileAsBase64(file);
    } catch (error) {
      throw new StageError("read-file", error);
    }
    try {
      // Tagged as a syllabus at upload time, so the server erases the file even if its reading never starts.
      const uploaded = await mutate("ai.uploadFile", { base64, mimeType, purpose: "syllabus" });
      if (!uploaded?.url) throw new Error("No URL returned from upload");
      return uploaded.url;
    } catch (error) {
      throw new StageError("upload", error);
    }
  }, []);

  /** The reading / uploading of a picked file itself (sendFile below marks it as under way). */
  const sendPickedFile = useCallback(
    async (file: LocalFile) => {
      const picked = file.file;
      if (!picked) {
        setFailure(FILE_GONE_FAILURE);
        return;
      }
      if (file.kind === "docx" || file.kind === "text") {
        let base64: string;
        try {
          base64 = await readFileAsBase64(picked);
        } catch (error) {
          throw new StageError("read-file", error);
        }
        if (file.kind === "text") {
          onSource({ kind: "file", input: { rawText: decodeBase64Text(base64) }, local: file });
          return;
        }
        try {
          const { text } = await mutate("ai.extractDocxText", { base64Data: base64 });
          onSource({ kind: "file", input: { rawText: text }, local: file });
        } catch (error) {
          throw new StageError("read-file", error);
        }
        return;
      }
      const url = await upload(picked, uploadMimeFor(file));
      onSource({ kind: "file", input: { pdfUrl: url }, local: file });
    },
    [onSource, upload],
  );

  /** Reads / uploads a picked file and hands it on. The file stays pending until the screen clears it. */
  const sendFile = useCallback(
    async (file: LocalFile) => {
      if (!(await ensureSession())) return;
      setIsSendingFile(true);
      try {
        await sendPickedFile(file);
      } finally {
        setIsSendingFile(false);
      }
    },
    [ensureSession, sendPickedFile],
  );

  /** "Choose a file" handed a file over (the hidden file input's change). */
  const filePicked = useCallback(
    (picked: File | undefined) =>
      guarded(async () => {
        if (!picked) return;
        const mimeType = picked.type || "application/octet-stream";
        const file: LocalFile = { uri: URL.createObjectURL(picked), name: picked.name || "Syllabus", mimeType, kind: classifyPickedFile(mimeType, picked.name), file: picked };
        if (fileTooLarge(picked.size)) {
          setFailure(TOO_LARGE_FAILURE);
          return;
        }
        setPendingFile(file);
        await sendFile(file);
      }),
    [guarded, sendFile],
  );

  /** Uploads every page that has no URL yet. Throws (pages kept) when one fails. */
  const uploadMissingPages = useCallback(async (): Promise<boolean> => {
    if (!pagesRef.current.some((p) => p.url === null)) return true;
    if (!(await ensureSession())) return false;
    for (const page of pagesRef.current) {
      if (page.url !== null) continue;
      if (!page.file) {
        setFailure(FILE_GONE_FAILURE);
        return false;
      }
      const url = await upload(page.file, imageMime(page.file.type));
      setScannedPages((pages) => pages.map((p) => (p.uri === page.uri ? { ...p, url } : p)));
    }
    return true;
  }, [ensureSession, setScannedPages, upload]);

  const addPages = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      if (files.some((file) => fileTooLarge(file.size))) {
        setFailure(TOO_LARGE_FAILURE);
        return;
      }
      setScannedPages((prev) => {
        const room = Math.max(0, PHOTO_SELECTION_LIMIT - prev.length);
        return [...prev, ...files.slice(0, room).map((file) => ({ uri: URL.createObjectURL(file), file, url: null }))];
      });
      await uploadMissingPages();
    },
    [setScannedPages, uploadMissingPages],
  );

  /** "Choose photos" handed photos over (the hidden photo input's change). */
  const photosPicked = useCallback((files: File[]) => guarded(() => addPages(files)), [addPages, guarded]);

  /** "Read N pages": uploads whatever is still missing, then hands the pages on. */
  const submitScan = useCallback(
    () =>
      guarded(async () => {
        if (pagesRef.current.length === 0) return;
        if (!(await uploadMissingPages())) return;
        const pages = pagesRef.current;
        if (pages.length === 0) return; // the pages were discarded while they were uploading
        onSource({ kind: "scan", input: { pdfUrls: pages.map((p) => p.url!) }, pageUris: pages.map((p) => p.uri) });
      }),
    [guarded, onSource, uploadMissingPages],
  );

  /** Sends the pending (picked but not yet read) file again. */
  const continuePendingFile = useCallback(() => {
    const file = pendingFile;
    if (file) void guarded(() => sendFile(file));
  }, [guarded, pendingFile, sendFile]);

  /**
   * Sends a source again after a failed reading. The server deletes an uploaded syllabus once its reading is
   * over, so a file or photos are uploaded again; text is simply sent again.
   */
  const resend = useCallback(
    (source: ExtractionSource) => {
      if (source.kind === "file" && source.local && source.input.pdfUrl) {
        const file = source.local;
        setPendingFile(file);
        void guarded(() => sendFile(file));
        return;
      }
      if (source.kind === "scan" && pagesRef.current.length > 0) {
        setScannedPages((pages) => pages.map((p) => ({ ...p, url: null })));
        void submitScan();
        return;
      }
      onSource(source);
    },
    [guarded, onSource, sendFile, setScannedPages, submitScan],
  );

  /** Puts a remembered source back on screen (a reading resumed after the page was reloaded). */
  const restore = useCallback(
    (source: ExtractionSource) => {
      if (source.kind === "file" && source.local) setPendingFile(source.local);
      if (source.kind === "scan" && source.pageUris?.length) {
        const urls = source.input.pdfUrls ?? [];
        setScannedPages(source.pageUris.map((uri, i) => ({ uri, file: null, url: urls[i] ?? null })));
      }
    },
    [setScannedPages],
  );

  return {
    isUploading,
    isSendingFile,
    restore,
    scannedPages,
    setScannedPages,
    pendingFile,
    clearPendingFile: () => setPendingFile(null),
    continuePendingFile,
    failure,
    clearFailure: () => setFailure(null),
    filePicked,
    photosPicked,
    submitScan,
    resend,
  };
}

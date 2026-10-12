/**
 * The plan saved to the account: the engine. It carries out the rules of lib/plan-sync.ts against a server (the
 * transport), the bookkeeping key and this iPhone's plan (the device), all handed in, so it runs in tests without an
 * iPhone or a server. lib/plan-sync-client.ts wires the real ones; components/plan-sync.tsx drives it.
 *
 * How it keeps a plan from being lost:
 *  - One thing at a time. Every check, load and save goes through one queue, and each step looks again at whether
 *    it is still wanted (signed out, signing out, another account) before it touches anything.
 *  - A save always says which revision of the account's plan it replaces, and that is always a revision whose
 *    content this iPhone has seen. `force` is never used: a plan nobody here looked at cannot be overwritten.
 *  - Before the account's plan replaces this iPhone's, or the other way round, the two are compared by content.
 *    Only when both hold something the other has not seen is the student asked.
 *  - A loaded plan is on disk before the bookkeeping says this iPhone holds it; if the app dies in between, the
 *    next launch simply does it again.
 *  - A part of this iPhone's plan that could not be read from its storage is never taken for empty: nothing is
 *    decided, saved or loaded on that reading, and it is tried again.
 *  - Nothing is saved, and nothing is written to storage, between prepareSignOut() and the next sign-in: the wipe
 *    that follows a sign-out leaves an emptied plan behind, and that must never reach the account. A plan that was
 *    being written to this iPhone when signing out began is let finish before prepareSignOut() answers, so it cannot
 *    land after that wipe either.
 */
import type { PlanHeader, PlanSaveInput, PlanSaveResult, SavedPlan } from "../shared/plan-sync";
import {
  decodePlanSnapshot,
  encodePlanSnapshot,
  encodePlanSnapshotInSlices,
  isBlankPlan,
  isPristineState,
  preparePlan,
  type PlanContents,
} from "./plan-snapshot";
import {
  PLAN_FOREGROUND_CHECK_INTERVAL_MS,
  PLAN_RATE_LIMIT_WAIT_MS,
  PLAN_SAFETY_COPY_STORAGE_KEY,
  PLAN_SAVE_MAX_WAIT_MS,
  PLAN_SAVE_MIN_INTERVAL_MS,
  PLAN_SAVE_QUIET_MS,
  PLAN_SIGN_OUT_WAIT_MS,
  PLAN_SYNC_STORAGE_KEY,
  classifyPlanSyncError,
  compareOutcome,
  decideSync,
  errorLabel,
  freshBookkeeping,
  ownUnansweredSave,
  parseBookkeeping,
  rememberSentSave,
  retryDelayMs,
  serializeBookkeeping,
  serializeSafetyCopy,
  type PlanSafetyCopy,
  type PlanSaveState,
  type PlanSync,
  type PlanSyncBookkeeping,
  type PlanSyncFailure,
  type PlanSyncNotice,
  type PlanSyncPhase,
  type PlanSyncPrompt,
  type PlanSyncQuestion,
  type SyncStep,
} from "./plan-sync";
import type { AppState } from "../engine/types";

/** The three server procedures (`plan.header`, `plan.load`, `plan.save`). */
export interface PlanSyncTransport {
  header(): Promise<PlanHeader | null>;
  load(): Promise<SavedPlan | null>;
  save(input: PlanSaveInput): Promise<PlanSaveResult>;
}

export interface PlanSyncStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/** This iPhone's plan: where it is read from and how it is replaced. */
export interface PlanSyncDevice {
  /** The app state as it is now (cheap: nothing is read from storage). */
  state(): AppState;
  /**
   * True when the student has just done something the state does not show yet (the action is on its way through
   * React). Loading a plan quietly at that moment would write over it, so it counts as a change of theirs.
   */
  editing?(): boolean;
  /**
   * The whole plan as it is now: the state and the feed links. Throws when part of it could not be read from
   * storage (feed links that could not be read must not be taken for none, and saved as such).
   */
  read(): Promise<PlanContents>;
  /**
   * Replaces this iPhone's plan with `plan`, keeping what is this iPhone's own (lib/plan-snapshot.ts
   * stateForLoadedPlan). Resolves, with the number of course feeds on this iPhone, only once all of it is on disk
   * and state() / read() give the new plan; throws when it could not be written.
   */
  apply(plan: PlanContents): Promise<{ feedCount: number }>;
  /** Erases everything the app keeps on this iPhone except the safety copy (the plan of another account is being replaced). */
  wipe(): Promise<void>;
}

export interface PlanSyncEngineDeps {
  transport: PlanSyncTransport;
  storage: PlanSyncStorage;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Resolves once the app is not busy with a touch or an animation: the heavy work (JSON, compression) waits for it. */
  whenIdle?: () => Promise<void>;
  /** Lets the app breathe between two slices of compression. */
  pause?: () => Promise<void>;
  random?: () => number;
  /** A log line: what failed and the error's name or code. Never plan content. */
  log?: (what: string, label: string) => void;
}

/** The student's answer to a PlanSyncQuestion. */
export type PlanSyncAnswer = "use-saved" | "keep-mine" | "continue" | "sign-out";

export interface PlanSyncEngine {
  /** The same object until something in it changes (for useSyncExternalStore). */
  getStatus(): PlanSync;
  getPrompt(): PlanSyncPrompt;
  subscribe(listener: () => void): () => void;
  /** The app state is loaded and `device` reads and replaces it: the bookkeeping is read now. */
  attach(device: PlanSyncDevice): void;
  /** The signed-in Apple account (openId), or null: nobody, a guest, or the browser preview. */
  setAccount(openId: string | null): void;
  /** Something in the plan changed. `edited`: the student changed it (not a re-plan the app ran by itself). */
  planChanged(change: { edited: boolean }): void;
  appBecameActive(): void;
  /** The app is going to the background: what is not saved yet is sent now. */
  appLeftForeground(): void;
  retry(): void;
  /** Ignored unless `question` is the one being asked. */
  answer(question: PlanSyncQuestion, reply: PlanSyncAnswer): void;
  /** Asks the open question again (it could not be acted on). */
  askAgain(): void;
  dismissNotice(notice: PlanSyncNotice): void;
  prepareSignOut(options?: { save?: boolean }): Promise<"saved" | "unsaved">;
  cancelSignOut(): void;
  /** Resolves when nothing is in progress (tests). */
  idle(): Promise<void>;
}

export function createPlanSyncEngine(deps: PlanSyncEngineDeps): PlanSyncEngine {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const whenIdle = deps.whenIdle ?? (() => Promise.resolve());
  const pause = deps.pause ?? (() => Promise.resolve());
  const log = deps.log ?? (() => undefined);
  const isoNow = () => new Date(now()).toISOString();

  let device: PlanSyncDevice | null = null;
  let book: PlanSyncBookkeeping | null = null;
  let bookRead: Promise<void> | null = null;
  let account: string | null = null;
  /** Goes up whenever the account changes: work started for an earlier session stops at its next step. */
  let session = 0;
  /** Between prepareSignOut() and the next sign-in (or cancelSignOut()): nothing is sent, nothing is written. */
  let paused = false;
  let signOutAnswer: "saved" | "unsaved" = "saved";

  let phase: PlanSyncPhase = "off";
  let restored = false;
  let question: PlanSyncQuestion | null = null;
  /** The account's plan the open "choose" question is about: what "Use the saved plan" loads. */
  let choice: { header: PlanHeader; plan: PlanContents; hash: string } | null = null;
  const notices: PlanSyncNotice[] = [];
  const noticesShown = new Set<PlanSyncNotice["kind"]>();
  /** The account's plan at this revision cannot be read by this app: it is left alone and nothing is saved. */
  let blocked: { reason: "newer-version" | "unreadable"; revision: number } | null = null;

  /** Whether the state was a fresh install's when the app handed it over (attach), before anything could touch it. */
  let pristineAtAttach = false;
  /** The rules ran against the account since this session started (or since the last failure). */
  let checked = false;
  /** The server refused the session: nothing more is tried until the app comes back, a retry or the next sign-in. */
  let stopped = false;
  let saving = false;
  let offline = false;
  let tooLarge = false;
  /** The app is about to be suspended (or the student is signing out): no waiting for a quiet moment. */
  let urgent = false;

  // Changes are counted so that a save knows whether the plan changed again while it was on its way.
  let changeSeq = 0;
  let editSeq = 0;
  /** Changes seen before the bookkeeping was read, or while signing out was in progress. */
  let pendingDirty = false;
  let pendingEdited = false;
  let lastChangeAt = 0;
  let firstUnsavedAt: number | null = null;

  let saveTimer: unknown = null;
  let retryTimer: unknown = null;
  let failures = 0;
  let lastSaveAt = -Infinity;
  let lastCheckAt = -Infinity;
  /** The server asked for a pause between saves until this moment. */
  let waitUntil = 0;

  // ── What the outside sees ───────────────────────────────────

  const listeners = new Set<() => void>();
  const retry = (): void => retryNow();
  let status: PlanSync = { phase: "off", save: "saved", lastSavedAt: null, restoredFromAccount: false, retry };
  let prompt: PlanSyncPrompt = { question: null, notice: null, blocked: null };

  function saveState(): PlanSaveState {
    if (phase !== "ready" || !book) return "saved";
    if (blocked) return "offline";
    if (tooLarge) return "too-large";
    if (saving) return "saving";
    if (offline) return "offline";
    return book.dirty || book.owner !== account ? "waiting" : "saved";
  }

  function publish(): void {
    const next = {
      phase,
      save: saveState(),
      lastSavedAt: book && account !== null && book.owner === account ? book.lastSavedAt : null,
      restoredFromAccount: restored,
    };
    const nextPrompt: PlanSyncPrompt = { question, notice: notices[0] ?? null, blocked: blocked?.reason ?? null };
    let changed = false;
    if (next.phase !== status.phase || next.save !== status.save || next.lastSavedAt !== status.lastSavedAt || next.restoredFromAccount !== status.restoredFromAccount) {
      status = { ...next, retry };
      changed = true;
    }
    if (nextPrompt.question !== prompt.question || nextPrompt.notice !== prompt.notice || nextPrompt.blocked !== prompt.blocked) {
      prompt = nextPrompt;
      changed = true;
    }
    if (changed) for (const listener of [...listeners]) listener();
  }

  /** Nothing is sent, fetched or retried while a question is open: only the student's answer moves things on. */
  function ask(next: PlanSyncQuestion): void {
    stopSaveTimer();
    stopRetry();
    question = next;
    phase = "choose";
    publish();
  }

  function notify(notice: PlanSyncNotice): void {
    if (noticesShown.has(notice.kind)) return; // once per launch
    noticesShown.add(notice.kind);
    notices.push(notice);
  }

  // ── Plumbing ────────────────────────────────────────────────

  let chain: Promise<void> = Promise.resolve();

  /** Still the session this work was started for, and not signing out. */
  const live = (s: number): boolean => s === session && !paused && account !== null;

  /** Runs `work` after everything queued before it. Work for a session that is over is skipped. */
  function enqueue(work: (s: number) => Promise<void>): Promise<void> {
    const s = session;
    chain = chain.then(async () => {
      if (!live(s)) return;
      try {
        await work(s);
      } catch (error) {
        // Never expected. The student must not be left on "Getting your plan…" for ever because of it.
        log("unexpected", errorLabel(error));
        if (live(s) && phase === "checking") {
          phase = "unreachable";
          publish();
        }
      }
    });
    return chain;
  }

  function stopSaveTimer(): void {
    if (saveTimer !== null) {
      clearTimer(saveTimer);
      saveTimer = null;
    }
  }

  function stopRetry(): void {
    if (retryTimer !== null) {
      clearTimer(retryTimer);
      retryTimer = null;
    }
  }

  async function persist(): Promise<void> {
    if (!book || paused) return;
    try {
      await deps.storage.setItem(PLAN_SYNC_STORAGE_KEY, serializeBookkeeping(book));
    } catch (error) {
      // What is in memory is still right for this launch. A stale record at the next one is caught by comparing the
      // two plans (compareOutcome), never by trusting the record.
      log("bookkeeping", errorLabel(error));
    }
  }

  function readBook(): Promise<void> {
    if (book) return Promise.resolve();
    bookRead ??= (async () => {
      let raw: string | null = null;
      let readable = true;
      try {
        raw = await deps.storage.getItem(PLAN_SYNC_STORAGE_KEY);
      } catch (error) {
        readable = false;
        log("bookkeeping", errorLabel(error));
      }
      const loaded = parseBookkeeping(raw, deps.random);
      const changedMeanwhile = pendingDirty;
      if (pendingDirty) {
        loaded.dirty = true;
        loaded.edited = loaded.edited || pendingEdited;
        pendingDirty = false;
        pendingEdited = false;
      }
      book = loaded;
      // A first launch keeps its new device id. A record that could not be read is not written over on a guess.
      if (readable && (raw === null || changedMeanwhile)) await persist();
    })();
    return bookRead;
  }

  /** The network answered and the rules ran. */
  function reached(): void {
    checked = true;
    stopped = false;
    offline = false;
    failures = 0;
    stopRetry();
  }

  function canSave(): boolean {
    return account !== null && book !== null && device !== null && phase === "ready" && !paused && !blocked && !stopped;
  }

  /**
   * This iPhone's plan, or null when it could not be read (its storage did not answer). A plan that could not be read
   * is never taken for an empty one, so nothing is decided: it is handled like an account that could not be reached,
   * and tried again.
   */
  async function readPlan(s: number): Promise<PlanContents | null> {
    if (!device) return null;
    try {
      return await device.read();
    } catch (error) {
      if (live(s)) await failed(s, error, "read");
      return null;
    }
  }

  /** A load or a wipe of this iPhone in progress (deviceAtRest). */
  let deviceWork: Promise<void> | null = null;

  async function onDevice<T>(work: () => Promise<T>): Promise<T> {
    let finished: () => void = () => undefined;
    const busy = new Promise<void>((resolve) => {
      finished = resolve;
    });
    deviceWork = busy;
    try {
      return await work();
    } finally {
      if (deviceWork === busy) deviceWork = null;
      finished();
    }
  }

  /**
   * Resolves once no load or wipe of this iPhone is in progress. Signing out waits for this: whoever asked is about to
   * wipe the iPhone, and a plan still being written must not land after that wipe (it would be left on an iPhone
   * nobody is signed in on). Not for ever: storage that hangs must not hang signing out.
   */
  async function deviceAtRest(): Promise<void> {
    const busy = deviceWork;
    if (!busy) return;
    const limit = sleep(PLAN_SIGN_OUT_WAIT_MS);
    await Promise.race([busy, limit.done]);
    limit.cancel();
  }

  /** This iPhone is at the account's `header`, whose plan has the fingerprint `hash`. */
  function adopt(header: PlanHeader, hash: string): void {
    if (!book) return;
    book = { ...book, owner: account, revision: header.revision, hash, sent: [], savedBy: header.deviceId, serverSavedAt: header.savedAt };
  }

  // ── Starting, and asking the account ────────────────────────

  async function start(s: number): Promise<void> {
    await readBook();
    if (!live(s) || !book || !device) return;
    if (book.owner !== null && book.owner !== account) {
      const contents = await readPlan(s);
      if (!contents || !live(s)) return;
      if (!isBlankPlan(contents)) {
        ask({ kind: "other-account" });
        return;
      }
      // No plan of the other account is left to lose, but what else it left here (a feed link, its AI consent) goes.
      if (!(await replaceOtherAccount(s, null))) return;
    }
    const pristine = pristineAtAttach || isPristineState(device.state());
    pristineAtAttach = false; // it described the launch, not a later sign-in
    if (lostItsCopy(pristine)) {
      untie();
      await persist();
      if (!live(s) || !book) return;
    }
    // This account's plan is already here: usable at once, without the network.
    if (book.owner === account) {
      phase = "ready";
      publish();
    }
    await check(s);
  }

  /**
   * A record that says "this iPhone holds revision N of this account's plan" next to a state as new as a fresh
   * install's: the iPhone lost its own copy (its storage was damaged or cleared in part). The record no longer
   * describes anything on it.
   */
  function lostItsCopy(pristine: boolean): boolean {
    return book !== null && book.owner === account && book.revision > 0 && pristine;
  }

  /**
   * Forgets what the record said. From here on this is an iPhone that was never tied to the account: the account's
   * plan is loaded onto it (a restore), and whatever the student might build on it in the meantime is never taken for
   * a newer version of that plan and saved over it; it would be a question. Also at the next launch, should this one
   * end before the plan is back.
   */
  function untie(): void {
    if (!book) return;
    book = { ...freshBookkeeping(deps.random), deviceId: book.deviceId };
  }

  /** Empties this iPhone (keeping `copy`, the plan being replaced, when there is one). False when it could not be done. */
  async function replaceOtherAccount(s: number, copy: string | null): Promise<boolean> {
    if (!device) return false;
    try {
      if (copy !== null) await deps.storage.setItem(PLAN_SAFETY_COPY_STORAGE_KEY, copy);
      if (!live(s)) return false;
      const phone = device;
      await onDevice(() => phone.wipe());
    } catch (error) {
      log("wipe", errorLabel(error));
      if (live(s)) {
        phase = "unreachable";
        publish();
      }
      return false;
    }
    if (!live(s)) return false;
    book = freshBookkeeping(deps.random);
    await persist();
    return live(s);
  }

  /**
   * Asks the account what it holds (or takes `known`, the header a refused save came back with) and does what the
   * rules say. `depth` counts refused saves in a row.
   */
  async function check(s: number, known?: { header: PlanHeader | null }, depth = 0): Promise<void> {
    if (!live(s) || !book || !device) return;
    let header: PlanHeader | null;
    if (known) {
      header = known.header;
    } else {
      lastCheckAt = now();
      try {
        header = await deps.transport.header();
      } catch (error) {
        if (live(s)) await failed(s, error, "header");
        return;
      }
      if (!live(s) || !book) return;
    }
    const own = header ? ownUnansweredSave(header, book) : null;
    if (header && own) {
      // The server stored a save of this iPhone's and only its answer was lost: nobody else has saved, so this
      // iPhone is at that revision. If the plan changed since, the rules below save it again over it; no question.
      const savedAt = Number.isFinite(Date.parse(header.savedAt)) ? header.savedAt : isoNow();
      adopt(header, own.hash);
      book = { ...book, lastSavedAt: savedAt };
      await persist();
      if (!live(s) || !book) return;
    }
    if (blocked && header && header.revision === blocked.revision) {
      // Still the plan this app cannot read.
      reached();
      phase = "ready";
      publish();
      return;
    }
    blocked = null;
    const contents = await readPlan(s);
    if (!contents || !live(s) || !book) return;
    if (lostItsCopy(isPristineState(contents.state))) {
      untie();
      await persist();
      if (!live(s) || !book) return;
    }
    await perform(s, stepFor(header, contents), header, contents, depth);
  }

  function stepFor(header: PlanHeader | null, contents: PlanContents): SyncStep {
    const b = book!;
    return decideSync({
      account: account!,
      owner: b.owner,
      revision: b.revision,
      dirty: b.dirty,
      edited: b.edited || device?.editing?.() === true,
      savedBy: b.savedBy,
      serverSavedAt: b.serverSavedAt,
      header,
      blank: isBlankPlan(contents),
    });
  }

  async function perform(s: number, step: SyncStep, header: PlanHeader | null, contents: PlanContents, depth: number): Promise<void> {
    if (!book) return;
    switch (step.do) {
      case "ask-other-account":
        ask({ kind: "other-account" });
        return;
      case "settle": {
        const nothingToSave = isBlankPlan(contents);
        book = {
          ...book,
          owner: account,
          ...(step.account === "empty" ? { revision: 0, hash: null, sent: [], savedBy: null, serverSavedAt: null, lastSavedAt: null } : {}),
          // An empty plan is not saved over a plan the account holds, nor as its first one.
          ...(nothingToSave ? { dirty: false, edited: false } : {}),
        };
        reached();
        await persist();
        if (!live(s)) return;
        phase = "ready";
        publish();
        armSave();
        return;
      }
      case "save":
        book = { ...book, dirty: true, ...(step.over === "nothing" ? { revision: 0, hash: null, savedBy: null, serverSavedAt: null } : {}) };
        reached();
        await persist();
        if (!live(s)) return;
        phase = "ready";
        publish();
        await save(s, depth);
        return;
      case "compare":
        await compare(s, depth);
        return;
    }
  }

  /**
   * The account holds a plan this iPhone is not known to have seen: fetches it and compares the two. The decision is
   * taken again from what both sides hold once the plan has arrived (the student may have changed something while it
   * was on its way).
   */
  async function compare(s: number, depth: number): Promise<void> {
    if (!device) return;
    let saved: SavedPlan | null;
    try {
      saved = await deps.transport.load();
    } catch (error) {
      if (live(s)) await failed(s, error, "load");
      return;
    }
    if (!live(s) || !book) return;
    if (!saved) {
      await check(s, { header: null }, depth);
      return;
    }
    const decoded = decodePlanSnapshot(saved.snapshot);
    if (decoded.kind !== "plan") {
      block(decoded.kind, saved.header);
      return;
    }
    if (!urgent) await whenIdle();
    if (!live(s)) return;
    const server = preparePlan(decoded.plan);
    const seq = changeSeq;
    const eseq = editSeq;
    const contents = await readPlan(s);
    if (!contents || !live(s) || !book) return;
    const step = stepFor(saved.header, contents);
    if (step.do !== "compare") {
      await perform(s, step, saved.header, contents, depth);
      return;
    }
    const local = preparePlan(contents);
    const outcome = compareOutcome({
      serverHash: server.hash,
      localHash: local.hash,
      syncedHash: book.owner === account ? book.hash : null,
      sentHashes: book.sent.map((sent) => sent.hash),
      mine: step.mine,
      whenDifferent: step.whenDifferent,
    });
    switch (outcome) {
      case "same":
        adopt(saved.header, server.hash);
        book = { ...book, dirty: seq !== changeSeq, edited: eseq !== editSeq, lastSavedAt: isoNow() };
        if (!book.dirty) firstUnsavedAt = null;
        reached();
        tooLarge = false;
        await persist();
        if (!live(s)) return;
        phase = "ready";
        publish();
        armSave();
        return;
      case "save":
        adopt(saved.header, server.hash);
        book = { ...book, dirty: true };
        reached();
        await persist();
        if (!live(s)) return;
        phase = "ready";
        publish();
        await save(s, depth);
        return;
      case "load":
        await applyLoaded(s, saved.header, decoded.plan, server.hash, { restore: step.restore, copy: null });
        return;
      case "ask":
        choice = { header: saved.header, plan: decoded.plan, hash: server.hash };
        reached();
        ask({ kind: "choose", savedAt: saved.header.savedAt });
        return;
    }
  }

  function block(kind: "newer-version" | "unreadable", header: PlanHeader): void {
    blocked = { reason: kind, revision: header.revision };
    question = null;
    choice = null;
    reached();
    stopSaveTimer();
    notify({ kind });
    // The student keeps working on this iPhone; nothing is saved until the account's plan can be read.
    phase = "ready";
    publish();
  }

  /** Puts the account's plan on this iPhone. `copy`: the plan being replaced, kept first (the student chose). */
  async function applyLoaded(s: number, header: PlanHeader, plan: PlanContents, hash: string, options: { restore: boolean; copy: string | null }): Promise<void> {
    if (!device) return;
    const loadedFor = account;
    const seq = changeSeq;
    const eseq = editSeq;
    let applied: { feedCount: number };
    try {
      if (options.copy !== null) {
        await deps.storage.setItem(PLAN_SAFETY_COPY_STORAGE_KEY, options.copy);
        // Signing out began while the copy was being written: nothing is replaced any more.
        if (!live(s)) return;
      }
      const phone = device;
      applied = await onDevice(() => phone.apply(plan));
    } catch (error) {
      log("apply", errorLabel(error));
      if (!live(s)) return;
      // Nothing is recorded: the next attempt starts from what is really on this iPhone.
      checked = false;
      if (choice) {
        // The student chose the saved plan and it could not be put in place: the question is theirs again.
        ask({ kind: "choose", savedAt: choice.header.savedAt });
        return;
      }
      if (phase === "checking") phase = "unreachable";
      scheduleRetry("unreachable");
      publish();
      return;
    }
    if (!live(s) || !book) {
      // The plan is on this iPhone, and the session it was loaded for is gone.
      //  - Signing out began (paused): the record is left as it was, the wipe is next.
      //  - The session only ended (the welcome screen's "Sign out" leaves alone a plan that was here before the
      //    sign-in; an expired session leaves everything): no wipe follows. The plan now on this iPhone is that
      //    account's, so it is recorded as theirs: the next account to sign in here is asked before it is replaced
      //    (decideSync "ask-other-account") and can never take it over as its own.
      if (!paused && book && loadedFor !== null) {
        book = { ...book, owner: loadedFor, revision: header.revision, hash, sent: [], savedBy: header.deviceId, serverSavedAt: header.savedAt, dirty: false, edited: false, lastSavedAt: isoNow() };
        await persist();
      }
      return;
    }
    adopt(header, hash);
    book = { ...book, dirty: seq !== changeSeq, edited: eseq !== editSeq, lastSavedAt: isoNow() };
    if (!book.dirty) firstUnsavedAt = null;
    reached();
    tooLarge = false;
    question = null;
    choice = null;
    if (options.restore) {
      restored = true;
      if (plan.feedCount > 0 && applied.feedCount === 0) notify({ kind: "feeds" });
    }
    await persist();
    if (!live(s)) return;
    phase = "ready";
    publish();
    armSave();
  }

  /** The server could not be asked (or refused the session). */
  async function failed(s: number, error: unknown, what: string): Promise<void> {
    const kind = classifyPlanSyncError(error);
    log(what, errorLabel(error));
    checked = false;
    if (kind === "unauthorized") stopped = true;
    if (phase === "checking" && device) {
      // Without the server: an iPhone with a plan carries on with it (it is saved, or the student is asked, once
      // the server answers). An empty one must not start a new plan over a saved one that could not be looked at.
      let empty = true;
      try {
        empty = isBlankPlan(await device.read());
      } catch (readError) {
        log("read", errorLabel(readError));
      }
      if (!live(s)) return;
      phase = empty ? "unreachable" : "ready";
    }
    if (phase === "ready" && book && kind !== "rate-limited" && (book.dirty || book.owner !== account)) offline = true;
    if (kind === "unauthorized") stopRetry();
    else scheduleRetry(kind);
    publish();
  }

  function scheduleRetry(kind: PlanSyncFailure): void {
    stopRetry();
    const delay = kind === "rate-limited" ? PLAN_RATE_LIMIT_WAIT_MS : retryDelayMs(++failures);
    retryTimer = setTimer(() => {
      retryTimer = null;
      void enqueue(async (s) => {
        if (question !== null) return; // waiting for the student's answer
        if (checked) await save(s, 0);
        else if (phase === "unreachable") await start(s);
        else await check(s);
      });
    }, delay);
  }

  // ── Saving ──────────────────────────────────────────────────

  function armSave(): void {
    stopSaveTimer();
    // While a retry is waiting its turn, it is the one that tries next.
    if (!canSave() || !book?.dirty || retryTimer !== null) return;
    const t = now();
    let at = lastChangeAt + PLAN_SAVE_QUIET_MS;
    if (firstUnsavedAt !== null) at = Math.min(at, firstUnsavedAt + PLAN_SAVE_MAX_WAIT_MS);
    at = Math.max(at, lastSaveAt + PLAN_SAVE_MIN_INTERVAL_MS, waitUntil, t);
    saveTimer = setTimer(() => {
      saveTimer = null;
      void enqueue((s) => save(s, 0));
    }, at - t);
  }

  /** Sends this iPhone's plan over the revision it is at, unless nothing in it changed. */
  async function save(s: number, depth: number): Promise<void> {
    if (!live(s) || !canSave() || !book || !device) return;
    if (!checked) {
      // Not known what the account holds (the last attempt failed): that comes first, and decides.
      await check(s, undefined, depth);
      return;
    }
    if (!book.dirty) {
      publish();
      return;
    }
    // Refused as too large: the same plan is not sent again. The next change to it is (planChanged).
    if (tooLarge) return;
    if (!urgent && now() < waitUntil) {
      armSave();
      return;
    }
    stopSaveTimer();
    const seq = changeSeq;
    const eseq = editSeq;
    const contents = await readPlan(s);
    if (!contents || !live(s) || !book) return;
    // What signing out and deleting the account leave behind is never saved, whatever led here.
    if (isPristineState(contents.state)) return;
    if (isBlankPlan(contents)) {
      if (book.revision === 0) {
        // The account holds nothing and neither does this iPhone.
        book = { ...book, dirty: false, edited: false };
        firstUnsavedAt = null;
        await persist();
        publish();
        return;
      }
      if (!book.edited) {
        // Empty, and the student did not empty it: never a plan to save over the account's. The rules look at what
        // the account holds and bring it back (decideSync).
        await check(s, undefined, depth);
        return;
      }
    }
    if (!urgent) await whenIdle();
    if (!live(s) || !book) return;
    const prepared = preparePlan(contents);
    if (book.owner === account && prepared.hash === book.hash) {
      // The account already holds exactly this.
      if (seq === changeSeq) {
        book = { ...book, dirty: false, edited: false };
        firstUnsavedAt = null;
      }
      offline = false;
      tooLarge = false;
      await persist();
      publish();
      armSave();
      return;
    }
    const encoded = urgent ? encodePlanSnapshot(prepared.json) : await encodePlanSnapshotInSlices(prepared.json, pause);
    if (!live(s) || !book) return;
    if (!encoded.ok) {
      tooLarge = true;
      publish();
      return;
    }
    // Remembered before it leaves: if the answer is lost on the way, the plan the account then holds is recognised
    // as this iPhone's own (ownUnansweredSave).
    const sending = { hash: prepared.hash, chars: encoded.snapshot.length };
    const sentBefore = book.sent;
    book = { ...book, sent: rememberSentSave(sentBefore, sending) };
    await persist();
    if (!live(s) || !book) return;
    saving = true;
    publish();
    let result: PlanSaveResult;
    try {
      result = await deps.transport.save({ baseRevision: book.revision, snapshot: encoded.snapshot, deviceId: book.deviceId });
    } catch (error) {
      if (s !== session) return;
      saving = false;
      if (!live(s) || !book) return;
      if (classifyPlanSyncError(error) !== "unreachable") {
        // The server answered, with a refusal: this save was not stored, so it is not one to look out for.
        book = { ...book, sent: sentBefore };
        await persist();
      }
      await saveFailed(error);
      return;
    }
    if (s !== session) return;
    saving = false;
    lastSaveAt = now();
    // Signing out began while it was on its way: the answer is not recorded (the wipe is next).
    if (!live(s) || !book) return;
    if (!result.saved) {
      // The account's plan is not at that revision any more, and this save was not stored. Whether the plan it does
      // hold is another device's, or an earlier save of this iPhone's whose answer was lost, check() finds out.
      book = { ...book, sent: sentBefore };
      publish();
      if (depth >= 2) {
        // Refused three times in a row: not a loop to stay in (refused saves count toward the server's limit too).
        offline = true;
        checked = false;
        await persist();
        scheduleRetry("unreachable");
        publish();
        return;
      }
      // (No header at all would mean the account's plan is gone: the rules then save this one as its first.)
      await check(s, { header: result.header ?? null }, depth + 1);
      return;
    }
    adopt(result.header, prepared.hash);
    book = { ...book, lastSavedAt: isoNow(), dirty: seq !== changeSeq, edited: eseq !== editSeq };
    firstUnsavedAt = book.dirty ? now() : null;
    reached();
    tooLarge = false;
    await persist();
    publish();
    armSave();
  }

  async function saveFailed(error: unknown): Promise<void> {
    const kind = classifyPlanSyncError(error);
    log("save", errorLabel(error));
    switch (kind) {
      case "rate-limited":
        // Saved a moment ago: simply later.
        waitUntil = now() + PLAN_RATE_LIMIT_WAIT_MS;
        publish();
        armSave();
        return;
      case "too-large":
        tooLarge = true;
        publish();
        return;
      case "unauthorized":
        // Quietly: nothing is asked and nothing is tried again by itself. The row says "not saved" all the same,
        // because it is not (and not "saving", which it is not either).
        stopped = true;
        checked = false;
        offline = true;
        stopRetry();
        publish();
        return;
      case "unreachable":
        offline = true;
        checked = false;
        scheduleRetry(kind);
        publish();
        return;
    }
  }

  /** The plan now on this iPhone, as a safety copy. Null when it could not be made. */
  async function safetyCopy(why: PlanSafetyCopy["why"]): Promise<string | null> {
    if (!device || !book) return null;
    try {
      const prepared = preparePlan(await device.read());
      const encoded = encodePlanSnapshot(prepared.json);
      return serializeSafetyCopy({ v: 1, at: isoNow(), owner: book.owner, why, ...(encoded.ok ? { snapshot: encoded.snapshot } : { json: prepared.json }) });
    } catch (error) {
      log("copy", errorLabel(error));
      return null;
    }
  }

  function sleep(ms: number): { done: Promise<void>; cancel: () => void } {
    let handle: unknown = null;
    const done = new Promise<void>((resolve) => {
      handle = setTimer(resolve, ms);
    });
    return { done, cancel: () => clearTimer(handle) };
  }

  /** Whether signing out now would lose something of the student's. */
  async function unsavedNow(): Promise<boolean> {
    if (account === null || !book || !device) return false;
    // The app's own re-plans do not count: they are made again from the plan that comes back.
    if (book.owner === account) return book.edited;
    try {
      return !isBlankPlan(await device.read());
    } catch {
      return true;
    }
  }

  function retryNow(): void {
    if (account === null || paused || question !== null) return;
    if (phase === "unreachable") {
      phase = "checking";
      failures = 0;
      stopRetry();
      publish();
      void enqueue(start);
      return;
    }
    if (phase !== "ready") return;
    if (offline || blocked || stopped || !checked) {
      failures = 0;
      stopped = false;
      waitUntil = 0;
      stopRetry();
      void enqueue((s) => check(s));
    }
  }

  return {
    getStatus: () => status,
    getPrompt: () => prompt,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    attach(next) {
      if (device === null) pristineAtAttach = isPristineState(next.state());
      device = next;
      void readBook();
      // Signed in before the app state was ready: the session starts now.
      if (account !== null && !paused && phase === "checking") void enqueue(start);
    },

    setAccount(next) {
      if (next === account) return;
      account = next;
      session++;
      stopSaveTimer();
      stopRetry();
      checked = false;
      stopped = false;
      saving = false;
      offline = false;
      tooLarge = false;
      blocked = null;
      question = null;
      choice = null;
      restored = false;
      failures = 0;
      waitUntil = 0;
      if (paused) {
        // Signing out wiped this iPhone (or is about to): what was known about its plan is gone with it.
        book = null;
        bookRead = null;
        pendingDirty = false;
        pendingEdited = false;
      }
      if (next === null) {
        phase = "off";
        publish();
        return;
      }
      paused = false; // a sign-in ends the pause
      phase = "checking";
      publish();
      if (device) void enqueue(start);
    },

    planChanged(change) {
      if (paused || !book) {
        pendingDirty = true;
        pendingEdited = pendingEdited || change.edited;
        if (!paused && device) void readBook();
        return;
      }
      changeSeq++;
      if (change.edited) editSeq++;
      lastChangeAt = now();
      firstUnsavedAt ??= lastChangeAt;
      // Written once, at the first change: if the app is killed before the save, the next launch knows.
      if (!book.dirty || (change.edited && !book.edited)) {
        book = { ...book, dirty: true, edited: book.edited || change.edited };
        void persist();
      }
      tooLarge = false; // a different plan: worth another try
      publish();
      armSave();
    },

    appBecameActive() {
      if (account === null || paused || !book || question !== null || phase === "checking" || phase === "off") return;
      stopped = false;
      if (phase === "unreachable") {
        stopRetry();
        void enqueue(start);
      } else if (!checked || now() - lastCheckAt >= PLAN_FOREGROUND_CHECK_INTERVAL_MS) {
        stopRetry();
        void enqueue((s) => check(s));
      } else {
        armSave();
      }
    },

    appLeftForeground() {
      if (!canSave() || !book?.dirty || now() < waitUntil) return;
      stopSaveTimer();
      void enqueue(async (s) => {
        urgent = true;
        try {
          await save(s, 0);
        } finally {
          urgent = false;
        }
      });
    },

    retry,

    answer(asked, reply) {
      if (asked !== question || paused || account === null) return;
      if (asked.kind === "choose") {
        const picked = choice;
        if (!picked || (reply !== "use-saved" && reply !== "keep-mine")) return;
        question = null;
        publish();
        void enqueue(async (s) => {
          if (!book) return;
          if (reply === "keep-mine") {
            // This iPhone's plan becomes the successor of the one the student was asked about: it is saved over
            // exactly that revision. If the account moved on again meanwhile, the save is refused and they are asked again.
            adopt(picked.header, picked.hash);
            book = { ...book, dirty: true, edited: true };
            choice = null;
            reached();
            await persist();
            if (!live(s)) return;
            phase = "ready";
            publish();
            await save(s, 0);
            return;
          }
          const copy = await safetyCopy("saved-plan-chosen");
          if (!live(s)) return;
          if (copy === null) {
            ask({ kind: "choose", savedAt: picked.header.savedAt });
            return;
          }
          await applyLoaded(s, picked.header, picked.plan, picked.hash, { restore: true, copy });
        });
        return;
      }
      // The plan of another account. "Sign out" is carried out by whoever shows the question; it stays open until
      // the account is gone.
      if (reply !== "continue") return;
      question = null;
      phase = "checking";
      publish();
      void enqueue(async (s) => {
        const copy = await safetyCopy("other-account");
        if (!live(s)) return;
        if (copy === null || !(await replaceOtherAccount(s, copy))) {
          if (live(s)) ask({ kind: "other-account" });
          return;
        }
        await check(s);
      });
    },

    askAgain() {
      if (!question || paused) return;
      question = { ...question };
      publish();
    },

    dismissNotice(notice) {
      const at = notices.indexOf(notice);
      if (at < 0) return;
      notices.splice(at, 1);
      publish();
    },

    async prepareSignOut(options) {
      if (paused) {
        await deviceAtRest();
        return signOutAnswer;
      }
      stopSaveTimer();
      let answer: "saved" | "unsaved" = "saved";
      if (options?.save !== false && account !== null) {
        await readBook();
        const attempt = enqueue(async (s) => {
          if (!canSave() || !book?.dirty) return;
          urgent = true;
          try {
            await save(s, 0);
          } finally {
            urgent = false;
          }
        });
        const limit = sleep(PLAN_SIGN_OUT_WAIT_MS);
        await Promise.race([attempt, limit.done]);
        limit.cancel();
        answer = (await unsavedNow()) ? "unsaved" : "saved";
      }
      paused = true;
      signOutAnswer = answer;
      stopSaveTimer();
      stopRetry();
      // A plan being written to this iPhone at this very moment is let finish first (deleting the account does not
      // wait for a save, and a save that was waited for may have run out of time).
      await deviceAtRest();
      return answer;
    },

    cancelSignOut() {
      if (!paused) return;
      paused = false;
      if (account === null || !book) return;
      if (pendingDirty) {
        book = { ...book, dirty: true, edited: book.edited || pendingEdited };
        pendingDirty = false;
        pendingEdited = false;
        void persist();
      }
      // A save that was on its way when signing out began may have arrived: ask the account before saving again.
      checked = false;
      publish();
      if (phase !== "off") void enqueue(start);
    },

    async idle() {
      let seen: Promise<void>;
      do {
        seen = chain;
        await seen;
      } while (seen !== chain);
    },
  };
}

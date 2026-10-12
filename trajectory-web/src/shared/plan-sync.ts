/**
 * The saved plan, shared by the app and the server (pure, no platform imports).
 *
 * A Trajectory account is required (Sign in with Apple, lib/features.ts ACCOUNT_REQUIRED), and the student's plan is
 * saved to it: the app keeps working from its own copy on the iPhone and sends the server a snapshot when the plan
 * has changed, so the plan is there on a new iPhone, after a reinstall, and later on other devices.
 *
 * One snapshot per account, replaced whole; nothing is ever merged. Every accepted save gets the next revision
 * number, and a device may only save over the revision it last saw. When another device has saved in between, the
 * save is refused (`saved: false`) and the student decides which plan to keep: the app then either loads the saved
 * plan or saves its own again with `force`.
 *
 * The server stores the snapshot exactly as the app wrote it and reads only its envelope (parsePlanEnvelope): the
 * plan inside is gzip-compressed by the app (lib/plan-snapshot.ts), which keeps saves small on a phone connection
 * and in the database. What goes into a plan is the app's business; events read from the iPhone's own calendars
 * never do.
 */

export const PLAN_SNAPSHOT_FORMAT = "trajectory-plan" as const;

/** Version of the plan's own layout inside the envelope (lib/plan-snapshot.ts). A newer app may write a higher one. */
export const PLAN_SNAPSHOT_VERSION = 1;

/** How `data` is encoded: the plan's JSON, gzip-compressed, as base64. */
export const PLAN_ENCODING_GZIP_BASE64 = "gzip-base64" as const;

/**
 * The largest snapshot the server stores, in characters of the envelope's JSON. A full semester with its syllabi
 * compresses to well under 200,000.
 */
export const MAX_PLAN_SNAPSHOT_CHARS = 4_000_000;

/** A device's own random id, made by the app at its first launch (never a hardware id). */
export const PLAN_DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * What every snapshot is: a small JSON object around the encoded plan.
 *   {"format":"trajectory-plan","v":1,"encoding":"gzip-base64","data":"H4sIA..."}
 */
export interface PlanSnapshotEnvelope {
  format: typeof PLAN_SNAPSHOT_FORMAT;
  /** PLAN_SNAPSHOT_VERSION of the app that wrote it. */
  v: number;
  encoding: string;
  data: string;
}

/**
 * The envelope of a snapshot string, or null when it is not one. All the server checks before storing a snapshot
 * (it never decodes `data`), and the app's first step when it loads one.
 */
export function parsePlanEnvelope(snapshot: unknown): PlanSnapshotEnvelope | null {
  if (typeof snapshot !== "string" || snapshot.length < 2 || snapshot.length > MAX_PLAN_SNAPSHOT_CHARS) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const { format, v, encoding, data } = parsed as Record<string, unknown>;
  if (format !== PLAN_SNAPSHOT_FORMAT) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) return null;
  if (typeof encoding !== "string" || !encoding || typeof data !== "string") return null;
  return { format, v, encoding, data };
}

/** What the server keeps about a saved plan besides the plan itself. */
export interface PlanHeader {
  /** Counts the accepted saves of this account's plan, starting at 1. */
  revision: number;
  /** When the server stored it (ISO 8601). */
  savedAt: string;
  /** The saving device's id (PLAN_DEVICE_ID_PATTERN): tells "this iPhone's own save" from another device's. */
  deviceId: string;
  /** Length of the stored snapshot in characters. */
  chars: number;
}

/** `plan.load`: the account's saved plan, or null when nothing has been saved yet. */
export interface SavedPlan {
  header: PlanHeader;
  snapshot: string;
}

/** `plan.save` input. */
export interface PlanSaveInput {
  /** The revision this device last saved or loaded; 0 when it believes the account has no saved plan. */
  baseRevision: number;
  snapshot: string;
  deviceId: string;
  /** Save even though the account's plan has moved on: only after the student chose to keep this device's plan. */
  force?: boolean;
}

/**
 * `plan.save` answer. `saved: false` is a conflict: the account's plan is not at `baseRevision` any more (another
 * device saved, or one exists and `baseRevision` was 0). Nothing was stored; `header` describes what is saved now.
 */
export type PlanSaveResult = { saved: true; header: PlanHeader } | { saved: false; header: PlanHeader };

/** Refusals of plan.save that are not conflicts (tRPC BAD_REQUEST / PAYLOAD_TOO_LARGE). */
export const PLAN_NOT_A_SNAPSHOT_MSG = "That is not a Trajectory plan.";
export const PLAN_TOO_LARGE_MSG = "This plan is too large to save to your account.";
/** plan.* is for Sign in with Apple accounts; a guest session (older builds) is refused with this (FORBIDDEN). */
export const PLAN_NEEDS_ACCOUNT_MSG = "Sign in with Apple to save your plan to your account.";
/** plan.save is limited per account (TOO_MANY_REQUESTS); the app simply tries again later. */
export const PLAN_SAVE_RATE_LIMIT_MSG = "Your plan was saved a moment ago. It will be saved again shortly.";

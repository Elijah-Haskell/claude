// What the AI helper's callers need without loading the Gemini client: the failure kinds and the default model.
// gemini-3.8-flash is the newest stable Flash and the mobile app's fast tier (server/_core/llm.ts, checked 2026-10-02).

export const DEFAULT_AI_MODEL = "gemini-3.8-flash";

export type AiFailureKind = "auth" | "rate" | "refusal" | "network" | "unusable" | "other";

export class AiError extends Error {
  constructor(public readonly kind: AiFailureKind, message: string) {
    super(message);
    this.name = "AiError";
  }
}

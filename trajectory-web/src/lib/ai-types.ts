// What the AI helper's callers need without loading the Anthropic SDK: the failure kinds and the default model.

export const DEFAULT_AI_MODEL = "claude-opus-5-5";

export type AiFailureKind = "auth" | "rate" | "refusal" | "network" | "unusable" | "other";

export class AiError extends Error {
  constructor(public readonly kind: AiFailureKind, message: string) {
    super(message);
    this.name = "AiError";
  }
}

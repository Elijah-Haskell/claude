export const AI_CONSENT_STORAGE_KEY = "trajectory.ai-data-sharing-consent.v1";
export const AI_CONSENT_GRANTED_VALUE = "granted";

/** Returns true only after the user has made an affirmative AI-processing choice. */
export function isAIConsentGranted(value: string | null): boolean {
  return value === AI_CONSENT_GRANTED_VALUE;
}

/** Matches tRPC batch URLs that include one or more AI procedures. */
export function requiresAIConsent(url: string): boolean {
  return /\/api\/trpc\/[^?]*\bai\./.test(url);
}

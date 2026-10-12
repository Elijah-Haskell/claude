/**
 * The AI data-sharing consent, outside React: the API client asks here before it sends an AI procedure
 * (lib/ai-consent-utils.ts says which URLs those are), and the provider in src/state/ai-consent.tsx registers how the
 * question is asked. Without a provider the stored answer decides.
 */
import { AI_CONSENT_STORAGE_KEY, isAIConsentGranted } from "./ai-consent-utils";
import { readLocal } from "./storage";

export { AI_CONSENT_GRANTED_VALUE, AI_CONSENT_STORAGE_KEY, isAIConsentGranted, requiresAIConsent } from "./ai-consent-utils";

let consentRequester: (() => Promise<boolean>) | null = null;

/** The provider registers how consent is asked for; returns the unregister. */
export function setAIConsentRequester(requester: (() => Promise<boolean>) | null): () => void {
  consentRequester = requester;
  return () => {
    if (consentRequester === requester) consentRequester = null;
  };
}

/** Allows the API client to request consent before it sends an AI procedure. */
export async function requestAIProcessingConsent(): Promise<boolean> {
  if (consentRequester) return consentRequester();
  return isAIConsentGranted(readLocal(AI_CONSENT_STORAGE_KEY));
}

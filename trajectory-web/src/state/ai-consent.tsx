/**
 * The AI data-sharing consent (the iPhone app's lib/ai-consent-context.tsx): asked once, before the first AI request,
 * and remembered in this browser. The API client asks through lib/ai-consent.ts; the provider here registers how the
 * question is shown (a sheet over everything).
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { AI_CONSENT_GRANTED_VALUE, AI_CONSENT_STORAGE_KEY, isAIConsentGranted, setAIConsentRequester } from "../lib/ai-consent";
import { readLocal, writeLocal } from "../lib/storage";
import { Icon } from "../ui/icon";
import { PrimaryButton } from "../ui/primitives";
import { Sheet, SheetBody } from "../ui/sheet";
import { useColors } from "../ui/theme";

type AIConsentStatus = "loading" | "granted" | "not_granted";

interface AIConsentContextValue {
  isConsentGranted: boolean;
  consentStatus: AIConsentStatus;
  requestAIConsent: () => Promise<boolean>;
  withdrawAIConsent: () => Promise<void>;
  promptVisible: boolean;
  answerPrompt: (accepted: boolean) => void;
}

const AIConsentContext = createContext<AIConsentContextValue | null>(null);

function ConsentSheet({ visible, onAccept, onDecline }: { visible: boolean; onAccept: () => void; onDecline: () => void }) {
  const colors = useColors();
  return (
    <Sheet open={visible} onClose={onDecline} ariaLabel="Before you use AI">
      <SheetBody gap={12}>
        <span style={{ width: 42, height: 42, borderRadius: 21, display: "inline-flex", alignItems: "center", justifyContent: "center", background: `${colors.violet}22` }}>
          <Icon name="spark" size={22} color={colors.violet} />
        </span>
        <h2 style={{ margin: 0, fontSize: 24, fontWeight: 800, letterSpacing: -0.4, color: colors.foreground }}>Before you use AI</h2>
        <p style={{ margin: 0, fontSize: 14, lineHeight: "20px", color: colors.muted }}>AI features are optional. Please review what is shared before continuing.</p>
        <div style={{ border: `1px solid ${colors.border}`, borderRadius: 14, padding: 14, display: "flex", flexDirection: "column", gap: 8, background: colors.surface }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: colors.foreground }}>What Trajectory sends</div>
          <p style={{ margin: 0, fontSize: 12.5, lineHeight: "17px", color: colors.muted }}>
            When you choose an AI feature, Trajectory sends the content needed for your request to our server, which passes it to Google Gemini (Google's paid Gemini API, which does not use it to improve its products). This may include your message, course and task names, deadlines, schedule details, the app's short notes on your study habits, and the syllabus text, images, or files you select.
          </p>
          <p style={{ margin: 0, fontSize: 12.5, lineHeight: "17px", color: colors.muted }}>Trajectory uses this data to answer requests, analyze syllabi, create study materials, and suggest schedules. Do not submit information you do not want processed by these services.</p>
        </div>
        <p style={{ margin: 0, fontSize: 12.5, lineHeight: "17px", color: colors.muted }}>You can turn off AI processing anytime from Privacy Policy in Settings. Core planning features still work without it.</p>
        <PrimaryButton size="lg" fullWidth tone="violet" label="Agree and Continue" onPress={onAccept} />
        <PrimaryButton size="lg" fullWidth tone="ghost" label="Not Now" onPress={onDecline} />
      </SheetBody>
    </Sheet>
  );
}

export function AIConsentProvider({ children }: { children: ReactNode }) {
  const [consentStatus, setConsentStatus] = useState<AIConsentStatus>(() => (isAIConsentGranted(readLocal(AI_CONSENT_STORAGE_KEY)) ? "granted" : "not_granted"));
  const [promptVisible, setPromptVisible] = useState(false);
  const pendingRef = useRef<((accepted: boolean) => void) | null>(null);

  useEffect(() => () => {
    pendingRef.current?.(false);
    pendingRef.current = null;
  }, []);

  const requestAIConsent = useCallback(async (): Promise<boolean> => {
    if (isAIConsentGranted(readLocal(AI_CONSENT_STORAGE_KEY))) {
      setConsentStatus("granted");
      return true;
    }
    return new Promise((resolve) => {
      pendingRef.current?.(false);
      pendingRef.current = resolve;
      setConsentStatus("not_granted");
      setPromptVisible(true);
    });
  }, []);

  const resolvePrompt = useCallback((accepted: boolean) => {
    if (accepted) {
      writeLocal(AI_CONSENT_STORAGE_KEY, AI_CONSENT_GRANTED_VALUE);
      setConsentStatus("granted");
    } else {
      writeLocal(AI_CONSENT_STORAGE_KEY, null);
      setConsentStatus("not_granted");
    }
    setPromptVisible(false);
    pendingRef.current?.(accepted);
    pendingRef.current = null;
  }, []);

  const withdrawAIConsent = useCallback(async () => {
    writeLocal(AI_CONSENT_STORAGE_KEY, null);
    setConsentStatus("not_granted");
  }, []);

  useEffect(() => setAIConsentRequester(requestAIConsent), [requestAIConsent]);

  return (
    <AIConsentContext.Provider value={{ isConsentGranted: consentStatus === "granted", consentStatus, requestAIConsent, withdrawAIConsent, promptVisible, answerPrompt: resolvePrompt }}>
      {children}
      <ConsentSheet visible={promptVisible} onAccept={() => resolvePrompt(true)} onDecline={() => resolvePrompt(false)} />
    </AIConsentContext.Provider>
  );
}

export function useAIConsent(): AIConsentContextValue {
  const context = useContext(AIConsentContext);
  if (!context) throw new Error("useAIConsent must be used within AIConsentProvider");
  return context;
}

// The other way in, beside Sign in with Apple on the sign-in screen: Google's own button. It ends with the server's
// { sessionToken, user }, which the sign-in screen finishes like an Apple sign-in.

import { useEffect, useRef, useState } from "react";

import { errorMessage, mutate, type SignInResult } from "../lib/api";
import { renderGoogleButton } from "../lib/google-signin";
import { useColors } from "../ui/theme";

/** Google's "Continue with Google" button, drawn by Google, the width of the column. */
export function GoogleSignInButton({ onSignedIn, onError, disabled }: { onSignedIn: (result: SignInResult) => Promise<void>; onError: (message: string) => void; disabled: boolean }) {
  const colors = useColors();
  const holder = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const handlers = useRef({ onSignedIn, onError });
  handlers.current = { onSignedIn, onError };

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    let active = true;
    renderGoogleButton(
      el,
      (credential) => {
        void (async () => {
          try {
            const result = await mutate("auth.google", credential, { quiet: true, timeoutMs: 20_000 });
            await handlers.current.onSignedIn(result);
          } catch (error) {
            handlers.current.onError(errorMessage(error, "Google could not complete the sign-in. Please try again."));
          }
        })();
      },
      el.getBoundingClientRect().width || 360,
    ).catch((error: unknown) => {
      if (active) setFailed(error instanceof Error ? error.message : "Google sign-in could not be loaded.");
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, opacity: disabled ? 0.6 : 1, pointerEvents: disabled ? "none" : undefined }}>
      <div ref={holder} aria-label="Continue with Google" style={{ minHeight: 44, display: "flex", justifyContent: "center", colorScheme: "light" }} />
      {failed ? <p className="caption" role="alert" style={{ margin: 0, textAlign: "center", color: colors.gold }}>{failed}</p> : null}
    </div>
  );
}

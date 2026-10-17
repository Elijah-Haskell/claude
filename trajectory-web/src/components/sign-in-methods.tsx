// The other ways in, beside Sign in with Apple on the sign-in screen: Google's own button, and a code sent by email.
// Each one ends with the server's { sessionToken, user }, which the sign-in screen finishes like an Apple sign-in.

import { useEffect, useRef, useState, type FormEvent } from "react";

import { errorMessage, mutate, type SignInResult } from "../lib/api";
import { codeDigits, looksLikeEmail, normalizeEmail } from "../lib/email-signin";
import { renderGoogleButton } from "../lib/google-signin";
import { PrimaryButton } from "../ui/primitives";
import { useColors } from "../ui/theme";

/** Seconds before "Send a new code" works again (the server limits sends as well). */
const RESEND_AFTER_S = 30;

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

/** "or", between the buttons and the email form. */
export function OrDivider() {
  const colors = useColors();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "2px 0" }} aria-hidden="true">
      <span style={{ flex: 1, height: 1, background: colors.border }} />
      <span style={{ fontSize: 12.5, color: colors.muted }}>or</span>
      <span style={{ flex: 1, height: 1, background: colors.border }} />
    </div>
  );
}

/** Email sign-in: the address, then the 6-digit code from the email. */
export function EmailSignIn({ onSignedIn, disabled }: { onSignedIn: (result: SignInResult) => Promise<void>; disabled: boolean }) {
  const colors = useColors();
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wait, setWait] = useState(0);

  useEffect(() => {
    if (wait <= 0) return;
    const timer = setTimeout(() => setWait((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [wait]);

  async function send(address: string) {
    setBusy(true);
    setError(null);
    try {
      await mutate("auth.emailStart", { email: address }, { quiet: true, timeoutMs: 20_000 });
      setSentTo(address);
      setCode("");
      setWait(RESEND_AFTER_S);
    } catch (err) {
      setError(errorMessage(err, "We could not send the code. Please try again."));
    } finally {
      setBusy(false);
    }
  }

  async function submitEmail(event: FormEvent) {
    event.preventDefault();
    if (!looksLikeEmail(email)) {
      setError("Enter your email address, like name@school.edu.");
      return;
    }
    await send(normalizeEmail(email));
  }

  async function submitCode(event: FormEvent) {
    event.preventDefault();
    const digits = codeDigits(code);
    if (!sentTo || !digits) {
      setError("Enter the 6-digit code from the email.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await mutate("auth.emailVerify", { email: sentTo, code: digits }, { quiet: true, timeoutMs: 20_000 });
      await onSignedIn(result);
    } catch (err) {
      setError(errorMessage(err, "That code didn't work. Check it, or send a new one."));
      setBusy(false);
    }
  }

  const off = disabled || busy;
  if (!sentTo) {
    return (
      <form onSubmit={(event) => void submitEmail(event)} style={{ display: "flex", flexDirection: "column", gap: 10 }} noValidate>
        <input className="input" type="email" inputMode="email" autoComplete="email" placeholder="you@school.edu" aria-label="Email address" value={email} onChange={(e) => setEmail(e.target.value)} disabled={off} />
        {error ? <p role="alert" className="caption" style={{ margin: 0, color: colors.error }}>{error}</p> : null}
        <PrimaryButton type="submit" size="lg" fullWidth tone="ghost" label="Email me a code" loading={busy} disabled={off} />
      </form>
    );
  }
  return (
    <form onSubmit={(event) => void submitCode(event)} style={{ display: "flex", flexDirection: "column", gap: 10 }} noValidate>
      <p style={{ margin: 0, fontSize: 14, lineHeight: "20px", color: colors.muted }} role="status">
        We sent a 6-digit code to <span style={{ color: colors.foreground, fontWeight: 600 }}>{sentTo}</span>. It works for 10 minutes.
      </p>
      <input className="input" inputMode="numeric" autoComplete="one-time-code" placeholder="123456" aria-label="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} maxLength={9} disabled={off} autoFocus style={{ letterSpacing: 6, fontSize: 20, textAlign: "center" }} />
      {error ? <p role="alert" className="caption" style={{ margin: 0, color: colors.error }}>{error}</p> : null}
      <PrimaryButton type="submit" size="lg" fullWidth label="Sign in" loading={busy} disabled={off} />
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <button type="button" className="link" onClick={() => { setSentTo(null); setError(null); }} disabled={off} style={{ minHeight: 40, fontSize: 13.5 }}>Use a different email</button>
        <button type="button" className="link" onClick={() => void send(sentTo)} disabled={off || wait > 0} style={{ minHeight: 40, fontSize: 13.5, opacity: wait > 0 ? 0.6 : 1 }}>
          {wait > 0 ? `Send a new code in ${wait}s` : "Send a new code"}
        </button>
      </div>
    </form>
  );
}

/**
 * Sign in with Apple on the web ("Sign in with Apple JS"): Apple's script is loaded on demand, initialised with the
 * Services ID registered for this origin (VITE_APPLE_CLIENT_ID), and the popup's answer is turned into exactly what
 * the server's `auth.apple` takes from the iPhone app: the identity token, Apple's user id (the token's subject), the
 * name and e-mail Apple shares at the first sign-in, and the one-time authorization code the server exchanges so that
 * deleting the account can revoke the grant.
 *
 * Each sign-in makes a fresh random nonce: Apple gets its SHA-256 (it comes back inside the identity token) and the
 * server gets the raw value, which it must hash to the token's claim. The server requires this for a web token
 * (APPLE_WEB_SERVICES_ID; see SERVER_CHANGES.md), so a token picked up elsewhere cannot be replayed.
 */
import { APPLE_CLIENT_ID, APPLE_REDIRECT_URI } from "./config";

const SCRIPT_URL = "https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js";

interface AppleAuthResponse {
  authorization: { code: string; id_token: string; state?: string };
  user?: { email?: string; name?: { firstName?: string; lastName?: string } };
}

interface AppleIDGlobal {
  auth: {
    init(config: { clientId: string; scope: string; redirectURI: string; state?: string; nonce?: string; usePopup: boolean }): void;
    signIn(config?: Record<string, unknown>): Promise<AppleAuthResponse>;
  };
}

declare global {
  interface Window {
    AppleID?: AppleIDGlobal;
  }
}

/** What `auth.apple` takes (the same fields the iPhone sends from expo-apple-authentication). */
export interface AppleWebCredential {
  identityToken: string;
  appleUserId: string;
  email?: string;
  givenName?: string;
  familyName?: string;
  authorizationCode?: string;
  /** The raw nonce whose SHA-256 Apple put in the identity token. */
  nonce?: string;
}

/** Whether this build can offer Sign in with Apple at all (a Services ID is configured). */
export function appleSignInAvailable(): boolean {
  return APPLE_CLIENT_ID.trim() !== "";
}

let loading: Promise<AppleIDGlobal> | null = null;

function loadAppleScript(): Promise<AppleIDGlobal> {
  if (window.AppleID) return Promise.resolve(window.AppleID);
  loading ??= new Promise<AppleIDGlobal>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => (window.AppleID ? resolve(window.AppleID) : reject(new Error("Apple's sign-in script did not load.")));
    script.onerror = () => {
      loading = null;
      reject(new Error("Apple's sign-in script could not be loaded. Check your connection and try again."));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/** The payload of a JWT, without checking its signature (the server does that): only `sub` is read here. */
function jwtSubject(token: string): string {
  const part = token.split(".")[1];
  if (!part) return "";
  try {
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const payload = JSON.parse(decodeURIComponent(escape(atob(base64)))) as { sub?: unknown };
    return typeof payload.sub === "string" ? payload.sub : "";
  } catch {
    return "";
  }
}

function randomHex(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 (hex) of a string: what Apple is given as the nonce for the raw value the server receives. */
export async function nonceDigest(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Errors Apple's script rejects with when the student closed the popup or declined. */
const CANCELLED = new Set(["popup_closed_by_user", "user_cancelled_authorize", "user_trigger_new_signin_flow"]);

/**
 * Opens Apple's sign-in popup. Resolves to the credential, or to null when the student closed it. Throws when Apple
 * could not be reached or answered without a token.
 */
export async function signInWithApple(): Promise<AppleWebCredential | null> {
  if (!appleSignInAvailable()) throw new Error("Sign in with Apple is not set up for this website yet.");
  const AppleID = await loadAppleScript();
  const state = randomHex(16);
  const nonce = randomHex(32);
  AppleID.auth.init({ clientId: APPLE_CLIENT_ID, scope: "name email", redirectURI: APPLE_REDIRECT_URI, state, nonce: await nonceDigest(nonce), usePopup: true });
  let response: AppleAuthResponse;
  try {
    response = await AppleID.auth.signIn();
  } catch (error) {
    const code = (error as { error?: unknown } | null)?.error;
    if (typeof code === "string" && CANCELLED.has(code)) return null;
    throw new Error("Apple could not complete the sign-in. Please try again.");
  }
  if (response?.authorization?.state !== undefined && response.authorization.state !== state) {
    throw new Error("Apple's answer did not match this sign-in. Please try again.");
  }
  const identityToken = response?.authorization?.id_token;
  if (!identityToken) throw new Error("Apple did not return a sign-in token. Please try again.");
  const appleUserId = jwtSubject(identityToken);
  if (!appleUserId) throw new Error("Apple's sign-in token could not be read. Please try again.");
  return {
    identityToken,
    appleUserId,
    email: response.user?.email || undefined,
    givenName: response.user?.name?.firstName || undefined,
    familyName: response.user?.name?.lastName || undefined,
    authorizationCode: response.authorization.code || undefined,
    nonce,
  };
}

/**
 * Sign in with Google on the web (Google Identity Services): Google's script is loaded on demand and draws its own
 * "Continue with Google" button; a click gives an ID token, which the server's `auth.google` checks. Each button gets
 * a fresh random nonce: Google is given its SHA-256 (it comes back inside the ID token) and the server the raw value,
 * so a token picked up elsewhere cannot be replayed (the same scheme as Sign in with Apple, src/lib/apple-signin.ts).
 */
import { nonceDigest } from "./apple-signin";
import { GOOGLE_CLIENT_ID } from "./config";

const SCRIPT_URL = "https://accounts.google.com/gsi/client";

interface GoogleCredentialResponse {
  credential?: string;
}

interface GoogleIdApi {
  initialize(config: { client_id: string; callback: (response: GoogleCredentialResponse) => void; nonce?: string; auto_select?: boolean; cancel_on_tap_outside?: boolean; ux_mode?: "popup" | "redirect"; itp_support?: boolean }): void;
  renderButton(parent: HTMLElement, options: { type?: "standard"; theme?: "outline" | "filled_blue" | "filled_black"; size?: "large" | "medium" | "small"; text?: "signin_with" | "signup_with" | "continue_with" | "signin"; shape?: "rectangular" | "pill" | "circle" | "square"; logo_alignment?: "left" | "center"; width?: number }): void;
  disableAutoSelect?(): void;
}

declare global {
  interface Window {
    google?: { accounts?: { id?: GoogleIdApi } };
  }
}

/** What `auth.google` takes. */
export interface GoogleWebCredential {
  idToken: string;
  nonce: string;
}

/** Whether this build offers Google sign-in (a web client id is configured). */
export function googleSignInAvailable(): boolean {
  return GOOGLE_CLIENT_ID !== "";
}

let loading: Promise<GoogleIdApi> | null = null;

function loadGoogleScript(): Promise<GoogleIdApi> {
  const ready = window.google?.accounts?.id;
  if (ready) return Promise.resolve(ready);
  loading ??= new Promise<GoogleIdApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => {
      const api = window.google?.accounts?.id;
      if (api) resolve(api);
      else reject(new Error("Google's sign-in script did not load."));
    };
    script.onerror = () => {
      loading = null;
      reject(new Error("Google's sign-in script could not be loaded. Check your connection and try again."));
    };
    document.head.appendChild(script);
  });
  return loading;
}

function randomHex(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Draws Google's button into `parent`. A click that ends in a sign-in calls `onCredential` with the ID token and the
 * raw nonce. Resolves once the button is drawn; rejects when Google's script cannot be loaded.
 */
export async function renderGoogleButton(parent: HTMLElement, onCredential: (credential: GoogleWebCredential) => void, width: number): Promise<void> {
  if (!googleSignInAvailable()) throw new Error("Google sign-in is not set up for this website.");
  const api = await loadGoogleScript();
  const nonce = randomHex(32);
  api.initialize({
    client_id: GOOGLE_CLIENT_ID,
    nonce: await nonceDigest(nonce),
    auto_select: false,
    cancel_on_tap_outside: true,
    ux_mode: "popup",
    itp_support: true,
    callback: (response) => {
      if (response.credential) onCredential({ idToken: response.credential, nonce });
    },
  });
  parent.replaceChildren();
  api.renderButton(parent, { type: "standard", theme: "filled_black", size: "large", text: "continue_with", shape: "rectangular", logo_alignment: "center", width: Math.max(200, Math.min(400, Math.round(width))) });
}

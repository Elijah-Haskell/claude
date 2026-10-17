/**
 * Release switches and build-time configuration for the web app (the mobile app's lib/features.ts and constants).
 * Every screen reads them from here, so changing one is a one-line change.
 */
import { PRODUCTION_API_BASE_URL } from "../shared/const";

const env = import.meta.env;

/** The Trajectory API this web app talks to: the same server, accounts and saved plans as the iPhone app. */
export const API_BASE_URL: string = (env.VITE_API_BASE_URL || PRODUCTION_API_BASE_URL).replace(/\/+$/, "");

/** Sign in with Apple JS: the Services ID for this web origin (not the iOS bundle id). */
export const APPLE_CLIENT_ID: string = env.VITE_APPLE_CLIENT_ID ?? "";

/** The Return URL registered for that Services ID: by default the page itself. */
export const APPLE_REDIRECT_URI: string =
  env.VITE_APPLE_REDIRECT_URI || (typeof window !== "undefined" ? `${window.location.origin}${window.location.pathname}` : "");

/** RevenueCat Web Billing public key. */
export const REVENUECAT_WEB_KEY: string = env.VITE_REVENUECAT_WEB_KEY ?? "";

/**
 * A Trajectory account is required (owner decision, 5 October 2026): Sign in with Apple on the first screen, the plan
 * saved to the account, Trajectory Pro tied to it. `VITE_ACCOUNT_REQUIRED=false` builds the browser preview the
 * mobile repo also has (no account, the plan stays in this browser), for screenshots and the smoke test.
 */
export const ACCOUNT_REQUIRED: boolean = env.VITE_ACCOUNT_REQUIRED !== "false";

export function accountRequired(): boolean {
  return ACCOUNT_REQUIRED;
}

/** Build-time only: a test sign-in on the welcome screen against the mock server. Tree-shaken out otherwise. */
export const TEST_SIGN_IN: boolean = import.meta.env.VITE_TEST_SIGN_IN === "1";

/**
 * Build-time only: Trajectory AI treats this browser as holding Trajectory Pro (the mock server grants Pro with
 * MOCK_PRO=1, but the browser only learns Pro from RevenueCat, which a test build has no key for). Tree-shaken out otherwise.
 */
export const TEST_PRO: boolean = import.meta.env.VITE_TEST_PRO === "1";

/** Google Identity Services web client id; empty hides "Continue with Google". */
export const GOOGLE_CLIENT_ID: string = (import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "").trim();

/** Sign-in with a code sent by email (off unless the build says so: the server has to be able to send it). */
export const EMAIL_SIGN_IN: boolean = import.meta.env.VITE_EMAIL_SIGN_IN === "1";

/**
 * Connecting Google Calendar through Trajectory's server is retired in the mobile app (Google's verification of the
 * calendar permission would block the App Store launch). Students who connected before keep a section on the
 * Calendars screen to sync or disconnect; the server endpoints stay.
 */
export const GOOGLE_CALENDAR_CONNECT_OFFERED: boolean = false;

/** Shown at the foot of Settings and in support e-mails. */
export const APP_VERSION = "1.1.0 (web)";

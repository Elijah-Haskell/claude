/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The Trajectory API (the same server the iPhone app uses). Default: the production API. */
  readonly VITE_API_BASE_URL?: string;
  /** Sign in with Apple JS: the Services ID registered for this web origin. Without it the sign-in button says so. */
  readonly VITE_APPLE_CLIENT_ID?: string;
  /** The Return URL registered with that Services ID. Default: this page's origin and path. */
  readonly VITE_APPLE_REDIRECT_URI?: string;
  /** RevenueCat Web Billing public key (rcb_...). Without it the paywall shows no prices and cannot sell. */
  readonly VITE_REVENUECAT_WEB_KEY?: string;
  /** "false" = the browser preview: no account, the plan stays in this browser (for screenshots and the smoke test). */
  readonly VITE_ACCOUNT_REQUIRED?: string;
  /** "1" = the welcome screen offers a test sign-in against a mock server (tests/mock-server.mjs). Never in production. */
  readonly VITE_TEST_SIGN_IN?: string;
  /** "1" = Trajectory AI treats this browser as Pro, for the browser test against the mock server (MOCK_PRO=1). Never in production. */
  readonly VITE_TEST_PRO?: string;
  /** Google Identity Services web client id: shows "Continue with Google" (the server must accept it). */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
  /** "1" shows sign-in with an emailed code (the server must be able to send it). */
  readonly VITE_EMAIL_SIGN_IN?: string;
}

export const COOKIE_NAME = "app_session_id";
export const ONE_YEAR_MS = 1000 * 60 * 60 * 24 * 365;
export const AXIOS_TIMEOUT_MS = 30_000;
export const UNAUTHED_ERR_MSG = "Please login (10001)";
export const NOT_ADMIN_ERR_MSG = "You do not have required permission (10002)";

// ── The production API host ───────────────────────────────────────────────────

/**
 * The durable production API (DigitalOcean App Platform since October 2026, before that Manus's
 * studysched-ijzbm9vp.manus.space). lib/release-endpoint.ts pins released native builds to it.
 */
export const PRODUCTION_API_BASE_URL = "https://api.trajectoryapp.org";

// ── Public web pages on the API host ──────────────────────────────────────────
// The API server's own copy of the legal pages: server/legal-pages.ts serves /privacy, /terms and /support and builds
// their links from these. They stay on the API host, not the website: the pages link to each other by these paths,
// which only this server answers (the website's copies are privacy.html etc.), so pointing them at the website would
// break that navigation. The app, App Store Connect and the website itself use the website's pages below; these are
// the copy that is always there wherever the API runs.

/** The host serving the pages below: the production API itself. */
export const PUBLIC_WEB_BASE_URL = PRODUCTION_API_BASE_URL;
export const PUBLIC_PRIVACY_URL = `${PUBLIC_WEB_BASE_URL}/privacy`;
export const PUBLIC_TERMS_URL = `${PUBLIC_WEB_BASE_URL}/terms`;
export const PUBLIC_SUPPORT_URL = `${PUBLIC_WEB_BASE_URL}/support`;

// ── The website's legal and support pages (trajectoryapp.org) ─────────────────
// Static pages with no scripts. Every link in the app opens these (components/ui/support-links.ts): Settings' Help and
// Terms rows and the paywall's Terms of Use and Privacy Policy links.

export const WEBSITE_BASE_URL = "https://www.trajectoryapp.org";
export const WEBSITE_PRIVACY_URL = `${WEBSITE_BASE_URL}/privacy.html`;
export const WEBSITE_TERMS_URL = `${WEBSITE_BASE_URL}/terms.html`;
export const WEBSITE_SUPPORT_URL = `${WEBSITE_BASE_URL}/support.html`;
export const WEBSITE_DELETE_ACCOUNT_URL = `${WEBSITE_BASE_URL}/delete-account.html`;

export const SUPPORT_EMAIL = "elijahhaskell@trajectoryapp.org";
/** Apple's standard EULA, which governs subscriptions bought in the App Store. */
export const APPLE_STANDARD_EULA_URL = "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/";

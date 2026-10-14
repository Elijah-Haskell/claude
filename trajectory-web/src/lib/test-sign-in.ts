/**
 * The credential the mock server (tests/mock-server.mjs) accepts, for test builds made with VITE_TEST_SIGN_IN=1. Loaded
 * on demand by the welcome screen's test button, so a production build never downloads it; the real server would
 * refuse it anyway (it verifies Apple's signature).
 */
export const testCredential = {
  identityToken: "test.identity.token-for-the-mock-server",
  appleUserId: "test-student",
  email: "student@example.com",
  givenName: "Test",
  familyName: "Student",
};

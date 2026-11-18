// Who is signed in, and signing out. (The user menu itself lives in ui/shell.js.)
//
// The app shell calls:
//   checkSignIn()      -> the signed-in person, or null (and shows the sign-in screens)
//   signOut()

import { replace } from "./dom.js";
import { get, post } from "./api.js";
import { state } from "./state.js";
import { authScreen } from "./views/signin.js";

/**
 * Ask the server who we are. If nobody is signed in (or they must choose a new password,
 * or they followed a reset link), draw the right screen into `root` and return null.
 */
export async function checkSignIn(root) {
  const st = await get("/auth/status");
  const resetting = /^#\/reset\//.test(location.hash);
  if (st.signedIn && !st.user.mustChangePassword && !resetting) {
    state.account = st.user;
    state.me = st.user.id;
    return st.user;
  }
  document.body.classList.add("signed-out");
  replace(root, authScreen(st));
  return null;
}

export async function signOut() {
  try {
    await post("/auth/sign-out");
  } finally {
    state.account = null;
    // A full page load (no hash change first, which would re-render the old screen).
    location.replace("/");
  }
}

/** When the session runs out mid-work, go back to the sign-in screen. */
window.addEventListener("lawdesk:signed-out", () => {
  if (!state.account) return;
  state.account = null;
  location.reload();
});

export const isAdmin = () => state.account?.role === "admin";

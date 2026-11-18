// Who is signed in, the user menu in the header, and signing out.
//
// The app shell calls:
//   checkSignIn()      -> the signed-in person, or null (and shows the sign-in screens)
//   renderUserMenu()   -> the header's name button with "My account" and "Sign out"
//   signOut()

import { h, replace } from "./dom.js";
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

let openMenu = null;

function closeMenu() {
  if (!openMenu) return;
  openMenu.menu.hidden = true;
  openMenu.button.setAttribute("aria-expanded", "false");
  openMenu = null;
}

document.addEventListener("click", (e) => {
  if (openMenu && !openMenu.wrap.contains(e.target)) closeMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && openMenu) {
    const b = openMenu.button;
    closeMenu();
    b.focus();
  }
});

/** The signed-in person's name with a small menu. */
export function renderUserMenu() {
  const a = state.account;
  if (!a) return h("span");
  const menu = h(
    "div.user-menu-list",
    { role: "menu", hidden: true },
    h("div.user-menu-who", h("strong", a.name), h("span.muted.small", a.email), h("span.muted.small", a.roleLabel)),
    h("a.user-menu-item", { role: "menuitem", href: "#/account", onclick: () => closeMenu() }, "My account"),
    h("button.user-menu-item", { type: "button", role: "menuitem", onclick: () => signOut() }, "Sign out"),
  );
  const button = h(
    "button.user-menu-button",
    {
      type: "button",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      onclick: (e) => {
        e.stopPropagation();
        if (openMenu) return closeMenu();
        menu.hidden = false;
        button.setAttribute("aria-expanded", "true");
        openMenu = { wrap, menu, button };
        menu.querySelector(".user-menu-item")?.focus();
      },
    },
    h("span.user-menu-name", a.name),
    h("span.user-menu-caret", { "aria-hidden": "true" }, "▾"),
  );
  const wrap = h("div.user-menu", button, menu);
  return wrap;
}

export const isAdmin = () => state.account?.role === "admin";

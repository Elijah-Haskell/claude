import { describe, expect, it } from "vitest";

import { codeDigits, looksLikeEmail, normalizeEmail, signedInWithLabel } from "../../src/lib/email-signin";

describe("email sign-in, before asking the server", () => {
  it("keys an address the way the server does: trimmed, lower-cased", () => {
    expect(normalizeEmail("  Student@School.EDU ")).toBe("student@school.edu");
  });

  it("catches typos, and lets ordinary addresses through", () => {
    for (const ok of ["a@b.co", "first.last+tag@mail.school.edu", " Name@Example.com "]) expect(looksLikeEmail(ok), ok).toBe(true);
    for (const bad of ["", "student", "student@", "@school.edu", "student@school", "two words@school.edu", "a@b.c", `${"x".repeat(320)}@a.co`]) expect(looksLikeEmail(bad), bad).toBe(false);
  });

  it("takes the code with or without spaces, and only six digits", () => {
    expect(codeDigits("123456")).toBe("123456");
    expect(codeDigits("123 456")).toBe("123456");
    expect(codeDigits(" 12-34-56 ")).toBe("123456");
    expect(codeDigits("12345")).toBeNull();
    expect(codeDigits("1234567")).toBeNull();
  });

  it("names the sign-in method in Settings", () => {
    expect(signedInWithLabel("google")).toBe("Signed in with Google");
    expect(signedInWithLabel("email")).toBe("Signed in with email");
    expect(signedInWithLabel("apple")).toBe("Signed in with Apple");
    expect(signedInWithLabel(null)).toBe("Signed in with Apple");
  });
});

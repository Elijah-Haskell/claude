import { describe, expect, it } from "vitest";

import { signedInWithLabel } from "../../src/lib/sign-in-label";

describe("the account row in Settings", () => {
  it("names the sign-in method", () => {
    expect(signedInWithLabel("google")).toBe("Signed in with Google");
    expect(signedInWithLabel("apple")).toBe("Signed in with Apple");
    expect(signedInWithLabel(null)).toBe("Signed in with Apple");
  });
});

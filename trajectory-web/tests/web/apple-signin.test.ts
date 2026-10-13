import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { nonceDigest } from "../../src/lib/apple-signin";

describe("the Sign in with Apple nonce", () => {
  it("gives Apple the same SHA-256 (hex) of the raw nonce that the server computes", async () => {
    const raw = "c2b1e0a4f7d94b6e8a3d5c1f0e9b8a7d";
    // server/apple-signin.ts appleNonceDigest: createHash("sha256").update(raw, "utf8").digest("hex")
    expect(await nonceDigest(raw)).toBe(createHash("sha256").update(raw, "utf8").digest("hex"));
    expect(await nonceDigest(raw)).toMatch(/^[0-9a-f]{64}$/);
  });
});

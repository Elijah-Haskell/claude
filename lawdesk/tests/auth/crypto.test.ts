import { test } from "node:test";
import assert from "node:assert/strict";
import { base32Decode, base32Encode, hotp, totp, verifyTotp, otpauthUri, groupKey } from "../../src/auth/totp.ts";
import { hashPassword, verifyPassword, passwordProblem, tokenHash } from "../../src/auth/passwords.ts";

const RFC_KEY = Buffer.from("12345678901234567890", "ascii");

test("base32 follows RFC 4648 test vectors", () => {
  const vectors: [string, string][] = [["", ""], ["f", "MY"], ["fo", "MZXQ"], ["foo", "MZXW6"], ["foob", "MZXW6YQ"], ["fooba", "MZXW6YTB"], ["foobar", "MZXW6YTBOI"]];
  for (const [plain, enc] of vectors) {
    assert.equal(base32Encode(Buffer.from(plain)), enc);
    assert.equal(base32Decode(enc).toString(), plain);
  }
  assert.equal(base32Decode("mzxw 6ytb-oi").toString(), "foobar");
  assert.throws(() => base32Decode("not base32!"));
});

test("HOTP matches RFC 4226 Appendix D", () => {
  const want = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
  want.forEach((code, i) => assert.equal(hotp(RFC_KEY, i), code));
});

test("TOTP matches RFC 6238 Appendix B (SHA-1, 8 digits)", () => {
  const secret = base32Encode(RFC_KEY);
  const vectors: [number, string][] = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];
  for (const [t, code] of vectors) assert.equal(totp(secret, t * 1000, 8), code);
});

test("TOTP verification allows one step of drift and refuses replays", () => {
  const secret = base32Encode(RFC_KEY);
  const now = 1_700_000_000_000;
  const code = totp(secret, now);
  const step = verifyTotp(secret, code, now);
  assert.equal(step, Math.floor(now / 30000));
  assert.equal(verifyTotp(secret, code, now + 30_000), step, "still good 30 s later");
  assert.equal(verifyTotp(secret, code, now + 90_000), null, "too old after 90 s");
  assert.equal(verifyTotp(secret, code, now, step), null, "the same code can't be used twice");
  assert.equal(verifyTotp(secret, "12345", now), null);
  assert.equal(verifyTotp(secret, "abcdef", now), null);
  assert.equal(verifyTotp(secret, ` ${code.slice(0, 3)} ${code.slice(3)} `, now), step, "spaces are ignored");
});

test("otpauth URI and grouped key", () => {
  const uri = otpauthUri("JBSWY3DPEHPK3PXP", "pat@example.com");
  assert.equal(uri, "otpauth://totp/Lawdesk%3Apat%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Lawdesk&algorithm=SHA1&digits=6&period=30");
  assert.equal(groupKey("JBSWY3DPEHPK3PXP"), "JBSW Y3DP EHPK 3PXP");
});

test("passwords: scrypt with a per-password salt, verified in constant time", async () => {
  const a = await hashPassword("correct horse battery");
  const b = await hashPassword("correct horse battery");
  assert.match(a, /^scrypt\$16384\$8\$1\$/);
  assert.notEqual(a, b, "each hash has its own salt");
  assert.equal(await verifyPassword("correct horse battery", a), true);
  assert.equal(await verifyPassword("correct horse batterY", a), false);
  assert.equal(await verifyPassword("anything", "garbage"), false);
  assert.equal(await verifyPassword("anything", "scrypt$x"), false);
});

test("password rules: length, not the email, not trivially guessable", () => {
  assert.match(passwordProblem("short")!, /at least 12/);
  assert.match(passwordProblem(undefined)!, /at least 12/);
  assert.match(passwordProblem("pat@example.com", "PAT@example.com")!, /email/);
  assert.match(passwordProblem("aaaaaaaaaaaaaa")!, /repeated/);
  assert.match(passwordProblem("password1234")!, /easy to guess/);
  assert.equal(passwordProblem("maple syrup on tuesdays"), null);
  assert.equal(tokenHash("x").length, 64);
});

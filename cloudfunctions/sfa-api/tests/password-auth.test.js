const assert = require("assert");
const { normalizeMobile, passwordFields, verifyPassword, createSessionCredential, hashSessionToken } = require("../password-auth");

assert.strictEqual(normalizeMobile("138 0013 8000"), "13800138000");
assert.throws(() => normalizeMobile("123"), (error) => error.code === "MOBILE_INVALID");
assert.throws(() => passwordFields("12345678"), (error) => error.code === "PASSWORD_INVALID");
const account = passwordFields("SfaTest2026");
assert.strictEqual(verifyPassword("SfaTest2026", account), true);
assert.strictEqual(verifyPassword("SfaTest2027", account), false);
assert(!Object.values(account).includes("SfaTest2026"));
const session = createSessionCredential();
assert.strictEqual(session.token.length, 64);
assert.strictEqual(session.tokenHash, hashSessionToken(session.token));
assert(Date.parse(session.expiresAt) > Date.now());
console.log("password auth tests passed");

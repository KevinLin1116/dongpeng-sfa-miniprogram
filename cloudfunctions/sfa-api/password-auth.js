const crypto = require("crypto");

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function authError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeMobile(value) {
  const mobile = String(value || "").replace(/[\s-]/g, "");
  if (!/^1[3-9]\d{9}$/.test(mobile)) throw authError("MOBILE_INVALID", "请输入正确的11位手机号");
  return mobile;
}

function validatePassword(value) {
  const password = String(value || "");
  if (password.length < 8 || password.length > 64 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw authError("PASSWORD_INVALID", "密码须为8至64位，且同时包含字母和数字");
  }
  return password;
}

function passwordFields(value) {
  const password = validatePassword(value);
  const passwordSalt = crypto.randomBytes(16).toString("hex");
  const passwordHash = crypto.scryptSync(password, passwordSalt, 64).toString("hex");
  return { passwordAlgorithm: "scrypt-v1", passwordSalt, passwordHash, passwordUpdatedAt: new Date().toISOString() };
}

function verifyPassword(value, account) {
  try {
    const password = String(value || "");
    if (account?.passwordAlgorithm !== "scrypt-v1" || !account.passwordSalt || !account.passwordHash) return false;
    const expected = Buffer.from(account.passwordHash, "hex");
    const actual = crypto.scryptSync(password, account.passwordSalt, expected.length);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch (_) { return false; }
}

function createSessionCredential() {
  const token = crypto.randomBytes(32).toString("hex");
  return { token, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString() };
}

function hashSessionToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

module.exports = { SESSION_TTL_MS, normalizeMobile, validatePassword, passwordFields, verifyPassword, createSessionCredential, hashSessionToken };

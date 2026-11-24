// Authentication: bcrypt password hashing + JWT in an HttpOnly cookie.
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const config = require("./config");
const store = require("./db");

const COOKIE = "hsAuth";
const SEVEN_DAYS = 7 * 24 * 60 * 60; // seconds
const ROUNDS = 12;                    // bcrypt cost
// Compared against when the email does not exist, so login takes the same time either way
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", ROUNDS);

// ---------- passwords ----------
const hashPassword = password => bcrypt.hash(password, ROUNDS);
const isBcrypt = h => typeof h === "string" && /^\$2[aby]\$/.test(h);

// Passwords saved by the older version look like "salt:hash" (scrypt). Still accepted once, then upgraded.
function legacyScryptVerify(password, stored) {
  if (typeof stored !== "string" || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const known = Buffer.from(hash, "hex");
  if (!salt || !known.length) return false;
  const test = crypto.scryptSync(password, salt, 64);
  return known.length === test.length && crypto.timingSafeEqual(known, test);
}

// Returns true if the password is right. Old scrypt hashes are replaced by bcrypt hashes after a successful login.
async function checkPassword(user, password) {
  if (Buffer.byteLength(password, "utf8") > 72) return false; // bcrypt ignores anything after 72 bytes
  if (!user) { await bcrypt.compare(password, DUMMY_HASH); return false; }
  if (isBcrypt(user.password)) return bcrypt.compare(password, user.password);
  if (!legacyScryptVerify(password, user.password)) return false;
  await store.updateUser(user.email, { password: await hashPassword(password) });
  return true;
}

// ---------- JWT cookie ----------
function cookie(value, maxAge) {
  return [`${COOKIE}=${value}`, "HttpOnly", "Path=/api", "SameSite=Lax", `Max-Age=${maxAge}`, ...(config.IS_PROD ? ["Secure"] : [])].join("; ");
}
// The token only holds the user's email (sub) and a version number (tv). The role is always read from the database.
function sessionCookie(user) {
  const token = jwt.sign({ sub: user.email, tv: user.tokenVersion || 0 }, config.JWT_SECRET, { expiresIn: SEVEN_DAYS, algorithm: "HS256" });
  return cookie(token, SEVEN_DAYS);
}
// Also clears the cookie used by the older version (hs_session)
const clearCookies = () => [cookie("", 0), "hs_session=; HttpOnly; Path=/; Max-Age=0"];

function readCookie(req, name) {
  for (const part of (req.headers.cookie || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

// Logged-in user for this request, or null (bad / expired / forged / logged-out token)
async function getUser(req) {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  let payload;
  try { payload = jwt.verify(token, config.JWT_SECRET, { algorithms: ["HS256"] }); } catch { return null; }
  const user = await store.findUserByEmail(String(payload.sub));
  if (!user || (user.tokenVersion || 0) !== payload.tv) return null;
  return user;
}

// Real logout: raising tokenVersion makes every token issued before it invalid
async function logoutUser(user) {
  await store.updateUser(user.email, { tokenVersion: (user.tokenVersion || 0) + 1 });
}

module.exports = { hashPassword, checkPassword, sessionCookie, clearCookies, getUser, logoutUser };

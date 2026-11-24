// Vercel serverless function: every request to /api/... is handled here (same routes as the local server).
const config = require("../backend/config");
const db = require("../backend/db");
const { handle } = require("../backend/routes");

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

module.exports = async (req, res) => {
  if (!config.JWT_SECRET || config.JWT_SECRET.length < 32) return json(res, 500, { error: "Server is not configured (JWT_SECRET)." });
  try { await db.connect(); }                       // reused between requests while the function stays warm
  catch (e) { console.error("MongoDB connection failed:", e.message); return json(res, 503, { error: "Database is not available." }); }
  if (req.method !== "GET") {                       // Vercel may already have read the body
    try { req.parsedBody = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {}); }
    catch { return json(res, 400, { error: "Bad request" }); }
  }
  return handle(req, res, new URL(req.url, "http://x").pathname);
};

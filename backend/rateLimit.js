// Small in-memory rate limiter (per IP address and per route name) - slows down password guessing.
const hits = new Map(); // "name:ip" -> { count, reset }

function key(req, name) { return name + ":" + (req.socket.remoteAddress || "unknown"); }

// Counts one attempt. Returns { ok, retryAfter } (retryAfter is in seconds)
function hit(req, name, max = 20, windowMs = 15 * 60 * 1000) {
  const now = Date.now(), k = key(req, name);
  let h = hits.get(k);
  if (!h || h.reset <= now) { h = { count: 0, reset: now + windowMs }; hits.set(k, h); }
  h.count++;
  return { ok: h.count <= max, retryAfter: Math.ceil((h.reset - now) / 1000) };
}
// After a successful login the counter starts again
function reset(req, name) { hits.delete(key(req, name)); }

setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (h.reset <= now) hits.delete(k); }, 60 * 1000).unref();

module.exports = { hit, reset };

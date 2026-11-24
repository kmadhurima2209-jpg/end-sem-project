// REST API routes (same endpoints and responses as before; data now lives in MongoDB Atlas)
const store = require("./db");
const session = require("./auth");
const limiter = require("./rateLimit");
const weather = require("./weather");

const STATUSES = ["Pending", "Confirmed", "In Progress", "Completed", "Cancelled"];
const PROVIDER_STATUSES = ["Confirmed", "Cancelled", "In Progress", "Completed"];
const CATEGORIES = ["Plumbing", "Electrical", "Cleaning", "Carpentry", "Painting", "Appliance Repair"];
const SERVICES = ["Plumbing", "Electrical", "Cleaning"];

function publicUser(u) {
  const p = { name: u.name, email: u.email, role: u.role };
  if (u.role === "provider") Object.assign(p, { category: u.category, price: u.price, bio: u.bio || "", available: u.available !== false, verified: !!u.verified, portfolio: u.portfolio || [] });
  return p;
}
async function auth(req, res, ...roles) {
  const u = await session.getUser(req);
  if (!u) { send(res, 401, { error: "Not logged in" }); return null; }
  if (roles.length && !roles.includes(u.role)) { send(res, 403, { error: "Not allowed" }); return null; }
  return u;
}
function ratingMap(bookings) {
  const m = {};
  for (const b of bookings) if (b.review && b.providerEmail) { const o = m[b.providerEmail] || (m[b.providerEmail] = { sum: 0, n: 0 }); o.sum += b.review.rating; o.n++; }
  return m;
}
// only the customer and the provider of a booking may chat
const canChat = (u, b) => !!(b && b.providerEmail && (b.email === u.email || b.providerEmail === u.email));
const sumPaid = bs => bs.filter(b => b.paid).reduce((s, b) => s + (b.price || 0), 0);

// Sends 429 and returns true when this IP has made too many attempts
function tooMany(req, res, name, max) {
  const r = limiter.hit(req, name, max);
  if (r.ok) return false;
  send(res, 429, { error: "Too many attempts. Please try again later." }, { "Retry-After": String(r.retryAfter) });
  return true;
}

function readBody(req) {
  if (req.parsedBody !== undefined) return Promise.resolve(req.parsedBody || {}); // body already read by Vercel
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", c => { raw += c; if (raw.length > 1e6) { reject(new Error("Too large")); req.destroy(); } });
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}


const routes = {
  "POST /api/signup": async (req, res, body) => {
    if (tooMany(req, res, "signup")) return;
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!name || name.length > 60 || !email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return send(res, 400, { error: "Please fill all fields correctly" });
    if (password.length < 8 || Buffer.byteLength(password, "utf8") > 72) return send(res, 400, { error: "Password must be 8 to 72 characters" });
    if (password !== String(body.confirm || "")) return send(res, 400, { error: "Passwords do not match" });
    const user = { name, email, password: await session.hashPassword(password), role: "user" };
    if (body.role === "provider") {
      const category = String(body.category || ""), price = Number(body.price);
      if (!CATEGORIES.includes(category) || !(price > 0)) return send(res, 400, { error: "Please fill all fields correctly" });
      Object.assign(user, { role: "provider", category, price, bio: String(body.bio || "").slice(0, 300), available: true, verified: false });
    }
    if (!(await store.createUser(user))) return send(res, 409, { error: "Email already registered" });
    send(res, 201, { message: "Signup successful" });
  },
  "POST /api/login": async (req, res, body) => {
    if (tooMany(req, res, "login")) return;
    const email = String(body.email || "").trim().toLowerCase();
    const user = await store.findUserByEmail(email);
    if (!(await session.checkPassword(user, String(body.password || "")))) return send(res, 401, { error: "Invalid email or password" });
    limiter.reset(req, "login");
    send(res, 200, { user: publicUser(user) }, { "Set-Cookie": session.sessionCookie(user) });
  },
  "POST /api/logout": async (req, res) => {
    const user = await session.getUser(req);
    if (user) await session.logoutUser(user); // invalidates the token on the server, not just in the browser
    send(res, 200, { message: "Logged out" }, { "Set-Cookie": session.clearCookies() });
  },
  
     "GET /api/health": async (req, res) => {
    try { await store.ping(); send(res, 200, { status: "ok", database: "connected" }); }
    catch (e) {
      console.error("Health check failed:", e.message);   // also appears in the Vercel logs
      const m = String(e.message || "");
      const reason =
        /MONGODB_URI is not set|scheme|Invalid/i.test(m) ? "MONGODB_URI is missing or malformed on Vercel"
        : /auth/i.test(m) ? "Authentication failed: wrong username or password in MONGODB_URI"
        : /ENOTFOUND|querySrv|ECONNREFUSED/i.test(m) ? "Cannot find the cluster: check the address in MONGODB_URI"
        : /timed out|Server selection|ETIMEDOUT/i.test(m) ? "Timed out: allow 0.0.0.0/0 in Atlas Network Access"
        : "Unknown problem: read the Vercel function logs";
      send(res, 503, { status: "error", database: "not connected", reason });
    }
  },
  "GET /api/me": async (req, res) => { const u = await auth(req, res); if (u) send(res, 200, { user: publicUser(u) }); },

  // ---- Third-party API: weather forecast (Open-Meteo) for the appointment date ----
  "GET /api/weather": async (req, res) => {
    if (!(await auth(req, res))) return;
    if (tooMany(req, res, "weather", 60)) return;
    const q = new URL(req.url, "http://x").searchParams;
    try { send(res, 200, await weather.getForecast(q.get("city"), q.get("date"))); }
    catch (e) { if (e.status) return send(res, e.status, { error: e.message }); throw e; }
  },

  // ---- Customer: browse / search providers (verified + available only) ----
  "GET /api/providers": async (req, res) => {
    if (!(await auth(req, res))) return;
    const q = new URL(req.url, "http://x").searchParams;
    const cat = q.get("category") || "", text = (q.get("q") || "").toLowerCase();
    const rm = ratingMap(await store.getAllBookings());
    const list = (await store.getAllUsers()).filter(u => u.role === "provider" && u.verified && u.available !== false)
      .filter(u => (!cat || u.category === cat) && (!text || (u.name + " " + u.category + " " + (u.bio || "")).toLowerCase().includes(text)))
      .map(u => ({ ...publicUser(u), rating: rm[u.email] ? +(rm[u.email].sum / rm[u.email].n).toFixed(1) : 0, reviews: rm[u.email] ? rm[u.email].n : 0 }));
    send(res, 200, { providers: list, categories: CATEGORIES });
  },

  // ---- Bookings (customer) ----
  "POST /api/bookings": async (req, res, body) => {
    const user = await auth(req, res); if (!user) return;
    if (body.providerEmail) {
      const p = await store.findUserByEmail(String(body.providerEmail).toLowerCase());
      if (!p || p.role !== "provider" || !p.verified || p.available === false) return send(res, 400, { error: "Provider not available" });
      const date = String(body.date || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return send(res, 400, { error: "Please choose a date" });
      const booking = await store.createBooking({ name: user.name, email: user.email, service: p.category, providerEmail: p.email, providerName: p.name, price: p.price, date });
      return send(res, 201, { booking });
    }
    const service = String(body.service || "");
    if (!SERVICES.includes(service)) return send(res, 400, { error: "Invalid service" });
    send(res, 201, { booking: await store.createBooking({ name: user.name, email: user.email, service }) });
  },
  "GET /api/bookings/mine": async (req, res) => {
    const user = await auth(req, res); if (user) send(res, 200, { bookings: await store.getBookingsByEmail(user.email) });
  },
  "POST /api/complaints": async (req, res, body) => {
    const user = await auth(req, res, "user"); if (!user) return;
    const text = String(body.text || "").trim().slice(0, 500);
    if (!text) return send(res, 400, { error: "Complaint text required" });
    send(res, 201, { complaint: await store.createComplaint({ email: user.email, name: user.name, bookingId: Number(body.bookingId) || null, text }) });
  },

  // ---- Provider ----
  "GET /api/provider/summary": async (req, res) => {
    const user = await auth(req, res, "provider"); if (!user) return;
    const bookings = await store.getBookingsByProvider(user.email);
    const rated = bookings.filter(b => b.review);
    send(res, 200, { profile: publicUser(user), bookings,
      earnings: sumPaid(bookings), pending: bookings.filter(b => !b.paid && b.status !== "Cancelled").reduce((s, b) => s + (b.price || 0), 0),
      rating: rated.length ? +(rated.reduce((s, b) => s + b.review.rating, 0) / rated.length).toFixed(1) : 0,
      reviews: rated.map(b => ({ customer: b.name, ...b.review })) });
  },
  "PUT /api/provider/profile": async (req, res, body) => {
    const user = await auth(req, res, "provider"); if (!user) return;
    const f = {};
    if (body.price !== undefined) { if (!(Number(body.price) > 0)) return send(res, 400, { error: "Invalid price" }); f.price = Number(body.price); }
    if (body.category !== undefined) { if (!CATEGORIES.includes(body.category)) return send(res, 400, { error: "Invalid category" }); f.category = body.category; }
    if (body.bio !== undefined) f.bio = String(body.bio).slice(0, 300);
    if (body.available !== undefined) f.available = !!body.available;
    await store.updateUser(user.email, f);
    send(res, 200, { profile: publicUser({ ...user, ...f }) });
  },

  // ---- Provider portfolio (max 10 items; image is an optional http(s) link) ----
  "POST /api/provider/portfolio": async (req, res, body) => {
    const user = await auth(req, res, "provider"); if (!user) return;
    const title = String(body.title || "").trim().slice(0, 60), description = String(body.description || "").trim().slice(0, 200);
    const imageUrl = String(body.imageUrl || "").trim();
    if (!title) return send(res, 400, { error: "Title is required" });
    if (imageUrl && !/^https?:\/\/\S+$/i.test(imageUrl)) return send(res, 400, { error: "Image link must start with http:// or https://" });
    const portfolio = user.portfolio || [];
    if (portfolio.length >= 10) return send(res, 400, { error: "Portfolio limit is 10 items" });
    portfolio.push({ title, description, imageUrl });
    await store.updateUser(user.email, { portfolio });
    send(res, 201, { portfolio });
  },

  // ---- Admin ----
  "GET /api/admin/summary": async (req, res) => {
    const user = await auth(req, res, "admin"); if (!user) return;
    const [bookings, users, complaints] = await Promise.all([store.getAllBookings(), store.getAllUsers(), store.getComplaints()]);
    send(res, 200, { bookings, users: users.map(publicUser), complaints, revenue: sumPaid(bookings) });
  },
  "GET /api/admin/report": async (req, res) => {
    const user = await auth(req, res, "admin"); if (!user) return;
    const q = v => '"' + String(v ?? "").replace(/"/g, '""') + '"';
    const rows = [["Booking ID", "Customer", "Email", "Service", "Provider", "Date", "Price", "Paid", "Status"]]
      .concat((await store.getAllBookings()).map(b => [b.id, b.name, b.email, b.service, b.providerName, b.date, b.price, b.paid ? "Yes" : "No", b.status]));
    res.writeHead(200, { "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=bookings-report.csv" });
    res.end(rows.map(r => r.map(q).join(",")).join("\n"));
  }
};

// Routes with an id in the URL: [method, pattern, handler]
const dynamic = [
  ["DELETE", /^\/api\/provider\/portfolio\/(\d+)$/, async (req, res, body, i) => {    // remove a portfolio item
    const user = await auth(req, res, "provider"); if (!user) return;
    const portfolio = user.portfolio || [];
    if (i >= portfolio.length) return send(res, 404, { error: "Item not found" });
    portfolio.splice(i, 1);
    await store.updateUser(user.email, { portfolio });
    send(res, 200, { portfolio });
  }],
  ["GET", /^\/api\/bookings\/(\d+)\/messages$/, async (req, res, body, id) => {      // chat history
    const user = await auth(req, res); if (!user) return;
    const b = await store.getBooking(id);
    if (!canChat(user, b)) return send(res, 404, { error: "Chat not available" });
    send(res, 200, { me: user.email, messages: await store.getMessages(id) });
  }],
  ["POST", /^\/api\/bookings\/(\d+)\/messages$/, async (req, res, body, id) => {     // send a message
    const user = await auth(req, res); if (!user) return;
    const b = await store.getBooking(id);
    if (!canChat(user, b)) return send(res, 404, { error: "Chat not available" });
    const text = String(body.text || "").trim().slice(0, 500);
    if (!text) return send(res, 400, { error: "Message is empty" });
    send(res, 201, { message: await store.createMessage({ bookingId: id, from: user.email, fromName: user.name, text }) });
  }],
  ["PUT", /^\/api\/bookings\/(\d+)\/status$/, async (req, res, body, id) => {      // admin sets any status
    if (!(await auth(req, res, "admin"))) return;
    if (!STATUSES.includes(body.status)) return send(res, 400, { error: "Invalid status" });
    const b = await store.updateBooking(id, { status: body.status });
    b ? send(res, 200, { booking: b }) : send(res, 404, { error: "Booking not found" });
  }],
  ["PUT", /^\/api\/provider\/bookings\/(\d+)$/, async (req, res, body, id) => {     // provider accept/reject/progress/complete
    const user = await auth(req, res, "provider"); if (!user) return;
    if (!PROVIDER_STATUSES.includes(body.status)) return send(res, 400, { error: "Invalid status" });
    const b = await store.getBooking(id);
    if (!b || b.providerEmail !== user.email) return send(res, 404, { error: "Booking not found" });
    send(res, 200, { booking: await store.updateBooking(id, { status: body.status }) });
  }],
  ["POST", /^\/api\/bookings\/(\d+)\/pay$/, async (req, res, body, id) => {          // simulated payment
    const user = await auth(req, res, "user"); if (!user) return;
    const b = await store.getBooking(id);
    if (!b || b.email !== user.email) return send(res, 404, { error: "Booking not found" });
    if (b.paid || !b.price || b.status === "Cancelled") return send(res, 400, { error: "Payment not possible" });
    send(res, 200, { booking: await store.updateBooking(id, { paid: true, paidAt: new Date().toISOString() }) });
  }],
  ["POST", /^\/api\/bookings\/(\d+)\/review$/, async (req, res, body, id) => {       // rate + review
    const user = await auth(req, res, "user"); if (!user) return;
    const b = await store.getBooking(id);
    if (!b || b.email !== user.email) return send(res, 404, { error: "Booking not found" });
    const rating = Number(body.rating);
    if (b.status !== "Completed" || !b.providerEmail || b.review) return send(res, 400, { error: "Review not possible" });
    if (!(rating >= 1 && rating <= 5)) return send(res, 400, { error: "Rating must be 1-5" });
    send(res, 200, { booking: await store.updateBooking(id, { review: { rating: Math.round(rating), comment: String(body.comment || "").slice(0, 300) } }) });
  }],
  ["PUT", /^\/api\/admin\/providers\/([^/]+)\/verify$/, async (req, res, body, email) => {   // verify provider
    if (!(await auth(req, res, "admin"))) return;
    const p = await store.findUserByEmail(decodeURIComponent(email).toLowerCase());
    if (!p || p.role !== "provider") return send(res, 404, { error: "Provider not found" });
    await store.updateUser(p.email, { verified: !!body.verified });
    send(res, 200, { message: "Updated" });
  }],
  ["PUT", /^\/api\/complaints\/(\d+)\/resolve$/, async (req, res, body, id) => {     // admin resolves complaint
    if (!(await auth(req, res, "admin"))) return;
    const c = await store.resolveComplaint(id);
    c ? send(res, 200, { complaint: c }) : send(res, 404, { error: "Complaint not found" });
  }]
];

async function handle(req, res, pathname) {
  let body = {};
  try { if (req.method !== "GET") body = await readBody(req); }
  catch (e) { return send(res, 400, { error: "Bad request" }); }
  try {
    for (const [method, re, fn] of dynamic) {
      const m = req.method === method && pathname.match(re);
      if (m) { const k = m[1]; return await fn(req, res, body, /^\d+$/.test(k) ? Number(k) : k); }
    }
    const route = routes[req.method + " " + pathname];
    if (!route) return send(res, 404, { error: "API route not found" });
    await route(req, res, body);
  } catch (e) {
    console.error("API error:", e);
    send(res, 500, { error: "Server error" });
  }
}

module.exports = { handle };

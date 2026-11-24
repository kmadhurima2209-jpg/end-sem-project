// Local server: REST API under /api + the built React app (client/dist). On Vercel, api/[...slug].js is used instead.
const http = require("http");
const fs = require("fs");
const path = require("path");
const config = require("./backend/config");
const db = require("./backend/db");
const { handle } = require("./backend/routes");

if (!config.JWT_SECRET || config.JWT_SECRET.length < 32) {
  console.error("JWT_SECRET is missing or shorter than 32 characters. Add it to .env (see .env.example).");
  process.exit(1);
}
const DIST = path.join(__dirname, "client", "dist");
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8",
  ".png": "image/png", ".ico": "image/x-icon", ".svg": "image/svg+xml", ".json": "application/json" };

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  if (pathname.startsWith("/api/")) return handle(req, res, pathname);
  const rel = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = path.join(DIST, rel);
  if (!file.startsWith(DIST + path.sep)) { res.writeHead(403); return res.end("Forbidden"); }
  fs.readFile(file, (err, data) => {
    if (err) {
      const ext = path.extname(pathname);          // real files (js, css, images) that do not exist -> 404
      if (ext && ext !== ".html") { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Not found"); }
      return fs.readFile(path.join(DIST, "index.html"), (e2, html) => {       // React Router paths -> index.html
        if (e2) { res.writeHead(503, { "Content-Type": "text/plain" }); return res.end("React app is not built yet. Run:  npm run install:client  then  npm run build  then restart this server.  (Or use: npm run dev  and open http://localhost:5173)"); }
        res.writeHead(200, { "Content-Type": TYPES[".html"] }); res.end(html);
      });
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
});

db.connect()
  .then(() => server.listen(config.PORT, () => console.log(`HomeServices running at http://localhost:${config.PORT} (MongoDB connected)`)))
  .catch(err => { console.error("Could not connect to MongoDB:", err.message); process.exit(1); });
process.on("SIGINT", async () => { await db.close(); process.exit(0); });

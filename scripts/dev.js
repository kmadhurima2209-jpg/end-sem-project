// One command for development: backend (port 3000) + React dev server (port 5173)
const { spawn } = require("child_process");
const run = (name, cmd, args) => { const p = spawn(cmd, args, { stdio: "inherit", shell: true }); p.on("exit", c => { console.log(`[${name}] stopped (code ${c})`); stop(); }); return p; };
const procs = [run("backend", "node", ["server.js"]), run("react", "npm", ["--prefix", "client", "run", "dev"])];
let stopping = false;
function stop() { if (stopping) return; stopping = true; procs.forEach(p => { try { p.kill(); } catch {} }); setTimeout(() => process.exit(0), 300); }
process.on("SIGINT", stop); process.on("SIGTERM", stop);
console.log("\n>>> Open http://localhost:5173 (Ctrl+C stops both)\n");

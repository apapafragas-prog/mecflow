import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import Database from "better-sqlite3";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { randomUUID, createHmac } from "crypto";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import fs from "fs";
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import nodemailer from "nodemailer";
import { validateAmounts } from "./lib/validate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || "/data";
const FILES_DIR = join(DATA_DIR, "files");
const PORT = process.env.PORT || 3000;

// ── JWT secret: fail hard on missing/known-weak values (never boot silently insecure) ──
const JWT_SECRET = process.env.JWT_SECRET || "";
const KNOWN_BAD_SECRETS = ["change-me-in-production", "CHANGE-THIS-TO-A-LONG-RANDOM-STRING"];
if (JWT_SECRET.length < 32 || KNOWN_BAD_SECRETS.includes(JWT_SECRET)) {
  console.error("FATAL: JWT_SECRET is missing, too short (<32 chars) or a known placeholder.");
  console.error("Set a strong random JWT_SECRET in .env, e.g.: openssl rand -hex 48");
  process.exit(1);
}
const PUBLIC_DIR = join(__dirname, "public");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });

const db = new Database(join(DATA_DIR, "cbre.db"));
db.pragma("journal_mode = WAL");

// ── Boot migrations (idempotent) ──
const tableCols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
if (!tableCols("users").includes("must_change_password")) db.exec("ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 0");
if (!tableCols("users").includes("token_version")) db.exec("ALTER TABLE users ADD COLUMN token_version INTEGER DEFAULT 0");
if (!tableCols("users").includes("email")) db.exec("ALTER TABLE users ADD COLUMN email TEXT DEFAULT ''");
if (!tableCols("client_data").includes("version")) db.exec("ALTER TABLE client_data ADD COLUMN version INTEGER DEFAULT 0");
// Password-reset tokens (email self-service flow). Only the HMAC of the token is stored.
db.exec(`CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (strftime('%s','now'))
)`);
db.prepare("DELETE FROM password_resets WHERE expires_at < ?").run(Math.floor(Date.now() / 1000) - 24 * 3600);

// Company-wide OPEX/CAPEX (one JSON blob per fiscal year — finance/admin only)
db.exec(`CREATE TABLE IF NOT EXISTS finance_data (
  year TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  version INTEGER DEFAULT 0,
  updated_at INTEGER DEFAULT (strftime('%s','now')),
  updated_by TEXT
)`);
// Flag any account still on the seeded default password → force change on next login
try {
  for (const u of db.prepare("SELECT id, password_hash, must_change_password FROM users").all()) {
    if (!u.must_change_password && bcrypt.compareSync("ChangeMe!2026", u.password_hash)) {
      db.prepare("UPDATE users SET must_change_password = 1 WHERE id = ?").run(u.id);
      console.warn(`⚠ User id=${u.id} still uses the default password — flagged must_change_password`);
    }
  }
} catch (e) { console.warn("Default-password scan failed:", e.message); }
// Audit-log retention: keep 18 months
db.prepare("DELETE FROM audit_log WHERE timestamp < ?").run(Math.floor(Date.now() / 1000) - 18 * 30 * 24 * 3600);

// Anthropic client (for AI invoice/contract extraction)
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;
if (!anthropic) console.warn("⚠ ANTHROPIC_API_KEY not set — AI extraction endpoints disabled");

// ── Email via SMTP (Zoho Mail) for password-reset self-service ──
const SMTP_HOST = process.env.SMTP_HOST || "smtp.zoho.eu";
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "465", 10);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM = process.env.SMTP_FROM || (SMTP_USER ? `CBRE Reporting <${SMTP_USER}>` : "");
const APP_BASE_URL = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
const EMAIL_ENABLED = !!(SMTP_USER && SMTP_PASS);
const mailer = EMAIL_ENABLED ? nodemailer.createTransport({
  host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465, // 465 = implicit TLS, 587 = STARTTLS
  auth: { user: SMTP_USER, pass: SMTP_PASS }
}) : null;
if (!EMAIL_ENABLED) console.warn("⚠ SMTP_USER/SMTP_PASS not set — email password-reset disabled (admin reset still works)");
const sendEmail = async (to, subject, html) => {
  if (!mailer) throw new Error("SMTP not configured");
  await mailer.sendMail({ from: SMTP_FROM, to, subject, html });
};
const resetEmailHtml = (name, link) => `
  <div style="font-family:Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;color:#1A2E23">
    <div style="background:#003F2D;color:#fff;padding:20px 24px;border-radius:10px 10px 0 0;font-size:20px;font-weight:700">CBRE Reporting</div>
    <div style="border:1px solid #D5DDD8;border-top:none;border-radius:0 0 10px 10px;padding:24px">
      <p>Γεια σου ${name || ""},</p>
      <p>Λάβαμε αίτημα επαναφοράς του κωδικού σου. Πάτα το κουμπί για να ορίσεις νέο κωδικό:</p>
      <p style="text-align:center;margin:26px 0">
        <a href="${link}" style="background:#003F2D;color:#fff;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:600;display:inline-block">Ορισμός νέου κωδικού</a>
      </p>
      <p style="font-size:13px;color:#5F7567">Ο σύνδεσμος λήγει σε 30 λεπτά. Αν δεν ζήτησες εσύ την επαναφορά, αγνόησε αυτό το email — ο κωδικός σου παραμένει ίδιος.</p>
      <p style="font-size:12px;color:#5F7567;word-break:break-all">${link}</p>
    </div>
  </div>`;

const app = express();
app.set('trust proxy', 1);
// CORS: explicit origin allowlist from env; default = same-origin only (frontend is served by this server)
const CORS_ORIGINS = (process.env.CORS_ORIGIN || "").split(",").map(s => s.trim()).filter(s => s && s !== "*");
app.use(cors(CORS_ORIGINS.length ? { origin: CORS_ORIGINS, credentials: true } : { origin: false }));
app.use(express.json({ limit: "20mb" }));

// Rate limit on login — keyed by username+IP (not bare IP) so the whole office,
// which shares one NAT IP, cannot lock each other out. A looser IP-only cap guards brute force.
const loginLimiter = rateLimit({
  windowMs: 15*60*1000, max: 10,
  keyGenerator: (req) => `${(req.body && req.body.username ? String(req.body.username).toLowerCase() : "-")}|${req.ip}`,
  message: { error: "Too many login attempts" }
});
const loginIpLimiter = rateLimit({ windowMs: 15*60*1000, max: 60, message: { error: "Too many login attempts from this network" } });
// Forgot-password requests are cheap to abuse (email spam) → tighter cap per IP.
const forgotLimiter = rateLimit({ windowMs: 15*60*1000, max: 5, message: { error: "Πάρα πολλά αιτήματα — δοκίμασε ξανά αργότερα" } });

// ── Audit log ──
const auditStmt = db.prepare("INSERT INTO audit_log (user, action, target, ip) VALUES (?, ?, ?, ?)");
const audit = (user, action, target, req) => auditStmt.run(user, action, target||"", req.ip||"");

// ── Auth middleware ──
const auth = (req, res, next) => {
  const token = req.headers.authorization?.replace("Bearer ", "") || req.query.token;
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // Session revocation: user must still exist and token_version must match
    const u = db.prepare("SELECT id, token_version FROM users WHERE id = ?").get(payload.id);
    if (!u || (u.token_version || 0) !== (payload.tv || 0)) return res.status(401).json({ error: "Session expired" });
    req.user = payload;
    next();
  } catch { res.status(401).json({ error: "Invalid token" }); }
};

const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) return res.status(403).json({ error: "Forbidden" });
  next();
};

// ── Auth endpoints ──
app.post("/api/auth/login", loginIpLimiter, loginLimiter, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Missing credentials" });
  const u = db.prepare("SELECT * FROM users WHERE username = ?").get(username.toLowerCase());
  if (!u || !bcrypt.compareSync(password, u.password_hash)) {
    audit(username, "login_failed", null, req);
    return res.status(401).json({ error: "Invalid credentials" });
  }
  const clients = u.clients === "ALL" ? "ALL" : JSON.parse(u.clients);
  const token = jwt.sign({ id: u.id, username: u.username, name: u.name, role: u.role, clients, tv: u.token_version || 0 }, JWT_SECRET, { expiresIn: "24h" });
  audit(u.username, "login_success", null, req);
  res.json({ token, user: { username: u.username, name: u.name, role: u.role, clients, must_change_password: !!u.must_change_password } });
});

app.post("/api/auth/change-password", auth, (req, res) => {
  const { current, next: nextPwd } = req.body;
  if (!nextPwd || nextPwd.length < 8) return res.status(400).json({ error: "Password must be 8+ chars" });
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  if (!bcrypt.compareSync(current, u.password_hash)) return res.status(401).json({ error: "Current password wrong" });
  if (nextPwd === current) return res.status(400).json({ error: "New password must differ from current" });
  // Bump token_version → all existing sessions for this user are revoked immediately
  db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0, token_version = COALESCE(token_version,0) + 1 WHERE id = ?")
    .run(bcrypt.hashSync(nextPwd, 10), req.user.id);
  const fresh = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  const clients = fresh.clients === "ALL" ? "ALL" : JSON.parse(fresh.clients);
  // Issue a new token so THIS session continues seamlessly
  const token = jwt.sign({ id: fresh.id, username: fresh.username, name: fresh.name, role: fresh.role, clients, tv: fresh.token_version }, JWT_SECRET, { expiresIn: "24h" });
  audit(req.user.username, "password_changed", null, req);
  res.json({ ok: true, token });
});

app.get("/api/auth/me", auth, (req, res) => {
  const u = db.prepare("SELECT must_change_password FROM users WHERE id = ?").get(req.user.id);
  res.json({ ...req.user, must_change_password: !!(u && u.must_change_password) });
});

// ── Forgot / reset password (email self-service via Resend) ──
// Request a reset link. Always returns 200 (never reveals whether the account/email exists).
app.post("/api/auth/forgot", forgotLimiter, async (req, res) => {
  const generic = { ok: true, message: "Αν υπάρχει λογαριασμός με καταχωρημένο email, στάλθηκε σύνδεσμος επαναφοράς." };
  if (!EMAIL_ENABLED) return res.status(503).json({ error: "Η επαναφορά μέσω email δεν έχει ρυθμιστεί. Ζήτα από τον διαχειριστή reset." });
  const id = (req.body && req.body.username) ? String(req.body.username).trim().toLowerCase() : "";
  if (!id) return res.json(generic);
  const u = db.prepare("SELECT id, username, name, email FROM users WHERE username = ? OR lower(email) = ?").get(id, id);
  if (!u || !u.email) return res.json(generic); // unknown user or no email on file → say nothing
  const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  const tokenHash = createHmac("sha256", JWT_SECRET).update(token).digest("hex");
  const exp = Math.floor(Date.now() / 1000) + 30 * 60; // 30 minutes
  db.prepare("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(tokenHash, u.id, exp);
  const base = (APP_BASE_URL || `${req.protocol}://${req.headers.host}`).replace(/\/$/, "");
  const link = `${base}/reset?token=${token}`;
  try {
    await sendEmail(u.email, "Επαναφορά κωδικού — CBRE Reporting", resetEmailHtml(u.name || u.username, link));
    audit(u.username, "password_reset_requested", null, req);
  } catch (e) {
    console.error("Resend send failed:", e.message);
    return res.status(502).json({ error: "Αποτυχία αποστολής email — δοκίμασε ξανά ή ζήτα admin reset." });
  }
  res.json(generic);
});

// Complete the reset with the emailed token.
app.post("/api/auth/reset", async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ error: "Λείπει το token ή ο κωδικός" });
  if (String(password).length < 8) return res.status(400).json({ error: "Ο κωδικός πρέπει να έχει 8+ χαρακτήρες" });
  const tokenHash = createHmac("sha256", JWT_SECRET).update(String(token)).digest("hex");
  const row = db.prepare("SELECT * FROM password_resets WHERE token_hash = ?").get(tokenHash);
  if (!row || row.used || row.expires_at < Math.floor(Date.now() / 1000)) return res.status(400).json({ error: "Ο σύνδεσμος έληξε ή δεν ισχύει. Ζήτα νέο." });
  const u = db.prepare("SELECT id, username FROM users WHERE id = ?").get(row.user_id);
  if (!u) return res.status(400).json({ error: "Μη έγκυρος σύνδεσμος" });
  db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0, token_version = COALESCE(token_version,0) + 1 WHERE id = ?")
    .run(bcrypt.hashSync(String(password), 10), u.id);
  db.prepare("UPDATE password_resets SET used = 1 WHERE user_id = ? AND used = 0").run(u.id); // burn this + any other outstanding tokens
  audit(u.username, "password_reset_completed", null, req);
  res.json({ ok: true });
});

// ── User management (admin only) ──
app.get("/api/users", auth, requireRole("admin"), (req, res) => {
  const users = db.prepare("SELECT id, username, name, email, role, clients, created_at FROM users").all();
  res.json(users.map(u => ({ ...u, clients: u.clients === "ALL" ? "ALL" : JSON.parse(u.clients) })));
});

app.post("/api/users", auth, requireRole("admin"), (req, res) => {
  const { username, password, name, role, clients, email } = req.body;
  if (!username || !password || !name || !role) return res.status(400).json({ error: "Missing fields" });
  if (password.length < 8) return res.status(400).json({ error: "Password must be 8+ chars" });
  try {
    const c = clients === "ALL" ? "ALL" : JSON.stringify(clients || []);
    db.prepare("INSERT INTO users (username, password_hash, name, email, role, clients) VALUES (?, ?, ?, ?, ?, ?)").run(
      username.toLowerCase(), bcrypt.hashSync(password, 10), name, String(email || ""), role, c
    );
    audit(req.user.username, "user_created", username, req);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Update an existing user's email / name / client access (admin only)
app.patch("/api/users/:id", auth, requireRole("admin"), (req, res) => {
  const u = db.prepare("SELECT id FROM users WHERE id = ?").get(req.params.id);
  if (!u) return res.status(404).json({ error: "Not found" });
  const { email, name, clients } = req.body || {};
  if (email !== undefined) db.prepare("UPDATE users SET email = ? WHERE id = ?").run(String(email), req.params.id);
  if (name !== undefined) db.prepare("UPDATE users SET name = ? WHERE id = ?").run(String(name), req.params.id);
  if (clients !== undefined) db.prepare("UPDATE users SET clients = ? WHERE id = ?").run(clients === "ALL" ? "ALL" : JSON.stringify(clients || []), req.params.id);
  audit(req.user.username, "user_updated", req.params.id, req);
  res.json({ ok: true });
});

app.delete("/api/users/:id", auth, requireRole("admin"), (req, res) => {
  if (req.user.id === parseInt(req.params.id)) return res.status(400).json({ error: "Cannot delete yourself" });
  db.prepare("DELETE FROM users WHERE id = ?").run(req.params.id);
  audit(req.user.username, "user_deleted", req.params.id, req);
  res.json({ ok: true });
});

// Admin password reset: sets a temp password (given or auto-generated), forces a change on next
// login, and revokes the target user's existing sessions. Returns the temp password to show once.
app.post("/api/users/:id/reset-password", auth, requireRole("admin"), (req, res) => {
  const id = parseInt(req.params.id);
  const u = db.prepare("SELECT id, username FROM users WHERE id = ?").get(id);
  if (!u) return res.status(404).json({ error: "Not found" });
  let temp = req.body && req.body.password ? String(req.body.password) : "";
  if (temp && temp.length < 8) return res.status(400).json({ error: "Password must be 8+ chars" });
  if (!temp) temp = "CBRE!" + randomUUID().replace(/-/g, "").slice(0, 8);
  db.prepare("UPDATE users SET password_hash = ?, must_change_password = 1, token_version = COALESCE(token_version,0) + 1 WHERE id = ?")
    .run(bcrypt.hashSync(temp, 10), id);
  audit(req.user.username, "password_reset", u.username, req);
  res.json({ ok: true, username: u.username, tempPassword: temp });
});

// ── Helper: check user can access client ──
const canAccess = (user, client) => user.clients === "ALL" || (Array.isArray(user.clients) && user.clients.includes(client));

// ── Data endpoints ──
app.get("/api/data/:year/:client", auth, (req, res) => {
  const { year, client } = req.params;
  if (!canAccess(req.user, client)) return res.status(403).json({ error: "Access denied for this client" });
  const row = db.prepare("SELECT data, version, updated_at, updated_by FROM client_data WHERE year = ? AND client = ?").get(year, client);
  if (!row) return res.json({ data: null, version: 0 });
  res.json({ data: JSON.parse(row.data), version: row.version || 0, updated_at: row.updated_at, updated_by: row.updated_by });
});

// Optimistic locking: client sends { data, baseVersion }. Version mismatch → 409 (no silent overwrite).
// Legacy body shape (raw data object, no baseVersion) is still accepted without the check.
app.put("/api/data/:year/:client", auth, (req, res) => {
  const { year, client } = req.params;
  if (!canAccess(req.user, client)) return res.status(403).json({ error: "Access denied" });
  const hasEnvelope = req.body && typeof req.body === "object" && req.body.data !== undefined && ("baseVersion" in req.body);
  const payload = hasEnvelope ? req.body.data : req.body;
  const baseVersion = hasEnvelope ? Number(req.body.baseVersion) : undefined;
  const row = db.prepare("SELECT version FROM client_data WHERE year = ? AND client = ?").get(year, client);
  const currentVersion = row ? (row.version || 0) : 0;
  if (baseVersion !== undefined && !Number.isNaN(baseVersion) && row && currentVersion !== baseVersion) {
    return res.status(409).json({ error: "Data was modified by another user", version: currentVersion });
  }
  const newVersion = currentVersion + 1;
  const upsert = db.prepare(`INSERT INTO client_data (year, client, data, version, updated_at, updated_by)
    VALUES (?, ?, ?, ?, strftime('%s','now'), ?)
    ON CONFLICT(year, client) DO UPDATE SET data=excluded.data, version=excluded.version, updated_at=excluded.updated_at, updated_by=excluded.updated_by`);
  upsert.run(year, client, JSON.stringify(payload), newVersion, req.user.username);
  res.json({ ok: true, version: newVersion });
});

app.get("/api/data/:year", auth, (req, res) => {
  const { year } = req.params;
  const rows = db.prepare("SELECT client, data, updated_at FROM client_data WHERE year = ?").all(year);
  const filtered = rows.filter(r => canAccess(req.user, r.client));
  const result = {};
  filtered.forEach(r => { result[r.client] = JSON.parse(r.data); });
  res.json(result);
});

// ── Company-wide OPEX/CAPEX (finance + admin only) ──
app.get("/api/finance/:year", auth, requireRole("finance", "admin"), (req, res) => {
  const row = db.prepare("SELECT data, version, updated_at, updated_by FROM finance_data WHERE year = ?").get(req.params.year);
  if (!row) return res.json({ data: null, version: 0 });
  res.json({ data: JSON.parse(row.data), version: row.version || 0, updated_at: row.updated_at, updated_by: row.updated_by });
});

// Optimistic locking: { data, baseVersion } → 409 on version mismatch (no silent overwrite).
app.put("/api/finance/:year", auth, requireRole("finance", "admin"), (req, res) => {
  const { year } = req.params;
  const hasEnvelope = req.body && typeof req.body === "object" && req.body.data !== undefined && ("baseVersion" in req.body);
  const payload = hasEnvelope ? req.body.data : req.body;
  const baseVersion = hasEnvelope ? Number(req.body.baseVersion) : undefined;
  const row = db.prepare("SELECT version FROM finance_data WHERE year = ?").get(year);
  const currentVersion = row ? (row.version || 0) : 0;
  if (baseVersion !== undefined && !Number.isNaN(baseVersion) && row && currentVersion !== baseVersion) {
    return res.status(409).json({ error: "Data was modified by another user", version: currentVersion });
  }
  const newVersion = currentVersion + 1;
  db.prepare(`INSERT INTO finance_data (year, data, version, updated_at, updated_by)
    VALUES (?, ?, ?, strftime('%s','now'), ?)
    ON CONFLICT(year) DO UPDATE SET data=excluded.data, version=excluded.version, updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
    .run(year, JSON.stringify(payload), newVersion, req.user.username);
  res.json({ ok: true, version: newVersion });
});

// ── File uploads ──
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, FILES_DIR),
    filename: (req, file, cb) => cb(null, randomUUID() + "_" + file.originalname.replace(/[^a-zA-Z0-9._-]/g,"_"))
  }),
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB
});

app.post("/api/files/:year/:client", auth, upload.single("file"), (req, res) => {
  const { year, client } = req.params;
  if (!canAccess(req.user, client)) {
    fs.unlinkSync(req.file.path);
    return res.status(403).json({ error: "Access denied" });
  }
  const id = randomUUID();
  db.prepare(`INSERT INTO documents (id, year, client, name, type, contract_ref, file_type, size, storage_path, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, year, client, req.file.originalname,
    req.body.type || "Other", req.body.contract_ref || "",
    req.file.mimetype, req.file.size, req.file.filename, req.user.username
  );
  res.json({ id, name: req.file.originalname, size: req.file.size, type: req.body.type, contract_ref: req.body.contract_ref });
});

app.get("/api/files/:year/:client", auth, (req, res) => {
  const { year, client } = req.params;
  if (!canAccess(req.user, client)) return res.status(403).json({ error: "Access denied" });
  const docs = db.prepare("SELECT id, name, type, contract_ref, file_type, size, uploaded_by, uploaded_at FROM documents WHERE year = ? AND client = ?").all(year, client);
  res.json(docs);
});

// ── Signed, short-lived download links (no JWT in URLs → nothing sensitive in logs/history) ──
const signDownload = (id, exp) => createHmac("sha256", JWT_SECRET).update(`dl.${id}.${exp}`).digest("base64url");

app.post("/api/files/:year/:client/:id/link", auth, (req, res) => {
  const { year, client, id } = req.params;
  if (!canAccess(req.user, client)) return res.status(403).json({ error: "Access denied" });
  const doc = db.prepare("SELECT id FROM documents WHERE id = ? AND year = ? AND client = ?").get(id, year, client);
  if (!doc) return res.status(404).json({ error: "Not found" });
  const exp = Math.floor(Date.now() / 1000) + 120; // 2 minutes
  const sig = signDownload(id, exp);
  const dl = req.body && req.body.dl ? "&dl=1" : "";
  res.json({ url: `/api/files/${encodeURIComponent(year)}/${encodeURIComponent(client)}/${encodeURIComponent(id)}/download?exp=${exp}&sig=${sig}${dl}` });
});

app.get("/api/files/:year/:client/:id/download", (req, res) => {
  const { year, client, id } = req.params;
  const { exp, sig } = req.query;
  if (exp && sig) {
    // Signed-link path: issued by an authorized user moments ago
    if (Math.floor(Date.now() / 1000) > Number(exp) || sig !== signDownload(id, String(exp))) {
      return res.status(403).json({ error: "Link expired" });
    }
  } else {
    // Fallback path: Bearer token in the Authorization header only (never in the URL —
    // a JWT in a query string leaks into logs, history and Referer headers). The UI uses
    // short-lived signed links (the branch above), so this is for programmatic access.
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (!token) return res.status(401).json({ error: "No token" });
    let payload;
    try { payload = jwt.verify(token, JWT_SECRET); } catch { return res.status(401).json({ error: "Invalid token" }); }
    const u = db.prepare("SELECT id, token_version FROM users WHERE id = ?").get(payload.id);
    if (!u || (u.token_version || 0) !== (payload.tv || 0)) return res.status(401).json({ error: "Session expired" });
    if (!canAccess(payload, client)) return res.status(403).json({ error: "Access denied" });
  }
  const doc = db.prepare("SELECT * FROM documents WHERE id = ? AND year = ? AND client = ?").get(id, year, client);
  if (!doc) return res.status(404).json({ error: "Not found" });
  if (req.query.dl) return res.download(join(FILES_DIR, doc.storage_path), doc.name);
  res.sendFile(join(FILES_DIR, doc.storage_path));
});

app.delete("/api/files/:year/:client/:id", auth, (req, res) => {
  const { year, client, id } = req.params;
  if (!canAccess(req.user, client)) return res.status(403).json({ error: "Access denied" });
  const doc = db.prepare("SELECT * FROM documents WHERE id = ? AND year = ? AND client = ?").get(id, year, client);
  if (!doc) return res.status(404).json({ error: "Not found" });
  try { fs.unlinkSync(join(FILES_DIR, doc.storage_path)); } catch (e) {}
  db.prepare("DELETE FROM documents WHERE id = ?").run(id);
  res.json({ ok: true });
});

// Update a document's linked contract reference / type (used by api.updateFileRef)
app.patch("/api/files/:year/:client/:id", auth, (req, res) => {
  const { year, client, id } = req.params;
  if (!canAccess(req.user, client)) return res.status(403).json({ error: "Access denied" });
  const doc = db.prepare("SELECT id FROM documents WHERE id = ? AND year = ? AND client = ?").get(id, year, client);
  if (!doc) return res.status(404).json({ error: "Not found" });
  const { contract_ref, type } = req.body || {};
  if (contract_ref !== undefined) db.prepare("UPDATE documents SET contract_ref = ? WHERE id = ?").run(String(contract_ref), id);
  if (type !== undefined) db.prepare("UPDATE documents SET type = ? WHERE id = ?").run(String(type), id);
  res.json({ ok: true });
});

// ── Audit log (admin only) ──
app.get("/api/audit", auth, requireRole("admin"), (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const logs = db.prepare("SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ?").all(limit);
  res.json(logs);
});

// ── AI Extraction (Anthropic Claude proxy) ──
const extractLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30, // 30 extractions/min per USER (not per shared office IP)
  keyGenerator: (req) => (req.user ? `u${req.user.id}` : req.ip)
});
const extractUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB max

const callClaudeExtract = async (file, prompt) => {
  if (!anthropic) throw new Error("AI extraction not configured (missing ANTHROPIC_API_KEY)");
  const isPdf = file.mimetype === "application/pdf";
  const isImg = file.mimetype.startsWith("image/");
  if (!isPdf && !isImg) throw new Error("Unsupported file type: " + file.mimetype);
  const base64 = file.buffer.toString("base64");
  const content = isPdf
    ? [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }, { type: "text", text: prompt }]
    : [{ type: "image", source: { type: "base64", media_type: file.mimetype, data: base64 } }, { type: "text", text: prompt }];
  const resp = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1500,
    messages: [{ role: "user", content }]
  });
  const text = resp.content?.[0]?.text || "";
  const clean = text.replace(/```json|```/g, "").trim();
  const m = clean.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("No JSON in AI response");
  return JSON.parse(m[0]);
};

// POST /api/extract/invoice — extract invoice fields from PDF/image (vision-enabled)
app.post("/api/extract/invoice", auth, extractLimiter, extractUpload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const mode = (req.body.mode || "AP").toUpperCase(); // AR or AP

  const prompt = `You are an invoice data extraction system for Greek and English invoices. Extract fields and respond with ONLY valid JSON (no markdown, no commentary).

═══════════════════════════════════════════════════════════
CRITICAL — SUPPLIER vs CUSTOMER DISTINCTION
═══════════════════════════════════════════════════════════

The SUPPLIER is the company that ISSUED this invoice (will RECEIVE payment).
The CUSTOMER is the company that RECEIVED the invoice (will PAY).
NEVER confuse them.

How to find the SUPPLIER (issuer) in a Greek invoice:
• Logo + company name at the TOP HEADER of the page
• Company info block at top: name, address, Α.Φ.Μ., ΔΟΥ, ΓΕΜΗ
• Often appears with "Έκδοση" / "Εκδόθηκε από" / "Issued by"

How to identify the CUSTOMER (recipient — NOT the supplier):
• Under sections labeled:
  - "ΣΤΟΙΧΕΙΑ ΠΕΛΑΤΗ" / "Στοιχεία Πελάτη" / "Client's Particulars"
  - "ΣΤΟΙΧΕΙΑ ΣΥΝΑΛΛΑΣΣΟΜΕΝΟΥ"
  - "Επωνυμία Πελάτη" / "Client's Name" / "Bill to"
  - "Πελάτης" / "Customer"
• If "CBRE HELLAS" appears under any of these → CBRE is the CUSTOMER, not the supplier.

For ${mode === "AUTO" ? "AUTO mode (mixed folder — you MUST detect the direction of EACH invoice)" : mode === "AR" ? "AR mode (CBRE-issued client invoices)" : "AP mode (supplier invoices billed TO CBRE)"}:
${mode === "AUTO"
  ? "→ DIRECTION DETECTION (critical): supplier_name = the ISSUER at the top header (always). Set direction=\"AR\" ONLY IF that ISSUER is CBRE Hellas itself (e.g. \"CBRE Hellas Μονοπροσωπή ΑΕ\" or \"CBRE Hellas Single Member SA\") — that is the ONLY AR case (CBRE billing a client = revenue). For EVERY other issuer — including ATRIA / Atria and any vendor or subcontractor — set direction=\"AP\" (cost to CBRE). ATRIA is NOT CBRE; an ATRIA-issued invoice is ALWAYS AP."
  : mode === "AR"
  ? "→ supplier_name = CBRE Hellas (the issuer at the top header, e.g. \"CBRE Hellas Μονοπροσωπή ΑΕ\" / \"CBRE Hellas Single Member SA\"). Set direction=\"AR\"."
  : "→ supplier_name = the VENDOR who billed CBRE (the company at the TOP HEADER). It is NEVER 'CBRE Hellas'. Set direction=\"AP\"."}

═══════════════════════════════════════════════════════════
INVOICE NUMBER — always present, never leave blank
═══════════════════════════════════════════════════════════

Look for these labels in the document header:
• "Αριθμός Παραστατικού" / "Αρ. Παραστατικού" / "Doc Number"
• "ΑΡΙΘΜΟΣ" / "Νο" / "Nb" / "No." / "Number"
• "Σειρά - Αριθμός" / "Series - Number"
• Often appears right next to "ΤΙΜΟΛΟΓΙΟ ΠΑΡΟΧΗΣ ΥΠΗΡΕΣΙΩΝ" or in a table cell

Always include the prefix as printed. Examples of valid invoice numbers:
• "ΤΠΥ-08408", "Α-ΤΙΜ0129366", "ΤΠΥI 12559", "Α 661", "3343", "10"

If the document title says "ΤΙΜΟΛΟΓΙΟ ΠΑΡΟΧ.ΥΠΗΡΕΣΙΩΝ" and a number "12559" appears nearby → that IS the invoice number.

═══════════════════════════════════════════════════════════
AMOUNT EXTRACTION — bottom summary only
═══════════════════════════════════════════════════════════

Find the BOTTOM SUMMARY of the invoice. Look for these labels:
• ΚΑΘΑΡΗ ΑΞΙΑ / Net Value / Καθαρή Αξία / Cost excl. VAT / Αξία προ ΦΠΑ → net_amount
• ΑΞΙΑ Φ.Π.Α. / ΦΠΑ / VAT / VAT Cost / Αξία Φ.Π.Α. → vat_amount
• ΠΛΗΡΩΤΕΟ / Σύνολο / Total / Πληρωτέο Ποσό / Συνολική Τελική Αξία / Σύνολο (ευρώ) → total_amount

⚠️ CRITICAL — IGNORE THESE FIELDS (they are NOT invoice amounts):
• "ΠΡΟΗΓ. ΥΠΟΛΟΙΠΟ" / "Προηγούμενο Υπόλοιπο" — previous account balance
• "ΝΕΟ ΥΠΟΛΟΙΠΟ" / "Νέο Υπόλοιπο" — running account balance
• Bank account numbers, IBAN
• Anything labeled "balance" or "υπόλοιπο"

⚠️ Greek line-item tables have columns ΠΟΣΟΤΗΤΑ | ΤΙΜΗ | ΑΞΙΑ | ΕΚΠΤ% | ΑΞΙΑ | ΦΠΑ%.
The "ΑΞΙΑ" in line items is PER LINE, not the total. Always use the bottom summary totals.

═══════════════════════════════════════════════════════════
HARD VALIDATION — must pass before returning
═══════════════════════════════════════════════════════════

Before returning JSON, verify:
1. net_amount > vat_amount (ALWAYS for Greek VAT 6/13/24%). If vat ≥ net, you have swapped them — fix it.
2. |net_amount + vat_amount − total_amount| < 0.05 (within rounding)
3. vat_amount ≈ net_amount × (vat_rate/100) ± 0.05
4. net_amount ≠ 0 when total_amount > 0
5. The numbers must come from the invoice's OWN bottom summary, never from a "ΠΡΟΗΓ ΥΠΟΛΟΙΠΟ" balance.

If validation fails, re-examine the document before answering.

═══════════════════════════════════════════════════════════
COMMON PITFALLS (real examples — do not repeat these mistakes)
═══════════════════════════════════════════════════════════

PITFALL 1 — ATRIA invoicing CBRE:
Header: "ATRIA ΥΠΗΡΕΣΙΕΣ ΑΚΙΝΗΤΩΝ Α.Ε." (ΑΦΜ 999211159)
"ΣΤΟΙΧΕΙΑ ΠΕΛΑΤΗ" section: CBRE HELLAS (ΑΦΜ 800672920)
✓ CORRECT: supplier_name="ATRIA ΥΠΗΡΕΣΙΕΣ ΑΚΙΝΗΤΩΝ Α.Ε.", afm="999211159"
✗ WRONG: supplier_name="CBRE HELLAS"

PITFALL 2 — Rainbow Waters multi-page statement:
Each page shows: ΣΥΝ.ΠΟΣΟΤ 1,00 | ΑΞΙΑ 112,32 | ΦΠΑ 26,96 | ΣΥΝΟΛΟ ΑΓΟΡΩΝ 139,28
Also: ΠΡΟΗΓ.ΥΠΟΛΟΙΠΟ 6.066,15 (account balance — IGNORE)
✓ CORRECT: net=112.32, vat=26.96, total=139.28
✗ WRONG: vat=6066.15 (that's the account balance, not invoice VAT)

PITFALL 3 — Landscape ΤΠΥ-08408 single-line invoice:
Single line: ΚΗΠΟΤΕΧΝΙΚΕΣ ΕΡΓΑΣΙΕΣ | 1,00 | 45,00 | 24%
Bottom: ΚΑΘΑΡΗ ΑΞΙΑ 45,00 | ΑΞΙΑ Φ.Π.Α. 10,80 | ΠΛΗΡΩΤΕΟ ΠΟΣΟ 55,80
✓ CORRECT: net=45.00, vat=10.80, total=55.80
✗ WRONG: net=0, vat=45, total=45 (violates net > vat!)

PITFALL 4 — Documents starting with "<%SP1>" or other markup:
The PDF text may begin with internal markup tags. Skip these.
The real supplier name (e.g. "A&M Architects A.E.") is in the visible logo/header.

═══════════════════════════════════════════════════════════
OUTPUT FORMAT (JSON only, no markdown)
═══════════════════════════════════════════════════════════

{
  "supplier_name": "name of ISSUER (top header). Greek or English. Max 60 chars.",
  "direction": "AP or AR — AR ONLY if the ISSUER is CBRE Hellas itself (Μονοπροσωπή ΑΕ / Single Member SA). ATRIA and every other issuer = AP. Always include this field.",
  "afm": "issuer's 9-digit ΑΦΜ (no EL prefix, no spaces)",
  "invoice_number": "full invoice number with prefix as printed (e.g. ΤΠΥ-08408, Α-ΤΙΜ0129366)",
  "invoice_date": "DD/MM/YYYY",
  "month": "YYYY-MM",
  "net_amount": numeric_net_pre_vat_EUR,
  "vat_amount": numeric_vat_EUR,
  "vat_rate": numeric_percent_24_or_13_or_6_or_0,
  "total_amount": numeric_total_with_vat_EUR,
  "description": "brief description of goods/services (max 80 chars)",
  "is_credit_note": true_if_ΠΙΣΤΩΤΙΚΟ_ΤΙΜΟΛΟΓΙΟ_else_false
}

For credit notes (ΠΙΣΤΩΤΙΚΟ ΤΙΜΟΛΟΓΙΟ): all amounts NEGATIVE.
Convert EU decimals: "1.234,56" → 1234.56`;

  try {
    const data = await callClaudeExtract(req.file, prompt);

    // ── Server-side validation & auto-correction (pure fn — unit-tested in lib/validate.js) ──
    const { net, vat, total, warnings } = validateAmounts(data);

    if (warnings.length) console.log(`[extract/invoice] warnings:`, warnings);

    res.json({
      ...data,
      net_amount: net,
      vat_amount: vat,
      total_amount: total,
      _warnings: warnings.length ? warnings : undefined
    });
  } catch (e) {
    console.error("Extract invoice error:", e.message);
    res.status(500).json({ error: e.message || "Extraction failed" });
  }
});

// POST /api/extract/contract — extract contract metadata from PDF/image
app.post("/api/extract/contract", auth, extractLimiter, extractUpload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const prompt = `You are a contract data extraction system. Read this document and respond with ONLY valid JSON, no markdown:

{
  "type": "MSA|LEA|PO|Amendment|NDA|Other",
  "ref": "contract reference number / PO number / agreement ID",
  "client": "client company name",
  "start": "DD/MM/YYYY (effective date)",
  "expiry": "DD/MM/YYYY (expiration / end date)",
  "fee_pct": numeric management fee percent (default 5.5 if not specified),
  "po": "PO number if this is or relates to a PO",
  "po_value": numeric PO value in EUR (no currency symbol),
  "scope": "brief scope of services (max 80 chars)",
  "notes": "key terms or important details (max 100 chars)"
}

Rules:
- Type detection: MSA = Master Service Agreement; LEA/LCA = Local Country / Local Enabling Agreement; PO = Purchase Order; Amendment = contract amendment/addendum; NDA = Non-disclosure Agreement
- Use empty string "" or 0 if a field is missing
- Output JSON only.`;

  try {
    const data = await callClaudeExtract(req.file, prompt);
    res.json(data);
  } catch (e) {
    console.error("Extract contract error:", e.message);
    res.status(500).json({ error: e.message || "Extraction failed" });
  }
});

// ── Health check ──
app.get("/api/health", (req, res) => res.json({ status: "ok", ai_enabled: !!anthropic, email_enabled: EMAIL_ENABLED, timestamp: Date.now() }));

// Unknown API routes → JSON 404 (must come before the SPA catch-all, which would
// otherwise return index.html with a 200 and mask typos/removed endpoints).
app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));

// ── Serve frontend (production) ──
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
  app.get("*", (req, res) => res.sendFile(join(PUBLIC_DIR, "index.html")));
}

app.listen(PORT, () => {
  console.log(`✓ CBRE Backend running on port ${PORT}`);
  console.log(`  Data dir: ${DATA_DIR}`);
  console.log(`  Files dir: ${FILES_DIR}`);
  console.log(`  Frontend: ${fs.existsSync(PUBLIC_DIR) ? "✓" : "⚠ not found"}`);
  console.log(`  AI Extraction: ${anthropic ? "✓ enabled (Claude)" : "✗ disabled (set ANTHROPIC_API_KEY)"}`);
  console.log(`  Email reset: ${EMAIL_ENABLED ? `✓ enabled (SMTP ${SMTP_HOST})` : "✗ disabled (set SMTP_USER/SMTP_PASS)"}`);
});

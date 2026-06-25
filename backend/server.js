import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import Database from "better-sqlite3";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import fs from "fs";
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || "/data";
const FILES_DIR = join(DATA_DIR, "files");
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "change-me-in-production";
const PUBLIC_DIR = join(__dirname, "public");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });

const db = new Database(join(DATA_DIR, "cbre.db"));
db.pragma("journal_mode = WAL");

// Anthropic client (for AI invoice/contract extraction)
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;
if (!anthropic) console.warn("⚠ ANTHROPIC_API_KEY not set — AI extraction endpoints disabled");

const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: process.env.CORS_ORIGIN || "*", credentials: true }));
app.use(express.json({ limit: "20mb" }));

// Rate limit on login
const loginLimiter = rateLimit({ windowMs: 15*60*1000, max: 10, message: { error: "Too many login attempts" } });

// ── Audit log ──
const auditStmt = db.prepare("INSERT INTO audit_log (user, action, target, ip) VALUES (?, ?, ?, ?)");
const audit = (user, action, target, req) => auditStmt.run(user, action, target||"", req.ip||"");

// ── Auth middleware ──
const auth = (req, res, next) => {
  const token = req.headers.authorization?.replace("Bearer ", "") || req.query.token;
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: "Invalid token" }); }
};

const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) return res.status(403).json({ error: "Forbidden" });
  next();
};

// ── Auth endpoints ──
app.post("/api/auth/login", loginLimiter, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Missing credentials" });
  const u = db.prepare("SELECT * FROM users WHERE username = ?").get(username.toLowerCase());
  if (!u || !bcrypt.compareSync(password, u.password_hash)) {
    audit(username, "login_failed", null, req);
    return res.status(401).json({ error: "Invalid credentials" });
  }
  const clients = u.clients === "ALL" ? "ALL" : JSON.parse(u.clients);
  const token = jwt.sign({ id: u.id, username: u.username, name: u.name, role: u.role, clients }, JWT_SECRET, { expiresIn: "24h" });
  audit(u.username, "login_success", null, req);
  res.json({ token, user: { username: u.username, name: u.name, role: u.role, clients } });
});

app.post("/api/auth/change-password", auth, (req, res) => {
  const { current, next: nextPwd } = req.body;
  if (!nextPwd || nextPwd.length < 8) return res.status(400).json({ error: "Password must be 8+ chars" });
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  if (!bcrypt.compareSync(current, u.password_hash)) return res.status(401).json({ error: "Current password wrong" });
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(bcrypt.hashSync(nextPwd, 10), req.user.id);
  audit(req.user.username, "password_changed", null, req);
  res.json({ ok: true });
});

app.get("/api/auth/me", auth, (req, res) => res.json(req.user));

// ── User management (admin only) ──
app.get("/api/users", auth, requireRole("admin"), (req, res) => {
  const users = db.prepare("SELECT id, username, name, role, clients, created_at FROM users").all();
  res.json(users.map(u => ({ ...u, clients: u.clients === "ALL" ? "ALL" : JSON.parse(u.clients) })));
});

app.post("/api/users", auth, requireRole("admin"), (req, res) => {
  const { username, password, name, role, clients } = req.body;
  if (!username || !password || !name || !role) return res.status(400).json({ error: "Missing fields" });
  if (password.length < 8) return res.status(400).json({ error: "Password must be 8+ chars" });
  try {
    const c = clients === "ALL" ? "ALL" : JSON.stringify(clients || []);
    db.prepare("INSERT INTO users (username, password_hash, name, role, clients) VALUES (?, ?, ?, ?, ?)").run(
      username.toLowerCase(), bcrypt.hashSync(password, 10), name, role, c
    );
    audit(req.user.username, "user_created", username, req);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete("/api/users/:id", auth, requireRole("admin"), (req, res) => {
  if (req.user.id === parseInt(req.params.id)) return res.status(400).json({ error: "Cannot delete yourself" });
  db.prepare("DELETE FROM users WHERE id = ?").run(req.params.id);
  audit(req.user.username, "user_deleted", req.params.id, req);
  res.json({ ok: true });
});

// ── Helper: check user can access client ──
const canAccess = (user, client) => user.clients === "ALL" || (Array.isArray(user.clients) && user.clients.includes(client));

// ── Data endpoints ──
app.get("/api/data/:year/:client", auth, (req, res) => {
  const { year, client } = req.params;
  if (!canAccess(req.user, client)) return res.status(403).json({ error: "Access denied for this client" });
  const row = db.prepare("SELECT data, updated_at, updated_by FROM client_data WHERE year = ? AND client = ?").get(year, client);
  if (!row) return res.json({ data: null });
  res.json({ data: JSON.parse(row.data), updated_at: row.updated_at, updated_by: row.updated_by });
});

app.put("/api/data/:year/:client", auth, (req, res) => {
  const { year, client } = req.params;
  if (!canAccess(req.user, client)) return res.status(403).json({ error: "Access denied" });
  const data = JSON.stringify(req.body);
  const upsert = db.prepare(`INSERT INTO client_data (year, client, data, updated_at, updated_by)
    VALUES (?, ?, ?, strftime('%s','now'), ?)
    ON CONFLICT(year, client) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at, updated_by=excluded.updated_by`);
  upsert.run(year, client, data, req.user.username);
  res.json({ ok: true });
});

app.get("/api/data/:year", auth, (req, res) => {
  const { year } = req.params;
  const rows = db.prepare("SELECT client, data, updated_at FROM client_data WHERE year = ?").all(year);
  const filtered = rows.filter(r => canAccess(req.user, r.client));
  const result = {};
  filtered.forEach(r => { result[r.client] = JSON.parse(r.data); });
  res.json(result);
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

app.get("/api/files/:year/:client/:id/download", auth, (req, res) => {
  const { year, client, id } = req.params;
  if (!canAccess(req.user, client)) return res.status(403).json({ error: "Access denied" });
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

// ── Audit log (admin only) ──
app.get("/api/audit", auth, requireRole("admin"), (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const logs = db.prepare("SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ?").all(limit);
  res.json(logs);
});

// ── AI Extraction (Anthropic Claude proxy) ──
const extractLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 }); // 30 extractions/min/user
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

For ${mode === "AR" ? "AR mode (CBRE-issued client invoices)" : "AP mode (supplier invoices billed TO CBRE)"}:
${mode === "AR"
  ? "→ supplier_name = CBRE Hellas or Atria (the issuer at the top header)"
  : "→ supplier_name = the VENDOR who billed CBRE (the company at the TOP HEADER). It is NEVER 'CBRE Hellas'."}

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

    // ── Server-side validation & auto-correction ──
    const warnings = [];
    let net = Number(data.net_amount) || 0;
    let vat = Number(data.vat_amount) || 0;
    let total = Number(data.total_amount) || 0;
    const rate = Number(data.vat_rate) || 24;
    const isCredit = !!data.is_credit_note;
    const absNet = Math.abs(net), absVat = Math.abs(vat), absTotal = Math.abs(total);

    // Rule 1: net must be > vat (Greek VAT max 24%)
    if (absVat > absNet && absNet > 0) {
      warnings.push(`vat(${absVat}) > net(${absNet}) — swapped automatically`);
      [net, vat] = [vat, net];
    }

    // Rule 2: if net=0 but total>0 → derive
    if (Math.abs(net) === 0 && Math.abs(total) > 0) {
      warnings.push("net=0 with total>0 — derived from total/vat_rate");
      const derivedNet = total / (1 + rate / 100);
      const derivedVat = total - derivedNet;
      net = Math.round(derivedNet * 100) / 100;
      vat = Math.round(derivedVat * 100) / 100;
    }

    // Rule 3: if total=0 but net+vat>0
    if (Math.abs(total) === 0 && (Math.abs(net) > 0 || Math.abs(vat) > 0)) {
      warnings.push("total=0 — derived from net+vat");
      total = net + vat;
    }

    // Rule 4: arithmetic sanity
    const sumCheck = Math.abs(Math.abs(net) + Math.abs(vat) - Math.abs(total));
    if (sumCheck > 0.05) {
      warnings.push(`net+vat ≠ total (diff=${sumCheck.toFixed(2)})`);
    }

    // Rule 5: detect "previous balance" hijack — vat absurdly bigger than net×rate
    if (Math.abs(net) > 0 && rate > 0) {
      const expectedVat = Math.abs(net) * (rate / 100);
      if (Math.abs(vat) > expectedVat * 2.5) {
        warnings.push(`vat(${Math.abs(vat)}) far exceeds net×rate(${expectedVat.toFixed(2)}) — possible statement-balance hijack`);
      }
    }

    // Restore sign for credit notes
    if (isCredit) {
      if (net > 0) net = -net;
      if (vat > 0) vat = -vat;
      if (total > 0) total = -total;
    }

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
app.get("/api/health", (req, res) => res.json({ status: "ok", ai_enabled: !!anthropic, timestamp: Date.now() }));

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
});

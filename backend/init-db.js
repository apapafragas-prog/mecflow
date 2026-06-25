// Initialize SQLite database with schema and default users
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || "/data";
const dbPath = join(DATA_DIR, "cbre.db");

console.log(`Initializing database at: ${dbPath}`);

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin','ops','finance')),
    clients TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS client_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    year TEXT NOT NULL,
    client TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at INTEGER DEFAULT (strftime('%s','now')),
    updated_by TEXT,
    UNIQUE(year, client)
  );

  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    year TEXT NOT NULL,
    client TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT,
    contract_ref TEXT,
    file_type TEXT,
    size INTEGER,
    storage_path TEXT NOT NULL,
    uploaded_by TEXT,
    uploaded_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    timestamp INTEGER DEFAULT (strftime('%s','now')),
    ip TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_data_year_client ON client_data(year, client);
  CREATE INDEX IF NOT EXISTS idx_docs_year_client ON documents(year, client);
  CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(timestamp);
`);

// Default users — change passwords on first login!
const defaultUsers = [
  { username: "antonis", password: "ChangeMe!2026", name: "Antonis", role: "admin", clients: "ALL" },
  { username: "manos",   password: "ChangeMe!2026", name: "Manos",   role: "finance", clients: "ALL" },
  { username: "kostas",  password: "ChangeMe!2026", name: "Kostas",  role: "ops",
    clients: ["Coca-Cola","Pfizer","Mondelez","Kenvue","Sanofi","Novartis","GSK","Gilead","Sandoz","Opella","Medtronic","Syngenta","Henkel","Tetra Pak"] },
  { username: "omiros",  password: "ChangeMe!2026", name: "Omiros",  role: "ops",
    clients: ["IBM","Iron Mountain","Ericsson","Lenovo","Dell","Worldline","Bank of America","Citibank","JPMorgan","Goldman Sachs","Bloomberg","Broadcom","Google","Philips","Kyndryl"] },
  { username: "iro",     password: "ChangeMe!2026", name: "Iro",     role: "ops",
    clients: ["FedEx","Foundever","LNW Hellas","Minerva SA","Dacia","BP Hellas","GE","Uber"] },
];

const insert = db.prepare(`INSERT OR IGNORE INTO users (username, password_hash, name, role, clients) VALUES (?, ?, ?, ?, ?)`);
for (const u of defaultUsers) {
  const hash = bcrypt.hashSync(u.password, 10);
  const clients = u.clients === "ALL" ? "ALL" : JSON.stringify(u.clients);
  insert.run(u.username, hash, u.name, u.role, clients);
}

const count = db.prepare("SELECT COUNT(*) as n FROM users").get().n;
console.log(`✓ Database ready. Users: ${count}`);
console.log("\n⚠ DEFAULT PASSWORDS: 'ChangeMe!2026' for all users");
console.log("⚠ Change these immediately after first login\n");

db.close();

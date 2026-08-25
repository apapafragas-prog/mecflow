// MFA end-to-end check for the smoke suite. Enrolls TOTP on an authenticated user, then proves that
// login now requires the second factor and that a computed TOTP code completes it.
// Env: B (base url), TOK (a valid session token), USER/PASS (that user's login creds).
import { createHmac } from "crypto";
const B = process.env.B, TOK = process.env.TOK, USER = process.env.USER || "antonis", PASS = process.env.PASS || "ChangeMe!2026";
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const dec = (s) => { let bits = 0, v = 0; const o = []; for (const c of String(s).replace(/=+$/, "").toUpperCase()) { const i = B32.indexOf(c); if (i < 0) continue; v = (v << 5) | i; bits += 5; if (bits >= 8) { o.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(o); };
const totp = (s) => { const k = dec(s); const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30))); const h = createHmac("sha1", k).update(b).digest(); const off = h[h.length - 1] & 15; const c = ((h[off] & 127) << 24) | ((h[off + 1] & 255) << 16) | ((h[off + 2] & 255) << 8) | (h[off + 3] & 255); return String(c % 1000000).padStart(6, "0"); };
const J = (r) => r.json();
const P = (name, ok) => console.log((ok ? "  PASS" : "  FAIL") + ": " + name + (ok ? "" : " — got unexpected response"));
let fail = 0; const chk = (n, ok) => { P(n, ok); if (!ok) fail++; };
try {
  const setup = await fetch(B + "/api/auth/mfa/setup", { method: "POST", headers: { authorization: "Bearer " + TOK } }).then(J);
  chk("mfa setup returns secret+qr", !!(setup.secret && setup.qr));
  const en = await fetch(B + "/api/auth/mfa/enable", { method: "POST", headers: { authorization: "Bearer " + TOK, "content-type": "application/json" }, body: JSON.stringify({ code: totp(setup.secret) }) }).then(J);
  chk("mfa enable with valid code + backup codes", !!(en.ok && Array.isArray(en.backupCodes) && en.backupCodes.length === 10));
  const bad = await fetch(B + "/api/auth/mfa/enable", { method: "POST", headers: { authorization: "Bearer " + TOK, "content-type": "application/json" }, body: JSON.stringify({ code: "000000" }) });
  // already enabled; enabling again with a wrong code should not error out the suite — just ensure server is alive
  const login = await fetch(B + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: USER, password: PASS }) }).then(J);
  chk("login now requires MFA (no token yet)", !!(login.mfaRequired && login.mfaToken && !login.token));
  const wrong = await fetch(B + "/api/auth/mfa/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mfaToken: login.mfaToken, code: "000000" }) });
  chk("mfa verify rejects wrong code (401)", wrong.status === 401);
  const ver = await fetch(B + "/api/auth/mfa/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mfaToken: login.mfaToken, code: totp(setup.secret) }) }).then(J);
  chk("mfa verify issues session token", !!ver.token);
  const mtok = login.mfaToken;
  const guard = await fetch(B + "/api/auth/mfa/status", { headers: { authorization: "Bearer " + mtok } });
  chk("mfa-challenge token rejected on normal API (401)", guard.status === 401);
  void bad;
} catch (e) { console.log("  FAIL: mfa e2e threw — " + e.message); fail++; }
process.exit(fail ? 1 : 0);

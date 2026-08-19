// Authentication screens, extracted from App.jsx.
//   Login          — username + access-code sign-in, with inline forgot-password flow.
//   ForcePw        — mandatory change when the account still uses a seeded/default password.
//   ResetPassword  — reached from the emailed reset link (/reset?token=…).
// All three share AuthShell (a CBRE-green geometric background) + BrandCard (the centered card),
// giving a single branded look inspired by the Metron sign-in, in CBRE colours with a mint accent.
import { useState } from "react";
import { api, setToken } from "./api.js";
import { P } from "./constants.js";
import { PwField, LangToggle } from "./ui.jsx";
import { useT } from "./i18n.jsx";

// CBRE 2026 brand palette (never the old #003F2D): CBRE Green #003F2D, Accent Green #17E88F
// (sparingly), Dark Green #012A2D.
const ACCENT = "#17E88F";
const DARK = "#003F2D";
const DARKER = "#012A2D";

// Official CBRE logo — white version, for dark/green backgrounds. Brand rules forbid typing "CBRE"
// in any font, so the proprietary letterforms are embedded from the official SVG.
function CbreLogo({ height = 34 }) {
  return (
    <svg viewBox="0 0 81 20.13" height={height} width={height * (81 / 20.13)} role="img" aria-label="CBRE" style={{ display: "block" }}>
      <path fill="#fff" d="M33.57,15.41h-6.68v-3.36h6.83h0.02l0.02,0c0.85,0.1,1.5,0.81,1.5,1.65C35.24,14.61,34.48,15.4,33.57,15.41 M26.89,4.37h6.99h0.03l0.02,0c0.79,0.14,1.37,0.81,1.37,1.6c0,0.81-0.62,1.57-1.44,1.68l-6.98,0.01L26.89,4.37z M36.83,9.74c2.56-0.85,3.02-3,3.02-4.75c0-2.68-1.89-4.99-7.48-4.99L21.94,0v20.09h10.4c5.62,0,7.69-2.88,7.69-5.78C40.02,10.82,36.83,9.74,36.83,9.74 M63.38,0v20.13H81l0-4.59H68.28v-3.51h11.46V7.63H68.28l-0.01-3.24h12.71L81,0H63.38z M55.79,6.26c-0.09,0.66-0.75,1.38-1.57,1.38l-6.88,0V4.43h6.88c0.82,0,1.47,0.6,1.57,1.4V6.26z M53.12,0.03H42.47v20.1h4.89V12l5.39,0c1.54,0.02,2.74,1.29,2.74,2.85v5.27l4.79,0l-0.01-6.49c0-3.01-2.9-3.89-2.9-3.89s2.97-0.89,2.97-4.44C60.34,0.94,56.6,0.03,53.12,0.03 M18.76,15.27c-0.07,0-6.69,0.13-8.97-0.09c-3.68-0.36-4.98-3.09-4.98-5.31c0-2.77,1.89-4.82,4.82-5.2c1.39-0.18,9.01-0.1,9.1-0.1l0.16,0L18.9,0h-0.16l-8.63,0.02C9.15,0.08,7.56,0.17,5.93,0.84C4.36,1.56,3,2.66,1.98,4.03C0.69,5.78,0,7.85,0,10.02c0,0.68,0.05,1.36,0.16,2.01c0.62,3.05,2.62,5.57,5.48,6.92c0.97,0.43,2.46,0.94,5.47,1.11c0.01,0,1.62,0.03,1.62,0.03c0,0,6.01,0.01,6.01,0.01h0.16l0.02-4.84L18.76,15.27z" />
    </svg>
  );
}

// Decorative constellation + triangle motif behind the card (deterministic — no randomness).
function AuthBgSvg() {
  const nodes = [[8,18],[20,40],[15,72],[31,58],[40,24],[52,49],[63,16],[70,43],[79,71],[88,31],[92,61],[35,86],[60,80],[47,68]];
  const links = [[0,1],[1,3],[3,5],[5,7],[7,9],[4,5],[6,7],[8,10],[3,11],[5,13],[13,12],[12,8],[1,2],[2,3],[4,6],[9,10],[10,8]];
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0.5, pointerEvents: "none" }} aria-hidden="true">
      <g stroke={ACCENT} strokeWidth="0.12" opacity="0.35">
        {links.map(([a, b], i) => <line key={i} x1={nodes[a][0]} y1={nodes[a][1]} x2={nodes[b][0]} y2={nodes[b][1]} />)}
      </g>
      {nodes.map(([x, y], i) => <circle key={i} cx={x} cy={y} r={i % 3 === 0 ? 0.55 : 0.32} fill={ACCENT} opacity="0.55" />)}
      {/* Large faint triangle motif, echoing a geometric brand mark */}
      <polygon points="82,88 96,88 89,74" fill="none" stroke={ACCENT} strokeWidth="0.18" opacity="0.25" />
      <polygon points="4,6 18,6 11,20" fill="none" stroke="#fff" strokeWidth="0.15" opacity="0.12" />
    </svg>
  );
}

// Full-screen branded background wrapper.
function AuthShell({ children }) {
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, fontFamily: "Segoe UI,Tahoma,sans-serif", position: "relative", overflow: "hidden",
      background: "radial-gradient(1100px 620px at 14% 8%, #005A3E 0%, rgba(0,90,62,0) 60%), radial-gradient(1000px 720px at 92% 96%, #012A2D 0%, rgba(1,42,45,0) 55%), linear-gradient(135deg,#012A2D 0%,#003F2D 55%,#012A2D 100%)" }}>
      <AuthBgSvg />
      <div style={{ position: "relative", zIndex: 1, width: "100%", maxWidth: 400 }}>{children}</div>
    </div>
  );
}

// Centered card: dark-green header band with the CBRE wordmark + tagline, white body.
function BrandCard({ subtitle, children }) {
  const { t } = useT();
  return (
    <div style={{ background: "#fff", borderRadius: 16, overflow: "hidden", boxShadow: "0 26px 70px rgba(0,0,0,.45), 0 2px 10px rgba(0,0,0,.25)" }}>
      <div style={{ background: `linear-gradient(135deg, ${DARK} 0%, ${DARKER} 100%)`, padding: "28px 32px 22px", textAlign: "center", position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", top: -22, right: -18, width: 90, height: 90, border: `1px solid ${ACCENT}`, opacity: 0.18, transform: "rotate(45deg)", borderRadius: 8 }} />
        <div style={{ display: "flex", justifyContent: "center" }}><CbreLogo height={34} /></div>
        <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 2, color: ACCENT, marginTop: 12 }}>{subtitle || t("ΑΝΑΦΟΡΕΣ · P&L · ΑΝΑΛΥΤΙΚΑ", "REPORTING · P&L · ANALYTICS")}</div>
      </div>
      <div style={{ padding: "20px 32px 26px", position: "relative" }}>{children}</div>
    </div>
  );
}

const LBL = { fontSize: 10.5, fontWeight: 700, letterSpacing: 1, color: P.tm, display: "block", marginBottom: 6, textTransform: "uppercase" };
const INP = { width: "100%", padding: "12px 14px", border: "1px solid " + P.bd, borderRadius: 8, fontSize: 14, outline: "none", background: "#F7F9F8", boxSizing: "border-box" };
const BTN = { width: "100%", background: DARK, color: "#fff", border: "none", padding: "13px", borderRadius: 8, fontSize: 14, fontWeight: 700, letterSpacing: .5, cursor: "pointer" };
// Focus ring in the accent colour (kept inline via events so no per-field state is needed).
const onFoc = (e) => { e.target.style.borderColor = ACCENT; e.target.style.boxShadow = `0 0 0 3px rgba(23,232,143,.18)`; };
const onBlur = (e) => { e.target.style.borderColor = P.bd; e.target.style.boxShadow = "none"; };

// Reached from the emailed reset link (/reset?token=...). Sets a new password, then → login.
export function ResetPassword({ token }) {
  const { t } = useT();
  const [p1, setP1] = useState("");
  const [p2, setP2] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const go = async () => {
    if (!p1 || !p2) { setErr(t("Συμπλήρωσε και τα δύο πεδία", "Fill in both fields")); return; }
    if (p1 !== p2) { setErr(t("Οι κωδικοί δεν ταιριάζουν", "The passwords don't match")); return; }
    if (p1.length < 8) { setErr(t("Ο κωδικός πρέπει να έχει 8+ χαρακτήρες", "The password must be 8+ characters")); return; }
    setBusy(true); setErr("");
    try { await api.resetPassword(token, p1); setDone(true); }
    catch (e) { setErr(e.message || t("Αποτυχία επαναφοράς", "Reset failed")); }
    finally { setBusy(false); }
  };
  return (
    <AuthShell>
      <BrandCard>
        <div style={{ position: "absolute", top: -46, right: 8 }}><LangToggle dark /></div>
        {done ? (
          <>
            <div style={{ fontSize: 18, fontWeight: 700, color: P.gn }}>✓ {t("Ο κωδικός άλλαξε", "Password changed")}</div>
            <div style={{ fontSize: 13, color: P.tm, margin: "8px 0 22px", lineHeight: 1.5 }}>{t("Μπορείς τώρα να συνδεθείς με τον νέο σου κωδικό.", "You can now sign in with your new password.")}</div>
            <button onClick={() => { window.location.href = "/"; }} style={BTN}>{t("Σύνδεση", "Sign In")}</button>
          </>
        ) : (
          <>
            <div style={{ fontSize: 18, fontWeight: 700, color: P.em }}>🔑 {t("Ορισμός νέου κωδικού", "Set a new password")}</div>
            <div style={{ fontSize: 12.5, color: P.tm, margin: "8px 0 20px", lineHeight: 1.5 }}>{t("Όρισε τον νέο σου κωδικό πρόσβασης.", "Set your new access password.")}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div><label style={LBL}>{t("Νέος κωδικός (8+ χαρακτήρες)", "New password (8+ characters)")}</label>
                <PwField value={p1} onChange={e => { setP1(e.target.value); setErr(""); }} style={INP} onFocus={onFoc} onBlur={onBlur} autoFocus /></div>
              <div><label style={LBL}>{t("Επιβεβαίωση", "Confirm")}</label>
                <PwField value={p2} onChange={e => { setP2(e.target.value); setErr(""); }} onEnter={go} style={INP} onFocus={onFoc} onBlur={onBlur} /></div>
              {err && <div style={{ color: P.rd, fontSize: 12 }}>{err}</div>}
              <button onClick={go} disabled={busy} style={{ ...BTN, cursor: busy ? "wait" : "pointer", opacity: busy ? 0.6 : 1 }}>{busy ? t("Αποθήκευση…", "Saving…") : t("Ορισμός & σύνδεση", "Set & sign in")}</button>
              <button onClick={() => { window.location.href = "/"; }} style={{ background: "none", border: "none", color: P.tm, fontSize: 12, cursor: "pointer", textDecoration: "underline" }}>{t("Πίσω στη σύνδεση", "Back to sign in")}</button>
            </div>
          </>
        )}
      </BrandCard>
    </AuthShell>
  );
}

// Mandatory password change screen — shown when the account still uses a seeded/default password.
export function ForcePw({ onDone, onLogout }) {
  const { t } = useT();
  const [cur, setCur] = useState("");
  const [n1, setN1] = useState("");
  const [n2, setN2] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (!cur || !n1 || !n2) { setErr(t("Συμπλήρωσε όλα τα πεδία", "Fill in all fields")); return; }
    if (n1 !== n2) { setErr(t("Οι νέοι κωδικοί δεν ταιριάζουν", "The new passwords don't match")); return; }
    if (n1.length < 8) { setErr(t("Ο νέος κωδικός πρέπει να έχει 8+ χαρακτήρες", "The new password must be 8+ characters")); return; }
    if (n1 === cur) { setErr(t("Ο νέος κωδικός πρέπει να διαφέρει από τον τρέχοντα", "The new password must differ from the current one")); return; }
    setBusy(true); setErr("");
    try {
      const r = await api.changePassword(cur, n1);
      if (r && r.token) setToken(r.token); // server rotated the session — keep this one alive
      onDone();
    } catch (e) { setErr(e.message || t("Αποτυχία αλλαγής κωδικού", "Failed to change password")); }
    finally { setBusy(false); }
  };
  return (
    <AuthShell>
      <BrandCard>
        <div style={{ position: "absolute", top: -46, right: 8 }}><LangToggle dark /></div>
        <div style={{ fontSize: 18, fontWeight: 700, color: P.em }}>🔒 {t("Απαιτείται αλλαγή κωδικού", "Password change required")}</div>
        <div style={{ fontSize: 12.5, color: P.tm, margin: "8px 0 20px", lineHeight: 1.5 }}>{t("Ο λογαριασμός σου χρησιμοποιεί ακόμη τον προεπιλεγμένο κωδικό. Όρισε δικό σου για να συνεχίσεις.", "Your account still uses the default password. Set your own to continue.")}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div><label style={LBL}>{t("Τρέχων κωδικός", "Current password")}</label>
            <PwField value={cur} onChange={e => { setCur(e.target.value); setErr(""); }} style={INP} onFocus={onFoc} onBlur={onBlur} /></div>
          <div><label style={LBL}>{t("Νέος κωδικός (8+ χαρακτήρες)", "New password (8+ characters)")}</label>
            <PwField value={n1} onChange={e => { setN1(e.target.value); setErr(""); }} style={INP} onFocus={onFoc} onBlur={onBlur} /></div>
          <div><label style={LBL}>{t("Επιβεβαίωση νέου κωδικού", "Confirm new password")}</label>
            <PwField value={n2} onChange={e => { setN2(e.target.value); setErr(""); }} onEnter={go} style={INP} onFocus={onFoc} onBlur={onBlur} /></div>
          {err && <div style={{ color: P.rd, fontSize: 12 }}>{err}</div>}
          <button onClick={go} disabled={busy} style={{ ...BTN, cursor: busy ? "wait" : "pointer", opacity: busy ? 0.6 : 1 }}>
            {busy ? t("Αποθήκευση...", "Saving...") : t("Αλλαγή κωδικού & είσοδος", "Change password & sign in")}
          </button>
          <button onClick={onLogout} style={{ background: "none", border: "none", color: P.tm, fontSize: 12, cursor: "pointer", textDecoration: "underline" }}>{t("Αποσύνδεση", "Logout")}</button>
        </div>
      </BrandCard>
    </AuthShell>
  );
}

export function Login({ onLogin }) {
  const { t } = useT();
  const [u, setU] = useState("");
  const [c, setC] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [fUser, setFUser] = useState("");
  const [fMsg, setFMsg] = useState("");
  const [fBusy, setFBusy] = useState(false);
  const sendForgot = async () => {
    if (!fUser.trim()) { setFMsg(t("Βάλε username ή email", "Enter a username or email")); return; }
    setFBusy(true); setFMsg("");
    try {
      const r = await api.forgotPassword(fUser.trim());
      setFMsg(r.message || t("Αν υπάρχει λογαριασμός με καταχωρημένο email, στάλθηκε σύνδεσμος επαναφοράς.", "If an account with a registered email exists, a reset link was sent."));
    } catch (e) {
      setFMsg(e.status === 503
        ? t("Η επαναφορά μέσω email δεν είναι ενεργή ακόμη — ζήτα από τον διαχειριστή reset (⚙️ Admin → Χρήστες).", "Email reset isn't enabled yet — ask an administrator to reset it (⚙️ Admin → Users).")
        : (e.message || t("Κάτι πήγε στραβά", "Something went wrong")));
    } finally { setFBusy(false); }
  };
  const go = async () => {
    if (!u || !c) { setErr(t("Δώσε όνομα χρήστη και κωδικό", "Enter username and password")); return; }
    setBusy(true); setErr("");
    try {
      const r = await api.login(u.trim().toLowerCase(), c);
      if (r.token) setToken(r.token);
      onLogin({ user: r.user.username, name: r.user.name, role: r.user.role, clients: r.user.clients, mustChange: !!r.user.must_change_password });
    } catch (e) {
      setErr(e.message || t("Λάθος στοιχεία", "Invalid credentials"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthShell>
      <BrandCard>
        <div style={{ position: "absolute", top: -46, right: 8 }}><LangToggle dark /></div>
        <div style={{ display: "flex", flexDirection: "column", gap: 15 }}>
          <div>
            <label style={LBL}>{t("Όνομα χρήστη", "Username")}</label>
            <input value={u} onChange={e => { setU(e.target.value); setErr(""); }} onKeyDown={e => e.key === "Enter" && go()} placeholder="your.name" autoFocus
              style={INP} onFocus={onFoc} onBlur={onBlur} />
          </div>
          <div>
            <label style={LBL}>{t("Κωδικός πρόσβασης", "Password")}</label>
            <PwField value={c} onChange={e => { setC(e.target.value); setErr(""); }} onEnter={go} style={INP} onFocus={onFoc} onBlur={onBlur} />
          </div>
          {err && <div style={{ color: P.rd, fontSize: 12, padding: "2px 0" }}>{err}</div>}
          <button onClick={go} disabled={busy} style={{ ...BTN, marginTop: 2, cursor: busy ? "wait" : "pointer", opacity: busy ? 0.6 : 1 }}>
            {busy ? t("Σύνδεση...", "Signing in...") : t("Σύνδεση", "Sign In")}
          </button>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11, color: P.tm, marginTop: 2 }}>
            <span>{t("Role-Based Access · Ίχνος ελέγχου", "Role-Based Access · Audit Trail")}</span>
            <button type="button" onClick={() => { setForgot(f => !f); setFMsg(""); }} style={{ background: "none", border: "none", color: P.em, fontSize: 11, fontWeight: 700, cursor: "pointer", padding: 0, display: "flex", alignItems: "center", gap: 4 }}>🔑 {t("Επαναφορά", "Recovery")}</button>
          </div>
          {forgot && (
            <div style={{ background: P.of, border: "1px solid " + P.bd, borderRadius: 8, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ fontSize: 12, color: P.tm }}>{t("Βάλε το username ή το email σου — θα λάβεις σύνδεσμο επαναφοράς στο email σου.", "Enter your username or email — you'll get a reset link by email.")}</div>
              <input value={fUser} onChange={e => { setFUser(e.target.value); setFMsg(""); }} onKeyDown={e => e.key === "Enter" && sendForgot()} placeholder={t("username ή email", "username or email")}
                style={{ ...INP, background: "#fff", padding: "9px 12px", fontSize: 13 }} onFocus={onFoc} onBlur={onBlur} />
              <button type="button" onClick={sendForgot} disabled={fBusy} style={{ background: DARK, color: "#fff", border: "none", padding: "9px", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: fBusy ? "wait" : "pointer", opacity: fBusy ? .6 : 1 }}>{fBusy ? t("Αποστολή…", "Sending…") : t("Στείλε σύνδεσμο επαναφοράς", "Send reset link")}</button>
              {fMsg && <div style={{ color: P.em, fontSize: 12 }}>{fMsg}</div>}
              <div style={{ color: P.tm, fontSize: 11 }}>{t("Εναλλακτικά, ζήτα από τον διαχειριστή reset (⚙️ Admin → Χρήστες).", "Alternatively, ask an administrator to reset it (⚙️ Admin → Users).")}</div>
            </div>
          )}
        </div>
      </BrandCard>
      <div style={{ textAlign: "center", fontSize: 11, color: "rgba(255,255,255,.55)", marginTop: 18 }}>
        {t("Μόνο για εξουσιοδοτημένους υπαλλήλους CBRE Hellas", "Authorised CBRE Hellas employees only")}
        <div style={{ opacity: .6, marginTop: 4 }}>© {new Date().getFullYear()} CBRE Group, Inc.</div>
      </div>
    </AuthShell>
  );
}

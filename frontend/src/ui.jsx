// Reusable leaf UI components, extracted from App.jsx. Shared by every screen.
import { useState, useRef, useEffect, useMemo } from "react";
import { P, fmt, logoUrl, logoUrl2 } from "./constants.js";
import { api } from "./api.js";
import { useT } from "./i18n.jsx";

// ── MFA (two-factor) self-service enrollment modal ────────────────────────────────────────────────
// Opens on the "mf-open-mfa" window event. Setup → scan QR / enter secret → confirm code → backup codes.
// Also lets an enrolled user disable MFA (password + current code). All state lives on the server.
export function MfaSettings() {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(null);   // null=loading
  const [setup, setSetup] = useState(null);        // {secret, otpauth, qr}
  const [code, setCode] = useState("");
  const [pw, setPw] = useState("");
  const [backup, setBackup] = useState(null);      // shown once after enable
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const reset = () => { setSetup(null); setCode(""); setPw(""); setBackup(null); setErr(""); };
  useEffect(() => {
    const onOpen = () => { setOpen(true); reset(); setEnabled(null); api.mfaStatus().then(r => setEnabled(!!r.enabled)).catch(() => setEnabled(false)); };
    window.addEventListener("mf-open-mfa", onOpen);
    return () => window.removeEventListener("mf-open-mfa", onOpen);
  }, []);
  if (!open) return null;
  const startSetup = async () => { setBusy(true); setErr(""); try { setSetup(await api.mfaSetup()); } catch (e) { setErr(e.message || "error"); } finally { setBusy(false); } };
  const confirm = async () => { setBusy(true); setErr(""); try { const r = await api.mfaEnable(code.trim()); setBackup(r.backupCodes || []); setEnabled(true); } catch (e) { setErr(e.message || t("Λάθος κωδικός", "Wrong code")); } finally { setBusy(false); } };
  const disable = async () => { setBusy(true); setErr(""); try { await api.mfaDisable(pw, code.trim()); setEnabled(false); reset(); } catch (e) { setErr(e.message || t("Αποτυχία", "Failed")); } finally { setBusy(false); } };
  const box = { width: "100%", padding: "9px 11px", border: "1px solid " + P.bd, borderRadius: 8, fontSize: 14, outline: "none", boxSizing: "border-box", background: P.ip };
  const primary = { background: P.em, color: "#fff", border: "none", padding: "9px 16px", borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: "pointer" };
  return (
    <div onMouseDown={() => setOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.42)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2100, padding: 16 }}>
      <div onMouseDown={e => e.stopPropagation()} style={{ background: P.wh, borderRadius: 14, width: "100%", maxWidth: 440, maxHeight: "88vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,.3)" }}>
        <div style={{ padding: "16px 20px", borderBottom: "1px solid " + P.bd, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: P.em }}>🔐 {t("Έλεγχος δύο παραγόντων (MFA)", "Two-factor authentication (MFA)")}</div>
          <button onClick={() => setOpen(false)} style={{ background: P.of, border: "1px solid " + P.bd, borderRadius: 8, padding: "5px 11px", cursor: "pointer" }}>✕</button>
        </div>
        <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
          {enabled == null && <div style={{ color: P.tm, textAlign: "center" }}>{t("Φόρτωση…", "Loading…")}</div>}

          {backup && (
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: P.gn, marginBottom: 6 }}>✓ {t("Το MFA ενεργοποιήθηκε", "MFA enabled")}</div>
              <div style={{ fontSize: 12, color: P.tm, marginBottom: 8 }}>{t("Φύλαξε αυτούς τους backup κωδικούς σε ασφαλές μέρος — κάθε ένας χρησιμοποιείται μία φορά αν χάσεις το τηλέφωνό σου.", "Save these backup codes somewhere safe — each works once if you lose your phone.")}</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontFamily: "monospace", fontSize: 13, background: P.of, border: "1px solid " + P.bd, borderRadius: 8, padding: 12 }}>
                {backup.map((c, i) => <div key={i}>{c}</div>)}
              </div>
              <button onClick={() => setOpen(false)} style={{ ...primary, marginTop: 14, width: "100%" }}>{t("Τέλος", "Done")}</button>
            </div>
          )}

          {!backup && enabled === false && !setup && (
            <>
              <div style={{ fontSize: 13, color: P.tx }}>{t("Πρόσθεσε ένα δεύτερο επίπεδο ασφαλείας με μια εφαρμογή authenticator (Google Authenticator, Microsoft Authenticator, κ.λπ.).", "Add a second layer of security with an authenticator app (Google Authenticator, Microsoft Authenticator, etc.).")}</div>
              {err && <div style={{ color: P.rd, fontSize: 12 }}>{err}</div>}
              <button onClick={startSetup} disabled={busy} style={{ ...primary, opacity: busy ? .6 : 1 }}>{busy ? "…" : t("Ενεργοποίηση MFA", "Enable MFA")}</button>
            </>
          )}

          {!backup && setup && (
            <>
              <div style={{ fontSize: 12, color: P.tm }}>{t("1) Σκάναρε το QR με την εφαρμογή authenticator (ή βάλε το κλειδί χειροκίνητα):", "1) Scan the QR with your authenticator app (or enter the key manually):")}</div>
              {setup.qr && <div style={{ textAlign: "center" }}><img src={setup.qr} alt="QR" style={{ width: 190, height: 190, border: "1px solid " + P.bd, borderRadius: 10 }} /></div>}
              <div style={{ fontFamily: "monospace", fontSize: 12, background: P.of, border: "1px solid " + P.bd, borderRadius: 8, padding: "8px 10px", wordBreak: "break-all", textAlign: "center" }}>{setup.secret}</div>
              <div style={{ fontSize: 12, color: P.tm }}>{t("2) Βάλε τον 6ψήφιο κωδικό που εμφανίζεται:", "2) Enter the 6-digit code it shows:")}</div>
              <input value={code} onChange={e => { setCode(e.target.value); setErr(""); }} onKeyDown={e => e.key === "Enter" && confirm()} placeholder="123456" inputMode="numeric" autoFocus style={{ ...box, letterSpacing: 4, fontSize: 18, textAlign: "center" }} />
              {err && <div style={{ color: P.rd, fontSize: 12 }}>{err}</div>}
              <button onClick={confirm} disabled={busy} style={{ ...primary, opacity: busy ? .6 : 1 }}>{busy ? t("Έλεγχος…", "Verifying…") : t("Επιβεβαίωση & ενεργοποίηση", "Confirm & enable")}</button>
            </>
          )}

          {!backup && enabled === true && !setup && (
            <>
              <div style={{ fontSize: 13, color: P.gn, fontWeight: 600 }}>✓ {t("Το MFA είναι ενεργό στον λογαριασμό σου.", "MFA is active on your account.")}</div>
              <div style={{ fontSize: 12, color: P.tm }}>{t("Για απενεργοποίηση, επιβεβαίωσε με τον κωδικό σου και έναν τρέχοντα κωδικό MFA.", "To disable, confirm with your password and a current MFA code.")}</div>
              <input type="password" value={pw} onChange={e => { setPw(e.target.value); setErr(""); }} placeholder={t("Κωδικός πρόσβασης", "Password")} style={box} />
              <input value={code} onChange={e => { setCode(e.target.value); setErr(""); }} placeholder={t("Κωδικός MFA", "MFA code")} inputMode="numeric" style={box} />
              {err && <div style={{ color: P.rd, fontSize: 12 }}>{err}</div>}
              <button onClick={disable} disabled={busy} style={{ background: P.rd, color: "#fff", border: "none", padding: "9px 16px", borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: "pointer", opacity: busy ? .6 : 1 }}>{busy ? "…" : t("Απενεργοποίηση MFA", "Disable MFA")}</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Global search palette (⌘K / Ctrl-K) ──────────────────────────────────────
// Cross-client fuzzy search over clients, invoices, subcontractor bills and contracts for the active
// year. `data` is the year map { clientName: clientData }; `onNavigate` receives a "client:Name:tab"
// route (the same grammar the chat assistant uses) so a hit jumps straight to the right screen.
export function GlobalSearch({ data, onNavigate, canFinance, myClients }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) { e.preventDefault(); setOpen(o => !o); }
      else if (e.key === "Escape") setOpen(false);
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("mf-open-search", onOpen);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("mf-open-search", onOpen); };
  }, []);
  useEffect(() => { if (open) { setQ(""); setHi(0); setTimeout(() => inputRef.current?.focus(), 30); } }, [open]);

  // Flat index of everything searchable for the active year (built once per data change).
  // Restricted (non-finance) users only ever see/navigate their own portfolio — never the full roster.
  const index = useMemo(() => {
    const allowed = (!canFinance && Array.isArray(myClients)) ? new Set(myClients) : null;
    const out = [];
    Object.entries(data || {}).forEach(([client, cd]) => {
      if (allowed && !allowed.has(client)) return;
      out.push({ type: "client", client, tab: "contracts", label: client, hint: t("Πελάτης", "Client"), text: client.toLowerCase() });
      (cd?.inv || []).forEach(r => out.push({ type: "inv", client, tab: "inv", label: (r.inv_no || t("Τιμολόγιο", "Invoice")) + " · €" + fmt(r.amt), hint: client + " · " + (r.cat || "") + (r.comments ? " · " + r.comments : ""), text: [client, r.inv_no, r.cat, r.comments, r.amt, r.site].join(" ").toLowerCase() }));
      (cd?.sub || []).forEach(r => out.push({ type: "sub", client, tab: "sub", label: (r.supplier || t("Υπεργολάβος", "Subcontractor")) + " · €" + fmt(r.amt), hint: client + " · " + (r.inv_no || "") + (r.svc_desc ? " · " + r.svc_desc : ""), text: [client, r.supplier, r.inv_no, r.svc_desc, r.cat, r.amt].join(" ").toLowerCase() }));
      (cd?.contracts || []).forEach(r => out.push({ type: "contract", client, tab: "contracts", label: (r.name || r.type || t("Συμβόλαιο", "Contract")) + (r.po ? " · PO " + r.po : ""), hint: client + " · " + (r.type || "") + (r.scope ? " · " + r.scope : ""), text: [client, r.name, r.type, r.po, r.scope].join(" ").toLowerCase() }));
    });
    return out;
  }, [data, t, canFinance, myClients]);

  // Token-AND match; clients first, then by type. Cap the list so the palette stays snappy.
  const results = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return [];
    const toks = query.split(/\s+/);
    const rank = { client: 0, contract: 1, inv: 2, sub: 3 };
    return index.filter(it => toks.every(tk => it.text.includes(tk)))
      .sort((a, b) => (rank[a.type] - rank[b.type]) || a.label.localeCompare(b.label))
      .slice(0, 40);
  }, [q, index]);

  useEffect(() => { if (hi >= results.length) setHi(0); }, [results.length, hi]);
  if (!open) return null;

  const go = (it) => { if (!it) return; setOpen(false); onNavigate("client:" + it.client + ":" + it.tab); };
  const onInputKey = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setHi(h => Math.min(h + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi(h => Math.max(h - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); go(results[hi]); }
  };
  const icon = { client: "🏢", inv: "📤", sub: "📥", contract: "📄" };

  return (
    <div onMouseDown={() => setOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.35)", zIndex: 2000, display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "10vh" }}>
      <div onMouseDown={e => e.stopPropagation()} style={{ width: "92%", maxWidth: 620, background: P.wh, borderRadius: 14, boxShadow: "0 24px 70px rgba(0,0,0,.35)", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 18px", borderBottom: "1px solid " + P.bd }}>
          <span style={{ fontSize: 18, opacity: .5 }}>🔎</span>
          <input ref={inputRef} value={q} onChange={e => { setQ(e.target.value); setHi(0); }} onKeyDown={onInputKey}
            placeholder={t("Αναζήτηση πελατών, τιμολογίων, προμηθευτών, συμβολαίων…", "Search clients, invoices, suppliers, contracts…")}
            style={{ flex: 1, border: "none", outline: "none", fontSize: 15, color: P.tx, background: "transparent" }} />
          <span style={{ fontSize: 10, color: P.tm, border: "1px solid " + P.bd, borderRadius: 5, padding: "2px 6px" }}>ESC</span>
        </div>
        <div style={{ maxHeight: "56vh", overflowY: "auto" }}>
          {q.trim() && !results.length && <div style={{ padding: 26, textAlign: "center", color: P.tm, fontStyle: "italic", fontSize: 13 }}>{t("Κανένα αποτέλεσμα", "No results")}</div>}
          {results.map((it, i) => (
            <div key={i} onMouseEnter={() => setHi(i)} onClick={() => go(it)}
              style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 18px", cursor: "pointer", background: i === hi ? P.ep : P.wh, borderBottom: "1px solid " + P.al }}>
              <span style={{ fontSize: 16 }}>{icon[it.type]}</span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: P.tx, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.label}</div>
                <div style={{ fontSize: 11, color: P.tm, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.hint}</div>
              </div>
              <span style={{ fontSize: 10, color: P.tm, textTransform: "uppercase", letterSpacing: .5 }}>{it.type}</span>
            </div>
          ))}
        </div>
        <div style={{ padding: "8px 18px", borderTop: "1px solid " + P.bd, fontSize: 11, color: P.tm, display: "flex", gap: 16 }}>
          <span>↑↓ {t("πλοήγηση", "navigate")}</span><span>↵ {t("άνοιγμα", "open")}</span><span>⌘K / Ctrl-K</span>
          {!canFinance && <span style={{ marginLeft: "auto", opacity: .7 }}>{t("μόνο οι πελάτες σας", "your clients only")}</span>}
        </div>
      </div>
    </div>
  );
}

// Loading skeleton — pulsing placeholder KPI cards + table rows, shown while a screen's data loads.
export function Skeleton({ kpis = 4, rows = 6 }) {
  const bar = (w, h, key) => <div key={key} style={{ width: w, height: h, background: "#E6ECE9", borderRadius: 6, animation: "mfpulse 1.2s ease-in-out infinite" }} />;
  return (
    <div style={{ padding: "8px 0" }}>
      <style>{"@keyframes mfpulse{0%,100%{opacity:1}50%{opacity:.45}}"}</style>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill,minmax(160px,1fr))`, gap: 12, marginBottom: 16 }}>
        {Array.from({ length: kpis }).map((_, i) => (
          <div key={i} style={{ background: "#fff", border: "1px solid #E6ECE9", borderRadius: 10, padding: 14 }}>{bar("55%", 9, "a")}<div style={{ height: 8 }} />{bar("80%", 20, "b")}</div>
        ))}
      </div>
      <div style={{ background: "#fff", border: "1px solid #E6ECE9", borderRadius: 8, padding: 16, display: "flex", flexDirection: "column", gap: 11 }}>
        {Array.from({ length: rows }).map((_, i) => bar(`${92 - i * 5}%`, 12, i))}
      </div>
    </div>
  );
}

// EL/EN language switch. `dark` variant for the emerald headers, light for the login card.
export function LangToggle({ dark }) {
  const { lang, setLang } = useT();
  const on = dark ? "rgba(255,255,255,.9)" : P.em, onTx = dark ? P.em : "#fff";
  const off = dark ? "rgba(255,255,255,.15)" : "transparent", offTx = dark ? "#fff" : P.tm;
  const bd = dark ? "rgba(255,255,255,.3)" : P.bd;
  return (
    <div style={{ display: "inline-flex", border: "1px solid " + bd, borderRadius: 6, overflow: "hidden" }}>
      {[["el", "ΕΛ"], ["en", "EN"]].map(([v, l]) => (
        <button key={v} onClick={() => setLang(v)} title={v === "el" ? "Ελληνικά" : "English"}
          style={{ background: lang === v ? on : off, color: lang === v ? onTx : offTx, border: "none",
            padding: "4px 9px", fontSize: 11, fontWeight: 700, cursor: "pointer", lineHeight: 1.4 }}>{l}</button>
      ))}
    </div>
  );
}

// Official CBRE logo (2026 green) — never type "CBRE" in a font (brand rule); use the real letterforms.
export function CbreMark({ height = 20 }) {
  return (
    <svg viewBox="0 0 81 20.13" style={{ height, width: "auto", display: "block" }} aria-label="CBRE">
      <path fill={P.em} d="M33.57,15.41H26.89V12.05h6.86a1.66,1.66,0,0,1,1.49,1.64,1.73,1.73,0,0,1-1.67,1.72m-6.68-11h7A1.64,1.64,0,0,1,35.3,6a1.72,1.72,0,0,1-1.43,1.68h-7Zm9.94,5.37c2.56-.85,3-3,3-4.75,0-2.68-1.89-5-7.48-5H21.94V20.09h10.4C38,20.09,40,17.21,40,14.32a4.91,4.91,0,0,0-3.19-4.58M63.37,0V20.13H81V15.54H68.28V12H79.75V7.63H68.28V4.39H81V0ZM55.79,6.26a1.65,1.65,0,0,1-1.57,1.38H47.34V4.43h6.88a1.57,1.57,0,0,1,1.57,1.4ZM53.12,0H42.47v20.1h4.89V12h5.39a2.8,2.8,0,0,1,2.74,2.85v5.27h4.79V13.62a4.21,4.21,0,0,0-2.9-3.89,4.5,4.5,0,0,0,3-4.44C60.34.94,56.6,0,53.12,0M18.76,15.27c-.07,0-6.69.13-9-.09a5.16,5.16,0,0,1-5-5.31,5.14,5.14,0,0,1,4.82-5.2c1.39-.19,9-.1,9.09-.1h.16L18.9,0h-.16L10.11,0A12.73,12.73,0,0,0,5.93.84,10.25,10.25,0,0,0,2,4a10,10,0,0,0-2,6,12.15,12.15,0,0,0,.16,2A9.8,9.8,0,0,0,5.65,19a14.72,14.72,0,0,0,5.46,1.11l1.63,0h6.17V15.27Z"/>
    </svg>
  );
}

// Header pill button — light (default) or solid green. Consistent nav control across every screen.
export function HeaderBtn({ onClick, children, tone = "light", title, active }) {
  const solid = tone === "solid" || active;
  return (
    <button onClick={onClick} title={title} style={{ background: solid ? P.em : P.of, border: "1px solid " + (solid ? P.em : P.bd), color: solid ? "#fff" : P.tx, padding: "7px 13px", borderRadius: 10, cursor: "pointer", fontSize: 12, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>{children}</button>
  );
}

// Shared top bar — light surface, real CBRE logo, pill controls, avatar + logout. `right` holds the
// screen-specific nav pills (use HeaderBtn); `onBack`/`title` render the left context.
export function AppHeader({ user, onLogout, onBack, backLabel, title, sub, right }) {
  const { t } = useT();
  const initials = (user?.name || user?.user || "?").split(/\s+/).filter(Boolean).map(s => s[0]).slice(0, 2).join("").toUpperCase() || "?";
  return (
    <div style={{ background: P.wh, color: P.tx, padding: "11px clamp(12px,3vw,24px)", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10, boxShadow: P.sh, position: "relative", zIndex: 5 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 13, flexWrap: "wrap" }}>
        <CbreMark />
        <span style={{ fontFamily: "'Space Mono',ui-monospace,monospace", fontSize: 9.5, letterSpacing: ".14em", color: P.tm, textTransform: "uppercase", borderLeft: "1px solid " + P.bd, paddingLeft: 11 }}>{sub || "Hellas · Reporting"}</span>
        {onBack && <button onClick={onBack} style={{ background: P.of, border: "1px solid " + P.bd, color: P.tx, padding: "6px 12px", borderRadius: 9, cursor: "pointer", fontSize: 12, fontWeight: 500 }}>◀ {backLabel || t("Πελάτες", "Clients")}</button>}
        {title && <span style={{ fontSize: 14, fontWeight: 600, color: P.em }}>{title}</span>}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 13 }}>
        {right}
        <LangToggle />
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 32, height: 32, borderRadius: "50%", background: "linear-gradient(135deg,#0A5A40," + P.ac + ")", color: "#fff", display: "grid", placeItems: "center", fontSize: 12, fontWeight: 600, flex: "none" }}>{initials}</span>
          <span style={{ fontSize: 13, color: P.tx, fontWeight: 500 }}>{user?.name}</span>
        </span>
        <button onClick={() => window.dispatchEvent(new Event("mf-open-mfa"))} title={t("Ασφάλεια / MFA", "Security / MFA")} style={{ background: P.of, border: "1px solid " + P.bd, color: P.tx, padding: "6px 10px", borderRadius: 10, cursor: "pointer", fontSize: 13 }}>🔐</button>
        <button onClick={onLogout} style={{ background: P.of, border: "1px solid " + P.bd, color: P.tx, padding: "6px 12px", borderRadius: 10, cursor: "pointer", fontSize: 12 }}>{t("Αποσύνδεση", "Logout")}</button>
      </div>
    </div>
  );
}

// Real company logo (Clearbit → Google favicon → colored-initials avatar on error).
export function LogoImg({name,size,radius}) {
  const nm = name || "?";
  const [src,setSrc] = useState(logoUrl(nm));
  const [err,setErr] = useState(0);
  const fallback = () => { if(err===0){setSrc(logoUrl2(nm));setErr(1);} else setErr(2); };
  const sz = size||36; const rd = radius||8;
  const color = (() => {const colors=["#003F2D","#003F2D","#003F2D","#0277BD","#1565C0","#283593","#4527A0","#6A1B9A","#AD1457","#C62828","#D84315","#EF6C00","#F9A825","#2E7D32","#00838F","#37474F"];let h=0;for(let i=0;i<nm.length;i++)h=((h<<5)-h+nm.charCodeAt(i))|0;return colors[Math.abs(h)%colors.length];})();
  const ini = nm.split(/[\s-]+/).map(w=>w[0]).join("").slice(0,2).toUpperCase();
  if(err>=2||!src) return <div style={{width:sz,height:sz,borderRadius:rd,background:color,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontWeight:700,fontSize:sz*0.36,flexShrink:0}}>{ini}</div>;
  return <img src={src} alt="" style={{width:sz,height:sz,borderRadius:rd,objectFit:"contain",background:"#f5f5f5",padding:2,flexShrink:0}} onError={fallback} />;
}

// Password input with a show/hide (👁) toggle. Reused on login + change-password screens.
export function PwField({value,onChange,onEnter,style,autoFocus,onFocus,onBlur}) {
  const [show,setShow] = useState(false);
  return (
    <div style={{position:"relative"}}>
      <input type={show?"text":"password"} value={value} onChange={onChange} autoFocus={autoFocus}
        onFocus={onFocus} onBlur={onBlur}
        onKeyDown={onEnter?e=>{if(e.key==="Enter")onEnter();}:undefined}
        style={{...style, paddingRight:40}} />
      <button type="button" tabIndex={-1} onMouseDown={e=>e.preventDefault()} onClick={()=>setShow(s=>!s)}
        title={show?"Απόκρυψη κωδικού":"Εμφάνιση κωδικού"} aria-label={show?"Απόκρυψη κωδικού":"Εμφάνιση κωδικού"}
        style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",cursor:"pointer",fontSize:16,opacity:.55,padding:0,lineHeight:1}}>{show?"🙈":"👁"}</button>
    </div>
  );
}

// Minimal, XSS-safe markdown (bold + bullets + line breaks) — never injects model HTML.
export function MdText({text}) {
  const inline = (s)=> s.split(/(\*\*[^*]+\*\*)/g).map((p,j)=> /^\*\*[^*]+\*\*$/.test(p)?<strong key={j}>{p.slice(2,-2)}</strong>:<span key={j}>{p}</span>);
  return <>{String(text||"").split("\n").map((ln,i)=>{
    if(!ln.trim()) return <div key={i} style={{height:6}} />;
    if(/^\s*[-•]\s+/.test(ln)) return <div key={i} style={{display:"flex",gap:6,paddingLeft:2}}><span style={{color:P.em}}>•</span><span>{inline(ln.replace(/^\s*[-•]\s+/,""))}</span></div>;
    return <div key={i}>{inline(ln)}</div>;
  })}</>;
}

// Any stored date string (dd/mm/yyyy or yyyy-mm-dd) → yyyy-mm-dd for a native date input; else "".
export const toISODate = (s) => {
  if (!s) return "";
  const str = String(s).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/.exec(str);
  if (m) { const y = m[3].length === 2 ? "20" + m[3] : m[3]; return `${y}-${String(m[2]).padStart(2,"0")}-${String(m[1]).padStart(2,"0")}`; }
  return "";
};

// Labelled text/number/date input (number uses text input to avoid spinner arrows; date is native).
export function Inp({l,v,set,w,t="text"}) {
  const isNum = t === "number";
  if (t === "date") return (
    <div style={{display:"flex",flexDirection:"column",gap:3,width:w}}>
      <label style={{fontSize:10,color:P.tm,fontWeight:600}}>{l}</label>
      <input type="date" value={toISODate(v)} onChange={e=>set(e.target.value)}
        style={{padding:"4px 6px",border:"1px solid "+P.bd,borderRadius:4,fontSize:12,background:P.ip,outline:"none"}} />
    </div>
  );
  return (
    <div style={{display:"flex",flexDirection:"column",gap:3,width:w}}>
      <label style={{fontSize:10,color:P.tm,fontWeight:600}}>{l}</label>
      <input
        type="text"
        inputMode={isNum?"decimal":"text"}
        value={v}
        onChange={e=>set(e.target.value)}
        onBlur={isNum?e=>{const n=parseFloat(String(e.target.value).replace(",","."));if(!isNaN(n))set(n);}:undefined}
        style={{padding:"5px 7px",border:"1px solid "+P.bd,borderRadius:4,fontSize:12,background:P.ip,outline:"none",textAlign:isNum?"right":"left"}}
      />
    </div>
  );
}

// Labelled select.
export function Sel({l,v,set,opts,w}) {
  return (
    <div style={{display:"flex",flexDirection:"column",gap:3,width:w}}>
      <label style={{fontSize:10,color:P.tm,fontWeight:600}}>{l}</label>
      <select value={v} onChange={e=>set(e.target.value)} style={{padding:"5px 7px",border:"1px solid "+P.bd,borderRadius:4,fontSize:12,background:P.ip,outline:"none"}}>{opts.map(o=><option key={o.v} value={o.v}>{o.l}</option>)}</select>
    </div>
  );
}

// Editable data grid with Excel-like cell selection (Sum/Avg/Min/Max on numeric selections).
export function Tbl({cols,data,del,onEdit,locked,onRestore}) {
  const { t } = useT();
  const [fl,sF] = useState("");
  const [sel,setSel] = useState(new Set());
  const [anchor,setAnchor] = useState(null);
  const [dragging,setDragging] = useState(false);
  const [rowSel,setRowSel] = useState(new Set());   // ids selected via the row checkboxes (for bulk ops)
  const [undo,setUndo] = useState(null);            // {rows} of the last bulk delete, for restore
  const undoTimer = useRef(null);
  useEffect(() => () => clearTimeout(undoTimer.current), []);   // clear the pending undo timer on unmount
  const rows = data.filter(r => !fl || cols.some(c => String(r[c.k]||"").toLowerCase().includes(fl.toLowerCase())));
  const canBulk = !!onRestore;
  const selectableRows = rows.filter(r => !(locked&&locked(r)));
  const toggleRow = id => setRowSel(s => { const n=new Set(s); n.has(id)?n.delete(id):n.add(id); return n; });
  const allSelected = selectableRows.length>0 && selectableRows.every(r=>rowSel.has(r.id));
  const toggleAll = () => setRowSel(allSelected ? new Set() : new Set(selectableRows.map(r=>r.id)));
  const bulkDelete = () => {
    const ids = [...rowSel].filter(id => selectableRows.some(r=>r.id===id));
    if(!ids.length) return;
    // Snapshot the rows before deletion so they can be restored. Attachments (docId) are purged by del()
    // and cannot be un-deleted, so strip docId from the restore snapshot to avoid a dangling reference.
    const snapshot = ids.map(id => data.find(r=>r.id===id)).filter(Boolean).map(r=>{ const c={...r}; delete c.docId; return c; });
    ids.forEach(id => del(id));
    setRowSel(new Set());
    setUndo({rows:snapshot});
    if(undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(()=>setUndo(null), 8000);
  };
  const doUndo = () => { if(undo&&onRestore) onRestore(undo.rows); setUndo(null); if(undoTimer.current) clearTimeout(undoTimer.current); };
  const cs = {padding:"5px 6px",border:"1px solid "+P.bd,borderRadius:3,fontSize:11,background:P.ip,outline:"none",width:"100%",boxSizing:"border-box"};
  const up = (id,k,v) => { if(onEdit) onEdit(id,k,v); };
  const ck = (ri,ci) => ri+":"+ci;
  const gv = (ri,ci) => { const r=rows[ri]; const c=cols[ci]; return r&&c?r[c.k]:null; };
  const md = (ri,ci,e) => { if(e.shiftKey&&anchor){const[ar,ac]=anchor;const s=new Set();for(let r=Math.min(ar,ri);r<=Math.max(ar,ri);r++) for(let c=Math.min(ac,ci);c<=Math.max(ac,ci);c++) s.add(ck(r,c));setSel(s);}else{setAnchor([ri,ci]);setSel(new Set([ck(ri,ci)]));setDragging(true);}};
  const me = (ri,ci) => { if(!dragging||!anchor)return;const[ar,ac]=anchor;const s=new Set();for(let r=Math.min(ar,ri);r<=Math.max(ar,ri);r++) for(let c=Math.min(ac,ci);c<=Math.max(ac,ci);c++) s.add(ck(r,c));setSel(s);};
  const mu = () => setDragging(false);
  const vals=[];sel.forEach(k=>{const[ri,ci]=k.split(":").map(Number);const v=gv(ri,ci);if(typeof v==="number"&&!isNaN(v))vals.push(v);});
  const sum=vals.reduce((s,v)=>s+v,0);const avg=vals.length?sum/vals.length:0;
  return (
    <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,boxShadow:P.sh,overflow:"hidden"}} onMouseUp={mu} onMouseLeave={mu}>
      <div style={{padding:"8px 12px",borderBottom:"1px solid "+P.bd,display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
        <input placeholder="Filter..." value={fl} onChange={e=>sF(e.target.value)} style={{padding:"5px 8px",border:"1px solid "+P.bd,borderRadius:4,fontSize:12,outline:"none",width:180}} />
        <span style={{fontSize:11,color:P.tm}}>{rows.length} rows</span>
        {sel.size>1&&<button onClick={()=>setSel(new Set())} style={{background:"none",border:"none",color:P.tm,cursor:"pointer",fontSize:11,textDecoration:"underline"}}>Clear</button>}
        {canBulk&&rowSel.size>0&&(
          <span style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:10}}>
            <span style={{fontSize:12,fontWeight:600,color:P.em}}>{rowSel.size} {t("επιλεγμένες","selected")}</span>
            <button onClick={bulkDelete} style={{background:P.rd,color:"#fff",border:"none",padding:"5px 12px",borderRadius:5,fontSize:12,fontWeight:600,cursor:"pointer"}}>🗑 {t("Διαγραφή","Delete")}</button>
            <button onClick={()=>setRowSel(new Set())} style={{background:"none",border:"1px solid "+P.bd,padding:"5px 10px",borderRadius:5,fontSize:12,cursor:"pointer",color:P.tx}}>{t("Άκυρο","Cancel")}</button>
          </span>
        )}
      </div>
      <div style={{overflowX:"auto",userSelect:"none"}}>
        <table style={{width:"100%",borderCollapse:"collapse"}}>
          <thead><tr>{canBulk&&<th style={{padding:"7px 6px",background:P.em,width:30,position:"sticky",top:0,zIndex:2,textAlign:"center"}}><input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={!selectableRows.length} title={t("Επιλογή όλων","Select all")} style={{cursor:"pointer"}} /></th>}{cols.map(c=><th key={c.k} style={{padding:"7px 10px",fontSize:11,fontWeight:700,color:"#fff",background:P.em,textAlign:c.a||"left",whiteSpace:"nowrap",position:"sticky",top:0,zIndex:2}}>{c.l}</th>)}<th style={{padding:7,fontSize:11,color:"#fff",background:P.em,width:30,position:"sticky",top:0,zIndex:2}}></th></tr></thead>
          <tbody>{rows.map((r,ri)=>{const rl=locked?locked(r):false;const rsel=canBulk&&rowSel.has(r.id);return <tr key={r.id||ri}>{canBulk&&<td style={{padding:"4px 6px",textAlign:"center",border:"1px solid "+P.bd,background:rsel?"#E3F2FD":rl?"#F2F4F3":ri%2===0?P.wh:P.al}}>{rl?null:<input type="checkbox" checked={rsel} onChange={()=>toggleRow(r.id)} style={{cursor:"pointer"}} />}</td>}{cols.map((c,ci)=>{const v=r[c.k];const isSel=sel.has(ck(ri,ci));const bg=isSel?"#E3F2FD":rl?"#F2F4F3":ri%2===0?P.wh:P.al;const bd=isSel?"2px solid #1565C0":"1px solid "+P.bd;const td={padding:"4px 6px",fontSize:12,border:bd,background:bg,textAlign:c.a||"left",minWidth:c.mw||undefined,cursor:"cell"};const h={onMouseDown:e=>md(ri,ci,e),onMouseEnter:()=>me(ri,ci)};
            // Locked (closed-period) rows are read-only: render the display value, never the editors.
            if(c.opts&&onEdit&&!rl) return <td key={c.k} style={td} {...h}><select value={v||""} onChange={e=>up(r.id,c.k,e.target.value)} style={{...cs,textAlign:"left"}}>{c.opts.map(o=><option key={o.v} value={o.v}>{o.l}</option>)}</select></td>;
            if(c.t==="date"&&c.edit&&onEdit&&!rl) return <td key={c.k} style={td} {...h}><input type="date" value={toISODate(v)} onChange={e=>up(r.id,c.k,e.target.value)} style={{...cs,textAlign:"left"}} /></td>;
            if(c.edit&&onEdit&&!rl) return <td key={c.k} style={td} {...h}><input type="text" inputMode={c.t==="number"?"decimal":"text"} value={v??""} onChange={e=>up(r.id,c.k,c.t==="number"?e.target.value:e.target.value)} onBlur={c.t==="number"?e=>{const n=parseFloat(String(e.target.value).replace(",","."));up(r.id,c.k,isNaN(n)?0:n);}:undefined} style={{...cs,textAlign:c.a||"left"}} /></td>;
            const disp = c.opts?((c.opts.find(o=>o.v===v)||{}).l??String(v??"")):c.r?c.r(v,r):String(v??"");
            return <td key={c.k} style={{...td,padding:"5px 10px"}} {...h}>{disp}</td>;
          })}<td style={{padding:4,textAlign:"center",border:"1px solid "+P.bd,background:rl?"#F2F4F3":ri%2===0?P.wh:P.al}}>{rl?<span title={t("Κλειδωμένος μήνας","Locked month")} style={{fontSize:13,opacity:.6}}>🔒</span>:<button onClick={()=>del(r.id)} style={{background:"none",border:"none",color:P.rd,cursor:"pointer",fontSize:15}}>×</button>}</td></tr>;})}</tbody>
        </table>
      </div>
      <div style={{background:"#263238",color:"#fff",padding:"6px 16px",display:"flex",gap:20,fontSize:12,fontFamily:"'Consolas','Courier New',monospace",minHeight:28,alignItems:"center"}}>
        {vals.length>0?(<>
          <span style={{color:"#80CBC4"}}>Cells: <b>{sel.size}</b></span>
          <span style={{color:"#B2DFDB"}}>Count: <b>{vals.length}</b></span>
          <span style={{color:"#A5D6A7"}}>Sum: <b>{fmt(sum)}</b></span>
          <span style={{color:"#C5E1A5"}}>Avg: <b>{fmt(avg)}</b></span>
          <span style={{color:"#FFCC80"}}>Min: <b>{fmt(Math.min(...vals))}</b></span>
          <span style={{color:"#EF9A9A"}}>Max: <b>{fmt(Math.max(...vals))}</b></span>
        </>):(<span style={{color:"#78909C"}}>Click or drag cells to select — Shift+click for range — numeric cells show Sum / Avg / Min / Max</span>)}
      </div>
      {undo && (
        <div style={{position:"fixed",bottom:22,left:"50%",transform:"translateX(-50%)",background:"#263238",color:"#fff",padding:"10px 16px",borderRadius:10,display:"flex",alignItems:"center",gap:16,boxShadow:"0 8px 30px rgba(0,0,0,.3)",zIndex:60,fontSize:13}}>
          <span>🗑 {undo.rows.length} {t("γραμμές διαγράφηκαν","rows deleted")}</span>
          <button onClick={doUndo} style={{background:"none",border:"1px solid rgba(255,255,255,.5)",color:"#fff",padding:"5px 14px",borderRadius:6,fontSize:12,fontWeight:600,cursor:"pointer"}}>↩ {t("Αναίρεση","Undo")}</button>
        </div>
      )}
    </div>
  );
}

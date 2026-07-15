// Authentication screens, extracted from App.jsx.
//   Login          — username + access-code sign-in, with inline forgot-password flow.
//   ForcePw        — mandatory change when the account still uses a seeded/default password.
//   ResetPassword  — reached from the emailed reset link (/reset?token=…).
import { useState } from "react";
import { api, setToken } from "./api.js";
import { P } from "./constants.js";
import { PwField } from "./ui.jsx";

// Reached from the emailed reset link (/reset?token=...). Sets a new password, then → login.
export function ResetPassword({token}) {
  const [p1,setP1] = useState("");
  const [p2,setP2] = useState("");
  const [err,setErr] = useState("");
  const [busy,setBusy] = useState(false);
  const [done,setDone] = useState(false);
  const go = async () => {
    if(!p1||!p2){ setErr("Συμπλήρωσε και τα δύο πεδία"); return; }
    if(p1!==p2){ setErr("Οι κωδικοί δεν ταιριάζουν"); return; }
    if(p1.length<8){ setErr("Ο κωδικός πρέπει να έχει 8+ χαρακτήρες"); return; }
    setBusy(true); setErr("");
    try { await api.resetPassword(token, p1); setDone(true); }
    catch(e){ setErr(e.message||"Αποτυχία επαναφοράς"); }
    finally{ setBusy(false); }
  };
  const inp = {width:"100%",padding:"11px 14px",border:"1px solid "+P.bd,borderRadius:6,fontSize:14,outline:"none",background:"#fff",boxSizing:"border-box"};
  return (
    <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"#F7F9F8",fontFamily:"Segoe UI,Tahoma,sans-serif"}}>
      <div style={{width:380,background:"#fff",border:"1px solid "+P.bd,borderRadius:10,padding:"34px 34px 28px"}}>
        <div style={{fontWeight:800,fontSize:22,color:P.em,letterSpacing:1,marginBottom:6}}>CBRE</div>
        {done ? (
          <>
            <div style={{fontSize:18,fontWeight:700,color:P.gn,marginTop:8}}>✓ Ο κωδικός άλλαξε</div>
            <div style={{fontSize:13,color:P.tm,margin:"8px 0 22px",lineHeight:1.5}}>Μπορείς τώρα να συνδεθείς με τον νέο σου κωδικό.</div>
            <button onClick={()=>{window.location.href="/";}} style={{width:"100%",background:P.em,color:"#fff",border:"none",padding:"12px",borderRadius:6,fontSize:14,fontWeight:600,cursor:"pointer"}}>Σύνδεση</button>
          </>
        ) : (
          <>
            <div style={{fontSize:20,fontWeight:700,color:P.em,marginTop:8}}>🔑 Ορισμός νέου κωδικού</div>
            <div style={{fontSize:12.5,color:P.tm,margin:"8px 0 22px",lineHeight:1.5}}>Όρισε τον νέο σου κωδικό πρόσβασης.</div>
            <div style={{display:"flex",flexDirection:"column",gap:14}}>
              <div><label style={{fontSize:11,fontWeight:600,color:P.tm,display:"block",marginBottom:4}}>Νέος κωδικός (8+ χαρακτήρες)</label>
                <PwField value={p1} onChange={e=>{setP1(e.target.value);setErr("");}} style={inp} autoFocus /></div>
              <div><label style={{fontSize:11,fontWeight:600,color:P.tm,display:"block",marginBottom:4}}>Επιβεβαίωση</label>
                <PwField value={p2} onChange={e=>{setP2(e.target.value);setErr("");}} onEnter={go} style={inp} /></div>
              {err && <div style={{color:P.rd,fontSize:12}}>{err}</div>}
              <button onClick={go} disabled={busy} style={{width:"100%",background:P.em,color:"#fff",border:"none",padding:"12px",borderRadius:6,fontSize:14,fontWeight:600,cursor:busy?"wait":"pointer",opacity:busy?0.6:1}}>{busy?"Αποθήκευση…":"Ορισμός & σύνδεση"}</button>
              <button onClick={()=>{window.location.href="/";}} style={{background:"none",border:"none",color:P.tm,fontSize:12,cursor:"pointer",textDecoration:"underline"}}>Πίσω στη σύνδεση</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Mandatory password change screen — shown when the account still uses a seeded/default password.
export function ForcePw({onDone,onLogout}) {
  const [cur,setCur] = useState("");
  const [n1,setN1] = useState("");
  const [n2,setN2] = useState("");
  const [err,setErr] = useState("");
  const [busy,setBusy] = useState(false);
  const go = async () => {
    if(!cur||!n1||!n2) { setErr("Συμπλήρωσε όλα τα πεδία"); return; }
    if(n1!==n2) { setErr("Οι νέοι κωδικοί δεν ταιριάζουν"); return; }
    if(n1.length<8) { setErr("Ο νέος κωδικός πρέπει να έχει 8+ χαρακτήρες"); return; }
    if(n1===cur) { setErr("Ο νέος κωδικός πρέπει να διαφέρει από τον τρέχοντα"); return; }
    setBusy(true); setErr("");
    try {
      const r = await api.changePassword(cur, n1);
      if(r && r.token) setToken(r.token); // server rotated the session — keep this one alive
      onDone();
    } catch(e) { setErr(e.message||"Αποτυχία αλλαγής κωδικού"); }
    finally { setBusy(false); }
  };
  const inp = {width:"100%",padding:"11px 14px",border:"1px solid "+P.bd,borderRadius:6,fontSize:14,outline:"none",background:"#fff",boxSizing:"border-box"};
  return (
    <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"#F7F9F8",fontFamily:"Segoe UI,Tahoma,sans-serif"}}>
      <div style={{width:380,background:"#fff",border:"1px solid "+P.bd,borderRadius:10,padding:"34px 34px 28px"}}>
        <div style={{fontSize:20,fontWeight:700,color:P.em}}>🔒 Απαιτείται αλλαγή κωδικού</div>
        <div style={{fontSize:12.5,color:P.tm,margin:"8px 0 22px",lineHeight:1.5}}>Ο λογαριασμός σου χρησιμοποιεί ακόμη τον προεπιλεγμένο κωδικό. Όρισε δικό σου για να συνεχίσεις.</div>
        <div style={{display:"flex",flexDirection:"column",gap:14}}>
          <div><label style={{fontSize:11,fontWeight:600,color:P.tm,display:"block",marginBottom:4}}>Τρέχων κωδικός</label>
            <PwField value={cur} onChange={e=>{setCur(e.target.value);setErr("");}} style={inp} /></div>
          <div><label style={{fontSize:11,fontWeight:600,color:P.tm,display:"block",marginBottom:4}}>Νέος κωδικός (8+ χαρακτήρες)</label>
            <PwField value={n1} onChange={e=>{setN1(e.target.value);setErr("");}} style={inp} /></div>
          <div><label style={{fontSize:11,fontWeight:600,color:P.tm,display:"block",marginBottom:4}}>Επιβεβαίωση νέου κωδικού</label>
            <PwField value={n2} onChange={e=>{setN2(e.target.value);setErr("");}} onEnter={go} style={inp} /></div>
          {err && <div style={{color:P.rd,fontSize:12}}>{err}</div>}
          <button onClick={go} disabled={busy} style={{width:"100%",background:P.em,color:"#fff",border:"none",padding:"12px",borderRadius:6,fontSize:14,fontWeight:600,cursor:busy?"wait":"pointer",opacity:busy?0.6:1}}>
            {busy?"Αποθήκευση...":"Αλλαγή κωδικού & είσοδος"}
          </button>
          <button onClick={onLogout} style={{background:"none",border:"none",color:P.tm,fontSize:12,cursor:"pointer",textDecoration:"underline"}}>Αποσύνδεση</button>
        </div>
      </div>
    </div>
  );
}

export function Login({onLogin}) {
  const [u,setU] = useState("");
  const [c,setC] = useState("");
  const [err,setErr] = useState("");
  const [busy,setBusy] = useState(false);
  const [forgot,setForgot] = useState(false);
  const [fUser,setFUser] = useState("");
  const [fMsg,setFMsg] = useState("");
  const [fBusy,setFBusy] = useState(false);
  const sendForgot = async () => {
    if(!fUser.trim()) { setFMsg("Βάλε username ή email"); return; }
    setFBusy(true); setFMsg("");
    try {
      const r = await api.forgotPassword(fUser.trim());
      setFMsg(r.message || "Αν υπάρχει λογαριασμός με καταχωρημένο email, στάλθηκε σύνδεσμος επαναφοράς.");
    } catch(e) {
      setFMsg(e.status===503
        ? "Η επαναφορά μέσω email δεν είναι ενεργή ακόμη — ζήτα από τον διαχειριστή reset (⚙️ Admin → Χρήστες)."
        : (e.message||"Κάτι πήγε στραβά"));
    } finally { setFBusy(false); }
  };
  const go = async () => {
    if(!u || !c) { setErr("Enter username and password"); return; }
    setBusy(true); setErr("");
    try {
      const r = await api.login(u.trim().toLowerCase(), c);
      if(r.token) setToken(r.token);
      onLogin({user: r.user.username, name: r.user.name, role: r.user.role, clients: r.user.clients, mustChange: !!r.user.must_change_password});
    } catch(e) {
      setErr(e.message || "Invalid credentials");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{minHeight:"100vh",display:"flex",fontFamily:"Segoe UI,Tahoma,sans-serif"}}>
      {/* Left panel */}
      <div style={{flex:"0 0 45%",background:"#003F2D",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"60px 50px",color:"#fff",position:"relative"}}>
        <svg width="220" height="62" viewBox="0 0 220 62" xmlns="http://www.w3.org/2000/svg">
          <text fill="#fff" fontFamily="'Helvetica Neue',Helvetica,Arial,sans-serif" fontSize="62" fontWeight="700" letterSpacing="1" x="110" y="50" textAnchor="middle">CBRE</text>
        </svg>
        <div style={{fontSize:14,fontWeight:300,opacity:.6,marginTop:20}}>Client Monthly Reporting Platform</div>
        <div style={{position:"absolute",bottom:20,fontSize:10,opacity:.25}}>© {new Date().getFullYear()} CBRE Group, Inc.</div>
      </div>
      {/* Right panel */}
      <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",background:"#F7F9F8"}}>
        <div style={{width:340}}>
          <div style={{marginBottom:32}}>
            <div style={{fontSize:22,fontWeight:700,color:P.em}}>Welcome back</div>
            <div style={{fontSize:13,color:P.tm,marginTop:4}}>Sign in to access client reports</div>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:16}}>
            <div>
              <label style={{fontSize:11,fontWeight:600,color:P.tm,display:"block",marginBottom:4}}>Username</label>
              <input value={u} onChange={e=>{setU(e.target.value);setErr("");}} onKeyDown={e=>e.key==="Enter"&&go()}
                style={{width:"100%",padding:"11px 14px",border:"1px solid "+P.bd,borderRadius:6,fontSize:14,outline:"none",background:"#fff",boxSizing:"border-box"}} />
            </div>
            <div>
              <label style={{fontSize:11,fontWeight:600,color:P.tm,display:"block",marginBottom:4}}>Access Code</label>
              <PwField value={c} onChange={e=>{setC(e.target.value);setErr("");}} onEnter={go}
                style={{width:"100%",padding:"11px 14px",border:"1px solid "+P.bd,borderRadius:6,fontSize:14,outline:"none",background:"#fff",boxSizing:"border-box"}} />
            </div>
            {err && <div style={{color:P.rd,fontSize:12,padding:"4px 0"}}>{err}</div>}
            <button onClick={go} disabled={busy}
              style={{width:"100%",background:P.em,color:"#fff",border:"none",padding:"12px",borderRadius:6,fontSize:14,fontWeight:600,cursor:busy?"wait":"pointer",marginTop:4,opacity:busy?0.6:1}}>
              {busy?"Signing in...":"Sign In"}
            </button>
            <button type="button" onClick={()=>{setForgot(f=>!f);setFMsg("");}} style={{background:"none",border:"none",color:P.tm,fontSize:12,cursor:"pointer",textDecoration:"underline",alignSelf:"center",padding:0}}>Ξέχασα τον κωδικό;</button>
            {forgot && (
              <div style={{background:P.of,border:"1px solid "+P.bd,borderRadius:6,padding:"12px",display:"flex",flexDirection:"column",gap:8}}>
                <div style={{fontSize:12,color:P.tm}}>Βάλε το username ή το email σου — θα λάβεις σύνδεσμο επαναφοράς στο email σου.</div>
                <input value={fUser} onChange={e=>{setFUser(e.target.value);setFMsg("");}} onKeyDown={e=>e.key==="Enter"&&sendForgot()} placeholder="username ή email"
                  style={{padding:"9px 12px",border:"1px solid "+P.bd,borderRadius:6,fontSize:13,outline:"none",background:"#fff",boxSizing:"border-box"}} />
                <button type="button" onClick={sendForgot} disabled={fBusy} style={{background:P.em,color:"#fff",border:"none",padding:"9px",borderRadius:6,fontSize:13,fontWeight:600,cursor:fBusy?"wait":"pointer",opacity:fBusy?.6:1}}>{fBusy?"Αποστολή…":"Στείλε σύνδεσμο επαναφοράς"}</button>
                {fMsg && <div style={{color:P.em,fontSize:12}}>{fMsg}</div>}
                <div style={{color:P.tm,fontSize:11}}>Εναλλακτικά, ζήτα από τον διαχειριστή reset (⚙️ Admin → Χρήστες).</div>
              </div>
            )}
          </div>
          <div style={{marginTop:24,fontSize:11,color:P.tm,textAlign:"center"}}>
            Authorised CBRE Hellas employees only
          </div>
        </div>
      </div>
    </div>
  );
}

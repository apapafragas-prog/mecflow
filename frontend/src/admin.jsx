// Admin-only console: user management + audit log, extracted from App.jsx.
import { useState, useEffect } from "react";
import { api } from "./api.js";
import { P } from "./constants.js";
import { Inp, Sel } from "./ui.jsx";
import { useT } from "./i18n.jsx";

export function AdminPanel({me,onClose}) {
  const { t, lang } = useT();
  const [tab,setTab] = useState("users");
  const [users,setUsers] = useState([]);
  const [logs,setLogs] = useState([]);
  const [err,setErr] = useState("");
  const [busy,setBusy] = useState(false);
  const [nf,setNf] = useState({username:"",name:"",email:"",role:"ops",password:"",clients:""});

  const loadUsers = () => api.listUsers().then(setUsers).catch(e=>setErr(e.message||t("Η φόρτωση απέτυχε","Load failed")));
  const loadLogs = () => api.audit().then(setLogs).catch(e=>setErr(e.message||t("Η φόρτωση απέτυχε","Load failed")));
  useEffect(()=>{ loadUsers(); loadLogs(); },[]);

  const create = async () => {
    setErr("");
    if(!nf.username||!nf.name||!nf.password){ setErr(t("Συμπλήρωσε username, όνομα και κωδικό","Fill in username, name and password")); return; }
    if(nf.password.length<8){ setErr(t("Ο κωδικός πρέπει να έχει 8+ χαρακτήρες","The password must be 8+ characters")); return; }
    const clients = nf.role==="ops"
      ? nf.clients.split(",").map(s=>s.trim()).filter(Boolean)
      : "ALL";
    setBusy(true);
    try {
      await api.createUser({username:nf.username.trim().toLowerCase(),name:nf.name.trim(),email:nf.email.trim(),role:nf.role,password:nf.password,clients});
      setNf({username:"",name:"",email:"",role:"ops",password:"",clients:""});
      await loadUsers(); await loadLogs();
    } catch(e){ setErr(e.message||t("Η δημιουργία απέτυχε","Create failed")); }
    finally{ setBusy(false); }
  };
  const del = async (u) => {
    if(u.username===me.username){ setErr(t("Δεν μπορείς να διαγράψεις τον εαυτό σου","You can't delete yourself")); return; }
    if(!confirm(t(`Διαγραφή χρήστη "${u.username}";`,`Delete user "${u.username}"?`))) return;
    setBusy(true);
    try { await api.deleteUser(u.id); await loadUsers(); await loadLogs(); }
    catch(e){ setErr(e.message||t("Η διαγραφή απέτυχε","Delete failed")); }
    finally{ setBusy(false); }
  };
  const resetPw = async (u) => {
    setErr("");
    const p = prompt(t(`Νέος προσωρινός κωδικός για "${u.username}" (8+ χαρακτήρες).\nΆφησέ το ΚΕΝΟ για αυτόματο.`,`New temporary password for "${u.username}" (8+ chars).\nLeave BLANK for auto-generated.`), "");
    if(p===null) return;
    if(p && p.length<8){ setErr(t("Ο κωδικός πρέπει να έχει 8+ χαρακτήρες","The password must be 8+ characters")); return; }
    setBusy(true);
    try {
      const r = await api.resetUserPassword(u.id, p||undefined);
      await loadLogs();
      alert(t(`✓ Ο κωδικός του "${r.username}" έγινε reset.\n\nΠροσωρινός κωδικός:\n\n    ${r.tempPassword}\n\nΔώσ' τον στον χρήστη — θα του ζητηθεί να τον αλλάξει στην πρώτη είσοδο. Οι υπάρχουσες συνεδρίες του ακυρώθηκαν.`,`✓ Password for "${r.username}" was reset.\n\nTemporary password:\n\n    ${r.tempPassword}\n\nGive it to the user — they'll be asked to change it on first login. Their existing sessions were revoked.`));
    } catch(e){ setErr(e.message||t("Το reset κωδικού απέτυχε","Password reset failed")); }
    finally{ setBusy(false); }
  };
  // Inline edit of an existing user (name / email / role / client access).
  const [editId,setEditId] = useState(null);
  const [ef,setEf] = useState({name:"",email:"",role:"ops",clients:""});
  const startEdit = (u) => { setErr(""); setEditId(u.id); setEf({name:u.name||"",email:u.email||"",role:u.role||"ops",clients:u.clients==="ALL"?"":(Array.isArray(u.clients)?u.clients.join(", "):"")}); };
  const cancelEdit = () => setEditId(null);
  const saveEdit = async (u) => {
    setErr("");
    if(!ef.name.trim()){ setErr(t("Το όνομα δεν μπορεί να είναι κενό","Name cannot be empty")); return; }
    const clients = ef.role==="ops" ? ef.clients.split(",").map(s=>s.trim()).filter(Boolean) : "ALL";
    const self = u.username===me.username;
    if(self && ef.role!==u.role){ setErr(t("Δεν μπορείς να αλλάξεις τον δικό σου ρόλο (θα αποσυνδεόσουν).","You can't change your own role (it would log you out).")); return; }
    setBusy(true);
    try {
      // Omit role/clients for self to avoid self-lockout (a role/clients change revokes live sessions).
      const patch = self ? {name:ef.name.trim(), email:ef.email.trim()} : {name:ef.name.trim(), email:ef.email.trim(), role:ef.role, clients};
      await api.updateUser(u.id, patch);
      setEditId(null); await loadUsers(); await loadLogs();
    } catch(e){ setErr(e.message||t("Η ενημέρωση απέτυχε","Update failed")); }
    finally{ setBusy(false); }
  };
  const downloadBackup = async () => {
    setErr(""); setBusy(true);
    try {
      const blob = await api.backupDb();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href=url; a.download=`cbre-backup-${new Date().toISOString().slice(0,10)}.db`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      await loadLogs();
    } catch(e){ setErr(e.message||t("Το backup απέτυχε","Backup failed")); }
    finally{ setBusy(false); }
  };

  const roleBadge = {admin:"#003F2D",finance:"#00695C",ops:"#0277BD"};
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.5)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:20}} onClick={onClose}>
      <div style={{background:P.wh,borderRadius:12,width:"95%",maxWidth:960,maxHeight:"90vh",overflow:"auto",boxShadow:"0 20px 60px rgba(0,0,0,.3)"}} onClick={e=>e.stopPropagation()}>
        <div style={{background:P.em,color:"#fff",padding:"16px 24px",borderRadius:"12px 12px 0 0",display:"flex",justifyContent:"space-between",alignItems:"center",position:"sticky",top:0,zIndex:1}}>
          <div style={{fontWeight:700,fontSize:16}}>⚙️ {t("Admin — Διαχείριση","Admin — Management")}</div>
          <div style={{display:"flex",gap:8,alignItems:"center"}}>
            <button onClick={downloadBackup} disabled={busy} title={t("Κατέβασε αντίγραφο της βάσης","Download a database backup")} style={{background:"rgba(255,255,255,.18)",border:"none",color:"#fff",padding:"6px 12px",borderRadius:6,cursor:busy?"wait":"pointer",fontSize:12,fontWeight:600}}>⬇ {t("Backup βάσης","DB Backup")}</button>
            <button onClick={onClose} style={{background:"rgba(255,255,255,.2)",border:"none",color:"#fff",padding:"6px 14px",borderRadius:6,cursor:"pointer",fontSize:14,fontWeight:700}}>✕</button>
          </div>
        </div>
        <div style={{display:"flex",gap:0,padding:"0 24px",borderBottom:"1px solid "+P.bd,background:P.of}}>
          {[{v:"users",l:t("👥 Χρήστες","👥 Users")},{v:"audit",l:"📜 Audit Log"}].map(o=>(
            <button key={o.v} onClick={()=>setTab(o.v)} style={{padding:"12px 18px",fontSize:13,background:"none",border:"none",borderBottom:tab===o.v?"3px solid "+P.em:"3px solid transparent",fontWeight:tab===o.v?700:400,color:tab===o.v?P.em:P.tm,cursor:"pointer"}}>{o.l}</button>
          ))}
        </div>
        <div style={{padding:20}}>
          {err && <div style={{color:P.rd,fontSize:12,marginBottom:12,padding:"8px 12px",background:"#FFEBEE",borderRadius:6}}>{err}</div>}

          {tab==="users" && (
            <>
              <div style={{background:P.of,border:"1px solid "+P.bd,borderRadius:8,padding:14,marginBottom:16,display:"flex",flexWrap:"wrap",gap:8,alignItems:"end"}}>
                <Inp l="Username" v={nf.username} set={v=>setNf(x=>({...x,username:v}))} w={120} />
                <Inp l={t("Όνομα","Name")} v={nf.name} set={v=>setNf(x=>({...x,name:v}))} w={120} />
                <Inp l={t("Email (για reset)","Email (for reset)")} v={nf.email} set={v=>setNf(x=>({...x,email:v}))} w={170} />
                <Sel l={t("Ρόλος","Role")} v={nf.role} set={v=>setNf(x=>({...x,role:v}))} opts={[{v:"ops",l:"ops"},{v:"finance",l:"finance"},{v:"admin",l:"admin"}]} w={100} />
                <Inp l={t("Κωδικός (8+)","Password (8+)")} v={nf.password} set={v=>setNf(x=>({...x,password:v}))} w={130} />
                {nf.role==="ops" && <Inp l={t("Πελάτες (χωρισμένοι με κόμμα)","Clients (comma-separated)")} v={nf.clients} set={v=>setNf(x=>({...x,clients:v}))} w={260} />}
                {nf.role!=="ops" && <div style={{fontSize:11,color:P.tm,alignSelf:"center",padding:"0 6px"}}>{t("Πρόσβαση: ΟΛΟΙ οι πελάτες","Access: ALL clients")}</div>}
                <button onClick={create} disabled={busy} style={{background:P.em,color:"#fff",border:"none",padding:"7px 18px",borderRadius:6,cursor:busy?"wait":"pointer",fontSize:13,fontWeight:600,opacity:busy?.6:1}}>+ {t("Νέος χρήστης","New user")}</button>
              </div>
              <div style={{overflowX:"auto",border:"1px solid "+P.bd,borderRadius:8}}>
                <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
                  <thead><tr>{["Username",t("Όνομα","Name"),"Email",t("Ρόλος","Role"),t("Πρόσβαση","Access"),""].map((h,i)=>(
                    <th key={i} style={{padding:"8px 12px",fontSize:11,fontWeight:700,color:"#fff",background:P.em,textAlign:"left"}}>{h}</th>
                  ))}</tr></thead>
                  <tbody>{users.map((u,i)=>{
                    const editing = editId===u.id; const self = u.username===me.username;
                    const cellInp = {width:"100%",padding:"4px 6px",border:"1px solid "+P.bd,borderRadius:4,fontSize:12,outline:"none",boxSizing:"border-box"};
                    return (
                    <tr key={u.id} style={{background:editing?"#FFFDE7":i%2===0?P.wh:P.al}}>
                      <td style={{padding:"8px 12px",borderBottom:"1px solid "+P.bd,fontWeight:600,color:P.em}}>{u.username}{self&&<span style={{fontSize:10,color:P.tm}}> {t("(εσύ)","(you)")}</span>}</td>
                      <td style={{padding:"8px 12px",borderBottom:"1px solid "+P.bd}}>
                        {editing ? <input value={ef.name} onChange={e=>setEf(x=>({...x,name:e.target.value}))} style={cellInp} /> : u.name}
                      </td>
                      <td style={{padding:"8px 12px",borderBottom:"1px solid "+P.bd,fontSize:12}}>
                        {editing ? <input value={ef.email} onChange={e=>setEf(x=>({...x,email:e.target.value}))} placeholder="email" style={cellInp} />
                                 : <span style={{color:u.email?P.tx:P.tm}}>{u.email||t("— χωρίς —","— none —")}</span>}
                      </td>
                      <td style={{padding:"8px 12px",borderBottom:"1px solid "+P.bd}}>
                        {editing && !self
                          ? <select value={ef.role} onChange={e=>setEf(x=>({...x,role:e.target.value}))} style={cellInp}>{["ops","finance","admin"].map(r=><option key={r} value={r}>{r}</option>)}</select>
                          : <span style={{padding:"2px 10px",borderRadius:10,fontSize:11,fontWeight:700,color:"#fff",background:roleBadge[u.role]||P.tm}}>{u.role}</span>}
                      </td>
                      <td style={{padding:"8px 12px",borderBottom:"1px solid "+P.bd,color:P.tm,fontSize:12}}>
                        {editing && !self
                          ? (ef.role==="ops"
                              ? <input value={ef.clients} onChange={e=>setEf(x=>({...x,clients:e.target.value}))} placeholder={t("πελάτες, με κόμμα","clients, comma-sep")} style={cellInp} />
                              : <span style={{fontSize:11}}>{t("ΟΛΟΙ","ALL")}</span>)
                          : (u.clients==="ALL"?t("ΟΛΟΙ","ALL"):(Array.isArray(u.clients)?`${u.clients.length} ${t("πελάτες","clients")}`:"—"))}
                      </td>
                      <td style={{padding:"8px 12px",borderBottom:"1px solid "+P.bd,textAlign:"right",whiteSpace:"nowrap"}}>
                        {editing ? (<>
                          <button onClick={()=>saveEdit(u)} disabled={busy} style={{background:P.em,color:"#fff",border:"none",padding:"4px 12px",borderRadius:4,fontSize:12,fontWeight:600,cursor:busy?"wait":"pointer",marginRight:6}}>{t("Αποθήκευση","Save")}</button>
                          <button onClick={cancelEdit} style={{background:"none",border:"1px solid "+P.bd,padding:"4px 10px",borderRadius:4,fontSize:12,cursor:"pointer"}}>{t("Άκυρο","Cancel")}</button>
                        </>) : (<>
                          <button onClick={()=>startEdit(u)} style={{background:P.ep,color:P.em,border:"none",padding:"4px 12px",borderRadius:4,fontSize:12,fontWeight:600,cursor:"pointer",marginRight:6}}>✎ {t("Επεξεργασία","Edit")}</button>
                          <button onClick={()=>resetPw(u)} style={{background:P.ep,color:P.em,border:"none",padding:"4px 12px",borderRadius:4,fontSize:12,fontWeight:600,cursor:"pointer",marginRight:6}}>{t("Reset κωδικού","Reset password")}</button>
                          {!self&&<button onClick={()=>del(u)} style={{background:"#FFEBEE",color:P.rd,border:"none",padding:"4px 12px",borderRadius:4,fontSize:12,fontWeight:600,cursor:"pointer"}}>{t("Διαγραφή","Delete")}</button>}
                        </>)}
                      </td>
                    </tr>
                    );
                  })}</tbody>
                </table>
              </div>
              <div style={{fontSize:11,color:P.tm,marginTop:8}}>{t("Οι νέοι χρήστες μπαίνουν με τον κωδικό που όρισες — δεν επιβάλλεται αλλαγή κατά την πρώτη είσοδο (σε αντίθεση με τους seeded).","New users sign in with the password you set — no forced change on first login (unlike seeded accounts).")}</div>
            </>
          )}

          {tab==="audit" && (
            <div style={{overflowX:"auto",border:"1px solid "+P.bd,borderRadius:8}}>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                <thead><tr>{[t("Ημ/νία & ώρα","Date & time"),t("Χρήστης","User"),t("Ενέργεια","Action"),t("Στόχος","Target"),"IP"].map(h=>(
                  <th key={h} style={{padding:"8px 12px",fontSize:11,fontWeight:700,color:"#fff",background:P.em,textAlign:"left"}}>{h}</th>
                ))}</tr></thead>
                <tbody>{logs.map((l,i)=>(
                  <tr key={l.id||i} style={{background:i%2===0?P.wh:P.al}}>
                    <td style={{padding:"6px 12px",borderBottom:"1px solid "+P.bd,whiteSpace:"nowrap"}}>{new Date((l.timestamp||0)*1000).toLocaleString(lang==="en"?"en-GB":"el-GR")}</td>
                    <td style={{padding:"6px 12px",borderBottom:"1px solid "+P.bd,fontWeight:600}}>{l.user}</td>
                    <td style={{padding:"6px 12px",borderBottom:"1px solid "+P.bd}}><span style={{color:(l.action||"").includes("fail")?P.rd:(l.action||"").includes("success")?P.gn:P.tx}}>{l.action}</span></td>
                    <td style={{padding:"6px 12px",borderBottom:"1px solid "+P.bd,color:P.tm}}>{l.target||"—"}</td>
                    <td style={{padding:"6px 12px",borderBottom:"1px solid "+P.bd,color:P.tm,fontFamily:"monospace",fontSize:11}}>{l.ip||"—"}</td>
                  </tr>
                ))}</tbody>
              </table>
              {logs.length===0 && <div style={{padding:20,textAlign:"center",color:P.tm,fontStyle:"italic"}}>{t("Καμία εγγραφή","No entries")}</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


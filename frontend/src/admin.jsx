// Admin-only console: user management + audit log, extracted from App.jsx.
import { useState, useEffect } from "react";
import { api } from "./api.js";
import { P } from "./constants.js";
import { Inp, Sel } from "./ui.jsx";

export function AdminPanel({me,onClose}) {
  const [tab,setTab] = useState("users");
  const [users,setUsers] = useState([]);
  const [logs,setLogs] = useState([]);
  const [err,setErr] = useState("");
  const [busy,setBusy] = useState(false);
  const [nf,setNf] = useState({username:"",name:"",email:"",role:"ops",password:"",clients:""});

  const loadUsers = () => api.listUsers().then(setUsers).catch(e=>setErr(e.message||"Load failed"));
  const loadLogs = () => api.audit().then(setLogs).catch(e=>setErr(e.message||"Load failed"));
  useEffect(()=>{ loadUsers(); loadLogs(); },[]);

  const create = async () => {
    setErr("");
    if(!nf.username||!nf.name||!nf.password){ setErr("Συμπλήρωσε username, όνομα και κωδικό"); return; }
    if(nf.password.length<8){ setErr("Ο κωδικός πρέπει να έχει 8+ χαρακτήρες"); return; }
    const clients = nf.role==="ops"
      ? nf.clients.split(",").map(s=>s.trim()).filter(Boolean)
      : "ALL";
    setBusy(true);
    try {
      await api.createUser({username:nf.username.trim().toLowerCase(),name:nf.name.trim(),email:nf.email.trim(),role:nf.role,password:nf.password,clients});
      setNf({username:"",name:"",email:"",role:"ops",password:"",clients:""});
      await loadUsers(); await loadLogs();
    } catch(e){ setErr(e.message||"Δημιουργία απέτυχε"); }
    finally{ setBusy(false); }
  };
  const del = async (u) => {
    if(u.username===me.username){ setErr("Δεν μπορείς να διαγράψεις τον εαυτό σου"); return; }
    if(!confirm(`Διαγραφή χρήστη "${u.username}";`)) return;
    setBusy(true);
    try { await api.deleteUser(u.id); await loadUsers(); await loadLogs(); }
    catch(e){ setErr(e.message||"Διαγραφή απέτυχε"); }
    finally{ setBusy(false); }
  };
  const resetPw = async (u) => {
    setErr("");
    const p = prompt(`Νέος προσωρινός κωδικός για "${u.username}" (8+ χαρακτήρες).\nΆφησέ το ΚΕΝΟ για αυτόματο.`, "");
    if(p===null) return;
    if(p && p.length<8){ setErr("Ο κωδικός πρέπει να έχει 8+ χαρακτήρες"); return; }
    setBusy(true);
    try {
      const r = await api.resetUserPassword(u.id, p||undefined);
      await loadLogs();
      alert(`✓ Ο κωδικός του "${r.username}" έγινε reset.\n\nΠροσωρινός κωδικός:\n\n    ${r.tempPassword}\n\nΔώσ' τον στον χρήστη — θα του ζητηθεί να τον αλλάξει στην πρώτη είσοδο. Οι υπάρχουσες συνεδρίες του ακυρώθηκαν.`);
    } catch(e){ setErr(e.message||"Reset κωδικού απέτυχε"); }
    finally{ setBusy(false); }
  };
  const editEmail = async (u) => {
    setErr("");
    const email = prompt(`Email του "${u.username}" (για επαναφορά κωδικού):`, u.email||"");
    if(email===null) return;
    setBusy(true);
    try { await api.updateUser(u.id, {email:email.trim()}); await loadUsers(); await loadLogs(); }
    catch(e){ setErr(e.message||"Ενημέρωση email απέτυχε"); }
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
    } catch(e){ setErr(e.message||"Backup απέτυχε"); }
    finally{ setBusy(false); }
  };

  const roleBadge = {admin:"#003F2D",finance:"#00695C",ops:"#0277BD"};
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.5)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:20}} onClick={onClose}>
      <div style={{background:P.wh,borderRadius:12,width:"95%",maxWidth:960,maxHeight:"90vh",overflow:"auto",boxShadow:"0 20px 60px rgba(0,0,0,.3)"}} onClick={e=>e.stopPropagation()}>
        <div style={{background:P.em,color:"#fff",padding:"16px 24px",borderRadius:"12px 12px 0 0",display:"flex",justifyContent:"space-between",alignItems:"center",position:"sticky",top:0,zIndex:1}}>
          <div style={{fontWeight:700,fontSize:16}}>⚙️ Admin — Διαχείριση</div>
          <div style={{display:"flex",gap:8,alignItems:"center"}}>
            <button onClick={downloadBackup} disabled={busy} title="Κατέβασε αντίγραφο της βάσης" style={{background:"rgba(255,255,255,.18)",border:"none",color:"#fff",padding:"6px 12px",borderRadius:6,cursor:busy?"wait":"pointer",fontSize:12,fontWeight:600}}>⬇ Backup βάσης</button>
            <button onClick={onClose} style={{background:"rgba(255,255,255,.2)",border:"none",color:"#fff",padding:"6px 14px",borderRadius:6,cursor:"pointer",fontSize:14,fontWeight:700}}>✕</button>
          </div>
        </div>
        <div style={{display:"flex",gap:0,padding:"0 24px",borderBottom:"1px solid "+P.bd,background:P.of}}>
          {[{v:"users",l:"👥 Χρήστες"},{v:"audit",l:"📜 Audit Log"}].map(t=>(
            <button key={t.v} onClick={()=>setTab(t.v)} style={{padding:"12px 18px",fontSize:13,background:"none",border:"none",borderBottom:tab===t.v?"3px solid "+P.em:"3px solid transparent",fontWeight:tab===t.v?700:400,color:tab===t.v?P.em:P.tm,cursor:"pointer"}}>{t.l}</button>
          ))}
        </div>
        <div style={{padding:20}}>
          {err && <div style={{color:P.rd,fontSize:12,marginBottom:12,padding:"8px 12px",background:"#FFEBEE",borderRadius:6}}>{err}</div>}

          {tab==="users" && (
            <>
              <div style={{background:P.of,border:"1px solid "+P.bd,borderRadius:8,padding:14,marginBottom:16,display:"flex",flexWrap:"wrap",gap:8,alignItems:"end"}}>
                <Inp l="Username" v={nf.username} set={v=>setNf(x=>({...x,username:v}))} w={120} />
                <Inp l="Όνομα" v={nf.name} set={v=>setNf(x=>({...x,name:v}))} w={120} />
                <Inp l="Email (για reset)" v={nf.email} set={v=>setNf(x=>({...x,email:v}))} w={170} />
                <Sel l="Ρόλος" v={nf.role} set={v=>setNf(x=>({...x,role:v}))} opts={[{v:"ops",l:"ops"},{v:"finance",l:"finance"},{v:"admin",l:"admin"}]} w={100} />
                <Inp l="Κωδικός (8+)" v={nf.password} set={v=>setNf(x=>({...x,password:v}))} w={130} />
                {nf.role==="ops" && <Inp l="Clients (χωρισμένα με κόμμα)" v={nf.clients} set={v=>setNf(x=>({...x,clients:v}))} w={260} />}
                {nf.role!=="ops" && <div style={{fontSize:11,color:P.tm,alignSelf:"center",padding:"0 6px"}}>Πρόσβαση: ΟΛΟΙ οι πελάτες</div>}
                <button onClick={create} disabled={busy} style={{background:P.em,color:"#fff",border:"none",padding:"7px 18px",borderRadius:6,cursor:busy?"wait":"pointer",fontSize:13,fontWeight:600,opacity:busy?.6:1}}>+ Νέος χρήστης</button>
              </div>
              <div style={{overflowX:"auto",border:"1px solid "+P.bd,borderRadius:8}}>
                <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
                  <thead><tr>{["Username","Όνομα","Email","Ρόλος","Πρόσβαση","",].map((h,i)=>(
                    <th key={i} style={{padding:"8px 12px",fontSize:11,fontWeight:700,color:"#fff",background:P.em,textAlign:"left"}}>{h}</th>
                  ))}</tr></thead>
                  <tbody>{users.map((u,i)=>(
                    <tr key={u.id} style={{background:i%2===0?P.wh:P.al}}>
                      <td style={{padding:"8px 12px",borderBottom:"1px solid "+P.bd,fontWeight:600,color:P.em}}>{u.username}{u.username===me.username&&<span style={{fontSize:10,color:P.tm}}> (εσύ)</span>}</td>
                      <td style={{padding:"8px 12px",borderBottom:"1px solid "+P.bd}}>{u.name}</td>
                      <td style={{padding:"8px 12px",borderBottom:"1px solid "+P.bd,fontSize:12}}>
                        <span style={{color:u.email?P.tx:P.tm}}>{u.email||"— χωρίς —"}</span>
                        <button onClick={()=>editEmail(u)} title="Επεξεργασία email" style={{background:"none",border:"none",color:P.em,cursor:"pointer",fontSize:12,marginLeft:6,padding:0}}>✎</button>
                      </td>
                      <td style={{padding:"8px 12px",borderBottom:"1px solid "+P.bd}}><span style={{padding:"2px 10px",borderRadius:10,fontSize:11,fontWeight:700,color:"#fff",background:roleBadge[u.role]||P.tm}}>{u.role}</span></td>
                      <td style={{padding:"8px 12px",borderBottom:"1px solid "+P.bd,color:P.tm,fontSize:12}}>{u.clients==="ALL"?"ΟΛΟΙ":(Array.isArray(u.clients)?`${u.clients.length} πελάτες`:"—")}</td>
                      <td style={{padding:"8px 12px",borderBottom:"1px solid "+P.bd,textAlign:"right",whiteSpace:"nowrap"}}>
                        <button onClick={()=>resetPw(u)} style={{background:P.ep,color:P.em,border:"none",padding:"4px 12px",borderRadius:4,fontSize:12,fontWeight:600,cursor:"pointer",marginRight:6}}>Reset κωδικού</button>
                        {u.username!==me.username&&<button onClick={()=>del(u)} style={{background:"#FFEBEE",color:P.rd,border:"none",padding:"4px 12px",borderRadius:4,fontSize:12,fontWeight:600,cursor:"pointer"}}>Διαγραφή</button>}
                      </td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
              <div style={{fontSize:11,color:P.tm,marginTop:8}}>Οι νέοι χρήστες μπαίνουν με τον κωδικό που όρισες — δεν επιβάλλεται αλλαγή κατά την πρώτη είσοδο (σε αντίθεση με τους seeded).</div>
            </>
          )}

          {tab==="audit" && (
            <div style={{overflowX:"auto",border:"1px solid "+P.bd,borderRadius:8}}>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                <thead><tr>{["Ημ/νία & ώρα","Χρήστης","Ενέργεια","Στόχος","IP"].map(h=>(
                  <th key={h} style={{padding:"8px 12px",fontSize:11,fontWeight:700,color:"#fff",background:P.em,textAlign:"left"}}>{h}</th>
                ))}</tr></thead>
                <tbody>{logs.map((l,i)=>(
                  <tr key={l.id||i} style={{background:i%2===0?P.wh:P.al}}>
                    <td style={{padding:"6px 12px",borderBottom:"1px solid "+P.bd,whiteSpace:"nowrap"}}>{new Date((l.timestamp||0)*1000).toLocaleString("el-GR")}</td>
                    <td style={{padding:"6px 12px",borderBottom:"1px solid "+P.bd,fontWeight:600}}>{l.user}</td>
                    <td style={{padding:"6px 12px",borderBottom:"1px solid "+P.bd}}><span style={{color:(l.action||"").includes("fail")?P.rd:(l.action||"").includes("success")?P.gn:P.tx}}>{l.action}</span></td>
                    <td style={{padding:"6px 12px",borderBottom:"1px solid "+P.bd,color:P.tm}}>{l.target||"—"}</td>
                    <td style={{padding:"6px 12px",borderBottom:"1px solid "+P.bd,color:P.tm,fontFamily:"monospace",fontSize:11}}>{l.ip||"—"}</td>
                  </tr>
                ))}</tbody>
              </table>
              {logs.length===0 && <div style={{padding:20,textAlign:"center",color:P.tm,fontStyle:"italic"}}>Καμία εγγραφή</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


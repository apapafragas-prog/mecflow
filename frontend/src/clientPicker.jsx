// Client selection landing screen (per-user client list with status + logo). Extracted from App.jsx.
import { useState } from "react";
import { P, CLIENTS, YEARS, REPORT_STATUS, fmt, fPct } from "./constants.js";
import { LogoImg, LangToggle } from "./ui.jsx";
import { AdminPanel } from "./admin.jsx";
import { useT, statusLabel } from "./i18n.jsx";


export function ClientPicker({user,year,setYear,onSelect,onLogout,allData,onOpenFinance,onOpenDash,onOpenLedger,onOpenGroup}) {
  const { t } = useT();
  const [search,setSearch] = useState("");
  const [sort,setSort] = useState("name");
  const [adminOpen,setAdminOpen] = useState(false);
  const myClients = user.clients === "ALL" ? CLIENTS : (user.clients || []);
  const isAdmin = user.clients === "ALL";

  const stats = (c) => {
    const d = allData[c]; if (!d) return {inv:0,sub:0,rev:0,cost:0,gm:0,contracts:0,poVal:0,status:"draft"};
    const rev = d.inv.reduce((s,i)=>s+(Number(i.amt)||0),0);
    const cost = d.sub.reduce((s,i)=>s+(Number(i.amt)||0),0);
    const poVal = d.contracts.filter(x=>x.type==="PO").reduce((s,x)=>s+(Number(x.po_value)||0),0);
    return {inv:d.inv.length, sub:d.sub.length, rev, cost, gm:rev-cost, contracts:d.contracts.length, poVal, status:d.status||"draft"};
  };

  const allStats = myClients.map(c=>({name:c,...stats(c)}));
  const totRev = allStats.reduce((s,x)=>s+x.rev,0);
  const totGM = allStats.reduce((s,x)=>s+x.gm,0);
  const activeN = allStats.filter(x=>x.inv>0).length;
  const submitted = allStats.filter(x=>x.status==="submitted").length;
  const approved = allStats.filter(x=>x.status==="approved").length;

  const filtered = allStats.filter(c => c.name.toLowerCase().includes(search.toLowerCase()));
  const sorted = filtered.sort((a,b) => {
    if(sort==="rev") return b.rev-a.rev;
    if(sort==="gm") return b.gm-a.gm;
    if(sort==="status") return a.status.localeCompare(b.status);
    const ha=a.inv+a.sub, hb=b.inv+b.sub;
    if(ha>0&&hb===0) return -1; if(hb>0&&ha===0) return 1;
    return a.name.localeCompare(b.name);
  });

  const rs = s => REPORT_STATUS.find(x=>x.v===s)||REPORT_STATUS[0];

  return (
    <div style={{minHeight:"100vh",background:P.of,fontFamily:"Segoe UI,Tahoma,sans-serif"}}>
      {/* Header */}
      <div style={{background:P.em,color:"#fff",padding:"14px 24px",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div style={{display:"flex",alignItems:"center",gap:16}}>
          <span style={{fontWeight:800,fontSize:22,letterSpacing:2}}>CBRE</span>
          <span style={{fontSize:13,opacity:.7,borderLeft:"1px solid rgba(255,255,255,.3)",paddingLeft:12}}>{t("Ελλάδα — Μηνιαία Αναφορά","Greece — Monthly Reporting")}</span>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:10,fontSize:13}}>
          <LangToggle dark />
          <span style={{opacity:.7}}>{user.name}</span>
          {isAdmin&&<span style={{background:"rgba(255,255,255,.2)",padding:"2px 8px",borderRadius:10,fontSize:10}}>ADMIN</span>}
          <button onClick={onOpenDash} style={{background:"rgba(255,255,255,.15)",border:"none",color:"#fff",padding:"5px 14px",borderRadius:4,cursor:"pointer",fontSize:12}}>📊 Dashboard</button>
          {(user.role==="finance"||user.role==="admin")&&<button onClick={onOpenLedger} style={{background:"rgba(255,255,255,.15)",border:"none",color:"#fff",padding:"5px 14px",borderRadius:4,cursor:"pointer",fontSize:12}}>📒 AP/AR</button>}
          {(user.role==="finance"||user.role==="admin")&&<button onClick={onOpenFinance} style={{background:"rgba(255,255,255,.15)",border:"none",color:"#fff",padding:"5px 14px",borderRadius:4,cursor:"pointer",fontSize:12}}>💰 OPEX/CAPEX</button>}
          {(user.role==="finance"||user.role==="admin")&&<button onClick={onOpenGroup} style={{background:"rgba(255,255,255,.15)",border:"none",color:"#fff",padding:"5px 14px",borderRadius:4,cursor:"pointer",fontSize:12}}>🏢 {t("Όμιλος P&L/BS","Group P&L/BS")}</button>}
          {user.role==="admin"&&<button onClick={()=>setAdminOpen(true)} style={{background:"rgba(255,255,255,.15)",border:"none",color:"#fff",padding:"5px 14px",borderRadius:4,cursor:"pointer",fontSize:12}}>⚙️ Admin</button>}
          <button onClick={onLogout} style={{background:"rgba(255,255,255,.12)",border:"none",color:"#fff",padding:"5px 14px",borderRadius:4,cursor:"pointer",fontSize:12}}>{t("Αποσύνδεση","Logout")}</button>
        </div>
      </div>
      {adminOpen && <AdminPanel me={user} onClose={()=>setAdminOpen(false)} />}

      <div style={{maxWidth:1300,margin:"0 auto",padding:"20px 24px"}}>
        {/* Year selector + KPIs */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20,flexWrap:"wrap",gap:12}}>
          <div style={{display:"flex",alignItems:"center",gap:12}}>
            {YEARS.map(y=>(
              <button key={y} onClick={()=>setYear(y)} style={{padding:"8px 20px",border:year===y?"2px solid "+P.em:"1px solid "+P.bd,borderRadius:6,cursor:"pointer",fontSize:14,fontWeight:year===y?700:400,background:year===y?P.em:P.wh,color:year===y?"#fff":P.tx}}>{y}</button>
            ))}
          </div>
          <div style={{display:"flex",gap:16,fontSize:13}}>
            <span style={{color:P.gn,fontWeight:600}}>{t("Έσοδα","Rev")}: €{fmt(totRev)}</span>
            <span style={{color:totGM>=0?P.gn:P.rd,fontWeight:600}}>GM: €{fmt(totGM)}</span>
            <span style={{color:P.tx}}>{activeN} {t("ενεργοί","active")}</span>
            {submitted>0&&<span style={{color:"#F57F17",fontWeight:600}}>{submitted} {t("εκκρεμούν","pending")}</span>}
            {approved>0&&<span style={{color:P.gn}}>{approved} {t("εγκεκριμένοι","approved")}</span>}
          </div>
        </div>

        {/* Toolbar */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,gap:12}}>
          <input placeholder={t("🔍 Αναζήτηση...","🔍 Search...")} value={search} onChange={e=>setSearch(e.target.value)} style={{padding:"7px 14px",border:"1px solid "+P.bd,borderRadius:6,fontSize:13,outline:"none",width:240,background:P.wh}} />
          <div style={{display:"flex",gap:4,fontSize:12}}>
            {[{v:"name",l:"A→Z"},{v:"rev",l:t("Έσοδα","Revenue")},{v:"gm",l:"GM"},{v:"status",l:t("Κατάσταση","Status")}].map(s=>(
              <button key={s.v} onClick={()=>setSort(s.v)} style={{padding:"5px 10px",border:"1px solid "+P.bd,borderRadius:4,cursor:"pointer",background:sort===s.v?P.ep:P.wh,color:P.tx,fontSize:11,fontWeight:sort===s.v?600:400}}>{s.l}</button>
            ))}
          </div>
        </div>

        {/* Client list */}
        <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,overflow:"hidden"}}>
          <table style={{width:"100%",borderCollapse:"collapse"}}>
            <thead><tr>
              {[["Client",t("Πελάτης","Client")],["Revenue €",t("Έσοδα €","Revenue €")],["Cost €",t("Κόστος €","Cost €")],["GM €","GM €"],["GM%","GM%"],["Invoices",t("Τιμολόγια","Invoices")],["Sub",t("Υπεργ.","Sub")],["Contracts",t("Συμβόλαια","Contracts")],["PO Value €",t("Αξία PO €","PO Value €")],["Report Status",t("Κατάσταση Αναφοράς","Report Status")]].map(([k,h])=>(
                <th key={k} style={{padding:"8px 12px",fontSize:11,fontWeight:700,color:"#fff",background:P.em,textAlign:k==="Client"||k==="Report Status"?"left":"right"}}>{h}</th>
              ))}
            </tr></thead>
            <tbody>{sorted.map((c,i) => {
              const st = rs(c.status);
              return (
                <tr key={c.name} onClick={()=>onSelect(c.name)} style={{cursor:"pointer",background:i%2===0?P.wh:P.al,transition:"background .1s"}}
                  onMouseEnter={e=>e.currentTarget.style.background=P.ep}
                  onMouseLeave={e=>e.currentTarget.style.background=i%2===0?P.wh:P.al}>
                  <td style={{padding:"10px 12px",fontSize:13,fontWeight:600,color:P.em,borderBottom:"1px solid "+P.bd}}>
                    <div style={{display:"flex",alignItems:"center",gap:10}}>
                      <LogoImg name={c.name} size={28} radius={6} />
                      <div>
                        <div>{c.name}</div>
                        {c.inv>0&&<div style={{fontSize:10,color:P.gn}}>● {t("Ενεργός","Active")}</div>}
                      </div>
                    </div>
                  </td>
                  <td style={{padding:"8px 12px",fontSize:12,textAlign:"right",color:c.rev?P.gn:P.tm,fontWeight:c.rev?600:400,borderBottom:"1px solid "+P.bd}}>{c.rev?fmt(c.rev):"-"}</td>
                  <td style={{padding:"8px 12px",fontSize:12,textAlign:"right",borderBottom:"1px solid "+P.bd}}>{c.cost?fmt(c.cost):"-"}</td>
                  <td style={{padding:"8px 12px",fontSize:12,textAlign:"right",fontWeight:600,color:c.gm>0?P.gn:c.gm<0?P.rd:P.tm,borderBottom:"1px solid "+P.bd}}>{c.gm?fmt(c.gm):"-"}</td>
                  <td style={{padding:"8px 12px",fontSize:12,textAlign:"right",borderBottom:"1px solid "+P.bd}}>{c.rev?fPct(c.gm/c.rev):"-"}</td>
                  <td style={{padding:"8px 12px",fontSize:12,textAlign:"right",borderBottom:"1px solid "+P.bd}}>{c.inv||"-"}</td>
                  <td style={{padding:"8px 12px",fontSize:12,textAlign:"right",borderBottom:"1px solid "+P.bd}}>{c.sub||"-"}</td>
                  <td style={{padding:"8px 12px",fontSize:12,textAlign:"right",borderBottom:"1px solid "+P.bd}}>{c.contracts||"-"}</td>
                  <td style={{padding:"8px 12px",fontSize:12,textAlign:"right",borderBottom:"1px solid "+P.bd}}>{c.poVal?fmt(c.poVal):"-"}</td>
                  <td style={{padding:"8px 12px",borderBottom:"1px solid "+P.bd}}>
                    <span style={{padding:"3px 10px",borderRadius:12,fontSize:10,fontWeight:700,background:st.bg,color:st.color,whiteSpace:"nowrap"}}>{statusLabel(st.v,st.l)}</span>
                  </td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
        <div style={{textAlign:"center",fontSize:11,color:P.tm,marginTop:12}}>{sorted.length} {t("από","of")} {myClients.length} {t("πελάτες","clients")} — {year}</div>
      </div>
    </div>
  );
}

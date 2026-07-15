// Company-wide finance screens (finance/admin roles), extracted from App.jsx.
//   Dashboard  — consolidated portfolio dashboard across all clients for the year.
//   ApArLedger — AP/AR ledger + aging (receivables from clients, payables to subs).
//   OpexCapex  — company OPEX budget-vs-actual + CAPEX register with depreciation.
import { useState, useEffect, useRef } from "react";
import { api } from "./api.js";
import { P, MONTHS, ML, YEARS, uid, fmt, fPct, REPORT_STATUS, DEFAULT_OPEX_CATS, CAPEX_CATS, CAPEX_STATUS } from "./constants.js";
import { agingBucket, AGING_BUCKETS, depreciation, daysUntil, parseDate, runRateFY, clientRisks } from "./calc.js";
import { Inp, Sel, LangToggle } from "./ui.jsx";
import { AiCard } from "./insights.jsx";
import { useT, monthLabel, statusLabel } from "./i18n.jsx";

// Consolidated portfolio dashboard (finance/admin + ops for their own clients).
// Loads ALL clients' data for the year at once via getYearData — so totals are real,
// not just the clients visited this session.
export function Dashboard({year,setYear,user,onBack,onLogout,onSelectClient}) {
  const { t } = useT();
  const [data,setData] = useState(null);
  const [loading,setLoading] = useState(true);

  useEffect(()=>{
    let cancelled=false; setLoading(true);
    api.getYearData(year).then(d=>{ if(!cancelled){ setData(d||{}); setLoading(false); } }).catch(()=>{ if(!cancelled){ setData({}); setLoading(false); } });
    return ()=>{cancelled=true;};
  },[year]);

  const clientStats = (cd) => {
    const inv=cd?.inv||[], sub=cd?.sub||[], lab=cd?.lab||{};
    const rev=inv.reduce((s,i)=>s+(Number(i.amt)||0),0);
    const cost=sub.reduce((s,i)=>s+(Number(i.amt)||0),0);
    const labour=Object.values(lab).reduce((s,mo)=>s+Object.values(mo||{}).reduce((s2,v)=>s2+(Number(v)||0),0),0);
    return {rev,cost,labour,gm:rev-cost-labour,status:cd?.status||"draft",inv:inv.length,sub:sub.length};
  };
  const rows = Object.entries(data||{}).map(([name,cd])=>({name,...clientStats(cd)}));
  const active = rows.filter(r=>r.inv>0||r.sub>0);
  const totRev = rows.reduce((s,r)=>s+r.rev,0);
  const totCost = rows.reduce((s,r)=>s+r.cost,0);
  const totLab = rows.reduce((s,r)=>s+r.labour,0);
  const totGM = totRev-totCost-totLab;
  const byStatus = (st)=>rows.filter(r=>r.status===st).length;
  const pending = rows.filter(r=>r.status==="submitted").sort((a,b)=>b.rev-a.rev);
  const topGM = [...active].sort((a,b)=>b.gm-a.gm).slice(0,8);

  // Monthly aggregates across all clients
  const monthly = MONTHS.map(m=>{
    let rev=0,cost=0,labour=0;
    Object.values(data||{}).forEach(cd=>{
      (cd?.inv||[]).forEach(i=>{ if(i.month===m) rev+=Number(i.amt)||0; });
      (cd?.sub||[]).forEach(i=>{ if(i.month===m) cost+=Number(i.amt)||0; });
      if(cd?.lab?.[m]) labour+=Object.values(cd.lab[m]).reduce((s,v)=>s+(Number(v)||0),0);
    });
    return {m,rev,cost,labour,gm:rev-cost-labour};
  });
  const maxRev = Math.max(1,...monthly.map(x=>x.rev));

  const kpi = (l,v,c,pct)=>(
    <div style={{background:P.wh,border:"1px solid "+P.bd,borderRadius:10,padding:"14px 16px",boxShadow:"0 1px 2px rgba(0,0,0,.04)"}}>
      <div style={{fontSize:12,color:P.tm}}>{l}</div>
      <div style={{fontSize:22,fontWeight:800,color:c,marginTop:5}}>{pct?fPct(v):"€"+fmt(v)}</div>
    </div>
  );
  const st = s => REPORT_STATUS.find(x=>x.v===s)||REPORT_STATUS[0];

  return (
    <div style={{minHeight:"100vh",background:P.of,fontFamily:"Segoe UI,Tahoma,sans-serif"}}>
      <div style={{background:P.em,color:"#fff",padding:"14px 24px",display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:8}}>
        <div style={{display:"flex",alignItems:"center",gap:16}}>
          <span style={{fontWeight:800,fontSize:20,letterSpacing:1}}>CBRE</span>
          <button onClick={onBack} style={{background:"rgba(255,255,255,.2)",border:"none",color:"#fff",padding:"4px 12px",borderRadius:4,cursor:"pointer",fontSize:12}}>◀ {t("Πελάτες","Clients")}</button>
          <span style={{fontSize:14,fontWeight:600,borderLeft:"1px solid rgba(255,255,255,.3)",paddingLeft:12}}>📊 {t("Dashboard Χαρτοφυλακίου","Portfolio Dashboard")} — {year}</span>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:10,fontSize:13}}>
          <LangToggle dark />
          <span style={{opacity:.7}}>{user.name}</span>
          <button onClick={onLogout} style={{background:"rgba(255,255,255,.15)",border:"none",color:"#fff",padding:"5px 14px",borderRadius:4,cursor:"pointer",fontSize:12}}>{t("Αποσύνδεση","Logout")}</button>
        </div>
      </div>

      <div style={{maxWidth:1300,margin:"0 auto",padding:"18px 24px"}}>
        <div style={{display:"flex",gap:8,marginBottom:16}}>
          {YEARS.map(y=>(<button key={y} onClick={()=>setYear(y)} style={{padding:"6px 16px",border:year===y?"2px solid "+P.em:"1px solid "+P.bd,borderRadius:6,cursor:"pointer",fontSize:13,fontWeight:year===y?700:400,background:year===y?P.em:P.wh,color:year===y?"#fff":P.tx}}>{y}</button>))}
        </div>

        {loading ? <div style={{padding:40,textAlign:"center",color:P.tm}}>{t("Φόρτωση…","Loading…")}</div> : (
        <>
          {/* KPIs */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(180px,1fr))",gap:12,marginBottom:20}}>
            {kpi(t("Συνολικά Έσοδα","Total Revenue"),totRev,P.gn)}
            {kpi(t("Συνολικό Κόστος (υπεργ.)","Total Cost (sub)"),totCost,P.tx)}
            {kpi(t("Εργασία","Labour"),totLab,P.tx)}
            {kpi(t("Μικτό Περιθώριο","Gross Margin"),totGM,totGM>=0?P.gn:P.rd)}
            {kpi("GM %",totRev?totGM/totRev:null,P.em,true)}
            <div style={{background:P.wh,border:"1px solid "+P.bd,borderRadius:10,padding:"14px 16px"}}>
              <div style={{fontSize:12,color:P.tm}}>{t("Ενεργοί πελάτες","Active clients")}</div>
              <div style={{fontSize:22,fontWeight:800,color:P.em,marginTop:5}}>{active.length}<span style={{fontSize:13,color:P.tm,fontWeight:400}}> / {rows.length}</span></div>
            </div>
          </div>

          <div style={{display:"grid",gridTemplateColumns:"2fr 1fr",gap:16,alignItems:"start"}}>
            {/* Monthly trend */}
            <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,padding:16}}>
              <div style={{fontSize:13,fontWeight:700,color:P.em,marginBottom:12}}>{t("Μηνιαία τάση — Έσοδα / GM","Monthly trend — Revenue / GM")}</div>
              <div style={{display:"flex",flexDirection:"column",gap:6}}>
                {monthly.map(x=>(
                  <div key={x.m} style={{display:"flex",alignItems:"center",gap:8,fontSize:11}}>
                    <span style={{width:44,color:P.tm,flexShrink:0}}>{monthLabel(x.m)}</span>
                    <div style={{flex:1,background:"#eef2ef",borderRadius:4,height:16,position:"relative",overflow:"hidden"}}>
                      <div style={{position:"absolute",left:0,top:0,bottom:0,width:(x.rev/maxRev*100)+"%",background:P.ep}} />
                      <div style={{position:"absolute",left:0,top:0,bottom:0,width:(Math.max(0,x.gm)/maxRev*100)+"%",background:P.em,opacity:.85}} />
                    </div>
                    <span style={{width:78,textAlign:"right",color:P.gn,flexShrink:0}}>{fmt(x.rev)}</span>
                    <span style={{width:78,textAlign:"right",color:x.gm>=0?P.em:P.rd,fontWeight:600,flexShrink:0}}>{fmt(x.gm)}</span>
                  </div>
                ))}
              </div>
              <div style={{display:"flex",gap:16,marginTop:10,fontSize:10,color:P.tm}}>
                <span><span style={{display:"inline-block",width:10,height:10,background:P.ep,borderRadius:2,verticalAlign:"middle",marginRight:4}} />{t("Έσοδα","Revenue")}</span>
                <span><span style={{display:"inline-block",width:10,height:10,background:P.em,borderRadius:2,verticalAlign:"middle",marginRight:4}} />GM</span>
              </div>
            </div>

            {/* Completeness + pending */}
            <div style={{display:"flex",flexDirection:"column",gap:16}}>
              <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,padding:16}}>
                <div style={{fontSize:13,fontWeight:700,color:P.em,marginBottom:10}}>{t("Πληρότητα αναφορών","Report completeness")}</div>
                {(()=>{ const ap=byStatus("approved"),su=byStatus("submitted"),rj=byStatus("rejected"),n=rows.length||1;
                  return (<>
                    <div style={{display:"flex",height:14,borderRadius:7,overflow:"hidden",marginBottom:10,background:"#ECEFF1"}}>
                      <div style={{width:(ap/n*100)+"%",background:"#2E7D32"}} title={`Approved ${ap}`} />
                      <div style={{width:(su/n*100)+"%",background:"#F57F17"}} title={`Submitted ${su}`} />
                      <div style={{width:(rj/n*100)+"%",background:"#C62828"}} title={`Rejected ${rj}`} />
                    </div>
                    {[[t("Εγκρίθηκε","Approved"),ap,"#2E7D32"],[t("Υποβλήθηκε (εκκρεμεί)","Submitted (pending)"),su,"#F57F17"],[t("Απορρίφθηκε","Rejected"),rj,"#C62828"],[t("Πρόχειρο","Draft"),byStatus("draft"),"#78909C"]].map(([l,v,c])=>(
                      <div key={l} style={{display:"flex",justifyContent:"space-between",fontSize:12,padding:"3px 0"}}><span style={{color:c,fontWeight:600}}>● {l}</span><span style={{fontWeight:700}}>{v}</span></div>
                    ))}
                  </>);
                })()}
              </div>
              <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,padding:16}}>
                <div style={{fontSize:13,fontWeight:700,color:"#F57F17",marginBottom:10}}>⏳ {t("Εκκρεμούν έγκριση","Pending approval")} ({pending.length})</div>
                {pending.length? pending.slice(0,8).map(p=>(
                  <div key={p.name} onClick={()=>onSelectClient&&onSelectClient(p.name)} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"5px 0",borderBottom:"1px solid "+P.bd,cursor:"pointer",fontSize:12}}>
                    <span style={{fontWeight:600,color:P.em}}>{p.name}</span><span style={{color:P.gn}}>€{fmt(p.rev)}</span>
                  </div>
                )) : <div style={{fontSize:12,color:P.tm,fontStyle:"italic"}}>{t("Καμία εκκρεμότητα 🎉","Nothing pending 🎉")}</div>}
              </div>
            </div>
          </div>

          {/* Expiring contracts (next 90 days) across the portfolio */}
          {(()=>{
            const exp=[]; Object.entries(data||{}).forEach(([name,cd])=>{ (cd?.contracts||[]).forEach(c=>{ if(c.status==="Terminated"||c.status==="Expired") return; const dd=daysUntil(c.expiry); if(dd!=null&&dd<=90) exp.push({client:name,ref:c.ref,type:c.type,expiry:c.expiry,dd}); }); });
            exp.sort((a,b)=>a.dd-b.dd);
            if(!exp.length) return null;
            return (
              <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,padding:16,marginTop:16}}>
                <div style={{fontSize:13,fontWeight:700,color:"#C62828",marginBottom:10}}>⚠️ {t("Συμβόλαια/PO που λήγουν (επόμενες 90 ημέρες)","Contracts/POs expiring (next 90 days)")} — {exp.length}</div>
                <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                  <thead><tr>{[t("Πελάτης","Client"),t("Τύπος","Type"),"Reference",t("Λήξη","Expiry"),t("Σε","In")].map((h,i)=>(<th key={i} style={{padding:"6px 10px",fontSize:11,fontWeight:700,color:"#fff",background:P.em,textAlign:i===4?"right":"left"}}>{h}</th>))}</tr></thead>
                  <tbody>{exp.slice(0,12).map((e,i)=>(
                    <tr key={i} onClick={()=>onSelectClient&&onSelectClient(e.client)} style={{background:i%2===0?P.wh:P.al,cursor:"pointer"}}>
                      <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,fontWeight:600,color:P.em}}>{e.client}</td>
                      <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,color:P.tm}}>{e.type}</td>
                      <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd}}>{e.ref||"—"}</td>
                      <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd}}>{e.expiry}</td>
                      <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,textAlign:"right",fontWeight:700,color:e.dd<0?P.rd:e.dd<=30?P.rd:"#F57F17"}}>{e.dd<0?t("Έληξε","Expired"):`${e.dd}${t("μ","d")}`}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            );
          })()}

          {/* Portfolio forecast + AI */}
          {(()=>{
            const rr = runRateFY(monthly);
            const projGmPct = rr.projected.rev? rr.projected.gm/rr.projected.rev : null;
            const riskyClients = Object.entries(data||{}).map(([name,cd])=>{ const rk=clientRisks(cd,MONTHS); const high=rk.filter(r=>r.level==="high").length; return {name,high,total:rk.length,labels:rk.map(r=>r.label)}; }).filter(c=>c.total>0).sort((a,b)=>b.high-a.high||b.total-a.total);
            const buildContext = () => ({
              year, clients: rows.length, activeClients: active.length,
              actualFY: { rev:Math.round(totRev), cost:Math.round(totCost), labour:Math.round(totLab), gm:Math.round(totGM) },
              projectedFY: { rev:Math.round(rr.projected.rev), cost:Math.round(rr.projected.cost), gm:Math.round(rr.projected.gm) },
              gmPctActual: totRev?+((totGM/totRev)*100).toFixed(1):null,
              pendingApprovals: pending.length,
              monthly: monthly.filter(x=>x.rev||x.cost).map(x=>({month:ML[x.m]||x.m, rev:Math.round(x.rev), cost:Math.round(x.cost), gm:Math.round(x.gm)})),
              clientsAtRisk: riskyClients.slice(0,10).map(c=>({client:c.name, risks:c.labels})),
            });
            return (
              <div style={{marginTop:16}}>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12,marginBottom:12}}>
                  <div style={{background:P.wh,border:"1px solid "+P.bd,borderRadius:10,padding:"14px 16px"}}><div style={{fontSize:12,color:P.tm}}>{t("Προβλ. Έσοδα έτους","Projected Revenue FY")}</div><div style={{fontSize:20,fontWeight:800,color:P.em,marginTop:5}}>€{fmt(rr.projected.rev)}</div></div>
                  <div style={{background:P.wh,border:"1px solid "+P.bd,borderRadius:10,padding:"14px 16px"}}><div style={{fontSize:12,color:P.tm}}>{t("Προβλ. GM έτους","Projected GM FY")}</div><div style={{fontSize:20,fontWeight:800,color:rr.projected.gm>=0?P.gn:P.rd,marginTop:5}}>€{fmt(rr.projected.gm)}</div></div>
                  <div style={{background:P.wh,border:"1px solid "+P.bd,borderRadius:10,padding:"14px 16px"}}><div style={{fontSize:12,color:P.tm}}>{t("Προβλ. GM%","Projected GM%")}</div><div style={{fontSize:20,fontWeight:800,color:P.em,marginTop:5}}>{fPct(projGmPct)}</div></div>
                </div>
                {riskyClients.length>0 && (
                  <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,padding:16,marginBottom:12}}>
                    <div style={{fontSize:13,fontWeight:700,color:P.rd,marginBottom:10}}>⚠️ {t("Πελάτες με ρίσκα","Clients at risk")} ({riskyClients.length})</div>
                    {riskyClients.slice(0,8).map(c=>(
                      <div key={c.name} onClick={()=>onSelectClient&&onSelectClient(c.name)} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"5px 0",borderBottom:"1px solid "+P.bd,cursor:"pointer",fontSize:12.5}}>
                        <span style={{fontWeight:600,color:P.em}}>{c.name}</span>
                        <span style={{fontSize:11,color:P.tm}}>{c.high>0&&<span style={{color:P.rd,fontWeight:700,marginRight:8}}>{c.high} high</span>}{c.total} {t("συνολικά","total")}</span>
                      </div>
                    ))}
                  </div>
                )}
                <AiCard scope="portfolio" buildContext={buildContext} />
              </div>
            );
          })()}

          {/* Top clients by GM */}
          <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,padding:16,marginTop:16}}>
            <div style={{fontSize:13,fontWeight:700,color:P.em,marginBottom:10}}>{t("Top πελάτες κατά GM","Top clients by GM")}</div>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
              <thead><tr>{["#",t("Πελάτης","Client"),t("Έσοδα €","Revenue €"),t("Κόστος €","Cost €"),t("Εργασία €","Labour €"),"GM €","GM%",t("Κατάσταση","Status")].map((h,i)=>(<th key={i} style={{padding:"6px 10px",fontSize:11,fontWeight:700,color:"#fff",background:P.em,textAlign:i>=2&&i<=6?"right":"left"}}>{h}</th>))}</tr></thead>
              <tbody>{topGM.map((r,i)=>{ const s=st(r.status); return (
                <tr key={r.name} onClick={()=>onSelectClient&&onSelectClient(r.name)} style={{background:i%2===0?P.wh:P.al,cursor:"pointer"}}>
                  <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,color:P.tm}}>{i+1}</td>
                  <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,fontWeight:600,color:P.em}}>{r.name}</td>
                  <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,textAlign:"right",color:P.gn}}>{fmt(r.rev)}</td>
                  <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,textAlign:"right"}}>{fmt(r.cost)}</td>
                  <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,textAlign:"right"}}>{fmt(r.labour)}</td>
                  <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,textAlign:"right",fontWeight:600,color:r.gm>=0?P.em:P.rd}}>{fmt(r.gm)}</td>
                  <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,textAlign:"right",color:P.tm}}>{r.rev?fPct(r.gm/r.rev):"-"}</td>
                  <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd}}><span style={{padding:"2px 8px",borderRadius:10,fontSize:10,fontWeight:700,background:s.bg,color:s.color}}>{statusLabel(s.v,s.l)}</span></td>
                </tr>
              ); })}</tbody>
            </table>
          </div>
        </>
        )}
      </div>
    </div>
  );
}

// AP/AR ledger + aging (finance + admin). AR = client (CBRE) invoices owed to us;
// AP = supplier (sub) invoices we owe. Aggregated across all clients via getYearData.
export function ApArLedger({year,setYear,user,onBack,onLogout,onSelectClient}) {
  const { t } = useT();
  const [data,setData] = useState(null);
  const [loading,setLoading] = useState(true);
  const [view,setView] = useState("AR");        // AR | AP
  const [terms,setTerms] = useState(30);          // payment terms in days (0 = from invoice date)
  const [showPaid,setShowPaid] = useState(false);
  const [busy,setBusy] = useState("");

  const load = () => { setLoading(true); api.getYearData(year).then(d=>{ setData(d||{}); setLoading(false); }).catch(()=>{ setData({}); setLoading(false); }); };
  useEffect(()=>{ load(); /* eslint-disable-next-line */ },[year]);

  const amt = r => Number(r.total) || (Number(r.amt)||0)+(Number(r.vat)||0) || Number(r.amt) || 0;
  // Build ledger entries for the current view across all clients.
  const entries = [];
  Object.entries(data||{}).forEach(([client,cd])=>{
    const list = view==="AR" ? (cd?.inv||[]) : (cd?.sub||[]);
    list.forEach(r=>{
      const paid = r.paid==="paid" || r.paid===true;
      entries.push({ client, id:r.id, counterparty: view==="AR" ? client : (r.supplier||"—"), invNo:r.inv_no||"", date:r.date||"", amount:amt(r), paid, bucket: agingBucket(r.date, terms) });
    });
  });
  const open = entries.filter(e=>!e.paid);
  const visible = (showPaid ? entries : open).slice().sort((a,b)=>(parseDate(b.date)?.getTime()||0)-(parseDate(a.date)?.getTime()||0));
  const totalOpen = open.reduce((s,e)=>s+e.amount,0);
  const overdue = open.filter(e=>e.bucket!=="current"&&e.bucket!=="unknown").reduce((s,e)=>s+e.amount,0);
  const bucketTotal = b => open.filter(e=>e.bucket===b).reduce((s,e)=>s+e.amount,0);
  // Per-counterparty aging
  const byCp = {};
  open.forEach(e=>{ const k=e.counterparty; if(!byCp[k]) byCp[k]={cp:k,total:0,client:e.client}; byCp[k][e.bucket]=(byCp[k][e.bucket]||0)+e.amount; byCp[k].total+=e.amount; });
  const cpRows = Object.values(byCp).sort((a,b)=>b.total-a.total);

  const markPaid = async (e) => {
    const list = view==="AR" ? "inv" : "sub";
    setBusy(e.client+e.id);
    try {
      const r = await api.getClientData(year, e.client);
      const cd = r?.data; if(!cd || !Array.isArray(cd[list])) throw new Error("Δεν βρέθηκαν δεδομένα");
      const row = cd[list].find(x=>x.id===e.id); if(!row) throw new Error("Δεν βρέθηκε το τιμολόγιο");
      const nowPaid = !(row.paid==="paid"||row.paid===true);
      row.paid = nowPaid ? "paid" : ""; row.paid_date = nowPaid ? new Date().toISOString().slice(0,10) : "";
      await api.saveClientData(year, e.client, cd, r.version);
      setData(p=>({ ...p, [e.client]: cd }));
    } catch(err){ alert(t("Δεν αποθηκεύτηκε: ","Not saved: ")+(err.message||t("σφάλμα","error"))); }
    finally{ setBusy(""); }
  };

  const bucketColor = {current:P.gn,"1-30":"#9E9D24","31-60":"#F57F17","61-90":"#EF6C00","90+":P.rd,unknown:P.tm};
  const termLabel = terms===0 ? t("από ημ/νία τιμολογίου","from invoice date") : `Net ${terms}`;

  return (
    <div style={{minHeight:"100vh",background:P.of,fontFamily:"Segoe UI,Tahoma,sans-serif"}}>
      <div style={{background:P.em,color:"#fff",padding:"14px 24px",display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:8}}>
        <div style={{display:"flex",alignItems:"center",gap:16}}>
          <span style={{fontWeight:800,fontSize:20,letterSpacing:1}}>CBRE</span>
          <button onClick={onBack} style={{background:"rgba(255,255,255,.2)",border:"none",color:"#fff",padding:"4px 12px",borderRadius:4,cursor:"pointer",fontSize:12}}>◀ {t("Πελάτες","Clients")}</button>
          <span style={{fontSize:14,fontWeight:600,borderLeft:"1px solid rgba(255,255,255,.3)",paddingLeft:12}}>📒 {t("Καθολικό AP / AR","AP / AR Ledger")} — {year}</span>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:10,fontSize:13}}>
          <LangToggle dark />
          <span style={{opacity:.7}}>{user.name}</span>
          <button onClick={onLogout} style={{background:"rgba(255,255,255,.15)",border:"none",color:"#fff",padding:"5px 14px",borderRadius:4,cursor:"pointer",fontSize:12}}>{t("Αποσύνδεση","Logout")}</button>
        </div>
      </div>

      <div style={{maxWidth:1300,margin:"0 auto",padding:"18px 24px"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,flexWrap:"wrap",gap:12}}>
          <div style={{display:"flex",gap:8,alignItems:"center"}}>
            {YEARS.map(y=>(<button key={y} onClick={()=>setYear(y)} style={{padding:"6px 14px",border:year===y?"2px solid "+P.em:"1px solid "+P.bd,borderRadius:6,cursor:"pointer",fontSize:13,fontWeight:year===y?700:400,background:year===y?P.em:P.wh,color:year===y?"#fff":P.tx}}>{y}</button>))}
          </div>
          <div style={{display:"flex",gap:0,background:P.wh,borderRadius:8,border:"1px solid "+P.bd,padding:4}}>
            <button onClick={()=>setView("AR")} style={{background:view==="AR"?P.em:"transparent",color:view==="AR"?"#fff":P.tx,border:"none",padding:"7px 18px",borderRadius:6,cursor:"pointer",fontSize:13,fontWeight:600}}>📤 {t("AR — Πελάτες (εισπρακτέα)","AR — Clients (receivable)")}</button>
            <button onClick={()=>setView("AP")} style={{background:view==="AP"?P.em:"transparent",color:view==="AP"?"#fff":P.tx,border:"none",padding:"7px 18px",borderRadius:6,cursor:"pointer",fontSize:13,fontWeight:600}}>📥 {t("AP — Προμηθευτές (πληρωτέα)","AP — Suppliers (payable)")}</button>
          </div>
        </div>

        <div style={{display:"flex",gap:14,alignItems:"center",marginBottom:16,flexWrap:"wrap"}}>
          <span style={{fontSize:12,color:P.tm}}>{t("Όροι πληρωμής:","Payment terms:")}</span>
          {[{v:30,l:"Net 30"},{v:60,l:"Net 60"},{v:0,l:t("Από ημ/νία","From date")}].map(o=>(
            <button key={o.v} onClick={()=>setTerms(o.v)} style={{padding:"5px 12px",border:"1px solid "+P.bd,borderRadius:6,cursor:"pointer",fontSize:12,background:terms===o.v?P.ep:P.wh,color:P.tx,fontWeight:terms===o.v?700:400}}>{o.l}</button>
          ))}
          <label style={{fontSize:12,color:P.tm,display:"flex",alignItems:"center",gap:6,marginLeft:8,cursor:"pointer"}}><input type="checkbox" checked={showPaid} onChange={e=>setShowPaid(e.target.checked)} /> {t("Εμφάνιση εξοφλημένων","Show paid")}</label>
        </div>

        {loading ? <div style={{padding:40,textAlign:"center",color:P.tm}}>{t("Φόρτωση…","Loading…")}</div> : (
        <>
          {/* KPIs + aging buckets */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(150px,1fr))",gap:12,marginBottom:18}}>
            <div style={{background:P.wh,border:"1px solid "+P.bd,borderRadius:10,padding:"14px 16px"}}><div style={{fontSize:12,color:P.tm}}>{view==="AR"?t("Εισπρακτέα","Receivable"):t("Πληρωτέα","Payable")} ({t("ανοιχτά","open")})</div><div style={{fontSize:22,fontWeight:800,color:P.em,marginTop:5}}>€{fmt(totalOpen)}</div></div>
            <div style={{background:P.wh,border:"1px solid "+P.bd,borderRadius:10,padding:"14px 16px"}}><div style={{fontSize:12,color:P.tm}}>{t("Ληξιπρόθεσμα","Overdue")}</div><div style={{fontSize:22,fontWeight:800,color:overdue>0?P.rd:P.gn,marginTop:5}}>€{fmt(overdue)}</div></div>
            {AGING_BUCKETS.map(b=>(
              <div key={b} style={{background:P.wh,border:"1px solid "+P.bd,borderRadius:10,padding:"14px 16px"}}>
                <div style={{fontSize:12,color:bucketColor[b]}}>● {b==="current"?t("Τρέχον","Current"):b+t(" ημ"," d")}</div>
                <div style={{fontSize:18,fontWeight:700,color:P.tx,marginTop:5}}>€{fmt(bucketTotal(b))}</div>
              </div>
            ))}
          </div>

          {/* Per-counterparty aging */}
          <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,marginBottom:16,overflowX:"auto"}}>
            <div style={{padding:"10px 16px",fontSize:13,fontWeight:700,color:P.em,borderBottom:"1px solid "+P.bd}}>{t("Aging ανά","Aging by")} {view==="AR"?t("πελάτη","client"):t("προμηθευτή","supplier")} ({termLabel})</div>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:12,minWidth:820}}>
              <thead><tr>{[view==="AR"?t("Πελάτης","Client"):t("Προμηθευτής","Supplier"),t("Τρέχον","Current"),"1-30","31-60","61-90","90+",t("Σύνολο","Total")].map((h,i)=>(<th key={i} style={{padding:"7px 10px",fontSize:11,fontWeight:700,color:"#fff",background:P.em,textAlign:i===0?"left":"right"}}>{h}</th>))}</tr></thead>
              <tbody>
                {cpRows.map((r,i)=>(
                  <tr key={r.cp} onClick={()=>view==="AR"&&onSelectClient&&onSelectClient(r.cp)} style={{background:i%2===0?P.wh:P.al,cursor:view==="AR"?"pointer":"default"}}>
                    <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,fontWeight:600,color:P.em}}>{r.cp}</td>
                    {AGING_BUCKETS.map(b=><td key={b} style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,textAlign:"right",color:(r[b]&&b!=="current")?bucketColor[b]:P.tx}}>{r[b]?fmt(r[b]):"-"}</td>)}
                    <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,textAlign:"right",fontWeight:700,color:P.em}}>{fmt(r.total)}</td>
                  </tr>
                ))}
                {!cpRows.length && <tr><td colSpan={7} style={{padding:24,textAlign:"center",color:P.tm,fontStyle:"italic"}}>{t("Κανένα ανοιχτό υπόλοιπο 🎉","No open balance 🎉")}</td></tr>}
              </tbody>
            </table>
          </div>

          {/* Open items */}
          <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,overflowX:"auto"}}>
            <div style={{padding:"10px 16px",fontSize:13,fontWeight:700,color:P.em,borderBottom:"1px solid "+P.bd}}>{showPaid?t("Όλα τα παραστατικά","All documents"):t("Ανοιχτά παραστατικά","Open documents")} ({visible.length})</div>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:12,minWidth:820}}>
              <thead><tr>{[[t("Ημ/νία","Date"),"l"],[view==="AR"?t("Πελάτης","Client"):t("Προμηθευτής","Supplier"),"l"],[t("Αρ. Τιμ.","Inv No"),"l"],[t("Ποσό €","Amount €"),"r"],["Aging","l"],["",""]].map(([h,al],i)=>(<th key={i} style={{padding:"7px 10px",fontSize:11,fontWeight:700,color:"#fff",background:P.em,textAlign:al==="r"?"right":"left"}}>{h}</th>))}</tr></thead>
              <tbody>
                {visible.map((e,i)=>(
                  <tr key={e.client+e.id+i} style={{background:e.paid?"#F1F8E9":i%2===0?P.wh:P.al}}>
                    <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd}}>{e.date||"—"}</td>
                    <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,fontWeight:600,color:P.em}}>{e.counterparty}{view==="AP"&&<span style={{fontSize:10,color:P.tm}}> ({e.client})</span>}</td>
                    <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd}}>{e.invNo||"—"}</td>
                    <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,textAlign:"right",fontWeight:600}}>{fmt(e.amount)}</td>
                    <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd}}>{e.paid?<span style={{color:P.gn,fontWeight:600}}>✓ {t("Πληρωμένο","Paid")}</span>:<span style={{color:bucketColor[e.bucket],fontWeight:600}}>{e.bucket==="current"?t("Τρέχον","Current"):e.bucket}</span>}</td>
                    <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,textAlign:"right"}}>
                      <button onClick={()=>markPaid(e)} disabled={busy===e.client+e.id} style={{background:e.paid?"#FFF3E0":P.ep,color:e.paid?"#E65100":P.em,border:"none",padding:"3px 10px",borderRadius:4,fontSize:11,fontWeight:600,cursor:busy?"wait":"pointer"}}>{busy===e.client+e.id?"…":e.paid?t("↩ Ακύρωση","↩ Unpay"):t("✓ Πληρώθηκε","✓ Paid")}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{fontSize:11,color:P.tm,marginTop:8}}>{t("Aging βάσει","Aging based on")} {termLabel}. {t("Το «Paid» ενημερώνει το τιμολόγιο στον αντίστοιχο πελάτη (με έλεγχο έκδοσης).","'Paid' updates the invoice on the corresponding client (with version check).")}</div>
        </>
        )}
      </div>
    </div>
  );
}

// Company-wide OPEX / CAPEX (finance + admin). Separate from client P&L. One blob per FY.
export function OpexCapex({year,setYear,user,onBack,onLogout}) {
  const { t } = useT();
  const [fin,setFin] = useState(null);
  const [loaded,setLoaded] = useState(false);
  const [saveState,setSaveState] = useState("idle");
  const [sub,setSub] = useState("opex");            // opex | capex | summary
  const [opexView,setOpexView] = useState("actual"); // actual | budget | variance
  const [newCat,setNewCat] = useState("");
  const [cf,setCf] = useState({desc:"",cat:CAPEX_CATS[0],amount:"",month:MONTHS[0],life:36,status:"Approved",po:""});
  const verRef = useRef(0);
  const dirtyRef = useRef(false);

  const mkDefault = () => ({ opex:{ cats:DEFAULT_OPEX_CATS.map(l=>({id:uid(),label:l})), budget:{}, actual:{} }, capex:[] });

  useEffect(()=>{
    let cancelled=false; setLoaded(false);
    (async()=>{
      const r = await api.getFinanceData(year).catch(()=>null);
      if(cancelled) return;
      verRef.current = (r&&r.version)||0;
      const d = (r&&r.data) || mkDefault();
      if(!d.opex) d.opex = mkDefault().opex;
      if(!Array.isArray(d.opex.cats)||!d.opex.cats.length) d.opex.cats = mkDefault().opex.cats;
      if(!d.opex.budget) d.opex.budget={};
      if(!d.opex.actual) d.opex.actual={};
      if(!Array.isArray(d.capex)) d.capex=[];
      setFin(d); dirtyRef.current=false; setSaveState("idle"); setLoaded(true);
    })();
    return ()=>{cancelled=true;};
  // eslint-disable-next-line
  },[year]);

  useEffect(()=>{
    if(!loaded||!fin||!dirtyRef.current) return;
    setSaveState("saving");
    const t=setTimeout(async()=>{
      try{ const resp=await api.saveFinanceData(year, fin, verRef.current); verRef.current=(resp&&resp.version)||verRef.current+1; dirtyRef.current=false; setSaveState("saved"); }
      catch(e){ setSaveState("error"); console.warn("finance save failed",e); }
    },600);
    return ()=>clearTimeout(t);
  // eslint-disable-next-line
  },[fin,loaded,year]);

  const mutate = (fn)=>{ dirtyRef.current=true; setFin(p=>{ const n=JSON.parse(JSON.stringify(p)); fn(n); return n; }); };
  const cats = fin?.opex?.cats || [];
  const cellVal = (kind,cid,m)=> (fin?.opex?.[kind]?.[cid]?.[m]) ?? "";
  const setCell = (kind,cid,m,v)=> mutate(n=>{ if(!n.opex[kind][cid]) n.opex[kind][cid]={}; n.opex[kind][cid][m]=parseFloat(v)||0; });
  const catMonthTotal = (kind,cid)=> MONTHS.reduce((s,m)=>s+(Number(fin?.opex?.[kind]?.[cid]?.[m])||0),0);
  const opexColTotal = (kind,m)=> cats.reduce((s,c)=>s+(Number(fin?.opex?.[kind]?.[c.id]?.[m])||0),0);
  const opexGrand = (kind)=> cats.reduce((s,c)=>s+catMonthTotal(kind,c.id),0);

  const addCat = ()=>{ const l=newCat.trim(); if(!l) return; mutate(n=>n.opex.cats.push({id:uid(),label:l})); setNewCat(""); };
  const delCat = (id)=>{ if(!confirm("Διαγραφή κατηγορίας και των τιμών της;")) return; mutate(n=>{ n.opex.cats=n.opex.cats.filter(x=>x.id!==id); delete n.opex.budget[id]; delete n.opex.actual[id]; }); };
  const renameCat = (id,l)=> mutate(n=>{ const c=n.opex.cats.find(x=>x.id===id); if(c) c.label=l; });

  const addCapex = ()=>{ if(!cf.desc||!cf.amount) return; mutate(n=>n.capex.push({id:uid(),desc:cf.desc,cat:cf.cat,amount:parseFloat(cf.amount)||0,month:cf.month,life:parseInt(cf.life)||0,status:cf.status,po:cf.po})); setCf(x=>({...x,desc:"",amount:"",po:""})); };
  const editCapex = (id,k,v)=> mutate(n=>{ const it=n.capex.find(x=>x.id===id); if(it) it[k]=(k==="amount"||k==="life")?(parseFloat(v)||0):v; });
  const delCapex = (id)=> mutate(n=>{ n.capex=n.capex.filter(x=>x.id!==id); });

  const capexItems = fin?.capex || [];
  // Only capitalised assets depreciate & carry NBV — Planned/Approved aren't on the books yet.
  const onBooks = it => it && it.status !== "Planned" && it.status !== "Approved";
  const zeroDepr = { monthly: 0, perMonth: Object.fromEntries(MONTHS.map(m=>[m,0])), accumulated: 0, nbv: 0 };
  const deprRows = capexItems.map(it=>({it, d: onBooks(it) ? depreciation(it,MONTHS) : zeroDepr}));
  const totCapex = capexItems.reduce((s,i)=>s+(Number(i.amount)||0),0);
  const totDeprFY = deprRows.reduce((s,x)=>s+MONTHS.reduce((s2,m)=>s2+x.d.perMonth[m],0),0);
  const totNBV = deprRows.reduce((s,x)=>s+x.d.nbv,0);
  const totBudget = opexGrand("budget"), totActual = opexGrand("actual");

  const thS = {padding:"6px 8px",textAlign:"center",fontSize:10,fontWeight:700,color:"#fff",background:P.em,whiteSpace:"nowrap"};
  const inpS = {width:"100%",padding:"4px 5px",border:"1px solid "+P.bd,borderRadius:3,fontSize:11,textAlign:"right",background:P.ip,outline:"none",boxSizing:"border-box"};
  const saveLbl = saveState==="saving"?t("💾 Αποθήκευση…","💾 Saving…"):saveState==="saved"?t("✓ Αποθηκεύτηκε","✓ Saved"):saveState==="error"?t("⚠ Αποτυχία","⚠ Save failed"):"";

  return (
    <div style={{minHeight:"100vh",background:P.of,fontFamily:"Segoe UI,Tahoma,sans-serif"}}>
      <div style={{background:P.em,color:"#fff",padding:"14px 24px",display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:8}}>
        <div style={{display:"flex",alignItems:"center",gap:16}}>
          <span style={{fontWeight:800,fontSize:20,letterSpacing:1}}>CBRE</span>
          <button onClick={onBack} style={{background:"rgba(255,255,255,.2)",border:"none",color:"#fff",padding:"4px 12px",borderRadius:4,cursor:"pointer",fontSize:12}}>◀ {t("Πελάτες","Clients")}</button>
          <span style={{fontSize:14,fontWeight:600,borderLeft:"1px solid rgba(255,255,255,.3)",paddingLeft:12}}>💰 {t("OPEX / CAPEX — Εταιρεία","OPEX / CAPEX — Company")} ({year})</span>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:10,fontSize:13}}>
          <span style={{fontSize:11,opacity:.9,minWidth:78,textAlign:"right"}}>{saveLbl}</span>
          <LangToggle dark />
          <span style={{opacity:.7}}>{user.name}</span>
          <button onClick={onLogout} style={{background:"rgba(255,255,255,.15)",border:"none",color:"#fff",padding:"5px 14px",borderRadius:4,cursor:"pointer",fontSize:12}}>{t("Αποσύνδεση","Logout")}</button>
        </div>
      </div>

      <div style={{maxWidth:1400,margin:"0 auto",padding:"18px 24px"}}>
        {/* Year + sub-tabs */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,flexWrap:"wrap",gap:12}}>
          <div style={{display:"flex",gap:8}}>
            {YEARS.map(y=>(<button key={y} onClick={()=>setYear(y)} style={{padding:"6px 16px",border:year===y?"2px solid "+P.em:"1px solid "+P.bd,borderRadius:6,cursor:"pointer",fontSize:13,fontWeight:year===y?700:400,background:year===y?P.em:P.wh,color:year===y?"#fff":P.tx}}>{y}</button>))}
          </div>
          <div style={{display:"flex",gap:0,background:P.wh,borderRadius:8,border:"1px solid "+P.bd,padding:4}}>
            {[{v:"opex",l:"OPEX"},{v:"capex",l:"CAPEX"},{v:"summary",l:t("Σύνοψη","Summary")}].map(o=>(
              <button key={o.v} onClick={()=>setSub(o.v)} style={{background:sub===o.v?P.em:"transparent",color:sub===o.v?"#fff":P.tx,border:"none",padding:"7px 20px",borderRadius:6,cursor:"pointer",fontSize:13,fontWeight:600}}>{o.l}</button>
            ))}
          </div>
        </div>

        {!loaded && <div style={{padding:40,textAlign:"center",color:P.tm}}>{t("Φόρτωση…","Loading…")}</div>}

        {/* ── OPEX ── */}
        {loaded && sub==="opex" && (
          <div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10,flexWrap:"wrap",gap:10}}>
              <div style={{display:"flex",gap:0,background:P.wh,borderRadius:8,border:"1px solid "+P.bd,padding:3}}>
                {[{v:"actual",l:t("Πραγματικά","Actual")},{v:"budget",l:t("Προϋπολογισμός","Budget")},{v:"variance",l:t("Απόκλιση","Variance")}].map(o=>(
                  <button key={o.v} onClick={()=>setOpexView(o.v)} style={{background:opexView===o.v?"#00897B":"transparent",color:opexView===o.v?"#fff":P.tx,border:"none",padding:"6px 16px",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:600}}>{o.l}</button>
                ))}
              </div>
              <div style={{display:"flex",gap:8,alignItems:"center"}}>
                <input value={newCat} onChange={e=>setNewCat(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addCat()} placeholder={t("Νέα κατηγορία…","New category…")} style={{padding:"6px 10px",border:"1px solid "+P.bd,borderRadius:6,fontSize:12,outline:"none"}} />
                <button onClick={addCat} style={{background:P.em,color:"#fff",border:"none",padding:"6px 14px",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:600}}>+ {t("Κατηγορία","Category")}</button>
              </div>
            </div>
            <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,overflowX:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse",tableLayout:"fixed",minWidth:1150}}>
                <colgroup><col style={{width:170}} />{MONTHS.map(m=><col key={m} style={{width:72}} />)}<col style={{width:95}} /><col style={{width:34}} /></colgroup>
                <thead><tr>
                  <th style={{...thS,textAlign:"left",borderRight:"2px solid #00695C"}}>{t("Κατηγορία","Category")}</th>
                  {MONTHS.map(m=><th key={m} style={thS}>{monthLabel(m)}</th>)}
                  <th style={{...thS,background:"#00695C"}}>{t("Σύνολο","Total")}</th><th style={thS}></th>
                </tr></thead>
                <tbody>
                  {cats.map((c,i)=>(
                    <tr key={c.id} style={{background:i%2===0?P.wh:P.al}}>
                      <td style={{padding:"3px 6px",borderBottom:"1px solid "+P.bd,borderRight:"2px solid "+P.bd}}>
                        <input value={c.label} onChange={e=>renameCat(c.id,e.target.value)} style={{width:"100%",border:"none",background:"transparent",fontSize:12,fontWeight:500,outline:"none"}} />
                      </td>
                      {MONTHS.map(m=>{
                        if(opexView==="variance"){ const v=(Number(cellVal("actual",c.id,m))||0)-(Number(cellVal("budget",c.id,m))||0); return <td key={m} style={{padding:"5px 6px",borderBottom:"1px solid "+P.bd,textAlign:"right",fontSize:11,fontWeight:v?600:400,color:v>0?P.rd:v<0?P.gn:P.tm}}>{v?fmt(v):"-"}</td>; }
                        return <td key={m} style={{padding:"3px 4px",borderBottom:"1px solid "+P.bd}}><input type="number" step="0.01" value={cellVal(opexView,c.id,m)} onChange={e=>setCell(opexView,c.id,m,e.target.value)} style={inpS} /></td>;
                      })}
                      <td style={{padding:"5px 8px",textAlign:"right",fontSize:12,fontWeight:700,color:P.em,borderBottom:"1px solid "+P.bd,background:"#f5f5f5",borderLeft:"2px solid "+P.bd}}>
                        {opexView==="variance"?fmt(catMonthTotal("actual",c.id)-catMonthTotal("budget",c.id)):fmt(catMonthTotal(opexView,c.id))}
                      </td>
                      <td style={{textAlign:"center",borderBottom:"1px solid "+P.bd}}><button onClick={()=>delCat(c.id)} style={{background:"none",border:"none",color:P.rd,cursor:"pointer",fontSize:14}}>×</button></td>
                    </tr>
                  ))}
                  <tr style={{background:P.ep}}>
                    <td style={{padding:"8px 8px",fontSize:12,fontWeight:700,borderRight:"2px solid #00695C"}}>{t("ΣΥΝΟΛΟ","TOTAL")} {opexView==="variance"?"(Act−Bud)":opexView}</td>
                    {MONTHS.map(m=>{ const v=opexView==="variance"?(opexColTotal("actual",m)-opexColTotal("budget",m)):opexColTotal(opexView,m); return <td key={m} style={{padding:"6px 6px",textAlign:"right",fontSize:11,fontWeight:700,color:opexView==="variance"&&v>0?P.rd:P.em}}>{fmt(v)}</td>; })}
                    <td style={{padding:"6px 8px",textAlign:"right",fontSize:12,fontWeight:700,color:P.em,background:"#C8E6C9",borderLeft:"2px solid #00695C"}}>{fmt(opexView==="variance"?(totActual-totBudget):opexGrand(opexView))}</td>
                    <td style={{background:P.ep}}></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div style={{fontSize:11,color:P.tm,marginTop:8}}>{t("Απόκλιση = Πραγματικά − Προϋπολογισμός (κόκκινο = υπέρβαση). Οι αλλαγές αποθηκεύονται αυτόματα.","Variance = Actual − Budget (red = over budget). Changes save automatically.")}</div>
          </div>
        )}

        {/* ── CAPEX ── */}
        {loaded && sub==="capex" && (
          <div>
            <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,padding:14,marginBottom:16,display:"flex",flexWrap:"wrap",gap:8,alignItems:"end"}}>
              <Inp l={t("Περιγραφή","Description")} v={cf.desc} set={v=>setCf(x=>({...x,desc:v}))} w={180} />
              <Sel l={t("Κατηγορία","Category")} v={cf.cat} set={v=>setCf(x=>({...x,cat:v}))} opts={CAPEX_CATS.map(c=>({v:c,l:c}))} w={160} />
              <Inp l={t("Αξία €","Value €")} v={cf.amount} set={v=>setCf(x=>({...x,amount:v}))} w={100} t="number" />
              <Sel l={t("Μήνας κτήσης","Acq. month")} v={cf.month} set={v=>setCf(x=>({...x,month:v}))} opts={MONTHS.map(m=>({v:m,l:monthLabel(m)}))} w={110} />
              <Inp l={t("Ωφ. ζωή (μήνες)","Useful life (mo)")} v={cf.life} set={v=>setCf(x=>({...x,life:v}))} w={110} t="number" />
              <Sel l="Status" v={cf.status} set={v=>setCf(x=>({...x,status:v}))} opts={CAPEX_STATUS.map(s=>({v:s.v,l:s.v}))} w={120} />
              <Inp l="PO No" v={cf.po} set={v=>setCf(x=>({...x,po:v}))} w={90} />
              <button onClick={addCapex} style={{background:P.em,color:"#fff",border:"none",padding:"7px 18px",borderRadius:6,cursor:"pointer",fontSize:13,fontWeight:600}}>+ {t("Πάγιο","Asset")}</button>
            </div>
            <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,overflowX:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:12,minWidth:1000}}>
                <thead><tr>{[[t("Περιγραφή","Description"),0],[t("Κατηγορία","Category"),0],[t("Αξία €","Value €"),1],[t("Κτήση","Acq."),0],[t("Ωφ.ζωή","Life"),0],[t("Μην. απόσβ.","Mo. depr."),1],[t("Σωρευ. απόσβ.","Accum. depr."),1],["NBV €",1],["Status",0],["PO",0],["",0]].map(([h,r],i)=>(
                  <th key={i} style={{padding:"8px 10px",fontSize:11,fontWeight:700,color:"#fff",background:P.em,textAlign:r?"right":"left"}}>{h}</th>
                ))}</tr></thead>
                <tbody>
                  {deprRows.map(({it,d},i)=>(
                    <tr key={it.id} style={{background:i%2===0?P.wh:P.al}}>
                      <td style={{padding:"5px 8px",borderBottom:"1px solid "+P.bd}}><input value={it.desc} onChange={e=>editCapex(it.id,"desc",e.target.value)} style={{width:"100%",border:"none",background:"transparent",fontSize:12,outline:"none"}} /></td>
                      <td style={{padding:"5px 8px",borderBottom:"1px solid "+P.bd,color:P.tm}}>{it.cat}</td>
                      <td style={{padding:"3px 6px",borderBottom:"1px solid "+P.bd,textAlign:"right"}}><input type="number" value={it.amount} onChange={e=>editCapex(it.id,"amount",e.target.value)} style={{...inpS,width:90}} /></td>
                      <td style={{padding:"5px 8px",borderBottom:"1px solid "+P.bd}}>{monthLabel(it.month)}</td>
                      <td style={{padding:"3px 6px",borderBottom:"1px solid "+P.bd,textAlign:"right"}}><input type="number" value={it.life} onChange={e=>editCapex(it.id,"life",e.target.value)} style={{...inpS,width:60}} /></td>
                      <td style={{padding:"5px 8px",borderBottom:"1px solid "+P.bd,textAlign:"right",color:P.tm}}>{fmt(d.monthly)}</td>
                      <td style={{padding:"5px 8px",borderBottom:"1px solid "+P.bd,textAlign:"right",color:P.tm}}>{fmt(d.accumulated)}</td>
                      <td style={{padding:"5px 8px",borderBottom:"1px solid "+P.bd,textAlign:"right",fontWeight:600,color:P.em}}>{fmt(d.nbv)}</td>
                      <td style={{padding:"5px 8px",borderBottom:"1px solid "+P.bd}}>
                        <select value={it.status} onChange={e=>editCapex(it.id,"status",e.target.value)} style={{border:"1px solid "+P.bd,borderRadius:10,fontSize:10,fontWeight:700,padding:"2px 6px",color:"#fff",background:(CAPEX_STATUS.find(s=>s.v===it.status)||{}).c||P.tm,outline:"none"}}>
                          {CAPEX_STATUS.map(s=><option key={s.v} value={s.v} style={{color:"#000",background:"#fff"}}>{s.v}</option>)}
                        </select>
                      </td>
                      <td style={{padding:"5px 8px",borderBottom:"1px solid "+P.bd,color:P.tm}}>{it.po||"—"}</td>
                      <td style={{padding:"5px 8px",borderBottom:"1px solid "+P.bd,textAlign:"center"}}><button onClick={()=>delCapex(it.id)} style={{background:"none",border:"none",color:P.rd,cursor:"pointer",fontSize:14}}>×</button></td>
                    </tr>
                  ))}
                  {!capexItems.length && <tr><td colSpan={11} style={{padding:24,textAlign:"center",color:P.tm,fontStyle:"italic"}}>{t("Κανένα πάγιο ακόμη — πρόσθεσε από πάνω","No assets yet — add one above")}</td></tr>}
                  {capexItems.length>0 && (
                    <tr style={{background:P.ep}}>
                      <td colSpan={2} style={{padding:"8px 10px",fontWeight:700}}>{t("ΣΥΝΟΛΑ","TOTALS")}</td>
                      <td style={{padding:"8px 8px",textAlign:"right",fontWeight:700,color:P.em}}>{fmt(totCapex)}</td>
                      <td colSpan={2}></td>
                      <td style={{padding:"8px 8px",textAlign:"right",fontWeight:700,color:P.tm}} title={t("Συνολική απόσβεση εντός FY","Total depreciation within FY")}>{fmt(totDeprFY)}</td>
                      <td></td>
                      <td style={{padding:"8px 8px",textAlign:"right",fontWeight:700,color:P.em}}>{fmt(totNBV)}</td>
                      <td colSpan={3}></td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div style={{fontSize:11,color:P.tm,marginTop:8}}>{t("Απόσβεση: σταθερή (straight-line) = Αξία ÷ ωφέλιμη ζωή. «Σωρευ. απόσβ.» & «NBV» υπολογίζονται μέχρι το τέλος του ","Depreciation: straight-line = Value ÷ useful life. 'Accum. depr.' & 'NBV' are computed to the end of ")}{year}. {t("Μόνο πάγια σε κατάσταση εκτός «Planned»/«Approved» αποσβένονται (τα υπόλοιπα δεν είναι ακόμη στα βιβλία).","Only assets not in 'Planned'/'Approved' status depreciate (the rest aren't on the books yet).")}</div>
          </div>
        )}

        {/* ── SUMMARY ── */}
        {loaded && sub==="summary" && (
          <div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(210px,1fr))",gap:14,marginBottom:20}}>
              {[
                {l:t("OPEX Προϋπολογισμός","OPEX Budget"),v:totBudget,c:P.em},
                {l:t("OPEX Πραγματικά","OPEX Actual"),v:totActual,c:P.tx},
                {l:t("OPEX Απόκλιση","OPEX Variance"),v:totActual-totBudget,c:(totActual-totBudget)>0?P.rd:P.gn,sign:true},
                {l:t("CAPEX Επένδυση","CAPEX Investment"),v:totCapex,c:P.em},
                {l:t("Απόσβεση ","Depreciation ")+year,v:totDeprFY,c:"#F57F17"},
                {l:t("Αναπόσβεστη Αξία","Net Book Value"),v:totNBV,c:P.gn},
              ].map(k=>(
                <div key={k.l} style={{background:P.wh,border:"1px solid "+P.bd,borderRadius:10,padding:"16px 18px",boxShadow:"0 1px 2px rgba(0,0,0,.04)"}}>
                  <div style={{fontSize:12,color:P.tm}}>{k.l}</div>
                  <div style={{fontSize:24,fontWeight:800,color:k.c,marginTop:6}}>€{fmt(k.v)}</div>
                </div>
              ))}
            </div>
            <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,padding:16}}>
              <div style={{fontSize:13,fontWeight:700,color:P.em,marginBottom:10}}>{t("OPEX — Προϋπολογισμός vs Πραγματικά ανά κατηγορία","OPEX — Budget vs Actual by category")} ({year})</div>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                <thead><tr>{[t("Κατηγορία","Category"),t("Προϋπ. €","Budget €"),t("Πραγμ. €","Actual €"),t("Απόκλιση €","Variance €"),"%"].map((h,i)=>(<th key={i} style={{padding:"7px 10px",fontSize:11,fontWeight:700,color:"#fff",background:P.em,textAlign:i===0?"left":"right"}}>{h}</th>))}</tr></thead>
                <tbody>
                  {cats.map((c,i)=>{ const b=catMonthTotal("budget",c.id),a=catMonthTotal("actual",c.id),v=a-b; return (
                    <tr key={c.id} style={{background:i%2===0?P.wh:P.al}}>
                      <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,fontWeight:500}}>{c.label}</td>
                      <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,textAlign:"right"}}>{fmt(b)}</td>
                      <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,textAlign:"right"}}>{fmt(a)}</td>
                      <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,textAlign:"right",fontWeight:600,color:v>0?P.rd:v<0?P.gn:P.tm}}>{fmt(v)}</td>
                      <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,textAlign:"right",color:P.tm}}>{b?fPct(v/b):"-"}</td>
                    </tr>
                  ); })}
                  <tr style={{background:P.ep,fontWeight:700}}>
                    <td style={{padding:"8px 10px"}}>{t("ΣΥΝΟΛΟ","TOTAL")}</td>
                    <td style={{padding:"8px 10px",textAlign:"right"}}>{fmt(totBudget)}</td>
                    <td style={{padding:"8px 10px",textAlign:"right"}}>{fmt(totActual)}</td>
                    <td style={{padding:"8px 10px",textAlign:"right",color:(totActual-totBudget)>0?P.rd:P.gn}}>{fmt(totActual-totBudget)}</td>
                    <td style={{padding:"8px 10px",textAlign:"right"}}>{totBudget?fPct((totActual-totBudget)/totBudget):"-"}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

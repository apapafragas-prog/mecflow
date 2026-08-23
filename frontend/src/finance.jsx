// Company-wide finance screens (finance/admin roles), extracted from App.jsx.
//   Dashboard  — consolidated portfolio dashboard across all clients for the year.
//   ApArLedger — AP/AR ledger + aging (receivables from clients, payables to subs).
//   OpexCapex  — company OPEX budget-vs-actual + CAPEX register with depreciation.
import { useState, useEffect, useRef } from "react";
import { api } from "./api.js";
import { P, MONTHS, ML, YEARS, uid, fmt, fPct, DEFAULT_OPEX_CATS, CAPEX_CATS, CAPEX_STATUS, normalizeClientData, REV_CATS, COST_CATS } from "./constants.js";
import { agingBucket, AGING_BUCKETS, depreciation, daysUntil, parseDate, runRateFY, clientRisks, detectAnomalies } from "./calc.js";
import { exportWorkbook } from "./exportXlsx.js";

// Previous fiscal-year label ("FY26" → "FY25"), or null if it falls before the first tracked year.
const prevFy = (y) => { const n = parseInt(String(y).replace(/\D/g, ""), 10); const p = `FY${n - 1}`; return YEARS.includes(p) ? p : null; };

// Bilingual label + icon for each anomaly type from detectAnomalies (which returns neutral types).
const ANOM_LABEL = {
  duplicate: { el: "Πιθανό διπλό τιμολόγιο", en: "Possible duplicate invoice", icon: "📄" },
  loss: { el: "Ζημιογόνος μήνας", en: "Loss-making month", icon: "🔻" },
  rev_drop: { el: "Πτώση εσόδων", en: "Revenue drop", icon: "📉" },
  rev_spike: { el: "Άνοδος εσόδων — έλεγξε", en: "Revenue spike — review", icon: "📈" },
  cost_spike: { el: "Απότομη αύξηση κόστους", en: "Cost spike", icon: "💸" },
  gap: { el: "Κενός μήνας (πιθανόν λείπουν δεδομένα)", en: "Missing month (data may be un-entered)", icon: "🕳️" },
};
const ANOM_COLOR = { high: "#C62828", med: "#F57F17", low: "#78909C" };

// getYearData returns RAW stored blobs; heal each client's months/keys onto the active FY (same as
// the per-client screens) so the finance aggregates match the client P&L and are self-consistent.
const normYear = (d) => Object.fromEntries(Object.entries(d || {}).map(([c, cd]) => [c, normalizeClientData(cd)]));
import { Inp, Sel, Skeleton, AppHeader } from "./ui.jsx";
import { AiCard } from "./insights.jsx";
import { useT, monthLabel } from "./i18n.jsx";

// Consolidated portfolio dashboard (finance/admin + ops for their own clients).
// Loads ALL clients' data for the year at once via getYearData — so totals are real,
// not just the clients visited this session.
export function Dashboard({year,setYear,user,onBack,onLogout,onSelectClient}) {
  const { t } = useT();
  const [data,setData] = useState(null);
  const [prevData,setPrevData] = useState(null);   // previous FY, for YoY deltas on the KPIs
  const [loading,setLoading] = useState(true);

  useEffect(()=>{
    let cancelled=false; setLoading(true); setPrevData(null);
    api.getYearData(year).then(d=>{ if(!cancelled){ setData(normYear(d)); setLoading(false); } }).catch(()=>{ if(!cancelled){ setData({}); setLoading(false); } });
    const py = prevFy(year);
    if(py) api.getYearData(py).then(d=>{ if(!cancelled) setPrevData(d||{}); }).catch(()=>{ if(!cancelled) setPrevData({}); });
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
  // All active clients, highest → lowest GM. Loss-makers (negative GM) are the ones finance most
  // needs to see, so we show the full list (scrollable) rather than truncating them off the bottom.
  const byGM = [...active].sort((a,b)=>b.gm-a.gm);
  const lossMakers = byGM.filter(r=>r.gm<0).length;

  // Previous-FY totals (amounts are month-independent, so no normalization needed) for YoY deltas.
  const prevTot = prevData ? Object.values(prevData).reduce((acc,cd)=>{
    (cd?.inv||[]).forEach(i=>acc.rev+=Number(i.amt)||0);
    (cd?.sub||[]).forEach(i=>acc.cost+=Number(i.amt)||0);
    Object.values(cd?.lab||{}).forEach(mo=>Object.values(mo||{}).forEach(v=>acc.lab+=Number(v)||0));
    return acc;
  },{rev:0,cost:0,lab:0}) : null;
  const prevGM = prevTot ? prevTot.rev-prevTot.cost-prevTot.lab : null;
  // % change vs prior year; null when there's no comparable base (no prev data or prev was 0).
  const yoy = (cur,prev)=> (prev==null||!isFinite(prev)||prev===0) ? null : (cur-prev)/Math.abs(prev);

  const exportDashboard = () => {
    const clientsAoa = [["#","Client","Revenue","Cost","Labour","GM","GM %","Invoices","Subs","Status"],
      ...byGM.map((r,i)=>[i+1,r.name,r.rev,r.cost,r.labour,r.gm,r.rev?+(r.gm/r.rev*100).toFixed(1):"",r.inv,r.sub,r.status])];
    const monthlyAoa = [["Month","Revenue","Cost","Labour","GM"],
      ...monthly.map(x=>[ML[x.m]||x.m,x.rev,x.cost,x.labour,x.gm]),
      ["TOTAL",totRev,totCost,totLab,totGM]];
    exportWorkbook(`CBRE_Dashboard_${year}.xlsx`, [{name:"Clients",aoa:clientsAoa},{name:"Monthly",aoa:monthlyAoa}]);
  };

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

  // AI-assisted anomaly feed across the whole portfolio (deterministic detection, severity-ranked).
  const anomalies = detectAnomalies(data, MONTHS);
  const anomHigh = anomalies.filter(a=>a.level==="high").length;

  // Data-quality guard (parity with Group P&L): rows with a non-canonical category count in these
  // portfolio KPIs but are dropped from the per-client P&L, so the numbers can silently disagree.
  let miscatTotal = 0;
  Object.values(data||{}).forEach(cd=>{
    (cd?.inv||[]).forEach(i=>{ if((Number(i.amt)||0)!==0 && !REV_CATS.includes(i.cat)) miscatTotal++; });
    (cd?.sub||[]).forEach(i=>{ if((Number(i.amt)||0)!==0 && !COST_CATS.includes(i.cat)) miscatTotal++; });
  });

  // Small YoY badge — green ▲ when the metric improved vs prior FY, red ▼ when it worsened.
  const yoyBadge = (d)=> d==null ? null : (
    <span style={{fontSize:11,fontWeight:700,color:d>=0?P.gn:P.rd,marginLeft:6}} title={t("έναντι προηγ. έτους","vs prior year")}>
      {d>=0?"▲":"▼"} {Math.abs(d*100).toFixed(0)}%
    </span>
  );
  const kpi = (l,v,c,pct,delta)=>(
    <div style={{background:P.wh,border:"1px solid "+P.bd,borderRadius:14,padding:"15px 16px",boxShadow:P.sh}}>
      <div style={{fontSize:12,color:P.tm}}>{l}</div>
      <div style={{fontSize:22,fontWeight:800,color:c,marginTop:5}}>{pct?fPct(v):"€"+fmt(v)}{delta!==undefined&&yoyBadge(delta)}</div>
    </div>
  );

  return (
    <div style={{minHeight:"100vh",background:P.of,fontFamily:"Segoe UI,Tahoma,sans-serif"}}>
      <AppHeader user={user} onLogout={onLogout} onBack={onBack} title={`📊 ${t("Dashboard Χαρτοφυλακίου","Portfolio Dashboard")} — ${year}`} />

      <div style={{maxWidth:1300,margin:"0 auto",padding:"18px clamp(12px,4vw,24px)"}}>
        <div style={{display:"flex",gap:8,marginBottom:16,justifyContent:"space-between",alignItems:"center",flexWrap:"wrap"}}>
          <div style={{display:"flex",gap:8}}>
            {YEARS.map(y=>(<button key={y} onClick={()=>setYear(y)} style={{padding:"6px 16px",border:year===y?"2px solid "+P.em:"1px solid "+P.bd,borderRadius:6,cursor:"pointer",fontSize:13,fontWeight:year===y?700:400,background:year===y?P.em:P.wh,color:year===y?"#fff":P.tx}}>{y}</button>))}
          </div>
          {!loading && <button onClick={exportDashboard} style={{padding:"6px 14px",border:"1px solid "+P.em,borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:600,background:P.wh,color:P.em}}>⬇ {t("Εξαγωγή Excel","Export Excel")}</button>}
        </div>

        {loading ? <Skeleton kpis={6} rows={6} /> : (
        <>
          {/* Hero consolidated-revenue card + KPI cards */}
          <div style={{display:"flex",gap:16,flexWrap:"wrap",marginBottom:20}}>
            <div style={{flex:"1 1 250px",minWidth:250,background:"linear-gradient(150deg,#014A34 0%,#003F2D 55%,#012A2D 100%)",color:"#EAF6EF",borderRadius:16,padding:"20px 22px",position:"relative",overflow:"hidden",boxShadow:P.sh}}>
              <div style={{fontFamily:"'Space Mono',ui-monospace,monospace",fontSize:9.5,letterSpacing:".12em",textTransform:"uppercase",color:"#9FD9C4"}}>{t("Ενοποιημένα Έσοδα · FY","Consolidated Revenue · FY")} {year}</div>
              <div style={{fontSize:32,fontWeight:700,margin:"12px 0 3px",letterSpacing:"-.02em",lineHeight:1}}>€{fmt(totRev)}{prevTot&&yoy(totRev,prevTot.rev)!=null&&<span style={{fontSize:13,fontWeight:700,marginLeft:8,color:yoy(totRev,prevTot.rev)>=0?"#7EE8B4":"#F3A6A5"}}>{yoy(totRev,prevTot.rev)>=0?"▲":"▼"} {Math.abs(yoy(totRev,prevTot.rev)*100).toFixed(0)}%</span>}</div>
              <div style={{fontSize:12,color:"#AEE9CF"}}>{active.length}/{rows.length} {t("ενεργοί πελάτες","active clients")} · {t("Μικτό","GM")} {fPct(totRev?totGM/totRev:null)}</div>
              <svg viewBox="0 0 300 40" preserveAspectRatio="none" style={{position:"absolute",left:0,right:0,bottom:0,width:"100%",height:38,opacity:.55}}><path d="M0 28 Q40 8 80 22 T160 18 T240 24 T300 12 V40 H0 Z" fill="rgba(23,232,143,.18)"/><path d="M0 28 Q40 8 80 22 T160 18 T240 24 T300 12" fill="none" stroke="rgba(23,232,143,.55)" strokeWidth="1.5"/></svg>
            </div>
            <div style={{flex:"3 1 440px",display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(150px,1fr))",gap:12}}>
              {kpi(t("Συνολικά Έσοδα","Total Revenue"),totRev,P.gn,false,prevTot?yoy(totRev,prevTot.rev):undefined)}
              {kpi(t("Συνολικό Κόστος (υπεργ.)","Total Cost (sub)"),totCost,P.tx,false,prevTot?(()=>{const d=yoy(totCost,prevTot.cost);return d==null?null:-d;})():undefined)}
              {kpi(t("Εργασία","Labour"),totLab,P.tx,false,prevTot?(()=>{const d=yoy(totLab,prevTot.lab);return d==null?null:-d;})():undefined)}
              {kpi(t("Μικτό Περιθώριο","Gross Margin"),totGM,totGM>=0?P.gn:P.rd,false,prevTot?yoy(totGM,prevGM):undefined)}
              {kpi("GM %",totRev?totGM/totRev:null,P.em,true)}
              <div style={{background:P.wh,border:"1px solid "+P.bd,borderRadius:14,padding:"15px 16px",boxShadow:P.sh}}>
                <div style={{fontSize:12,color:P.tm}}>{t("Ενεργοί πελάτες","Active clients")}</div>
                <div style={{fontSize:22,fontWeight:800,color:P.em,marginTop:5}}>{active.length}<span style={{fontSize:13,color:P.tm,fontWeight:400}}> / {rows.length}</span></div>
              </div>
            </div>
          </div>

          {miscatTotal>0 && (
            <div style={{background:"#FFF8E1",border:"1px solid #F5D76E",borderRadius:8,padding:"10px 16px",marginBottom:16,fontSize:12,color:"#7A5B00"}}>
              ⚠️ {miscatTotal} {t("γραμμές με μη-κανονική κατηγορία μετρούν σε αυτά τα σύνολα αλλά ΟΧΙ στο P&L του κάθε πελάτη — τα νούμερα μπορεί να διαφέρουν. Διόρθωσε την κατηγορία τους.","rows with a non-canonical category count in these totals but NOT in each client's P&L — the numbers may disagree. Fix their category.")}
            </div>
          )}

          {/* 🔔 AI Anomaly Alerts — portfolio-wide, severity-ranked, click a row to open the client */}
          {anomalies.length>0 && (
            <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,boxShadow:P.sh,marginBottom:16,overflow:"hidden"}}>
              <div style={{padding:"10px 16px",borderBottom:"1px solid "+P.bd,display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}>
                <div style={{fontSize:13,fontWeight:700,color:P.em}}>🔔 {t("Ειδοποιήσεις — ανωμαλίες δεδομένων","Alerts — data anomalies")} ({anomalies.length})</div>
                {anomHigh>0 && <div style={{fontSize:11,fontWeight:700,color:P.rd}}>⚠️ {anomHigh} {t("υψηλής προτεραιότητας","high priority")}</div>}
              </div>
              <div style={{maxHeight:300,overflowY:"auto"}}>
                {anomalies.slice(0,40).map((a,i)=>{ const L=ANOM_LABEL[a.type]||{el:a.type,en:a.type,icon:"•"}; return (
                  <div key={i} onClick={()=>onSelectClient&&onSelectClient(a.client)} style={{display:"flex",alignItems:"center",gap:10,padding:"7px 16px",borderBottom:"1px solid "+P.al,cursor:"pointer",fontSize:12}}>
                    <span style={{width:8,height:8,borderRadius:"50%",background:ANOM_COLOR[a.level],flexShrink:0}} />
                    <span style={{flexShrink:0}}>{L.icon}</span>
                    <span style={{fontWeight:600,color:P.em,minWidth:130,flexShrink:0}}>{a.client}</span>
                    <span style={{color:P.tx,flex:1}}>{t(L.el,L.en)}{a.month?` · ${monthLabel(a.month)}`:""}</span>
                    {a.detail && <span style={{color:P.tm,fontSize:11,whiteSpace:"nowrap"}}>{a.detail}</span>}
                  </div>
                ); })}
                {anomalies.length>40 && <div style={{padding:"7px 16px",fontSize:11,color:P.tm,fontStyle:"italic"}}>… +{anomalies.length-40} {t("ακόμα","more")}</div>}
              </div>
            </div>
          )}

          <div style={{display:"grid",gridTemplateColumns:"1fr",gap:16,alignItems:"start"}}>
            {/* Monthly trend — vertical bar chart (revenue) with per-month GM + a GM trend line */}
            <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,boxShadow:P.sh,padding:16}}>
              <div style={{fontSize:13,fontWeight:700,color:P.em,marginBottom:6}}>{t("Μηνιαία τάση — Έσοδα / GM","Monthly trend — Revenue / GM")}</div>
              {(()=>{
                const W=720,H=250,base=200,top=14,plot=base-top,x0=16,slot=(W-2*x0)/12,barW=Math.min(34,slot-14);
                const peak=monthly.reduce((mi,x,i,a)=>x.rev>a[mi].rev?i:mi,0);
                const cx=i=>x0+i*slot+slot/2;
                const gmMax=Math.max(1,...monthly.map(x=>Math.abs(x.gm)));
                const gmY=v=>base-(v/gmMax)*plot*0.9;   // GM line on its own scale, sharing the baseline
                const pts=monthly.map((x,i)=>`${cx(i)},${Math.max(top-6,Math.min(base,gmY(x.gm)))}`).join(" ");
                return (
                  <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",height:"auto",display:"block"}}>
                    <text x={x0} y={top-2} style={{fontSize:11,fill:P.tm}}>€{fmt(maxRev)}</text>
                    {[0.25,0.5,0.75,1].map(f=><line key={f} x1={x0} y1={base-f*plot} x2={W-x0} y2={base-f*plot} stroke={P.bd} strokeWidth="1"/>)}
                    <line x1={x0} y1={base} x2={W-x0} y2={base} stroke={P.tm} strokeWidth="1"/>
                    {monthly.map((x,i)=>{ const h=maxRev>0?(x.rev/maxRev)*plot:0; return (
                      <g key={x.m}>
                        <rect x={cx(i)-barW/2} y={base-h} width={barW} height={h} rx="6" fill={i===peak&&maxRev>0?P.em:"#80BBAD"}>
                          <title>{`${monthLabel(x.m)} · ${t("Έσοδα","Revenue")} €${fmt(x.rev)} · GM €${fmt(x.gm)}`}</title>
                        </rect>
                        <text x={cx(i)} y={base+16} textAnchor="middle" style={{fontSize:11,fill:i===peak?P.em:P.tm,fontWeight:i===peak?700:400}}>{monthLabel(x.m)}</text>
                        <text x={cx(i)} y={base+31} textAnchor="middle" style={{fontSize:10,fill:x.gm>=0?P.gn:P.rd,fontWeight:600}}>{fmt(x.gm)}</text>
                      </g>
                    ); })}
                    <polyline points={pts} fill="none" stroke={P.tx} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.75"/>
                    {monthly.map((x,i)=><circle key={x.m} cx={cx(i)} cy={Math.max(top-6,Math.min(base,gmY(x.gm)))} r="2.6" fill={P.tx}/>)}
                  </svg>
                );
              })()}
              <div style={{display:"flex",gap:16,marginTop:6,fontSize:10,color:P.tm}}>
                <span><span style={{display:"inline-block",width:10,height:10,background:"#80BBAD",borderRadius:2,verticalAlign:"middle",marginRight:4}} />{t("Έσοδα","Revenue")}</span>
                <span><span style={{display:"inline-block",width:10,height:10,background:P.em,borderRadius:2,verticalAlign:"middle",marginRight:4}} />{t("Κορυφή","Peak")}</span>
                <span><span style={{display:"inline-block",width:14,height:2,background:P.tx,verticalAlign:"middle",marginRight:4}} />{t("Γραμμή GM","GM line")}</span>
              </div>
            </div>
          </div>

          {/* Expiring contracts (next 90 days) across the portfolio */}
          {(()=>{
            const exp=[]; Object.entries(data||{}).forEach(([name,cd])=>{ (cd?.contracts||[]).forEach(c=>{ if(c.status==="Terminated"||c.status==="Expired") return; const dd=daysUntil(c.expiry); if(dd!=null&&dd<=90) exp.push({client:name,ref:c.ref,type:c.type,expiry:c.expiry,dd}); }); });
            exp.sort((a,b)=>a.dd-b.dd);
            if(!exp.length) return null;
            return (
              <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,boxShadow:P.sh,padding:16,marginTop:16}}>
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
              monthly: monthly.filter(x=>x.rev||x.cost).map(x=>({month:ML[x.m]||x.m, rev:Math.round(x.rev), cost:Math.round(x.cost), gm:Math.round(x.gm)})),
              clientsAtRisk: riskyClients.slice(0,10).map(c=>({client:c.name, risks:c.labels})),
              anomalies: anomalies.slice(0,20).map(a=>({client:a.client, type:a.type, month:a.month?(ML[a.month]||a.month):null, severity:a.level, detail:a.detail})),
            });
            return (
              <div style={{marginTop:16}}>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12,marginBottom:12}}>
                  <div style={{background:P.wh,border:"1px solid "+P.bd,borderRadius:14,padding:"15px 16px",boxShadow:P.sh}}><div style={{fontSize:12,color:P.tm}}>{t("Προβλ. Έσοδα έτους","Projected Revenue FY")}</div><div style={{fontSize:20,fontWeight:800,color:P.em,marginTop:5}}>€{fmt(rr.projected.rev)}</div></div>
                  <div style={{background:P.wh,border:"1px solid "+P.bd,borderRadius:14,padding:"15px 16px",boxShadow:P.sh}}><div style={{fontSize:12,color:P.tm}}>{t("Προβλ. GM έτους","Projected GM FY")}</div><div style={{fontSize:20,fontWeight:800,color:rr.projected.gm>=0?P.gn:P.rd,marginTop:5}}>€{fmt(rr.projected.gm)}</div></div>
                  <div style={{background:P.wh,border:"1px solid "+P.bd,borderRadius:14,padding:"15px 16px",boxShadow:P.sh}}><div style={{fontSize:12,color:P.tm}}>{t("Προβλ. GM%","Projected GM%")}</div><div style={{fontSize:20,fontWeight:800,color:P.em,marginTop:5}}>{fPct(projGmPct)}</div></div>
                </div>
                {riskyClients.length>0 && (
                  <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,boxShadow:P.sh,padding:16,marginBottom:12}}>
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

          {/* Clients by GM — all active, highest → lowest (loss-makers surfaced, not truncated) */}
          <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,boxShadow:P.sh,padding:16,marginTop:16}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10,flexWrap:"wrap",gap:8}}>
              <div style={{fontSize:13,fontWeight:700,color:P.em}}>{t("Πελάτες κατά GM (φθίνουσα)","Clients by GM (highest → lowest)")}</div>
              {lossMakers>0 && <div style={{fontSize:11,fontWeight:700,color:P.rd}}>⚠️ {lossMakers} {t("με αρνητικό GM","with negative GM")}</div>}
            </div>
            <div style={{maxHeight:360,overflowY:"auto"}}>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
              <thead><tr>{["#",t("Πελάτης","Client"),t("Έσοδα €","Revenue €"),t("Κόστος €","Cost €"),t("Εργασία €","Labour €"),"GM €","GM%"].map((h,i)=>(<th key={i} style={{padding:"6px 10px",fontSize:11,fontWeight:700,color:"#fff",background:P.em,textAlign:i>=2&&i<=6?"right":"left",position:"sticky",top:0,zIndex:1}}>{h}</th>))}</tr></thead>
              <tbody>{byGM.map((r,i)=>{ const loss=r.gm<0; return (
                <tr key={r.name} onClick={()=>onSelectClient&&onSelectClient(r.name)} style={{background:loss?"#FDECEA":i%2===0?P.wh:P.al,cursor:"pointer"}}>
                  <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,color:P.tm}}>{i+1}</td>
                  <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,fontWeight:600,color:P.em}}>{r.name}</td>
                  <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,textAlign:"right",color:P.gn}}>{fmt(r.rev)}</td>
                  <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,textAlign:"right"}}>{fmt(r.cost)}</td>
                  <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,textAlign:"right"}}>{fmt(r.labour)}</td>
                  <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,textAlign:"right",fontWeight:600,color:r.gm>=0?P.em:P.rd}}>{fmt(r.gm)}</td>
                  <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,textAlign:"right",color:P.tm}}>{r.rev?fPct(r.gm/r.rev):"-"}</td>
                </tr>
              ); })}</tbody>
            </table>
            </div>
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
  const [terms,setTerms] = useState(30);          // default payment terms in days (0 = from invoice date)
  const [showPaid,setShowPaid] = useState(false);
  const [busy,setBusy] = useState("");
  const [payDate,setPayDate] = useState(new Date().toISOString().slice(0,10)); // value date stamped when marking Paid
  const [payModal,setPayModal] = useState(null);  // {e, amount, date} — record-a-partial-payment dialog
  // Per-counterparty payment-term overrides (days). Persisted per user/view in localStorage so collections
  // teams can encode "Client X is Net 45" without touching the finance blob. Falls back to the global terms.
  const [cpTerms,setCpTerms] = useState(()=>{ try { return JSON.parse(localStorage.getItem("mf_apar_terms")||"{}"); } catch { return {}; } });
  // Namespace the override by view so a client and a supplier sharing a name don't collide across AR/AP.
  const termKey = cp => view+":"+cp;
  const setCpTerm = (cp,v) => setCpTerms(p=>{ const n={...p}; const k=termKey(cp); if(v===""||v==null){ delete n[k]; } else { n[k]=Number(v); } try{ localStorage.setItem("mf_apar_terms",JSON.stringify(n)); }catch{ /* ignore */ } return n; });
  const cpTerm = cp => cpTerms[termKey(cp)];
  const termsFor = cp => (cpTerm(cp)!=null && cpTerm(cp)!=="") ? Number(cpTerm(cp)) : terms;

  const load = () => { setLoading(true); api.getYearData(year).then(d=>{ setData(normYear(d)); setLoading(false); }).catch(()=>{ setData({}); setLoading(false); }); };
  useEffect(()=>{ load(); /* eslint-disable-next-line */ },[year]);

  const amt = r => Number(r.total) || (Number(r.amt)||0)+(Number(r.vat)||0) || Number(r.amt) || 0;
  // Settlement model: a row is "closed" when the paid flag is set (full settle); until then any recorded
  // partial payments accumulate and the open exposure is the remaining balance.
  const settleInfo = r => {
    const total = amt(r);
    const paidFlag = r.paid==="paid" || r.paid===true;
    const hasPaidDate = !!(r.paid_date && String(r.paid_date).trim());
    const pays = Array.isArray(r.payments) ? r.payments : [];
    const paySum = pays.reduce((s,p)=>s+(Number(p.amount)||0),0);
    // Fully closed only when the paid flag carries a settlement date (matching the balance sheet, which
    // keeps paid-without-date rows open) OR recorded payments cover the full amount. This keeps the ledger
    // and the balance sheet in agreement on legacy/imported "paid" rows that lack a date.
    const settled = (paidFlag && hasPaidDate) ? total : Math.min(paySum, total);
    return { total, settled, balance: Math.max(0, total-settled), paidFlag, paySum };
  };
  // Build ledger entries for the current view across all clients.
  const entries = [];
  Object.entries(data||{}).forEach(([client,cd])=>{
    const list = view==="AR" ? (cd?.inv||[]) : (cd?.sub||[]);
    const locked = cd?.locked || {};
    list.forEach(r=>{
      const cp = view==="AR" ? client : (r.supplier||"—");
      const si = settleInfo(r);
      const closed = si.balance <= 0.005;
      entries.push({ client, id:r.id, counterparty: cp, invNo:r.inv_no||"", date:r.date||"", amount:si.total, settled:si.settled, balance:si.balance, paid:closed, partial: si.settled>0.005 && !closed, bucket: agingBucket(r.date, termsFor(cp)), lockedMonth: !!(r.month && locked[r.month]) });
    });
  });
  const open = entries.filter(e=>!e.paid);
  const visible = (showPaid ? entries : open).slice().sort((a,b)=>(parseDate(b.date)?.getTime()||0)-(parseDate(a.date)?.getTime()||0));
  const totalOpen = open.reduce((s,e)=>s+e.balance,0);
  const overdue = open.filter(e=>e.bucket!=="current"&&e.bucket!=="unknown").reduce((s,e)=>s+e.balance,0);
  const bucketTotal = b => open.filter(e=>e.bucket===b).reduce((s,e)=>s+e.balance,0);
  // Per-counterparty aging (exposure = remaining balance)
  const byCp = {};
  open.forEach(e=>{ const k=e.counterparty; if(!byCp[k]) byCp[k]={cp:k,total:0,client:e.client}; byCp[k][e.bucket]=(byCp[k][e.bucket]||0)+e.balance; byCp[k].total+=e.balance; });
  const cpRows = Object.values(byCp).sort((a,b)=>b.total-a.total);
  // Undated open items age into no bucket; surface an explicit "Undated" column when any exist so the
  // per-counterparty bucket cells always reconcile to the row Total (and to the portfolio KPIs).
  const hasUnknown = open.some(e=>e.bucket==="unknown");
  const AGING_COLS = hasUnknown ? [...AGING_BUCKETS, "unknown"] : AGING_BUCKETS;
  const bucketLabel = b => b==="unknown" ? t("Χωρίς ημ/νία","Undated") : b==="current" ? t("Τρέχον","Current") : b;

  const exportLedger = () => {
    const cpLabel = view==="AR" ? "Client" : "Supplier";
    const agingAoa = [[cpLabel, ...AGING_COLS.map(b=>b==="unknown"?"Undated":b==="current"?"Current":b), "Total"],
      ...cpRows.map(r=>[r.cp, ...AGING_COLS.map(b=>r[b]||0), r.total]),
      ["TOTAL", ...AGING_COLS.map(b=>bucketTotal(b)), totalOpen]];
    // The item sheet always includes every document (paid + open) regardless of the on-screen filter,
    // so an exported ledger is a complete record; a Paid/Status column carries the state.
    const itemsAoa = [["Date",cpLabel,"Client","Invoice No","Amount","Settled","Balance","Aging","Status"],
      ...entries.slice().sort((a,b)=>(parseDate(b.date)?.getTime()||0)-(parseDate(a.date)?.getTime()||0))
        .map(e=>[e.date||"", e.counterparty, e.client, e.invNo, e.amount, e.settled, e.balance, e.bucket, e.paid?"Paid":e.partial?"Partial":"Open"])];
    exportWorkbook(`CBRE_${view}_Ledger_${year}.xlsx`, [{name:`Aging ${view}`,aoa:agingAoa},{name:"Items",aoa:itemsAoa}]);
  };

  // Generic optimistic-locked mutate of a single AR/AP document, then persist the normalized blob.
  const persistRow = async (e, mutate) => {
    const list = view==="AR" ? "inv" : "sub";
    setBusy(e.client+e.id);
    try {
      const r = await api.getClientData(year, e.client);
      const cd = r?.data; if(!cd || !Array.isArray(cd[list])) throw new Error(t("Δεν βρέθηκαν δεδομένα","No data found"));
      const row = cd[list].find(x=>x.id===e.id); if(!row) throw new Error(t("Δεν βρέθηκε το τιμολόγιο","Document not found"));
      // Respect the period lock: a closed month is read-only for everyone (unlock it first to post).
      if(row.month && cd.locked && cd.locked[row.month]) throw new Error(t("Ο μήνας είναι κλειδωμένος (κλεισμένη περίοδος).","This month is locked (closed period)."));
      mutate(row);
      // Normalize once and persist THAT (not the raw blob), so the server and local state agree on
      // month keys — matching what every other load path stores via normYear.
      const norm = normalizeClientData(cd);
      await api.saveClientData(year, e.client, norm, r.version);
      setData(p=>({ ...p, [e.client]: norm }));
    } catch(err){ alert(t("Δεν αποθηκεύτηκε: ","Not saved: ")+(err.message||t("σφάλμα","error"))); }
    finally{ setBusy(""); }
  };

  // Full settle / un-settle. Stamp the actual value date the user set (drives aging + the month the
  // invoice leaves AR/AP on the balance sheet). Falls back to today if cleared.
  const markPaid = (e) => persistRow(e, row => {
    const nowPaid = !(row.paid==="paid"||row.paid===true);
    row.paid = nowPaid ? "paid" : ""; row.paid_date = nowPaid ? (payDate || new Date().toISOString().slice(0,10)) : "";
    if(!nowPaid) row.payments = [];   // reopening clears the payment history
  });

  // Record a partial payment; auto-close the document once payments cover the full amount.
  const recordPayment = () => {
    const m = payModal; if(!m) return;
    const val = Number(m.amount)||0; if(val<=0){ setPayModal(null); return; }
    setPayModal(null);
    persistRow(m.e, row => {
      const pays = Array.isArray(row.payments) ? row.payments.slice() : [];
      pays.push({ date: m.date || new Date().toISOString().slice(0,10), amount: val });
      row.payments = pays;
      const total = amt(row);
      const paySum = pays.reduce((s,p)=>s+(Number(p.amount)||0),0);
      if(paySum >= total-0.005){ row.paid = "paid"; row.paid_date = m.date || new Date().toISOString().slice(0,10); }
    });
  };

  const bucketColor = {current:P.gn,"1-30":"#9E9D24","31-60":"#F57F17","61-90":"#EF6C00","90+":P.rd,unknown:P.tm};
  const termLabel = terms===0 ? t("από ημ/νία τιμολογίου","from invoice date") : `Net ${terms}`;

  return (
    <div style={{minHeight:"100vh",background:P.of,fontFamily:"Segoe UI,Tahoma,sans-serif"}}>
      <AppHeader user={user} onLogout={onLogout} onBack={onBack} title={`📒 ${t("Καθολικό AP / AR","AP / AR Ledger")} — ${year}`} />

      <div style={{maxWidth:1300,margin:"0 auto",padding:"18px clamp(12px,4vw,24px)"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,flexWrap:"wrap",gap:12}}>
          <div style={{display:"flex",gap:8,alignItems:"center"}}>
            {YEARS.map(y=>(<button key={y} onClick={()=>setYear(y)} style={{padding:"6px 14px",border:year===y?"2px solid "+P.em:"1px solid "+P.bd,borderRadius:6,cursor:"pointer",fontSize:13,fontWeight:year===y?700:400,background:year===y?P.em:P.wh,color:year===y?"#fff":P.tx}}>{y}</button>))}
          </div>
          <div style={{display:"flex",gap:0,background:P.wh,borderRadius:8,border:"1px solid "+P.bd,boxShadow:P.sh,padding:4}}>
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
          <label style={{fontSize:12,color:P.tm,display:"flex",alignItems:"center",gap:6,marginLeft:8}} title={t("Η ημερομηνία που θα καταχωρηθεί όταν πατάς «Πληρώθηκε»","The date stamped when you click 'Paid'")}>{t("Ημ/νία πληρωμής","Payment date")}: <input type="date" value={payDate} onChange={e=>setPayDate(e.target.value)} style={{padding:"4px 6px",border:"1px solid "+P.bd,borderRadius:6,fontSize:12,outline:"none"}} /></label>
          {!loading && <button onClick={exportLedger} style={{marginLeft:"auto",padding:"6px 14px",border:"1px solid "+P.em,borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:600,background:P.wh,color:P.em}}>⬇ {t("Εξαγωγή Excel","Export Excel")}</button>}
        </div>

        {loading ? <Skeleton kpis={6} rows={6} /> : (
        <>
          {/* Hero + aging donut */}
          <div style={{display:"flex",gap:16,flexWrap:"wrap",marginBottom:18}}>
            <div style={{flex:"1 1 250px",minWidth:250,background:"linear-gradient(150deg,#014A34 0%,#003F2D 55%,#012A2D 100%)",color:"#EAF6EF",borderRadius:16,padding:"20px 22px",position:"relative",overflow:"hidden",boxShadow:P.sh}}>
              <div style={{fontFamily:"'Space Mono',ui-monospace,monospace",fontSize:9.5,letterSpacing:".12em",textTransform:"uppercase",color:"#9FD9C4"}}>{view==="AR"?t("Εισπρακτέα · Ανοιχτά","Receivable · Open"):t("Πληρωτέα · Ανοιχτά","Payable · Open")}</div>
              <div style={{fontSize:32,fontWeight:700,margin:"12px 0 3px",letterSpacing:"-.02em",lineHeight:1}}>€{fmt(totalOpen)}</div>
              <div style={{fontSize:12,color:overdue>0?"#F3A6A5":"#AEE9CF"}}>{t("Ληξιπρόθεσμα","Overdue")} €{fmt(overdue)}{totalOpen?` · ${Math.round(overdue/totalOpen*100)}%`:""}</div>
              <svg viewBox="0 0 300 40" preserveAspectRatio="none" style={{position:"absolute",left:0,right:0,bottom:0,width:"100%",height:38,opacity:.55}}><path d="M0 28 Q40 8 80 22 T160 18 T240 24 T300 12 V40 H0 Z" fill="rgba(23,232,143,.18)"/><path d="M0 28 Q40 8 80 22 T160 18 T240 24 T300 12" fill="none" stroke="rgba(23,232,143,.55)" strokeWidth="1.5"/></svg>
            </div>
            <div style={{flex:"2 1 380px",background:P.wh,border:"1px solid "+P.bd,borderRadius:16,padding:"16px 18px",boxShadow:P.sh,display:"flex",gap:20,alignItems:"center",flexWrap:"wrap"}}>
              <div>
                <div style={{fontSize:13,fontWeight:700,color:P.em,marginBottom:8}}>{t("Κατανομή aging","Aging distribution")}</div>
                {(()=>{
                  const segs=AGING_COLS.map(b=>({b,v:bucketTotal(b)})).filter(s=>s.v>0);
                  const tot=segs.reduce((s,x)=>s+x.v,0); const C=2*Math.PI*52; let acc=0;
                  return (
                    <svg viewBox="0 0 140 140" width="128" height="128" style={{display:"block"}}>
                      <circle cx="70" cy="70" r="52" fill="none" stroke={P.al} strokeWidth="20"/>
                      {tot>0 && segs.map(s=>{ const seg=s.v/tot*C; const el=<circle key={s.b} cx="70" cy="70" r="52" fill="none" stroke={bucketColor[s.b]} strokeWidth="20" strokeDasharray={`${seg} ${C-seg}`} strokeDashoffset={-acc} transform="rotate(-90 70 70)"/>; acc+=seg; return el; })}
                      <text x="70" y="66" textAnchor="middle" style={{fontSize:15,fontWeight:800,fill:P.em}}>€{fmt(totalOpen)}</text>
                      <text x="70" y="84" textAnchor="middle" style={{fontSize:9,fill:P.tm}}>{t("ανοιχτά","open")}</text>
                    </svg>
                  );
                })()}
              </div>
              <div style={{flex:1,minWidth:150,display:"flex",flexDirection:"column",gap:7}}>
                {AGING_COLS.map(b=>(
                  <div key={b} style={{display:"flex",alignItems:"center",gap:8,fontSize:12}}>
                    <span style={{width:9,height:9,borderRadius:2,background:bucketColor[b],flex:"none"}} />
                    <span style={{color:P.tm}}>{b==="current"?t("Τρέχον","Current"):b==="unknown"?t("Χωρίς ημ/νία","Undated"):b+t(" ημ"," d")}</span>
                    <span style={{marginLeft:"auto",fontWeight:600,color:(bucketTotal(b)&&b!=="current")?bucketColor[b]:P.tx}}>€{fmt(bucketTotal(b))}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Per-counterparty aging */}
          <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,boxShadow:P.sh,marginBottom:16,overflowX:"auto"}}>
            <div style={{padding:"10px 16px",fontSize:13,fontWeight:700,color:P.em,borderBottom:"1px solid "+P.bd}}>{t("Aging ανά","Aging by")} {view==="AR"?t("πελάτη","client"):t("προμηθευτή","supplier")} ({termLabel})</div>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:12,minWidth:900}}>
              <thead><tr>{[view==="AR"?t("Πελάτης","Client"):t("Προμηθευτής","Supplier"),t("Όροι","Terms"),...AGING_COLS.map(bucketLabel),t("Σύνολο","Total")].map((h,i)=>(<th key={i} style={{padding:"7px 10px",fontSize:11,fontWeight:700,color:"#fff",background:P.em,textAlign:i===0?"left":i===1?"center":"right"}}>{h}</th>))}</tr></thead>
              <tbody>
                {cpRows.map((r,i)=>(
                  <tr key={r.cp} style={{background:i%2===0?P.wh:P.al}}>
                    <td onClick={()=>view==="AR"&&onSelectClient&&onSelectClient(r.cp)} style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,fontWeight:600,color:P.em,cursor:view==="AR"?"pointer":"default"}}>{r.cp}</td>
                    <td style={{padding:"4px 6px",borderBottom:"1px solid "+P.bd,textAlign:"center"}} title={t("Όροι πληρωμής (ημέρες) για αυτόν — υπερισχύει του γενικού","Payment terms (days) for this one — overrides the global default")}>
                      <input value={cpTerm(r.cp)??""} onChange={ev=>setCpTerm(r.cp, ev.target.value.replace(/[^\d]/g,""))} placeholder={String(terms)} style={{width:44,padding:"3px 5px",border:"1px solid "+P.bd,borderRadius:5,fontSize:11,textAlign:"center",outline:"none",color:cpTerm(r.cp)!=null&&cpTerm(r.cp)!==""?P.em:P.tm}} />
                    </td>
                    {AGING_COLS.map(b=><td key={b} style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,textAlign:"right",color:(r[b]&&b!=="current")?bucketColor[b]:P.tx}}>{r[b]?fmt(r[b]):"-"}</td>)}
                    <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,textAlign:"right",fontWeight:700,color:P.em}}>{fmt(r.total)}</td>
                  </tr>
                ))}
                {!cpRows.length && <tr><td colSpan={AGING_COLS.length+3} style={{padding:24,textAlign:"center",color:P.tm,fontStyle:"italic"}}>{t("Κανένα ανοιχτό υπόλοιπο 🎉","No open balance 🎉")}</td></tr>}
              </tbody>
            </table>
          </div>

          {/* Open items */}
          <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,boxShadow:P.sh,overflowX:"auto"}}>
            <div style={{padding:"10px 16px",fontSize:13,fontWeight:700,color:P.em,borderBottom:"1px solid "+P.bd}}>{showPaid?t("Όλα τα παραστατικά","All documents"):t("Ανοιχτά παραστατικά","Open documents")} ({visible.length})</div>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:12,minWidth:960}}>
              <thead><tr>{[[t("Ημ/νία","Date"),"l"],[view==="AR"?t("Πελάτης","Client"):t("Προμηθευτής","Supplier"),"l"],[t("Αρ. Τιμ.","Inv No"),"l"],[t("Ποσό €","Amount €"),"r"],[t("Υπόλοιπο €","Balance €"),"r"],["Aging","l"],["",""]].map(([h,al],i)=>(<th key={i} style={{padding:"7px 10px",fontSize:11,fontWeight:700,color:"#fff",background:P.em,textAlign:al==="r"?"right":"left"}}>{h}</th>))}</tr></thead>
              <tbody>
                {visible.map((e,i)=>(
                  <tr key={e.client+e.id+i} style={{background:e.paid?"#F1F8E9":e.partial?"#FFFDE7":i%2===0?P.wh:P.al}}>
                    <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd}}>{e.date||"—"}</td>
                    <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,fontWeight:600,color:P.em}}>{e.counterparty}{view==="AP"&&<span style={{fontSize:10,color:P.tm}}> ({e.client})</span>}</td>
                    <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd}}>{e.invNo||"—"}</td>
                    <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,textAlign:"right",fontWeight:600}}>{fmt(e.amount)}</td>
                    <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,textAlign:"right",fontWeight:700,color:e.balance>0.005?P.tx:P.gn}}>{e.paid?"—":fmt(e.balance)}</td>
                    <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd}}>{e.paid?<span style={{color:P.gn,fontWeight:600}}>✓ {t("Πληρωμένο","Paid")}</span>:<span style={{color:bucketColor[e.bucket],fontWeight:600}}>{e.bucket==="current"?t("Τρέχον","Current"):e.bucket}{e.partial&&<span style={{color:"#E65100",fontWeight:600,marginLeft:6}}>· {t("μερικώς","partial")}</span>}</span>}</td>
                    <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,textAlign:"right",whiteSpace:"nowrap"}}>
                      {e.lockedMonth ? <span title={t("Κλειδωμένος μήνας — ξεκλείδωσέ τον για καταχώρηση","Locked month — unlock it to post")} style={{fontSize:12,color:P.tm}}>🔒</span> : <>
                      {!e.paid && <button onClick={()=>setPayModal({e, amount:String(Math.round(e.balance*100)/100), date:payDate})} disabled={busy===e.client+e.id} style={{background:P.wh,color:P.em,border:"1px solid "+P.bd,padding:"3px 8px",borderRadius:4,fontSize:11,fontWeight:600,cursor:busy?"wait":"pointer",marginRight:6}}>€ {t("Μερική","Part")}</button>}
                      <button onClick={()=>markPaid(e)} disabled={busy===e.client+e.id} style={{background:e.paid?"#FFF3E0":P.ep,color:e.paid?"#E65100":P.em,border:"none",padding:"3px 10px",borderRadius:4,fontSize:11,fontWeight:600,cursor:busy?"wait":"pointer"}}>{busy===e.client+e.id?"…":e.paid?t("↩ Ακύρωση","↩ Unpay"):t("✓ Πληρώθηκε","✓ Paid")}</button>
                      </>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{fontSize:11,color:P.tm,marginTop:8}}>{t("Aging βάσει","Aging based on")} {termLabel} ({t("ανά αντισυμβαλλόμενο όπου έχει οριστεί","per counterparty where set")}). {t("Το «Μερική» καταχωρεί τμηματική πληρωμή· όταν καλυφθεί το σύνολο, το παραστατικό κλείνει αυτόματα.","'Part' records a partial payment; once the full amount is covered the document closes automatically.")}</div>
        </>
        )}
      </div>

      {payModal && (
        <div onClick={()=>setPayModal(null)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:50}}>
          <div onClick={ev=>ev.stopPropagation()} style={{background:P.wh,borderRadius:12,padding:22,width:340,boxShadow:"0 12px 40px rgba(0,0,0,.25)"}}>
            <div style={{fontSize:15,fontWeight:700,color:P.em,marginBottom:4}}>{t("Καταχώρηση πληρωμής","Record payment")}</div>
            <div style={{fontSize:12,color:P.tm,marginBottom:14}}>{payModal.e.counterparty} · {payModal.e.invNo||t("χωρίς αρ.","no no.")} · {t("υπόλοιπο","balance")} €{fmt(payModal.e.balance)}</div>
            <label style={{display:"block",fontSize:12,color:P.tm,marginBottom:4}}>{t("Ποσό €","Amount €")}</label>
            <input type="number" step="0.01" autoFocus value={payModal.amount} onChange={ev=>setPayModal(m=>({...m,amount:ev.target.value}))} onKeyDown={ev=>ev.key==="Enter"&&recordPayment()} style={{width:"100%",padding:"8px 10px",border:"1px solid "+P.bd,borderRadius:8,fontSize:14,outline:"none",marginBottom:12,boxSizing:"border-box"}} />
            <label style={{display:"block",fontSize:12,color:P.tm,marginBottom:4}}>{t("Ημ/νία","Date")}</label>
            <input type="date" value={payModal.date} onChange={ev=>setPayModal(m=>({...m,date:ev.target.value}))} style={{width:"100%",padding:"8px 10px",border:"1px solid "+P.bd,borderRadius:8,fontSize:14,outline:"none",marginBottom:8,boxSizing:"border-box"}} />
            {Number(payModal.amount)>payModal.e.balance+0.005 && <div style={{fontSize:11,color:"#E65100",marginBottom:8}}>{t("Το ποσό υπερβαίνει το υπόλοιπο — θα κλείσει πλήρως.","Amount exceeds the balance — will fully close it.")}</div>}
            <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginTop:6}}>
              <button onClick={()=>setPayModal(null)} style={{padding:"8px 14px",border:"1px solid "+P.bd,borderRadius:8,background:P.wh,color:P.tx,fontSize:13,cursor:"pointer"}}>{t("Άκυρο","Cancel")}</button>
              <button onClick={recordPayment} disabled={!(Number(payModal.amount)>0)} style={{padding:"8px 16px",border:"none",borderRadius:8,background:P.em,color:"#fff",fontSize:13,fontWeight:600,cursor:Number(payModal.amount)>0?"pointer":"not-allowed",opacity:Number(payModal.amount)>0?1:.5}}>{t("Καταχώρηση","Record")}</button>
            </div>
          </div>
        </div>
      )}
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
  // Normalize a getFinanceData response into state + record the server version for optimistic locking.
  const hydrate = (r)=>{
    verRef.current = (r&&r.version)||0;
    const d = (r&&r.data) || mkDefault();
    if(!d.opex) d.opex = mkDefault().opex;
    if(!Array.isArray(d.opex.cats)||!d.opex.cats.length) d.opex.cats = mkDefault().opex.cats;
    if(!d.opex.budget) d.opex.budget={};
    if(!d.opex.actual) d.opex.actual={};
    if(!Array.isArray(d.capex)) d.capex=[];
    setFin(d); dirtyRef.current=false;
  };

  useEffect(()=>{
    let cancelled=false; setLoaded(false);
    (async()=>{
      const r = await api.getFinanceData(year).catch(()=>null);
      if(cancelled) return;
      hydrate(r); setSaveState("idle"); setLoaded(true);
    })();
    return ()=>{cancelled=true;};
  // eslint-disable-next-line
  },[year]);

  useEffect(()=>{
    if(!loaded||!fin||!dirtyRef.current) return;
    setSaveState("saving");
    const t=setTimeout(async()=>{
      try{ const resp=await api.saveFinanceData(year, fin, verRef.current); verRef.current=(resp&&resp.version)||verRef.current+1; dirtyRef.current=false; setSaveState("saved"); }
      catch(e){
        // 409 = another finance/admin user saved first. Never silently overwrite their work: reload the
        // latest server copy so the user re-applies onto current data (same policy as client-data saves).
        if(e&&e.status===409){
          dirtyRef.current=false; setSaveState("error");
          alert(t("⚠️ Τα δεδομένα OPEX/CAPEX ενημερώθηκαν από άλλον χρήστη.\n\nΘα φορτωθεί τώρα η τελευταία αποθηκευμένη έκδοση — οι πολύ πρόσφατες αλλαγές σου ΔΕΝ αποθηκεύτηκαν, ξαναπέρασέ τες.","⚠️ The OPEX/CAPEX data was updated by another user.\n\nThe latest saved version will load now — your most recent edits were NOT saved, please re-apply them."));
          const r = await api.getFinanceData(year).catch(()=>null);
          hydrate(r); setSaveState("idle");
        } else { setSaveState("error"); console.warn("finance save failed",e); }
      }
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
      <AppHeader user={user} onLogout={onLogout} onBack={onBack} title={`💰 ${t("OPEX / CAPEX — Εταιρεία","OPEX / CAPEX — Company")} (${year})`}
        right={<span style={{fontSize:11,color:P.tm,minWidth:78,textAlign:"right"}}>{saveLbl}</span>} />

      <div style={{maxWidth:1400,margin:"0 auto",padding:"18px clamp(12px,4vw,24px)"}}>
        {/* Year + sub-tabs */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,flexWrap:"wrap",gap:12}}>
          <div style={{display:"flex",gap:8}}>
            {YEARS.map(y=>(<button key={y} onClick={()=>setYear(y)} style={{padding:"6px 16px",border:year===y?"2px solid "+P.em:"1px solid "+P.bd,borderRadius:6,cursor:"pointer",fontSize:13,fontWeight:year===y?700:400,background:year===y?P.em:P.wh,color:year===y?"#fff":P.tx}}>{y}</button>))}
          </div>
          <div style={{display:"flex",gap:0,background:P.wh,borderRadius:8,border:"1px solid "+P.bd,boxShadow:P.sh,padding:4}}>
            {[{v:"opex",l:"OPEX"},{v:"capex",l:"CAPEX"},{v:"summary",l:t("Σύνοψη","Summary")}].map(o=>(
              <button key={o.v} onClick={()=>setSub(o.v)} style={{background:sub===o.v?P.em:"transparent",color:sub===o.v?"#fff":P.tx,border:"none",padding:"7px 20px",borderRadius:6,cursor:"pointer",fontSize:13,fontWeight:600}}>{o.l}</button>
            ))}
          </div>
        </div>

        {!loaded && <div style={{padding:40,textAlign:"center",color:P.tm}}>{t("Φόρτωση…","Loading…")}</div>}

        {/* ── OPEX ── */}
        {loaded && sub==="opex" && (
          <div>
            {(()=>{
              const DVZ=["#80BBAD","#435254","#17E88F","#DBD99A","#D2785A","#885073","#A388BF","#1F3765","#3E7CA6","#CAD1D3"];
              const actTot=cats.reduce((s,c)=>s+catMonthTotal("actual",c.id),0);
              const budTot=cats.reduce((s,c)=>s+catMonthTotal("budget",c.id),0);
              const byCat=cats.map((c,idx)=>({label:c.label||t("(χωρίς όνομα)","(unnamed)"),v:catMonthTotal("actual",c.id),color:DVZ[idx%DVZ.length]})).filter(x=>x.v>0).sort((a,b)=>b.v-a.v);
              const varPct=budTot?(actTot-budTot)/budTot:null;
              const C=2*Math.PI*52; let acc=0;
              const legend=byCat.slice(0,7); const restV=byCat.slice(7).reduce((s,x)=>s+x.v,0);
              return (
                <div style={{display:"flex",gap:16,flexWrap:"wrap",marginBottom:14}}>
                  <div style={{flex:"1 1 240px",minWidth:240,background:"linear-gradient(150deg,#014A34 0%,#003F2D 55%,#012A2D 100%)",color:"#EAF6EF",borderRadius:16,padding:"20px 22px",position:"relative",overflow:"hidden",boxShadow:P.sh}}>
                    <div style={{fontFamily:"'Space Mono',ui-monospace,monospace",fontSize:9.5,letterSpacing:".12em",textTransform:"uppercase",color:"#9FD9C4"}}>{t("OPEX Πραγματικά · FY","OPEX Actual · FY")} {year}</div>
                    <div style={{fontSize:32,fontWeight:700,margin:"12px 0 3px",letterSpacing:"-.02em",lineHeight:1}}>€{fmt(actTot)}</div>
                    <div style={{fontSize:12,color:varPct==null?"#AEE9CF":varPct>0?"#F3A6A5":"#7EE8B4"}}>{t("Προϋπ.","Budget")} €{fmt(budTot)}{varPct!=null?` · ${varPct>0?"+":""}${(varPct*100).toFixed(0)}%`:""}</div>
                    <svg viewBox="0 0 300 40" preserveAspectRatio="none" style={{position:"absolute",left:0,right:0,bottom:0,width:"100%",height:38,opacity:.55}}><path d="M0 28 Q40 8 80 22 T160 18 T240 24 T300 12 V40 H0 Z" fill="rgba(23,232,143,.18)"/><path d="M0 28 Q40 8 80 22 T160 18 T240 24 T300 12" fill="none" stroke="rgba(23,232,143,.55)" strokeWidth="1.5"/></svg>
                  </div>
                  <div style={{flex:"2 1 380px",background:P.wh,border:"1px solid "+P.bd,borderRadius:16,padding:"16px 18px",boxShadow:P.sh,display:"flex",gap:20,alignItems:"center",flexWrap:"wrap"}}>
                    <div>
                      <div style={{fontSize:13,fontWeight:700,color:P.em,marginBottom:8}}>{t("OPEX ανά κατηγορία","OPEX by category")}</div>
                      <svg viewBox="0 0 140 140" width="128" height="128" style={{display:"block"}}>
                        <circle cx="70" cy="70" r="52" fill="none" stroke={P.al} strokeWidth="20"/>
                        {actTot>0 && byCat.map(s=>{ const seg=s.v/actTot*C; const el=<circle key={s.label} cx="70" cy="70" r="52" fill="none" stroke={s.color} strokeWidth="20" strokeDasharray={`${seg} ${C-seg}`} strokeDashoffset={-acc} transform="rotate(-90 70 70)"/>; acc+=seg; return el; })}
                        <text x="70" y="66" textAnchor="middle" style={{fontSize:15,fontWeight:800,fill:P.em}}>€{fmt(actTot)}</text>
                        <text x="70" y="84" textAnchor="middle" style={{fontSize:9,fill:P.tm}}>OPEX</text>
                      </svg>
                    </div>
                    <div style={{flex:1,minWidth:150,display:"flex",flexDirection:"column",gap:6}}>
                      {legend.map(s=>(
                        <div key={s.label} style={{display:"flex",alignItems:"center",gap:8,fontSize:12}}>
                          <span style={{width:9,height:9,borderRadius:2,background:s.color,flex:"none"}} />
                          <span style={{color:P.tm,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{s.label}</span>
                          <span style={{marginLeft:"auto",fontWeight:600,color:P.tx}}>€{fmt(s.v)}</span>
                        </div>
                      ))}
                      {restV>0 && <div style={{display:"flex",alignItems:"center",gap:8,fontSize:12}}><span style={{width:9,height:9,borderRadius:2,background:P.bd,flex:"none"}} /><span style={{color:P.tm}}>{t("Λοιπές","Other")}</span><span style={{marginLeft:"auto",fontWeight:600,color:P.tx}}>€{fmt(restV)}</span></div>}
                      {!byCat.length && <div style={{fontSize:12,color:P.tm,fontStyle:"italic"}}>{t("Δεν υπάρχουν πραγματικά OPEX ακόμα","No actual OPEX yet")}</div>}
                    </div>
                  </div>
                </div>
              );
            })()}
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10,flexWrap:"wrap",gap:10}}>
              <div style={{display:"flex",gap:0,background:P.wh,borderRadius:8,border:"1px solid "+P.bd,boxShadow:P.sh,padding:3}}>
                {[{v:"actual",l:t("Πραγματικά","Actual")},{v:"budget",l:t("Προϋπολογισμός","Budget")},{v:"variance",l:t("Απόκλιση","Variance")}].map(o=>(
                  <button key={o.v} onClick={()=>setOpexView(o.v)} style={{background:opexView===o.v?"#003F2D":"transparent",color:opexView===o.v?"#fff":P.tx,border:"none",padding:"6px 16px",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:600}}>{o.l}</button>
                ))}
              </div>
              <div style={{display:"flex",gap:8,alignItems:"center"}}>
                <input value={newCat} onChange={e=>setNewCat(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addCat()} placeholder={t("Νέα κατηγορία…","New category…")} style={{padding:"6px 10px",border:"1px solid "+P.bd,borderRadius:6,fontSize:12,outline:"none"}} />
                <button onClick={addCat} style={{background:P.em,color:"#fff",border:"none",padding:"6px 14px",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:600}}>+ {t("Κατηγορία","Category")}</button>
              </div>
            </div>
            <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,boxShadow:P.sh,overflowX:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse",tableLayout:"fixed",minWidth:1150}}>
                <colgroup><col style={{width:170}} />{MONTHS.map(m=><col key={m} style={{width:72}} />)}<col style={{width:95}} /><col style={{width:34}} /></colgroup>
                <thead><tr>
                  <th style={{...thS,textAlign:"left",borderRight:"2px solid #003F2D"}}>{t("Κατηγορία","Category")}</th>
                  {MONTHS.map(m=><th key={m} style={thS}>{monthLabel(m)}</th>)}
                  <th style={{...thS,background:"#003F2D"}}>{t("Σύνολο","Total")}</th><th style={thS}></th>
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
                    <td style={{padding:"8px 8px",fontSize:12,fontWeight:700,borderRight:"2px solid #003F2D"}}>{t("ΣΥΝΟΛΟ","TOTAL")} {opexView==="variance"?"(Act−Bud)":opexView}</td>
                    {MONTHS.map(m=>{ const v=opexView==="variance"?(opexColTotal("actual",m)-opexColTotal("budget",m)):opexColTotal(opexView,m); return <td key={m} style={{padding:"6px 6px",textAlign:"right",fontSize:11,fontWeight:700,color:opexView==="variance"&&v>0?P.rd:P.em}}>{fmt(v)}</td>; })}
                    <td style={{padding:"6px 8px",textAlign:"right",fontSize:12,fontWeight:700,color:P.em,background:"#C8E6C9",borderLeft:"2px solid #003F2D"}}>{fmt(opexView==="variance"?(totActual-totBudget):opexGrand(opexView))}</td>
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
            <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,boxShadow:P.sh,padding:14,marginBottom:16,display:"flex",flexWrap:"wrap",gap:8,alignItems:"end"}}>
              <Inp l={t("Περιγραφή","Description")} v={cf.desc} set={v=>setCf(x=>({...x,desc:v}))} w={180} />
              <Sel l={t("Κατηγορία","Category")} v={cf.cat} set={v=>setCf(x=>({...x,cat:v}))} opts={CAPEX_CATS.map(c=>({v:c,l:c}))} w={160} />
              <Inp l={t("Αξία €","Value €")} v={cf.amount} set={v=>setCf(x=>({...x,amount:v}))} w={100} t="number" />
              <Sel l={t("Μήνας κτήσης","Acq. month")} v={cf.month} set={v=>setCf(x=>({...x,month:v}))} opts={MONTHS.map(m=>({v:m,l:monthLabel(m)}))} w={110} />
              <Inp l={t("Ωφ. ζωή (μήνες)","Useful life (mo)")} v={cf.life} set={v=>setCf(x=>({...x,life:v}))} w={110} t="number" />
              <Sel l="Status" v={cf.status} set={v=>setCf(x=>({...x,status:v}))} opts={CAPEX_STATUS.map(s=>({v:s.v,l:s.v}))} w={120} />
              <Inp l="PO No" v={cf.po} set={v=>setCf(x=>({...x,po:v}))} w={90} />
              <button onClick={addCapex} style={{background:P.em,color:"#fff",border:"none",padding:"7px 18px",borderRadius:6,cursor:"pointer",fontSize:13,fontWeight:600}}>+ {t("Πάγιο","Asset")}</button>
            </div>
            <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,boxShadow:P.sh,overflowX:"auto"}}>
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
            <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,boxShadow:P.sh,padding:16}}>
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

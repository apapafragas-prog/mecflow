// AI analytics: deterministic run-rate forecast + risk flags, with an on-demand
// Claude narrative (AiCard). Extracted from App.jsx.
//   AiCard   — reusable "🤖 AI σχολιασμός" card (client + portfolio scopes).
//   Insights — per-client forecast/risk view.
import { useState } from "react";
import { api } from "./api.js";
import { P, MONTHS, ML, fmt, fPct } from "./constants.js";
import { clientSeries, runRateFY, clientRisks } from "./calc.js";

function riskColor(l){ return l==="high"?P.rd:l==="med"?"#F57F17":"#78909C"; }

export function AiCard({scope,buildContext}) {
  const [text,setText]=useState(""); const [busy,setBusy]=useState(false); const [err,setErr]=useState("");
  const gen = async () => { setBusy(true); setErr(""); try { const r=await api.getInsights(scope, buildContext()); setText(r.text||"(κενή απάντηση)"); } catch(e){ setErr(e.status===503?"Το AI δεν έχει ρυθμιστεί (ANTHROPIC_API_KEY).":(e.message||"Απέτυχε")); } finally{ setBusy(false); } };
  return (
    <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,padding:16,marginTop:16}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:text?10:0}}>
        <div style={{fontSize:13,fontWeight:700,color:P.em}}>🤖 AI σχολιασμός</div>
        <button onClick={gen} disabled={busy} style={{background:P.em,color:"#fff",border:"none",padding:"6px 16px",borderRadius:6,cursor:busy?"wait":"pointer",fontSize:12,fontWeight:600,opacity:busy?.6:1}}>{busy?"Ανάλυση…":text?"↻ Ξανά":"✨ Δημιουργία σχολίου"}</button>
      </div>
      {err && <div style={{color:P.rd,fontSize:12,marginTop:8}}>{err}</div>}
      {text && <div style={{fontSize:13.5,color:P.tx,lineHeight:1.6,whiteSpace:"pre-wrap",marginTop:6}}>{text}</div>}
      {!text && !err && <div style={{fontSize:11,color:P.tm,marginTop:8}}>Το Claude γράφει σύντομο commentary & ρίσκα με βάση μόνο τα συγκεντρωτικά νούμερα (όχι επιμέρους τιμολόγια).</div>}
    </div>
  );
}
export function Insights({inv,sub,lab,contracts,client,year}) {
  const cd = {inv,sub,lab,contracts};
  const series = clientSeries(cd, MONTHS);
  const rr = runRateFY(series);
  const risks = clientRisks(cd, MONTHS);
  const activeSeries = series.filter(s=>s.rev||s.cost||s.labour);
  const maxAbs = Math.max(1,...series.map(s=>Math.abs(s.gm)),...series.map(s=>s.rev));
  const gmPct = rr.actual.rev? rr.actual.gm/rr.actual.rev : null;
  const projGmPct = rr.projected.rev? rr.projected.gm/rr.projected.rev : null;
  const buildContext = () => ({
    client, year, monthsActive: rr.monthsActive,
    actualFY: { rev:Math.round(rr.actual.rev), cost:Math.round(rr.actual.cost), labour:Math.round(rr.actual.labour), gm:Math.round(rr.actual.gm) },
    projectedFY: { rev:Math.round(rr.projected.rev), cost:Math.round(rr.projected.cost), gm:Math.round(rr.projected.gm) },
    gmPctActual: gmPct!=null?+(gmPct*100).toFixed(1):null,
    monthly: activeSeries.map(s=>({month:ML[s.m]||s.m, rev:Math.round(s.rev), cost:Math.round(s.cost), gm:Math.round(s.gm)})),
    risks: risks.map(r=>r.label),
  });
  const kpi=(l,v,c,pct)=>(<div style={{background:P.wh,border:"1px solid "+P.bd,borderRadius:10,padding:"12px 14px"}}><div style={{fontSize:11,color:P.tm}}>{l}</div><div style={{fontSize:19,fontWeight:800,color:c,marginTop:4}}>{pct?fPct(v):"€"+fmt(v)}</div></div>);
  return (
    <div>
      <h2 style={{color:P.em,fontSize:16,fontWeight:700,margin:"0 0 6px"}}>Insights & Forecast — {client}</h2>
      <p style={{fontSize:12,color:P.tm,margin:"0 0 16px"}}>Πρόβλεψη έτους (run-rate σε {rr.monthsActive} ενεργούς μήνες) + αυτόματα risk flags. Το AI σχόλιο είναι προαιρετικό.</p>

      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(150px,1fr))",gap:12,marginBottom:8}}>
        {kpi("Revenue — actual",rr.actual.rev,P.gn)}
        {kpi("Revenue — προβλ. έτους",rr.projected.rev,P.em)}
        {kpi("GM — actual",rr.actual.gm,rr.actual.gm>=0?P.gn:P.rd)}
        {kpi("GM — προβλ. έτους",rr.projected.gm,rr.projected.gm>=0?P.em:P.rd)}
        {kpi("GM% — actual",gmPct,P.tx,true)}
        {kpi("GM% — προβλ.",projGmPct,P.em,true)}
      </div>

      <div style={{display:"grid",gridTemplateColumns:"1.6fr 1fr",gap:16,alignItems:"start",marginTop:8}}>
        <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,padding:16}}>
          <div style={{fontSize:13,fontWeight:700,color:P.em,marginBottom:12}}>Μηνιαία εξέλιξη GM</div>
          {activeSeries.length? series.map(x=>(
            <div key={x.m} style={{display:"flex",alignItems:"center",gap:8,fontSize:11,marginBottom:5}}>
              <span style={{width:44,color:P.tm,flexShrink:0}}>{ML[x.m]}</span>
              <div style={{flex:1,background:"#eef2ef",borderRadius:4,height:14,position:"relative",overflow:"hidden"}}>
                <div style={{position:"absolute",left:0,top:0,bottom:0,width:(Math.max(0,x.gm)/maxAbs*100)+"%",background:x.gm>=0?P.em:P.rd,opacity:.85}} />
              </div>
              <span style={{width:78,textAlign:"right",color:x.gm>=0?P.em:P.rd,fontWeight:600,flexShrink:0}}>{fmt(x.gm)}</span>
            </div>
          )) : <div style={{fontSize:12,color:P.tm,fontStyle:"italic"}}>Δεν υπάρχουν δεδομένα ακόμη.</div>}
        </div>
        <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,padding:16}}>
          <div style={{fontSize:13,fontWeight:700,color:P.rd,marginBottom:10}}>⚠️ Risk flags ({risks.length})</div>
          {risks.length? risks.map((r,i)=>(
            <div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"5px 0",borderBottom:i<risks.length-1?"1px solid "+P.bd:"none",fontSize:12.5}}>
              <span style={{width:8,height:8,borderRadius:"50%",background:riskColor(r.level),flexShrink:0}} />
              <span style={{color:P.tx}}>{r.label}</span>
            </div>
          )) : <div style={{fontSize:12,color:P.gn,fontStyle:"italic"}}>Κανένα ρίσκο εντοπίστηκε 🎉</div>}
        </div>
      </div>

      <AiCard scope="client" buildContext={buildContext} />
    </div>
  );
}

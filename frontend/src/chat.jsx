// AI Chat assistant (single-shot, client-built snapshot — no live DB tool-calling).
// The client assembles an aggregate snapshot of the current screen and sends it with
// the question; the server does one Anthropic call and returns { text, actions[] }.
import { useState, useEffect, useRef } from "react";
import { api } from "./api.js";
import { P, MONTHS, ML } from "./constants.js";
import { clientSeries, runRateFY, clientRisks, daysUntil } from "./calc.js";
import { MdText } from "./ui.jsx";
import { useT } from "./i18n.jsx";

// Friendly robot mascot for the AI assistant — inline SVG so it stays crisp at any
// size and needs no binary asset. Blue rounded head + antenna + side ears + dark
// screen face with two eyes and a smile.
export const AiFace = ({ size = 32 }) => (
  <svg width={size} height={size} viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" style={{display:"block"}} aria-hidden="true">
    <circle cx="32" cy="6.5" r="4" fill="#35ADEF"/>
    <rect x="30.5" y="9.5" width="3" height="7.5" rx="1.5" fill="#35ADEF"/>
    <rect x="4.5" y="25.5" width="8" height="14.5" rx="4" fill="#2E9BE0"/>
    <rect x="51.5" y="25.5" width="8" height="14.5" rx="4" fill="#2E9BE0"/>
    <rect x="10.5" y="15" width="43" height="35.5" rx="12" fill="#3BB0F2"/>
    <rect x="16.5" y="21" width="31" height="23" rx="7.5" fill="#1E2A3A"/>
    <circle cx="26" cy="31.5" r="3.1" fill="#fff"/>
    <circle cx="38" cy="31.5" r="3.1" fill="#fff"/>
    <path d="M25.5 36.4 Q32 41.6 38.5 36.4" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" fill="none"/>
  </svg>
);

const grossAmt = r => Number(r.total) || (Number(r.amt)||0)+(Number(r.vat)||0) || Number(r.amt) || 0;
const isPaid = r => r.paid==="paid" || r.paid===true;
function buildClientSnapshot(cd, client, year) {
  const inv=cd?.inv||[], sub=cd?.sub||[], contracts=cd?.contracts||[];
  const series = clientSeries(cd, MONTHS);
  const rr = runRateFY(series);
  const active = series.filter(s=>s.rev||s.cost||s.labour);
  const rc={core:0,ew:0,pjm:0};
  inv.forEach(i=>{ const c=i.cat||""; if(c.includes("Core"))rc.core+=Number(i.amt)||0; else if(c.includes("Extra"))rc.ew+=Number(i.amt)||0; else if(c.includes("PJM"))rc.pjm+=Number(i.amt)||0; });
  const supMap={}; sub.forEach(s=>{ const n=s.supplier||"—"; supMap[n]=(supMap[n]||0)+(Number(s.amt)||0); });
  const topSuppliers=Object.entries(supMap).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([name,amount])=>({name,amount:Math.round(amount)}));
  const poSpend=contracts.filter(c=>c.type==="PO"&&c.po).map(c=>{ const spent=inv.filter(i=>i.po_no===c.po&&(i.act_acc||"").toUpperCase()==="ACTUAL").reduce((s,i)=>s+(Number(i.amt)||0),0); const b=Number(c.po_value)||0; return {po:c.po,budget:Math.round(b),spent:Math.round(spent),remaining:Math.round(b-spent)}; });
  return {
    scope:"client", year, client, status:cd?.status||"draft",
    totals:{ revenue:Math.round(rr.actual.rev), sub_cost:Math.round(rr.actual.cost), labour:Math.round(rr.actual.labour), gm:Math.round(rr.actual.gm), gm_pct: rr.actual.rev?+((rr.actual.gm/rr.actual.rev)*100).toFixed(1):null },
    projected_fy:{ revenue:Math.round(rr.projected.rev), gm:Math.round(rr.projected.gm) },
    counts:{ cbre_invoices:inv.length, sub_invoices:sub.length, contracts:contracts.length },
    monthly: active.map(s=>({month:ML[s.m]||s.m, rev:Math.round(s.rev), cost:Math.round(s.cost), gm:Math.round(s.gm)})),
    revenue_by_category:{ core:Math.round(rc.core), extra_works:Math.round(rc.ew), pjm:Math.round(rc.pjm) },
    top_suppliers: topSuppliers, po_spend: poSpend,
    contracts: contracts.slice(0,12).map(c=>({type:c.type,ref:c.ref,expiry:c.expiry,fee_pct:c.fee_pct})),
    ar_ap:{ receivable_open:Math.round(inv.filter(i=>!isPaid(i)).reduce((s,i)=>s+grossAmt(i),0)), payable_open:Math.round(sub.filter(i=>!isPaid(i)).reduce((s,i)=>s+grossAmt(i),0)) },
    risk_flags: clientRisks(cd, MONTHS).map(r=>r.label),
  };
}
function buildPortfolioSnapshot(data, year) {
  const rows=Object.entries(data||{}).map(([name,cd])=>{ const inv=cd?.inv||[],sub=cd?.sub||[],lab=cd?.lab||{}; const rev=inv.reduce((s,i)=>s+(Number(i.amt)||0),0); const cost=sub.reduce((s,i)=>s+(Number(i.amt)||0),0); const labour=Object.values(lab).reduce((s,mo)=>s+Object.values(mo||{}).reduce((a,v)=>a+(Number(v)||0),0),0); return {name,rev,cost,labour,gm:rev-cost-labour,status:cd?.status||"draft",active:inv.length>0||sub.length>0}; });
  const sum=k=>rows.reduce((s,r)=>s+r[k],0); const totRev=sum("rev"), totGM=rows.reduce((s,r)=>s+r.gm,0); const st=s=>rows.filter(r=>r.status===s).length;
  const expiring=[], atRisk=[];
  Object.entries(data||{}).forEach(([name,cd])=>{ (cd?.contracts||[]).forEach(c=>{ if(c.status==="Terminated"||c.status==="Expired")return; const dd=daysUntil(c.expiry); if(dd!=null&&dd<=90) expiring.push({client:name,ref:c.ref,days:dd}); }); const rk=clientRisks(cd,MONTHS); if(rk.length) atRisk.push({client:name,risks:rk.map(r=>r.label)}); });
  expiring.sort((a,b)=>a.days-b.days);
  return {
    scope:"portfolio", year,
    totals:{ revenue:Math.round(totRev), cost:Math.round(sum("cost")), labour:Math.round(sum("labour")), gm:Math.round(totGM), gm_pct: totRev?+((totGM/totRev)*100).toFixed(1):null, clients:rows.length, active:rows.filter(r=>r.active).length },
    by_status:{ draft:st("draft"), submitted:st("submitted"), approved:st("approved"), rejected:st("rejected") },
    top_clients: rows.filter(r=>r.active).sort((a,b)=>b.gm-a.gm).slice(0,8).map(r=>({name:r.name,revenue:Math.round(r.rev),gm:Math.round(r.gm)})),
    expiring_contracts: expiring.slice(0,10), clients_at_risk: atRisk.slice(0,10),
  };
}
export function ChatWidget({user,year,ctx,nav}) {
  const { t, lang } = useT();
  const [open,setOpen]=useState(false);
  const [msgs,setMsgs]=useState(()=>{ try{ return JSON.parse(localStorage.getItem("cbre_chat_v1")||"[]"); }catch{ return []; } });
  const [input,setInput]=useState("");
  const [busy,setBusy]=useState(false);
  const scrollRef=useRef(null);
  const portRef=useRef({year:null,data:null});
  useEffect(()=>{ try{ localStorage.setItem("cbre_chat_v1", JSON.stringify(msgs.slice(-30))); }catch{} },[msgs]);
  useEffect(()=>{ if(scrollRef.current) scrollRef.current.scrollTop=scrollRef.current.scrollHeight; },[msgs,busy,open]);
  const scope = ctx.client ? "client" : "portfolio";
  const suggestions = scope==="client"
    ? [t("Πώς πάει το GM;","How is the GM doing?"),t("Ποια είναι τα ρίσκα;","What are the risks?"),t("Ανάλυσε τα έσοδα","Analyze the revenue"),t("Τι λήγει σύντομα;","What expires soon?")]
    : [t("Σύνοψη χαρτοφυλακίου","Portfolio summary"),t("Ποιοι πελάτες έχουν ρίσκα;","Which clients are at risk?"),t("Τι εκκρεμεί για έγκριση;","What's pending approval?"),t("Top πελάτες κατά GM","Top clients by GM")];
  const buildSnapshot = async () => {
    if(ctx.client && ctx.cd) return { user:{name:user.name,role:user.role}, ...buildClientSnapshot(ctx.cd, ctx.client, year) };
    let data = portRef.current.year===year ? portRef.current.data : null;
    if(!data){ data = await api.getYearData(year).catch(()=>({})); portRef.current={year,data}; }
    return { user:{name:user.name,role:user.role}, ...buildPortfolioSnapshot(data, year) };
  };
  const send = async (text) => {
    const q=(text||input).trim(); if(!q||busy) return;
    setInput(""); const next=[...msgs,{role:"user",content:q}]; setMsgs(next); setBusy(true);
    try {
      const snapshot = await buildSnapshot();
      const history = next.slice(-9).map(m=>({role:m.role,content:m.content}));
      const r = await api.chat(q, history, snapshot, lang);
      setMsgs(m=>[...m,{role:"assistant",content:r.text||t("(κενή απάντηση)","(empty response)"),actions:Array.isArray(r.actions)?r.actions:[]}]);
    } catch(e) {
      const msg = e.status===429?t("⚠️ Εξαντλήθηκε το ημερήσιο όριο AI για σήμερα.","⚠️ Today's AI limit has been reached."):e.status===503?t("⚠️ Το AI δεν είναι ρυθμισμένο στον server.","⚠️ AI is not configured on the server."):t("⚠️ Κάτι πήγε στραβά. Δοκίμασε ξανά.","⚠️ Something went wrong. Try again.");
      setMsgs(m=>[...m,{role:"assistant",content:msg,actions:[]}]);
    } finally { setBusy(false); }
  };
  const doAction = (a) => { if(a&&typeof a.view==="string") nav(a.view); setOpen(false); };
  if(!open) return (
    <button onClick={()=>setOpen(true)} title={t("AI βοηθός","AI assistant")} style={{position:"fixed",bottom:22,right:22,width:56,height:56,borderRadius:"50%",background:"#fff",border:"none",boxShadow:"0 6px 20px rgba(0,0,0,.25)",cursor:"pointer",zIndex:1200,display:"flex",alignItems:"center",justifyContent:"center"}}><AiFace size={40}/></button>
  );
  return (
    <div style={{position:"fixed",bottom:22,right:22,width:"min(420px, calc(100vw - 32px))",height:"min(600px, calc(100vh - 44px))",background:P.wh,borderRadius:14,boxShadow:"0 12px 48px rgba(0,0,0,.3)",zIndex:1200,display:"flex",flexDirection:"column",overflow:"hidden",border:"1px solid "+P.bd,fontFamily:"Segoe UI,Tahoma,sans-serif"}}>
      <div style={{background:P.em,color:"#fff",padding:"12px 16px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div style={{fontWeight:700,fontSize:14}}><span style={{display:"inline-flex",verticalAlign:"middle",marginRight:6}}><AiFace size={20}/></span>{t("AI Βοηθός","AI Assistant")} <span style={{fontSize:11,opacity:.7,fontWeight:400}}>· {scope==="client"?ctx.client:t("Χαρτοφυλάκιο","Portfolio")} · {year}</span></div>
        <div style={{display:"flex",gap:6}}>
          {msgs.length>0&&<button onClick={()=>setMsgs([])} title={t("Καθαρισμός","Clear")} style={{background:"rgba(255,255,255,.15)",border:"none",color:"#fff",padding:"4px 8px",borderRadius:5,cursor:"pointer",fontSize:11}}>🗑</button>}
          <button onClick={()=>setOpen(false)} style={{background:"rgba(255,255,255,.2)",border:"none",color:"#fff",padding:"4px 10px",borderRadius:5,cursor:"pointer",fontSize:14,fontWeight:700}}>✕</button>
        </div>
      </div>
      <div ref={scrollRef} style={{flex:1,overflowY:"auto",padding:14,background:P.of,display:"flex",flexDirection:"column",gap:10}}>
        {msgs.length===0 && (
          <div style={{color:P.tm,fontSize:12.5,lineHeight:1.5}}>
            {t("Ρώτησέ με για ","Ask me about ")}{scope==="client"?t(`τον πελάτη ${ctx.client}`,`client ${ctx.client}`):t("το χαρτοφυλάκιο","the portfolio")}{t(" — έσοδα, GM, ρίσκα, συμβόλαια, εκκρεμότητες."," — revenue, GM, risks, contracts, pending items.")}
            <div style={{fontSize:10.5,color:P.tm,marginTop:6,opacity:.8}}>{t("Βλέπω μόνο συγκεντρωτικά στοιχεία της τρέχουσας οθόνης.","I only see aggregate data for the current screen.")}</div>
          </div>
        )}
        {msgs.map((m,i)=> m.role==="user" ? (
          <div key={i} style={{alignSelf:"flex-end",maxWidth:"85%",background:P.em,color:"#fff",padding:"8px 12px",borderRadius:"12px 12px 3px 12px",fontSize:13}}>{m.content}</div>
        ) : (
          <div key={i} style={{alignSelf:"flex-start",maxWidth:"90%",background:P.wh,border:"1px solid "+P.bd,color:P.tx,padding:"9px 12px",borderRadius:"12px 12px 12px 3px",fontSize:13,lineHeight:1.5}}>
            <MdText text={m.content} />
            {Array.isArray(m.actions)&&m.actions.length>0&&(
              <div style={{display:"flex",flexWrap:"wrap",gap:6,marginTop:8}}>
                {m.actions.map((a,j)=><button key={j} onClick={()=>doAction(a)} style={{background:P.ep,color:P.em,border:"1px solid "+P.bd,padding:"4px 10px",borderRadius:12,fontSize:11.5,fontWeight:600,cursor:"pointer"}}>{a.label||t("Άνοιγμα","Open")} →</button>)}
              </div>
            )}
          </div>
        ))}
        {busy && <div style={{alignSelf:"flex-start",color:P.tm,fontSize:12,fontStyle:"italic"}}>{t("Σκέφτομαι…","Thinking…")}</div>}
      </div>
      {msgs.length===0 && (
        <div style={{padding:"8px 12px",display:"flex",flexWrap:"wrap",gap:6,borderTop:"1px solid "+P.bd,background:P.wh}}>
          {suggestions.map((s,i)=><button key={i} onClick={()=>send(s)} style={{background:P.of,border:"1px solid "+P.bd,color:P.tx,padding:"5px 10px",borderRadius:12,fontSize:11.5,cursor:"pointer"}}>{s}</button>)}
        </div>
      )}
      <div style={{padding:10,borderTop:"1px solid "+P.bd,background:P.wh,display:"flex",gap:8}}>
        <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&send()} placeholder={t("Ρώτησε κάτι…","Ask something…")} disabled={busy}
          style={{flex:1,padding:"9px 12px",border:"1px solid "+P.bd,borderRadius:8,fontSize:13,outline:"none",background:P.ip}} />
        <button onClick={()=>send()} disabled={busy||!input.trim()} style={{background:P.em,color:"#fff",border:"none",padding:"0 16px",borderRadius:8,cursor:busy?"wait":"pointer",fontSize:14,fontWeight:600,opacity:(busy||!input.trim())?.5:1}}>➤</button>
      </div>
    </div>
  );
}

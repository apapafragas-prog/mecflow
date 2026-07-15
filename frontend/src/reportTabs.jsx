// Client monthly-report sub-tabs, extracted from App.jsx.
//   PnL       — Profit & Loss with click-to-drill-down to source records.
//   InvTab    — CBRE revenue invoices grid.
//   SubTab    — Subcontractor invoices grid (with CBRE fee calc).
//   AccTab    — Accruals (read-only, derived from ACCRUAL-flagged invoices).
//   LabTab    — Labour cost grid + per-month segment allocation.
//   POTracker — PO spend tracker (budget vs actuals).
import { useState } from "react";
import { api } from "./api.js";
import { MONTHS, ML, P, fmt, fPct, uid, SITES, REV_CATS, COST_CATS, SVC_CATS, LAB_ROWS } from "./constants.js";
import { allocFractions } from "./calc.js";
import { Inp, Sel, Tbl } from "./ui.jsx";

export function PnL({inv,sub,lab,labAlloc}) {
  const [drill,setDrill] = useState(null);
  const pnl = {};
  MONTHS.forEach(m => {
    const rc = inv.filter(i=>i.month===m&&i.cat==="CLIENT REVENUE - FM Core").reduce((s,i)=>s+i.amt,0);
    const re = inv.filter(i=>i.month===m&&i.cat==="CLIENT REVENUE - FM Extra Works").reduce((s,i)=>s+i.amt,0);
    const rp = inv.filter(i=>i.month===m&&i.cat==="CLIENT REVENUE - PJMs").reduce((s,i)=>s+i.amt,0);
    const sc = sub.filter(i=>i.month===m&&(i.cat||"").toUpperCase().includes("CORE")).reduce((s,i)=>s+i.amt,0);
    const se = sub.filter(i=>i.month===m&&((i.cat||"").toUpperCase().includes("EXRA")||(i.cat||"").toUpperCase().includes("EXTRA"))).reduce((s,i)=>s+i.amt,0);
    const sp = sub.filter(i=>i.month===m&&(i.cat||"").toUpperCase().includes("PJM")).reduce((s,i)=>s+i.amt,0);
    // Total monthly labour, split across segments by the (proportional) allocation weights.
    // Total is preserved exactly: lc + lc_ew + lc_pjm === labTotal for any weights.
    const labTotal = lab[m] ? Object.values(lab[m]).reduce((s,v)=>s+(Number(v)||0),0) : 0;
    const fr = allocFractions(labAlloc, m);
    const lc = labTotal * fr.core;
    const lc_ew = labTotal * fr.ew;
    const lc_pjm = labTotal * fr.pjm;
    const lc_total = lc + lc_ew + lc_pjm;
    const tr = rc+re+rp;
    const sub_total = sc+se+sp;
    const tc = lc_total+sub_total;
    pnl[m] = {rc,re,rp,tr,lc,lc_ew,lc_pjm,lc_total,sc,se,sp,sub_total,tc,gm:tr-tc,gc:rc-lc-sc,ge:re-lc_ew-se,gp:rp-lc_pjm-sp};
  });
  const am = MONTHS;
  const ytd = k => am.reduce((s,m) => s+(pnl[m][k]||0),0);

  // Drill-down records for a given (key, month or "ytd")
  const getRecords = (key,month) => {
    const monthsScope = month==="ytd" ? am : [month];
    let recs = [];
    if(["rc","re","rp","tr"].includes(key)) {
      const cats = key==="rc"?["CLIENT REVENUE - FM Core"]:key==="re"?["CLIENT REVENUE - FM Extra Works"]:key==="rp"?["CLIENT REVENUE - PJMs"]:["CLIENT REVENUE - FM Core","CLIENT REVENUE - FM Extra Works","CLIENT REVENUE - PJMs"];
      recs = inv.filter(i=>monthsScope.includes(i.month)&&cats.includes(i.cat)).map(i=>({type:"Revenue",month:i.month,cat:i.cat,desc:i.inv_no,supplier:i.site,amt:i.amt,vat:i.vat,total:i.total,ref:i.po_no||"-",actAcc:i.act_acc,date:i.date}));
    } else if(["sc","se","sp","sub_total"].includes(key)) {
      const matcher = i => key==="sc"?(i.cat||"").toUpperCase().includes("CORE"):key==="se"?((i.cat||"").toUpperCase().includes("EXTRA")||(i.cat||"").toUpperCase().includes("EXRA")):key==="sp"?(i.cat||"").toUpperCase().includes("PJM"):true;
      recs = sub.filter(i=>monthsScope.includes(i.month)&&matcher(i)).map(i=>({type:"Sub Cost",month:i.month,cat:i.cat,desc:i.inv_no,supplier:i.supplier,amt:i.amt,vat:i.vat,total:i.total,ref:"-",actAcc:i.act_acc,date:i.date}));
    } else if(["lc","lc_ew","lc_pjm","lc_total"].includes(key)) {
      monthsScope.forEach(m => {
        const fr = allocFractions(labAlloc, m);
        const f = key==="lc"?fr.core:key==="lc_ew"?fr.ew:key==="lc_pjm"?fr.pjm:1;
        if(f && lab[m]) Object.entries(lab[m]).forEach(([k,v])=>{ const a=Number(v)*f; if(Number(v)) recs.push({type:"Labour",month:m,cat:k,desc:k,supplier:"-",amt:a,vat:0,total:a,ref:"-",actAcc:"-",date:"-"}); });
      });
    } else if(["tc"].includes(key)) {
      // Sub + labour combined
      recs = sub.filter(i=>monthsScope.includes(i.month)).map(i=>({type:"Sub Cost",month:i.month,cat:i.cat,desc:i.inv_no,supplier:i.supplier,amt:i.amt,vat:i.vat,total:i.total,ref:"-",actAcc:i.act_acc,date:i.date}));
      monthsScope.forEach(m => {
        if(lab[m]) Object.entries(lab[m]).forEach(([k,v])=>{ if(Number(v)) recs.push({type:"Labour",month:m,cat:k,desc:k,supplier:"-",amt:Number(v),vat:0,total:Number(v),ref:"-",actAcc:"-",date:"-"}); });
      });
    } else if(["gm","gc","ge","gp"].includes(key)) {
      // GM = related revenue + related cost (negative)
      const revKey = key==="gm"?"tr":key==="gc"?"rc":key==="ge"?"re":"rp";
      const costMatcher = key==="gc"?(i=>(i.cat||"").toUpperCase().includes("CORE")):key==="ge"?(i=>((i.cat||"").toUpperCase().includes("EXTRA")||(i.cat||"").toUpperCase().includes("EXRA"))):key==="gp"?(i=>(i.cat||"").toUpperCase().includes("PJM")):(()=>true);
      const revCats = revKey==="rc"?["CLIENT REVENUE - FM Core"]:revKey==="re"?["CLIENT REVENUE - FM Extra Works"]:revKey==="rp"?["CLIENT REVENUE - PJMs"]:["CLIENT REVENUE - FM Core","CLIENT REVENUE - FM Extra Works","CLIENT REVENUE - PJMs"];
      recs = inv.filter(i=>monthsScope.includes(i.month)&&revCats.includes(i.cat)).map(i=>({type:"Revenue",month:i.month,cat:i.cat,desc:i.inv_no,supplier:i.site,amt:i.amt,vat:i.vat,total:i.total,ref:i.po_no||"-",actAcc:i.act_acc,date:i.date}));
      const costRecs = sub.filter(i=>monthsScope.includes(i.month)&&costMatcher(i)).map(i=>({type:"Sub Cost",month:i.month,cat:i.cat,desc:i.inv_no,supplier:i.supplier,amt:-i.amt,vat:i.vat,total:-i.total,ref:"-",actAcc:i.act_acc,date:i.date}));
      recs = [...recs,...costRecs];
      // Labour attributable to this GM segment (full for total GM, allocated share for gc/ge/gp)
      monthsScope.forEach(m => {
        const fr = allocFractions(labAlloc, m);
        const f = key==="gm"?1:key==="gc"?fr.core:key==="ge"?fr.ew:fr.pjm;
        if(f && lab[m]) Object.entries(lab[m]).forEach(([k,v])=>{ const a=-Number(v)*f; if(Number(v)) recs.push({type:"Labour",month:m,cat:k,desc:k,supplier:"-",amt:a,vat:0,total:a,ref:"-",actAcc:"-",date:"-"}); });
      });
    }
    return recs;
  };

  const openDrill = (row,month) => {
    if(row.pct||row.l==="_") return;
    let v;
    if(row.k==="gm_pct"||row.k==="gc_pct"||row.k==="ge_pct") return;
    if(month==="ytd") v = ytd(row.k);
    else v = pnl[month][row.k];
    setDrill({label:row.l,month,value:v,records:getRecords(row.k,month)});
  };

  const rows = [
    {l:"CLIENT REVENUE - FM Core",k:"rc"},{l:"CLIENT REVENUE - FM Extra Works",k:"re"},{l:"CLIENT REVENUE - PJMs",k:"rp"},
    {l:"Total Sales / Revenue",k:"tr",b:true},{l:"_"},
    {l:"Labour Cost - FM Core",k:"lc"},{l:"Labour Cost - FM Extra Works",k:"lc_ew"},{l:"Labour Cost - PJMs",k:"lc_pjm"},
    {l:"Total Labour Cost",k:"lc_total",b:true},{l:"_"},
    {l:"CLIENT Subcontractors cost - FM Core",k:"sc"},{l:"CLIENT Subcontractors cost - FM Extra Works",k:"se"},{l:"CLIENT Subcontractors cost - PJMs",k:"sp"},
    {l:"Total Subcontractor",k:"sub_total",b:true},{l:"_"},
    {l:"Total Cost",k:"tc",b:true},{l:"_"},
    {l:"GM - Total",k:"gm",b:true,g:true},{l:"GM - Total %",k:"gm_pct",pct:true,b:true},{l:"_"},
    {l:"GM - FM Core",k:"gc",g:true},{l:"GM - FM Core %",k:"gc_pct",pct:true},
    {l:"GM - FM Extra Works",k:"ge",g:true},{l:"GM - FM Extra Works %",k:"ge_pct",pct:true},
    {l:"GM - FM PJM",k:"gp",g:true},
  ];

  const H = {padding:"8px 12px",textAlign:"right",fontSize:12,fontWeight:700,color:"#fff",background:P.em,position:"sticky",top:0};
  const D = {padding:"7px 12px",textAlign:"right",fontSize:12,borderBottom:"1px solid "+P.bd};

  return (
    <div>
      <h2 style={{color:P.em,fontSize:16,fontWeight:700,margin:"0 0 6px"}}>Profit & Loss (EUR)</h2>
      <p style={{fontSize:11,color:P.tm,margin:"0 0 16px"}}>💡 Click any number to drill down to source records</p>
      <div style={{overflowX:"auto",background:P.wh,borderRadius:8,border:"1px solid "+P.bd}}>
        <table style={{width:"100%",borderCollapse:"collapse",minWidth:600}}>
          <thead><tr><th style={{...H,textAlign:"left",minWidth:220}}>Line</th>{am.map(m=><th key={m} style={H}>{ML[m]}</th>)}<th style={H}>YTD</th></tr></thead>
          <tbody>{rows.map((r,i) => {
            if (r.l === "_") return <tr key={i}><td colSpan={am.length+2} style={{height:6,background:P.of}} /></tr>;
            const drillable = !r.pct && r.k;
            return (
              <tr key={i} style={{background:r.b?P.ep:i%2===0?P.wh:P.al}}>
                <td style={{...D,textAlign:"left",fontWeight:r.b?700:400,color:r.g?P.em:P.tx}}>{r.l}</td>
                {am.map(m => {
                  let v;
                  if (r.k==="gm_pct") v = pnl[m].tr ? pnl[m].gm/pnl[m].tr : null;
                  else if (r.k==="gc_pct") v = pnl[m].rc ? pnl[m].gc/pnl[m].rc : null;
                  else if (r.k==="ge_pct") v = pnl[m].re ? pnl[m].ge/pnl[m].re : null;
                  else v = pnl[m][r.k];
                  const neg = typeof v==="number" && v < 0;
                  const has = drillable && v;
                  return <td key={m} onClick={has?()=>openDrill(r,m):undefined} style={{...D,fontWeight:r.b?700:400,color:neg?P.rd:r.g?P.gn:P.tx,cursor:has?"pointer":"default",textDecoration:has?"underline dotted":"none",textDecorationColor:P.bd}}>{r.pct?fPct(v):fmt(v)}</td>;
                })}
                <td onClick={drillable&&ytd(r.k)?()=>openDrill(r,"ytd"):undefined} style={{...D,fontWeight:700,color:P.em,cursor:drillable&&ytd(r.k)?"pointer":"default",textDecoration:drillable&&ytd(r.k)?"underline dotted":"none",background:r.b?"":"#f5f5f5"}}>
                  {r.pct ? fPct(
                    r.k==="gm_pct"?(ytd("tr")?ytd("gm")/ytd("tr"):null):
                    r.k==="gc_pct"?(ytd("rc")?ytd("gc")/ytd("rc"):null):
                    r.k==="ge_pct"?(ytd("re")?ytd("ge")/ytd("re"):null):null
                  ) : fmt(ytd(r.k))}
                </td>
              </tr>
            );
          })}</tbody>
        </table>
      </div>

      {/* Drill-down Modal */}
      {drill && (
        <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,.5)",zIndex:999,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={()=>setDrill(null)}>
          <div style={{background:P.wh,borderRadius:12,width:"95%",maxWidth:1100,maxHeight:"90vh",overflow:"auto",boxShadow:"0 20px 60px rgba(0,0,0,.3)"}} onClick={e=>e.stopPropagation()}>
            <div style={{background:P.em,color:"#fff",padding:"16px 24px",borderRadius:"12px 12px 0 0",display:"flex",justifyContent:"space-between",alignItems:"center",position:"sticky",top:0,zIndex:1}}>
              <div>
                <div style={{fontWeight:700,fontSize:16}}>{drill.label} — {drill.month==="ytd"?"YTD Total":ML[drill.month]}</div>
                <div style={{fontSize:12,opacity:.8,marginTop:2}}>Total: €{fmt(drill.value)} · {drill.records.length} records</div>
              </div>
              <button onClick={()=>setDrill(null)} style={{background:"rgba(255,255,255,.2)",border:"none",color:"#fff",padding:"6px 14px",borderRadius:6,cursor:"pointer",fontSize:14,fontWeight:700}}>✕</button>
            </div>
            <div style={{padding:20}}>
              {drill.records.length>0 ? (
                <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                  <thead><tr>{["Type","Month","Category","Description","Supplier/Site","Amount €","VAT","Total €","Reference","Act/Acc","Date"].map(h=>(
                    <th key={h} style={{padding:"8px 10px",fontSize:11,fontWeight:700,color:"#fff",background:P.em,textAlign:h.includes("€")||h==="VAT"?"right":"left",position:"sticky",top:0}}>{h}</th>
                  ))}</tr></thead>
                  <tbody>
                    {drill.records.sort((a,b)=>a.month.localeCompare(b.month)).map((r,i)=>(
                      <tr key={i} style={{background:i%2===0?P.wh:P.al}}>
                        <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,fontSize:11}}>
                          <span style={{padding:"1px 8px",borderRadius:8,background:r.type==="Revenue"?"#E8F5E9":r.type==="Sub Cost"?"#FFEBEE":"#FFF8E1",color:r.type==="Revenue"?P.gn:r.type==="Sub Cost"?P.rd:"#F57F17",fontSize:10,fontWeight:600}}>{r.type}</span>
                        </td>
                        <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd}}>{ML[r.month]||r.month}</td>
                        <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,fontSize:11}}>{r.cat}</td>
                        <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd}}>{r.desc||"-"}</td>
                        <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd}}>{r.supplier||"-"}</td>
                        <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,textAlign:"right",fontWeight:600,color:r.amt<0?P.rd:P.tx}}>{fmt(r.amt)}</td>
                        <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,textAlign:"right"}}>{fmt(r.vat)}</td>
                        <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,textAlign:"right",fontWeight:600}}>{fmt(r.total)}</td>
                        <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,fontSize:11}}>{r.ref}</td>
                        <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,fontSize:11}}>{r.actAcc}</td>
                        <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,fontSize:11}}>{r.date}</td>
                      </tr>
                    ))}
                    <tr style={{background:P.ep,fontWeight:700}}>
                      <td colSpan={5} style={{padding:"8px 10px",fontSize:12}}>Total — {drill.records.length} records</td>
                      <td style={{padding:"8px 10px",textAlign:"right",fontWeight:700,color:P.em}}>{fmt(drill.records.reduce((s,r)=>s+(Number(r.amt)||0),0))}</td>
                      <td style={{padding:"8px 10px",textAlign:"right"}}>{fmt(drill.records.reduce((s,r)=>s+(Number(r.vat)||0),0))}</td>
                      <td style={{padding:"8px 10px",textAlign:"right",fontWeight:700,color:P.em}}>{fmt(drill.records.reduce((s,r)=>s+(Number(r.total)||0),0))}</td>
                      <td colSpan={3}></td>
                    </tr>
                  </tbody>
                </table>
              ) : (
                <div style={{textAlign:"center",padding:30,color:P.tm,fontStyle:"italic"}}>No source records found for this cell</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function InvTab({data,set,contracts,year,client}) {
  const poList = (contracts||[]).filter(c=>c.type==="PO"&&c.po).map(c=>c.po);
  const poOpts = [{v:"",l:"— None —"},...poList.map(p=>({v:p,l:p}))];
  const [f,sF] = useState({client:"",site:SITES[0],month:MONTHS[0],cat:REV_CATS[0],amt:"",vat:"",inv_no:"",date:"",comments:"",act_acc:"ACTUAL",po_no:""});
  const add = () => { if(!f.amt) return; const a=parseFloat(f.amt); const v=parseFloat(f.vat)||a*.24; set(p=>[...p,{...f,id:uid(),amt:a,vat:v,total:a+v}]); sF(x=>({...x,amt:"",vat:"",inv_no:"",date:"",comments:"",po_no:""})); };
  return (
    <div>
      <h2 style={{color:P.em,fontSize:16,fontWeight:700,margin:"0 0 16px"}}>CBRE Invoices — Revenue</h2>
      <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,padding:14,marginBottom:16,display:"flex",flexWrap:"wrap",gap:8,alignItems:"end"}}>
        <Sel l="Site" v={f.site} set={v=>sF(x=>({...x,site:v}))} opts={SITES.map(s=>({v:s,l:s}))} w={90} />
        <Sel l="Month" v={f.month} set={v=>sF(x=>({...x,month:v}))} opts={MONTHS.map(m=>({v:m,l:ML[m]}))} w={100} />
        <Sel l="Revenue Category" v={f.cat} set={v=>sF(x=>({...x,cat:v}))} opts={REV_CATS.map(c=>({v:c,l:c}))} w={200} />
        <Inp l="Amount €" v={f.amt} set={v=>sF(x=>({...x,amt:v}))} w={110} t="number" />
        <Inp l="VAT €" v={f.vat} set={v=>sF(x=>({...x,vat:v}))} w={90} t="number" />
        <Inp l="Invoice No" v={f.inv_no} set={v=>sF(x=>({...x,inv_no:v}))} w={110} />
        <Inp l="Date" v={f.date} set={v=>sF(x=>({...x,date:v}))} w={100} />
        <Sel l="Actual/Accrual" v={f.act_acc} set={v=>sF(x=>({...x,act_acc:v}))} opts={[{v:"ACTUAL",l:"ACTUAL"},{v:"ACCRUAL",l:"ACCRUAL"}]} w={110} />
        <Sel l="PO No" v={f.po_no||""} set={v=>sF(x=>({...x,po_no:v}))} opts={poOpts} w={120} />
        <Inp l="Comments" v={f.comments} set={v=>sF(x=>({...x,comments:v}))} w={120} />
        <button onClick={add} style={{background:P.em,color:"#fff",border:"none",padding:"7px 18px",borderRadius:6,cursor:"pointer",fontSize:13,fontWeight:600}}>+ Add</button>
      </div>
      <Tbl cols={[
        {k:"month",l:"Month",opts:MONTHS.map(m=>({v:m,l:ML[m]})),mw:90},
        {k:"site",l:"Site",opts:SITES.map(s=>({v:s,l:s})),mw:70},
        {k:"cat",l:"Revenue Cat",opts:REV_CATS.map(c=>({v:c,l:c})),mw:150},
        {k:"amt",l:"Amount €",a:"right",edit:true,t:"number",mw:90},
        {k:"vat",l:"VAT 24%",a:"right",edit:true,t:"number",mw:80},
        {k:"total",l:"Total €",a:"right",r:fmt},
        {k:"inv_no",l:"Invoice No",edit:true,mw:90},
        {k:"date",l:"Date",edit:true,mw:85},
        {k:"comments",l:"Comments",edit:true,mw:100},
        {k:"act_acc",l:"Act/Acc",opts:[{v:"ACTUAL",l:"ACTUAL"},{v:"ACCRUAL",l:"ACCRUAL"}],mw:90},
        {k:"po_no",l:"PO No",opts:poOpts,mw:100},
        {k:"paid",l:"Πληρωμή",opts:[{v:"",l:"Unpaid"},{v:"paid",l:"Paid"}],mw:80},
        {k:"docId",l:"File",mw:80,r:(v,row)=>row&&row.docId?(<span style={{whiteSpace:"nowrap"}}><a href="#" onClick={async e=>{e.preventDefault();try{window.open(await api.getFileLink(year,client,row.docId),"_blank");}catch{alert("Could not open file");}}} title="Preview" style={{textDecoration:"none",marginRight:8,fontSize:15}}>👁</a><a href="#" onClick={async e=>{e.preventDefault();try{window.location.assign(await api.getFileLink(year,client,row.docId,true));}catch{alert("Could not download file");}}} title="Download" style={{textDecoration:"none",fontSize:15}}>⬇</a></span>):<span style={{color:P.tm}}>—</span>}
      ]} data={data} del={id=>set(p=>p.filter(x=>x.id!==id))} onEdit={(id,k,v)=>set(p=>p.map(r=>r.id===id?{...r,[k]:v,total:k==="amt"||k==="vat"?(k==="amt"?parseFloat(v)||0:r.amt)+(k==="vat"?parseFloat(v)||0:r.vat):r.total}:r))} />
    </div>
  );
}

export function SubTab({data,set,contracts,year,client}) {
  const activeFee = (contracts||[]).find(c=>c.status==="Active"&&c.type==="MSA")?.fee_pct || 5.5;
  const [f,sF] = useState({site:SITES[0],month:MONTHS[0],cat:COST_CATS[0],gl:"",supplier:"",svc_cat:SVC_CATS[0],svc_desc:"",inv_no:"",date:"",amt:"",vat:"",act_acc:"ACTUAL",comments:"",fee_pct:activeFee});
  const add = () => { if(!f.amt) return; const a=parseFloat(f.amt); const v2=parseFloat(f.vat)||a*.24; const fp=parseFloat(f.fee_pct)||activeFee; const fee=a*fp/100; set(p=>[...p,{...f,id:uid(),amt:a,vat:v2,total:a+v2,fee_pct:fp,cbre_fee:Math.round(fee*100)/100,cbre_bill:Math.round((a+fee)*100)/100}]); sF(x=>({...x,gl:"",supplier:"",svc_desc:"",inv_no:"",date:"",amt:"",vat:"",comments:""})); };
  const edit = (id,k,v) => set(p=>p.map(r=>{
    if(r.id!==id) return r;
    const u={...r,[k]:v}; const amt=k==="amt"?(parseFloat(v)||0):r.amt; const vat=k==="vat"?(parseFloat(v)||0):r.vat;
    const fp=k==="fee_pct"?(parseFloat(v)||0):(r.fee_pct||activeFee);
    u.total=amt+vat; u.fee_pct=fp; u.cbre_fee=Math.round(amt*fp/100*100)/100; u.cbre_bill=Math.round((amt+u.cbre_fee)*100)/100;
    return u;
  }));
  return (
    <div>
      <h2 style={{color:P.em,fontSize:16,fontWeight:700,margin:"0 0 6px"}}>Subcontractor Invoices</h2>
      <p style={{fontSize:13,color:P.tm,margin:"0 0 16px"}}>Contract fee: <strong style={{color:P.em}}>{activeFee}%</strong> (from active MSA)</p>
      <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,padding:14,marginBottom:16,display:"flex",flexWrap:"wrap",gap:8,alignItems:"end"}}>
        <Sel l="Month" v={f.month} set={v=>sF(x=>({...x,month:v}))} opts={MONTHS.map(m=>({v:m,l:ML[m]}))} w={100} />
        <Sel l="Cost Cat" v={f.cat} set={v=>sF(x=>({...x,cat:v}))} opts={COST_CATS.map(c=>({v:c,l:c}))} w={190} />
        <Inp l="Supplier" v={f.supplier} set={v=>sF(x=>({...x,supplier:v}))} w={130} />
        <Sel l="Service" v={f.svc_cat} set={v=>sF(x=>({...x,svc_cat:v}))} opts={SVC_CATS.map(c=>({v:c,l:c}))} w={150} />
        <Inp l="Description" v={f.svc_desc||""} set={v=>sF(x=>({...x,svc_desc:v}))} w={120} />
        <Inp l="Invoice No" v={f.inv_no||""} set={v=>sF(x=>({...x,inv_no:v}))} w={100} />
        <Inp l="Date" v={f.date||""} set={v=>sF(x=>({...x,date:v}))} w={90} />
        <Inp l="Amount €" v={f.amt} set={v=>sF(x=>({...x,amt:v}))} w={95} t="number" />
        <Inp l="Fee %" v={f.fee_pct} set={v=>sF(x=>({...x,fee_pct:v}))} w={55} t="number" />
        <Sel l="Act/Acc" v={f.act_acc} set={v=>sF(x=>({...x,act_acc:v}))} opts={[{v:"ACTUAL",l:"ACTUAL"},{v:"ACCRUAL",l:"ACCRUAL"}]} w={90} />
        <Inp l="Comments" v={f.comments||""} set={v=>sF(x=>({...x,comments:v}))} w={110} />
        <button onClick={add} style={{background:P.em,color:"#fff",border:"none",padding:"7px 18px",borderRadius:6,cursor:"pointer",fontSize:13,fontWeight:600}}>+ Add</button>
      </div>
      <Tbl cols={[
        {k:"month",l:"Month",opts:MONTHS.map(m=>({v:m,l:ML[m]})),mw:90},
        {k:"cat",l:"Sub Category",opts:COST_CATS.map(c=>({v:c,l:c})),mw:140},
        {k:"supplier",l:"Supplier",edit:true,mw:120},
        {k:"svc_cat",l:"Service",opts:SVC_CATS.map(c=>({v:c,l:c})),mw:120},
        {k:"svc_desc",l:"Description",edit:true,mw:120},
        {k:"inv_no",l:"Inv No",edit:true,mw:80},
        {k:"date",l:"Date",edit:true,mw:80},
        {k:"amt",l:"Amount €",a:"right",edit:true,t:"number",mw:80},
        {k:"vat",l:"VAT €",a:"right",edit:true,t:"number",mw:70},
        {k:"total",l:"Total €",a:"right",r:fmt},
        {k:"fee_pct",l:"Fee %",a:"right",edit:true,t:"number",mw:55},
        {k:"cbre_fee",l:"CBRE Fee €",a:"right",r:fmt},
        {k:"cbre_bill",l:"CBRE Billing €",a:"right",r:fmt},
        {k:"act_acc",l:"Act/Acc",opts:[{v:"ACTUAL",l:"ACTUAL"},{v:"ACCRUAL",l:"ACCRUAL"}],mw:90},
        {k:"comments",l:"Comments",edit:true,mw:100},
        {k:"paid",l:"Πληρωμή",opts:[{v:"",l:"Unpaid"},{v:"paid",l:"Paid"}],mw:80},
        {k:"docId",l:"File",mw:80,r:(v,row)=>row&&row.docId?(<span style={{whiteSpace:"nowrap"}}><a href="#" onClick={async e=>{e.preventDefault();try{window.open(await api.getFileLink(year,client,row.docId),"_blank");}catch{alert("Could not open file");}}} title="Preview" style={{textDecoration:"none",marginRight:8,fontSize:15}}>👁</a><a href="#" onClick={async e=>{e.preventDefault();try{window.location.assign(await api.getFileLink(year,client,row.docId,true));}catch{alert("Could not download file");}}} title="Download" style={{textDecoration:"none",fontSize:15}}>⬇</a></span>):<span style={{color:P.tm}}>—</span>}
      ]} data={data} del={id=>set(p=>p.filter(x=>x.id!==id))} onEdit={edit} />
    </div>
  );
}

export function AccTab({inv,sub}) {
  const thS = {padding:"6px 8px",textAlign:"center",fontSize:10,fontWeight:700,color:"#fff",background:P.em,whiteSpace:"nowrap"};
  const cellS = {padding:"6px 8px",textAlign:"right",fontSize:12,borderBottom:"1px solid "+P.bd};

  // Revenue accruals from CBRE Invoices where act_acc=ACCRUAL, split by sign
  const revAcc = (cat,m,sign) => inv.filter(i=>i.month===m&&(i.act_acc||"").toUpperCase()==="ACCRUAL"&&(i.cat||"").includes(cat)&&(sign==="+"?(Number(i.amt)||0)>0:(Number(i.amt)||0)<0)).reduce((s,i)=>s+(Number(i.amt)||0),0);
  const revAccAll = (cat,m) => inv.filter(i=>i.month===m&&(i.act_acc||"").toUpperCase()==="ACCRUAL"&&(i.cat||"").includes(cat)).reduce((s,i)=>s+(Number(i.amt)||0),0);
  // Expense accruals from Sub Invoices where act_acc=ACCRUAL
  const costAcc = (cat,m) => sub.filter(i=>i.month===m&&(i.act_acc||"").toUpperCase()==="ACCRUAL"&&(i.cat||"").toUpperCase().includes(cat)).reduce((s,i)=>s+(Number(i.amt)||0),0);

  const cats = ["FM Core","FM Extra Works","PJMs"];
  const costCats = ["CORE","EXTRA","PJM"];
  const catLabels = ["FM Core","FM Extra Works","FM PJMs"];

  const sections = [
    {t:"Revenue Accruals — UBR (Unbilled Revenue)",sub:"UBR",rows:cats.map((c,i)=>({l:catLabels[i],fn:m=>revAcc(c,m,"+")}))},
    {t:"Revenue Accruals — UER (Unearned Revenue)",sub:"UER",rows:cats.map((c,i)=>({l:catLabels[i],fn:m=>revAcc(c,m,"-")}))},
    {t:"Expense Accruals (from Sub Invoices — Accrual entries)",sub:"Total",rows:costCats.map((c,i)=>({l:catLabels[i],fn:m=>costAcc(c,m)}))},
  ];

  return (
    <div>
      <h2 style={{color:P.em,fontSize:16,fontWeight:700,margin:"0 0 6px"}}>Accruals</h2>
      <p style={{fontSize:12,color:P.tm,margin:"0 0 16px"}}>Auto-populated from invoices marked as ACCRUAL — read-only</p>
      {sections.map(sec => (
        <div key={sec.t} style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,marginBottom:16}}>
          <div style={{background:sec.bold?"#00695C":P.ep,padding:"10px 16px",fontWeight:700,fontSize:13,color:sec.bold?"#fff":P.em}}>{sec.t}</div>
          <div style={{overflowX:"auto"}}>
            <table style={{width:"100%",borderCollapse:"collapse",tableLayout:"fixed",minWidth:1100}}>
              <colgroup>
                <col style={{width:150}} />
                {MONTHS.map(m=><col key={m} style={{width:75}} />)}
                <col style={{width:95}} />
              </colgroup>
              <thead><tr>
                <th style={{...thS,textAlign:"left",borderRight:"2px solid #00695C"}}>Category</th>
                {MONTHS.map(m=><th key={m} style={thS}>{ML[m]}</th>)}
                <th style={{...thS,background:"#00695C"}}>Total</th>
              </tr></thead>
              <tbody>
                {sec.rows.map((r,ri) => {
                  const total = MONTHS.reduce((s,m)=>s+r.fn(m),0);
                  return (
                    <tr key={r.l+ri} style={{background:ri%2===0?P.wh:P.al}}>
                      <td style={{padding:"6px 10px",fontSize:12,fontWeight:500,borderBottom:"1px solid "+P.bd,borderRight:"2px solid "+P.bd}}>{r.l}</td>
                      {MONTHS.map(m => {
                        const v = r.fn(m);
                        return <td key={m} style={{...cellS,color:v<0?P.rd:v>0?P.em:P.tm,fontWeight:v!==0?600:400}}>{v!==0?fmt(v):"-"}</td>;
                      })}
                      <td style={{...cellS,fontWeight:700,color:total<0?P.rd:P.em,background:"#f5f5f5",borderLeft:"2px solid "+P.bd}}>{total!==0?fmt(total):"-"}</td>
                    </tr>
                  );
                })}
                <tr style={{background:P.ep}}>
                  <td style={{padding:"8px 10px",fontSize:12,fontWeight:700,borderRight:"2px solid #00695C"}}>Sub-Total {sec.sub}</td>
                  {MONTHS.map(m => {
                    const v = sec.rows.reduce((s,r)=>s+r.fn(m),0);
                    return <td key={m} style={{padding:"6px 8px",textAlign:"right",fontSize:12,fontWeight:700,color:v<0?P.rd:P.em}}>{fmt(v)}</td>;
                  })}
                  <td style={{padding:"6px 8px",textAlign:"right",fontSize:13,fontWeight:700,color:P.em,background:"#C8E6C9",borderLeft:"2px solid #00695C"}}>
                    {fmt(MONTHS.reduce((x,m)=>x+sec.rows.reduce((s,r)=>s+r.fn(m),0),0))}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

export function LabTab({data,set,alloc,setAlloc}) {
  const up = (m,k,v) => set(p => ({...p,[m]:{...p[m],[k]:parseFloat(v)||0}}));
  const A = alloc || {};
  const av = (m,seg) => { const a=A[m]; return a && a[seg]!==undefined ? a[seg] : (seg==="core"?100:0); };
  const upA = (m,seg,v) => setAlloc && setAlloc({...A,[m]:{core:av(m,"core"),ew:av(m,"ew"),pjm:av(m,"pjm"),[seg]:parseFloat(v)||0}});
  const ALLOC_SEGS = [{k:"core",l:"FM Core"},{k:"ew",l:"FM Extra Works"},{k:"pjm",l:"FM PJM"}];
  const monthLabTotal = m => LAB_ROWS.reduce((s,r)=>s+(Number(data[m]?.[r.k])||0),0);
  const thS = {padding:"6px 8px",textAlign:"center",fontSize:10,fontWeight:700,color:"#fff",background:P.em,whiteSpace:"nowrap"};
  const inpS = {width:"100%",padding:"4px 5px",border:"1px solid "+P.bd,borderRadius:3,fontSize:11,textAlign:"right",background:P.ip,outline:"none",boxSizing:"border-box"};
  return (
    <div>
      <h2 style={{color:P.em,fontSize:16,fontWeight:700,margin:"0 0 16px"}}>Labour Cost</h2>
      <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd}}>
        <div style={{overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse",tableLayout:"fixed",minWidth:1100}}>
            <colgroup>
              <col style={{width:150}} />
              {MONTHS.map(m=><col key={m} style={{width:75}} />)}
              <col style={{width:95}} />
            </colgroup>
            <thead><tr>
              <th style={{...thS,textAlign:"left",borderRight:"2px solid #00695C"}}>Category</th>
              {MONTHS.map(m=><th key={m} style={thS}>{ML[m]}</th>)}
              <th style={{...thS,background:"#00695C"}}>Total</th>
            </tr></thead>
            <tbody>
              {LAB_ROWS.map((r,i) => (
                <tr key={r.k} style={{background:i%2===0?P.wh:P.al}}>
                  <td style={{padding:"6px 10px",fontSize:12,fontWeight:500,borderBottom:"1px solid "+P.bd,borderRight:"2px solid "+P.bd,whiteSpace:"nowrap"}}>{r.l}</td>
                  {MONTHS.map(m => (
                    <td key={m} style={{padding:"3px 4px",borderBottom:"1px solid "+P.bd,textAlign:"center"}}>
                      <input type="number" step="0.01" value={data[m]?.[r.k]||""} onChange={e=>up(m,r.k,e.target.value)} style={inpS} />
                    </td>
                  ))}
                  <td style={{padding:"5px 8px",textAlign:"right",fontSize:12,fontWeight:700,color:P.em,borderBottom:"1px solid "+P.bd,background:"#f5f5f5",borderLeft:"2px solid "+P.bd}}>
                    {fmt(MONTHS.reduce((s,m)=>s+(Number(data[m]?.[r.k])||0),0))}
                  </td>
                </tr>
              ))}
              <tr style={{background:P.ep}}>
                <td style={{padding:"8px 10px",fontSize:12,fontWeight:700,borderRight:"2px solid #00695C"}}>SUM</td>
                {MONTHS.map(m => {
                  const v = LAB_ROWS.reduce((s,r)=>s+(Number(data[m]?.[r.k])||0),0);
                  return <td key={m} style={{padding:"6px 8px",textAlign:"right",fontSize:12,fontWeight:700,color:P.em}}>{fmt(v)}</td>;
                })}
                <td style={{padding:"6px 8px",textAlign:"right",fontSize:13,fontWeight:700,color:P.em,background:"#C8E6C9",borderLeft:"2px solid #00695C"}}>
                  {fmt(MONTHS.reduce((x,m)=>x+LAB_ROWS.reduce((s,r)=>s+(Number(data[m]?.[r.k])||0),0),0))}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Labour allocation across segments ── */}
      <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,marginTop:16}}>
        <div style={{background:P.ep,padding:"10px 16px",fontWeight:700,fontSize:13,color:P.em}}>Κατανομή Labour ανά segment (βάρη)</div>
        <div style={{padding:"6px 16px 0",fontSize:11.5,color:P.tm}}>Default 100% στο FM Core. Άλλαξε τα βάρη για να κατανεμηθεί το labour κάθε μήνα σε Core / Extra Works / PJM — το <b>συνολικό</b> κόστος labour &amp; GM δεν αλλάζει, μόνο η ανά-segment ανάλυση. Ιδανικά κάθε μήνας αθροίζει 100.</div>
        <div style={{overflowX:"auto",padding:"10px 0 4px"}}>
          <table style={{width:"100%",borderCollapse:"collapse",tableLayout:"fixed",minWidth:1100}}>
            <colgroup>
              <col style={{width:150}} />
              {MONTHS.map(m=><col key={m} style={{width:75}} />)}
              <col style={{width:95}} />
            </colgroup>
            <thead><tr>
              <th style={{...thS,textAlign:"left",borderRight:"2px solid #00695C"}}>Segment</th>
              {MONTHS.map(m=><th key={m} style={thS}>{ML[m]}</th>)}
              <th style={{...thS,background:"#00695C"}}>€ / μήνα</th>
            </tr></thead>
            <tbody>
              {ALLOC_SEGS.map((seg,i)=>(
                <tr key={seg.k} style={{background:i%2===0?P.wh:P.al}}>
                  <td style={{padding:"6px 10px",fontSize:12,fontWeight:500,borderBottom:"1px solid "+P.bd,borderRight:"2px solid "+P.bd,whiteSpace:"nowrap"}}>{seg.l}</td>
                  {MONTHS.map(m=>(
                    <td key={m} style={{padding:"3px 4px",borderBottom:"1px solid "+P.bd,textAlign:"center"}}>
                      <input type="number" step="1" value={av(m,seg.k)||""} placeholder="0" onChange={e=>upA(m,seg.k,e.target.value)} style={inpS} />
                    </td>
                  ))}
                  <td style={{padding:"5px 8px",textAlign:"right",fontSize:11,fontWeight:600,color:P.em,borderBottom:"1px solid "+P.bd,background:"#f5f5f5",borderLeft:"2px solid "+P.bd}}>
                    {(()=>{const t=MONTHS.reduce((x,m)=>{const s=av(m,"core")+av(m,"ew")+av(m,"pjm");return x+(s>0?monthLabTotal(m)*av(m,seg.k)/s:(seg.k==="core"?monthLabTotal(m):0));},0);return fmt(t);})()}
                  </td>
                </tr>
              ))}
              <tr style={{background:P.ep}}>
                <td style={{padding:"8px 10px",fontSize:12,fontWeight:700,borderRight:"2px solid #00695C"}}>Άθροισμα βαρών</td>
                {MONTHS.map(m=>{const s=av(m,"core")+av(m,"ew")+av(m,"pjm");const ok=Math.abs(s-100)<0.01;return <td key={m} style={{padding:"6px 8px",textAlign:"center",fontSize:11,fontWeight:700,color:ok?P.gn:s===0?P.tm:P.rd}} title={ok?"":"Δεν αθροίζει 100 — η κατανομή γίνεται αναλογικά"}>{s||0}</td>;})}
                <td style={{background:"#C8E6C9",borderLeft:"2px solid #00695C"}}></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export function POTracker({inv,contracts}) {
  const [open,setOpen] = useState({});
  const toggle = po => setOpen(p=>({...p,[po]:!p[po]}));
  const poContracts = (contracts||[]).filter(c=>c.type==="PO"&&c.po);
  const allPOs = [...new Set([...poContracts.map(c=>c.po),...inv.filter(i=>i.po_no).map(i=>i.po_no)])].filter(Boolean);

  const poData = allPOs.map(po => {
    const contract = poContracts.find(c=>c.po===po);
    const actuals = inv.filter(i=>i.po_no===po&&(i.act_acc||"").toUpperCase()==="ACTUAL");
    const spent = actuals.reduce((s,i)=>s+(Number(i.amt)||0),0);
    const spentTotal = actuals.reduce((s,i)=>s+(Number(i.total||i.amt+(i.vat||0))||0),0);
    const budget = contract?.po_value || 0;
    const remaining = budget - spent;
    const pct = budget ? spent/budget : 0;
    return {po,contract,actuals,spent,spentTotal,budget,remaining,pct,scope:contract?.scope||"",expiry:contract?.expiry||""};
  });

  const totalBudget = poData.reduce((s,p)=>s+p.budget,0);
  const totalSpent = poData.reduce((s,p)=>s+p.spent,0);

  return (
    <div>
      <h2 style={{color:P.em,fontSize:16,fontWeight:700,margin:"0 0 6px"}}>PO Spend Tracker</h2>
      <p style={{fontSize:13,color:P.tm,margin:"0 0 16px"}}>Actuals only (excl. accruals) — {allPOs.length} POs — Budget: €{fmt(totalBudget)} — Spent: €{fmt(totalSpent)} — Remaining: €{fmt(totalBudget-totalSpent)}</p>

      {/* Summary cards */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:14,marginBottom:20}}>
        {poData.map(pd => {
          const pctUsed = Math.min(pd.pct*100,100);
          const bc = pctUsed>90?P.rd:pctUsed>70?"#F57F17":P.gn;
          return (
            <div key={pd.po} style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,overflow:"hidden"}}>
              <div style={{background:P.em,color:"#fff",padding:"10px 14px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span style={{fontWeight:700,fontSize:14}}>PO {pd.po}</span>
                <span style={{fontSize:11,opacity:.8}}>{pd.scope}</span>
              </div>
              <div style={{padding:14}}>
                <div style={{background:"#eee",borderRadius:6,height:12,marginBottom:10,overflow:"hidden"}}>
                  <div style={{background:bc,height:"100%",width:pctUsed+"%",borderRadius:6}} />
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:8}}>
                  <div style={{textAlign:"center"}}><div style={{fontSize:10,color:P.tm}}>Budget</div><div style={{fontSize:14,fontWeight:700,color:P.em}}>€{fmt(pd.budget)}</div></div>
                  <div style={{textAlign:"center"}}><div style={{fontSize:10,color:P.tm}}>Spent (net)</div><div style={{fontSize:14,fontWeight:700,color:bc}}>€{fmt(pd.spent)}</div></div>
                  <div style={{textAlign:"center"}}><div style={{fontSize:10,color:P.tm}}>Remaining</div><div style={{fontSize:14,fontWeight:700,color:pd.remaining<0?P.rd:P.gn}}>€{fmt(pd.remaining)}</div></div>
                </div>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:P.tm}}>
                  <span>{(pd.pct*100).toFixed(1)}% consumed</span>
                  <span>{pd.actuals.length} invoices</span>
                  {pd.expiry && <span>Expires: {pd.expiry}</span>}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Collapsible invoice detail per PO */}
      {poData.map(pd => (
        <div key={pd.po} style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,marginBottom:12,overflow:"hidden"}}>
          <div onClick={()=>toggle(pd.po)} style={{background:P.ep,padding:"10px 14px",display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer",userSelect:"none"}}>
            <span style={{fontWeight:700,fontSize:13,color:P.em}}>{open[pd.po]?"▼":"▶"} PO {pd.po} — {pd.scope} ({pd.actuals.length} actuals)</span>
            <span style={{fontSize:12,fontWeight:600,color:pd.remaining<0?P.rd:P.gn}}>€{fmt(pd.spent)} / €{fmt(pd.budget)}</span>
          </div>
          {open[pd.po] && (
            <div style={{overflowX:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                <thead><tr>
                  {["Month","Category","Amount €","VAT €","Total €","Invoice No","Date"].map(h=>(
                    <th key={h} style={{padding:"6px 10px",fontSize:11,fontWeight:700,color:"#fff",background:P.em,textAlign:h.includes("€")?"right":"left"}}>{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {pd.actuals.map((iv,i) => (
                    <tr key={iv.id||i} style={{background:i%2===0?P.wh:P.al}}>
                      <td style={{padding:"5px 10px",borderBottom:"1px solid "+P.bd}}>{ML[iv.month]||iv.month}</td>
                      <td style={{padding:"5px 10px",borderBottom:"1px solid "+P.bd}}>{iv.cat}</td>
                      <td style={{padding:"5px 10px",borderBottom:"1px solid "+P.bd,textAlign:"right"}}>{fmt(iv.amt)}</td>
                      <td style={{padding:"5px 10px",borderBottom:"1px solid "+P.bd,textAlign:"right"}}>{fmt(iv.vat)}</td>
                      <td style={{padding:"5px 10px",borderBottom:"1px solid "+P.bd,textAlign:"right"}}>{fmt(iv.total||iv.amt+(iv.vat||0))}</td>
                      <td style={{padding:"5px 10px",borderBottom:"1px solid "+P.bd}}>{iv.inv_no}</td>
                      <td style={{padding:"5px 10px",borderBottom:"1px solid "+P.bd}}>{iv.date}</td>
                    </tr>
                  ))}
                  <tr style={{background:P.ep}}>
                    <td colSpan={2} style={{padding:"6px 10px",fontWeight:700}}>Total Actuals</td>
                    <td style={{padding:"6px 10px",textAlign:"right",fontWeight:700,color:P.em}}>{fmt(pd.spent)}</td>
                    <td style={{padding:"6px 10px",textAlign:"right",fontWeight:700,color:P.em}}>{fmt(pd.actuals.reduce((s,i)=>s+(Number(i.vat)||0),0))}</td>
                    <td style={{padding:"6px 10px",textAlign:"right",fontWeight:700,color:P.em}}>{fmt(pd.spentTotal)}</td>
                    <td colSpan={2}></td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

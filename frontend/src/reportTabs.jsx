// Client monthly-report sub-tabs, extracted from App.jsx.
//   PnL       — Profit & Loss with click-to-drill-down to source records.
//   InvTab    — CBRE revenue invoices grid.
//   SubTab    — Subcontractor invoices grid (with CBRE fee calc).
//   AccTab    — Accruals (read-only, derived from ACCRUAL-flagged invoices).
//   LabTab    — Labour cost grid + per-month segment allocation.
//   POTracker — PO spend tracker (budget vs actuals).
import { useState } from "react";
import { api } from "./api.js";
import { MONTHS, ML, P, fmt, fPct, uid, SITES, REV_CATS, COST_CATS, SVC_CATS, LAB_ROWS, LAB_SEG_ROWS, LAB_ALL_ROWS, LAB_EW_KEY, LAB_PJM_KEY } from "./constants.js";
import { Inp, Sel, Tbl } from "./ui.jsx";
import { useT, monthLabel, catLabel } from "./i18n.jsx";

export function PnL({inv,sub,lab}) {
  const { t } = useT();
  const [drill,setDrill] = useState(null);
  const pnl = {};
  MONTHS.forEach(m => {
    const rc = inv.filter(i=>i.month===m&&i.cat==="CLIENT REVENUE - FM Core").reduce((s,i)=>s+i.amt,0);
    const re = inv.filter(i=>i.month===m&&i.cat==="CLIENT REVENUE - FM Extra Works").reduce((s,i)=>s+i.amt,0);
    const rp = inv.filter(i=>i.month===m&&i.cat==="CLIENT REVENUE - PJMs").reduce((s,i)=>s+i.amt,0);
    const sc = sub.filter(i=>i.month===m&&(i.cat||"").toUpperCase().includes("CORE")).reduce((s,i)=>s+i.amt,0);
    const se = sub.filter(i=>i.month===m&&((i.cat||"").toUpperCase().includes("EXRA")||(i.cat||"").toUpperCase().includes("EXTRA"))).reduce((s,i)=>s+i.amt,0);
    const sp = sub.filter(i=>i.month===m&&(i.cat||"").toUpperCase().includes("PJM")).reduce((s,i)=>s+i.amt,0);
    // Labour per segment comes from ACTUAL amounts entered on the Labour tab:
    //   FM Core = sum of the 6 core components; Extra Works / PJM = their own direct lines.
    const lc = LAB_ROWS.reduce((s,r)=>s+(Number(lab[m]?.[r.k])||0),0);
    const lc_ew = Number(lab[m]?.[LAB_EW_KEY])||0;
    const lc_pjm = Number(lab[m]?.[LAB_PJM_KEY])||0;
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
      const pushLab = (m,label,v)=>{ if(Number(v)) recs.push({type:"Labour",month:m,cat:label,desc:label,supplier:"-",amt:Number(v),vat:0,total:Number(v),ref:"-",actAcc:"-",date:"-"}); };
      monthsScope.forEach(m => {
        if(!lab[m]) return;
        if(key==="lc"||key==="lc_total") LAB_ROWS.forEach(r=>pushLab(m,r.l,lab[m][r.k]));
        if(key==="lc_ew"||key==="lc_total") pushLab(m,"FM Extra Works Labour",lab[m][LAB_EW_KEY]);
        if(key==="lc_pjm"||key==="lc_total") pushLab(m,"FM PJM Labour",lab[m][LAB_PJM_KEY]);
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
      // Labour attributable to this GM segment (direct actuals: core = 6 components, ew/pjm = their own line)
      const pushNegLab = (m,label,v)=>{ if(Number(v)) recs.push({type:"Labour",month:m,cat:label,desc:label,supplier:"-",amt:-Number(v),vat:0,total:-Number(v),ref:"-",actAcc:"-",date:"-"}); };
      monthsScope.forEach(m => {
        if(!lab[m]) return;
        if(key==="gm"||key==="gc") LAB_ROWS.forEach(r=>pushNegLab(m,r.l,lab[m][r.k]));
        if(key==="gm"||key==="ge") pushNegLab(m,"FM Extra Works Labour",lab[m][LAB_EW_KEY]);
        if(key==="gm"||key==="gp") pushNegLab(m,"FM PJM Labour",lab[m][LAB_PJM_KEY]);
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
    {l:t("ΕΣΟΔΑ ΠΕΛΑΤΗ - FM Core","CLIENT REVENUE - FM Core"),k:"rc"},{l:t("ΕΣΟΔΑ ΠΕΛΑΤΗ - Πρόσθετες Εργασίες","CLIENT REVENUE - FM Extra Works"),k:"re"},{l:t("ΕΣΟΔΑ ΠΕΛΑΤΗ - Έργα (PJMs)","CLIENT REVENUE - PJMs"),k:"rp"},
    {l:t("Σύνολο Πωλήσεων / Εσόδων","Total Sales / Revenue"),k:"tr",b:true},{l:"_"},
    {l:t("Κόστος Εργασίας - FM Core","Labour Cost - FM Core"),k:"lc"},{l:t("Κόστος Εργασίας - Πρόσθετες Εργασίες","Labour Cost - FM Extra Works"),k:"lc_ew"},{l:t("Κόστος Εργασίας - Έργα (PJMs)","Labour Cost - PJMs"),k:"lc_pjm"},
    {l:t("Σύνολο Κόστους Εργασίας","Total Labour Cost"),k:"lc_total",b:true},{l:"_"},
    {l:t("Κόστος Υπεργολάβων - FM Core","CLIENT Subcontractors cost - FM Core"),k:"sc"},{l:t("Κόστος Υπεργολάβων - Πρόσθετες Εργασίες","CLIENT Subcontractors cost - FM Extra Works"),k:"se"},{l:t("Κόστος Υπεργολάβων - Έργα (PJMs)","CLIENT Subcontractors cost - PJMs"),k:"sp"},
    {l:t("Σύνολο Υπεργολάβων","Total Subcontractor"),k:"sub_total",b:true},{l:"_"},
    {l:t("Συνολικό Κόστος","Total Cost"),k:"tc",b:true},{l:"_"},
    {l:t("GM - Σύνολο","GM - Total"),k:"gm",b:true,g:true},{l:t("GM - Σύνολο %","GM - Total %"),k:"gm_pct",pct:true,b:true},{l:"_"},
    {l:"GM - FM Core",k:"gc",g:true},{l:"GM - FM Core %",k:"gc_pct",pct:true},
    {l:t("GM - Πρόσθετες Εργασίες","GM - FM Extra Works"),k:"ge",g:true},{l:t("GM - Πρόσθετες Εργασίες %","GM - FM Extra Works %"),k:"ge_pct",pct:true},
    {l:t("GM - Έργα (PJM)","GM - FM PJM"),k:"gp",g:true},
  ];

  const H = {padding:"8px 12px",textAlign:"right",fontSize:12,fontWeight:700,color:"#fff",background:P.em,position:"sticky",top:0};
  const D = {padding:"7px 12px",textAlign:"right",fontSize:12,borderBottom:"1px solid "+P.bd};

  return (
    <div>
      <h2 style={{color:P.em,fontSize:16,fontWeight:700,margin:"0 0 6px"}}>{t("Κατάσταση Αποτελεσμάτων (EUR)","Profit & Loss (EUR)")}</h2>
      <p style={{fontSize:11,color:P.tm,margin:"0 0 16px"}}>💡 {t("Κάνε κλικ σε οποιονδήποτε αριθμό για ανάλυση στις πηγές","Click any number to drill down to source records")}</p>
      <div style={{overflowX:"auto",background:P.wh,borderRadius:8,border:"1px solid "+P.bd}}>
        <table style={{width:"100%",borderCollapse:"collapse",minWidth:600}}>
          <thead><tr><th style={{...H,textAlign:"left",minWidth:220}}>{t("Γραμμή","Line")}</th>{am.map(m=><th key={m} style={H}>{monthLabel(m)}</th>)}<th style={H}>YTD</th></tr></thead>
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
                <div style={{fontWeight:700,fontSize:16}}>{drill.label} — {drill.month==="ytd"?t("Σύνολο YTD","YTD Total"):monthLabel(drill.month)}</div>
                <div style={{fontSize:12,opacity:.8,marginTop:2}}>{t("Σύνολο","Total")}: €{fmt(drill.value)} · {drill.records.length} {t("εγγραφές","records")}</div>
              </div>
              <button onClick={()=>setDrill(null)} style={{background:"rgba(255,255,255,.2)",border:"none",color:"#fff",padding:"6px 14px",borderRadius:6,cursor:"pointer",fontSize:14,fontWeight:700}}>✕</button>
            </div>
            <div style={{padding:20}}>
              {drill.records.length>0 ? (
                <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                  <thead><tr>{[["Type",t("Τύπος","Type")],["Month",t("Μήνας","Month")],["Category",t("Κατηγορία","Category")],["Description",t("Περιγραφή","Description")],["Supplier/Site",t("Προμηθευτής/Site","Supplier/Site")],["Amount €",t("Ποσό €","Amount €")],["VAT",t("ΦΠΑ","VAT")],["Total €",t("Σύνολο €","Total €")],["Reference",t("Αναφορά","Reference")],["Act/Acc","Act/Acc"],["Date",t("Ημ/νία","Date")]].map(([k,h])=>(
                    <th key={k} style={{padding:"8px 10px",fontSize:11,fontWeight:700,color:"#fff",background:P.em,textAlign:k.includes("€")||k==="VAT"?"right":"left",position:"sticky",top:0}}>{h}</th>
                  ))}</tr></thead>
                  <tbody>
                    {drill.records.sort((a,b)=>a.month.localeCompare(b.month)).map((r,i)=>(
                      <tr key={i} style={{background:i%2===0?P.wh:P.al}}>
                        <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,fontSize:11}}>
                          <span style={{padding:"1px 8px",borderRadius:8,background:r.type==="Revenue"?"#E8F5E9":r.type==="Sub Cost"?"#FFEBEE":"#FFF8E1",color:r.type==="Revenue"?P.gn:r.type==="Sub Cost"?P.rd:"#F57F17",fontSize:10,fontWeight:600}}>{r.type}</span>
                        </td>
                        <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd}}>{monthLabel(r.month)}</td>
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
                      <td colSpan={5} style={{padding:"8px 10px",fontSize:12}}>{t("Σύνολο","Total")} — {drill.records.length} {t("εγγραφές","records")}</td>
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
  const { t } = useT();
  const poList = (contracts||[]).filter(c=>c.type==="PO"&&c.po).map(c=>c.po);
  const poOpts = [{v:"",l:t("— Κανένα —","— None —")},...poList.map(p=>({v:p,l:p}))];
  const [f,sF] = useState({client:"",site:SITES[0],month:MONTHS[0],cat:REV_CATS[0],amt:"",vat:"",inv_no:"",date:"",comments:"",act_acc:"ACTUAL",po_no:""});
  // Blank VAT → default 24%; an explicitly typed 0 stays 0 (zero-rated / reverse-charge invoices).
  const add = () => { if(!f.amt) return; const a=parseFloat(f.amt); const pv=parseFloat(f.vat); const v=Number.isNaN(pv)?a*.24:pv; set(p=>[...p,{...f,id:uid(),amt:a,vat:v,total:a+v}]); sF(x=>({...x,amt:"",vat:"",inv_no:"",date:"",comments:"",po_no:""})); };
  return (
    <div>
      <h2 style={{color:P.em,fontSize:16,fontWeight:700,margin:"0 0 16px"}}>{t("Τιμολόγια CBRE — Έσοδα","CBRE Invoices — Revenue")}</h2>
      <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,padding:14,marginBottom:16,display:"flex",flexWrap:"wrap",gap:8,alignItems:"end"}}>
        <Sel l="Site" v={f.site} set={v=>sF(x=>({...x,site:v}))} opts={SITES.map(s=>({v:s,l:s}))} w={90} />
        <Sel l={t("Μήνας","Month")} v={f.month} set={v=>sF(x=>({...x,month:v}))} opts={MONTHS.map(m=>({v:m,l:monthLabel(m)}))} w={100} />
        <Sel l={t("Κατηγορία Εσόδων","Revenue Category")} v={f.cat} set={v=>sF(x=>({...x,cat:v}))} opts={REV_CATS.map(c=>({v:c,l:catLabel(c)}))} w={200} />
        <Inp l={t("Ποσό €","Amount €")} v={f.amt} set={v=>sF(x=>({...x,amt:v}))} w={110} t="number" />
        <Inp l={t("ΦΠΑ €","VAT €")} v={f.vat} set={v=>sF(x=>({...x,vat:v}))} w={90} t="number" />
        <Inp l={t("Αρ. Τιμολογίου","Invoice No")} v={f.inv_no} set={v=>sF(x=>({...x,inv_no:v}))} w={110} />
        <Inp l={t("Ημ/νία","Date")} v={f.date} set={v=>sF(x=>({...x,date:v}))} w={100} />
        <Sel l="Actual/Accrual" v={f.act_acc} set={v=>sF(x=>({...x,act_acc:v}))} opts={[{v:"ACTUAL",l:"ACTUAL"},{v:"ACCRUAL",l:"ACCRUAL"}]} w={110} />
        <Sel l="PO No" v={f.po_no||""} set={v=>sF(x=>({...x,po_no:v}))} opts={poOpts} w={120} />
        <Inp l={t("Σχόλια","Comments")} v={f.comments} set={v=>sF(x=>({...x,comments:v}))} w={120} />
        <button onClick={add} style={{background:P.em,color:"#fff",border:"none",padding:"7px 18px",borderRadius:6,cursor:"pointer",fontSize:13,fontWeight:600}}>+ {t("Προσθήκη","Add")}</button>
      </div>
      <Tbl cols={[
        {k:"month",l:t("Μήνας","Month"),opts:MONTHS.map(m=>({v:m,l:monthLabel(m)})),mw:90},
        {k:"site",l:"Site",opts:SITES.map(s=>({v:s,l:s})),mw:70},
        {k:"cat",l:t("Κατ. Εσόδων","Revenue Cat"),opts:REV_CATS.map(c=>({v:c,l:catLabel(c)})),mw:150},
        {k:"amt",l:t("Ποσό €","Amount €"),a:"right",edit:true,t:"number",mw:90},
        {k:"vat",l:t("ΦΠΑ 24%","VAT 24%"),a:"right",edit:true,t:"number",mw:80},
        {k:"total",l:t("Σύνολο €","Total €"),a:"right",r:fmt},
        {k:"inv_no",l:t("Αρ. Τιμολ.","Invoice No"),edit:true,mw:90},
        {k:"date",l:t("Ημ/νία","Date"),edit:true,mw:85},
        {k:"comments",l:t("Σχόλια","Comments"),edit:true,mw:100},
        {k:"act_acc",l:"Act/Acc",opts:[{v:"ACTUAL",l:"ACTUAL"},{v:"ACCRUAL",l:"ACCRUAL"}],mw:90},
        {k:"po_no",l:"PO No",opts:poOpts,mw:100},
        {k:"paid",l:t("Πληρωμή","Payment"),opts:[{v:"",l:t("Απλήρωτο","Unpaid")},{v:"paid",l:t("Πληρωμένο","Paid")}],mw:80},
        {k:"docId",l:t("Αρχείο","File"),mw:80,r:(v,row)=>row&&row.docId?(<span style={{whiteSpace:"nowrap"}}><a href="#" onClick={async e=>{e.preventDefault();try{window.open(await api.getFileLink(year,client,row.docId),"_blank");}catch{alert(t("Αδυναμία ανοίγματος αρχείου","Could not open file"));}}} title={t("Προεπισκόπηση","Preview")} style={{textDecoration:"none",marginRight:8,fontSize:15}}>👁</a><a href="#" onClick={async e=>{e.preventDefault();try{window.location.assign(await api.getFileLink(year,client,row.docId,true));}catch{alert(t("Αδυναμία λήψης αρχείου","Could not download file"));}}} title={t("Λήψη","Download")} style={{textDecoration:"none",fontSize:15}}>⬇</a></span>):<span style={{color:P.tm}}>—</span>}
      ]} data={data} del={id=>{const row=(data||[]).find(x=>x.id===id); if(row&&row.docId) api.deleteFile(year,client,row.docId).catch(()=>{}); set(p=>p.filter(x=>x.id!==id));}} onEdit={(id,k,v)=>set(p=>p.map(r=>{
        if(r.id!==id) return r;
        const u={...r,[k]:v};
        if(k==="amt"||k==="vat") u.total=(k==="amt"?parseFloat(v)||0:r.amt)+(k==="vat"?parseFloat(v)||0:r.vat);
        // Stamp/clear the payment date so open-AR aging & the balance sheet know WHEN it settled.
        if(k==="paid") u.paid_date = v==="paid" ? (r.paid_date || new Date().toISOString().slice(0,10)) : "";
        return u;
      }))} />
    </div>
  );
}

export function SubTab({data,set,contracts,year,client}) {
  const { t } = useT();
  const activeFee = (contracts||[]).find(c=>c.status==="Active"&&c.type==="MSA")?.fee_pct || 5.5;
  const [f,sF] = useState({site:SITES[0],month:MONTHS[0],cat:COST_CATS[0],gl:"",supplier:"",svc_cat:SVC_CATS[0],svc_desc:"",inv_no:"",date:"",amt:"",vat:"",act_acc:"ACTUAL",comments:"",fee_pct:activeFee});
  // Blank VAT → default 24%; an explicitly typed 0 stays 0 (zero-rated / reverse-charge invoices).
  const add = () => { if(!f.amt) return; const a=parseFloat(f.amt); const pv=parseFloat(f.vat); const v2=Number.isNaN(pv)?a*.24:pv; const fp=parseFloat(f.fee_pct)||activeFee; const fee=a*fp/100; set(p=>[...p,{...f,id:uid(),amt:a,vat:v2,total:a+v2,fee_pct:fp,cbre_fee:Math.round(fee*100)/100,cbre_bill:Math.round((a+fee)*100)/100}]); sF(x=>({...x,gl:"",supplier:"",svc_desc:"",inv_no:"",date:"",amt:"",vat:"",comments:""})); };
  const edit = (id,k,v) => set(p=>p.map(r=>{
    if(r.id!==id) return r;
    const u={...r,[k]:v}; const amt=k==="amt"?(parseFloat(v)||0):r.amt; const vat=k==="vat"?(parseFloat(v)||0):r.vat;
    const fp=k==="fee_pct"?(parseFloat(v)||0):(r.fee_pct||activeFee);
    u.total=amt+vat; u.fee_pct=fp; u.cbre_fee=Math.round(amt*fp/100*100)/100; u.cbre_bill=Math.round((amt+u.cbre_fee)*100)/100;
    // Stamp/clear the payment date so open-AP aging & the balance sheet know WHEN it settled.
    if(k==="paid") u.paid_date = v==="paid" ? (r.paid_date || new Date().toISOString().slice(0,10)) : "";
    return u;
  }));
  return (
    <div>
      <h2 style={{color:P.em,fontSize:16,fontWeight:700,margin:"0 0 6px"}}>{t("Τιμολόγια Υπεργολάβων","Subcontractor Invoices")}</h2>
      <p style={{fontSize:13,color:P.tm,margin:"0 0 16px"}}>{t("Αμοιβή συμβολαίου","Contract fee")}: <strong style={{color:P.em}}>{activeFee}%</strong> {t("(από ενεργό MSA)","(from active MSA)")}</p>
      <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,padding:14,marginBottom:16,display:"flex",flexWrap:"wrap",gap:8,alignItems:"end"}}>
        <Sel l={t("Μήνας","Month")} v={f.month} set={v=>sF(x=>({...x,month:v}))} opts={MONTHS.map(m=>({v:m,l:monthLabel(m)}))} w={100} />
        <Sel l={t("Κατ. Κόστους","Cost Cat")} v={f.cat} set={v=>sF(x=>({...x,cat:v}))} opts={COST_CATS.map(c=>({v:c,l:catLabel(c)}))} w={190} />
        <Inp l={t("Προμηθευτής","Supplier")} v={f.supplier} set={v=>sF(x=>({...x,supplier:v}))} w={130} />
        <Sel l={t("Υπηρεσία","Service")} v={f.svc_cat} set={v=>sF(x=>({...x,svc_cat:v}))} opts={SVC_CATS.map(c=>({v:c,l:catLabel(c)}))} w={150} />
        <Inp l={t("Περιγραφή","Description")} v={f.svc_desc||""} set={v=>sF(x=>({...x,svc_desc:v}))} w={120} />
        <Inp l={t("Αρ. Τιμολ.","Invoice No")} v={f.inv_no||""} set={v=>sF(x=>({...x,inv_no:v}))} w={100} />
        <Inp l={t("Ημ/νία","Date")} v={f.date||""} set={v=>sF(x=>({...x,date:v}))} w={90} />
        <Inp l={t("Ποσό €","Amount €")} v={f.amt} set={v=>sF(x=>({...x,amt:v}))} w={95} t="number" />
        <Inp l={t("Αμοιβή %","Fee %")} v={f.fee_pct} set={v=>sF(x=>({...x,fee_pct:v}))} w={55} t="number" />
        <Sel l="Act/Acc" v={f.act_acc} set={v=>sF(x=>({...x,act_acc:v}))} opts={[{v:"ACTUAL",l:"ACTUAL"},{v:"ACCRUAL",l:"ACCRUAL"}]} w={90} />
        <Inp l={t("Σχόλια","Comments")} v={f.comments||""} set={v=>sF(x=>({...x,comments:v}))} w={110} />
        <button onClick={add} style={{background:P.em,color:"#fff",border:"none",padding:"7px 18px",borderRadius:6,cursor:"pointer",fontSize:13,fontWeight:600}}>+ {t("Προσθήκη","Add")}</button>
      </div>
      <Tbl cols={[
        {k:"month",l:t("Μήνας","Month"),opts:MONTHS.map(m=>({v:m,l:monthLabel(m)})),mw:90},
        {k:"cat",l:t("Κατ. Υπεργ.","Sub Category"),opts:COST_CATS.map(c=>({v:c,l:catLabel(c)})),mw:140},
        {k:"supplier",l:t("Προμηθευτής","Supplier"),edit:true,mw:120},
        {k:"svc_cat",l:t("Υπηρεσία","Service"),opts:SVC_CATS.map(c=>({v:c,l:catLabel(c)})),mw:120},
        {k:"svc_desc",l:t("Περιγραφή","Description"),edit:true,mw:120},
        {k:"inv_no",l:t("Αρ. Τιμ.","Inv No"),edit:true,mw:80},
        {k:"date",l:t("Ημ/νία","Date"),edit:true,mw:80},
        {k:"amt",l:t("Ποσό €","Amount €"),a:"right",edit:true,t:"number",mw:80},
        {k:"vat",l:t("ΦΠΑ €","VAT €"),a:"right",edit:true,t:"number",mw:70},
        {k:"total",l:t("Σύνολο €","Total €"),a:"right",r:fmt},
        {k:"fee_pct",l:t("Αμοιβή %","Fee %"),a:"right",edit:true,t:"number",mw:55},
        {k:"cbre_fee",l:t("Αμοιβή CBRE €","CBRE Fee €"),a:"right",r:fmt},
        {k:"cbre_bill",l:t("Χρέωση CBRE €","CBRE Billing €"),a:"right",r:fmt},
        {k:"act_acc",l:"Act/Acc",opts:[{v:"ACTUAL",l:"ACTUAL"},{v:"ACCRUAL",l:"ACCRUAL"}],mw:90},
        {k:"comments",l:t("Σχόλια","Comments"),edit:true,mw:100},
        {k:"paid",l:t("Πληρωμή","Payment"),opts:[{v:"",l:t("Απλήρωτο","Unpaid")},{v:"paid",l:t("Πληρωμένο","Paid")}],mw:80},
        {k:"docId",l:t("Αρχείο","File"),mw:80,r:(v,row)=>row&&row.docId?(<span style={{whiteSpace:"nowrap"}}><a href="#" onClick={async e=>{e.preventDefault();try{window.open(await api.getFileLink(year,client,row.docId),"_blank");}catch{alert(t("Αδυναμία ανοίγματος αρχείου","Could not open file"));}}} title={t("Προεπισκόπηση","Preview")} style={{textDecoration:"none",marginRight:8,fontSize:15}}>👁</a><a href="#" onClick={async e=>{e.preventDefault();try{window.location.assign(await api.getFileLink(year,client,row.docId,true));}catch{alert(t("Αδυναμία λήψης αρχείου","Could not download file"));}}} title={t("Λήψη","Download")} style={{textDecoration:"none",fontSize:15}}>⬇</a></span>):<span style={{color:P.tm}}>—</span>}
      ]} data={data} del={id=>{const row=(data||[]).find(x=>x.id===id); if(row&&row.docId) api.deleteFile(year,client,row.docId).catch(()=>{}); set(p=>p.filter(x=>x.id!==id));}} onEdit={edit} />
    </div>
  );
}

export function AccTab({inv,sub,data,set}) {
  const { t } = useT();
  const manual = data || [];
  const [f,sF] = useState({month:MONTHS[0],section:"UBR",seg:0,amt:"",note:""});
  const thS = {padding:"6px 8px",textAlign:"center",fontSize:10,fontWeight:700,color:"#fff",background:P.em,whiteSpace:"nowrap"};
  const cellS = {padding:"6px 8px",textAlign:"right",fontSize:12,borderBottom:"1px solid "+P.bd};

  // Revenue accruals from CBRE Invoices where act_acc=ACCRUAL, split by sign
  const revAcc = (cat,m,sign) => inv.filter(i=>i.month===m&&(i.act_acc||"").toUpperCase()==="ACCRUAL"&&(i.cat||"").includes(cat)&&(sign==="+"?(Number(i.amt)||0)>0:(Number(i.amt)||0)<0)).reduce((s,i)=>s+(Number(i.amt)||0),0);
  // Expense accruals from Sub Invoices where act_acc=ACCRUAL
  const costAcc = (cat,m) => sub.filter(i=>i.month===m&&(i.act_acc||"").toUpperCase()==="ACCRUAL"&&(i.cat||"").toUpperCase().includes(cat)).reduce((s,i)=>s+(Number(i.amt)||0),0);
  // Manual accrual entries added on this tab, summed per section (UBR/UER/EXP) + segment + month.
  const manualSum = (secKey,seg,m) => manual.filter(a=>a.section===secKey&&a.seg===seg&&a.month===m).reduce((s,a)=>s+(Number(a.amt)||0),0);

  const cats = ["FM Core","FM Extra Works","PJMs"];
  const costCats = ["CORE","EXTRA","PJM"];
  const catLabels = ["FM Core","FM Extra Works","FM PJMs"];

  const sections = [
    {t:t("Δουλευμένα Εσόδων — UBR (Ανείσπρακτα Έσοδα)","Revenue Accruals — UBR (Unbilled Revenue)"),sub:"UBR",key:"UBR",rows:cats.map((c,i)=>({l:catLabels[i],fn:m=>revAcc(c,m,"+")+manualSum("UBR",i,m)}))},
    {t:t("Δουλευμένα Εσόδων — UER (Έσοδα Επόμενων Χρήσεων)","Revenue Accruals — UER (Unearned Revenue)"),sub:"UER",key:"UER",rows:cats.map((c,i)=>({l:catLabels[i],fn:m=>revAcc(c,m,"-")+manualSum("UER",i,m)}))},
    {t:t("Δουλευμένα Εξόδων (Τιμολόγια Υπεργ. Accrual + χειροκίνητα)","Expense Accruals (Sub Accrual entries + manual)"),sub:"Total",key:"EXP",rows:costCats.map((c,i)=>({l:catLabels[i],fn:m=>costAcc(c,m)+manualSum("EXP",i,m)}))},
  ];

  const addManual = () => {
    const a = parseFloat(f.amt);
    if(f.amt===""||Number.isNaN(a)) return;
    set([...manual,{id:uid(),month:f.month,section:f.section,seg:Number(f.seg),amt:a,note:f.note||""}]);
    sF(x=>({...x,amt:"",note:""}));
  };
  const delManual = (id) => set(manual.filter(a=>a.id!==id));
  const secOpts = [{v:"UBR",l:"UBR — "+t("Ανείσπρακτα","Unbilled")},{v:"UER",l:"UER — "+t("Επόμ. Χρήσεων","Unearned")},{v:"EXP",l:t("Έξοδα","Expense")}];

  return (
    <div>
      <h2 style={{color:P.em,fontSize:16,fontWeight:700,margin:"0 0 6px"}}>{t("Δουλευμένα (Accruals)","Accruals")}</h2>
      <p style={{fontSize:12,color:P.tm,margin:"0 0 16px"}}>{t("Αυτόματη συμπλήρωση από τιμολόγια ACCRUAL + χειροκίνητες εγγραφές (παρακάτω). Τα σύνολα αθροίζουν και τα δύο.","Auto-populated from ACCRUAL-marked invoices + manual entries (below). Totals include both.")}</p>
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
                <th style={{...thS,textAlign:"left",borderRight:"2px solid #00695C"}}>{t("Κατηγορία","Category")}</th>
                {MONTHS.map(m=><th key={m} style={thS}>{monthLabel(m)}</th>)}
                <th style={{...thS,background:"#00695C"}}>{t("Σύνολο","Total")}</th>
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
                  <td style={{padding:"8px 10px",fontSize:12,fontWeight:700,borderRight:"2px solid #00695C"}}>{t("Υποσύνολο","Sub-Total")} {sec.sub}</td>
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

      {/* ── Manual accrual entries ── */}
      <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,marginTop:4}}>
        <div style={{background:P.ep,padding:"10px 16px",fontWeight:700,fontSize:13,color:P.em}}>✍️ {t("Χειροκίνητη Εγγραφή Accrual","Manual Accrual Entry")}</div>
        <div style={{padding:14,display:"flex",flexWrap:"wrap",gap:8,alignItems:"flex-end"}}>
          <Sel l={t("Μήνας","Month")} v={f.month} set={v=>sF(x=>({...x,month:v}))} opts={MONTHS.map(m=>({v:m,l:monthLabel(m)}))} w={100} />
          <Sel l={t("Τύπος","Type")} v={f.section} set={v=>sF(x=>({...x,section:v}))} opts={secOpts} w={180} />
          <Sel l="Segment" v={String(f.seg)} set={v=>sF(x=>({...x,seg:Number(v)}))} opts={catLabels.map((l,i)=>({v:String(i),l}))} w={130} />
          <Inp l={t("Ποσό €","Amount €")} v={f.amt} set={v=>sF(x=>({...x,amt:v}))} w={100} t="number" />
          <Inp l={t("Σημείωση","Note")} v={f.note} set={v=>sF(x=>({...x,note:v}))} w={200} />
          <button onClick={addManual} style={{background:P.em,color:"#fff",border:"none",padding:"8px 18px",borderRadius:6,cursor:"pointer",fontSize:13,fontWeight:600}}>+ {t("Προσθήκη","Add")}</button>
        </div>
        {manual.length>0 && (
          <div style={{padding:"0 14px 14px",overflowX:"auto"}}>
            <table style={{width:"100%",borderCollapse:"collapse"}}>
              <thead><tr>{[t("Μήνας","Month"),t("Τύπος","Type"),"Segment",t("Ποσό €","Amount €"),t("Σημείωση","Note"),""].map((h,i)=>(
                <th key={i} style={{padding:"5px 8px",fontSize:10,fontWeight:700,color:"#fff",background:P.em,textAlign:i===3?"right":"left"}}>{h}</th>
              ))}</tr></thead>
              <tbody>{manual.map(a=>(
                <tr key={a.id} style={{borderBottom:"1px solid "+P.bd}}>
                  <td style={{padding:"5px 8px",fontSize:12}}>{monthLabel(a.month)}</td>
                  <td style={{padding:"5px 8px",fontSize:12}}>{a.section}</td>
                  <td style={{padding:"5px 8px",fontSize:12}}>{catLabels[a.seg]||"-"}</td>
                  <td style={{padding:"5px 8px",fontSize:12,textAlign:"right",color:a.amt<0?P.rd:P.em,fontWeight:600}}>{fmt(a.amt)}</td>
                  <td style={{padding:"5px 8px",fontSize:12,color:P.tm}}>{a.note}</td>
                  <td style={{padding:"5px 8px",textAlign:"right"}}><button onClick={()=>delManual(a.id)} title={t("Διαγραφή","Delete")} style={{background:"none",border:"none",color:P.rd,cursor:"pointer",fontSize:15}}>×</button></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export function LabTab({data,set}) {
  const { t } = useT();
  const up = (m,k,v) => set(p => ({...p,[m]:{...p[m],[k]:parseFloat(v)||0}}));
  const rowTot = k => MONTHS.reduce((s,m)=>s+(Number(data[m]?.[k])||0),0);
  const coreMonth = m => LAB_ROWS.reduce((s,r)=>s+(Number(data[m]?.[r.k])||0),0);
  const totalMonth = m => LAB_ALL_ROWS.reduce((s,r)=>s+(Number(data[m]?.[r.k])||0),0);
  const thS = {padding:"6px 8px",textAlign:"center",fontSize:10,fontWeight:700,color:"#fff",background:P.em,whiteSpace:"nowrap"};
  const inpS = {width:"100%",padding:"4px 5px",border:"1px solid "+P.bd,borderRadius:3,fontSize:11,textAlign:"right",background:P.ip,outline:"none",boxSizing:"border-box"};
  const inpRow = (r,i,shade) => (
    <tr key={r.k} style={{background:shade!==undefined?shade:(i%2===0?P.wh:P.al)}}>
      <td style={{padding:"6px 10px",fontSize:12,fontWeight:500,borderBottom:"1px solid "+P.bd,borderRight:"2px solid "+P.bd,whiteSpace:"nowrap"}}>{r.l}</td>
      {MONTHS.map(m => (
        <td key={m} style={{padding:"3px 4px",borderBottom:"1px solid "+P.bd,textAlign:"center"}}>
          <input type="number" step="0.01" value={data[m]?.[r.k]||""} onChange={e=>up(m,r.k,e.target.value)} style={inpS} />
        </td>
      ))}
      <td style={{padding:"5px 8px",textAlign:"right",fontSize:12,fontWeight:700,color:P.em,borderBottom:"1px solid "+P.bd,background:"#f5f5f5",borderLeft:"2px solid "+P.bd}}>
        {fmt(rowTot(r.k))}
      </td>
    </tr>
  );
  return (
    <div>
      <h2 style={{color:P.em,fontSize:16,fontWeight:700,margin:"0 0 8px"}}>{t("Κόστος Εργασίας","Labour Cost")}</h2>
      <div style={{fontSize:11.5,color:P.tm,margin:"0 0 12px",lineHeight:1.5}}>{t("Οι κατηγορίες αθροίζουν στο FM Core Labour. Οι γραμμές Extra Works & PJM δέχονται πραγματικά ποσά και μεταφέρονται αυτούσιες στο P&L (Labour Cost - FM Extra Works / PJMs).","The categories sum into FM Core Labour. The Extra Works & PJM lines take actual amounts and flow verbatim into the P&L (Labour Cost - FM Extra Works / PJMs).")}</div>
      <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd}}>
        <div style={{overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse",tableLayout:"fixed",minWidth:1100}}>
            <colgroup>
              <col style={{width:170}} />
              {MONTHS.map(m=><col key={m} style={{width:75}} />)}
              <col style={{width:95}} />
            </colgroup>
            <thead><tr>
              <th style={{...thS,textAlign:"left",borderRight:"2px solid #00695C"}}>{t("Κατηγορία","Category")}</th>
              {MONTHS.map(m=><th key={m} style={thS}>{monthLabel(m)}</th>)}
              <th style={{...thS,background:"#00695C"}}>{t("Σύνολο","Total")}</th>
            </tr></thead>
            <tbody>
              {LAB_ROWS.map((r,i) => inpRow(r,i))}
              {/* Subtotal — FM Core Labour → P&L "Labour Cost - FM Core" */}
              <tr style={{background:"#E8F5E9"}}>
                <td style={{padding:"7px 10px",fontSize:12,fontWeight:700,color:P.em,borderRight:"2px solid #00695C"}}>{t("Υποσύνολο — FM Core Labour","Subtotal — FM Core Labour")}</td>
                {MONTHS.map(m => <td key={m} style={{padding:"6px 8px",textAlign:"right",fontSize:12,fontWeight:700,color:P.em}}>{fmt(coreMonth(m))}</td>)}
                <td style={{padding:"6px 8px",textAlign:"right",fontSize:12,fontWeight:700,color:P.em,background:"#DcEDC8",borderLeft:"2px solid #00695C"}}>
                  {fmt(MONTHS.reduce((x,m)=>x+coreMonth(m),0))}
                </td>
              </tr>
              {/* Direct actual labour for the Extra Works & PJM segments */}
              {LAB_SEG_ROWS.map((r,i) => inpRow(r,i,"#FFFDE7"))}
              {/* SUM — Total Labour → P&L "Total Labour Cost" */}
              <tr style={{background:P.ep}}>
                <td style={{padding:"8px 10px",fontSize:12,fontWeight:700,borderRight:"2px solid #00695C"}}>{t("ΣΥΝΟΛΟ — Total Labour","SUM — Total Labour")}</td>
                {MONTHS.map(m => <td key={m} style={{padding:"6px 8px",textAlign:"right",fontSize:12,fontWeight:700,color:P.em}}>{fmt(totalMonth(m))}</td>)}
                <td style={{padding:"6px 8px",textAlign:"right",fontSize:13,fontWeight:700,color:P.em,background:"#C8E6C9",borderLeft:"2px solid #00695C"}}>
                  {fmt(MONTHS.reduce((x,m)=>x+totalMonth(m),0))}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export function POTracker({inv,contracts}) {
  const { t } = useT();
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
      <h2 style={{color:P.em,fontSize:16,fontWeight:700,margin:"0 0 6px"}}>{t("Παρακολούθηση Δαπανών PO","PO Spend Tracker")}</h2>
      <p style={{fontSize:13,color:P.tm,margin:"0 0 16px"}}>{t("Μόνο πραγματικά (χωρίς accruals)","Actuals only (excl. accruals)")} — {allPOs.length} POs — Budget: €{fmt(totalBudget)} — {t("Δαπάνη","Spent")}: €{fmt(totalSpent)} — {t("Υπόλοιπο","Remaining")}: €{fmt(totalBudget-totalSpent)}</p>

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
                  <div style={{textAlign:"center"}}><div style={{fontSize:10,color:P.tm}}>{t("Δαπάνη (καθ.)","Spent (net)")}</div><div style={{fontSize:14,fontWeight:700,color:bc}}>€{fmt(pd.spent)}</div></div>
                  <div style={{textAlign:"center"}}><div style={{fontSize:10,color:P.tm}}>{t("Υπόλοιπο","Remaining")}</div><div style={{fontSize:14,fontWeight:700,color:pd.remaining<0?P.rd:P.gn}}>€{fmt(pd.remaining)}</div></div>
                </div>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:P.tm}}>
                  <span>{(pd.pct*100).toFixed(1)}% {t("αναλώθηκε","consumed")}</span>
                  <span>{pd.actuals.length} {t("τιμολόγια","invoices")}</span>
                  {pd.expiry && <span>{t("Λήγει","Expires")}: {pd.expiry}</span>}
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
            <span style={{fontWeight:700,fontSize:13,color:P.em}}>{open[pd.po]?"▼":"▶"} PO {pd.po} — {pd.scope} ({pd.actuals.length} {t("πραγματικά","actuals")})</span>
            <span style={{fontSize:12,fontWeight:600,color:pd.remaining<0?P.rd:P.gn}}>€{fmt(pd.spent)} / €{fmt(pd.budget)}</span>
          </div>
          {open[pd.po] && (
            <div style={{overflowX:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                <thead><tr>
                  {[["Month",t("Μήνας","Month")],["Category",t("Κατηγορία","Category")],["Amount €",t("Ποσό €","Amount €")],["VAT €",t("ΦΠΑ €","VAT €")],["Total €",t("Σύνολο €","Total €")],["Invoice No",t("Αρ. Τιμολ.","Invoice No")],["Date",t("Ημ/νία","Date")]].map(([k,h])=>(
                    <th key={k} style={{padding:"6px 10px",fontSize:11,fontWeight:700,color:"#fff",background:P.em,textAlign:k.includes("€")?"right":"left"}}>{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {pd.actuals.map((iv,i) => (
                    <tr key={iv.id||i} style={{background:i%2===0?P.wh:P.al}}>
                      <td style={{padding:"5px 10px",borderBottom:"1px solid "+P.bd}}>{monthLabel(iv.month)}</td>
                      <td style={{padding:"5px 10px",borderBottom:"1px solid "+P.bd}}>{iv.cat}</td>
                      <td style={{padding:"5px 10px",borderBottom:"1px solid "+P.bd,textAlign:"right"}}>{fmt(iv.amt)}</td>
                      <td style={{padding:"5px 10px",borderBottom:"1px solid "+P.bd,textAlign:"right"}}>{fmt(iv.vat)}</td>
                      <td style={{padding:"5px 10px",borderBottom:"1px solid "+P.bd,textAlign:"right"}}>{fmt(iv.total||iv.amt+(iv.vat||0))}</td>
                      <td style={{padding:"5px 10px",borderBottom:"1px solid "+P.bd}}>{iv.inv_no}</td>
                      <td style={{padding:"5px 10px",borderBottom:"1px solid "+P.bd}}>{iv.date}</td>
                    </tr>
                  ))}
                  <tr style={{background:P.ep}}>
                    <td colSpan={2} style={{padding:"6px 10px",fontWeight:700}}>{t("Σύνολο Πραγματικών","Total Actuals")}</td>
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

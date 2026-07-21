// Contracts & documents tab: contract register (MSA/PO/…) with expiry badges, plus
// per-client document upload with AI extraction. Extracted from App.jsx.
import { useState } from "react";
import { api } from "./api.js";
import { P, ML, uid, expiryBadge, fmt } from "./constants.js";
import { Inp, Sel, Tbl } from "./ui.jsx";
import { useT, monthLabel } from "./i18n.jsx";


export function ContractTab({data,set,inv,docs,setDocs,year,client}) {
  const { t } = useT();
  const [drag,setDrag] = useState(false);
  const [modalPO,setModalPO] = useState(null);
  const [extracting,setExtracting] = useState(false);
  const TYPES = [{v:"MSA",l:"MSA"},{v:"LEA",l:"LEA / LCA"},{v:"PO",l:"Purchase Order"},{v:"Amendment",l:"Amendment"},{v:"NDA",l:"NDA"},{v:"Other",l:"Other"}];
  const STAT = [{v:"Active",l:"Active"},{v:"Expired",l:"Expired"},{v:"Pending",l:"Pending"},{v:"Terminated",l:"Terminated"}];
  const [f,sF] = useState({type:"MSA",ref:"",client:"",start:"",expiry:"",fee_pct:5.5,status:"Active",po:"",po_value:"",scope:"",notes:""});
  const [docType,setDocType] = useState("MSA");
  const [docContract,setDocContract] = useState("");

  const add = () => {
    if(!f.ref) return;
    set(p=>[...p,{...f,id:uid(),po_value:parseFloat(f.po_value)||0,fee_pct:parseFloat(f.fee_pct)||5.5}]);
    sF(x=>({...x,ref:"",start:"",expiry:"",po:"",po_value:"",scope:"",notes:""}));
  };

  // Upload files to NAS + AI extract contract metadata via backend (Claude proxy)
  const addDocs = async fl => {
    const arr = Array.from(fl).filter(f=>f.type==="application/pdf"||f.type.startsWith("image/")||f.name.endsWith(".docx"));
    if(!arr.length) return;
    setExtracting(true);
    const TYPES_VALID = ["MSA","LEA","PO","Amendment","NDA","Other"];
    const newDocs = [];
    const created = [];
    for(let i=0; i<arr.length; i++) {
      const f = arr[i];
      // Step 1: Upload file to NAS
      let docEntry;
      try {
        const uploaded = await api.uploadFile(year, client, f, docType, docContract);
        docEntry = {
          id: uploaded.id,
          name: uploaded.name,
          size: uploaded.size,
          type: docType,
          contract_ref: docContract,
          fileType: f.type,
          date: new Date().toLocaleDateString(),
          _persisted: true // opened via signed links — no token-bearing URL stored
        };
      } catch(e) {
        console.error("Upload failed:",e);
        docEntry = {name:f.name,size:f.size,type:docType,contract_ref:docContract,date:new Date().toLocaleDateString(),url:URL.createObjectURL(f),fileType:f.type,_uploadFailed:true};
      }
      newDocs.push(docEntry);

      // Step 2: AI extract contract details (skip .docx — Claude can't read it directly)
      if(!f.name.endsWith(".docx")) {
        try {
          const ex = await api.extractContract(f);
          const type = TYPES_VALID.includes(ex.type) ? ex.type : "Other";
          const contract = {
            id: Date.now()+i,
            type,
            ref: String(ex.ref||"").slice(0,80),
            client: String(ex.client||"").slice(0,80),
            start: String(ex.start||""),
            expiry: String(ex.expiry||""),
            fee_pct: Number(ex.fee_pct)||5.5,
            status: "Active",
            po: String(ex.po||""),
            po_value: Number(ex.po_value)||0,
            scope: String(ex.scope||"").slice(0,120),
            notes: String(ex.notes||"").slice(0,150),
            _source_doc: f.name
          };
          created.push(contract);
          // Update doc type based on AI detection
          docEntry.type = type;
          docEntry.contract_ref = contract.ref || docEntry.contract_ref;
        } catch(e) {
          console.error("AI extraction failed for",f.name,":",e);
        }
      }
    }
    setDocs(p=>[...(p||[]),...newDocs]);
    if(created.length) set(p=>[...(p||[]),...created]);
    setExtracting(false);
    sF({type:"MSA",ref:"",client:"",start:"",expiry:"",fee_pct:5.5,status:"Active",po:"",po_value:"",scope:"",notes:""});
    if(created.length) {
      const summary = created.map((c,i)=>`${i+1}. ${c.type} — ${c.ref||t("(χωρίς ref)","(no ref)")} ${c.po_value?"€"+fmt(c.po_value):""}`).join("\n");
      alert(t(`✓ Ανέβηκαν ${newDocs.length} αρχείο(α) και εξήχθησαν ${created.length} συμβόλαιο(α):\n\n${summary}`,`✓ Uploaded ${newDocs.length} file(s) and extracted ${created.length} contract(s):\n\n${summary}`));
    } else {
      alert(t(`✓ Ανέβηκαν ${newDocs.length} αρχείο(α).\n\nΤο AI δεν εξήγαγε στοιχεία συμβολαίου — πρόσθεσε στοιχεία χειροκίνητα παρακάτω.`,`✓ Uploaded ${newDocs.length} file(s).\n\nAI extraction returned no contract data — please add details manually below.`));
    }
  };

  const edit = (id,k,v) => set(p=>p.map(r=>r.id===id?{...r,[k]:k==="po_value"||k==="fee_pct"?parseFloat(v)||0:v}:r));
  const activeFee = data.find(c=>c.status==="Active"&&c.type==="MSA")?.fee_pct || 5.5;
  // Only CONTRACT documents belong here. Invoice PDFs (AP/AR Invoice) attached by the scanner
  // live on the invoice grids (their File column), so exclude them from this list.
  const contractDocs = (docs||[]).filter(d=>d.type!=="AP Invoice"&&d.type!=="AR Invoice");

  // PO Spend data
  const poContracts = data.filter(c=>c.type==="PO"&&c.po);
  const allPOs = [...new Set([...poContracts.map(c=>c.po),...(inv||[]).filter(i=>i.po_no).map(i=>i.po_no)])].filter(Boolean);
  const poData = allPOs.map(po=>{
    const contract = poContracts.find(c=>c.po===po);
    const actuals = (inv||[]).filter(i=>i.po_no===po&&(i.act_acc||"").toUpperCase()==="ACTUAL");
    const spent = actuals.reduce((s,i)=>s+(Number(i.amt)||0),0);
    const budget = contract?.po_value||0;
    return {po,actuals,spent,budget,rem:budget-spent,pct:budget?spent/budget:0,scope:contract?.scope||"",expiry:contract?.expiry||""};
  });

  // Contract summary
  const typeColors = {MSA:"#003F2D",LEA:"#00695C",PO:"#00897B",Amendment:"#4DB6AC",NDA:"#80CBC4",Other:"#B2DFDB"};
  const summary = TYPES.map(ty => {
    const contracts = data.filter(c=>c.type===ty.v);
    const docCount = (docs||[]).filter(d=>d.type===ty.v).length;
    const totalPO = contracts.reduce((s,c)=>s+(Number(c.po_value)||0),0);
    const active = contracts.filter(c=>c.status==="Active").length;
    return {...ty, contracts, docCount, totalPO, active, total:contracts.length};
  }).filter(ty=>ty.total>0||ty.docCount>0);

  return (
    <div>
      <h2 style={{color:P.em,fontSize:16,fontWeight:700,margin:"0 0 6px"}}>{t("Συμβόλαια, POs & Αμοιβή Διαχείρισης","Contracts, POs & Management Fee")}</h2>
      <p style={{fontSize:13,color:P.tm,margin:"0 0 16px"}}>{t("Αμοιβή ενεργού MSA","Active MSA fee")}: <strong style={{color:P.em,fontSize:15}}>{activeFee}%</strong> — {data.filter(c=>c.status==="Active").length} {t("ενεργά συμβόλαια","active contracts")} — {contractDocs.length} {t("έγγραφα","documents")}</p>

      {/* ── 1. CONTRACT SUMMARY CARDS ── */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:12,marginBottom:20}}>
        {summary.map(ty => (
          <div key={ty.v} style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,overflow:"hidden"}}>
            <div style={{background:typeColors[ty.v]||P.em,color:"#fff",padding:"10px 14px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <span style={{fontWeight:700,fontSize:14}}>{ty.l}</span>
              <div style={{display:"flex",gap:6,alignItems:"center"}}>
                {ty.docCount>0&&<span style={{background:"rgba(255,255,255,.25)",padding:"2px 8px",borderRadius:10,fontSize:10,fontWeight:700}}>📎 {ty.docCount} docs</span>}
                <span style={{fontSize:11,opacity:.8}}>{ty.active} active / {ty.total} total</span>
              </div>
            </div>
            <div style={{padding:12}}>
              {ty.contracts.map(c => (
                <div key={c.id} style={{padding:"6px 0",borderBottom:"1px solid "+P.bd,fontSize:12}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <span style={{fontWeight:600,color:P.em}}>{c.ref}</span>
                    <span style={{fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:10,color:"#fff",
                      background:c.status==="Active"?"#2E7D32":c.status==="Expired"?"#C62828":c.status==="Pending"?"#F57F17":"#757575"
                    }}>{c.status}</span>
                  </div>
                  <div style={{color:P.tm,marginTop:2}}>{c.scope}</div>
                  <div style={{display:"flex",gap:12,marginTop:4,fontSize:11,color:P.tx}}>
                    {c.start&&<span>{t("Από","From")}: {c.start}</span>}
                    {c.expiry&&<span>{t("Έως","To")}: {c.expiry}</span>}
                    {(()=>{ const b=c.status!=="Terminated"&&c.status!=="Expired"&&expiryBadge(c.expiry); return b?<span style={{padding:"1px 8px",borderRadius:8,fontSize:10,fontWeight:700,background:b.bg,color:b.color}}>{b.label}</span>:null; })()}
                    <span style={{fontWeight:600}}>{t("Αμοιβή","Fee")}: {c.fee_pct}%</span>
                    {c.po_value>0&&<span>PO: €{fmt(c.po_value)}</span>}
                  </div>
                  {/* Docs linked to this specific contract */}
                  {docs.filter(d=>d.contract_ref===c.ref).length>0&&(
                    <div style={{marginTop:6}}>
                      {docs.filter(d=>d.contract_ref===c.ref).map((d,j)=>(
                        <div key={j} style={{display:"flex",alignItems:"center",gap:6,padding:"2px 0",fontSize:11,color:P.tm}}>
                          <span>📄</span><span style={{flex:1}}>{d.name}</span>
                          {(d._persisted&&d.id)?<a href="#" onClick={async e=>{e.preventDefault();try{window.open(await api.getFileLink(year,client,d.id),"_blank");}catch{alert(t("Αδυναμία ανοίγματος αρχείου","Could not open file"));}}} style={{background:P.em,color:"#fff",padding:"1px 8px",borderRadius:4,fontSize:10,fontWeight:600,textDecoration:"none"}}>{t("Άνοιγμα","Open")}</a>:d.url?<a href={d.url} target="_blank" rel="noopener noreferrer" style={{background:P.em,color:"#fff",padding:"1px 8px",borderRadius:4,fontSize:10,fontWeight:600,textDecoration:"none"}}>{t("Άνοιγμα","Open")}</a>:null}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {/* Docs of this type not linked to a specific contract */}
              {docs.filter(d=>d.type===ty.v&&!d.contract_ref).length>0&&(
                <div style={{marginTop:ty.contracts.length?8:0,paddingTop:ty.contracts.length?8:0,borderTop:ty.contracts.length?"1px dashed "+P.bd:"none"}}>
                  <div style={{fontSize:10,fontWeight:700,color:P.tm,marginBottom:4}}>{t("ΑΣΥΝΔΕΤΑ ΕΓΓΡΑΦΑ","UNLINKED DOCUMENTS")}</div>
                  {docs.filter(d=>d.type===ty.v&&!d.contract_ref).map((d,j)=>(
                    <div key={j} style={{display:"flex",alignItems:"center",gap:6,padding:"2px 0",fontSize:11,color:P.tm}}>
                      <span>📄</span><span style={{flex:1}}>{d.name}</span>
                      {(d._persisted&&d.id)?<a href="#" onClick={async e=>{e.preventDefault();try{window.open(await api.getFileLink(year,client,d.id),"_blank");}catch{alert(t("Αδυναμία ανοίγματος αρχείου","Could not open file"));}}} style={{background:P.em,color:"#fff",padding:"1px 8px",borderRadius:4,fontSize:10,fontWeight:600,textDecoration:"none"}}>{t("Άνοιγμα","Open")}</a>:d.url?<a href={d.url} target="_blank" rel="noopener noreferrer" style={{background:P.em,color:"#fff",padding:"1px 8px",borderRadius:4,fontSize:10,fontWeight:600,textDecoration:"none"}}>{t("Άνοιγμα","Open")}</a>:null}
                    </div>
                  ))}
                </div>
              )}
              {ty.contracts.length===0&&ty.docCount===0&&(
                <div style={{fontSize:11,color:P.tm,fontStyle:"italic",padding:"4px 0"}}>{t("Καμία εγγραφή ακόμη","No records yet")}</div>
              )}
            </div>
            {ty.totalPO>0&&<div style={{background:P.ep,padding:"6px 14px",fontSize:12,fontWeight:600,color:P.em,borderTop:"1px solid "+P.bd}}>{t("Συνολική Αξία PO","Total PO Value")}: €{fmt(ty.totalPO)}</div>}
          </div>
        ))}
      </div>

      {/* ── 2. PO SPEND DASHBOARDS ── */}
      {allPOs.length>0 && (
        <div style={{marginBottom:20}}>
          {/* General summary bar */}
          <div style={{background:P.em,borderRadius:8,padding:"14px 20px",marginBottom:12,display:"flex",justifyContent:"space-between",alignItems:"center",color:"#fff",flexWrap:"wrap",gap:10}}>
            <span style={{fontWeight:700,fontSize:14}}>{t("Επισκόπηση Δαπανών PO — Μόνο Πραγματικά","PO Spend Overview — Actuals Only")}</span>
            <div style={{display:"flex",gap:24,fontSize:13}}>
              <span>Budget: <b>€{fmt(poData.reduce((s,p)=>s+p.budget,0))}</b></span>
              <span>{t("Δαπάνη","Spent")}: <b>€{fmt(poData.reduce((s,p)=>s+p.spent,0))}</b></span>
              <span>{t("Υπόλοιπο","Remaining")}: <b style={{color:poData.reduce((s,p)=>s+p.rem,0)<0?"#EF9A9A":"#A5D6A7"}}>€{fmt(poData.reduce((s,p)=>s+p.rem,0))}</b></span>
              <span>{poData.reduce((s,p)=>s+p.actuals.length,0)} {t("τιμολόγια","invoices")}</span>
            </div>
          </div>
          {/* Individual PO cards */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:12}}>
            {poData.map(pd=>{
              const pct=Math.min(pd.pct*100,100);const bc=pct>90?P.rd:pct>70?"#F57F17":P.gn;
              return (
                <div key={pd.po} style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,padding:14,cursor:"pointer",transition:"all .15s"}}
                  onClick={()=>setModalPO(pd)}
                  onMouseEnter={e=>e.currentTarget.style.borderColor=P.em}
                  onMouseLeave={e=>e.currentTarget.style.borderColor=P.bd}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                    <span style={{fontWeight:700,fontSize:13,color:P.em}}>PO {pd.po}</span>
                    <span style={{fontSize:11,color:P.tm}}>{pd.scope}</span>
                  </div>
                  <div style={{background:"#eee",borderRadius:6,height:10,marginBottom:8,overflow:"hidden"}}><div style={{background:bc,height:"100%",width:pct+"%",borderRadius:6}} /></div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6,fontSize:11}}>
                    <div><span style={{color:P.tm}}>Budget</span><div style={{fontWeight:700,color:P.em}}>€{fmt(pd.budget)}</div></div>
                    <div><span style={{color:P.tm}}>{t("Δαπάνη","Spent")}</span><div style={{fontWeight:700,color:bc}}>€{fmt(pd.spent)}</div></div>
                    <div><span style={{color:P.tm}}>{t("Υπόλοιπο","Remaining")}</span><div style={{fontWeight:700,color:pd.rem<0?P.rd:P.gn}}>€{fmt(pd.rem)}</div></div>
                  </div>
                  <div style={{textAlign:"right",fontSize:10,color:P.tm,marginTop:4}}>{t("Κλικ για λεπτομέρειες","Click for details")} · {pd.actuals.length} inv{pd.expiry?` · ${t("Λήξη","Exp")}: ${pd.expiry}`:""}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* PO Detail Modal */}
      {modalPO && (
        <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,.5)",zIndex:999,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={()=>setModalPO(null)}>
          <div style={{background:P.wh,borderRadius:12,width:"90%",maxWidth:900,maxHeight:"85vh",overflow:"auto",boxShadow:"0 20px 60px rgba(0,0,0,.3)"}} onClick={e=>e.stopPropagation()}>
            <div style={{background:P.em,color:"#fff",padding:"16px 24px",borderRadius:"12px 12px 0 0",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div>
                <div style={{fontWeight:700,fontSize:16}}>PO {modalPO.po} — {modalPO.scope}</div>
                <div style={{fontSize:12,opacity:.7,marginTop:2}}>Budget: €{fmt(modalPO.budget)} · {t("Δαπάνη","Spent")}: €{fmt(modalPO.spent)} · {t("Υπόλοιπο","Remaining")}: €{fmt(modalPO.rem)} · {(modalPO.pct*100).toFixed(1)}%</div>
              </div>
              <button onClick={()=>setModalPO(null)} style={{background:"rgba(255,255,255,.2)",border:"none",color:"#fff",padding:"6px 14px",borderRadius:6,cursor:"pointer",fontSize:14,fontWeight:700}}>✕</button>
            </div>
            <div style={{padding:20}}>
              {modalPO.actuals.length>0 ? (
                <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                  <thead><tr>{[["Month",t("Μήνας","Month")],["Category",t("Κατηγορία","Category")],["Amount €",t("Ποσό €","Amount €")],["VAT €",t("ΦΠΑ €","VAT €")],["Total €",t("Σύνολο €","Total €")],["Invoice No",t("Αρ. Τιμολ.","Invoice No")],["Date",t("Ημ/νία","Date")]].map(([k,h])=>(
                    <th key={k} style={{padding:"8px 10px",fontSize:11,fontWeight:700,color:"#fff",background:P.em,textAlign:k.includes("€")?"right":"left"}}>{h}</th>
                  ))}</tr></thead>
                  <tbody>
                    {modalPO.actuals.map((iv,i)=>(
                      <tr key={iv.id||i} style={{background:i%2===0?P.wh:P.al}}>
                        <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd}}>{monthLabel(iv.month)}</td>
                        <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd}}>{iv.cat}</td>
                        <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,textAlign:"right"}}>{fmt(iv.amt)}</td>
                        <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,textAlign:"right"}}>{fmt(iv.vat)}</td>
                        <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,textAlign:"right"}}>{fmt(iv.total||iv.amt+(iv.vat||0))}</td>
                        <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd}}>{iv.inv_no}</td>
                        <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd}}>{iv.date}</td>
                      </tr>
                    ))}
                    <tr style={{background:P.ep}}>
                      <td colSpan={2} style={{padding:"8px 10px",fontWeight:700}}>{t("Σύνολο Πραγματικών","Total Actuals")}</td>
                      <td style={{padding:"8px 10px",textAlign:"right",fontWeight:700,color:P.em}}>{fmt(modalPO.spent)}</td>
                      <td style={{padding:"8px 10px",textAlign:"right",fontWeight:700,color:P.em}}>{fmt(modalPO.actuals.reduce((s,i)=>s+(Number(i.vat)||0),0))}</td>
                      <td style={{padding:"8px 10px",textAlign:"right",fontWeight:700,color:P.em}}>{fmt(modalPO.actuals.reduce((s,i)=>s+(Number(i.total||i.amt+(i.vat||0))||0),0))}</td>
                      <td colSpan={2}></td>
                    </tr>
                  </tbody>
                </table>
              ) : (
                <div style={{textAlign:"center",padding:30,color:P.tm,fontStyle:"italic"}}>{t("Κανένα πραγματικό τιμολόγιο σε αυτό το PO ακόμη","No actual invoices assigned to this PO yet")}</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── 3. DOCUMENT UPLOAD ── */}
      <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,padding:14,marginBottom:16}}>
        <div style={{fontSize:13,fontWeight:600,color:P.em,marginBottom:10}}>{t("Ανέβασμα Εγγράφου Συμβολαίου","Upload Contract Document")}</div>
        <div style={{display:"flex",gap:8,alignItems:"end",marginBottom:10,flexWrap:"wrap"}}>
          <Sel l={t("Τύπος Εγγράφου","Document Type")} v={docType} set={setDocType} opts={TYPES} w={120} />
          <Sel l={t("Σύνδεση με Συμβόλαιο","Link to Contract")} v={docContract} set={setDocContract} opts={[{v:"",l:t("— Κανένα —","— None —")},...data.map(c=>({v:c.ref,l:c.ref+" ("+c.type+")"}))] } w={200} />
        </div>
        <label
          onDrop={e=>{e.preventDefault();setDrag(false);addDocs(e.dataTransfer.files);}}
          onDragOver={e=>{e.preventDefault();setDrag(true);}}
          onDragLeave={()=>setDrag(false)}
          style={{display:"block",border:"2px dashed "+(drag?P.em:P.bd),borderRadius:8,padding:"24px 16px",textAlign:"center",cursor:"pointer",background:drag?P.ep:P.of,transition:"all .2s"}}>
          <input type="file" multiple accept=".pdf,.docx,image/*" style={{display:"none"}} onChange={e=>{addDocs(e.target.files);e.target.value="";}} />
          <div style={{fontSize:22,marginBottom:6}}>📁</div>
          <div style={{fontSize:13,color:P.em,fontWeight:600}}>{extracting?t("🤖 Ανέβασμα + εξαγωγή AI...","🤖 Uploading + AI extracting..."):t("Κάνε κλικ για επιλογή αρχείων","Click to browse files")}</div>
          <div style={{fontSize:11,color:P.tm,marginTop:4}}>{extracting?t("Κάθε αρχείο γίνεται εγγραφή συμβολαίου","Each file becomes a contract entry"):t("Ρίξε ένα ή πολλά — το AI εξάγει το καθένα σε συμβόλαιο","Drop one or many — AI extracts each into a contract")}</div>
        </label>

        {/* Documents list */}
        {contractDocs.length>0 && (
          <div style={{marginTop:14}}>
            <div style={{fontSize:12,fontWeight:700,color:P.em,marginBottom:8}}>📂 {t("Ανεβασμένα Έγγραφα","Uploaded Documents")} ({contractDocs.length})</div>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
              <thead><tr>
                {[["File",t("Αρχείο","File")],["Type",t("Τύπος","Type")],["Linked Contract",t("Συνδεδεμένο Συμβόλαιο","Linked Contract")],["Date",t("Ημ/νία","Date")],["",""]].map(([k,h])=>(
                  <th key={k} style={{padding:"6px 10px",fontSize:11,fontWeight:700,color:"#fff",background:P.em,textAlign:"left"}}>{h}</th>
                ))}
              </tr></thead>
              <tbody>{contractDocs.map((d,i)=>(
                <tr key={d.id||i} style={{background:i%2===0?P.wh:P.al}}>
                  <td style={{padding:"7px 10px",borderBottom:"1px solid "+P.bd}}>
                    <span style={{marginRight:6}}>📄</span>{d.name}
                  </td>
                  <td style={{padding:"7px 10px",borderBottom:"1px solid "+P.bd}}>
                    <span style={{padding:"2px 8px",borderRadius:10,fontSize:10,fontWeight:700,background:P.ep,color:P.em}}>{d.type}</span>
                  </td>
                  <td style={{padding:"7px 10px",borderBottom:"1px solid "+P.bd,color:P.tm}}>{d.contract_ref||"—"}</td>
                  <td style={{padding:"7px 10px",borderBottom:"1px solid "+P.bd,color:P.tm}}>{d.date}</td>
                  <td style={{padding:"7px 10px",borderBottom:"1px solid "+P.bd}}>
                    <div style={{display:"flex",gap:6,justifyContent:"flex-end"}}>
                      {(d._persisted&&d.id)?<a href="#" onClick={async e=>{e.preventDefault();try{window.open(await api.getFileLink(year,client,d.id),"_blank");}catch{alert(t("Αδυναμία ανοίγματος αρχείου","Could not open file"));}}} style={{background:P.em,color:"#fff",padding:"3px 10px",borderRadius:4,fontSize:11,fontWeight:600,textDecoration:"none"}}>{t("Άνοιγμα","Open")}</a>:d.url?<a href={d.url} target="_blank" rel="noopener noreferrer" style={{background:P.em,color:"#fff",padding:"3px 10px",borderRadius:4,fontSize:11,fontWeight:600,textDecoration:"none"}}>{t("Άνοιγμα","Open")}</a>:null}
                      <button onClick={async()=>{if(d._persisted&&d.id){try{await api.deleteFile(year,client,d.id);}catch(e){console.warn("Delete failed:",e);}}setDocs(p=>p.filter(x=> d.id ? x.id!==d.id : x!==d));}} style={{background:"#FFEBEE",color:P.rd,border:"none",padding:"3px 10px",borderRadius:4,fontSize:11,fontWeight:600,cursor:"pointer"}}>{t("Αφαίρεση","Remove")}</button>
                    </div>
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── 4. ADD CONTRACT FORM ── */}
      <div style={{background:P.wh,borderRadius:8,border:"2px solid "+(extracting?"#F57F17":P.bd),padding:14,marginBottom:16,transition:"border-color .3s"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
          <div style={{fontSize:13,fontWeight:600,color:P.em}}>{t("Προσθήκη Συμβολαίου / PO Χειροκίνητα","Add Contract / PO Manually")} {extracting&&<span style={{color:"#F57F17",fontSize:11,marginLeft:8}}>{t("🤖 Εξαγωγή AI από τα ανεβασμένα αρχεία...","🤖 AI extracting from uploaded files...")}</span>}</div>
          {f.ref&&<button onClick={()=>sF({type:"MSA",ref:"",client:"",start:"",expiry:"",fee_pct:5.5,status:"Active",po:"",po_value:"",scope:"",notes:""})} style={{background:"#FFEBEE",border:"none",color:P.rd,padding:"3px 10px",borderRadius:4,cursor:"pointer",fontSize:11}}>{t("Καθαρισμός","Clear")}</button>}
        </div>
        <div style={{display:"flex",flexWrap:"wrap",gap:8,alignItems:"end"}}>
          <Sel l={t("Τύπος","Type")} v={f.type} set={v=>sF(x=>({...x,type:v}))} opts={TYPES} w={100} />
          <Inp l="Reference" v={f.ref} set={v=>sF(x=>({...x,ref:v}))} w={130} />
          <Inp l={t("Πελάτης","Client")} v={f.client} set={v=>sF(x=>({...x,client:v}))} w={140} />
          <Inp l={t("Ημ/νία Έναρξης","Start Date")} v={f.start} set={v=>sF(x=>({...x,start:v}))} w={140} t="date" />
          <Inp l={t("Ημ/νία Λήξης","Expiry Date")} v={f.expiry} set={v=>sF(x=>({...x,expiry:v}))} w={140} t="date" />
          <Inp l={t("Αμοιβή %","Fee %")} v={f.fee_pct} set={v=>sF(x=>({...x,fee_pct:v}))} w={60} t="number" />
          <Sel l="Status" v={f.status} set={v=>sF(x=>({...x,status:v}))} opts={STAT} w={90} />
          <Inp l="PO No" v={f.po} set={v=>sF(x=>({...x,po:v}))} w={100} />
          <Inp l={t("Αξία PO €","PO Value €")} v={f.po_value} set={v=>sF(x=>({...x,po_value:v}))} w={95} t="number" />
          <Inp l={t("Αντικείμενο","Scope")} v={f.scope} set={v=>sF(x=>({...x,scope:v}))} w={140} />
          <Inp l={t("Σημειώσεις","Notes")} v={f.notes} set={v=>sF(x=>({...x,notes:v}))} w={120} />
          <button onClick={add} style={{background:P.em,color:"#fff",border:"none",padding:"7px 18px",borderRadius:6,cursor:"pointer",fontSize:13,fontWeight:600}}>+ {t("Προσθήκη","Add")}</button>
        </div>
      </div>

      {/* ── 5. FULL TABLE ── */}
      <Tbl cols={[
        {k:"type",l:t("Τύπος","Type"),opts:TYPES,mw:80},
        {k:"ref",l:"Reference",edit:true,mw:120},
        {k:"client",l:t("Πελάτης","Client"),edit:true,mw:130},
        {k:"start",l:t("Έναρξη","Start"),edit:true,mw:90},
        {k:"expiry",l:t("Λήξη","Expiry"),edit:true,mw:90},
        {k:"fee_pct",l:t("Αμοιβή %","Fee %"),a:"right",edit:true,t:"number",mw:60},
        {k:"status",l:"Status",opts:STAT,mw:85},
        {k:"po",l:"PO No",edit:true,mw:100},
        {k:"po_value",l:t("Αξία PO €","PO Value €"),a:"right",edit:true,t:"number",mw:90},
        {k:"scope",l:t("Αντικείμενο","Scope"),edit:true,mw:140},
        {k:"notes",l:t("Σημειώσεις","Notes"),edit:true,mw:130},
      ]} data={data} del={id=>set(p=>p.filter(x=>x.id!==id))} onEdit={edit} />
    </div>
  );
}

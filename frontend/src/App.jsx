import { useState, useEffect, useRef } from "react";
import { api, setToken, getToken } from "./api.js";
import { allocFractions, depreciation, parseDate, daysUntil, clientSeries, runRateFY, clientRisks, agingBucket, AGING_BUCKETS } from "./calc.js";
import * as XLSX from "xlsx";
// Bundled locally (no CDN dependency): zip handling + PDF rendering for the scanner
import JSZip from "jszip";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.js?url";
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
if (typeof window !== "undefined") { window.JSZip = JSZip; window.pdfjsLib = pdfjsLib; }

import {
  uid, CLIENTS, LOGOS, logoUrl, logoUrl2, REPORT_STATUS, MONTHS, ML, setFiscalYear,
  remapMonth, normalizeClientData, SITES, REV_CATS, COST_CATS, SVC_CATS, LAB_ROWS,
  mkLab, mkAlloc, P, fmt, fPct, expiryBadge, YEARS, DEFAULT_OPEX_CATS, CAPEX_CATS, CAPEX_STATUS,
} from "./constants.js";
import { LogoImg, PwField, MdText, Inp, Sel, Tbl } from "./ui.jsx";
import { Login, ForcePw, ResetPassword } from "./auth.jsx";
import { PnL, InvTab, SubTab, AccTab, LabTab, POTracker } from "./reportTabs.jsx";
import { Insights, AiCard } from "./insights.jsx";
import { ChatWidget } from "./chat.jsx";
import { Dashboard, ApArLedger, OpexCapex } from "./finance.jsx";
import { AdminPanel } from "./admin.jsx";
import { Scan } from "./scan.jsx";

export default function App() {
  const [user, setUser] = useState(null);
  const [authChecking, setAuthChecking] = useState(true);

  // Auto-restore session if token exists
  useEffect(() => {
    if(getToken()) {
      api.me().then(u => {
        setUser({user:u.username, name:u.name, role:u.role, clients:u.clients, mustChange:!!u.must_change_password});
      }).catch(() => setToken(null)).finally(() => setAuthChecking(false));
    } else {
      setAuthChecking(false);
    }
  }, []);

  const logout = () => { flushSave(); setToken(null); setUser(null); };

  const [client, setClient] = useState(null);
  const [financeOpen, setFinanceOpen] = useState(false);
  const [dashOpen, setDashOpen] = useState(false);
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [year, setYear] = useState("FY26");
  setFiscalYear(year); // render-safe (idempotent): keeps MONTHS/ML aligned with the selected FY
  const [tab, setTab] = useState("contracts");
  const [tabOrder, setTabOrder] = useState([
    {id:"contracts",lb:"📋 Contracts & POs"},
    {id:"scan",lb:"📄 Invoice Scanner"},
    {id:"pnl",lb:"P&L Report"},
    {id:"insights",lb:"📈 Insights"},
    {id:"inv",lb:"CBRE Invoices"},
    {id:"sub",lb:"Sub Invoices"},
    {id:"acc",lb:"Accruals"},
    {id:"lab",lb:"Labour Cost"},
  ]);
  const [dragTab,setDragTab] = useState(null);
  const [overTab,setOverTab] = useState(null);
  const [menuOpen,setMenuOpen] = useState(false);
  const [importing,setImporting] = useState(false);
  const [allData, setAllData] = useState(() => {
    const d = {};
    YEARS.forEach(y => {
      d[y] = {};
      CLIENTS.forEach(c => { d[y][c] = {inv:[],sub:[],lab:mkLab(),labAlloc:mkAlloc(),contracts:[],docs:[],status:"draft",submittedBy:"",submittedAt:""}; });
    });
    return d;
  });

  const yd = allData[year] || {};
  const upClient = (key,val) => setAllData(p=>{
    const cur = (p[year] && p[year][client]) ? p[year][client] : {};
    const next = typeof val === "function" ? val(cur[key]) : val;
    return {...p,[year]:{...p[year],[client]:{...cur,[key]:next}}};
  });
  const cd = client ? yd[client] : null;
  const [hydratedKeys,setHydratedKeys] = useState({});
  const [saveState,setSaveState] = useState("idle"); // idle | saving | saved | error
  const versionsRef = useRef({}); // ckey -> server version (optimistic locking)
  const dirtyRef = useRef(false);
  const ctxRef = useRef(null);
  ctxRef.current = (client && cd) ? {year, client, cd} : null;

  // Load ALL data for a client/year from API on first visit
  useEffect(() => {
    if(!client||!cd) return;
    const ckey = `${year}:${client}`;
    if(hydratedKeys[ckey]) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await api.getClientData(year, client).catch(()=>null);
        if(!cancelled) {
          versionsRef.current[ckey] = (r && r.version) || 0;
          // normalize month keys onto the selected FY (heals data saved under hardcoded 2026 months)
          setAllData(p=>({...p,[year]:{...p[year],[client]: normalizeClientData({...p[year][client], ...((r && r.data) || {})})}}));
        }
        const files = await api.listFiles(year, client).catch(()=>[]);
        if(!cancelled && files && files.length) {
          const docs = files.map(f => ({
            id: f.id,
            name: f.name,
            type: f.type,
            contract_ref: f.contract_ref,
            fileType: f.file_type,
            size: f.size,
            date: new Date(f.uploaded_at*1000).toLocaleDateString(),
            _persisted: true // opened via short-lived signed links (api.getFileLink) — no token in URLs
          }));
          setAllData(p=>({...p,[year]:{...p[year],[client]:{...p[year][client],docs}}}));
        }
      } catch(e) { console.warn("Could not load:",e); }
      finally { if(!cancelled) setHydratedKeys(p=>({...p,[ckey]:true})); }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line
  }, [client,year,hydratedKeys]);

  // Persist with visible status + one retry. On 409 (someone else saved first)
  // we NEVER overwrite — reload the latest server copy instead.
  const doSave = async (yr, cl, data) => {
    setSaveState("saving");
    const ckey = `${yr}:${cl}`;
    for(let attempt=0; attempt<2; attempt++) {
      try {
        const resp = await api.saveClientData(yr, cl, data, versionsRef.current[ckey] ?? 0);
        versionsRef.current[ckey] = (resp && resp.version) || ((versionsRef.current[ckey] ?? 0) + 1);
        dirtyRef.current = false;
        setSaveState("saved");
        return true;
      } catch(e) {
        if(e && e.status === 409) {
          dirtyRef.current = false;
          setSaveState("error");
          alert("⚠️ Αυτός ο πελάτης ενημερώθηκε από άλλον χρήστη.\n\nΗ οθόνη θα φορτώσει τώρα την τελευταία αποθηκευμένη έκδοση. Οι πολύ πρόσφατες αλλαγές σου ΔΕΝ αποθηκεύτηκαν — ξαναπέρασέ τες.");
          setHydratedKeys(p=>{ const n={...p}; delete n[ckey]; return n; }); // triggers re-hydration
          return false;
        }
        if(attempt===1) { console.warn("Save failed:",e); setSaveState("error"); return false; }
        await new Promise(r=>setTimeout(r,700));
      }
    }
  };
  // Flush a pending change immediately (on leave / tab close)
  const flushSave = (beacon) => {
    if(!dirtyRef.current || !ctxRef.current) return;
    const {year:yr, client:cl, cd:c} = ctxRef.current;
    const {docs, ...rest} = c;
    dirtyRef.current = false;
    if(beacon) { api.saveClientDataBeacon(yr, cl, rest, versionsRef.current[`${yr}:${cl}`] ?? 0); }
    else { return doSave(yr, cl, rest); }
  };
  // Save main data on change (debounced 500ms)
  useEffect(() => {
    if(!client||!cd) return;
    const ckey = `${year}:${client}`;
    if(!hydratedKeys[ckey]) return;
    dirtyRef.current = true;
    setSaveState("saving");
    const {docs, ...rest} = cd;
    const t = setTimeout(() => { doSave(year, client, rest); }, 500);
    return () => clearTimeout(t);
  // eslint-disable-next-line
  }, [cd&&cd.inv,cd&&cd.sub,cd&&cd.lab,cd&&cd.labAlloc,cd&&cd.contracts,cd&&cd.status,cd&&cd.submittedBy,cd&&cd.submittedAt,cd&&cd.rejectNote, client, year]);
  // Flush on tab hide / close so nothing is lost
  useEffect(() => {
    const onVis = () => { if(document.visibilityState==="hidden") flushSave(true); };
    const onUnload = () => flushSave(true);
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("beforeunload", onUnload);
    return () => { document.removeEventListener("visibilitychange", onVis); window.removeEventListener("beforeunload", onUnload); };
  // eslint-disable-next-line
  }, []);

  // Password-reset landing page (from the emailed link): /reset?token=... — shown regardless of auth.
  const resetToken = (typeof window!=="undefined" && window.location.pathname==="/reset")
    ? new URLSearchParams(window.location.search).get("token") : null;
  if (resetToken) return <ResetPassword token={resetToken} />;

  if (authChecking) return <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"Segoe UI,sans-serif",color:"#003F2D",fontSize:14}}>Loading…</div>;
  if (!user) return <Login onLogin={setUser} />;
  if (user.mustChange) return <ForcePw onDone={()=>setUser(p=>({...p,mustChange:false}))} onLogout={logout} />;

  // AI chat assistant — mounted on every authenticated screen; the snapshot reflects the current view.
  const navChat = (view) => {
    if (typeof view !== "string") return;
    const fin = user.role==="finance"||user.role==="admin";
    if (view==="dashboard") { setClient(null); setFinanceOpen(false); setLedgerOpen(false); setDashOpen(true); }
    else if (view==="ledger" && fin) { setClient(null); setDashOpen(false); setFinanceOpen(false); setLedgerOpen(true); }
    else if (view==="opex" && fin) { setClient(null); setDashOpen(false); setLedgerOpen(false); setFinanceOpen(true); }
    else if (view==="clients") { setClient(null); setDashOpen(false); setLedgerOpen(false); setFinanceOpen(false); }
    else if (view.startsWith("tab:")) { if (client) setTab(view.slice(4)); }
    else if (view.startsWith("client:")) { const p=view.split(":"); if (p[1]) { setDashOpen(false); setLedgerOpen(false); setFinanceOpen(false); setClient(p[1]); setTab(p[2]||"contracts"); } }
  };
  const chatEl = <ChatWidget user={user} year={year} ctx={{client, cd:(client&&cd)?cd:null, tab}} nav={navChat} />;
  const withChat = (screen) => <>{screen}{chatEl}</>;

  if (!client && dashOpen)
    return withChat(<Dashboard year={year} setYear={setYear} user={user} onBack={()=>setDashOpen(false)} onLogout={logout} onSelectClient={c=>{setDashOpen(false);setClient(c);setTab("contracts");}} />);
  if (!client && ledgerOpen && (user.role==="finance"||user.role==="admin"))
    return withChat(<ApArLedger year={year} setYear={setYear} user={user} onBack={()=>setLedgerOpen(false)} onLogout={logout} onSelectClient={c=>{setLedgerOpen(false);setClient(c);setTab("inv");}} />);
  if (!client && financeOpen && (user.role==="finance"||user.role==="admin"))
    return withChat(<OpexCapex year={year} setYear={setYear} user={user} onBack={()=>setFinanceOpen(false)} onLogout={logout} />);
  if (!client) return withChat(<ClientPicker user={user} year={year} setYear={setYear} onSelect={c=>{setClient(c);setTab("contracts");}} onLogout={logout} allData={yd} onOpenFinance={()=>setFinanceOpen(true)} onOpenDash={()=>setDashOpen(true)} onOpenLedger={()=>setLedgerOpen(true)} />);

  const inv=cd.inv; const sub=cd.sub; const lab=cd.lab; const contracts=cd.contracts; const docs=cd.docs||[];
  const labAlloc=cd.labAlloc||mkAlloc();
  const setInv=v=>upClient("inv",v);
  const setSub=v=>upClient("sub",v);
  const setLab=v=>upClient("lab",v);
  const setLabAlloc=v=>upClient("labAlloc",v);
  const setContracts=v=>upClient("contracts",v);
  const setDocs=v=>upClient("docs",v);

  const exportXL = () => {
    const wb = XLSX.utils.book_new();
    const G = "003F2D"; // CBRE emerald
    const hs = {font:{name:"Arial",sz:12,bold:true,color:{rgb:"FFFFFF"}},fill:{patternType:"solid",fgColor:{rgb:G}},alignment:{horizontal:"center",vertical:"center",wrapText:true}};
    const ds = {font:{name:"Arial",sz:12}};
    const dc = {font:{name:"Arial",sz:12},alignment:{horizontal:"center"}};
    const eur = '_([$€-2]\\ * #,##0.00_);_([$€-2]\\ * \\(#,##0.00\\);_([$€-2]\\ * "-"??_);_(@_)';
    const eurC = {...dc, numFmt:eur};
    const phs = {font:{name:"Arial",sz:10,bold:true,color:{rgb:"FFFFFF"}},fill:{patternType:"solid",fgColor:{rgb:G}},alignment:{horizontal:"center"}};
    const pbs = {font:{name:"Arial",sz:10,bold:true}};
    const pds = {font:{name:"Arial",sz:10},alignment:{horizontal:"center"},numFmt:"#,##0"};
    const pps = {font:{name:"Arial",sz:10},alignment:{horizontal:"center"},numFmt:"0.0%"};
    const ts = {font:{name:"Arial",sz:12,bold:true,color:{rgb:"FFFFFF"}},fill:{patternType:"solid",fgColor:{rgb:G}},alignment:{horizontal:"center"},numFmt:"#,##0"};
    const mmyy = '[$-409]mmm\\-yy;@';
    const ce = (r,c) => XLSX.utils.encode_cell({r,c});
    const cl = c => XLSX.utils.encode_col(c);
    const sc = (ws,r,c,v,s,f) => { const a = ce(r,c); if(f) ws[a] = {t:'n',f,s}; else ws[a] = {v,t:typeof v==='number'?'n':'s',s}; };

    // ── 1. SUB INVOICES ──
    const subH = ["Site","Month","Subcontractor Category","GL Code","Supplier name","Service category","Service description","Invoice number","Date","Amount (excl VAT)","VAT","TOTAL","Fee %","CBRE Fee","CBRE Billing","Actual/Accrual","Comments"];
    const subData = [subH];
    sub.forEach(r => subData.push([r.site,ML[r.month]||r.month,r.cat,r.gl,r.supplier,r.svc_cat||"",r.svc_desc||"",r.inv_no||"",r.date||"",r.amt,null,null,0.055,null,null,r.act_acc||"",r.comments||""]));
    const sWS = XLSX.utils.aoa_to_sheet(subData);
    // Header styles
    subH.forEach((_,i) => { if(sWS[ce(0,i)]) sWS[ce(0,i)].s = hs; });
    // Data styles + formulas
    sub.forEach((r,i) => {
      const row = i+1;
      const R = row+1; // Excel row
      [0,2,3,4,5,6,15,16].forEach(c => { if(sWS[ce(row,c)]) sWS[ce(row,c)].s = ds; });
      if(sWS[ce(row,1)]) sWS[ce(row,1)].s = {...ds, numFmt:mmyy};
      if(sWS[ce(row,7)]) sWS[ce(row,7)].s = {...dc, numFmt:'@'};
      if(sWS[ce(row,8)]) sWS[ce(row,8)].s = {...ds, numFmt:'dd/mm/yyyy'};
      if(sWS[ce(row,9)]) sWS[ce(row,9)].s = {font:{name:"Arial",sz:12},numFmt:eur,alignment:{horizontal:"center"}};
      // Real VAT (not a fixed 24% formula) so reduced rates (13/6/0%) export correctly
      sWS[ce(row,10)] = {t:'n',v:(r.vat!=null&&!isNaN(Number(r.vat)))?Number(r.vat):(Number(r.amt)||0)*0.24,s:{font:{name:"Arial",sz:12},numFmt:eur,alignment:{horizontal:"center"}}};
      sWS[ce(row,11)] = {t:'n',f:`J${R}+K${R}`,s:{font:{name:"Arial",sz:12},numFmt:eur,alignment:{horizontal:"center"}}};
      if(sWS[ce(row,12)]) sWS[ce(row,12)].s = {font:{name:"Arial",sz:12},numFmt:'0.0%',alignment:{horizontal:"center"}};
      sWS[ce(row,13)] = {t:'n',f:`J${R}*M${R}`,s:{font:{name:"Arial",sz:12},numFmt:eur,alignment:{horizontal:"center"}}};
      sWS[ce(row,14)] = {t:'n',f:`J${R}+N${R}`,s:{font:{name:"Arial",sz:12},numFmt:eur,alignment:{horizontal:"center"}}};
    });
    sWS['!cols'] = [{wch:10},{wch:12},{wch:32},{wch:10},{wch:30},{wch:22},{wch:33},{wch:16},{wch:12},{wch:18},{wch:16},{wch:14},{wch:8},{wch:14},{wch:16},{wch:16},{wch:20}];
    sWS['!rows'] = [{hpt:42}];
    XLSX.utils.book_append_sheet(wb, sWS, "Sub Invoices");

    // ── 2. CBRE INVOICES ──
    const invH = ["CLIENT","Site","Month","Revenue category","Amount","VAT","TOTAL","INVOICE NUMBER","DATE","COMMENTS","Actual/Accrual","PO No"];
    const invData = [invH];
    inv.forEach(r => invData.push([r.client,r.site,ML[r.month]||r.month,r.cat,r.amt,null,null,r.inv_no||"",r.date||"",r.comments||"",r.act_acc||"",r.po_no||""]));
    const iWS = XLSX.utils.aoa_to_sheet(invData);
    invH.forEach((_,i) => { if(iWS[ce(0,i)]) iWS[ce(0,i)].s = hs; });
    inv.forEach((r,i) => {
      const row = i+1; const R = row+1;
      [0,1,3,9,10,11].forEach(c => { if(iWS[ce(row,c)]) iWS[ce(row,c)].s = ds; });
      if(iWS[ce(row,2)]) iWS[ce(row,2)].s = {...ds, numFmt:mmyy};
      if(iWS[ce(row,4)]) iWS[ce(row,4)].s = {font:{name:"Arial",sz:12},numFmt:eur};
      // Real VAT (not a fixed 24% formula) so reduced rates (13/6/0%) export correctly
      iWS[ce(row,5)] = {t:'n',v:(r.vat!=null&&!isNaN(Number(r.vat)))?Number(r.vat):(Number(r.amt)||0)*0.24,s:{font:{name:"Arial",sz:12},numFmt:eur}};
      iWS[ce(row,6)] = {t:'n',f:`E${R}+F${R}`,s:{font:{name:"Arial",sz:12},numFmt:eur}};
      if(iWS[ce(row,7)]) iWS[ce(row,7)].s = {...dc,numFmt:'@'};
      if(iWS[ce(row,8)]) iWS[ce(row,8)].s = {...dc,numFmt:'dd/mm/yyyy'};
    });
    iWS['!cols'] = [{wch:16},{wch:14},{wch:10},{wch:30},{wch:15},{wch:12},{wch:12},{wch:18},{wch:10},{wch:29},{wch:16},{wch:11}];
    iWS['!rows'] = [{hpt:42}];
    XLSX.utils.book_append_sheet(wb, iWS, "CBRE Invoices");

    // ── 3. P&L REPORT ──
    const am = MONTHS.filter(m => inv.some(i=>i.month===m) || sub.some(i=>i.month===m) || (lab[m] && Object.values(lab[m]).some(v=>Number(v)>0)));
    if(!am.length) am.push(...MONTHS.slice(0,4));
    const pRows = [];
    pRows.push(["","",`GREECE ${year}- Profit & Loss - EURO`]);
    pRows.push([]);
    pRows.push(["ISCALA","","MONTHS >>",...am.map(m=>ML[m])]);
    const pnlLines = [
      ["CLIENT REVENUE - FM Core","rev_core"],["CLIENT REVENUE - FM Extra Works","rev_ew"],["CLIENT REVENUE - PJMs","rev_pjm"],
      ["Total Sales / Revenue","rev_total"],[],
      ["Labour Cost - FM Core","lab_core"],["Labour Cost - FM Extra Works","lab_ew"],["Labour Cost - FM PJMs","lab_pjm"],["Total Labour Cost","lab_total"],
      ["CLIENT Subcontractors cost - FM CORE","sub_core"],["CLIENT Subcontractors cost - FM Extra Works","sub_ew"],["CLIENT Subcontractors cost - PJMs","sub_pjm"],
      ["Total Subcontractor","sub_total"],[],
      ["GM - Total","gm"],[],
      ["GM - FM Core","gm_core"],["GM - FM Core %","gm_core_pct"],["GM - FM Extra Works","gm_ew"],["GM - FM Extra Works %","gm_ew_pct"],["GM - FM PJM","gm_pjm"],
    ];
    pnlLines.forEach(pl => { if(!pl.length){pRows.push([]);return;} pRows.push([pl[0],"","",...am.map(()=>null)]); });
    const pWS = XLSX.utils.aoa_to_sheet(pRows);
    // Title
    sc(pWS,0,2,`GREECE ${year}- Profit & Loss - EURO`,{font:{name:"Arial",sz:10,bold:true}});
    // Header row (row index 2)
    sc(pWS,2,0,"ISCALA",pbs);
    sc(pWS,2,2,"MONTHS >>",phs);
    am.forEach((m,mi) => sc(pWS,2,3+mi,ML[m],phs));
    // Data rows with formulas
    let pr = 3; // current pnl row
    pnlLines.forEach(pl => {
      if(!pl.length){pr++;return;}
      const label=pl[0],key=pl[1];
      const isBold = key.includes("total") || key==="gm";
      const isPct = key.includes("pct");
      const st = isPct ? pps : isBold ? {...pds,font:{name:"Arial",sz:10,bold:true}} : pds;
      sc(pWS,pr,2,label,isBold?pbs:{font:{name:"Arial",sz:10}});
      am.forEach((m,mi) => {
        const col=3+mi; const C=XLSX.utils.encode_col(col); const R=pr+1;
        if(key==="rev_core") sc(pWS,pr,col,null,st,`SUMIFS('CBRE Invoices'!$E:$E,'CBRE Invoices'!$D:$D,"CLIENT REVENUE - FM Core",'CBRE Invoices'!$C:$C,${C}3)`);
        else if(key==="rev_ew") sc(pWS,pr,col,null,st,`SUMIFS('CBRE Invoices'!$E:$E,'CBRE Invoices'!$D:$D,"CLIENT REVENUE - FM Extra Works",'CBRE Invoices'!$C:$C,${C}3)`);
        else if(key==="rev_pjm") sc(pWS,pr,col,null,st,`SUMIFS('CBRE Invoices'!$E:$E,'CBRE Invoices'!$D:$D,"CLIENT REVENUE - PJMs",'CBRE Invoices'!$C:$C,${C}3)`);
        else if(key==="rev_total") sc(pWS,pr,col,null,st,`${C}${pr-2}+${C}${pr-1}+${C}${pr}`);
        else if(key==="lab_core"||key==="lab_ew"||key==="lab_pjm") { const lt=lab[m]?Object.values(lab[m]).reduce((s,v)=>s+(Number(v)||0),0):0; const fr=allocFractions(labAlloc,m); const f=key==="lab_core"?fr.core:key==="lab_ew"?fr.ew:fr.pjm; sc(pWS,pr,col,Math.round(lt*f*100)/100,st); }
        else if(key==="lab_total") sc(pWS,pr,col,null,st,`${C}9+${C}10+${C}11`);
        else if(key==="sub_core") sc(pWS,pr,col,null,st,`SUMIFS('Sub Invoices'!$J:$J,'Sub Invoices'!$C:$C,"*CORE*",'Sub Invoices'!$B:$B,${C}3)`);
        else if(key==="sub_ew") sc(pWS,pr,col,null,st,`SUMIFS('Sub Invoices'!$J:$J,'Sub Invoices'!$C:$C,"*Extra*",'Sub Invoices'!$B:$B,${C}3)`);
        else if(key==="sub_pjm") sc(pWS,pr,col,null,st,`SUMIFS('Sub Invoices'!$J:$J,'Sub Invoices'!$C:$C,"*PJM*",'Sub Invoices'!$B:$B,${C}3)`);
        else if(key==="sub_total") sc(pWS,pr,col,null,st,`${C}${pr-2}+${C}${pr-1}+${C}${pr}`);
        else if(key==="gm") sc(pWS,pr,col,null,st,`${C}${pr-10}-${C}${pr-5}-${C}${pr-1}`);
        else if(key==="gm_core") sc(pWS,pr,col,null,st,`${C}4-${C}9-${C}13`);
        else if(key==="gm_core_pct") sc(pWS,pr,col,null,pps,`IF(${C}4=0,"",${C}20/${C}4)`);
        else if(key==="gm_ew") sc(pWS,pr,col,null,st,`${C}5-${C}10-${C}14`);
        else if(key==="gm_ew_pct") sc(pWS,pr,col,null,pps,`IF(${C}5=0,"",${C}22/${C}5)`);
        else if(key==="gm_pjm") sc(pWS,pr,col,null,st,`${C}6-${C}11-${C}15`);
      });
      pr++;
    });
    pWS['!cols'] = [{wch:11},{wch:5},{wch:36},...am.map(()=>({wch:11}))];
    XLSX.utils.book_append_sheet(wb, pWS, "P&L Report");

    // ── 4. LABOUR COST ──
    const labH = ["Category","FTEs",...am.map(m=>ML[m])];
    const labData = [labH];
    LAB_ROWS.forEach(r => { const row=[r.l,""];am.forEach(m=>row.push(Number(lab[m]?.[r.k])||0));labData.push(row); });
    labData.push(["SUM","",...am.map(()=>null)]);
    const lWS = XLSX.utils.aoa_to_sheet(labData);
    labH.forEach((_,i) => { if(lWS[ce(0,i)]) lWS[ce(0,i)].s = {font:{name:"Arial",sz:10,bold:true},alignment:{horizontal:i>=2?"right":"left"}}; });
    LAB_ROWS.forEach((r,i) => { am.forEach((m,mi) => { const c=lWS[ce(i+1,2+mi)]; if(c) c.s={font:{name:"Arial",sz:10},numFmt:"#,##0.00",alignment:{horizontal:"center"}}; }); });
    am.forEach((m,mi) => { const C=XLSX.utils.encode_col(2+mi); lWS[ce(LAB_ROWS.length+1,2+mi)]={t:'n',f:`SUM(${C}2:${C}${LAB_ROWS.length+1})`,s:{font:{name:"Arial",sz:10,bold:true},numFmt:"#,##0.00",alignment:{horizontal:"center"}}}; });
    lWS['!cols'] = [{wch:14},{wch:9},...am.map(()=>({wch:11}))];
    XLSX.utils.book_append_sheet(wb, lWS, "Labour Cost");

    // ── 5. ACCRUALS ──
    const accData = [["ACCRUAL"],["","","UBR/UER"],["","","OpenBalance","MONTHS >>",...am.map(m=>ML[m])]];
    const accRevR = [{l:"UBR/UER-FM Core",c:"CLIENT REVENUE - FM Core"},{l:"UBR/UER-FM Extra works",c:"CLIENT REVENUE - FM Extra Works"},{l:"UBR/UER-FM PJM",c:"CLIENT REVENUE - PJMs"}];
    accRevR.forEach(ar => { accData.push(["","","",ar.l,...am.map(()=>null)]); });
    accData.push(["","","","Total",...am.map(()=>null)]);
    accData.push([],[],["","","Expense Accrual"],["","","OpenBalance","MONTHS >>",...am.map(m=>ML[m])]);
    const accCstR = [{l:"SubCost-FM Core",c:"*CORE*"},{l:"SubCost-FM Extra works",c:"*Extra*"},{l:"SubCost-FM PJM",c:"*PJM*"}];
    accCstR.forEach(ar => { accData.push(["","","",ar.l,...am.map(()=>null)]); });
    accData.push(["","","","Total ",...am.map(()=>null)]);
    const aWS = XLSX.utils.aoa_to_sheet(accData);
    // Style headers
    sc(aWS,0,0,"ACCRUAL",{font:{name:"Arial",sz:10,bold:true}});
    sc(aWS,1,2,"UBR/UER",{font:{name:"Arial",sz:12,bold:true}});
    [2,9].forEach(hr => { for(let c=2;c<4+am.length;c++) { const x=aWS[ce(hr,c)]; if(x) x.s=phs; } });
    // SUMIFS for UBR
    accRevR.forEach((ar,i) => { am.forEach((m,mi) => {
      const col=4+mi; const C=XLSX.utils.encode_col(col);
      aWS[ce(3+i,col)]={t:'n',f:`SUMIFS('CBRE Invoices'!$E:$E,'CBRE Invoices'!$D:$D,"${ar.c}",'CBRE Invoices'!$C:$C,${C}3)`,s:{font:{name:"Arial",sz:12},numFmt:"#,##0",alignment:{horizontal:"center"}}};
    }); });
    // Total row
    am.forEach((m,mi) => { const col=4+mi; const C=XLSX.utils.encode_col(col); aWS[ce(6,col)]={t:'n',f:`SUM(${C}4:${C}6)`,s:ts}; });
    for(let c=2;c<4+am.length;c++){ const x=aWS[ce(6,c)]; if(x&&!x.s) x.s=ts; if(x) x.s=ts; }
    sc(aWS,6,3,"Total",ts);
    // SUMIFS for costs
    accCstR.forEach((ar,i) => { am.forEach((m,mi) => {
      const col=4+mi; const C=XLSX.utils.encode_col(col);
      aWS[ce(10+i,col)]={t:'n',f:`SUMIFS('Sub Invoices'!$J:$J,'Sub Invoices'!$C:$C,"${ar.c}",'Sub Invoices'!$B:$B,${C}10)`,s:{font:{name:"Arial",sz:12},numFmt:"#,##0",alignment:{horizontal:"center"}}};
    }); });
    am.forEach((m,mi) => { const col=4+mi; const C=XLSX.utils.encode_col(col); aWS[ce(13,col)]={t:'n',f:`SUM(${C}11:${C}13)`,s:ts}; });
    sc(aWS,13,3,"Total ",ts);
    aWS['!cols'] = [{wch:35},{wch:9},{wch:16},{wch:23},...am.map(()=>({wch:10}))];
    XLSX.utils.book_append_sheet(wb, aWS, "Accrual");

    // ── Download ──
    XLSX.writeFile(wb, "CBRE_"+client.replace(/\s/g,"")+"_Report_"+year+".xlsx");
  };

  // Import historical data from Excel
  const importExcel = async (file) => {
    if(!file) return;
    setImporting(true);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf,{type:"array",cellDates:true});
      const sheetNames = wb.SheetNames;
      const get = name => name && wb.Sheets[name] ? XLSX.utils.sheet_to_json(wb.Sheets[name],{defval:"",raw:false}) : [];

      // Helper: convert any value to string safely
      const dateToStr = (v) => {
        if(!v) return "";
        if(v instanceof Date && !isNaN(v)) return String(v.getDate()).padStart(2,"0")+"/"+String(v.getMonth()+1).padStart(2,"0")+"/"+v.getFullYear();
        return String(v);
      };

      // Fuzzy sheet finder by name keywords
      const findSheet = (keywords) => {
        const lc = sheetNames.map(n=>n.toLowerCase());
        for(const kw of keywords) {
          const idx = lc.findIndex(n => n.includes(kw.toLowerCase()));
          if(idx>=0) return sheetNames[idx];
        }
        return null;
      };
      // Fallback: detect sheet by column headers
      const findSheetByHeaders = (mustHave, mustNotHave=[]) => {
        for(const name of sheetNames) {
          const data = get(name);
          if(!data.length) continue;
          const headers = Object.keys(data[0]).map(h=>h.toLowerCase().trim());
          const hasAll = mustHave.every(needed => headers.some(h=>h.includes(needed.toLowerCase())));
          const hasNone = mustNotHave.every(bad => !headers.some(h=>h.includes(bad.toLowerCase())));
          if(hasAll && hasNone) return name;
        }
        return null;
      };

      // Detect each sheet — name first, then header content fallback
      let invSheet = findSheet(["cbre invoice","cbre_inv","client invoice","customer invoice","ar invoice","revenue"]);
      let subSheet = findSheet(["sub invoice","subcontractor","sub_inv","sub inv","subs","ap invoice","supplier invoice","cost invoice","ap "]);
      let labSheet = findSheet(["labour cost","labour","labor cost","labor","staff cost","payroll","headcount"]);
      let conSheet = findSheet(["contract","po list","purchase order"]);

      // Header-based fallback for sub (detects by presence of supplier+amount, no client_revenue)
      if(!subSheet) subSheet = findSheetByHeaders(["supplier","amount"]) || findSheetByHeaders(["vendor","amount"]) || findSheetByHeaders(["supplier","net"]);
      // For inv (revenue) — has revenue category or client revenue
      if(!invSheet) invSheet = findSheetByHeaders(["category","amount"], ["supplier","vendor"]);
      // Avoid sub being same as inv
      if(invSheet && invSheet===subSheet) {
        const altSub = sheetNames.find(n => n!==invSheet && get(n).length>0 && Object.keys(get(n)[0]||{}).some(h=>h.toLowerCase().includes("supplier")));
        if(altSub) subSheet = altSub;
      }

      const fld = (r,...keys) => {
        for(const k of keys) {
          if(r[k]!==undefined && r[k]!=="" && r[k]!==null) return r[k];
          const found = Object.keys(r).find(rk => rk.toLowerCase().trim()===k.toLowerCase().trim());
          if(found && r[found]!==undefined && r[found]!=="" && r[found]!==null) return r[found];
          // Partial match
          const partial = Object.keys(r).find(rk => rk.toLowerCase().trim().includes(k.toLowerCase().trim()));
          if(partial && r[partial]!==undefined && r[partial]!=="" && r[partial]!==null) return r[partial];
        }
        return "";
      };

      const parseMonth = (v) => {
        if(!v) return MONTHS[0];
        if(MONTHS.includes(v)) return v;
        if(v instanceof Date && !isNaN(v)) return v.getFullYear()+"-"+String(v.getMonth()+1).padStart(2,"0");
        const s = String(v).trim();
        const ymMatch = s.match(/(\d{4})[-\/](\d{1,2})/);
        if(ymMatch) {const m = ymMatch[1]+"-"+ymMatch[2].padStart(2,"0"); return MONTHS.includes(m)?m:MONTHS[0];}
        const dmyMatch = s.match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/);
        if(dmyMatch) {const y=dmyMatch[3].length===2?"20"+dmyMatch[3]:dmyMatch[3]; const m=y+"-"+dmyMatch[2].padStart(2,"0"); return MONTHS.includes(m)?m:MONTHS[0];}
        const monMap = {jan:"01",feb:"02",mar:"03",apr:"04",may:"05",jun:"06",jul:"07",aug:"08",sep:"09",oct:"10",nov:"11",dec:"12",ian:"01",fev:"02",mar:"03",apr:"04",mai:"05",iun:"06",iul:"07",aug:"08",sep:"09",oct:"10",noi:"11",dec:"12"};
        const lc = s.toLowerCase();
        for(const [n,num] of Object.entries(monMap)) {
          if(lc.includes(n)) {
            const yMatch = s.match(/(\d{2,4})/);
            const y = yMatch ? (yMatch[1].length===2?"20"+yMatch[1]:yMatch[1]) : "2026";
            const m = y+"-"+num;
            return MONTHS.includes(m)?m:MONTHS[0];
          }
        }
        return MONTHS[0];
      };

      const num = (v) => {
        if(v===""||v==null) return 0;
        if(typeof v==="number") return v;
        let s = String(v).replace(/\s/g,"").replace(/€|\$/g,"");
        if(/^-?\d{1,3}\.\d{3}/.test(s) || (s.includes(",")&&s.match(/,\d{2}$/))) s=s.replace(/\./g,"").replace(",",".");
        else s = s.replace(/,/g,"");
        const n = parseFloat(s);
        return isNaN(n) ? 0 : n;
      };

      const matchCat = (val, list) => {
        if(!val) return list[0];
        const v = String(val).toLowerCase().trim();
        const exact = list.find(c => c.toLowerCase().trim()===v);
        if(exact) return exact;
        const partial = list.find(c => c.toLowerCase().includes(v) || v.includes(c.toLowerCase()));
        if(partial) return partial;
        if(v.includes("core")) return list.find(c=>c.toLowerCase().includes("core"))||list[0];
        if(v.includes("extra")||v.includes("exra")) return list.find(c=>c.toLowerCase().includes("extra"))||list[0];
        if(v.includes("pjm")||v.includes("project")) return list.find(c=>c.toLowerCase().includes("pjm"))||list[0];
        return list[0];
      };

      // ── CBRE Invoices ──
      const newInv = invSheet ? get(invSheet).map((r,i)=>{
        const a = num(fld(r,"Amount","amt","Amount €","Net","Net Amount","Net €","Καθαρή Αξία"));
        const v = num(fld(r,"VAT","vat","VAT €","ΦΠΑ","Φ.Π.Α."));
        const t = num(fld(r,"Total","total","Total €","Σύνολο","Πληρωτέο"))||(a+v);
        return {
          id:Date.now()+i,
          site:fld(r,"Site","site")||"Site 1",
          month:parseMonth(fld(r,"Month","month","Period","Period/Month")),
          cat:matchCat(fld(r,"Category","cat","Revenue Cat","Revenue Category"),REV_CATS),
          amt:a, vat:v||a*0.24, total:t,
          inv_no:String(fld(r,"Invoice No","inv_no","Inv No","Αρ. Τιμολογίου","Invoice Number","Inv #","No")||""),
          date:dateToStr(fld(r,"Date","date","Ημερομηνία","Invoice Date")),
          comments:String(fld(r,"Comments","comments","Notes","Σχόλια")||""),
          act_acc:String(fld(r,"Act/Acc","act_acc","Actual/Accrual","Type")||"ACTUAL").toUpperCase().includes("ACCR")?"ACCRUAL":"ACTUAL",
          po_no:String(fld(r,"PO No","po_no","PO","PO#","Purchase Order")||"")
        };
      }).filter(x=>x.amt!==0||x.inv_no||x.cat!==REV_CATS[0]) : [];

      // ── Sub Invoices ──
      const newSub = subSheet ? get(subSheet).map((r,i)=>{
        const a = num(fld(r,"Amount","amt","Amount €","Net","Net Amount","Net €","Net Value","Καθαρή Αξία","Αξία"));
        const v = num(fld(r,"VAT","vat","VAT €","ΦΠΑ","Φ.Π.Α."));
        const t = num(fld(r,"Total","total","Total €","Total Amount","Σύνολο"))||(a+v);
        const fee = num(fld(r,"Fee","fee_pct","Fee %","CBRE Fee %","Mgt Fee","Management Fee"))||5.5;
        const supplier = String(fld(r,"Supplier","supplier","Vendor","Vendor Name","Supplier Name","Προμηθευτής","Επωνυμία")||"");
        const invNo = String(fld(r,"Invoice No","inv_no","Inv No","Invoice #","Invoice Number","Αρ. Τιμολογίου","No","Number")||"");
        const feeNorm = fee>1?fee/100:fee;
        return {
          id:Date.now()+1000+i,
          site:String(fld(r,"Site","site")||"Site 1"),
          month:parseMonth(fld(r,"Month","month","Period","Per","Mo")),
          cat:matchCat(fld(r,"Category","cat","Sub Category","Cost Category","Cost Cat","Type"),COST_CATS),
          supplier,
          svc_cat:String(fld(r,"Service","svc_cat","Service Cat","Service Category","Svc Cat")||"Other"),
          svc_desc:String(fld(r,"Description","svc_desc","Service Desc","Service Description","Desc","Περιγραφή")||""),
          amt:a, vat:v||a*0.24, total:t,
          inv_no:invNo,
          date:dateToStr(fld(r,"Date","date","Ημερομηνία","Invoice Date")),
          fee_pct:feeNorm, cbre_fee:a*feeNorm, cbre_billing:a+a*feeNorm,
          act_acc:String(fld(r,"Act/Acc","act_acc","Actual/Accrual","Status")||"ACTUAL").toUpperCase().includes("ACCR")?"ACCRUAL":"ACTUAL",
          comments:String(fld(r,"Comments","comments","Notes","Σχόλια","PO No","po_no","PO")||"")
        };
      }).filter(x=>x.amt!==0||x.inv_no||x.supplier) : [];

      // ── Labour ──
      const newLab = mkLab();
      let labRowsImported = 0;
      if(labSheet){
        // Strict month finder: exact or case-insensitive trimmed match only (no partial)
        const strictFld = (r, ...keys) => {
          for(const k of keys) {
            if(r[k]!==undefined && r[k]!=="" && r[k]!==null) return r[k];
            const found = Object.keys(r).find(rk => rk.toLowerCase().trim()===k.toLowerCase().trim());
            if(found && r[found]!==undefined && r[found]!=="" && r[found]!==null) return r[found];
          }
          return "";
        };
        get(labSheet).forEach(r => {
          const catRaw = fld(r,"Category","cat","Line","Description")||"";
          const lc = String(catRaw).toLowerCase();
          let labKey = LAB_ROWS.find(x=>x.l.toLowerCase()===lc.trim())?.k;
          if(!labKey){
            if(lc.includes("onsite")||lc.includes("on site")||lc.includes("on-site")) labKey="onsite";
            else if(lc.includes("regional")) labKey="regional";
            else if(lc.includes("local")) labKey="local";
            else if(lc.includes("sg&a")||lc.includes("sga")) labKey="sga";
            else if(lc.includes("it")&&!lc.includes("with")&&!lc.includes("its")) labKey="it";
            else if(lc.includes("other")) labKey="other";
          }
          if(labKey){
            MONTHS.forEach(m => {
              // Strict match only — exact month column
              const v = strictFld(r, ML[m], m, ML[m].replace("-","_"));
              if(num(v)) {newLab[m][labKey] = num(v); labRowsImported++;}
            });
          }
        });
      }

      // ── Contracts ──
      const newContracts = conSheet ? get(conSheet).map((r,i)=>{
        const t = String(fld(r,"Type","type")||"PO").toUpperCase();
        return {
          id:Date.now()+2000+i,
          type:t.includes("MSA")?"MSA":t.includes("LEA")||t.includes("LCA")?"LEA":t.includes("AMEND")?"Amendment":t.includes("NDA")?"NDA":t.includes("PO")||t.includes("PURCHASE")?"PO":"Other",
          ref:String(fld(r,"Reference","ref","Contract Ref","Contract Number")||""),
          client:String(fld(r,"Client","client","Customer")||""),
          start:dateToStr(fld(r,"Start","start","Start Date","From")),
          expiry:dateToStr(fld(r,"Expiry","expiry","Expiry Date","End","To")),
          fee_pct:num(fld(r,"Fee %","fee_pct","Fee","Management Fee"))||5.5,
          status:String(fld(r,"Status","status")||"Active"),
          po:String(fld(r,"PO No","po","PO Number","PO#")||""),
          po_value:num(fld(r,"PO Value","po_value","PO Value €","Value")),
          scope:String(fld(r,"Scope","scope","Description")||""),
          notes:String(fld(r,"Notes","notes","Comments")||"")
        };
      }).filter(x=>x.ref||x.po) : [];

      // Apply imports — preview counts, then let the user choose Merge vs Replace
      const hasExisting = (cd.inv?.length||0) + (cd.sub?.length||0) + (cd.contracts?.length||0) > 0;
      let mode = "replace";
      if(hasExisting) {
        const ans = prompt(
          `Βρέθηκαν προς εισαγωγή στο ${client} ${year}:\n`+
          `  • CBRE Invoices: ${newInv.length}\n  • Sub Invoices: ${newSub.length}\n  • Labour rows: ${labRowsImported}\n  • Contracts/POs: ${newContracts.length}\n\n`+
          `Υπάρχουν ήδη δεδομένα. Γράψε:\n  M = Merge (πρόσθεσε στα υπάρχοντα)\n  R = Replace (αντικατέστησε όλα)\n\n(Άκυρο για ακύρωση)`,
          "M");
        if(ans===null) { setImporting(false); setMenuOpen(false); return; }
        mode = /^\s*r/i.test(ans) ? "replace" : "merge";
      }
      if(mode==="replace") {
        if(newInv.length) setInv(newInv);
        if(newSub.length) setSub(newSub);
        if(labRowsImported) setLab(newLab);
        if(newContracts.length) setContracts(newContracts);
      } else {
        if(newInv.length) setInv(p=>[...(p||[]),...newInv]);
        if(newSub.length) setSub(p=>[...(p||[]),...newSub]);
        if(newContracts.length) setContracts(p=>[...(p||[]),...newContracts]);
        if(labRowsImported) setLab(p=>{ const out={}; MONTHS.forEach(m=>{ out[m]={...(p?.[m]||{})}; LAB_ROWS.forEach(r=>{ const nv=Number(newLab[m]?.[r.k])||0; if(nv) out[m][r.k]=nv; }); }); return out; });
      }

      // Build diagnostic info
      const diag = [];
      diag.push(`✓ Imported into ${client} ${year}:`);
      diag.push(``);
      diag.push(`📄 CBRE Invoices: ${newInv.length}${invSheet?` (sheet: "${invSheet}")`:" — NO SHEET DETECTED"}`);
      diag.push(`📑 Sub Invoices: ${newSub.length}${subSheet?` (sheet: "${subSheet}")`:" — NO SHEET DETECTED"}`);
      diag.push(`👥 Labour rows: ${labRowsImported}${labSheet?` (sheet: "${labSheet}")`:" — NO SHEET DETECTED"}`);
      diag.push(`📋 Contracts/POs: ${newContracts.length}${conSheet?` (sheet: "${conSheet}")`:" — NO SHEET DETECTED"}`);
      diag.push(``);
      diag.push(`Sheets in file: ${sheetNames.join(", ")}`);
      // If sub failed, dump first row keys for debug
      if(subSheet && newSub.length===0) {
        const sample = get(subSheet)[0];
        if(sample) diag.push(``,`Sub sheet "${subSheet}" columns found:`,Object.keys(sample).join(", "));
      }
      if(!subSheet) {
        diag.push(``,`⚠ No Sub sheet matched. Rename your subcontractors sheet to "Sub Invoices" or include "subcontractor"/"supplier" in the name.`);
      }
      alert(diag.join("\n"));
    } catch(e) {
      console.error(e);
      alert("Import failed: "+e.message);
    } finally {
      setImporting(false);
      setMenuOpen(false);
    }
  };

  return withChat(
    <div style={{minHeight:"100vh",background:P.of,fontFamily:"Segoe UI,Tahoma,sans-serif"}}>
      <div style={{background:P.em,color:P.wh,padding:"12px 24px",display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:8}}>
        <div style={{display:"flex",alignItems:"center",gap:16}}>
          <span style={{fontWeight:800,fontSize:18,letterSpacing:1}}>CBRE</span>
          <button onClick={()=>{flushSave();setClient(null);}} style={{background:"rgba(255,255,255,.2)",border:"none",color:"#fff",padding:"4px 12px",borderRadius:4,cursor:"pointer",fontSize:12}}>◀ Clients</button>
          <LogoImg name={client} size={28} radius={4} />
          <span style={{fontSize:14,fontWeight:600,borderLeft:"1px solid rgba(255,255,255,.3)",paddingLeft:12}}>{client} — {year}</span>
          {(()=>{const rs=REPORT_STATUS.find(x=>x.v===(cd.status||"draft"))||REPORT_STATUS[0]; return <span style={{padding:"3px 12px",borderRadius:12,fontSize:10,fontWeight:700,background:rs.bg,color:rs.color,marginLeft:8}}>{rs.l}</span>;})()}
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8,fontSize:13,position:"relative"}}>
          {/* Quick approve/reject for finance */}
          {(user.role==="finance"||user.role==="admin")&&cd.status==="submitted"&&(
            <>
              <button onClick={()=>{upClient("status","approved");upClient("rejectNote","");}} style={{background:P.gn,border:"none",color:"#fff",padding:"6px 14px",borderRadius:4,cursor:"pointer",fontSize:12,fontWeight:600}}>✓ Approve</button>
              <button onClick={()=>{const why=prompt("Λόγος απόρριψης (θα τον δει ο χρήστης που υπέβαλε):","");if(why===null)return;upClient("status","rejected");upClient("rejectNote",why||"");}} style={{background:P.rd,border:"none",color:"#fff",padding:"6px 14px",borderRadius:4,cursor:"pointer",fontSize:12,fontWeight:600}}>✗ Reject</button>
            </>
          )}

          {/* Actions dropdown */}
          <div style={{position:"relative"}}>
            <button onClick={()=>setMenuOpen(!menuOpen)} style={{background:"#00897B",border:"none",color:"#fff",padding:"7px 16px",borderRadius:4,cursor:"pointer",fontSize:12,fontWeight:600,display:"flex",alignItems:"center",gap:6}}>
              ⚙️ Actions <span style={{fontSize:9}}>{menuOpen?"▲":"▼"}</span>
            </button>
            {menuOpen && (
              <>
                <div onClick={()=>setMenuOpen(false)} style={{position:"fixed",top:0,left:0,right:0,bottom:0,zIndex:99}} />
                <div style={{position:"absolute",top:"calc(100% + 6px)",right:0,background:"#fff",borderRadius:8,boxShadow:"0 8px 24px rgba(0,0,0,.18)",minWidth:240,zIndex:100,overflow:"hidden",border:"1px solid "+P.bd}}>
                  {/* Submit */}
                  {(user.role==="ops"||user.role==="admin")&&(cd.status||"draft")==="draft"&&(
                    <button onClick={()=>{upClient("status","submitted");upClient("submittedBy",user.name);upClient("submittedAt",new Date().toLocaleDateString());setMenuOpen(false);}} style={{display:"flex",alignItems:"center",gap:10,width:"100%",padding:"11px 16px",border:"none",background:"none",cursor:"pointer",fontSize:13,color:"#F57F17",fontWeight:600,textAlign:"left",borderBottom:"1px solid "+P.bd}}>
                      <span style={{fontSize:16}}>📤</span><div><div>Submit Report</div><div style={{fontSize:10,color:P.tm,fontWeight:400}}>Send to finance for approval</div></div>
                    </button>
                  )}
                  {(user.role==="ops"||user.role==="admin")&&cd.status==="rejected"&&(
                    <button onClick={()=>{upClient("status","submitted");upClient("submittedBy",user.name);upClient("submittedAt",new Date().toLocaleDateString());upClient("rejectNote","");setMenuOpen(false);}} style={{display:"flex",alignItems:"center",gap:10,width:"100%",padding:"11px 16px",border:"none",background:"none",cursor:"pointer",fontSize:13,color:"#F57F17",fontWeight:600,textAlign:"left",borderBottom:"1px solid "+P.bd}}>
                      <span style={{fontSize:16}}>📤</span><div><div>Re-Submit Report</div><div style={{fontSize:10,color:P.tm,fontWeight:400}}>After making corrections</div></div>
                    </button>
                  )}
                  {cd.status==="approved"&&user.role==="admin"&&(
                    <button onClick={()=>{upClient("status","draft");setMenuOpen(false);}} style={{display:"flex",alignItems:"center",gap:10,width:"100%",padding:"11px 16px",border:"none",background:"none",cursor:"pointer",fontSize:13,color:P.tx,fontWeight:600,textAlign:"left",borderBottom:"1px solid "+P.bd}}>
                      <span style={{fontSize:16}}>↺</span><div><div>Reopen Report</div><div style={{fontSize:10,color:P.tm,fontWeight:400}}>Move back to draft</div></div>
                    </button>
                  )}
                  {/* Export Excel */}
                  <button onClick={()=>{exportXL();setMenuOpen(false);}} style={{display:"flex",alignItems:"center",gap:10,width:"100%",padding:"11px 16px",border:"none",background:"none",cursor:"pointer",fontSize:13,color:P.em,fontWeight:600,textAlign:"left",borderBottom:"1px solid "+P.bd}}>
                    <span style={{fontSize:16}}>📥</span><div><div>Download Excel</div><div style={{fontSize:10,color:P.tm,fontWeight:400}}>Export full report</div></div>
                  </button>
                  {/* Import Excel */}
                  <label style={{display:"flex",alignItems:"center",gap:10,width:"100%",padding:"11px 16px",cursor:importing?"wait":"pointer",fontSize:13,color:P.em,fontWeight:600,textAlign:"left",borderBottom:"1px solid "+P.bd}}>
                    <input type="file" accept=".xlsx,.xls,.xlsm" style={{display:"none"}} onChange={e=>{importExcel(e.target.files[0]);e.target.value="";}} disabled={importing} />
                    <span style={{fontSize:16}}>📤</span>
                    <div><div>{importing?"Importing...":"Import Historical Excel"}</div><div style={{fontSize:10,color:P.tm,fontWeight:400}}>Bulk-load invoices, labour, POs</div></div>
                  </label>
                  {/* Clear All */}
                  <button onClick={async ()=>{
                    if(!confirm("⚠ Permanently delete ALL data for "+client+" "+year+"?\n(invoices, sub, labour, contracts, documents, status)\n\nThis cannot be undone.")) return;
                    setMenuOpen(false);
                    // Delete all uploaded files from server
                    try {
                      const filesList = await api.listFiles(year, client).catch(()=>[]);
                      for(const f of filesList) {
                        await api.deleteFile(year, client, f.id).catch(()=>{});
                      }
                    } catch(e) { console.warn("File cleanup failed:",e); }
                    // Reset local state — the debounced auto-save persists it with proper versioning
                    setInv([]); setSub([]); setLab(mkLab()); setContracts([]); setDocs([]);
                    upClient("labAlloc",mkAlloc());
                    upClient("status","draft"); upClient("submittedBy",""); upClient("submittedAt","");
                  }} style={{display:"flex",alignItems:"center",gap:10,width:"100%",padding:"11px 16px",border:"none",background:"none",cursor:"pointer",fontSize:13,color:P.rd,fontWeight:600,textAlign:"left"}}>
                    <span style={{fontSize:16}}>🗑️</span><div><div>Clear All Data</div><div style={{fontSize:10,color:P.tm,fontWeight:400}}>Wipe this client/year completely</div></div>
                  </button>
                </div>
              </>
            )}
          </div>

          <span onClick={()=>saveState==="error"&&flushSave()} style={{fontSize:11,opacity:.9,minWidth:78,textAlign:"right",cursor:saveState==="error"?"pointer":"default"}}>{saveState==="saving"?"💾 Saving…":saveState==="saved"?"✓ Saved":saveState==="error"?"⚠ Save failed — retry":""}</span>
          <span style={{opacity:.7}}>{user.name}</span>
          <button onClick={logout} style={{background:"rgba(255,255,255,.15)",border:"none",color:P.wh,padding:"5px 14px",borderRadius:4,cursor:"pointer",fontSize:12}}>Logout</button>
        </div>
      </div>
      {cd.status==="rejected" && cd.rejectNote && (
        <div style={{background:"#FFEBEE",borderBottom:"1px solid #F5C6CB",color:P.rd,padding:"8px 24px",fontSize:13,display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontWeight:700}}>✗ Απορρίφθηκε από Finance:</span>
          <span style={{color:P.tx}}>{cd.rejectNote}</span>
        </div>
      )}
      <div style={{background:P.wh,borderBottom:"1px solid "+P.bd,display:"flex",padding:"0 16px",overflowX:"auto"}}>
        {tabOrder.map((t,i) => (
          <button key={t.id}
            draggable="true"
            onDragStart={e=>{setDragTab(i);e.dataTransfer.effectAllowed="move";}}
            onDragOver={e=>{e.preventDefault();setOverTab(i);}}
            onDrop={e=>{e.preventDefault();if(dragTab!==null&&dragTab!==i){setTabOrder(prev=>{const a=[...prev];const item=a.splice(dragTab,1)[0];a.splice(i,0,item);return a;});}setDragTab(null);setOverTab(null);}}
            onDragEnd={()=>{setDragTab(null);setOverTab(null);}}
            onClick={() => setTab(t.id)}
            style={{
              padding:"12px 18px",fontSize:13,background:"none",whiteSpace:"nowrap",
              border:"none",borderBottom:tab===t.id?"3px solid "+P.em:"3px solid transparent",
              fontWeight:tab===t.id?700:400,color:tab===t.id?P.em:P.tm,
              opacity:dragTab===i?0.4:1,cursor:"grab",
              outline:overTab===i&&dragTab!==null?"2px solid #00897B":"none",
            }}>{t.lb}</button>
        ))}
      </div>
      <div style={{padding:20,maxWidth:1400,margin:"0 auto"}}>
        {tab==="contracts" && <ContractTab data={contracts} set={setContracts} inv={inv} docs={docs} setDocs={setDocs} year={year} client={client} />}
        {tab==="scan" && <Scan goTo={setTab} year={year} client={client} onAdd={items => setSub(p => [...p,...items.map(x => ({...x,id:uid()}))])} onAddAR={items => setInv(p => [...p,...items.map(x => ({...x,id:uid()}))])} />}
        {tab==="pnl" && <PnL inv={inv} sub={sub} lab={lab} labAlloc={labAlloc} />}
        {tab==="insights" && <Insights inv={inv} sub={sub} lab={lab} contracts={contracts} client={client} year={year} />}
        {tab==="inv" && <InvTab data={inv} set={setInv} contracts={contracts} year={year} client={client} />}
        {tab==="sub" && <SubTab data={sub} set={setSub} contracts={contracts} year={year} client={client} />}
        {tab==="acc" && <AccTab inv={inv} sub={sub} />}
        {tab==="lab" && <LabTab data={lab} set={setLab} alloc={labAlloc} setAlloc={setLabAlloc} />}
      </div>
    </div>
  );
}

function ClientPicker({user,year,setYear,onSelect,onLogout,allData,onOpenFinance,onOpenDash,onOpenLedger}) {
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
          <span style={{fontSize:13,opacity:.7,borderLeft:"1px solid rgba(255,255,255,.3)",paddingLeft:12}}>Greece — Monthly Reporting</span>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:10,fontSize:13}}>
          <span style={{opacity:.7}}>{user.name}</span>
          {isAdmin&&<span style={{background:"rgba(255,255,255,.2)",padding:"2px 8px",borderRadius:10,fontSize:10}}>ADMIN</span>}
          <button onClick={onOpenDash} style={{background:"rgba(255,255,255,.15)",border:"none",color:"#fff",padding:"5px 14px",borderRadius:4,cursor:"pointer",fontSize:12}}>📊 Dashboard</button>
          {(user.role==="finance"||user.role==="admin")&&<button onClick={onOpenLedger} style={{background:"rgba(255,255,255,.15)",border:"none",color:"#fff",padding:"5px 14px",borderRadius:4,cursor:"pointer",fontSize:12}}>📒 AP/AR</button>}
          {(user.role==="finance"||user.role==="admin")&&<button onClick={onOpenFinance} style={{background:"rgba(255,255,255,.15)",border:"none",color:"#fff",padding:"5px 14px",borderRadius:4,cursor:"pointer",fontSize:12}}>💰 OPEX/CAPEX</button>}
          {user.role==="admin"&&<button onClick={()=>setAdminOpen(true)} style={{background:"rgba(255,255,255,.15)",border:"none",color:"#fff",padding:"5px 14px",borderRadius:4,cursor:"pointer",fontSize:12}}>⚙️ Admin</button>}
          <button onClick={onLogout} style={{background:"rgba(255,255,255,.12)",border:"none",color:"#fff",padding:"5px 14px",borderRadius:4,cursor:"pointer",fontSize:12}}>Logout</button>
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
            <span style={{color:P.gn,fontWeight:600}}>Rev: €{fmt(totRev)}</span>
            <span style={{color:totGM>=0?P.gn:P.rd,fontWeight:600}}>GM: €{fmt(totGM)}</span>
            <span style={{color:P.tx}}>{activeN} active</span>
            {submitted>0&&<span style={{color:"#F57F17",fontWeight:600}}>{submitted} pending</span>}
            {approved>0&&<span style={{color:P.gn}}>{approved} approved</span>}
          </div>
        </div>

        {/* Toolbar */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,gap:12}}>
          <input placeholder="🔍 Search..." value={search} onChange={e=>setSearch(e.target.value)} style={{padding:"7px 14px",border:"1px solid "+P.bd,borderRadius:6,fontSize:13,outline:"none",width:240,background:P.wh}} />
          <div style={{display:"flex",gap:4,fontSize:12}}>
            {[{v:"name",l:"A→Z"},{v:"rev",l:"Revenue"},{v:"gm",l:"GM"},{v:"status",l:"Status"}].map(s=>(
              <button key={s.v} onClick={()=>setSort(s.v)} style={{padding:"5px 10px",border:"1px solid "+P.bd,borderRadius:4,cursor:"pointer",background:sort===s.v?P.ep:P.wh,color:P.tx,fontSize:11,fontWeight:sort===s.v?600:400}}>{s.l}</button>
            ))}
          </div>
        </div>

        {/* Client list */}
        <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,overflow:"hidden"}}>
          <table style={{width:"100%",borderCollapse:"collapse"}}>
            <thead><tr>
              {["Client","Revenue €","Cost €","GM €","GM%","Invoices","Sub","Contracts","PO Value €","Report Status"].map(h=>(
                <th key={h} style={{padding:"8px 12px",fontSize:11,fontWeight:700,color:"#fff",background:P.em,textAlign:h==="Client"||h==="Report Status"?"left":"right"}}>{h}</th>
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
                        {c.inv>0&&<div style={{fontSize:10,color:P.gn}}>● Active</div>}
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
                    <span style={{padding:"3px 10px",borderRadius:12,fontSize:10,fontWeight:700,background:st.bg,color:st.color,whiteSpace:"nowrap"}}>{st.l}</span>
                  </td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
        <div style={{textAlign:"center",fontSize:11,color:P.tm,marginTop:12}}>{sorted.length} of {myClients.length} clients — {year}</div>
      </div>
    </div>
  );
}

function ContractTab({data,set,inv,docs,setDocs,year,client}) {
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
      const summary = created.map((c,i)=>`${i+1}. ${c.type} — ${c.ref||"(no ref)"} ${c.po_value?"€"+fmt(c.po_value):""}`).join("\n");
      alert(`✓ Uploaded ${newDocs.length} file(s) and extracted ${created.length} contract(s):\n\n${summary}`);
    } else {
      alert(`✓ Uploaded ${newDocs.length} file(s).\n\nAI extraction returned no contract data — please add details manually below.`);
    }
  };

  const edit = (id,k,v) => set(p=>p.map(r=>r.id===id?{...r,[k]:k==="po_value"||k==="fee_pct"?parseFloat(v)||0:v}:r));
  const activeFee = data.find(c=>c.status==="Active"&&c.type==="MSA")?.fee_pct || 5.5;

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
  const summary = TYPES.map(t => {
    const contracts = data.filter(c=>c.type===t.v);
    const docCount = (docs||[]).filter(d=>d.type===t.v).length;
    const totalPO = contracts.reduce((s,c)=>s+(Number(c.po_value)||0),0);
    const active = contracts.filter(c=>c.status==="Active").length;
    return {...t, contracts, docCount, totalPO, active, total:contracts.length};
  }).filter(t=>t.total>0||t.docCount>0);

  return (
    <div>
      <h2 style={{color:P.em,fontSize:16,fontWeight:700,margin:"0 0 6px"}}>Contracts, POs & Management Fee</h2>
      <p style={{fontSize:13,color:P.tm,margin:"0 0 16px"}}>Active MSA fee: <strong style={{color:P.em,fontSize:15}}>{activeFee}%</strong> — {data.filter(c=>c.status==="Active").length} active contracts — {docs.length} documents</p>

      {/* ── 1. CONTRACT SUMMARY CARDS ── */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:12,marginBottom:20}}>
        {summary.map(t => (
          <div key={t.v} style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,overflow:"hidden"}}>
            <div style={{background:typeColors[t.v]||P.em,color:"#fff",padding:"10px 14px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <span style={{fontWeight:700,fontSize:14}}>{t.l}</span>
              <div style={{display:"flex",gap:6,alignItems:"center"}}>
                {t.docCount>0&&<span style={{background:"rgba(255,255,255,.25)",padding:"2px 8px",borderRadius:10,fontSize:10,fontWeight:700}}>📎 {t.docCount} docs</span>}
                <span style={{fontSize:11,opacity:.8}}>{t.active} active / {t.total} total</span>
              </div>
            </div>
            <div style={{padding:12}}>
              {t.contracts.map(c => (
                <div key={c.id} style={{padding:"6px 0",borderBottom:"1px solid "+P.bd,fontSize:12}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <span style={{fontWeight:600,color:P.em}}>{c.ref}</span>
                    <span style={{fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:10,color:"#fff",
                      background:c.status==="Active"?"#2E7D32":c.status==="Expired"?"#C62828":c.status==="Pending"?"#F57F17":"#757575"
                    }}>{c.status}</span>
                  </div>
                  <div style={{color:P.tm,marginTop:2}}>{c.scope}</div>
                  <div style={{display:"flex",gap:12,marginTop:4,fontSize:11,color:P.tx}}>
                    {c.start&&<span>From: {c.start}</span>}
                    {c.expiry&&<span>To: {c.expiry}</span>}
                    {(()=>{ const b=c.status!=="Terminated"&&c.status!=="Expired"&&expiryBadge(c.expiry); return b?<span style={{padding:"1px 8px",borderRadius:8,fontSize:10,fontWeight:700,background:b.bg,color:b.color}}>{b.label}</span>:null; })()}
                    <span style={{fontWeight:600}}>Fee: {c.fee_pct}%</span>
                    {c.po_value>0&&<span>PO: €{fmt(c.po_value)}</span>}
                  </div>
                  {/* Docs linked to this specific contract */}
                  {docs.filter(d=>d.contract_ref===c.ref).length>0&&(
                    <div style={{marginTop:6}}>
                      {docs.filter(d=>d.contract_ref===c.ref).map((d,j)=>(
                        <div key={j} style={{display:"flex",alignItems:"center",gap:6,padding:"2px 0",fontSize:11,color:P.tm}}>
                          <span>📄</span><span style={{flex:1}}>{d.name}</span>
                          {(d._persisted&&d.id)?<a href="#" onClick={async e=>{e.preventDefault();try{window.open(await api.getFileLink(year,client,d.id),"_blank");}catch{alert("Could not open file");}}} style={{background:P.em,color:"#fff",padding:"1px 8px",borderRadius:4,fontSize:10,fontWeight:600,textDecoration:"none"}}>Open</a>:d.url?<a href={d.url} target="_blank" rel="noopener noreferrer" style={{background:P.em,color:"#fff",padding:"1px 8px",borderRadius:4,fontSize:10,fontWeight:600,textDecoration:"none"}}>Open</a>:null}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {/* Docs of this type not linked to a specific contract */}
              {docs.filter(d=>d.type===t.v&&!d.contract_ref).length>0&&(
                <div style={{marginTop:t.contracts.length?8:0,paddingTop:t.contracts.length?8:0,borderTop:t.contracts.length?"1px dashed "+P.bd:"none"}}>
                  <div style={{fontSize:10,fontWeight:700,color:P.tm,marginBottom:4}}>UNLINKED DOCUMENTS</div>
                  {docs.filter(d=>d.type===t.v&&!d.contract_ref).map((d,j)=>(
                    <div key={j} style={{display:"flex",alignItems:"center",gap:6,padding:"2px 0",fontSize:11,color:P.tm}}>
                      <span>📄</span><span style={{flex:1}}>{d.name}</span>
                      {(d._persisted&&d.id)?<a href="#" onClick={async e=>{e.preventDefault();try{window.open(await api.getFileLink(year,client,d.id),"_blank");}catch{alert("Could not open file");}}} style={{background:P.em,color:"#fff",padding:"1px 8px",borderRadius:4,fontSize:10,fontWeight:600,textDecoration:"none"}}>Open</a>:d.url?<a href={d.url} target="_blank" rel="noopener noreferrer" style={{background:P.em,color:"#fff",padding:"1px 8px",borderRadius:4,fontSize:10,fontWeight:600,textDecoration:"none"}}>Open</a>:null}
                    </div>
                  ))}
                </div>
              )}
              {t.contracts.length===0&&t.docCount===0&&(
                <div style={{fontSize:11,color:P.tm,fontStyle:"italic",padding:"4px 0"}}>No records yet</div>
              )}
            </div>
            {t.totalPO>0&&<div style={{background:P.ep,padding:"6px 14px",fontSize:12,fontWeight:600,color:P.em,borderTop:"1px solid "+P.bd}}>Total PO Value: €{fmt(t.totalPO)}</div>}
          </div>
        ))}
      </div>

      {/* ── 2. PO SPEND DASHBOARDS ── */}
      {allPOs.length>0 && (
        <div style={{marginBottom:20}}>
          {/* General summary bar */}
          <div style={{background:P.em,borderRadius:8,padding:"14px 20px",marginBottom:12,display:"flex",justifyContent:"space-between",alignItems:"center",color:"#fff",flexWrap:"wrap",gap:10}}>
            <span style={{fontWeight:700,fontSize:14}}>PO Spend Overview — Actuals Only</span>
            <div style={{display:"flex",gap:24,fontSize:13}}>
              <span>Budget: <b>€{fmt(poData.reduce((s,p)=>s+p.budget,0))}</b></span>
              <span>Spent: <b>€{fmt(poData.reduce((s,p)=>s+p.spent,0))}</b></span>
              <span>Remaining: <b style={{color:poData.reduce((s,p)=>s+p.rem,0)<0?"#EF9A9A":"#A5D6A7"}}>€{fmt(poData.reduce((s,p)=>s+p.rem,0))}</b></span>
              <span>{poData.reduce((s,p)=>s+p.actuals.length,0)} invoices</span>
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
                    <div><span style={{color:P.tm}}>Spent</span><div style={{fontWeight:700,color:bc}}>€{fmt(pd.spent)}</div></div>
                    <div><span style={{color:P.tm}}>Remaining</span><div style={{fontWeight:700,color:pd.rem<0?P.rd:P.gn}}>€{fmt(pd.rem)}</div></div>
                  </div>
                  <div style={{textAlign:"right",fontSize:10,color:P.tm,marginTop:4}}>Click for details · {pd.actuals.length} inv{pd.expiry?` · Exp: ${pd.expiry}`:""}</div>
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
                <div style={{fontSize:12,opacity:.7,marginTop:2}}>Budget: €{fmt(modalPO.budget)} · Spent: €{fmt(modalPO.spent)} · Remaining: €{fmt(modalPO.rem)} · {(modalPO.pct*100).toFixed(1)}%</div>
              </div>
              <button onClick={()=>setModalPO(null)} style={{background:"rgba(255,255,255,.2)",border:"none",color:"#fff",padding:"6px 14px",borderRadius:6,cursor:"pointer",fontSize:14,fontWeight:700}}>✕</button>
            </div>
            <div style={{padding:20}}>
              {modalPO.actuals.length>0 ? (
                <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                  <thead><tr>{["Month","Category","Amount €","VAT €","Total €","Invoice No","Date"].map(h=>(
                    <th key={h} style={{padding:"8px 10px",fontSize:11,fontWeight:700,color:"#fff",background:P.em,textAlign:h.includes("€")?"right":"left"}}>{h}</th>
                  ))}</tr></thead>
                  <tbody>
                    {modalPO.actuals.map((iv,i)=>(
                      <tr key={iv.id||i} style={{background:i%2===0?P.wh:P.al}}>
                        <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd}}>{ML[iv.month]||iv.month}</td>
                        <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd}}>{iv.cat}</td>
                        <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,textAlign:"right"}}>{fmt(iv.amt)}</td>
                        <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,textAlign:"right"}}>{fmt(iv.vat)}</td>
                        <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,textAlign:"right"}}>{fmt(iv.total||iv.amt+(iv.vat||0))}</td>
                        <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd}}>{iv.inv_no}</td>
                        <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd}}>{iv.date}</td>
                      </tr>
                    ))}
                    <tr style={{background:P.ep}}>
                      <td colSpan={2} style={{padding:"8px 10px",fontWeight:700}}>Total Actuals</td>
                      <td style={{padding:"8px 10px",textAlign:"right",fontWeight:700,color:P.em}}>{fmt(modalPO.spent)}</td>
                      <td style={{padding:"8px 10px",textAlign:"right",fontWeight:700,color:P.em}}>{fmt(modalPO.actuals.reduce((s,i)=>s+(Number(i.vat)||0),0))}</td>
                      <td style={{padding:"8px 10px",textAlign:"right",fontWeight:700,color:P.em}}>{fmt(modalPO.actuals.reduce((s,i)=>s+(Number(i.total||i.amt+(i.vat||0))||0),0))}</td>
                      <td colSpan={2}></td>
                    </tr>
                  </tbody>
                </table>
              ) : (
                <div style={{textAlign:"center",padding:30,color:P.tm,fontStyle:"italic"}}>No actual invoices assigned to this PO yet</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── 3. DOCUMENT UPLOAD ── */}
      <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,padding:14,marginBottom:16}}>
        <div style={{fontSize:13,fontWeight:600,color:P.em,marginBottom:10}}>Upload Contract Document</div>
        <div style={{display:"flex",gap:8,alignItems:"end",marginBottom:10,flexWrap:"wrap"}}>
          <Sel l="Document Type" v={docType} set={setDocType} opts={TYPES} w={120} />
          <Sel l="Link to Contract" v={docContract} set={setDocContract} opts={[{v:"",l:"— None —"},...data.map(c=>({v:c.ref,l:c.ref+" ("+c.type+")"}))] } w={200} />
        </div>
        <label
          onDrop={e=>{e.preventDefault();setDrag(false);addDocs(e.dataTransfer.files);}}
          onDragOver={e=>{e.preventDefault();setDrag(true);}}
          onDragLeave={()=>setDrag(false)}
          style={{display:"block",border:"2px dashed "+(drag?P.em:P.bd),borderRadius:8,padding:"24px 16px",textAlign:"center",cursor:"pointer",background:drag?P.ep:P.of,transition:"all .2s"}}>
          <input type="file" multiple accept=".pdf,.docx,image/*" style={{display:"none"}} onChange={e=>{addDocs(e.target.files);e.target.value="";}} />
          <div style={{fontSize:22,marginBottom:6}}>📁</div>
          <div style={{fontSize:13,color:P.em,fontWeight:600}}>{extracting?"🤖 Uploading + AI extracting...":"Click to browse files"}</div>
          <div style={{fontSize:11,color:P.tm,marginTop:4}}>{extracting?"Each file becomes a contract entry":"Drop one or many — AI extracts each into a contract"}</div>
        </label>

        {/* Documents list */}
        {docs.length>0 && (
          <div style={{marginTop:14}}>
            <div style={{fontSize:12,fontWeight:700,color:P.em,marginBottom:8}}>📂 Uploaded Documents ({docs.length})</div>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
              <thead><tr>
                {["File","Type","Linked Contract","Date",""].map(h=>(
                  <th key={h} style={{padding:"6px 10px",fontSize:11,fontWeight:700,color:"#fff",background:P.em,textAlign:"left"}}>{h}</th>
                ))}
              </tr></thead>
              <tbody>{docs.map((d,i)=>(
                <tr key={i} style={{background:i%2===0?P.wh:P.al}}>
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
                      {(d._persisted&&d.id)?<a href="#" onClick={async e=>{e.preventDefault();try{window.open(await api.getFileLink(year,client,d.id),"_blank");}catch{alert("Could not open file");}}} style={{background:P.em,color:"#fff",padding:"3px 10px",borderRadius:4,fontSize:11,fontWeight:600,textDecoration:"none"}}>Open</a>:d.url?<a href={d.url} target="_blank" rel="noopener noreferrer" style={{background:P.em,color:"#fff",padding:"3px 10px",borderRadius:4,fontSize:11,fontWeight:600,textDecoration:"none"}}>Open</a>:null}
                      <button onClick={async()=>{const doc=docs[i];if(doc._persisted&&doc.id){try{await api.deleteFile(year,client,doc.id);}catch(e){console.warn("Delete failed:",e);}}setDocs(p=>p.filter((_,j)=>j!==i));}} style={{background:"#FFEBEE",color:P.rd,border:"none",padding:"3px 10px",borderRadius:4,fontSize:11,fontWeight:600,cursor:"pointer"}}>Remove</button>
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
          <div style={{fontSize:13,fontWeight:600,color:P.em}}>Add Contract / PO Manually {extracting&&<span style={{color:"#F57F17",fontSize:11,marginLeft:8}}>🤖 AI extracting from uploaded files...</span>}</div>
          {f.ref&&<button onClick={()=>sF({type:"MSA",ref:"",client:"",start:"",expiry:"",fee_pct:5.5,status:"Active",po:"",po_value:"",scope:"",notes:""})} style={{background:"#FFEBEE",border:"none",color:P.rd,padding:"3px 10px",borderRadius:4,cursor:"pointer",fontSize:11}}>Clear</button>}
        </div>
        <div style={{display:"flex",flexWrap:"wrap",gap:8,alignItems:"end"}}>
          <Sel l="Type" v={f.type} set={v=>sF(x=>({...x,type:v}))} opts={TYPES} w={100} />
          <Inp l="Reference" v={f.ref} set={v=>sF(x=>({...x,ref:v}))} w={130} />
          <Inp l="Client" v={f.client} set={v=>sF(x=>({...x,client:v}))} w={140} />
          <Inp l="Start Date" v={f.start} set={v=>sF(x=>({...x,start:v}))} w={95} />
          <Inp l="Expiry Date" v={f.expiry} set={v=>sF(x=>({...x,expiry:v}))} w={95} />
          <Inp l="Fee %" v={f.fee_pct} set={v=>sF(x=>({...x,fee_pct:v}))} w={60} t="number" />
          <Sel l="Status" v={f.status} set={v=>sF(x=>({...x,status:v}))} opts={STAT} w={90} />
          <Inp l="PO No" v={f.po} set={v=>sF(x=>({...x,po:v}))} w={100} />
          <Inp l="PO Value €" v={f.po_value} set={v=>sF(x=>({...x,po_value:v}))} w={95} t="number" />
          <Inp l="Scope" v={f.scope} set={v=>sF(x=>({...x,scope:v}))} w={140} />
          <Inp l="Notes" v={f.notes} set={v=>sF(x=>({...x,notes:v}))} w={120} />
          <button onClick={add} style={{background:P.em,color:"#fff",border:"none",padding:"7px 18px",borderRadius:6,cursor:"pointer",fontSize:13,fontWeight:600}}>+ Add</button>
        </div>
      </div>

      {/* ── 5. FULL TABLE ── */}
      <Tbl cols={[
        {k:"type",l:"Type",opts:TYPES,mw:80},
        {k:"ref",l:"Reference",edit:true,mw:120},
        {k:"client",l:"Client",edit:true,mw:130},
        {k:"start",l:"Start",edit:true,mw:90},
        {k:"expiry",l:"Expiry",edit:true,mw:90},
        {k:"fee_pct",l:"Fee %",a:"right",edit:true,t:"number",mw:60},
        {k:"status",l:"Status",opts:STAT,mw:85},
        {k:"po",l:"PO No",edit:true,mw:100},
        {k:"po_value",l:"PO Value €",a:"right",edit:true,t:"number",mw:90},
        {k:"scope",l:"Scope",edit:true,mw:140},
        {k:"notes",l:"Notes",edit:true,mw:130},
      ]} data={data} del={id=>set(p=>p.filter(x=>x.id!==id))} onEdit={edit} />
    </div>
  );
}

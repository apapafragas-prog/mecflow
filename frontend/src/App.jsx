import { useState, useEffect, useRef } from "react";
import { api, setToken, getToken } from "./api.js";
import { allocFractions } from "./calc.js";
import * as XLSX from "xlsx";
// Bundled locally (no CDN dependency): zip handling + PDF rendering for the scanner
import JSZip from "jszip";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.js?url";
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
if (typeof window !== "undefined") { window.JSZip = JSZip; window.pdfjsLib = pdfjsLib; }

import {
  uid, CLIENTS, REPORT_STATUS, MONTHS, ML, setFiscalYear, normalizeClientData,
  REV_CATS, COST_CATS, LAB_ROWS, mkLab, mkAlloc, P, YEARS,
} from "./constants.js";
import { LogoImg, LangToggle } from "./ui.jsx";
import { Login, ForcePw, ResetPassword } from "./auth.jsx";
import { PnL, InvTab, SubTab, AccTab, LabTab, POTracker } from "./reportTabs.jsx";
import { Insights } from "./insights.jsx";
import { ChatWidget } from "./chat.jsx";
import { Dashboard, ApArLedger, OpexCapex } from "./finance.jsx";
import { GroupReports } from "./groupReports.jsx";
import { AdminPanel } from "./admin.jsx";
import { Scan } from "./scan.jsx";
import { ClientPicker } from "./clientPicker.jsx";
import { ContractTab } from "./contracts.jsx";
import { useT, statusLabel, monthLabel } from "./i18n.jsx";

export default function App() {
  const { t } = useT();
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
  const [groupOpen, setGroupOpen] = useState(false);
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
  // Tab labels are derived live (not from the stored `lb`) so they follow the language.
  const tabLabel = (id) => ({
    contracts: t("📋 Συμβόλαια & POs","📋 Contracts & POs"),
    scan: t("📄 Σαρωτής Τιμολογίων","📄 Invoice Scanner"),
    pnl: t("Αναφορά P&L","P&L Report"),
    insights: t("📈 Insights","📈 Insights"),
    inv: t("Τιμολόγια CBRE","CBRE Invoices"),
    sub: t("Τιμολόγια Υπεργολάβων","Sub Invoices"),
    acc: t("Δουλευμένα (Accruals)","Accruals"),
    lab: t("Κόστος Εργασίας","Labour Cost"),
  }[id] || id);
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
  const savingRef = useRef(false);   // a save is in flight — serialize to avoid self-409
  const pendingRef = useRef(null);   // newest data queued while a save is in flight
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
    // Serialize saves: a rapid second change while one is in flight would otherwise reuse the same
    // baseVersion and self-inflict a false 409. Queue the newest data and flush it after this save.
    if(savingRef.current) { pendingRef.current = {yr, cl, data}; return true; }
    savingRef.current = true;
    setSaveState("saving");
    const ckey = `${yr}:${cl}`;
    try {
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
            pendingRef.current = null; // a real cross-user conflict — drop the queue, reload instead
            setSaveState("error");
            alert("⚠️ Αυτός ο πελάτης ενημερώθηκε από άλλον χρήστη.\n\nΗ οθόνη θα φορτώσει τώρα την τελευταία αποθηκευμένη έκδοση. Οι πολύ πρόσφατες αλλαγές σου ΔΕΝ αποθηκεύτηκαν — ξαναπέρασέ τες.");
            setHydratedKeys(p=>{ const n={...p}; delete n[ckey]; return n; }); // triggers re-hydration
            return false;
          }
          if(attempt===1) { console.warn("Save failed:",e); setSaveState("error"); return false; }
          await new Promise(r=>setTimeout(r,700));
        }
      }
    } finally {
      savingRef.current = false;
      // Flush the newest queued data (now with the freshly-incremented version).
      const q = pendingRef.current; pendingRef.current = null;
      if(q) doSave(q.yr, q.cl, q.data);
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
    if (view==="dashboard") { setClient(null); setFinanceOpen(false); setLedgerOpen(false); setGroupOpen(false); setDashOpen(true); }
    else if (view==="ledger" && fin) { setClient(null); setDashOpen(false); setFinanceOpen(false); setGroupOpen(false); setLedgerOpen(true); }
    else if (view==="opex" && fin) { setClient(null); setDashOpen(false); setLedgerOpen(false); setGroupOpen(false); setFinanceOpen(true); }
    else if (view==="group" && fin) { setClient(null); setDashOpen(false); setLedgerOpen(false); setFinanceOpen(false); setGroupOpen(true); }
    else if (view==="clients") { setClient(null); setDashOpen(false); setLedgerOpen(false); setFinanceOpen(false); setGroupOpen(false); }
    else if (view.startsWith("tab:")) { if (client) setTab(view.slice(4)); }
    else if (view.startsWith("client:")) { const p=view.split(":"); if (p[1]) { setDashOpen(false); setLedgerOpen(false); setFinanceOpen(false); setGroupOpen(false); setClient(p[1]); setTab(p[2]||"contracts"); } }
  };
  const chatEl = <ChatWidget user={user} year={year} ctx={{client, cd:(client&&cd)?cd:null, tab}} nav={navChat} />;
  const withChat = (screen) => <>{screen}{chatEl}</>;

  if (!client && dashOpen)
    return withChat(<Dashboard year={year} setYear={setYear} user={user} onBack={()=>setDashOpen(false)} onLogout={logout} onSelectClient={c=>{setDashOpen(false);setClient(c);setTab("contracts");}} />);
  if (!client && ledgerOpen && (user.role==="finance"||user.role==="admin"))
    return withChat(<ApArLedger year={year} setYear={setYear} user={user} onBack={()=>setLedgerOpen(false)} onLogout={logout} onSelectClient={c=>{setLedgerOpen(false);setClient(c);setTab("inv");}} />);
  if (!client && financeOpen && (user.role==="finance"||user.role==="admin"))
    return withChat(<OpexCapex year={year} setYear={setYear} user={user} onBack={()=>setFinanceOpen(false)} onLogout={logout} />);
  if (!client && groupOpen && (user.role==="finance"||user.role==="admin"))
    return withChat(<GroupReports year={year} setYear={setYear} user={user} onBack={()=>setGroupOpen(false)} onLogout={logout} />);
  if (!client) return withChat(<ClientPicker user={user} year={year} setYear={setYear} onSelect={c=>{setClient(c);setTab("contracts");}} onLogout={logout} allData={yd} onOpenFinance={()=>setFinanceOpen(true)} onOpenDash={()=>setDashOpen(true)} onOpenLedger={()=>setLedgerOpen(true)} onOpenGroup={()=>setGroupOpen(true)} />);

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
    pRows.push(["","",t(`ΕΛΛΑΔΑ ${year} - Κατάσταση Αποτελεσμάτων - EURO`,`GREECE ${year}- Profit & Loss - EURO`)]);
    pRows.push([]);
    pRows.push(["ISCALA","","MONTHS >>",...am.map(m=>ML[m])]);
    const pnlLines = [
      [t("ΕΣΟΔΑ ΠΕΛΑΤΗ - FM Core","CLIENT REVENUE - FM Core"),"rev_core"],[t("ΕΣΟΔΑ ΠΕΛΑΤΗ - Πρόσθετες Εργασίες","CLIENT REVENUE - FM Extra Works"),"rev_ew"],[t("ΕΣΟΔΑ ΠΕΛΑΤΗ - Έργα (PJMs)","CLIENT REVENUE - PJMs"),"rev_pjm"],
      [t("Σύνολο Πωλήσεων / Εσόδων","Total Sales / Revenue"),"rev_total"],[],
      [t("Κόστος Εργασίας - FM Core","Labour Cost - FM Core"),"lab_core"],[t("Κόστος Εργασίας - Πρόσθετες Εργασίες","Labour Cost - FM Extra Works"),"lab_ew"],[t("Κόστος Εργασίας - Έργα (PJMs)","Labour Cost - FM PJMs"),"lab_pjm"],[t("Σύνολο Κόστους Εργασίας","Total Labour Cost"),"lab_total"],
      [t("Κόστος Υπεργολάβων - FM Core","CLIENT Subcontractors cost - FM CORE"),"sub_core"],[t("Κόστος Υπεργολάβων - Πρόσθετες Εργασίες","CLIENT Subcontractors cost - FM Extra Works"),"sub_ew"],[t("Κόστος Υπεργολάβων - Έργα (PJMs)","CLIENT Subcontractors cost - PJMs"),"sub_pjm"],
      [t("Σύνολο Υπεργολάβων","Total Subcontractor"),"sub_total"],[],
      [t("GM - Σύνολο","GM - Total"),"gm"],[],
      ["GM - FM Core","gm_core"],["GM - FM Core %","gm_core_pct"],[t("GM - Πρόσθετες Εργασίες","GM - FM Extra Works"),"gm_ew"],[t("GM - Πρόσθετες Εργασίες %","GM - FM Extra Works %"),"gm_ew_pct"],[t("GM - Έργα (PJM)","GM - FM PJM"),"gm_pjm"],
    ];
    pnlLines.forEach(pl => { if(!pl.length){pRows.push([]);return;} pRows.push([pl[0],"","",...am.map(()=>null)]); });
    const pWS = XLSX.utils.aoa_to_sheet(pRows);
    // Title
    sc(pWS,0,2,t(`ΕΛΛΑΔΑ ${year} - Κατάσταση Αποτελεσμάτων - EURO`,`GREECE ${year}- Profit & Loss - EURO`),{font:{name:"Arial",sz:10,bold:true}});
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

      // When the parsed month isn't in the selected FY (e.g. importing an FY25 workbook while FY26
      // is active), map it onto the active FY by its MONTH INDEX (MM) instead of collapsing every
      // out-of-FY row into January. Mirrors remapMonth/normalizeClientData so the month is preserved.
      const toFY = (mm) => { const i = (parseInt(mm,10)||1)-1; return MONTHS[Math.max(0,Math.min(11,i))]; };
      const parseMonth = (v) => {
        if(!v) return MONTHS[0];
        if(MONTHS.includes(v)) return v;
        if(v instanceof Date && !isNaN(v)) { const m = v.getFullYear()+"-"+String(v.getMonth()+1).padStart(2,"0"); return MONTHS.includes(m)?m:toFY(v.getMonth()+1); }
        const s = String(v).trim();
        const ymMatch = s.match(/(\d{4})[-\/](\d{1,2})/);
        if(ymMatch) {const mm=ymMatch[2].padStart(2,"0"); const m = ymMatch[1]+"-"+mm; return MONTHS.includes(m)?m:toFY(mm);}
        const dmyMatch = s.match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/);
        if(dmyMatch) {const y=dmyMatch[3].length===2?"20"+dmyMatch[3]:dmyMatch[3]; const mm=dmyMatch[2].padStart(2,"0"); const m=y+"-"+mm; return MONTHS.includes(m)?m:toFY(mm);}
        const monMap = {jan:"01",feb:"02",mar:"03",apr:"04",may:"05",jun:"06",jul:"07",aug:"08",sep:"09",oct:"10",nov:"11",dec:"12",ian:"01",fev:"02",mar:"03",apr:"04",mai:"05",iun:"06",iul:"07",aug:"08",sep:"09",oct:"10",noi:"11",dec:"12"};
        const lc = s.toLowerCase();
        for(const [n,num] of Object.entries(monMap)) {
          if(lc.includes(n)) {
            const yMatch = s.match(/(\d{2,4})/);
            const y = yMatch ? (yMatch[1].length===2?"20"+yMatch[1]:yMatch[1]) : "2026";
            const m = y+"-"+num;
            return MONTHS.includes(m)?m:toFY(num);
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
          t(`Βρέθηκαν προς εισαγωγή στο ${client} ${year}:\n`,`Found to import into ${client} ${year}:\n`)+
          `  • CBRE Invoices: ${newInv.length}\n  • Sub Invoices: ${newSub.length}\n  • ${t("Γραμμές εργασίας","Labour rows")}: ${labRowsImported}\n  • Contracts/POs: ${newContracts.length}\n\n`+
          t(`Υπάρχουν ήδη δεδομένα. Γράψε:\n  M = Merge (πρόσθεσε στα υπάρχοντα)\n  R = Replace (αντικατέστησε όλα)\n\n(Άκυρο για ακύρωση)`,`Data already exists. Type:\n  M = Merge (add to existing)\n  R = Replace (overwrite all)\n\n(Cancel to abort)`),
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
      alert(t("Η εισαγωγή απέτυχε: ","Import failed: ")+e.message);
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
          <button onClick={()=>{flushSave();setClient(null);}} style={{background:"rgba(255,255,255,.2)",border:"none",color:"#fff",padding:"4px 12px",borderRadius:4,cursor:"pointer",fontSize:12}}>◀ {t("Πελάτες","Clients")}</button>
          <LogoImg name={client} size={28} radius={4} />
          <span style={{fontSize:14,fontWeight:600,borderLeft:"1px solid rgba(255,255,255,.3)",paddingLeft:12}}>{client} — {year}</span>
          {(()=>{const rs=REPORT_STATUS.find(x=>x.v===(cd.status||"draft"))||REPORT_STATUS[0]; return <span style={{padding:"3px 12px",borderRadius:12,fontSize:10,fontWeight:700,background:rs.bg,color:rs.color,marginLeft:8}}>{statusLabel(rs.v,rs.l)}</span>;})()}
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8,fontSize:13,position:"relative"}}>
          {/* Quick approve/reject for finance */}
          {(user.role==="finance"||user.role==="admin")&&cd.status==="submitted"&&(
            <>
              <button onClick={()=>{upClient("status","approved");upClient("rejectNote","");}} style={{background:P.gn,border:"none",color:"#fff",padding:"6px 14px",borderRadius:4,cursor:"pointer",fontSize:12,fontWeight:600}}>✓ {t("Έγκριση","Approve")}</button>
              <button onClick={()=>{const why=prompt(t("Λόγος απόρριψης (θα τον δει ο χρήστης που υπέβαλε):","Rejection reason (visible to the user who submitted):"),"");if(why===null)return;upClient("status","rejected");upClient("rejectNote",why||"");}} style={{background:P.rd,border:"none",color:"#fff",padding:"6px 14px",borderRadius:4,cursor:"pointer",fontSize:12,fontWeight:600}}>✗ {t("Απόρριψη","Reject")}</button>
            </>
          )}

          {/* Actions dropdown */}
          <div style={{position:"relative"}}>
            <button onClick={()=>setMenuOpen(!menuOpen)} style={{background:"#00897B",border:"none",color:"#fff",padding:"7px 16px",borderRadius:4,cursor:"pointer",fontSize:12,fontWeight:600,display:"flex",alignItems:"center",gap:6}}>
              ⚙️ {t("Ενέργειες","Actions")} <span style={{fontSize:9}}>{menuOpen?"▲":"▼"}</span>
            </button>
            {menuOpen && (
              <>
                <div onClick={()=>setMenuOpen(false)} style={{position:"fixed",top:0,left:0,right:0,bottom:0,zIndex:99}} />
                <div style={{position:"absolute",top:"calc(100% + 6px)",right:0,background:"#fff",borderRadius:8,boxShadow:"0 8px 24px rgba(0,0,0,.18)",minWidth:240,zIndex:100,overflow:"hidden",border:"1px solid "+P.bd}}>
                  {/* Submit */}
                  {(user.role==="ops"||user.role==="admin")&&(cd.status||"draft")==="draft"&&(
                    <button onClick={()=>{upClient("status","submitted");upClient("submittedBy",user.name);upClient("submittedAt",new Date().toLocaleDateString());setMenuOpen(false);}} style={{display:"flex",alignItems:"center",gap:10,width:"100%",padding:"11px 16px",border:"none",background:"none",cursor:"pointer",fontSize:13,color:"#F57F17",fontWeight:600,textAlign:"left",borderBottom:"1px solid "+P.bd}}>
                      <span style={{fontSize:16}}>📤</span><div><div>{t("Υποβολή Αναφοράς","Submit Report")}</div><div style={{fontSize:10,color:P.tm,fontWeight:400}}>{t("Αποστολή στο Finance για έγκριση","Send to finance for approval")}</div></div>
                    </button>
                  )}
                  {(user.role==="ops"||user.role==="admin")&&cd.status==="rejected"&&(
                    <button onClick={()=>{upClient("status","submitted");upClient("submittedBy",user.name);upClient("submittedAt",new Date().toLocaleDateString());upClient("rejectNote","");setMenuOpen(false);}} style={{display:"flex",alignItems:"center",gap:10,width:"100%",padding:"11px 16px",border:"none",background:"none",cursor:"pointer",fontSize:13,color:"#F57F17",fontWeight:600,textAlign:"left",borderBottom:"1px solid "+P.bd}}>
                      <span style={{fontSize:16}}>📤</span><div><div>{t("Επανυποβολή Αναφοράς","Re-Submit Report")}</div><div style={{fontSize:10,color:P.tm,fontWeight:400}}>{t("Μετά τις διορθώσεις","After making corrections")}</div></div>
                    </button>
                  )}
                  {cd.status==="approved"&&user.role==="admin"&&(
                    <button onClick={()=>{upClient("status","draft");setMenuOpen(false);}} style={{display:"flex",alignItems:"center",gap:10,width:"100%",padding:"11px 16px",border:"none",background:"none",cursor:"pointer",fontSize:13,color:P.tx,fontWeight:600,textAlign:"left",borderBottom:"1px solid "+P.bd}}>
                      <span style={{fontSize:16}}>↺</span><div><div>{t("Επαναφορά Αναφοράς","Reopen Report")}</div><div style={{fontSize:10,color:P.tm,fontWeight:400}}>{t("Επιστροφή σε πρόχειρο","Move back to draft")}</div></div>
                    </button>
                  )}
                  {/* Export Excel */}
                  <button onClick={()=>{exportXL();setMenuOpen(false);}} style={{display:"flex",alignItems:"center",gap:10,width:"100%",padding:"11px 16px",border:"none",background:"none",cursor:"pointer",fontSize:13,color:P.em,fontWeight:600,textAlign:"left",borderBottom:"1px solid "+P.bd}}>
                    <span style={{fontSize:16}}>📥</span><div><div>{t("Λήψη Excel","Download Excel")}</div><div style={{fontSize:10,color:P.tm,fontWeight:400}}>{t("Εξαγωγή πλήρους αναφοράς","Export full report")}</div></div>
                  </button>
                  {/* Import Excel */}
                  <label style={{display:"flex",alignItems:"center",gap:10,width:"100%",padding:"11px 16px",cursor:importing?"wait":"pointer",fontSize:13,color:P.em,fontWeight:600,textAlign:"left",borderBottom:"1px solid "+P.bd}}>
                    <input type="file" accept=".xlsx,.xls,.xlsm" style={{display:"none"}} onChange={e=>{importExcel(e.target.files[0]);e.target.value="";}} disabled={importing} />
                    <span style={{fontSize:16}}>📤</span>
                    <div><div>{importing?t("Εισαγωγή...","Importing..."):t("Εισαγωγή Ιστορικού Excel","Import Historical Excel")}</div><div style={{fontSize:10,color:P.tm,fontWeight:400}}>{t("Μαζική φόρτωση τιμολογίων, εργασίας, POs","Bulk-load invoices, labour, POs")}</div></div>
                  </label>
                  {/* Clear All */}
                  <button onClick={async ()=>{
                    if(!confirm(t("⚠ Οριστική διαγραφή ΟΛΩΝ των δεδομένων για "+client+" "+year+";\n(τιμολόγια, υπεργολάβοι, εργασία, συμβόλαια, έγγραφα, κατάσταση)\n\nΔεν αναιρείται.","⚠ Permanently delete ALL data for "+client+" "+year+"?\n(invoices, sub, labour, contracts, documents, status)\n\nThis cannot be undone."))) return;
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
                    <span style={{fontSize:16}}>🗑️</span><div><div>{t("Διαγραφή Όλων","Clear All Data")}</div><div style={{fontSize:10,color:P.tm,fontWeight:400}}>{t("Πλήρης εκκαθάριση πελάτη/έτους","Wipe this client/year completely")}</div></div>
                  </button>
                </div>
              </>
            )}
          </div>

          <span onClick={()=>saveState==="error"&&flushSave()} style={{fontSize:11,opacity:.9,minWidth:78,textAlign:"right",cursor:saveState==="error"?"pointer":"default"}}>{saveState==="saving"?t("💾 Αποθήκευση…","💾 Saving…"):saveState==="saved"?t("✓ Αποθηκεύτηκε","✓ Saved"):saveState==="error"?t("⚠ Αποτυχία — δοκίμασε ξανά","⚠ Save failed — retry"):""}</span>
          <LangToggle dark />
          <span style={{opacity:.7}}>{user.name}</span>
          <button onClick={logout} style={{background:"rgba(255,255,255,.15)",border:"none",color:P.wh,padding:"5px 14px",borderRadius:4,cursor:"pointer",fontSize:12}}>{t("Αποσύνδεση","Logout")}</button>
        </div>
      </div>
      {cd.status==="rejected" && cd.rejectNote && (
        <div style={{background:"#FFEBEE",borderBottom:"1px solid #F5C6CB",color:P.rd,padding:"8px 24px",fontSize:13,display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontWeight:700}}>✗ {t("Απορρίφθηκε από Finance:","Rejected by Finance:")}</span>
          <span style={{color:P.tx}}>{cd.rejectNote}</span>
        </div>
      )}
      <div style={{background:P.wh,borderBottom:"1px solid "+P.bd,display:"flex",padding:"0 16px",overflowX:"auto"}}>
        {tabOrder.map((tb,i) => (
          <button key={tb.id}
            draggable="true"
            onDragStart={e=>{setDragTab(i);e.dataTransfer.effectAllowed="move";}}
            onDragOver={e=>{e.preventDefault();setOverTab(i);}}
            onDrop={e=>{e.preventDefault();if(dragTab!==null&&dragTab!==i){setTabOrder(prev=>{const a=[...prev];const item=a.splice(dragTab,1)[0];a.splice(i,0,item);return a;});}setDragTab(null);setOverTab(null);}}
            onDragEnd={()=>{setDragTab(null);setOverTab(null);}}
            onClick={() => setTab(tb.id)}
            style={{
              padding:"12px 18px",fontSize:13,background:"none",whiteSpace:"nowrap",
              border:"none",borderBottom:tab===tb.id?"3px solid "+P.em:"3px solid transparent",
              fontWeight:tab===tb.id?700:400,color:tab===tb.id?P.em:P.tm,
              opacity:dragTab===i?0.4:1,cursor:"grab",
              outline:overTab===i&&dragTab!==null?"2px solid #00897B":"none",
            }}>{tabLabel(tb.id)}</button>
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

import { useState, useEffect, useRef } from "react";
import { api, setToken, getToken } from "./api.js";
import * as XLSX from "xlsx";
// Bundled locally (no CDN dependency): zip handling + PDF rendering for the scanner
import JSZip from "jszip";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.js?url";
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
if (typeof window !== "undefined") { window.JSZip = JSZip; window.pdfjsLib = pdfjsLib; }

import {
  uid, CLIENTS, MONTHS, ML, setFiscalYear, normalizeClientData, currentFyLabel,
  REV_CATS, COST_CATS, LAB_ROWS, LAB_ALL_ROWS, LAB_EW_KEY, LAB_PJM_KEY, mkLab, mkAlloc, P, YEARS,
} from "./constants.js";
import { LogoImg, LangToggle, GlobalSearch } from "./ui.jsx";
import { Login, ForcePw, ResetPassword } from "./auth.jsx";
import { PnL, InvTab, SubTab, AccTab, LabTab, POTracker } from "./reportTabs.jsx";
import { parseWorkbookFile, ReconcileModal } from "./importReconcile.jsx";
import { expandFiles, extractOne } from "./scanEngine.js";
import { DuplicateModal } from "./dupCheck.jsx";
import { Insights } from "./insights.jsx";
import { ChatWidget } from "./chat.jsx";
import { Dashboard, ApArLedger, OpexCapex } from "./finance.jsx";
import { GroupReports } from "./groupReports.jsx";
import { AdminPanel } from "./admin.jsx";
import { Scan } from "./scan.jsx";
import { ClientPicker } from "./clientPicker.jsx";
import { ContractTab } from "./contracts.jsx";
import { useT, monthLabel } from "./i18n.jsx";

// A scan session is per-client so scanning survives tab/client navigation (it lives in App,
// which never unmounts). Fresh object each call to avoid shared-reference mutation.
const emptyScan = () => ({ files: [], results: [], busy: false, prog: "", mode: "AP", autoMode: false, targetMonth: "", approved: { sub: 0, inv: 0 } });

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
  const [year, setYear] = useState(() => YEARS.includes(currentFyLabel()) ? currentFyLabel() : YEARS[YEARS.length - 1]);
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
  const [lockOpen,setLockOpen] = useState(false);
  const [reconcile,setReconcile] = useState(null);   // { parsed } — open Import & Reconcile modal
  const [reconciling,setReconciling] = useState(false);
  const [dupOpen,setDupOpen] = useState(false);      // duplicate-check modal

  // ── Background invoice scanning (per-client sessions; the loop lives here so it keeps running
  // while you switch tabs or clients, and you see the progress when you come back) ──
  const [scanSessions,setScanSessions] = useState({});
  const scanRef = useRef({}); scanRef.current = scanSessions;
  const scanBusyRef = useRef({});
  const patchScan = (key,upd) => setScanSessions(p => { const cur = p[key] || emptyScan(); const nx = typeof upd==="function"?upd(cur):upd; return {...p,[key]:{...cur,...nx}}; });
  const patchScanResult = (key,i,kv) => setScanSessions(p => { const cur = p[key] || emptyScan(); return {...p,[key]:{...cur,results:cur.results.map((r,j)=>j===i?{...r,...kv}:r)}}; });
  const runScan = async (key) => {
    if(!key || scanBusyRef.current[key]) return;
    const sess = scanRef.current[key] || emptyScan();
    if(!sess.files.length) return;
    scanBusyRef.current[key] = true;
    const { mode, autoMode, files } = sess;
    patchScan(key,{busy:true,results:[],approved:{sub:0,inv:0}});
    for(let i=0;i<files.length;i++){
      const f = files[i];
      patchScan(key,{prog:t(`🤖 AI ανάγνωση ${i+1}/${files.length}: ${f.name}`,`🤖 AI reading ${i+1}/${files.length}: ${f.name}`)});
      const row = await extractOne(f, mode, autoMode, (msg)=>patchScan(key,{prog:msg}));
      setScanSessions(p => { const cur = p[key] || emptyScan(); return {...p,[key]:{...cur,results:[...cur.results,row]}}; });
    }
    patchScan(key,{busy:false,prog:""});
    scanBusyRef.current[key] = false;
  };
  const [allData, setAllData] = useState(() => {
    const d = {};
    YEARS.forEach(y => {
      d[y] = {};
      CLIENTS.forEach(c => { d[y][c] = {inv:[],sub:[],lab:mkLab(),labAlloc:mkAlloc(),manualAccruals:[],contracts:[],docs:[],locked:{},status:"draft",submittedBy:"",submittedAt:""}; });
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

  // Landing-screen aggregates: pull EVERY client's data for the year in one request so the
  // client list shows revenue/GM/counts immediately — not only after a client has been opened.
  const [yearLoaded,setYearLoaded] = useState({});
  useEffect(() => {
    if(!user || client) return;                 // only while on the client-picker landing screen
    if(yearLoaded[year]) return;
    let cancelled = false;
    (async () => {
      const all = await api.getYearData(year).catch(()=>null);
      if(cancelled || !all) return;
      setAllData(p => {
        const yr = {...(p[year]||{})};
        Object.entries(all).forEach(([c,data]) => {
          if(hydratedKeys[`${year}:${c}`]) return;   // don't clobber a client already fully hydrated
          yr[c] = normalizeClientData({...(yr[c]||{}), ...data});
        });
        return {...p,[year]:yr};
      });
      if(!cancelled) setYearLoaded(prev=>({...prev,[year]:true}));
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line
  }, [user,client,year,yearLoaded]);

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
    const ckey = `${yr}:${cl}`;
    dirtyRef.current = false;
    if(beacon) {
      // Fire-and-forget save on leave/hide. The server increments the stored version by 1, so we must
      // bump our cached version to match — otherwise a resumed tab reuses the stale baseVersion and the
      // next real save self-inflicts a false 409 ("modified by another user") that drops the last edit.
      const base = versionsRef.current[ckey] ?? 0;
      versionsRef.current[ckey] = base + 1;                    // optimistic: matches the server on success
      const p = api.saveClientDataBeacon(yr, cl, rest, base);
      // On visibility-hidden (page still alive) the fetch resolves — reconcile with the true version,
      // and roll back the optimistic bump if the beacon never landed, so a later save isn't wrongly rejected.
      if(p && typeof p.then === "function") {
        p.then(async r => {
          try { const j = await r.json(); if(j && typeof j.version === "number") versionsRef.current[ckey] = j.version; }
          catch { versionsRef.current[ckey] = base; }
        }).catch(() => { versionsRef.current[ckey] = base; });
      }
    }
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
    // Guard with dirtyRef: a beacon flush on tab-hide sets dirtyRef=false, so this pending timer must
    // NOT fire a second (duplicate) save — which could reorder on the wire and self-inflict a false 409.
    const t = setTimeout(() => { if(dirtyRef.current) doSave(year, client, rest); }, 500);
    return () => clearTimeout(t);
  // eslint-disable-next-line
  }, [cd&&cd.inv,cd&&cd.sub,cd&&cd.lab,cd&&cd.labAlloc,cd&&cd.labPlan,cd&&cd.manualAccruals,cd&&cd.accrualReverse,cd&&cd.contracts,cd&&cd.locked,cd&&cd.status,cd&&cd.submittedBy,cd&&cd.submittedAt,cd&&cd.rejectNote, client, year]);
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
    // Any navigation away from the current client must first flush its debounced (unsaved) edit,
    // otherwise the 500ms save timer is cleared by the client switch and the last change is lost.
    flushSave();
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
  // Floating pill(s) for any scan running in the background — visible on every screen, click to jump
  // to that client's Scanner and watch the progress.
  const busyScans = Object.entries(scanSessions).filter(([,s])=>s.busy).map(([k,s])=>{ const i=k.indexOf(":"); return {key:k,year:k.slice(0,i),client:k.slice(i+1),done:s.results.length,total:s.files.length}; });
  const scanPill = busyScans.length ? (
    <div style={{position:"fixed",bottom:22,left:22,zIndex:1300,display:"flex",flexDirection:"column",gap:8}}>
      {busyScans.map(bs=>(
        <button key={bs.key} onClick={()=>{ flushSave(); setDashOpen(false);setLedgerOpen(false);setFinanceOpen(false);setGroupOpen(false); setYear(bs.year); setClient(bs.client); setTab("scan"); }}
          style={{background:P.em,color:"#fff",border:"none",borderRadius:20,padding:"9px 16px",boxShadow:"0 6px 20px rgba(0,0,0,.25)",cursor:"pointer",fontSize:12,fontWeight:600,display:"flex",alignItems:"center",gap:8,maxWidth:320}}>
          <span style={{fontSize:14}}>🤖</span>
          <span style={{whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{t("Σάρωση","Scanning")} {bs.client}: {bs.done}/{bs.total}</span>
        </button>
      ))}
    </div>
  ) : null;
  const searchEl = <GlobalSearch data={yd} onNavigate={navChat} canFinance={user.role==="finance"||user.role==="admin"} myClients={user.clients} />;
  const withChat = (screen) => <>{screen}{scanPill}{chatEl}{searchEl}</>;

  if (!client && dashOpen)
    return withChat(<Dashboard year={year} setYear={setYear} user={user} onBack={()=>setDashOpen(false)} onLogout={logout} onSelectClient={c=>{setDashOpen(false);setClient(c);setTab("contracts");}} />);
  if (!client && ledgerOpen && (user.role==="finance"||user.role==="admin"))
    return withChat(<ApArLedger year={year} setYear={setYear} user={user} onBack={()=>setLedgerOpen(false)} onLogout={logout} onSelectClient={c=>{setLedgerOpen(false);setClient(c);setTab("inv");}} />);
  if (!client && financeOpen && (user.role==="finance"||user.role==="admin"))
    return withChat(<OpexCapex year={year} setYear={setYear} user={user} onBack={()=>setFinanceOpen(false)} onLogout={logout} />);
  if (!client && groupOpen && (user.role==="finance"||user.role==="admin"))
    return withChat(<GroupReports year={year} setYear={setYear} user={user} onBack={()=>setGroupOpen(false)} onLogout={logout} />);
  if (!client) return withChat(<ClientPicker user={user} year={year} setYear={setYear} onSelect={c=>{setClient(c);setTab("contracts");}} onLogout={logout} allData={yd} loading={!yearLoaded[year]} onOpenFinance={()=>setFinanceOpen(true)} onOpenDash={()=>setDashOpen(true)} onOpenLedger={()=>setLedgerOpen(true)} onOpenGroup={()=>setGroupOpen(true)} />);

  const inv=cd.inv; const sub=cd.sub; const lab=cd.lab; const contracts=cd.contracts; const docs=cd.docs||[];
  const manualAccruals=cd.manualAccruals||[];
  const labPlan=cd.labPlan||{};                 // persisted FTE×rate planner inputs (survives refresh)
  const accrualReverse=cd.accrualReverse||false; // persisted accrual auto-reverse (M+1) toggle
  // Period lock: months a finance/admin has closed. Data-entry in these months is read-only for everyone.
  const lockedMap = cd.locked||{};
  const lockedSet = new Set(Object.keys(lockedMap));
  const canLock = user.role==="finance"||user.role==="admin";
  const toggleLock = (m) => { const next={...lockedMap}; if(next[m]) delete next[m]; else next[m]={by:user.name||user.user,at:new Date().toISOString().slice(0,10)}; upClient("locked",next); };
  const setInv=v=>upClient("inv",v);
  const setSub=v=>upClient("sub",v);
  const setLab=v=>upClient("lab",v);
  const setManualAccruals=v=>upClient("manualAccruals",v);
  const setContracts=v=>upClient("contracts",v);
  const setDocs=v=>upClient("docs",v);

  // Current client's scan session + bound actions passed to the Scan view (which is now a
  // controlled view over App-owned, per-client scan state).
  const curScanKey = client ? `${year}:${client}` : null;
  const scanSession = (curScanKey && scanSessions[curScanKey]) || emptyScan();
  const scanApi = {
    addFiles: async (fl) => { patchScan(curScanKey,{prog:t("Φόρτωση αρχείων…","Loading files…")}); const files = await expandFiles(fl,(m)=>patchScan(curScanKey,{prog:m})); patchScan(curScanKey, s=>({files:[...s.files,...files],prog:""})); },
    resetPick: (auto) => patchScan(curScanKey,{files:[],results:[],approved:{sub:0,inv:0},autoMode:auto}),
    clearFiles: () => patchScan(curScanKey,{files:[],autoMode:false}),
    removeFile: (idx) => patchScan(curScanKey, s=>({files:s.files.filter((_,j)=>j!==idx)})),
    setField: (k,v) => patchScan(curScanKey,{[k]:v}),
    run: () => runScan(curScanKey),
    updateResult: (i,kv) => patchScanResult(curScanKey,i,kv),
    setResults: (fn) => patchScan(curScanKey, s=>({results:fn(s.results)})),
    bumpApproved: (k) => patchScan(curScanKey, s=>({approved:{...s.approved,[k]:s.approved[k]+1}})),
  };

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
        else if(key==="lab_core") sc(pWS,pr,col,Math.round(LAB_ROWS.reduce((s,r)=>s+(Number(lab[m]?.[r.k])||0),0)*100)/100,st);
        else if(key==="lab_ew") sc(pWS,pr,col,Math.round((Number(lab[m]?.[LAB_EW_KEY])||0)*100)/100,st);
        else if(key==="lab_pjm") sc(pWS,pr,col,Math.round((Number(lab[m]?.[LAB_PJM_KEY])||0)*100)/100,st);
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
    LAB_ALL_ROWS.forEach(r => { const row=[r.l,""];am.forEach(m=>row.push(Number(lab[m]?.[r.k])||0));labData.push(row); });
    labData.push(["SUM","",...am.map(()=>null)]);
    const lWS = XLSX.utils.aoa_to_sheet(labData);
    labH.forEach((_,i) => { if(lWS[ce(0,i)]) lWS[ce(0,i)].s = {font:{name:"Arial",sz:10,bold:true},alignment:{horizontal:i>=2?"right":"left"}}; });
    LAB_ALL_ROWS.forEach((r,i) => { am.forEach((m,mi) => { const c=lWS[ce(i+1,2+mi)]; if(c) c.s={font:{name:"Arial",sz:10},numFmt:"#,##0.00",alignment:{horizontal:"center"}}; }); });
    am.forEach((m,mi) => { const C=XLSX.utils.encode_col(2+mi); lWS[ce(LAB_ALL_ROWS.length+1,2+mi)]={t:'n',f:`SUM(${C}2:${C}${LAB_ALL_ROWS.length+1})`,s:{font:{name:"Arial",sz:10,bold:true},numFmt:"#,##0.00",alignment:{horizontal:"center"}}}; });
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


  // Apply the reconciliation choices — ADD new rows (fresh id) + UPDATE changed rows in place
  // (keep the system id). Never deletes. The debounced auto-save persists it with versioning.
  const applyReconcile = ({ invAdd, invUpd, subAdd, subUpd, labSet }) => {
    if (invAdd.length || invUpd.length) setInv(prev => {
      const upd = (prev || []).map(r => { const u = invUpd.find(x => x.sysId === r.id); return u ? { ...r, ...u.file, id: r.id } : r; });
      return [...upd, ...invAdd.map(f => ({ ...f, id: uid() }))];
    });
    if (subAdd.length || subUpd.length) setSub(prev => {
      const upd = (prev || []).map(r => { const u = subUpd.find(x => x.sysId === r.id); return u ? { ...r, ...u.file, id: r.id } : r; });
      return [...upd, ...subAdd.map(f => ({ ...f, id: uid() }))];
    });
    if (labSet.length) setLab(prev => {
      const out = {}; MONTHS.forEach(m => { out[m] = { ...(prev?.[m] || {}) }; });
      labSet.forEach(({ m, k, v }) => { if (!out[m]) out[m] = {}; out[m][k] = v; });
      return out;
    });
    const n = invAdd.length + invUpd.length + subAdd.length + subUpd.length + labSet.length;
    setReconcile(null);
    alert(t(`Εφαρμόστηκαν ${n} αλλαγές. Αποθηκεύονται αυτόματα.`, `Applied ${n} changes. Auto-saving.`));
  };

  return withChat(
    <div style={{minHeight:"100vh",background:P.of,fontFamily:"Segoe UI,Tahoma,sans-serif"}}>
      <div style={{background:P.em,color:P.wh,padding:"12px 24px",display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:8}}>
        <div style={{display:"flex",alignItems:"center",gap:16}}>
          <span style={{fontWeight:800,fontSize:18,letterSpacing:1}}>CBRE</span>
          <button onClick={()=>{flushSave();setClient(null);}} style={{background:"rgba(255,255,255,.2)",border:"none",color:"#fff",padding:"4px 12px",borderRadius:4,cursor:"pointer",fontSize:12}}>◀ {t("Πελάτες","Clients")}</button>
          <LogoImg name={client} size={28} radius={4} />
          <span style={{fontSize:14,fontWeight:600,borderLeft:"1px solid rgba(255,255,255,.3)",paddingLeft:12}}>{client} — {year}</span>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8,fontSize:13,position:"relative"}}>
          <button onClick={()=>window.dispatchEvent(new Event("mf-open-search"))} title={t("Αναζήτηση (⌘K)","Search (⌘K)")} style={{background:"rgba(255,255,255,.2)",border:"none",color:"#fff",padding:"7px 12px",borderRadius:4,cursor:"pointer",fontSize:12,fontWeight:600,display:"flex",alignItems:"center",gap:6}}>🔎 <span style={{fontSize:10,opacity:.85}}>⌘K</span></button>
          {/* Period lock (finance/admin): close a month so its invoices/sub become read-only for everyone */}
          {canLock && (
            <div style={{position:"relative"}}>
              <button onClick={()=>setLockOpen(!lockOpen)} title={t("Κλείδωμα/άνοιγμα μηνών","Lock/unlock months")} style={{background:lockedSet.size?"#B71C1C":"rgba(255,255,255,.2)",border:"none",color:"#fff",padding:"7px 14px",borderRadius:4,cursor:"pointer",fontSize:12,fontWeight:600,display:"flex",alignItems:"center",gap:6}}>
                🔒 {t("Κλείσιμο","Lock")}{lockedSet.size?` (${lockedSet.size})`:""} <span style={{fontSize:9}}>{lockOpen?"▲":"▼"}</span>
              </button>
              {lockOpen && (<>
                <div onClick={()=>setLockOpen(false)} style={{position:"fixed",inset:0,zIndex:99}} />
                <div style={{position:"absolute",top:"calc(100% + 6px)",right:0,background:"#fff",borderRadius:8,boxShadow:"0 8px 24px rgba(0,0,0,.18)",width:230,zIndex:100,overflow:"hidden",border:"1px solid "+P.bd}}>
                  <div style={{padding:"9px 14px",fontSize:11,color:P.tm,borderBottom:"1px solid "+P.bd,lineHeight:1.4}}>{t("Κλείδωσε κλεισμένους μήνες — τα τιμολόγια γίνονται read-only.","Lock closed months — invoices become read-only.")}</div>
                  <div style={{maxHeight:320,overflowY:"auto"}}>
                    {MONTHS.map(m=>{ const on=lockedSet.has(m); const info=lockedMap[m]; return (
                      <button key={m} onClick={()=>toggleLock(m)} style={{display:"flex",alignItems:"center",justifyContent:"space-between",width:"100%",padding:"8px 14px",border:"none",borderBottom:"1px solid "+P.al,background:on?"#FDECEA":"#fff",cursor:"pointer",fontSize:12.5,textAlign:"left",color:P.tx}}>
                        <span style={{fontWeight:600,color:on?"#B71C1C":P.tx}}>{on?"🔒":"🔓"} {ML[m]||m}</span>
                        <span style={{fontSize:9.5,color:P.tm}}>{on?(info?.at||t("κλειδ.","locked")):t("ανοιχτό","open")}</span>
                      </button>
                    ); })}
                  </div>
                </div>
              </>)}
            </div>
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
                  {/* Export Excel */}
                  <button onClick={()=>{exportXL();setMenuOpen(false);}} style={{display:"flex",alignItems:"center",gap:10,width:"100%",padding:"11px 16px",border:"none",background:"none",cursor:"pointer",fontSize:13,color:P.em,fontWeight:600,textAlign:"left",borderBottom:"1px solid "+P.bd}}>
                    <span style={{fontSize:16}}>📥</span><div><div>{t("Λήψη Excel","Download Excel")}</div><div style={{fontSize:10,color:P.tm,fontWeight:400}}>{t("Εξαγωγή πλήρους αναφοράς","Export full report")}</div></div>
                  </button>
                  {/* Import & Reconcile P&L */}
                  <label style={{display:"flex",alignItems:"center",gap:10,width:"100%",padding:"11px 16px",cursor:reconciling?"wait":"pointer",fontSize:13,color:P.em,fontWeight:600,textAlign:"left",borderBottom:"1px solid "+P.bd}}>
                    <input type="file" accept=".xlsx,.xls,.xlsm" style={{display:"none"}} disabled={reconciling} onChange={async e=>{
                      const f=e.target.files[0]; e.target.value="";
                      if(!f) return;
                      setMenuOpen(false); setReconciling(true);
                      try { const parsed=await parseWorkbookFile(f); setReconcile({parsed}); }
                      catch(err){ console.error(err); alert(t("Η ανάγνωση απέτυχε: ","Parse failed: ")+err.message); }
                      finally { setReconciling(false); }
                    }} />
                    <span style={{fontSize:16}}>📊</span>
                    <div><div>{reconciling?t("Ανάγνωση...","Reading..."):t("Import & Reconcile P&L","Import & Reconcile P&L")}</div><div style={{fontSize:10,color:P.tm,fontWeight:400}}>{t("Σύγκριση με τα υπάρχοντα + προσθήκη/ενημέρωση","Compare with existing + add / update")}</div></div>
                  </label>
                  {/* Clear All */}
                  <button onClick={async ()=>{
                    // Type-to-confirm: must type the exact client name, so a stray click can't wipe data.
                    const typed = prompt(t(`⚠ ΟΡΙΣΤΙΚΗ διαγραφή ΟΛΩΝ των δεδομένων για ${client} ${year}\n(τιμολόγια, υπεργολάβοι, εργασία, συμβόλαια, έγγραφα, κατάσταση) — ΔΕΝ αναιρείται.\n\nΓια επιβεβαίωση γράψε το όνομα του πελάτη ακριβώς:\n${client}`,`⚠ PERMANENTLY delete ALL data for ${client} ${year}\n(invoices, sub, labour, contracts, documents, status) — cannot be undone.\n\nTo confirm, type the client name exactly:\n${client}`), "");
                    if(typed===null) return;
                    if(typed.trim()!==client){ alert(t("Το όνομα δεν ταιριάζει — η διαγραφή ακυρώθηκε.","Name doesn't match — deletion cancelled.")); return; }
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
      <div style={{padding:"clamp(10px,3vw,20px)",maxWidth:1400,margin:"0 auto"}}>
        {tab==="contracts" && <ContractTab data={contracts} set={setContracts} inv={inv} docs={docs} setDocs={setDocs} year={year} client={client} />}
        {tab==="scan" && <Scan session={scanSession} scanApi={scanApi} goTo={setTab} year={year} client={client} onAdd={items => setSub(p => [...p,...items.map(x => { const a=Number(x.amt)||0, v=Number(x.vat)||0; const fp=Number(x.fee_pct)|| (contracts||[]).find(c=>c.status==="Active"&&c.type==="MSA")?.fee_pct || 5.5; const fee=Math.round(a*fp/100*100)/100; return {...x,id:uid(),total:x.total!=null?x.total:Math.round((a+v)*100)/100,fee_pct:fp,cbre_fee:fee,cbre_bill:Math.round((a+fee)*100)/100}; })])} onAddAR={items => setInv(p => [...p,...items.map(x => ({...x,id:uid()}))])} />}
        {tab==="pnl" && <PnL inv={inv} sub={sub} lab={lab} client={client} year={year} user={user} />}
        {tab==="insights" && <Insights inv={inv} sub={sub} lab={lab} contracts={contracts} client={client} year={year} />}
        {tab==="inv" && <InvTab data={inv} set={setInv} contracts={contracts} year={year} client={client} onDupCheck={()=>setDupOpen(true)} locked={lockedSet} />}
        {tab==="sub" && <SubTab data={sub} set={setSub} contracts={contracts} year={year} client={client} onDupCheck={()=>setDupOpen(true)} locked={lockedSet} />}
        {tab==="acc" && <AccTab inv={inv} sub={sub} data={manualAccruals} set={setManualAccruals} locked={lockedSet} autoRev={accrualReverse} setAutoRev={v=>upClient("accrualReverse",v)} />}
        {tab==="lab" && <LabTab data={lab} set={setLab} locked={lockedSet} plan={labPlan} setPlan={v=>upClient("labPlan",v)} />}
      </div>
      {reconcile && (
        <ReconcileModal
          parsed={reconcile.parsed}
          cur={{ inv, sub, lab, client }}
          onClose={()=>setReconcile(null)}
          onApply={applyReconcile}
        />
      )}
      {dupOpen && (
        <DuplicateModal inv={inv} sub={sub} setInv={setInv} setSub={setSub} year={year} client={client} onClose={()=>setDupOpen(false)} />
      )}
    </div>
  );
}

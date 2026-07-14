import { useState, useEffect, useRef } from "react";
import { api, setToken, getToken } from "./api.js";
import * as XLSX from "xlsx";
// Bundled locally (no CDN dependency): zip handling + PDF rendering for the scanner
import JSZip from "jszip";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.js?url";
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
if (typeof window !== "undefined") { window.JSZip = JSZip; window.pdfjsLib = pdfjsLib; }

// Stable unique id with a fallback for non-secure contexts (crypto.randomUUID is
// undefined over plain http, e.g. http://<LAN-ip>:3300 — would otherwise throw).
const uid = () => (typeof crypto !== "undefined" && crypto.randomUUID)
  ? crypto.randomUUID()
  : "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);

// Legacy client-side USERS/PIN array removed — authentication is backend JWT (api.login).

const CLIENTS = [
  "FedEx","Foundever","Bloomberg","LNW Hellas","Lenovo","Minerva SA","Dacia",
  "Pfizer","Mondelez","Kenvue","IBM","Iron Mountain","Ericsson","Coca-Cola",
  "Novartis","Citibank","Sanofi","GSK","Google","Philips","JPMorgan","Gilead",
  "Tetra Pak","Dell","Worldline","Bank of America","Sandoz","BP Hellas","GE",
  "Goldman Sachs","Broadcom","Uber","Medtronic","Henkel","Opella","Kyndryl","Syngenta",
];

const LOGOS = {
  "FedEx":"fedex.com","Foundever":"foundever.com","Bloomberg":"bloomberg.com","LNW Hellas":"lnw.com",
  "Lenovo":"lenovo.com","Minerva SA":"minerva.com","Dacia":"dacia.com","Pfizer":"pfizer.com",
  "Mondelez":"mondelezinternational.com","Kenvue":"kenvue.com","IBM":"ibm.com","Iron Mountain":"ironmountain.com",
  "Ericsson":"ericsson.com","Coca-Cola":"coca-cola.com","Novartis":"novartis.com","Citibank":"citigroup.com",
  "Sanofi":"sanofi.com","GSK":"gsk.com","Google":"google.com","Philips":"philips.com",
  "JPMorgan":"jpmorgan.com","Gilead":"gilead.com","Tetra Pak":"tetrapak.com","Dell":"dell.com",
  "Worldline":"worldline.com","Bank of America":"bankofamerica.com","Sandoz":"sandoz.com",
  "BP Hellas":"bp.com","GE":"ge.com","Goldman Sachs":"goldmansachs.com","Broadcom":"broadcom.com",
  "Uber":"uber.com","Medtronic":"medtronic.com","Henkel":"henkel.com","Opella":"opella.com",
  "Kyndryl":"kyndryl.com","Syngenta":"syngenta.com",
};
const logoUrl = (c) => LOGOS[c] ? `https://logo.clearbit.com/${LOGOS[c]}` : null;
const logoUrl2 = (c) => LOGOS[c] ? `https://www.google.com/s2/favicons?domain=${LOGOS[c]}&sz=128` : null;

const REPORT_STATUS = [{v:"draft",l:"Draft",color:"#78909C",bg:"#ECEFF1"},{v:"submitted",l:"Submitted by User",color:"#F57F17",bg:"#FFF8E1"},{v:"approved",l:"Approved by Finance",color:"#2E7D32",bg:"#E8F5E9"},{v:"rejected",l:"Rejected — Revise",color:"#C62828",bg:"#FFEBEE"}];

// ── Fiscal months are DERIVED from the selected FY (no more hardcoded year) ──
// MONTHS/ML keep stable references (mutated in place) so every component sees the active FY.
const MNAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const fyToMonths = (fy) => {
  const yy = 2000 + (parseInt(String(fy).replace(/\D/g, ""), 10) || 26);
  return Array.from({ length: 12 }, (_, i) => `${yy}-${String(i + 1).padStart(2, "0")}`);
};
const MONTHS = fyToMonths("FY26");
const ML = {};
const rebuildML = () => {
  Object.keys(ML).forEach(k => delete ML[k]);
  MONTHS.forEach(m => { const [y, mm] = m.split("-"); ML[m] = `${MNAMES[+mm - 1]}-${y.slice(2)}`; });
};
rebuildML();
let CURRENT_FY = "FY26";
const setFiscalYear = (fy) => {
  if (fy === CURRENT_FY) return;
  CURRENT_FY = fy;
  MONTHS.splice(0, MONTHS.length, ...fyToMonths(fy));
  rebuildML();
};
// Remap any month key of a different calendar year onto the active FY (keeps the MM part).
// Heals data saved while months were hardcoded to 2026 — lossless, month index preserved.
const remapMonth = (m) => {
  if (typeof m !== "string" || !/^\d{4}-\d{2}/.test(m)) return m;
  const target = MONTHS[+m.slice(5, 7) - 1];
  return target || m;
};
const normalizeClientData = (c) => {
  if (!c || typeof c !== "object") return c;
  const out = { ...c };
  if (Array.isArray(out.inv)) out.inv = out.inv.map(r => ({ ...r, month: remapMonth(r.month) }));
  if (Array.isArray(out.sub)) out.sub = out.sub.map(r => ({ ...r, month: remapMonth(r.month) }));
  for (const key of ["lab"]) {
    const src = out[key];
    if (!src || typeof src !== "object") continue;
    const fixed = {};
    MONTHS.forEach(m => { fixed[m] = {}; });
    for (const [m, vals] of Object.entries(src)) {
      const t = remapMonth(m);
      if (fixed[t]) fixed[t] = { ...fixed[t], ...vals };
    }
    out[key] = fixed;
  }
  // Labour segment allocation: always present with month keys on the active FY, default 100% Core
  const alloc = {};
  MONTHS.forEach(m => { alloc[m] = { core:100, ew:0, pjm:0 }; });
  if (out.labAlloc && typeof out.labAlloc === "object") {
    for (const [m, v] of Object.entries(out.labAlloc)) {
      const t = remapMonth(m);
      if (alloc[t] && v && typeof v === "object") alloc[t] = { core:Number(v.core)||0, ew:Number(v.ew)||0, pjm:Number(v.pjm)||0 };
    }
  }
  out.labAlloc = alloc;
  return out;
};
const SITES = ["Site 1","Site 2","Site 3","Site 4","Site 5"];
const REV_CATS = ["CLIENT REVENUE - FM Core","CLIENT REVENUE - FM Extra Works","CLIENT REVENUE - PJMs"];
const COST_CATS = ["Subcontractors cost - FM Core","Subcontractors cost - FM Extra Works","Subcontractors cost - PJMs"];
const SVC_CATS = ["Cleaning","Building Systems & maintenance","Waste Management","Handyman services","Office supplies","Kitchen supplies","Water supplies","Small works","Laundry services","Mail services","Pest Control","Landscaping","Security services","Catering services","Employee Convenience","Other"];
const LAB_ROWS = [{k:"onsite",l:"CBRE On site team"},{k:"regional",l:"Regional Cost"},{k:"it",l:"IT Cost"},{k:"local",l:"Local Support"},{k:"sga",l:"SG&A"},{k:"other",l:"Other items"}];
function mkLab() { const o = {}; MONTHS.forEach(m => { o[m] = {}; LAB_ROWS.forEach(r => { o[m][r.k] = 0; }); }); return o; }
// Accruals (AccTab) are computed live from inv/sub — no stored `acc` blob is kept.
// Per-month allocation of total labour across the 3 segments (weights, default all to Core
// so existing numbers are unchanged until finance allocates). Segments: core / ew / pjm.
function mkAlloc() { const o = {}; MONTHS.forEach(m => { o[m] = {core:100,ew:0,pjm:0}; }); return o; }
// Read a month's allocation as normalized fractions that ALWAYS sum to 1 (proportional to the
// weights) so the split can never change the total labour cost. Empty/zero → 100% Core.
const allocFractions = (labAlloc, m) => {
  const a = labAlloc && labAlloc[m];
  const core = a ? Number(a.core)||0 : 100, ew = a ? Number(a.ew)||0 : 0, pjm = a ? Number(a.pjm)||0 : 0;
  const s = core + ew + pjm;
  return s > 0 ? {core:core/s, ew:ew/s, pjm:pjm/s} : {core:1, ew:0, pjm:0};
};


const P = { em:"#003F2D",ep:"#E8F5E9",wh:"#fff",of:"#F7F9F8",bd:"#D5DDD8",tx:"#1A2E23",tm:"#5F7567",rd:"#C62828",gn:"#2E7D32",al:"#F0F5F2",ip:"#FFFFF0" };
const fmt = n => (n == null || isNaN(n)) ? "-" : n.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
const fPct = n => (n == null || isNaN(n) || !isFinite(n)) ? "-" : (n*100).toFixed(1)+"%";

const YEARS = ["FY24","FY25","FY26","FY27"];

// ── Company-wide OPEX / CAPEX (finance/admin) ──
const DEFAULT_OPEX_CATS = ["Payroll & overhead","Rent","Utilities","IT & Software","Telecom","Travel","Professional fees","Insurance","Office supplies","Marketing","Training","Other"];
const CAPEX_CATS = ["IT Equipment","Furniture & Fixtures","Vehicles","Leasehold improvements","Software (capitalised)","Machinery","Other"];
const CAPEX_STATUS = [{v:"Planned",c:"#78909C"},{v:"Approved",c:"#0277BD"},{v:"In progress",c:"#F57F17"},{v:"Capitalised",c:"#2E7D32"}];
// Absolute month index (year*12 + month-1) from a "YYYY-MM" key, for depreciation math.
const monthIdx = (ym) => { const m=/^(\d{4})-(\d{2})/.exec(String(ym||"")); return m ? (+m[1])*12 + (+m[2]-1) : null; };
// Straight-line depreciation of a capex item as of the end of the given fiscal-year months.
const depreciation = (item, fyMonths) => {
  const amt = Number(item.amount)||0, life = Number(item.life)||0;
  const acq = monthIdx(item.month);
  const monthly = life>0 ? amt/life : 0;
  const perMonth = {}; fyMonths.forEach(m=>{ perMonth[m]=0; });
  let elapsedToYearEnd = 0;
  const lastIdx = fyMonths.length ? monthIdx(fyMonths[fyMonths.length-1]) : null;
  if (acq!=null && life>0) {
    fyMonths.forEach(m => { const gi=monthIdx(m); const k=gi-acq; if (k>=0 && k<life) perMonth[m]=monthly; });
    if (lastIdx!=null) elapsedToYearEnd = Math.min(life, Math.max(0, lastIdx - acq + 1));
  }
  const accumulated = Math.min(amt, elapsedToYearEnd*monthly);
  return { monthly, perMonth, accumulated, nbv: Math.max(0, amt-accumulated) };
};

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
  const [year, setYear] = useState("FY26");
  setFiscalYear(year); // render-safe (idempotent): keeps MONTHS/ML aligned with the selected FY
  const [tab, setTab] = useState("contracts");
  const [tabOrder, setTabOrder] = useState([
    {id:"contracts",lb:"📋 Contracts & POs"},
    {id:"scan",lb:"📄 Invoice Scanner"},
    {id:"pnl",lb:"P&L Report"},
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
  if (!client && dashOpen)
    return <Dashboard year={year} setYear={setYear} user={user} onBack={()=>setDashOpen(false)} onLogout={logout} onSelectClient={c=>{setDashOpen(false);setClient(c);setTab("contracts");}} />;
  if (!client && financeOpen && (user.role==="finance"||user.role==="admin"))
    return <OpexCapex year={year} setYear={setYear} user={user} onBack={()=>setFinanceOpen(false)} onLogout={logout} />;
  if (!client) return <ClientPicker user={user} year={year} setYear={setYear} onSelect={c=>{setClient(c);setTab("contracts");}} onLogout={logout} allData={yd} onOpenFinance={()=>setFinanceOpen(true)} onOpenDash={()=>setDashOpen(true)} />;

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

      // Apply imports — REPLACE existing data
      const hasExisting = (cd.inv?.length||0) + (cd.sub?.length||0) + (cd.contracts?.length||0) > 0;
      if(hasExisting && !confirm("This will REPLACE all existing data for "+client+" "+year+". Continue?")) {
        setImporting(false); setMenuOpen(false); return;
      }
      if(newInv.length) setInv(newInv);
      if(newSub.length) setSub(newSub);
      if(labRowsImported) setLab(newLab);
      if(newContracts.length) setContracts(newContracts);

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

  return (
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
        {tab==="inv" && <InvTab data={inv} set={setInv} contracts={contracts} year={year} client={client} />}
        {tab==="sub" && <SubTab data={sub} set={setSub} contracts={contracts} year={year} client={client} />}
        {tab==="acc" && <AccTab inv={inv} sub={sub} />}
        {tab==="lab" && <LabTab data={lab} set={setLab} alloc={labAlloc} setAlloc={setLabAlloc} />}
      </div>
    </div>
  );
}

function ClientPicker({user,year,setYear,onSelect,onLogout,allData,onOpenFinance,onOpenDash}) {
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

function LogoImg({name,size,radius}) {
  const [src,setSrc] = useState(logoUrl(name));
  const [err,setErr] = useState(0);
  const fallback = () => {
    if(err===0){setSrc(logoUrl2(name));setErr(1);}
    else setErr(2);
  };
  const sz = size||36; const rd = radius||8;
  const color = (() => {const colors=["#003F2D","#00695C","#00897B","#0277BD","#1565C0","#283593","#4527A0","#6A1B9A","#AD1457","#C62828","#D84315","#EF6C00","#F9A825","#2E7D32","#00838F","#37474F"];let h=0;for(let i=0;i<name.length;i++)h=((h<<5)-h+name.charCodeAt(i))|0;return colors[Math.abs(h)%colors.length];})();
  const ini = name.split(/[\s-]+/).map(w=>w[0]).join("").slice(0,2).toUpperCase();
  if(err>=2||!src) return <div style={{width:sz,height:sz,borderRadius:rd,background:color,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontWeight:700,fontSize:sz*0.36,flexShrink:0}}>{ini}</div>;
  return <img src={src} alt="" style={{width:sz,height:sz,borderRadius:rd,objectFit:"contain",background:"#f5f5f5",padding:2,flexShrink:0}} onError={fallback} />;
}

// Mandatory password change screen — shown when the account still uses a seeded/default password.
// Password input with a show/hide (👁) toggle. Reused on login + change-password screens.
function PwField({value,onChange,onEnter,style,autoFocus}) {
  const [show,setShow] = useState(false);
  return (
    <div style={{position:"relative"}}>
      <input type={show?"text":"password"} value={value} onChange={onChange} autoFocus={autoFocus}
        onKeyDown={onEnter?e=>{if(e.key==="Enter")onEnter();}:undefined}
        style={{...style, paddingRight:40}} />
      <button type="button" tabIndex={-1} onMouseDown={e=>e.preventDefault()} onClick={()=>setShow(s=>!s)}
        title={show?"Απόκρυψη κωδικού":"Εμφάνιση κωδικού"} aria-label={show?"Απόκρυψη κωδικού":"Εμφάνιση κωδικού"}
        style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",cursor:"pointer",fontSize:16,opacity:.55,padding:0,lineHeight:1}}>{show?"🙈":"👁"}</button>
    </div>
  );
}

// Reached from the emailed reset link (/reset?token=...). Sets a new password, then → login.
function ResetPassword({token}) {
  const [p1,setP1] = useState("");
  const [p2,setP2] = useState("");
  const [err,setErr] = useState("");
  const [busy,setBusy] = useState(false);
  const [done,setDone] = useState(false);
  const go = async () => {
    if(!p1||!p2){ setErr("Συμπλήρωσε και τα δύο πεδία"); return; }
    if(p1!==p2){ setErr("Οι κωδικοί δεν ταιριάζουν"); return; }
    if(p1.length<8){ setErr("Ο κωδικός πρέπει να έχει 8+ χαρακτήρες"); return; }
    setBusy(true); setErr("");
    try { await api.resetPassword(token, p1); setDone(true); }
    catch(e){ setErr(e.message||"Αποτυχία επαναφοράς"); }
    finally{ setBusy(false); }
  };
  const inp = {width:"100%",padding:"11px 14px",border:"1px solid "+P.bd,borderRadius:6,fontSize:14,outline:"none",background:"#fff",boxSizing:"border-box"};
  return (
    <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"#F7F9F8",fontFamily:"Segoe UI,Tahoma,sans-serif"}}>
      <div style={{width:380,background:"#fff",border:"1px solid "+P.bd,borderRadius:10,padding:"34px 34px 28px"}}>
        <div style={{fontWeight:800,fontSize:22,color:P.em,letterSpacing:1,marginBottom:6}}>CBRE</div>
        {done ? (
          <>
            <div style={{fontSize:18,fontWeight:700,color:P.gn,marginTop:8}}>✓ Ο κωδικός άλλαξε</div>
            <div style={{fontSize:13,color:P.tm,margin:"8px 0 22px",lineHeight:1.5}}>Μπορείς τώρα να συνδεθείς με τον νέο σου κωδικό.</div>
            <button onClick={()=>{window.location.href="/";}} style={{width:"100%",background:P.em,color:"#fff",border:"none",padding:"12px",borderRadius:6,fontSize:14,fontWeight:600,cursor:"pointer"}}>Σύνδεση</button>
          </>
        ) : (
          <>
            <div style={{fontSize:20,fontWeight:700,color:P.em,marginTop:8}}>🔑 Ορισμός νέου κωδικού</div>
            <div style={{fontSize:12.5,color:P.tm,margin:"8px 0 22px",lineHeight:1.5}}>Όρισε τον νέο σου κωδικό πρόσβασης.</div>
            <div style={{display:"flex",flexDirection:"column",gap:14}}>
              <div><label style={{fontSize:11,fontWeight:600,color:P.tm,display:"block",marginBottom:4}}>Νέος κωδικός (8+ χαρακτήρες)</label>
                <PwField value={p1} onChange={e=>{setP1(e.target.value);setErr("");}} style={inp} autoFocus /></div>
              <div><label style={{fontSize:11,fontWeight:600,color:P.tm,display:"block",marginBottom:4}}>Επιβεβαίωση</label>
                <PwField value={p2} onChange={e=>{setP2(e.target.value);setErr("");}} onEnter={go} style={inp} /></div>
              {err && <div style={{color:P.rd,fontSize:12}}>{err}</div>}
              <button onClick={go} disabled={busy} style={{width:"100%",background:P.em,color:"#fff",border:"none",padding:"12px",borderRadius:6,fontSize:14,fontWeight:600,cursor:busy?"wait":"pointer",opacity:busy?0.6:1}}>{busy?"Αποθήκευση…":"Ορισμός & σύνδεση"}</button>
              <button onClick={()=>{window.location.href="/";}} style={{background:"none",border:"none",color:P.tm,fontSize:12,cursor:"pointer",textDecoration:"underline"}}>Πίσω στη σύνδεση</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ForcePw({onDone,onLogout}) {
  const [cur,setCur] = useState("");
  const [n1,setN1] = useState("");
  const [n2,setN2] = useState("");
  const [err,setErr] = useState("");
  const [busy,setBusy] = useState(false);
  const go = async () => {
    if(!cur||!n1||!n2) { setErr("Συμπλήρωσε όλα τα πεδία"); return; }
    if(n1!==n2) { setErr("Οι νέοι κωδικοί δεν ταιριάζουν"); return; }
    if(n1.length<8) { setErr("Ο νέος κωδικός πρέπει να έχει 8+ χαρακτήρες"); return; }
    if(n1===cur) { setErr("Ο νέος κωδικός πρέπει να διαφέρει από τον τρέχοντα"); return; }
    setBusy(true); setErr("");
    try {
      const r = await api.changePassword(cur, n1);
      if(r && r.token) setToken(r.token); // server rotated the session — keep this one alive
      onDone();
    } catch(e) { setErr(e.message||"Αποτυχία αλλαγής κωδικού"); }
    finally { setBusy(false); }
  };
  const inp = {width:"100%",padding:"11px 14px",border:"1px solid "+P.bd,borderRadius:6,fontSize:14,outline:"none",background:"#fff",boxSizing:"border-box"};
  return (
    <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"#F7F9F8",fontFamily:"Segoe UI,Tahoma,sans-serif"}}>
      <div style={{width:380,background:"#fff",border:"1px solid "+P.bd,borderRadius:10,padding:"34px 34px 28px"}}>
        <div style={{fontSize:20,fontWeight:700,color:P.em}}>🔒 Απαιτείται αλλαγή κωδικού</div>
        <div style={{fontSize:12.5,color:P.tm,margin:"8px 0 22px",lineHeight:1.5}}>Ο λογαριασμός σου χρησιμοποιεί ακόμη τον προεπιλεγμένο κωδικό. Όρισε δικό σου για να συνεχίσεις.</div>
        <div style={{display:"flex",flexDirection:"column",gap:14}}>
          <div><label style={{fontSize:11,fontWeight:600,color:P.tm,display:"block",marginBottom:4}}>Τρέχων κωδικός</label>
            <PwField value={cur} onChange={e=>{setCur(e.target.value);setErr("");}} style={inp} /></div>
          <div><label style={{fontSize:11,fontWeight:600,color:P.tm,display:"block",marginBottom:4}}>Νέος κωδικός (8+ χαρακτήρες)</label>
            <PwField value={n1} onChange={e=>{setN1(e.target.value);setErr("");}} style={inp} /></div>
          <div><label style={{fontSize:11,fontWeight:600,color:P.tm,display:"block",marginBottom:4}}>Επιβεβαίωση νέου κωδικού</label>
            <PwField value={n2} onChange={e=>{setN2(e.target.value);setErr("");}} onEnter={go} style={inp} /></div>
          {err && <div style={{color:P.rd,fontSize:12}}>{err}</div>}
          <button onClick={go} disabled={busy} style={{width:"100%",background:P.em,color:"#fff",border:"none",padding:"12px",borderRadius:6,fontSize:14,fontWeight:600,cursor:busy?"wait":"pointer",opacity:busy?0.6:1}}>
            {busy?"Αποθήκευση...":"Αλλαγή κωδικού & είσοδος"}
          </button>
          <button onClick={onLogout} style={{background:"none",border:"none",color:P.tm,fontSize:12,cursor:"pointer",textDecoration:"underline"}}>Αποσύνδεση</button>
        </div>
      </div>
    </div>
  );
}

function Login({onLogin}) {
  const [u,setU] = useState("");
  const [c,setC] = useState("");
  const [err,setErr] = useState("");
  const [busy,setBusy] = useState(false);
  const [forgot,setForgot] = useState(false);
  const [fUser,setFUser] = useState("");
  const [fMsg,setFMsg] = useState("");
  const [fBusy,setFBusy] = useState(false);
  const sendForgot = async () => {
    if(!fUser.trim()) { setFMsg("Βάλε username ή email"); return; }
    setFBusy(true); setFMsg("");
    try {
      const r = await api.forgotPassword(fUser.trim());
      setFMsg(r.message || "Αν υπάρχει λογαριασμός με καταχωρημένο email, στάλθηκε σύνδεσμος επαναφοράς.");
    } catch(e) {
      setFMsg(e.status===503
        ? "Η επαναφορά μέσω email δεν είναι ενεργή ακόμη — ζήτα από τον διαχειριστή reset (⚙️ Admin → Χρήστες)."
        : (e.message||"Κάτι πήγε στραβά"));
    } finally { setFBusy(false); }
  };
  const go = async () => {
    if(!u || !c) { setErr("Enter username and password"); return; }
    setBusy(true); setErr("");
    try {
      const r = await api.login(u.trim().toLowerCase(), c);
      if(r.token) setToken(r.token);
      onLogin({user: r.user.username, name: r.user.name, role: r.user.role, clients: r.user.clients, mustChange: !!r.user.must_change_password});
    } catch(e) {
      setErr(e.message || "Invalid credentials");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{minHeight:"100vh",display:"flex",fontFamily:"Segoe UI,Tahoma,sans-serif"}}>
      {/* Left panel */}
      <div style={{flex:"0 0 45%",background:"#003F2D",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"60px 50px",color:"#fff",position:"relative"}}>
        <svg width="220" height="62" viewBox="0 0 220 62" xmlns="http://www.w3.org/2000/svg">
          <text fill="#fff" fontFamily="'Helvetica Neue',Helvetica,Arial,sans-serif" fontSize="62" fontWeight="700" letterSpacing="1" x="110" y="50" textAnchor="middle">CBRE</text>
        </svg>
        <div style={{fontSize:14,fontWeight:300,opacity:.6,marginTop:20}}>Client Monthly Reporting Platform</div>
        <div style={{position:"absolute",bottom:20,fontSize:10,opacity:.25}}>© {new Date().getFullYear()} CBRE Group, Inc.</div>
      </div>
      {/* Right panel */}
      <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",background:"#F7F9F8"}}>
        <div style={{width:340}}>
          <div style={{marginBottom:32}}>
            <div style={{fontSize:22,fontWeight:700,color:P.em}}>Welcome back</div>
            <div style={{fontSize:13,color:P.tm,marginTop:4}}>Sign in to access client reports</div>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:16}}>
            <div>
              <label style={{fontSize:11,fontWeight:600,color:P.tm,display:"block",marginBottom:4}}>Username</label>
              <input value={u} onChange={e=>{setU(e.target.value);setErr("");}} onKeyDown={e=>e.key==="Enter"&&go()}
                style={{width:"100%",padding:"11px 14px",border:"1px solid "+P.bd,borderRadius:6,fontSize:14,outline:"none",background:"#fff",boxSizing:"border-box"}} />
            </div>
            <div>
              <label style={{fontSize:11,fontWeight:600,color:P.tm,display:"block",marginBottom:4}}>Access Code</label>
              <PwField value={c} onChange={e=>{setC(e.target.value);setErr("");}} onEnter={go}
                style={{width:"100%",padding:"11px 14px",border:"1px solid "+P.bd,borderRadius:6,fontSize:14,outline:"none",background:"#fff",boxSizing:"border-box"}} />
            </div>
            {err && <div style={{color:P.rd,fontSize:12,padding:"4px 0"}}>{err}</div>}
            <button onClick={go} disabled={busy}
              style={{width:"100%",background:P.em,color:"#fff",border:"none",padding:"12px",borderRadius:6,fontSize:14,fontWeight:600,cursor:busy?"wait":"pointer",marginTop:4,opacity:busy?0.6:1}}>
              {busy?"Signing in...":"Sign In"}
            </button>
            <button type="button" onClick={()=>{setForgot(f=>!f);setFMsg("");}} style={{background:"none",border:"none",color:P.tm,fontSize:12,cursor:"pointer",textDecoration:"underline",alignSelf:"center",padding:0}}>Ξέχασα τον κωδικό;</button>
            {forgot && (
              <div style={{background:P.of,border:"1px solid "+P.bd,borderRadius:6,padding:"12px",display:"flex",flexDirection:"column",gap:8}}>
                <div style={{fontSize:12,color:P.tm}}>Βάλε το username ή το email σου — θα λάβεις σύνδεσμο επαναφοράς στο email σου.</div>
                <input value={fUser} onChange={e=>{setFUser(e.target.value);setFMsg("");}} onKeyDown={e=>e.key==="Enter"&&sendForgot()} placeholder="username ή email"
                  style={{padding:"9px 12px",border:"1px solid "+P.bd,borderRadius:6,fontSize:13,outline:"none",background:"#fff",boxSizing:"border-box"}} />
                <button type="button" onClick={sendForgot} disabled={fBusy} style={{background:P.em,color:"#fff",border:"none",padding:"9px",borderRadius:6,fontSize:13,fontWeight:600,cursor:fBusy?"wait":"pointer",opacity:fBusy?.6:1}}>{fBusy?"Αποστολή…":"Στείλε σύνδεσμο επαναφοράς"}</button>
                {fMsg && <div style={{color:P.em,fontSize:12}}>{fMsg}</div>}
                <div style={{color:P.tm,fontSize:11}}>Εναλλακτικά, ζήτα από τον διαχειριστή reset (⚙️ Admin → Χρήστες).</div>
              </div>
            )}
          </div>
          <div style={{marginTop:24,fontSize:11,color:P.tm,textAlign:"center"}}>
            Authorised CBRE Hellas employees only
          </div>
        </div>
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

function Scan({onAdd,onAddAR,goTo,year,client}) {
  const [files, setFiles] = useState([]);
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState("");
  const [drag, setDrag] = useState(false);
  const [mode, setMode] = useState("AP"); // "AP" = Sub Invoices, "AR" = CBRE Invoices
  const [autoMode, setAutoMode] = useState(false); // bulk folder scan: auto-detect AP/AR per invoice
  const [targetMonth, setTargetMonth] = useState(""); // optional override
  const [approved, setApproved] = useState({sub:0, inv:0}); // post-approve destination summary
  const [preview, setPreview] = useState(null); // {url,name,isPdf} local-blob preview before approve

  const [libsReady, setLibsReady] = useState({pdf:false, ocr:false, zip:false});
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);

  // pdf.js + JSZip are bundled locally (imported at module top) — instantly ready, no CDN.
  // Tesseract (rare OCR fallback) stays lazy-loaded but pinned with an SRI integrity hash.
  useEffect(() => {
    setLibsReady(p=>({...p, pdf: !!window.pdfjsLib, zip: !!window.JSZip}));
    if (window.Tesseract) { setLibsReady(p=>({...p, ocr:true})); return; }
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.0.4/tesseract.min.js";
    s.integrity = "sha512-2wYKf5SRmHOMuTUmSsOkTTwejJrRcL6oHK5zHw/8MPUwZgTEekmapU6UOkxs0KFy20eWWmCiL30fZoVrtRkcPQ==";
    s.crossOrigin = "anonymous";
    s.async = true;
    s.onload = () => setLibsReady(p=>({...p, ocr:true}));
    document.head.appendChild(s);
  }, []);

  // Enable folder selection on the hidden folder input (React doesn't pass webkitdirectory reliably)
  useEffect(() => {
    if (folderInputRef.current) {
      folderInputRef.current.setAttribute("webkitdirectory", "");
      folderInputRef.current.setAttribute("directory", "");
    }
  }, []);

  // ── Recursive folder traversal for drag-and-drop (dataTransfer.files ignores folder contents) ──
  const readAllEntries = (reader) => new Promise((resolve) => {
    const all = [];
    const pump = () => reader.readEntries(
      (batch) => { if (!batch.length) return resolve(all); all.push(...batch); pump(); },
      () => resolve(all)
    );
    pump();
  });
  const collectEntry = async (entry, out) => {
    if (!entry) return;
    if (entry.isFile) {
      await new Promise((resolve) => entry.file((f) => { out.push(f); resolve(); }, () => resolve()));
    } else if (entry.isDirectory) {
      const entries = await readAllEntries(entry.createReader());
      for (const e of entries) await collectEntry(e, out);
    }
  };
  const filesFromDataTransfer = async (dt) => {
    // Must capture entries synchronously — dataTransfer.items is invalidated after the first await
    const items = dt && dt.items ? Array.from(dt.items) : [];
    const entries = items
      .filter((it) => it.kind === "file" && typeof it.webkitGetAsEntry === "function")
      .map((it) => it.webkitGetAsEntry())
      .filter(Boolean);
    if (!entries.length) return dt && dt.files ? Array.from(dt.files) : [];
    const out = [];
    for (const en of entries) await collectEntry(en, out);
    return out;
  };

  // Isolated throwaway pickers — a fresh input each click, so file vs folder mode can never get crossed
  const pickFiles = () => {
    const inp = document.createElement("input");
    inp.type = "file"; inp.multiple = false; inp.accept = ".pdf,.zip,image/*";
    inp.style.display = "none"; document.body.appendChild(inp);
    inp.onchange = (e) => { setAutoMode(false); setFiles([]); setResults([]); setApproved({sub:0,inv:0}); addFiles(e.target.files); inp.remove(); };
    inp.click();
  };
  const pickFolder = () => {
    const inp = document.createElement("input");
    inp.type = "file"; inp.multiple = true; inp.webkitdirectory = true;
    inp.style.display = "none"; document.body.appendChild(inp);
    inp.onchange = (e) => { setAutoMode(true); setFiles([]); setResults([]); setApproved({sub:0,inv:0}); addFiles(e.target.files); inp.remove(); };
    inp.click();
  };

  const isZip = f => f.name.toLowerCase().endsWith(".zip") || f.type==="application/zip" || f.type==="application/x-zip-compressed";

  const waitForLib = async (key, timeout=15000) => {
    const start = Date.now();
    while(Date.now()-start < timeout) {
      if(key==="pdf" && window.pdfjsLib) return true;
      if(key==="ocr" && window.Tesseract) return true;
      if(key==="zip" && window.JSZip) return true;
      await new Promise(r=>setTimeout(r,200));
    }
    return false;
  };

  const addFiles = async fl => {
    const incoming = Array.from(fl);
    const out = [];
    for(const f of incoming) {
      if(isZip(f)) {
        // Extract ZIP contents
        if(!window.JSZip) {
          setProg("Loading ZIP support...");
          const ok = await waitForLib("zip");
          if(!ok) { alert("ZIP support could not be loaded. Please try again."); continue; }
          setProg("");
        }
        try {
          const zip = await window.JSZip.loadAsync(f);
          const entries = Object.values(zip.files).filter(z => !z.dir);
          for(const entry of entries) {
            const lname = entry.name.toLowerCase();
            if(lname.endsWith(".pdf")||lname.endsWith(".jpg")||lname.endsWith(".jpeg")||lname.endsWith(".png")||lname.endsWith(".gif")||lname.endsWith(".webp")) {
              const blob = await entry.async("blob");
              const ext = lname.split(".").pop();
              const mime = ext==="pdf"?"application/pdf":`image/${ext==="jpg"?"jpeg":ext}`;
              const file = new File([blob], entry.name.split("/").pop(), {type:mime});
              out.push(file);
            }
          }
        } catch(e) {
          console.error("ZIP extraction failed:",e);
          alert(`Failed to extract ${f.name}: ${e.message}`);
        }
      } else if(f.type==="application/pdf"||f.type.startsWith("image/")) {
        out.push(f);
      }
    }
    if(out.length) setFiles(p => [...p, ...out]);
  };

  // Extract text from PDF using pdf.js
  const extractPdfText = async (file) => {
    if(!window.pdfjsLib) {
      const ok = await waitForLib("pdf");
      if(!ok) throw new Error("pdf.js failed to load — check internet connection");
    }
    const buf = await file.arrayBuffer();
    const pdf = await window.pdfjsLib.getDocument({data:buf}).promise;
    let text = "";
    for(let i=1;i<=pdf.numPages;i++){
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map(it=>it.str).join(" ") + "\n";
    }
    return text;
  };

  // Render PDF page to canvas for OCR
  const pdfPageToImage = async (file, pageNum) => {
    const buf = await file.arrayBuffer();
    const pdf = await window.pdfjsLib.getDocument({data:buf}).promise;
    const page = await pdf.getPage(pageNum || 1);
    const scale = 2; // higher = better OCR
    const vp = page.getViewport({scale});
    const canvas = document.createElement("canvas");
    canvas.width = vp.width; canvas.height = vp.height;
    await page.render({canvasContext:canvas.getContext("2d"),viewport:vp}).promise;
    return canvas;
  };

  // OCR using Tesseract.js
  const ocrImage = async (imageSource, progressCb) => {
    if(!window.Tesseract) {
      const ok = await waitForLib("ocr");
      if(!ok) throw new Error("Tesseract.js failed to load — check internet connection");
    }
    const worker = await window.Tesseract.createWorker("ell+eng", 1, {
      logger: m => { if(m.status==="recognizing text" && progressCb) progressCb(Math.round(m.progress*100)); }
    });
    const {data:{text}} = await worker.recognize(imageSource);
    await worker.terminate();
    return text;
  };

  // Parse invoice data from text using regex
  const parseInvoice = (text, fileName) => {
    const t = text.replace(/\s+/g," ");
    const lines = text.split("\n").map(l=>l.trim()).filter(l=>l.length>3);
    
    // Supplier — look for company suffixes like Ε.Π.Ε., Α.Ε., Ltd, S.A.
    let supplier = "";
    const compM = t.match(/([A-Za-zΑ-Ωα-ωάέήίόύώϊϋΐΰ\s.&\-,]{3,60})\s*(?:Ε\.?Π\.?Ε|Α\.?Ε|Ι\.?Κ\.?Ε|Ο\.?Ε|LTD|Ltd|S\.?A\.?|GmbH|LLC|INC|Μον[οπρόσωπη]*)/i);
    if(compM) supplier = compM[0].trim();
    if(!supplier){ const suppM = t.match(/(?:Επωνυμία|Company|Προμηθευτής|Εκδότης)[:\s]*([A-Za-zΑ-Ωα-ωάέήίόύώϊϋΐΰ\s.&\-]{3,60})/i); if(suppM) supplier=suppM[1].trim(); }
    if(!supplier) supplier = lines[0]||"Unknown";
    
    // AFM
    const afmM = t.match(/(?:Α\.?Φ\.?Μ\.?|ΑΦΜ|AFM|VAT\s*(?:No|ID|:)?)\s*:?\s*(?:EL)?(\d{9})/i);
    const afm = afmM?afmM[1]:"";
    
    // Invoice number
    let invNo = "";
    const invPs = [/(?:Αρ\.?\s*(?:Τιμ[ολογίου]*|Παρ[αστατικού]*)|Αριθμ[ός]*\s*(?:Τιμ|Παρ)|Invoice\s*(?:No|#|Number)|ΤΙΜΟΛΟΓΙΟ\s*(?:No|Αρ)?|ΑΡΙΘΜΟΣ)[:\s#]*([A-Za-zΑ-Ω]*[\s\-]*\d+[A-Za-z0-9\/-]*)/i, /(?:Σειρά|Series)[:\s]*([A-Za-zΑ-Ω]+)\s*(?:Αρ|No)[:\s]*(\d+)/i, /([A-ZΑ-Ω]{2,4}[\-]\d{4,8})/];
    for(const p of invPs){const m=t.match(p);if(m){invNo=(m[2]?m[1]+"-"+m[2]:m[1]).trim();break;}}
    
    // Date
    let invDate="", month=MONTHS[0];
    const dPs = [/(?:Ημερομηνία|Date|Ημ\/νία|Ημ\.)[:\s]*(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})/i, /(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/];
    for(const p of dPs){const m=t.match(p);if(m){const d=m[1],mo=m[2],y=m[3].length===2?"20"+m[3]:m[3];invDate=d.padStart(2,"0")+"/"+mo.padStart(2,"0")+"/"+y;const tryM=y+"-"+mo.padStart(2,"0");month=MONTHS.includes(tryM)?tryM:MONTHS[0];break;}}
    
    // Amount parsing — handles EU format 1.234,56 and US 1,234.56
    const parseAmt = s => { if(!s)return 0; s=s.replace(/\s/g,""); if(/^\d{1,3}\.\d{3}/.test(s))s=s.replace(/\./g,"").replace(",","."); else s=s.replace(",","."); return parseFloat(s)||0; };
    
    let net=0,vat=0,total=0;
    const nPs=[/(?:ΚΑΘΑΡΗ\s*ΑΞΙΑ|Καθαρή\s*Αξία|Net\s*(?:Amount|Value)|Αξία\s*(?:προ|χωρίς)\s*ΦΠΑ|Υποσύνολο|Subtotal|Taxable)[^0-9€]*€?\s*([\d]{1,3}(?:[.,]\d{3})*[.,]\d{2})/i];
    const vPs=[/(?:Φ\.?\s*Π\.?\s*Α\.?\s*\d*%?|ΦΠΑ\s*\d*%?|VAT\s*\d*%?|Φόρος)[^0-9€]*€?\s*(?:[\d.,]+\s+)?([\d]{1,3}(?:[.,]\d{3})*[.,]\d{2})/i];
    const tPs=[/(?:ΠΛΗΡΩΤΕΟ|Πληρωτέο|GRAND\s*TOTAL|Grand\s*Total|Γενικό\s*Σύνολο|ΓΕΝΙΚΟ\s*ΣΥΝΟΛΟ|ΣΥΝΟΛΙΚΗ\s*ΑΞΙΑ|Total\s*Due|Amount\s*Due)[^0-9€]*€?\s*([\d]{1,3}(?:[.,]\d{3})*[.,]\d{2})/i, /(?:ΣΥΝΟΛΟ|Σύνολο|Total)[^0-9€]*€?\s*([\d]{1,3}(?:[.,]\d{3})*[.,]\d{2})/i];
    for(const p of nPs){const m=t.match(p);if(m){net=parseAmt(m[1]);break;}}
    for(const p of vPs){const m=t.match(p);if(m){vat=parseAmt(m[1]);break;}}
    for(const p of tPs){const m=t.match(p);if(m){total=parseAmt(m[1]);break;}}
    
    // Fallback: find largest number
    if(!net&&!vat&&!total){const nums=[...t.matchAll(/([\d]{1,3}(?:[.,]\d{3})*(?:[.,]\d{2}))/g)].map(m=>parseAmt(m[1])).filter(n=>n>1);if(nums.length)total=Math.max(...nums);}
    
    if(net&&vat&&!total)total=net+vat; if(total&&vat&&!net)net=total-vat; if(total&&net&&!vat&&total!==net)vat=total-net;
    // Sanity: VAT cannot be >= net (max 24% in Greece)
    if(vat>=net&&net>0){vat=0;total=0;}
    if(total&&!net&&!vat){net=Math.round(total/1.24*100)/100;vat=Math.round((total-net)*100)/100;}
    if(net&&!vat){vat=Math.round(net*0.24*100)/100;total=net+vat;}
    if(net&&total&&net===total&&!vat){vat=Math.round(net*0.24*100)/100;total=net+vat;}
    
    // Description
    let desc="";
    const dePs=[/(?:Περιγραφή|Description|Αιτιολογία|Υπηρεσ[ίες]*|ΠΕΡΙΓΡΑΦΗ|DESCRIPTION)[:\s\/]*([A-Za-zΑ-Ωα-ωάέήίόύώϊϋΐΰ\s,.\-\/]{5,100})/i, /(?:για|for)\s+([A-Za-zΑ-Ωα-ωάέήίόύώϊϋΐΰ\s,.\-\/]{5,80})/i, /\b((?:Enhanced|Cleaning|Maintenance|Security|Facility|Management|Services?|Project)\s+[A-Za-z\s]{3,60})/i];
    for(const p of dePs){const m=t.match(p);if(m){desc=m[1].trim();break;}}

    return {supplier_name:supplier.slice(0,60),afm,invoice_number:invNo,invoice_date:invDate,month,net_amount:net,vat_amount:vat,total_amount:total,description:desc,cost_category:mode==="AP"?COST_CATS[0]:REV_CATS[0],service_category:"Other",_file:fileName,_st:"ready",_raw:text.slice(0,2000),_mode:mode};
  };

  // Invoice scanner — calls backend proxy (which calls Claude AI)
  // Falls back to local OCR + regex if backend AI is unavailable
  const scan = async () => {
    setBusy(true); setResults([]); setApproved({sub:0,inv:0}); const out = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      setProg(`🤖 AI reading ${i+1}/${files.length}: ${f.name}`);
      try {
        const scanMode = autoMode ? "AUTO" : mode;
        const ex = await api.extractInvoice(f, scanMode);
        const rMode = autoMode ? (String(ex.direction||"").toUpperCase()==="AR" ? "AR" : "AP") : mode;
        const isCredit = !!ex.is_credit_note;
        let net = Number(ex.net_amount)||0;
        let vat = Number(ex.vat_amount)||0;
        let total = Number(ex.total_amount)||0;
        if(isCredit) {
          if(net>0) net = -net;
          if(vat>0) vat = -vat;
          if(total>0) total = -total;
        }
        if(!total && net) total = net + (vat||net*0.24);
        if(!vat && net && total) vat = total - net;
        if(!net && total) { net = total/1.24; vat = total - net; }

        // Month: prefer ex.month, fallback to date parse
        let month = ex.month || "";
        if(!MONTHS.includes(month) && ex.invoice_date) {
          const dm = String(ex.invoice_date).match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/);
          if(dm){const y=dm[3].length===2?"20"+dm[3]:dm[3]; month = y+"-"+dm[2].padStart(2,"0");}
        }
        if(!MONTHS.includes(month)) month = MONTHS[0];

        // Cost/revenue category guess from description
        const desc = (ex.description||"").toLowerCase();
        let cat;
        if(rMode==="AR") {
          if(desc.includes("pjm")||desc.includes("project")) cat = REV_CATS.find(c=>c.toLowerCase().includes("pjm"))||REV_CATS[0];
          else if(desc.includes("extra")) cat = REV_CATS.find(c=>c.toLowerCase().includes("extra"))||REV_CATS[0];
          else cat = REV_CATS.find(c=>c.toLowerCase().includes("core"))||REV_CATS[0];
        } else {
          if(desc.includes("pjm")||desc.includes("project")) cat = COST_CATS.find(c=>c.toLowerCase().includes("pjm"))||COST_CATS[0];
          else if(desc.includes("extra")) cat = COST_CATS.find(c=>c.toLowerCase().includes("extra"))||COST_CATS[0];
          else cat = COST_CATS.find(c=>c.toLowerCase().includes("core"))||COST_CATS[0];
        }

        // Service category guess
        let svcCat = "Other";
        if(desc.includes("clean")||desc.includes("καθαρ")) svcCat = "Cleaning";
        else if(desc.includes("security")||desc.includes("ασφαλ")) svcCat = "Security";
        else if(desc.includes("maintenance")||desc.includes("technical")||desc.includes("hvac")) svcCat = "Building Systems operations & maintenance";
        else if(desc.includes("landscap")||desc.includes("plant")||desc.includes("κήπο")) svcCat = "Landscaping";
        else if(desc.includes("kitchen")||desc.includes("coffee")||desc.includes("καφέ")) svcCat = "Kitchen supplies";

        out.push({
          supplier_name: ex.supplier_name||"",
          afm: ex.afm||"",
          invoice_number: ex.invoice_number||"",
          invoice_date: ex.invoice_date||"",
          month,
          net_amount: net,
          vat_amount: vat,
          total_amount: total,
          description: ex.description||"",
          cost_category: cat,
          service_category: svcCat,
          _file: f.name,
          _st: "ready",
          _mode: rMode,
          _isCredit: isCredit,
          _fileObj: f
        });
      } catch(e) {
        console.error("AI extraction failed for",f.name,e);
        // Fallback: try local OCR + regex parser
        try {
          let text = "";
          if(f.type==="application/pdf"){
            text = await extractPdfText(f);
            if(text.replace(/\s/g,"").length < 30){
              const canvas = await pdfPageToImage(f, 1);
              text = await ocrImage(canvas, pct => setProg(`OCR fallback: ${f.name} (${pct}%)`));
            }
          } else {
            const url = URL.createObjectURL(f);
            text = await ocrImage(url, pct => setProg(`OCR: ${f.name} (${pct}%)`));
            URL.revokeObjectURL(url);
          }
          const parsed = parseInvoice(text, f.name);
          parsed._mode = mode;
          parsed._fileObj = f;
          out.push(parsed);
        } catch(e2) {
          out.push({_file:f.name,_st:"error",_mode:mode,supplier_name:"EXTRACTION FAILED",net_amount:0,vat_amount:0,total_amount:0,description:String(e.message||e),cost_category:mode==="AR"?REV_CATS[0]:COST_CATS[0],service_category:"Other",month:MONTHS[0],_raw:"",_fileObj:f});
        }
      }
    }
    setResults(out); setBusy(false); setProg("");
  };

  const upd = (i,k,v) => setResults(p => p.map((r,j) => j===i?{...r,[k]:v}:r));
  const flipMode = (i) => setResults(p => p.map((r,j) => {
    if(j!==i) return r;
    const nm = (r._mode||"AP")==="AR" ? "AP" : "AR";
    return {...r, _mode:nm, cost_category: nm==="AR"?REV_CATS[0]:COST_CATS[0]};
  }));
  const approve = async (i) => {
    const r = results[i]; if(r._st!=="ready") return;
    // Use targetMonth if set, otherwise the row's month, otherwise block
    const m = targetMonth || ((r.month||"").slice(0,7));
    if(!MONTHS.includes(m)) {
      alert(`Cannot approve "${r._file}" — invalid month "${m||"(empty)"}"\n\nSet a Target Month above or fix this row's month dropdown.`);
      return;
    }
    // Store the original file on the NAS and link it to the entry
    let docId = r._docId || null;
    if(!docId && r._fileObj && year && client) {
      try {
        upd(i,"_st","saving");
        const up = await api.uploadFile(year, client, r._fileObj, (r._mode||mode)==="AR"?"AR Invoice":"AP Invoice", r.invoice_number||"");
        docId = up && up.id;
        upd(i,"_docId",docId);
      } catch(e) { console.warn("Invoice file upload failed:",e); }
    }
    if((r._mode||mode)==="AR") {
      const a = Number(r.net_amount)||0; const v = Number(r.vat_amount)||0;
      onAddAR && onAddAR([{site:"Site 1",month:m,cat:r.cost_category||REV_CATS[0],amt:a,vat:v,total:a+v,inv_no:r.invoice_number||"",date:r.invoice_date||"",comments:r.description||"",act_acc:"ACTUAL",po_no:"",docId}]);
    } else {
      onAdd([{site:"Site 1",month:m,cat:r.cost_category||COST_CATS[0],supplier:r.supplier_name||"",svc_cat:r.service_category||"Other",svc_desc:r.description||"",amt:Number(r.net_amount)||0,vat:Number(r.vat_amount)||0,inv_no:r.invoice_number||"",date:r.invoice_date||"",docId}]);
    }
    setApproved(a=>{const k=(r._mode||mode)==="AR"?"inv":"sub";return {...a,[k]:a[k]+1};});
    upd(i,"_st","done");
  };
  const approveAll = () => {
    if(!targetMonth && results.some(r=>r._st==="ready"&&!MONTHS.includes((r.month||"").slice(0,7)))) {
      alert("Some invoices have invalid months. Please set a Target Month above or fix individual rows first.");
      return;
    }
    results.forEach((_,i) => approve(i));
  };
  const setAllMonth = (m) => setResults(p=>p.map(r=>({...r,month:m})));
  const [showRaw,setShowRaw] = useState(null);

  return (
    <div>
      <h2 style={{color:P.em,fontSize:16,fontWeight:700,margin:"0 0 6px"}}>Invoice Scanner — AI-Powered</h2>
      <p style={{fontSize:13,color:P.tm,margin:"0 0 12px"}}>Drop invoices (PDF, images, ZIP). Claude reads each invoice directly — no regex, no OCR guesswork. Auto-detects credit notes (πιστωτικά) and applies negative amounts.</p>

      {/* Libraries status */}
      <div style={{display:"flex",gap:10,fontSize:11,marginBottom:10,color:P.tm}}>
        <span>{libsReady.pdf?"✓":"⏳"} PDF parser</span>
        <span>{libsReady.ocr?"✓":"⏳"} OCR engine</span>
        <span>{libsReady.zip?"✓":"⏳"} ZIP support</span>
        {(!libsReady.pdf||!libsReady.ocr||!libsReady.zip) && <span style={{color:"#F57F17"}}>Loading libraries from CDN...</span>}
      </div>

      {/* Mode toggle */}
      <div style={{display:"flex",gap:0,marginBottom:14,background:P.wh,borderRadius:8,border:"1px solid "+P.bd,padding:4,width:"fit-content"}}>
        <button onClick={()=>setMode("AP")} style={{background:mode==="AP"?P.em:"transparent",color:mode==="AP"?"#fff":P.tx,border:"none",padding:"8px 18px",borderRadius:6,cursor:"pointer",fontSize:13,fontWeight:600}}>📥 AP — Supplier Invoices → Sub Costs</button>
        <button onClick={()=>setMode("AR")} style={{background:mode==="AR"?P.em:"transparent",color:mode==="AR"?"#fff":P.tx,border:"none",padding:"8px 18px",borderRadius:6,cursor:"pointer",fontSize:13,fontWeight:600}}>📤 AR — Client Invoices → CBRE Revenue</button>
      </div>

      <div onClick={pickFiles}
        onDrop={e=>{e.preventDefault();setDrag(false);const items=Array.from(e.dataTransfer.items||[]);const hasDir=items.some(it=>{const en=it.webkitGetAsEntry&&it.webkitGetAsEntry();return en&&en.isDirectory;});if(hasDir){alert("Σύρε ΑΡΧΕΙΑ (PDF/εικόνες), όχι ολόκληρο φάκελο.\n\nΓια ένα αρχείο: πάτα το κουμπί «Select a file».\nΓια πολλά: διάλεξέ τα μέσα στον φάκελο και σύρ' τα μαζί.");return;}setFiles([]);setResults([]);setApproved({sub:0,inv:0});addFiles(e.dataTransfer.files);}} onDragOver={e=>{e.preventDefault();setDrag(true);}} onDragLeave={()=>setDrag(false)}
        style={{display:"block",border:"3px dashed "+(drag?P.em:P.bd),borderRadius:12,padding:"36px 20px",textAlign:"center",cursor:"pointer",background:drag?P.ep:P.wh,transition:"all .2s",marginBottom:10}}>
        <input ref={fileInputRef} type="file" multiple accept=".pdf,.zip,image/*" style={{display:"none"}} onChange={e=>{addFiles(e.target.files);e.target.value="";}} />
        <input ref={folderInputRef} type="file" multiple style={{display:"none"}} onChange={e=>{addFiles(e.target.files);e.target.value="";}} />
        <div style={{fontSize:36,marginBottom:6}}>{mode==="AR"?"📤":"📥"}</div>
        <div style={{fontSize:14,fontWeight:600,color:P.em}}>Drop {mode==="AR"?"client (AR) invoices":"supplier (AP) invoices"} here</div>
        <div style={{fontSize:11,color:P.tm,marginTop:4}}>{mode==="AR"?"Will feed CBRE Invoices (Revenue)":"Will feed Sub Invoices (Costs)"} — drag one or more files here, or pick a single file with the button</div>
      </div>
      <div style={{display:"flex",justifyContent:"center",gap:10,marginBottom:16}}>
        <button type="button" onClick={pickFiles} style={{background:P.em,color:"#fff",border:"none",padding:"10px 24px",borderRadius:6,cursor:"pointer",fontSize:13,fontWeight:700}}>📄 Select a file</button>
        <button type="button" onClick={pickFolder} style={{background:"#0277BD",color:"#fff",border:"none",padding:"10px 24px",borderRadius:6,cursor:"pointer",fontSize:13,fontWeight:700}}>📁 Σάρωση φακέλου (auto AP/AR)</button>
      </div>
      {autoMode && <div style={{textAlign:"center",marginBottom:14,padding:"8px 14px",background:"#E1F5FE",border:"1px solid #0277BD",borderRadius:6,fontSize:12,color:"#01579B",fontWeight:600}}>🔍 Auto-ανίχνευση ΕΝΕΡΓΗ — κάθε τιμολόγιο ταξινομείται μόνο του σε 📥 AP (κόστος) ή 📤 AR (έσοδο). Έλεγξε/διόρθωσε το badge κάθε κάρτας (κλικ ⇄) πριν το Approve.</div>}
      {files.length > 0 && (
        <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,padding:14,marginBottom:16}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
            <span style={{fontSize:13,fontWeight:600,color:P.em}}>{files.length} file(s)</span>
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>{setFiles([]);setAutoMode(false);}} style={{background:"none",border:"1px solid "+P.bd,padding:"5px 12px",borderRadius:4,cursor:"pointer",fontSize:12}}>Clear</button>
              <button onClick={scan} disabled={busy} style={{background:P.em,color:"#fff",border:"none",padding:"7px 20px",borderRadius:6,cursor:busy?"wait":"pointer",fontSize:13,fontWeight:600,opacity:busy?0.5:1}}>{busy?"AI processing...":"🤖 Extract All with AI"}</button>
            </div>
          </div>
          {files.map((f,i)=><div key={i} style={{display:"flex",gap:8,padding:"3px 0",fontSize:12,alignItems:"center"}}><span>{f.type.includes("pdf")?"📄":"🖼️"}</span><span style={{flex:1}}>{f.name}</span><span style={{color:P.tm}}>{(f.size/1024).toFixed(0)}KB</span><button onClick={()=>setFiles(p=>p.filter((_,j)=>j!==i))} style={{background:"none",border:"none",color:P.rd,cursor:"pointer"}}>×</button></div>)}
          {prog && <div style={{marginTop:8,padding:"8px 12px",background:"#FFF8E1",borderRadius:6,fontSize:12,color:"#F57F17",fontWeight:600}}>{prog}</div>}
        </div>
      )}
      {(approved.sub>0||approved.inv>0) && (
        <div style={{background:P.gn,color:"#fff",borderRadius:8,padding:"10px 14px",marginBottom:14,display:"flex",alignItems:"center",gap:12,flexWrap:"wrap",fontSize:13,fontWeight:600}}>
          <span>✓ Καταχωρήθηκαν:</span>
          {approved.sub>0 && <span>{approved.sub} → Sub Invoices (Costs)</span>}
          {approved.inv>0 && <span>{approved.inv} → CBRE Invoices (Revenue)</span>}
          {approved.sub>0 && <button onClick={()=>goTo&&goTo("sub")} style={{background:"#fff",color:P.em,border:"none",padding:"5px 12px",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:700}}>→ Sub Invoices</button>}
          {approved.inv>0 && <button onClick={()=>goTo&&goTo("inv")} style={{background:"#fff",color:P.em,border:"none",padding:"5px 12px",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:700}}>→ CBRE Invoices</button>}
        </div>
      )}
      {results.length > 0 && (
        <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,overflow:"hidden"}}>
          <div style={{background:P.ep,padding:"10px 16px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span style={{fontSize:14,fontWeight:700,color:P.em}}>Extracted — Review & Approve</span>
            <button onClick={approveAll} style={{background:P.gn,color:"#fff",border:"none",padding:"7px 18px",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:600}}>✓ Approve All ({results.filter(r=>r._st==="ready").length})</button>
          </div>
          {results.map((r,i) => (
            <div key={i} style={{padding:"12px 16px",borderBottom:"1px solid "+P.bd,background:r._st==="done"?"#E8F5E9":r._st==="error"?"#FFEBEE":i%2===0?P.wh:P.al}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <span style={{fontSize:11,color:P.tm}}>{r._file}</span>
                  <button onClick={()=>r._st==="ready"&&flipMode(i)} title="Κλικ για εναλλαγή AP/AR" style={{fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:10,color:"#fff",border:"none",cursor:r._st==="ready"?"pointer":"default",background:(r._mode||"AP")==="AR"?"#0277BD":"#00897B"}}>{(r._mode||"AP")==="AR"?"📤 AR":"📥 AP"}{r._st==="ready"?" ⇄":""}</button>
                  <span style={{fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:10,color:"#fff",background:r._st==="done"?P.gn:r._st==="error"?P.rd:r._st==="rejected"?P.rd:P.em}}>{r._st==="done"?"✓ APPROVED":r._st==="saving"?"⏳ SAVING…":r._st==="error"?"ERROR":r._st==="rejected"?"✗ REJECTED":"READY"}</span>
                  {r.afm&&<span style={{fontSize:10,color:P.tm}}>ΑΦΜ: {r.afm}</span>}
                </div>
                <div style={{display:"flex",gap:6}}>
                  {r._fileObj && <button onClick={()=>setPreview({url:URL.createObjectURL(r._fileObj),name:r._file,isPdf:(r._fileObj.type||"").includes("pdf")||(r._file||"").toLowerCase().endsWith(".pdf")})} style={{background:"none",border:"1px solid "+P.bd,padding:"3px 8px",borderRadius:4,cursor:"pointer",fontSize:10}}>👁 Preview</button>}
                  <button onClick={()=>setShowRaw(showRaw===i?null:i)} style={{background:"none",border:"1px solid "+P.bd,padding:"3px 8px",borderRadius:4,cursor:"pointer",fontSize:10}}>📋 Raw</button>
                  {r._st==="ready" && <button onClick={()=>approve(i)} style={{background:P.gn,color:"#fff",border:"none",padding:"4px 12px",borderRadius:4,cursor:"pointer",fontSize:12,fontWeight:600}}>✓ Approve</button>}
                  {r._st==="ready" && <button onClick={()=>setResults(p=>p.map((x,j)=>j===i?{...x,_st:"rejected"}:x))} style={{background:P.rd,color:"#fff",border:"none",padding:"4px 10px",borderRadius:4,cursor:"pointer",fontSize:12,fontWeight:600}}>✗ Reject</button>}
                  {r._st==="rejected" && <span style={{fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:10,color:"#fff",background:P.rd}}>✗ REJECTED</span>}
                  {r._st==="rejected" && <button onClick={()=>setResults(p=>p.map((x,j)=>j===i?{...x,_st:"ready"}:x))} style={{background:"none",border:"1px solid "+P.bd,padding:"3px 8px",borderRadius:4,cursor:"pointer",fontSize:10}}>↩ Undo</button>}
                </div>
              </div>
              <div style={{display:"flex",flexWrap:"wrap",gap:8,fontSize:12}}>
                <Inp l={(r._mode||"AP")==="AR"?"Client":"Supplier"} v={r.supplier_name||""} set={v=>upd(i,"supplier_name",v)} w={160} />
                <Inp l="Invoice #" v={r.invoice_number||""} set={v=>upd(i,"invoice_number",v)} w={90} />
                <Inp l="Date" v={r.invoice_date||""} set={v=>upd(i,"invoice_date",v)} w={90} />
                <Sel l="Month" v={(r.month||"").slice(0,7)} set={v=>upd(i,"month",v)} opts={MONTHS.map(m=>({v:m,l:ML[m]}))} w={100} />
                <Inp l="Net €" v={r.net_amount||0} set={v=>upd(i,"net_amount",parseFloat(v)||0)} w={80} t="number" />
                <Inp l="VAT €" v={r.vat_amount||0} set={v=>upd(i,"vat_amount",parseFloat(v)||0)} w={70} t="number" />
                <Inp l="Total €" v={r.total_amount||0} set={v=>upd(i,"total_amount",parseFloat(v)||0)} w={80} t="number" />
                {(r._mode||"AP")==="AR" ? (
                  <Sel l="Revenue Category" v={r.cost_category||REV_CATS[0]} set={v=>upd(i,"cost_category",v)} opts={REV_CATS.map(c=>({v:c,l:c}))} w={220} />
                ) : (
                  <>
                    <Sel l="Cost Cat" v={r.cost_category||COST_CATS[0]} set={v=>upd(i,"cost_category",v)} opts={COST_CATS.map(c=>({v:c,l:c}))} w={190} />
                    <Sel l="Service" v={r.service_category||"Other"} set={v=>upd(i,"service_category",v)} opts={SVC_CATS.map(c=>({v:c,l:c}))} w={160} />
                  </>
                )}
                <Inp l="Description" v={r.description||""} set={v=>upd(i,"description",v)} w={180} />
              </div>
              {showRaw===i && r._raw && (
                <div style={{marginTop:8,padding:10,background:"#f5f5f5",borderRadius:6,fontSize:10,fontFamily:"monospace",maxHeight:150,overflow:"auto",whiteSpace:"pre-wrap",color:P.tm}}>{r._raw}</div>
              )}
            </div>
          ))}
        </div>
      )}
      {preview && (
        <div onClick={()=>{ if(preview.url) URL.revokeObjectURL(preview.url); setPreview(null); }} style={{position:"fixed",inset:0,background:"rgba(0,0,0,.6)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div onClick={e=>e.stopPropagation()} style={{background:P.wh,borderRadius:10,width:"90%",maxWidth:900,height:"88vh",display:"flex",flexDirection:"column",overflow:"hidden",boxShadow:"0 20px 60px rgba(0,0,0,.3)"}}>
            <div style={{background:P.em,color:"#fff",padding:"10px 16px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <span style={{fontSize:13,fontWeight:700,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>👁 {preview.name}</span>
              <button onClick={()=>{ if(preview.url) URL.revokeObjectURL(preview.url); setPreview(null); }} style={{background:"rgba(255,255,255,.2)",border:"none",color:"#fff",padding:"5px 12px",borderRadius:6,cursor:"pointer",fontSize:14,fontWeight:700}}>✕</button>
            </div>
            <div style={{flex:1,overflow:"auto",background:"#525659",display:"flex",alignItems:"center",justifyContent:"center"}}>
              {preview.isPdf
                ? <iframe title="preview" src={preview.url} style={{width:"100%",height:"100%",border:"none"}} />
                : <img alt="preview" src={preview.url} style={{maxWidth:"100%",maxHeight:"100%"}} />}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PnL({inv,sub,lab,labAlloc}) {
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

function InvTab({data,set,contracts,year,client}) {
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
        {k:"docId",l:"File",mw:80,r:(v,row)=>row&&row.docId?(<span style={{whiteSpace:"nowrap"}}><a href="#" onClick={async e=>{e.preventDefault();try{window.open(await api.getFileLink(year,client,row.docId),"_blank");}catch{alert("Could not open file");}}} title="Preview" style={{textDecoration:"none",marginRight:8,fontSize:15}}>👁</a><a href="#" onClick={async e=>{e.preventDefault();try{window.location.assign(await api.getFileLink(year,client,row.docId,true));}catch{alert("Could not download file");}}} title="Download" style={{textDecoration:"none",fontSize:15}}>⬇</a></span>):<span style={{color:P.tm}}>—</span>}
      ]} data={data} del={id=>set(p=>p.filter(x=>x.id!==id))} onEdit={(id,k,v)=>set(p=>p.map(r=>r.id===id?{...r,[k]:v,total:k==="amt"||k==="vat"?(k==="amt"?parseFloat(v)||0:r.amt)+(k==="vat"?parseFloat(v)||0:r.vat):r.total}:r))} />
    </div>
  );
}

function SubTab({data,set,contracts,year,client}) {
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
        {k:"docId",l:"File",mw:80,r:(v,row)=>row&&row.docId?(<span style={{whiteSpace:"nowrap"}}><a href="#" onClick={async e=>{e.preventDefault();try{window.open(await api.getFileLink(year,client,row.docId),"_blank");}catch{alert("Could not open file");}}} title="Preview" style={{textDecoration:"none",marginRight:8,fontSize:15}}>👁</a><a href="#" onClick={async e=>{e.preventDefault();try{window.location.assign(await api.getFileLink(year,client,row.docId,true));}catch{alert("Could not download file");}}} title="Download" style={{textDecoration:"none",fontSize:15}}>⬇</a></span>):<span style={{color:P.tm}}>—</span>}
      ]} data={data} del={id=>set(p=>p.filter(x=>x.id!==id))} onEdit={edit} />
    </div>
  );
}

function AccTab({inv,sub}) {
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

function LabTab({data,set,alloc,setAlloc}) {
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

function POTracker({inv,contracts}) {
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

// Consolidated portfolio dashboard (finance/admin + ops for their own clients).
// Loads ALL clients' data for the year at once via getYearData — so totals are real,
// not just the clients visited this session.
function Dashboard({year,setYear,user,onBack,onLogout,onSelectClient}) {
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
    let rev=0,cost=0,lab=0;
    Object.values(data||{}).forEach(cd=>{
      (cd?.inv||[]).forEach(i=>{ if(i.month===m) rev+=Number(i.amt)||0; });
      (cd?.sub||[]).forEach(i=>{ if(i.month===m) cost+=Number(i.amt)||0; });
      if(cd?.lab?.[m]) lab+=Object.values(cd.lab[m]).reduce((s,v)=>s+(Number(v)||0),0);
    });
    return {m,rev,cost,lab,gm:rev-cost-lab};
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
          <button onClick={onBack} style={{background:"rgba(255,255,255,.2)",border:"none",color:"#fff",padding:"4px 12px",borderRadius:4,cursor:"pointer",fontSize:12}}>◀ Clients</button>
          <span style={{fontSize:14,fontWeight:600,borderLeft:"1px solid rgba(255,255,255,.3)",paddingLeft:12}}>📊 Portfolio Dashboard — {year}</span>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:10,fontSize:13}}>
          <span style={{opacity:.7}}>{user.name}</span>
          <button onClick={onLogout} style={{background:"rgba(255,255,255,.15)",border:"none",color:"#fff",padding:"5px 14px",borderRadius:4,cursor:"pointer",fontSize:12}}>Logout</button>
        </div>
      </div>

      <div style={{maxWidth:1300,margin:"0 auto",padding:"18px 24px"}}>
        <div style={{display:"flex",gap:8,marginBottom:16}}>
          {YEARS.map(y=>(<button key={y} onClick={()=>setYear(y)} style={{padding:"6px 16px",border:year===y?"2px solid "+P.em:"1px solid "+P.bd,borderRadius:6,cursor:"pointer",fontSize:13,fontWeight:year===y?700:400,background:year===y?P.em:P.wh,color:year===y?"#fff":P.tx}}>{y}</button>))}
        </div>

        {loading ? <div style={{padding:40,textAlign:"center",color:P.tm}}>Loading…</div> : (
        <>
          {/* KPIs */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(180px,1fr))",gap:12,marginBottom:20}}>
            {kpi("Total Revenue",totRev,P.gn)}
            {kpi("Total Cost (sub)",totCost,P.tx)}
            {kpi("Labour",totLab,P.tx)}
            {kpi("Gross Margin",totGM,totGM>=0?P.gn:P.rd)}
            {kpi("GM %",totRev?totGM/totRev:null,P.em,true)}
            <div style={{background:P.wh,border:"1px solid "+P.bd,borderRadius:10,padding:"14px 16px"}}>
              <div style={{fontSize:12,color:P.tm}}>Active clients</div>
              <div style={{fontSize:22,fontWeight:800,color:P.em,marginTop:5}}>{active.length}<span style={{fontSize:13,color:P.tm,fontWeight:400}}> / {rows.length}</span></div>
            </div>
          </div>

          <div style={{display:"grid",gridTemplateColumns:"2fr 1fr",gap:16,alignItems:"start"}}>
            {/* Monthly trend */}
            <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,padding:16}}>
              <div style={{fontSize:13,fontWeight:700,color:P.em,marginBottom:12}}>Μηνιαία τάση — Revenue / GM</div>
              <div style={{display:"flex",flexDirection:"column",gap:6}}>
                {monthly.map(x=>(
                  <div key={x.m} style={{display:"flex",alignItems:"center",gap:8,fontSize:11}}>
                    <span style={{width:44,color:P.tm,flexShrink:0}}>{ML[x.m]}</span>
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
                <span><span style={{display:"inline-block",width:10,height:10,background:P.ep,borderRadius:2,verticalAlign:"middle",marginRight:4}} />Revenue</span>
                <span><span style={{display:"inline-block",width:10,height:10,background:P.em,borderRadius:2,verticalAlign:"middle",marginRight:4}} />GM</span>
              </div>
            </div>

            {/* Completeness + pending */}
            <div style={{display:"flex",flexDirection:"column",gap:16}}>
              <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,padding:16}}>
                <div style={{fontSize:13,fontWeight:700,color:P.em,marginBottom:10}}>Πληρότητα αναφορών</div>
                {(()=>{ const ap=byStatus("approved"),su=byStatus("submitted"),rj=byStatus("rejected"),n=rows.length||1;
                  return (<>
                    <div style={{display:"flex",height:14,borderRadius:7,overflow:"hidden",marginBottom:10,background:"#ECEFF1"}}>
                      <div style={{width:(ap/n*100)+"%",background:"#2E7D32"}} title={`Approved ${ap}`} />
                      <div style={{width:(su/n*100)+"%",background:"#F57F17"}} title={`Submitted ${su}`} />
                      <div style={{width:(rj/n*100)+"%",background:"#C62828"}} title={`Rejected ${rj}`} />
                    </div>
                    {[["Approved",ap,"#2E7D32"],["Submitted (pending)",su,"#F57F17"],["Rejected",rj,"#C62828"],["Draft",byStatus("draft"),"#78909C"]].map(([l,v,c])=>(
                      <div key={l} style={{display:"flex",justifyContent:"space-between",fontSize:12,padding:"3px 0"}}><span style={{color:c,fontWeight:600}}>● {l}</span><span style={{fontWeight:700}}>{v}</span></div>
                    ))}
                  </>);
                })()}
              </div>
              <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,padding:16}}>
                <div style={{fontSize:13,fontWeight:700,color:"#F57F17",marginBottom:10}}>⏳ Εκκρεμούν έγκριση ({pending.length})</div>
                {pending.length? pending.slice(0,8).map(p=>(
                  <div key={p.name} onClick={()=>onSelectClient&&onSelectClient(p.name)} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"5px 0",borderBottom:"1px solid "+P.bd,cursor:"pointer",fontSize:12}}>
                    <span style={{fontWeight:600,color:P.em}}>{p.name}</span><span style={{color:P.gn}}>€{fmt(p.rev)}</span>
                  </div>
                )) : <div style={{fontSize:12,color:P.tm,fontStyle:"italic"}}>Καμία εκκρεμότητα 🎉</div>}
              </div>
            </div>
          </div>

          {/* Top clients by GM */}
          <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,padding:16,marginTop:16}}>
            <div style={{fontSize:13,fontWeight:700,color:P.em,marginBottom:10}}>Top πελάτες κατά GM</div>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
              <thead><tr>{["#","Πελάτης","Revenue €","Cost €","Labour €","GM €","GM%","Status"].map((h,i)=>(<th key={i} style={{padding:"6px 10px",fontSize:11,fontWeight:700,color:"#fff",background:P.em,textAlign:i>=2&&i<=6?"right":"left"}}>{h}</th>))}</tr></thead>
              <tbody>{topGM.map((r,i)=>{ const s=st(r.status); return (
                <tr key={r.name} onClick={()=>onSelectClient&&onSelectClient(r.name)} style={{background:i%2===0?P.wh:P.al,cursor:"pointer"}}>
                  <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,color:P.tm}}>{i+1}</td>
                  <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,fontWeight:600,color:P.em}}>{r.name}</td>
                  <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,textAlign:"right",color:P.gn}}>{fmt(r.rev)}</td>
                  <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,textAlign:"right"}}>{fmt(r.cost)}</td>
                  <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,textAlign:"right"}}>{fmt(r.labour)}</td>
                  <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,textAlign:"right",fontWeight:600,color:r.gm>=0?P.em:P.rd}}>{fmt(r.gm)}</td>
                  <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd,textAlign:"right",color:P.tm}}>{r.rev?fPct(r.gm/r.rev):"-"}</td>
                  <td style={{padding:"6px 10px",borderBottom:"1px solid "+P.bd}}><span style={{padding:"2px 8px",borderRadius:10,fontSize:10,fontWeight:700,background:s.bg,color:s.color}}>{s.l}</span></td>
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

// Company-wide OPEX / CAPEX (finance + admin). Separate from client P&L. One blob per FY.
function OpexCapex({year,setYear,user,onBack,onLogout}) {
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
  const deprRows = capexItems.map(it=>({it, d:depreciation(it,MONTHS)}));
  const totCapex = capexItems.reduce((s,i)=>s+(Number(i.amount)||0),0);
  const totDeprFY = deprRows.reduce((s,x)=>s+MONTHS.reduce((s2,m)=>s2+x.d.perMonth[m],0),0);
  const totNBV = deprRows.reduce((s,x)=>s+x.d.nbv,0);
  const totBudget = opexGrand("budget"), totActual = opexGrand("actual");

  const thS = {padding:"6px 8px",textAlign:"center",fontSize:10,fontWeight:700,color:"#fff",background:P.em,whiteSpace:"nowrap"};
  const inpS = {width:"100%",padding:"4px 5px",border:"1px solid "+P.bd,borderRadius:3,fontSize:11,textAlign:"right",background:P.ip,outline:"none",boxSizing:"border-box"};
  const saveLbl = saveState==="saving"?"💾 Saving…":saveState==="saved"?"✓ Saved":saveState==="error"?"⚠ Save failed":"";

  return (
    <div style={{minHeight:"100vh",background:P.of,fontFamily:"Segoe UI,Tahoma,sans-serif"}}>
      <div style={{background:P.em,color:"#fff",padding:"14px 24px",display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:8}}>
        <div style={{display:"flex",alignItems:"center",gap:16}}>
          <span style={{fontWeight:800,fontSize:20,letterSpacing:1}}>CBRE</span>
          <button onClick={onBack} style={{background:"rgba(255,255,255,.2)",border:"none",color:"#fff",padding:"4px 12px",borderRadius:4,cursor:"pointer",fontSize:12}}>◀ Clients</button>
          <span style={{fontSize:14,fontWeight:600,borderLeft:"1px solid rgba(255,255,255,.3)",paddingLeft:12}}>💰 OPEX / CAPEX — Company ({year})</span>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:10,fontSize:13}}>
          <span style={{fontSize:11,opacity:.9,minWidth:78,textAlign:"right"}}>{saveLbl}</span>
          <span style={{opacity:.7}}>{user.name}</span>
          <button onClick={onLogout} style={{background:"rgba(255,255,255,.15)",border:"none",color:"#fff",padding:"5px 14px",borderRadius:4,cursor:"pointer",fontSize:12}}>Logout</button>
        </div>
      </div>

      <div style={{maxWidth:1400,margin:"0 auto",padding:"18px 24px"}}>
        {/* Year + sub-tabs */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,flexWrap:"wrap",gap:12}}>
          <div style={{display:"flex",gap:8}}>
            {YEARS.map(y=>(<button key={y} onClick={()=>setYear(y)} style={{padding:"6px 16px",border:year===y?"2px solid "+P.em:"1px solid "+P.bd,borderRadius:6,cursor:"pointer",fontSize:13,fontWeight:year===y?700:400,background:year===y?P.em:P.wh,color:year===y?"#fff":P.tx}}>{y}</button>))}
          </div>
          <div style={{display:"flex",gap:0,background:P.wh,borderRadius:8,border:"1px solid "+P.bd,padding:4}}>
            {[{v:"opex",l:"OPEX"},{v:"capex",l:"CAPEX"},{v:"summary",l:"Summary"}].map(t=>(
              <button key={t.v} onClick={()=>setSub(t.v)} style={{background:sub===t.v?P.em:"transparent",color:sub===t.v?"#fff":P.tx,border:"none",padding:"7px 20px",borderRadius:6,cursor:"pointer",fontSize:13,fontWeight:600}}>{t.l}</button>
            ))}
          </div>
        </div>

        {!loaded && <div style={{padding:40,textAlign:"center",color:P.tm}}>Loading…</div>}

        {/* ── OPEX ── */}
        {loaded && sub==="opex" && (
          <div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10,flexWrap:"wrap",gap:10}}>
              <div style={{display:"flex",gap:0,background:P.wh,borderRadius:8,border:"1px solid "+P.bd,padding:3}}>
                {[{v:"actual",l:"Actual"},{v:"budget",l:"Budget"},{v:"variance",l:"Variance"}].map(t=>(
                  <button key={t.v} onClick={()=>setOpexView(t.v)} style={{background:opexView===t.v?"#00897B":"transparent",color:opexView===t.v?"#fff":P.tx,border:"none",padding:"6px 16px",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:600}}>{t.l}</button>
                ))}
              </div>
              <div style={{display:"flex",gap:8,alignItems:"center"}}>
                <input value={newCat} onChange={e=>setNewCat(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addCat()} placeholder="Νέα κατηγορία…" style={{padding:"6px 10px",border:"1px solid "+P.bd,borderRadius:6,fontSize:12,outline:"none"}} />
                <button onClick={addCat} style={{background:P.em,color:"#fff",border:"none",padding:"6px 14px",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:600}}>+ Κατηγορία</button>
              </div>
            </div>
            <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,overflowX:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse",tableLayout:"fixed",minWidth:1150}}>
                <colgroup><col style={{width:170}} />{MONTHS.map(m=><col key={m} style={{width:72}} />)}<col style={{width:95}} /><col style={{width:34}} /></colgroup>
                <thead><tr>
                  <th style={{...thS,textAlign:"left",borderRight:"2px solid #00695C"}}>Κατηγορία</th>
                  {MONTHS.map(m=><th key={m} style={thS}>{ML[m]}</th>)}
                  <th style={{...thS,background:"#00695C"}}>Total</th><th style={thS}></th>
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
                    <td style={{padding:"8px 8px",fontSize:12,fontWeight:700,borderRight:"2px solid #00695C"}}>ΣΥΝΟΛΟ {opexView==="variance"?"(Act−Bud)":opexView}</td>
                    {MONTHS.map(m=>{ const v=opexView==="variance"?(opexColTotal("actual",m)-opexColTotal("budget",m)):opexColTotal(opexView,m); return <td key={m} style={{padding:"6px 6px",textAlign:"right",fontSize:11,fontWeight:700,color:opexView==="variance"&&v>0?P.rd:P.em}}>{fmt(v)}</td>; })}
                    <td style={{padding:"6px 8px",textAlign:"right",fontSize:12,fontWeight:700,color:P.em,background:"#C8E6C9",borderLeft:"2px solid #00695C"}}>{fmt(opexView==="variance"?(totActual-totBudget):opexGrand(opexView))}</td>
                    <td style={{background:P.ep}}></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div style={{fontSize:11,color:P.tm,marginTop:8}}>Variance = Actual − Budget (κόκκινο = υπέρβαση). Οι αλλαγές αποθηκεύονται αυτόματα.</div>
          </div>
        )}

        {/* ── CAPEX ── */}
        {loaded && sub==="capex" && (
          <div>
            <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,padding:14,marginBottom:16,display:"flex",flexWrap:"wrap",gap:8,alignItems:"end"}}>
              <Inp l="Περιγραφή" v={cf.desc} set={v=>setCf(x=>({...x,desc:v}))} w={180} />
              <Sel l="Κατηγορία" v={cf.cat} set={v=>setCf(x=>({...x,cat:v}))} opts={CAPEX_CATS.map(c=>({v:c,l:c}))} w={160} />
              <Inp l="Αξία €" v={cf.amount} set={v=>setCf(x=>({...x,amount:v}))} w={100} t="number" />
              <Sel l="Μήνας κτήσης" v={cf.month} set={v=>setCf(x=>({...x,month:v}))} opts={MONTHS.map(m=>({v:m,l:ML[m]}))} w={110} />
              <Inp l="Ωφ. ζωή (μήνες)" v={cf.life} set={v=>setCf(x=>({...x,life:v}))} w={110} t="number" />
              <Sel l="Status" v={cf.status} set={v=>setCf(x=>({...x,status:v}))} opts={CAPEX_STATUS.map(s=>({v:s.v,l:s.v}))} w={120} />
              <Inp l="PO No" v={cf.po} set={v=>setCf(x=>({...x,po:v}))} w={90} />
              <button onClick={addCapex} style={{background:P.em,color:"#fff",border:"none",padding:"7px 18px",borderRadius:6,cursor:"pointer",fontSize:13,fontWeight:600}}>+ Πάγιο</button>
            </div>
            <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,overflowX:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:12,minWidth:1000}}>
                <thead><tr>{["Περιγραφή","Κατηγορία","Αξία €","Κτήση","Ωφ.ζωή","Μην. απόσβ.","Σωρευ. απόσβ.","NBV €","Status","PO",""].map((h,i)=>(
                  <th key={i} style={{padding:"8px 10px",fontSize:11,fontWeight:700,color:"#fff",background:P.em,textAlign:["Αξία €","Μην. απόσβ.","Σωρευ. απόσβ.","NBV €"].includes(h)?"right":"left"}}>{h}</th>
                ))}</tr></thead>
                <tbody>
                  {deprRows.map(({it,d},i)=>(
                    <tr key={it.id} style={{background:i%2===0?P.wh:P.al}}>
                      <td style={{padding:"5px 8px",borderBottom:"1px solid "+P.bd}}><input value={it.desc} onChange={e=>editCapex(it.id,"desc",e.target.value)} style={{width:"100%",border:"none",background:"transparent",fontSize:12,outline:"none"}} /></td>
                      <td style={{padding:"5px 8px",borderBottom:"1px solid "+P.bd,color:P.tm}}>{it.cat}</td>
                      <td style={{padding:"3px 6px",borderBottom:"1px solid "+P.bd,textAlign:"right"}}><input type="number" value={it.amount} onChange={e=>editCapex(it.id,"amount",e.target.value)} style={{...inpS,width:90}} /></td>
                      <td style={{padding:"5px 8px",borderBottom:"1px solid "+P.bd}}>{ML[it.month]||it.month}</td>
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
                  {!capexItems.length && <tr><td colSpan={11} style={{padding:24,textAlign:"center",color:P.tm,fontStyle:"italic"}}>Κανένα πάγιο ακόμη — πρόσθεσε από πάνω</td></tr>}
                  {capexItems.length>0 && (
                    <tr style={{background:P.ep}}>
                      <td colSpan={2} style={{padding:"8px 10px",fontWeight:700}}>ΣΥΝΟΛΑ</td>
                      <td style={{padding:"8px 8px",textAlign:"right",fontWeight:700,color:P.em}}>{fmt(totCapex)}</td>
                      <td colSpan={2}></td>
                      <td style={{padding:"8px 8px",textAlign:"right",fontWeight:700,color:P.tm}} title="Συνολική απόσβεση εντός FY">{fmt(totDeprFY)}</td>
                      <td></td>
                      <td style={{padding:"8px 8px",textAlign:"right",fontWeight:700,color:P.em}}>{fmt(totNBV)}</td>
                      <td colSpan={3}></td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div style={{fontSize:11,color:P.tm,marginTop:8}}>Απόσβεση: σταθερή (straight-line) = Αξία ÷ ωφέλιμη ζωή. «Σωρευ. απόσβ.» & «NBV» υπολογίζονται μέχρι το τέλος του {year}.</div>
          </div>
        )}

        {/* ── SUMMARY ── */}
        {loaded && sub==="summary" && (
          <div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(210px,1fr))",gap:14,marginBottom:20}}>
              {[
                {l:"OPEX Budget",v:totBudget,c:P.em},
                {l:"OPEX Actual",v:totActual,c:P.tx},
                {l:"OPEX Variance",v:totActual-totBudget,c:(totActual-totBudget)>0?P.rd:P.gn,sign:true},
                {l:"CAPEX Investment",v:totCapex,c:P.em},
                {l:"Απόσβεση "+year,v:totDeprFY,c:"#F57F17"},
                {l:"Net Book Value",v:totNBV,c:P.gn},
              ].map(k=>(
                <div key={k.l} style={{background:P.wh,border:"1px solid "+P.bd,borderRadius:10,padding:"16px 18px",boxShadow:"0 1px 2px rgba(0,0,0,.04)"}}>
                  <div style={{fontSize:12,color:P.tm}}>{k.l}</div>
                  <div style={{fontSize:24,fontWeight:800,color:k.c,marginTop:6}}>€{fmt(k.v)}</div>
                </div>
              ))}
            </div>
            <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,padding:16}}>
              <div style={{fontSize:13,fontWeight:700,color:P.em,marginBottom:10}}>OPEX — Budget vs Actual ανά κατηγορία ({year})</div>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                <thead><tr>{["Κατηγορία","Budget €","Actual €","Variance €","%"].map((h,i)=>(<th key={i} style={{padding:"7px 10px",fontSize:11,fontWeight:700,color:"#fff",background:P.em,textAlign:i===0?"left":"right"}}>{h}</th>))}</tr></thead>
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
                    <td style={{padding:"8px 10px"}}>ΣΥΝΟΛΟ</td>
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

// Admin-only console: user management + audit log. Backend endpoints already existed
// (/api/users, /api/audit) but had no UI — an admin could not manage users in-app.
function AdminPanel({me,onClose}) {
  const [tab,setTab] = useState("users");
  const [users,setUsers] = useState([]);
  const [logs,setLogs] = useState([]);
  const [err,setErr] = useState("");
  const [busy,setBusy] = useState(false);
  const [nf,setNf] = useState({username:"",name:"",email:"",role:"ops",password:"",clients:""});

  const loadUsers = () => api.listUsers().then(setUsers).catch(e=>setErr(e.message||"Load failed"));
  const loadLogs = () => api.audit().then(setLogs).catch(e=>setErr(e.message||"Load failed"));
  useEffect(()=>{ loadUsers(); loadLogs(); },[]);

  const create = async () => {
    setErr("");
    if(!nf.username||!nf.name||!nf.password){ setErr("Συμπλήρωσε username, όνομα και κωδικό"); return; }
    if(nf.password.length<8){ setErr("Ο κωδικός πρέπει να έχει 8+ χαρακτήρες"); return; }
    const clients = nf.role==="ops"
      ? nf.clients.split(",").map(s=>s.trim()).filter(Boolean)
      : "ALL";
    setBusy(true);
    try {
      await api.createUser({username:nf.username.trim().toLowerCase(),name:nf.name.trim(),email:nf.email.trim(),role:nf.role,password:nf.password,clients});
      setNf({username:"",name:"",email:"",role:"ops",password:"",clients:""});
      await loadUsers(); await loadLogs();
    } catch(e){ setErr(e.message||"Δημιουργία απέτυχε"); }
    finally{ setBusy(false); }
  };
  const del = async (u) => {
    if(u.username===me.username){ setErr("Δεν μπορείς να διαγράψεις τον εαυτό σου"); return; }
    if(!confirm(`Διαγραφή χρήστη "${u.username}";`)) return;
    setBusy(true);
    try { await api.deleteUser(u.id); await loadUsers(); await loadLogs(); }
    catch(e){ setErr(e.message||"Διαγραφή απέτυχε"); }
    finally{ setBusy(false); }
  };
  const resetPw = async (u) => {
    setErr("");
    const p = prompt(`Νέος προσωρινός κωδικός για "${u.username}" (8+ χαρακτήρες).\nΆφησέ το ΚΕΝΟ για αυτόματο.`, "");
    if(p===null) return;
    if(p && p.length<8){ setErr("Ο κωδικός πρέπει να έχει 8+ χαρακτήρες"); return; }
    setBusy(true);
    try {
      const r = await api.resetUserPassword(u.id, p||undefined);
      await loadLogs();
      alert(`✓ Ο κωδικός του "${r.username}" έγινε reset.\n\nΠροσωρινός κωδικός:\n\n    ${r.tempPassword}\n\nΔώσ' τον στον χρήστη — θα του ζητηθεί να τον αλλάξει στην πρώτη είσοδο. Οι υπάρχουσες συνεδρίες του ακυρώθηκαν.`);
    } catch(e){ setErr(e.message||"Reset κωδικού απέτυχε"); }
    finally{ setBusy(false); }
  };
  const editEmail = async (u) => {
    setErr("");
    const email = prompt(`Email του "${u.username}" (για επαναφορά κωδικού):`, u.email||"");
    if(email===null) return;
    setBusy(true);
    try { await api.updateUser(u.id, {email:email.trim()}); await loadUsers(); await loadLogs(); }
    catch(e){ setErr(e.message||"Ενημέρωση email απέτυχε"); }
    finally{ setBusy(false); }
  };

  const roleBadge = {admin:"#003F2D",finance:"#00695C",ops:"#0277BD"};
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.5)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:20}} onClick={onClose}>
      <div style={{background:P.wh,borderRadius:12,width:"95%",maxWidth:960,maxHeight:"90vh",overflow:"auto",boxShadow:"0 20px 60px rgba(0,0,0,.3)"}} onClick={e=>e.stopPropagation()}>
        <div style={{background:P.em,color:"#fff",padding:"16px 24px",borderRadius:"12px 12px 0 0",display:"flex",justifyContent:"space-between",alignItems:"center",position:"sticky",top:0,zIndex:1}}>
          <div style={{fontWeight:700,fontSize:16}}>⚙️ Admin — Διαχείριση</div>
          <button onClick={onClose} style={{background:"rgba(255,255,255,.2)",border:"none",color:"#fff",padding:"6px 14px",borderRadius:6,cursor:"pointer",fontSize:14,fontWeight:700}}>✕</button>
        </div>
        <div style={{display:"flex",gap:0,padding:"0 24px",borderBottom:"1px solid "+P.bd,background:P.of}}>
          {[{v:"users",l:"👥 Χρήστες"},{v:"audit",l:"📜 Audit Log"}].map(t=>(
            <button key={t.v} onClick={()=>setTab(t.v)} style={{padding:"12px 18px",fontSize:13,background:"none",border:"none",borderBottom:tab===t.v?"3px solid "+P.em:"3px solid transparent",fontWeight:tab===t.v?700:400,color:tab===t.v?P.em:P.tm,cursor:"pointer"}}>{t.l}</button>
          ))}
        </div>
        <div style={{padding:20}}>
          {err && <div style={{color:P.rd,fontSize:12,marginBottom:12,padding:"8px 12px",background:"#FFEBEE",borderRadius:6}}>{err}</div>}

          {tab==="users" && (
            <>
              <div style={{background:P.of,border:"1px solid "+P.bd,borderRadius:8,padding:14,marginBottom:16,display:"flex",flexWrap:"wrap",gap:8,alignItems:"end"}}>
                <Inp l="Username" v={nf.username} set={v=>setNf(x=>({...x,username:v}))} w={120} />
                <Inp l="Όνομα" v={nf.name} set={v=>setNf(x=>({...x,name:v}))} w={120} />
                <Inp l="Email (για reset)" v={nf.email} set={v=>setNf(x=>({...x,email:v}))} w={170} />
                <Sel l="Ρόλος" v={nf.role} set={v=>setNf(x=>({...x,role:v}))} opts={[{v:"ops",l:"ops"},{v:"finance",l:"finance"},{v:"admin",l:"admin"}]} w={100} />
                <Inp l="Κωδικός (8+)" v={nf.password} set={v=>setNf(x=>({...x,password:v}))} w={130} />
                {nf.role==="ops" && <Inp l="Clients (χωρισμένα με κόμμα)" v={nf.clients} set={v=>setNf(x=>({...x,clients:v}))} w={260} />}
                {nf.role!=="ops" && <div style={{fontSize:11,color:P.tm,alignSelf:"center",padding:"0 6px"}}>Πρόσβαση: ΟΛΟΙ οι πελάτες</div>}
                <button onClick={create} disabled={busy} style={{background:P.em,color:"#fff",border:"none",padding:"7px 18px",borderRadius:6,cursor:busy?"wait":"pointer",fontSize:13,fontWeight:600,opacity:busy?.6:1}}>+ Νέος χρήστης</button>
              </div>
              <div style={{overflowX:"auto",border:"1px solid "+P.bd,borderRadius:8}}>
                <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
                  <thead><tr>{["Username","Όνομα","Email","Ρόλος","Πρόσβαση","",].map((h,i)=>(
                    <th key={i} style={{padding:"8px 12px",fontSize:11,fontWeight:700,color:"#fff",background:P.em,textAlign:"left"}}>{h}</th>
                  ))}</tr></thead>
                  <tbody>{users.map((u,i)=>(
                    <tr key={u.id} style={{background:i%2===0?P.wh:P.al}}>
                      <td style={{padding:"8px 12px",borderBottom:"1px solid "+P.bd,fontWeight:600,color:P.em}}>{u.username}{u.username===me.username&&<span style={{fontSize:10,color:P.tm}}> (εσύ)</span>}</td>
                      <td style={{padding:"8px 12px",borderBottom:"1px solid "+P.bd}}>{u.name}</td>
                      <td style={{padding:"8px 12px",borderBottom:"1px solid "+P.bd,fontSize:12}}>
                        <span style={{color:u.email?P.tx:P.tm}}>{u.email||"— χωρίς —"}</span>
                        <button onClick={()=>editEmail(u)} title="Επεξεργασία email" style={{background:"none",border:"none",color:P.em,cursor:"pointer",fontSize:12,marginLeft:6,padding:0}}>✎</button>
                      </td>
                      <td style={{padding:"8px 12px",borderBottom:"1px solid "+P.bd}}><span style={{padding:"2px 10px",borderRadius:10,fontSize:11,fontWeight:700,color:"#fff",background:roleBadge[u.role]||P.tm}}>{u.role}</span></td>
                      <td style={{padding:"8px 12px",borderBottom:"1px solid "+P.bd,color:P.tm,fontSize:12}}>{u.clients==="ALL"?"ΟΛΟΙ":(Array.isArray(u.clients)?`${u.clients.length} πελάτες`:"—")}</td>
                      <td style={{padding:"8px 12px",borderBottom:"1px solid "+P.bd,textAlign:"right",whiteSpace:"nowrap"}}>
                        <button onClick={()=>resetPw(u)} style={{background:P.ep,color:P.em,border:"none",padding:"4px 12px",borderRadius:4,fontSize:12,fontWeight:600,cursor:"pointer",marginRight:6}}>Reset κωδικού</button>
                        {u.username!==me.username&&<button onClick={()=>del(u)} style={{background:"#FFEBEE",color:P.rd,border:"none",padding:"4px 12px",borderRadius:4,fontSize:12,fontWeight:600,cursor:"pointer"}}>Διαγραφή</button>}
                      </td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
              <div style={{fontSize:11,color:P.tm,marginTop:8}}>Οι νέοι χρήστες μπαίνουν με τον κωδικό που όρισες — δεν επιβάλλεται αλλαγή κατά την πρώτη είσοδο (σε αντίθεση με τους seeded).</div>
            </>
          )}

          {tab==="audit" && (
            <div style={{overflowX:"auto",border:"1px solid "+P.bd,borderRadius:8}}>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                <thead><tr>{["Ημ/νία & ώρα","Χρήστης","Ενέργεια","Στόχος","IP"].map(h=>(
                  <th key={h} style={{padding:"8px 12px",fontSize:11,fontWeight:700,color:"#fff",background:P.em,textAlign:"left"}}>{h}</th>
                ))}</tr></thead>
                <tbody>{logs.map((l,i)=>(
                  <tr key={l.id||i} style={{background:i%2===0?P.wh:P.al}}>
                    <td style={{padding:"6px 12px",borderBottom:"1px solid "+P.bd,whiteSpace:"nowrap"}}>{new Date((l.timestamp||0)*1000).toLocaleString("el-GR")}</td>
                    <td style={{padding:"6px 12px",borderBottom:"1px solid "+P.bd,fontWeight:600}}>{l.user}</td>
                    <td style={{padding:"6px 12px",borderBottom:"1px solid "+P.bd}}><span style={{color:(l.action||"").includes("fail")?P.rd:(l.action||"").includes("success")?P.gn:P.tx}}>{l.action}</span></td>
                    <td style={{padding:"6px 12px",borderBottom:"1px solid "+P.bd,color:P.tm}}>{l.target||"—"}</td>
                    <td style={{padding:"6px 12px",borderBottom:"1px solid "+P.bd,color:P.tm,fontFamily:"monospace",fontSize:11}}>{l.ip||"—"}</td>
                  </tr>
                ))}</tbody>
              </table>
              {logs.length===0 && <div style={{padding:20,textAlign:"center",color:P.tm,fontStyle:"italic"}}>Καμία εγγραφή</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Inp({l,v,set,w,t="text"}) {
  // Use text input for numbers to avoid browser spinner arrows
  const isNum = t === "number";
  return (
    <div style={{display:"flex",flexDirection:"column",gap:3,width:w}}>
      <label style={{fontSize:10,color:P.tm,fontWeight:600}}>{l}</label>
      <input
        type="text"
        inputMode={isNum?"decimal":"text"}
        value={v}
        onChange={e=>set(e.target.value)}
        onBlur={isNum?e=>{const n=parseFloat(String(e.target.value).replace(",","."));if(!isNaN(n))set(n);}:undefined}
        style={{padding:"5px 7px",border:"1px solid "+P.bd,borderRadius:4,fontSize:12,background:P.ip,outline:"none",textAlign:isNum?"right":"left"}}
      />
    </div>
  );
}
function Sel({l,v,set,opts,w}) {
  return (
    <div style={{display:"flex",flexDirection:"column",gap:3,width:w}}>
      <label style={{fontSize:10,color:P.tm,fontWeight:600}}>{l}</label>
      <select value={v} onChange={e=>set(e.target.value)} style={{padding:"5px 7px",border:"1px solid "+P.bd,borderRadius:4,fontSize:12,background:P.ip,outline:"none"}}>{opts.map(o=><option key={o.v} value={o.v}>{o.l}</option>)}</select>
    </div>
  );
}
function Tbl({cols,data,del,onEdit}) {
  const [fl,sF] = useState("");
  const [sel,setSel] = useState(new Set());
  const [anchor,setAnchor] = useState(null);
  const [dragging,setDragging] = useState(false);
  const rows = data.filter(r => !fl || cols.some(c => String(r[c.k]||"").toLowerCase().includes(fl.toLowerCase())));
  const cs = {padding:"5px 6px",border:"1px solid "+P.bd,borderRadius:3,fontSize:11,background:P.ip,outline:"none",width:"100%",boxSizing:"border-box"};
  const up = (id,k,v) => { if(onEdit) onEdit(id,k,v); };
  const ck = (ri,ci) => ri+":"+ci;
  const gv = (ri,ci) => { const r=rows[ri]; const c=cols[ci]; return r&&c?r[c.k]:null; };
  const md = (ri,ci,e) => { if(e.shiftKey&&anchor){const[ar,ac]=anchor;const s=new Set();for(let r=Math.min(ar,ri);r<=Math.max(ar,ri);r++) for(let c=Math.min(ac,ci);c<=Math.max(ac,ci);c++) s.add(ck(r,c));setSel(s);}else{setAnchor([ri,ci]);setSel(new Set([ck(ri,ci)]));setDragging(true);}};
  const me = (ri,ci) => { if(!dragging||!anchor)return;const[ar,ac]=anchor;const s=new Set();for(let r=Math.min(ar,ri);r<=Math.max(ar,ri);r++) for(let c=Math.min(ac,ci);c<=Math.max(ac,ci);c++) s.add(ck(r,c));setSel(s);};
  const mu = () => setDragging(false);
  const vals=[];sel.forEach(k=>{const[ri,ci]=k.split(":").map(Number);const v=gv(ri,ci);if(typeof v==="number"&&!isNaN(v))vals.push(v);});
  const sum=vals.reduce((s,v)=>s+v,0);const avg=vals.length?sum/vals.length:0;
  return (
    <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,overflow:"hidden"}} onMouseUp={mu} onMouseLeave={mu}>
      <div style={{padding:"8px 12px",borderBottom:"1px solid "+P.bd,display:"flex",alignItems:"center",gap:12}}>
        <input placeholder="Filter..." value={fl} onChange={e=>sF(e.target.value)} style={{padding:"5px 8px",border:"1px solid "+P.bd,borderRadius:4,fontSize:12,outline:"none",width:180}} />
        <span style={{fontSize:11,color:P.tm}}>{rows.length} rows</span>
        {sel.size>1&&<button onClick={()=>setSel(new Set())} style={{background:"none",border:"none",color:P.tm,cursor:"pointer",fontSize:11,textDecoration:"underline"}}>Clear</button>}
      </div>
      <div style={{overflowX:"auto",userSelect:"none"}}>
        <table style={{width:"100%",borderCollapse:"collapse"}}>
          <thead><tr>{cols.map(c=><th key={c.k} style={{padding:"7px 10px",fontSize:11,fontWeight:700,color:"#fff",background:P.em,textAlign:c.a||"left",whiteSpace:"nowrap",position:"sticky",top:0,zIndex:2}}>{c.l}</th>)}<th style={{padding:7,fontSize:11,color:"#fff",background:P.em,width:30,position:"sticky",top:0,zIndex:2}}></th></tr></thead>
          <tbody>{rows.map((r,ri)=><tr key={r.id||ri}>{cols.map((c,ci)=>{const v=r[c.k];const isSel=sel.has(ck(ri,ci));const bg=isSel?"#E3F2FD":ri%2===0?P.wh:P.al;const bd=isSel?"2px solid #1565C0":"1px solid "+P.bd;const td={padding:"4px 6px",fontSize:12,border:bd,background:bg,textAlign:c.a||"left",minWidth:c.mw||undefined,cursor:"cell"};const h={onMouseDown:e=>md(ri,ci,e),onMouseEnter:()=>me(ri,ci)};
            if(c.opts&&onEdit) return <td key={c.k} style={td} {...h}><select value={v||""} onChange={e=>up(r.id,c.k,e.target.value)} style={{...cs,textAlign:"left"}}>{c.opts.map(o=><option key={o.v} value={o.v}>{o.l}</option>)}</select></td>;
            if(c.edit&&onEdit) return <td key={c.k} style={td} {...h}><input type="text" inputMode={c.t==="number"?"decimal":"text"} value={v??""} onChange={e=>up(r.id,c.k,c.t==="number"?e.target.value:e.target.value)} onBlur={c.t==="number"?e=>{const n=parseFloat(String(e.target.value).replace(",","."));up(r.id,c.k,isNaN(n)?0:n);}:undefined} style={{...cs,textAlign:c.a||"left"}} /></td>;
            return <td key={c.k} style={{...td,padding:"5px 10px"}} {...h}>{c.r?c.r(v,r):String(v??"")}</td>;
          })}<td style={{padding:4,textAlign:"center",border:"1px solid "+P.bd,background:ri%2===0?P.wh:P.al}}><button onClick={()=>del(r.id)} style={{background:"none",border:"none",color:P.rd,cursor:"pointer",fontSize:15}}>×</button></td></tr>)}</tbody>
        </table>
      </div>
      <div style={{background:"#263238",color:"#fff",padding:"6px 16px",display:"flex",gap:20,fontSize:12,fontFamily:"'Consolas','Courier New',monospace",minHeight:28,alignItems:"center"}}>
        {vals.length>0?(<>
          <span style={{color:"#80CBC4"}}>Cells: <b>{sel.size}</b></span>
          <span style={{color:"#B2DFDB"}}>Count: <b>{vals.length}</b></span>
          <span style={{color:"#A5D6A7"}}>Sum: <b>{fmt(sum)}</b></span>
          <span style={{color:"#C5E1A5"}}>Avg: <b>{fmt(avg)}</b></span>
          <span style={{color:"#FFCC80"}}>Min: <b>{fmt(Math.min(...vals))}</b></span>
          <span style={{color:"#EF9A9A"}}>Max: <b>{fmt(Math.max(...vals))}</b></span>
        </>):(<span style={{color:"#78909C"}}>Click or drag cells to select — Shift+click for range — numeric cells show Sum / Avg / Min / Max</span>)}
      </div>
    </div>
  );
}

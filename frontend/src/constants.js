// Shared constants, domain data, palette, and small pure helpers — extracted from App.jsx
// so components can be split into their own files. No React/DOM here (except uid's crypto guard).
import { daysUntil } from "./calc.js";

// Stable unique id with a fallback for non-secure contexts (crypto.randomUUID is
// undefined over plain http, e.g. http://<LAN-ip>:3300 — would otherwise throw).
export const uid = () => (typeof crypto !== "undefined" && crypto.randomUUID)
  ? crypto.randomUUID()
  : "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);

export const CLIENTS = [
  "FedEx","Foundever","Bloomberg","LNW Hellas","Lenovo","Minerva SA","Dacia",
  "Pfizer","Mondelez","Kenvue","IBM","Iron Mountain","Ericsson","Coca-Cola",
  "Novartis","Citibank","Sanofi","GSK","Google","Philips","JPMorgan","Gilead",
  "Tetra Pak","Dell","Worldline","Bank of America","Sandoz","BP Hellas","GE",
  "Goldman Sachs","Broadcom","Uber","Medtronic","Henkel","Opella","Kyndryl","Syngenta",
];

// Company logos via Clearbit (falls back to Google favicon, then to colored initials on error).
export const LOGOS = {
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
export const logoUrl = (c) => LOGOS[c] ? `https://logo.clearbit.com/${LOGOS[c]}` : null;
export const logoUrl2 = (c) => LOGOS[c] ? `https://www.google.com/s2/favicons?domain=${LOGOS[c]}&sz=128` : null;

export const REPORT_STATUS = [{v:"draft",l:"Draft",color:"#78909C",bg:"#ECEFF1"},{v:"submitted",l:"Submitted by User",color:"#F57F17",bg:"#FFF8E1"},{v:"approved",l:"Approved by Finance",color:"#2E7D32",bg:"#E8F5E9"},{v:"rejected",l:"Rejected — Revise",color:"#C62828",bg:"#FFEBEE"}];

// ── Fiscal months are DERIVED from the selected FY (no more hardcoded year) ──
// MONTHS/ML keep stable references (mutated in place) so every component sees the active FY.
const MNAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const fyToMonths = (fy) => {
  const yy = 2000 + (parseInt(String(fy).replace(/\D/g, ""), 10) || 26);
  return Array.from({ length: 12 }, (_, i) => `${yy}-${String(i + 1).padStart(2, "0")}`);
};
export const MONTHS = fyToMonths("FY26");
export const ML = {};
const rebuildML = () => {
  Object.keys(ML).forEach(k => delete ML[k]);
  MONTHS.forEach(m => { const [y, mm] = m.split("-"); ML[m] = `${MNAMES[+mm - 1]}-${y.slice(2)}`; });
};
rebuildML();
let CURRENT_FY = "FY26";
export const setFiscalYear = (fy) => {
  if (fy === CURRENT_FY) return;
  CURRENT_FY = fy;
  MONTHS.splice(0, MONTHS.length, ...fyToMonths(fy));
  rebuildML();
};
// Remap any month key of a different calendar year onto the active FY (keeps the MM part).
// Heals data saved while months were hardcoded to 2026 — lossless, month index preserved.
export const remapMonth = (m) => {
  if (typeof m !== "string" || !/^\d{4}-\d{2}/.test(m)) return m;
  const target = MONTHS[+m.slice(5, 7) - 1];
  return target || m;
};
export const normalizeClientData = (c) => {
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
export const SITES = ["Site 1","Site 2","Site 3","Site 4","Site 5"];
export const REV_CATS = ["CLIENT REVENUE - FM Core","CLIENT REVENUE - FM Extra Works","CLIENT REVENUE - PJMs"];
export const COST_CATS = ["Subcontractors cost - FM Core","Subcontractors cost - FM Extra Works","Subcontractors cost - PJMs"];
export const SVC_CATS = ["Cleaning","Building Systems & maintenance","Waste Management","Handyman services","Office supplies","Kitchen supplies","Water supplies","Small works","Laundry services","Mail services","Pest Control","Landscaping","Security services","Catering services","Employee Convenience","Other"];
// FM Core labour components (their monthly sum → "Labour Cost - FM Core" in the P&L).
export const LAB_ROWS = [{k:"onsite",l:"CBRE On site team"},{k:"regional",l:"Regional Cost"},{k:"it",l:"IT Cost"},{k:"local",l:"Local Support"},{k:"sga",l:"SG&A"},{k:"other",l:"Other items"}];
// Direct actual labour for the Extra Works and PJM segments — entered as real € amounts (not weights).
export const LAB_EW_KEY = "ew_labour", LAB_PJM_KEY = "pjm_labour";
export const LAB_SEG_ROWS = [{k:LAB_EW_KEY,l:"FM Extra Works Labour"},{k:LAB_PJM_KEY,l:"FM PJM Labour"}];
// All labour rows in display order (6 core components + 2 segment lines).
export const LAB_ALL_ROWS = [...LAB_ROWS, ...LAB_SEG_ROWS];
export function mkLab() { const o = {}; MONTHS.forEach(m => { o[m] = {}; LAB_ALL_ROWS.forEach(r => { o[m][r.k] = 0; }); }); return o; }
// Legacy per-month segment weights — no longer used for the P&L split (kept for old saved blobs).
export function mkAlloc() { const o = {}; MONTHS.forEach(m => { o[m] = {core:100,ew:0,pjm:0}; }); return o; }

export const P = { em:"#003F2D",ep:"#E8F5E9",wh:"#fff",of:"#F7F9F8",bd:"#D5DDD8",tx:"#1A2E23",tm:"#5F7567",rd:"#C62828",gn:"#2E7D32",al:"#F0F5F2",ip:"#FFFFF0" };
export const fmt = n => (n == null || isNaN(n)) ? "-" : n.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
export const fPct = n => (n == null || isNaN(n) || !isFinite(n)) ? "-" : (n*100).toFixed(1)+"%";

// Small badge describing a contract's expiry state (null when no/unparseable date or far out).
export const expiryBadge = (expiry) => {
  const dd = daysUntil(expiry); if (dd == null) return null;
  if (dd < 0) return { label: "Έληξε", color: "#fff", bg: "#C62828" };
  if (dd <= 30) return { label: `Λήγει σε ${dd}μ`, color: "#fff", bg: "#C62828" };
  if (dd <= 90) return { label: `Λήγει σε ${dd}μ`, color: "#fff", bg: "#F57F17" };
  return null;
};

export const YEARS = ["FY24","FY25","FY26","FY27"];

// ── Company-wide OPEX / CAPEX (finance/admin) ──
export const DEFAULT_OPEX_CATS = ["Payroll & overhead","Rent","Utilities","IT & Software","Telecom","Travel","Professional fees","Insurance","Office supplies","Marketing","Training","Other"];
export const CAPEX_CATS = ["IT Equipment","Furniture & Fixtures","Vehicles","Leasehold improvements","Software (capitalised)","Machinery","Other"];
export const CAPEX_STATUS = [{v:"Planned",c:"#78909C"},{v:"Approved",c:"#0277BD"},{v:"In progress",c:"#F57F17"},{v:"Capitalised",c:"#2E7D32"}];

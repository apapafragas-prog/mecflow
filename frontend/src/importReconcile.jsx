// Import & Reconcile — parse a CBRE monthly-report .xlsx and reconcile it against
// the client's current in-system data, then apply ADD + UPDATE only (never deletes).
//
// Handles both system-exported workbooks (month headers like "Jan-26") and the
// original CBRE template (month headers as Excel serial dates, e.g. 46023). The
// three reconciled sections are CBRE Invoices, Sub Invoices and Labour Cost.
import { useState, useMemo } from "react";
import * as XLSX from "xlsx";
import { MONTHS, P, fmt, uid, REV_CATS, COST_CATS, LAB_ROWS, LAB_ALL_ROWS, LAB_EW_KEY, LAB_PJM_KEY } from "./constants.js";
import { useT, monthLabel } from "./i18n.jsx";

// ───────────────────────── parsing helpers ─────────────────────────
const str = (v) => (v == null ? "" : String(v).trim());
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Robust numeric parse — tolerates €, spaces, and both EU (1.234,56) and US (1,234.56) grouping.
const num = (v) => {
  if (v === "" || v == null) return 0;
  if (typeof v === "number") return v;
  let s = String(v).replace(/\s/g, "").replace(/€|\$/g, "");
  if (/^-?\d{1,3}\.\d{3}/.test(s) || (s.includes(",") && /,\d{2}$/.test(s))) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
};

// Excel serial → JS Date (UTC). 25569 = days between 1899-12-30 and 1970-01-01.
const serialToDate = (n) => new Date(Math.round((n - 25569) * 86400000));
const serialToDMY = (n) => { const d = serialToDate(n); return String(d.getUTCDate()).padStart(2, "0") + "/" + String(d.getUTCMonth() + 1).padStart(2, "0") + "/" + d.getUTCFullYear(); };

// Any header/cell → a MONTHS key of the ACTIVE fiscal year (mapped by month-of-year), or null.
const MNAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const toMonthKey = (v) => {
  if (v == null || v === "") return null;
  let mo = 0;
  if (v instanceof Date && !isNaN(v)) mo = v.getUTCMonth() + 1;
  else if (typeof v === "number" && v >= 20000 && v <= 90000) mo = serialToDate(v).getUTCMonth() + 1;
  else {
    const s = String(v).trim();
    let m = s.match(/^(\d{4})[-/](\d{1,2})/);
    if (m) mo = +m[2];
    else if ((m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/))) mo = +m[2];
    else { const lc = s.toLowerCase(); const idx = MNAMES.findIndex(n => lc.includes(n)); if (idx >= 0) mo = idx + 1; }
  }
  if (mo < 1 || mo > 12) return null;
  return MONTHS.find(mm => +mm.split("-")[1] === mo) || null;
};

// Any date-ish cell → dd/mm/yyyy string.
const dateToStr = (v) => {
  if (!v) return "";
  if (v instanceof Date && !isNaN(v)) return String(v.getUTCDate()).padStart(2, "0") + "/" + String(v.getUTCMonth() + 1).padStart(2, "0") + "/" + v.getUTCFullYear();
  if (typeof v === "number" && v >= 20000 && v <= 90000) return serialToDMY(v);
  return String(v);
};

// Field lookup across an object row. TWO passes so an early key's partial match can't
// beat a later key's exact match — e.g. asking for "VAT" must not grab "Amount (excluding VAT)".
const fld = (r, ...keys) => {
  const rk = Object.keys(r);
  const ok = (k) => r[k] !== undefined && r[k] !== "" && r[k] !== null;
  for (const k of keys) {                                   // pass 1: exact + case-insensitive equal
    if (ok(k)) return r[k];
    const ci = rk.find(x => x.toLowerCase().trim() === k.toLowerCase().trim());
    if (ci && ok(ci)) return r[ci];
  }
  for (const k of keys) {                                    // pass 2: substring
    const pa = rk.find(x => x.toLowerCase().trim().includes(k.toLowerCase().trim()));
    if (pa && ok(pa)) return r[pa];
  }
  return "";
};

// Map a raw category string to a canonical segment category. Returns null when the value is
// blank or unrecognizable — the caller drops such rows (they are footers/subtotals, never real
// lines) instead of silently defaulting them to Core, which would corrupt the totals.
const matchCat = (val, list) => {
  const v = String(val || "").toLowerCase().trim();
  if (!v) return null;
  const exact = list.find(c => c.toLowerCase().trim() === v);
  if (exact) return exact;
  if (v.includes("core")) return list.find(c => c.toLowerCase().includes("core")) || null;
  if (v.includes("extra") || v.includes("exra")) return list.find(c => c.toLowerCase().includes("extra")) || null;
  if (v.includes("pjm") || v.includes("project")) return list.find(c => c.toLowerCase().includes("pjm")) || null;
  const partial = list.find(c => c.toLowerCase().includes(v) || v.includes(c.toLowerCase()));
  return partial || null;
};

// Labour category label → internal key (6 core + 2 segment lines).
const labKeyOf = (label) => {
  const lc = String(label || "").toLowerCase().trim();
  if (!lc || lc === "sum" || lc === "category" || lc === "total" || lc.startsWith("fte")) return null;
  if (lc.includes("extra") || lc.includes("exra")) return LAB_EW_KEY;
  if (lc.includes("pjm") || lc.includes("project")) return LAB_PJM_KEY;
  if (lc.includes("on site") || lc.includes("on-site") || lc.includes("onsite")) return "onsite";
  if (lc.includes("regional")) return "regional";
  if (lc.includes("local")) return "local";
  if (lc.includes("sg&a") || lc.includes("sga")) return "sga";
  if (lc.includes("other")) return "other";
  if (/\bit\b/.test(lc) || lc.includes("it cost")) return "it";
  return null;
};

const findSheet = (names, keywords) => {
  const lc = names.map(n => n.toLowerCase());
  for (const kw of keywords) { const i = lc.findIndex(n => n.includes(kw)); if (i >= 0) return names[i]; }
  return null;
};

// Parse a File (async) → { inv, sub, lab, meta }. Records carry NO id (assigned on apply).
export async function parseWorkbookFile(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array", cellDates: true });
  const names = wb.SheetNames;
  const rows = (name) => (name && wb.Sheets[name] ? XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: "", raw: true }) : []);
  const grid = (name) => (name && wb.Sheets[name] ? XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: "", raw: true }) : []);

  const invSheet = findSheet(names, ["cbre invoice", "client invoice", "customer invoice", "ar invoice", "revenue"]);
  const subSheet = findSheet(names, ["sub invoice", "subcontractor", "sub inv", "ap invoice", "supplier invoice"]);
  const labSheet = findSheet(names, ["labour cost", "labour", "labor cost", "labor", "payroll"]);

  // ── CBRE Invoices ──
  const invAll = (invSheet ? rows(invSheet) : []).map(r => {
    const a = num(fld(r, "Amount", "Net", "Net Amount", "Καθαρή Αξία"));
    const v = num(fld(r, "VAT (24%)", "VAT", "VAT €", "ΦΠΑ", "Φ.Π.Α."));
    const t = num(fld(r, "Total", "TOTAL", "Σύνολο", "Πληρωτέο")) || a + v;
    return {
      client: str(fld(r, "Client", "Customer")),
      site: str(fld(r, "Site")) || "Site 1",
      month: toMonthKey(fld(r, "Month", "Period")) || MONTHS[0],
      cat: matchCat(fld(r, "Revenue category", "Category"), REV_CATS),
      amt: a, vat: v || round2(a * 0.24), total: t,
      inv_no: str(fld(r, "Invoice Number", "Invoice No", "Αρ. Τιμολογίου", "No")),
      date: dateToStr(fld(r, "Date", "Ημερομηνία")),
      comments: str(fld(r, "Comments", "Notes", "Σχόλια")),
      act_acc: str(fld(r, "Actual/Accrual", "Act/Acc", "Type")).toUpperCase().includes("ACCR") ? "ACCRUAL" : "ACTUAL",
      po_no: str(fld(r, "PO No", "PO", "Purchase Order")),
    };
  });
  // Keep only rows with a recognized revenue category (drops blank footer/subtotal rows that
  // would otherwise be mis-bucketed). Track how many carried an amount but no category.
  const inv = invAll.filter(x => x.cat && (x.amt !== 0 || x.inv_no));
  const invSkipped = invAll.filter(x => !x.cat && x.amt !== 0).length;

  // ── Sub Invoices ──
  const subAll = (subSheet ? rows(subSheet) : []).map(r => {
    const a = num(fld(r, "Amount (excluding", "Amount", "Net", "Net Value", "Αξία"));
    const v = num(fld(r, "VAT (24%)", "VAT", "VAT €", "ΦΠΑ", "Φ.Π.Α."));
    const t = num(fld(r, "Total", "TOTAL", "Σύνολο")) || a + v;
    let fp = num(fld(r, "Fee %", "CBRE fee %", "Management Fee", "fee_pct"));
    if (fp > 0 && fp < 1) fp = fp * 100;                    // stored as 0.055 → 5.5
    if (!fp) fp = 5.5;
    const fee = round2(a * fp / 100);
    return {
      site: str(fld(r, "Site")) || "Site 1",
      month: toMonthKey(fld(r, "Month", "Period")) || MONTHS[0],
      cat: matchCat(fld(r, "Subcontractor Ca", "Subcontractor Category", "Category", "Cost Category"), COST_CATS),
      gl: str(fld(r, "GL Code", "GL")),
      supplier: str(fld(r, "Supplier name", "Supplier", "Vendor", "Προμηθευτής")),
      svc_cat: str(fld(r, "Service category", "Service Cat", "Svc Cat")) || "Other",
      svc_desc: str(fld(r, "Service descript", "Service Description", "Description", "Περιγραφή")),
      amt: a, vat: v || round2(a * 0.24), total: t,
      inv_no: str(fld(r, "Invoice number", "Invoice No", "Αρ. Τιμολογίου", "No")),
      date: dateToStr(fld(r, "Date", "Ημερομηνία")),
      fee_pct: fp, cbre_fee: fee, cbre_bill: round2(a + fee),
      act_acc: str(fld(r, "Actual/Accrual", "Act/Acc", "Status")).toUpperCase().includes("ACCR") ? "ACCRUAL" : "ACTUAL",
      comments: str(fld(r, "Comments", "Notes", "Σχόλια")),
    };
  });
  // A real sub line has a recognized cost category AND a supplier or invoice number.
  const sub = subAll.filter(x => x.cat && (x.supplier || x.inv_no) && (x.amt !== 0 || x.total !== 0));
  const subSkipped = subAll.filter(x => (!x.cat || (!x.supplier && !x.inv_no)) && x.amt !== 0).length;

  // ── Labour Cost (grid mode — handles serial-date headers + multiple sub-sections) ──
  const lab = {}; MONTHS.forEach(m => { lab[m] = {}; });
  let labCells = 0;
  if (labSheet) {
    const g = grid(labSheet);
    let colMap = {};                                        // col index → MONTHS key (from the latest header row)
    g.forEach(row => {
      const first = str(row[0]).toLowerCase();
      if (first === "category" || first.startsWith("categor")) {
        colMap = {}; row.forEach((cell, ci) => { if (ci === 0) return; const mk = toMonthKey(cell); if (mk) colMap[ci] = mk; });
        return;
      }
      const key = labKeyOf(row[0]);
      if (!key) return;
      Object.entries(colMap).forEach(([ci, mk]) => { const val = num(row[ci]); if (val) { lab[mk][key] = round2((lab[mk][key] || 0) + val); labCells++; } });
    });
  }

  // ── Extra Works & PJM labour come from the P&L report sheet (authoritative segment totals) ──
  // The Labour detail sheet only breaks down FM Core; Extra/PJM live as P&L lines.
  const pnlSheet = findSheet(names, ["p&l report", "p&l", "pnl", "profit"]);
  if (pnlSheet) {
    const g = grid(pnlSheet);
    let colMap = {};
    g.forEach(row => {
      if (row.some(c => String(c).toLowerCase().includes("months >>"))) {
        colMap = {}; row.forEach((c, ci) => { const mk = toMonthKey(c); if (mk) colMap[ci] = mk; });
        return;
      }
      const label = String(row[2] || row[0] || "").toLowerCase();
      if (!label.includes("labour")) return;
      let key = null;
      if (label.includes("extra") || label.includes("exra")) key = LAB_EW_KEY;
      else if (label.includes("pjm")) key = LAB_PJM_KEY;
      if (!key) return;                                       // ignore FM Core / Total labour lines
      Object.entries(colMap).forEach(([ci, mk]) => { const v = num(row[ci]); if (v) { lab[mk][key] = round2(v); labCells++; } });
    });
  }

  // Client name: prefer the invoices' CLIENT column, else null.
  const client = str((inv.find(i => i.client) || {}).client) || null;
  return { inv, sub, lab, meta: { client, invSheet, subSheet, labSheet, pnlSheet, labCells, invSkipped, subSkipped, sheets: names } };
}

// ───────────────────────── reconciliation ─────────────────────────
// Match file rows against system rows. idOf = identity (same invoice), fullOf = identity+amounts.
//   full hit  → MATCH (nothing to do)
//   id hit    → CHANGED (same invoice, different numbers) → carries system row id for in-place update
//   no hit    → NEW
//   unmatched system rows → ONLY_IN_SYSTEM (never deleted)
export function reconcileRows(fileRows, sysRows, idOf, fullOf) {
  const byFull = new Map(), byId = new Map();
  const push = (map, k, x) => { if (!map.has(k)) map.set(k, []); map.get(k).push(x); };
  sysRows.forEach((r, i) => { push(byFull, fullOf(r), i); push(byId, idOf(r), i); });
  const used = new Set();
  const take = (map, k) => { const arr = map.get(k); if (!arr) return -1; const i = arr.find(ix => !used.has(ix)); return i === undefined ? -1 : i; };
  const out = { newRows: [], changed: [], match: [] };
  fileRows.forEach(fr => {
    let i = take(byFull, fullOf(fr));
    if (i >= 0) { used.add(i); out.match.push({ file: fr, sys: sysRows[i] }); return; }
    i = take(byId, idOf(fr));
    if (i >= 0) { used.add(i); out.changed.push({ file: fr, sys: sysRows[i], sysId: sysRows[i].id }); return; }
    out.newRows.push(fr);
  });
  out.onlySys = sysRows.filter((_, i) => !used.has(i));
  return out;
}

// IDENTITY = the invoice number alone (unique per client), so the SAME invoice is matched even if
// it landed in a different month/category (e.g. scanned into May, but the P&L file books it to June).
// That makes such a case a CHANGED (updated in place) instead of a NEW row — no duplicates.
// FULL adds month/category/amounts so a genuine difference still registers as CHANGED vs MATCH.
// No invoice number (accruals) → fall back to a content key.
const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, "").trim();
const invId = (r) => { const no = norm(r.inv_no); return no ? `no:${no}` : `x:${r.month}|${r.cat}|${round2(r.amt)}|${norm(r.comments)}`; };
const invFull = (r) => `${invId(r)}|${r.month}|${r.cat}|${round2(r.amt)}|${round2(r.vat)}`;
const subId = (r) => { const no = norm(r.inv_no); return no ? `no:${no}` : `x:${r.month}|${r.cat}|${norm(r.supplier)}|${round2(r.amt)}`; };
const subFull = (r) => `${subId(r)}|${r.month}|${r.cat}|${norm(r.supplier)}|${round2(r.amt)}`;

// Per-cell labour diff (month × labour line). Skips 0/0 cells.
export function reconcileLabour(fileLab, sysLab) {
  const cells = [];
  MONTHS.forEach(m => LAB_ALL_ROWS.forEach(row => {
    const fv = round2(fileLab?.[m]?.[row.k]), sv = round2(sysLab?.[m]?.[row.k]);
    if (fv === 0 && sv === 0) return;
    let status = "match";
    if (fv !== sv) status = sv === 0 ? "new" : fv === 0 ? "onlySys" : "changed";
    cells.push({ m, k: row.k, label: row.l, fv, sv, status });
  }));
  return cells;
}

export function buildReconciliation(parsed, cur) {
  return {
    inv: reconcileRows(parsed.inv, cur.inv || [], invId, invFull),
    sub: reconcileRows(parsed.sub, cur.sub || [], subId, subFull),
    lab: reconcileLabour(parsed.lab, cur.lab || {}),
  };
}

// ───────────────────────── UI ─────────────────────────
const BADGE = {
  new: { bg: "#E8F5E9", fg: "#2E7D32", el: "ΝΕΟ", en: "NEW" },
  changed: { bg: "#FFF8E1", fg: "#F57F17", el: "ΑΛΛΑΓΗ", en: "CHANGED" },
  match: { bg: "#ECEFF1", fg: "#607D8B", el: "ΙΔΙΟ", en: "MATCH" },
  onlySys: { bg: "#E3F2FD", fg: "#1565C0", el: "ΜΟΝΟ ΣΤΟ ΣΥΣΤΗΜΑ", en: "ONLY IN SYSTEM" },
};

function Badge({ status }) {
  const { t } = useT(); const b = BADGE[status] || BADGE.match;
  return <span style={{ background: b.bg, color: b.fg, padding: "1px 7px", borderRadius: 10, fontSize: 10, fontWeight: 700, whiteSpace: "nowrap" }}>{t(b.el, b.en)}</span>;
}

export function ReconcileModal({ parsed, cur, onApply, onClose }) {
  const { t } = useT();
  const rec = useMemo(() => buildReconciliation(parsed, cur), [parsed, cur]);
  // Selection sets — default: all NEW + CHANGED selected.
  const [selInv, setSelInv] = useState(() => new Set(rec.inv.newRows.map((_, i) => "n" + i).concat(rec.inv.changed.map((_, i) => "c" + i))));
  const [selSub, setSelSub] = useState(() => new Set(rec.sub.newRows.map((_, i) => "n" + i).concat(rec.sub.changed.map((_, i) => "c" + i))));
  const [selLab, setSelLab] = useState(() => new Set(rec.lab.filter(c => c.status === "new" || c.status === "changed").map(c => c.m + "|" + c.k)));
  const [section, setSection] = useState("inv");

  const toggle = (setter) => (key) => setter(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const tInv = toggle(setSelInv), tSub = toggle(setSelSub), tLab = toggle(setSelLab);

  const invActionable = rec.inv.newRows.length + rec.inv.changed.length;
  const subActionable = rec.sub.newRows.length + rec.sub.changed.length;
  const labActionable = rec.lab.filter(c => c.status === "new" || c.status === "changed").length;

  const apply = () => {
    const invAdd = rec.inv.newRows.filter((_, i) => selInv.has("n" + i));
    const invUpd = rec.inv.changed.filter((_, i) => selInv.has("c" + i)).map(c => ({ sysId: c.sysId, file: c.file }));
    const subAdd = rec.sub.newRows.filter((_, i) => selSub.has("n" + i));
    const subUpd = rec.sub.changed.filter((_, i) => selSub.has("c" + i)).map(c => ({ sysId: c.sysId, file: c.file }));
    const labSet = rec.lab.filter(c => (c.status === "new" || c.status === "changed") && selLab.has(c.m + "|" + c.k)).map(c => ({ m: c.m, k: c.k, v: c.fv }));
    onApply({ invAdd, invUpd, subAdd, subUpd, labSet });
  };

  const th = { padding: "6px 8px", textAlign: "left", fontSize: 10.5, fontWeight: 700, color: "#fff", background: P.em, position: "sticky", top: 0, whiteSpace: "nowrap" };
  const td = { padding: "5px 8px", fontSize: 11.5, borderBottom: "1px solid " + P.bd, whiteSpace: "nowrap" };
  const amtCell = (v, neg) => <span style={{ color: neg && v < 0 ? P.rd : P.tx }}>{fmt(v)}</span>;

  const rowTable = (list, kind, sel, tog, extraCols) => (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead><tr>
        <th style={{ ...th, width: 34 }}></th>
        <th style={th}>{t("Κατάσταση", "Status")}</th>
        <th style={th}>{t("Μήνας", "Month")}</th>
        <th style={th}>{t("Κατηγορία", "Category")}</th>
        {extraCols.map(c => <th key={c} style={th}>{c}</th>)}
        <th style={{ ...th, textAlign: "right" }}>{t("Σύστημα", "System")}</th>
        <th style={{ ...th, textAlign: "right" }}>{t("Αρχείο", "File")}</th>
      </tr></thead>
      <tbody>
        {list.map(({ item, status, key, sys, cells }) => {
          const actionable = status === "new" || status === "changed";
          return (
            <tr key={key} style={{ background: actionable && sel.has(key) ? "#F1F8E9" : "#fff", opacity: actionable ? 1 : 0.7 }}>
              <td style={{ ...td, textAlign: "center" }}>{actionable ? <input type="checkbox" checked={sel.has(key)} onChange={() => tog(key)} /> : ""}</td>
              <td style={td}><Badge status={status} /></td>
              <td style={td}>{monthLabel(item.month)}</td>
              <td style={{ ...td, maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis" }} title={item.cat}>{item.cat.replace(/^CLIENT (REVENUE|Subcontractors cost) - /, "")}</td>
              {cells.map((c, i) => <td key={i} style={{ ...td, maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis" }} title={c}>{c || "—"}</td>)}
              <td style={{ ...td, textAlign: "right" }}>{sys ? amtCell(sys.amt, true) : "—"}</td>
              <td style={{ ...td, textAlign: "right", fontWeight: status === "changed" ? 700 : 400 }}>{amtCell(item.amt, true)}</td>
            </tr>
          );
        })}
        {list.length === 0 && <tr><td colSpan={5 + extraCols.length} style={{ ...td, textAlign: "center", color: P.tm }}>{t("Καμία εγγραφή", "No rows")}</td></tr>}
      </tbody>
    </table>
  );

  const invList = [
    ...rec.inv.newRows.map((item, i) => ({ item, status: "new", key: "n" + i, sys: null, cells: [item.inv_no, item.act_acc] })),
    ...rec.inv.changed.map((c, i) => ({ item: c.file, status: "changed", key: "c" + i, sys: c.sys, cells: [c.file.inv_no, c.file.act_acc] })),
    ...rec.inv.onlySys.map((r, i) => ({ item: r, status: "onlySys", key: "s" + i, sys: null, cells: [r.inv_no, r.act_acc] })),
  ];
  const subList = [
    ...rec.sub.newRows.map((item, i) => ({ item, status: "new", key: "n" + i, sys: null, cells: [item.supplier, item.inv_no] })),
    ...rec.sub.changed.map((c, i) => ({ item: c.file, status: "changed", key: "c" + i, sys: c.sys, cells: [c.file.supplier, c.file.inv_no] })),
    ...rec.sub.onlySys.map((r, i) => ({ item: r, status: "onlySys", key: "s" + i, sys: null, cells: [r.supplier, r.inv_no] })),
  ];

  const tabBtn = (id, label, n) => (
    <button onClick={() => setSection(id)} style={{ background: section === id ? P.em : "transparent", color: section === id ? "#fff" : P.tx, border: "1px solid " + (section === id ? P.em : P.bd), padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600 }}>{label} <span style={{ opacity: .8 }}>({n})</span></button>
  );

  const selCount = selInv.size + selSub.size + selLab.size;

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, width: "min(1100px,100%)", height: "min(760px,100%)", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 16px 60px rgba(0,0,0,.4)", fontFamily: "Segoe UI,Tahoma,sans-serif" }}>
        <div style={{ background: P.em, color: "#fff", padding: "12px 18px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>📊 {t("Συμφιλίωση P&L", "P&L Reconciliation")}
            {parsed.meta.client && <span style={{ fontSize: 12, opacity: .8, fontWeight: 400 }}> · {parsed.meta.client}</span>}
          </div>
          <button onClick={onClose} style={{ background: "rgba(255,255,255,.2)", border: "none", color: "#fff", padding: "4px 11px", borderRadius: 5, cursor: "pointer", fontSize: 15, fontWeight: 700 }}>✕</button>
        </div>

        <div style={{ padding: "10px 18px", borderBottom: "1px solid " + P.bd, background: P.of, fontSize: 11.5, color: P.tm, lineHeight: 1.5 }}>
          {t("Επιλεγμένες γραμμές θα προστεθούν (ΝΕΟ) ή θα ενημερωθούν (ΑΛΛΑΓΗ). Τίποτα δεν διαγράφεται — οι εγγραφές «μόνο στο σύστημα» μένουν ως έχουν.",
            "Selected rows will be added (NEW) or updated (CHANGED). Nothing is deleted — “only in system” rows are left as they are.")}
          {(parsed.meta.client && cur.client && parsed.meta.client.toLowerCase() !== String(cur.client).toLowerCase()) && (
            <div style={{ marginTop: 6, color: P.rd, fontWeight: 600 }}>⚠ {t("Ο πελάτης στο αρχείο", "File client")} «{parsed.meta.client}» {t("διαφέρει από τον τρέχοντα", "differs from the current")} «{cur.client}». {t("Θα εισαχθεί στον τρέχοντα.", "It will be imported into the current one.")}</div>
          )}
          {(parsed.meta.invSkipped > 0 || parsed.meta.subSkipped > 0) && (
            <div style={{ marginTop: 6, color: "#F57F17", fontWeight: 600 }}>ℹ {t("Αγνοήθηκαν γραμμές χωρίς κατηγορία (footer/σύνολα)", "Skipped rows with no category (footers/subtotals)")}: {t("Τιμολ.", "Inv")} {parsed.meta.invSkipped}, {t("Υπεργ.", "Sub")} {parsed.meta.subSkipped}</div>
          )}
        </div>

        <div style={{ padding: "10px 18px", display: "flex", gap: 8, borderBottom: "1px solid " + P.bd }}>
          {tabBtn("inv", t("Τιμολόγια CBRE", "CBRE Invoices"), invActionable)}
          {tabBtn("sub", t("Υπεργολάβοι", "Sub Invoices"), subActionable)}
          {tabBtn("lab", t("Εργασία", "Labour"), labActionable)}
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: "0 18px" }}>
          {section === "inv" && rowTable(invList, "inv", selInv, tInv, [t("Αρ. Τιμολ.", "Invoice No"), "Act/Acc"])}
          {section === "sub" && rowTable(subList, "sub", selSub, tSub, [t("Προμηθευτής", "Supplier"), t("Αρ. Τιμολ.", "Invoice No")])}
          {section === "lab" && (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>
                <th style={{ ...th, width: 34 }}></th><th style={th}>{t("Κατάσταση", "Status")}</th><th style={th}>{t("Μήνας", "Month")}</th>
                <th style={th}>{t("Γραμμή", "Line")}</th><th style={{ ...th, textAlign: "right" }}>{t("Σύστημα", "System")}</th><th style={{ ...th, textAlign: "right" }}>{t("Αρχείο", "File")}</th>
              </tr></thead>
              <tbody>
                {rec.lab.map((c) => {
                  const key = c.m + "|" + c.k; const actionable = c.status === "new" || c.status === "changed";
                  return (
                    <tr key={key} style={{ background: actionable && selLab.has(key) ? "#F1F8E9" : "#fff", opacity: actionable ? 1 : 0.7 }}>
                      <td style={{ ...td, textAlign: "center" }}>{actionable ? <input type="checkbox" checked={selLab.has(key)} onChange={() => tLab(key)} /> : ""}</td>
                      <td style={td}><Badge status={c.status} /></td>
                      <td style={td}>{monthLabel(c.m)}</td>
                      <td style={td}>{c.label}</td>
                      <td style={{ ...td, textAlign: "right" }}>{fmt(c.sv)}</td>
                      <td style={{ ...td, textAlign: "right", fontWeight: c.status === "changed" ? 700 : 400 }}>{fmt(c.fv)}</td>
                    </tr>
                  );
                })}
                {rec.lab.length === 0 && <tr><td colSpan={6} style={{ ...td, textAlign: "center", color: P.tm }}>{t("Καμία διαφορά", "No differences")}</td></tr>}
              </tbody>
            </table>
          )}
        </div>

        <div style={{ padding: "12px 18px", borderTop: "1px solid " + P.bd, background: P.of, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <div style={{ fontSize: 12, color: P.tm }}>
            {t("Επιλεγμένα", "Selected")}: <b style={{ color: P.em }}>{selCount}</b> · {t("Τιμολ.", "Inv")} {selInv.size} · {t("Υπεργ.", "Sub")} {selSub.size} · {t("Εργ.", "Lab")} {selLab.size}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onClose} style={{ background: "#fff", border: "1px solid " + P.bd, color: P.tx, padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>{t("Άκυρο", "Cancel")}</button>
            <button onClick={apply} disabled={selCount === 0} style={{ background: selCount ? P.em : P.bd, border: "none", color: "#fff", padding: "8px 20px", borderRadius: 6, cursor: selCount ? "pointer" : "not-allowed", fontSize: 13, fontWeight: 700 }}>{t("Εφαρμογή Επιλεγμένων", "Apply Selected")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

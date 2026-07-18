// Company-wide (consolidated) monthly reports for finance/admin:
//   • Group P&L   — all clients' revenue/cost/labour + company OPEX/CAPEX → GM → EBITDA → EBIT → Net.
//   • Balance Sheet — monthly closing balances per account. Fixed assets (NBV), trade AR/AP and
//     retained earnings are auto-derived from the data; the rest are maintained by hand.
// P&L manual rows (interest/tax) and the balance-sheet accounts live in the finance_data blob
// (same store as OPEX/CAPEX) — we load the whole blob and save it back, preserving opex/capex.
import { useState, useEffect, useRef } from "react";
import { api } from "./api.js";
import { P, MONTHS, ML, YEARS, uid, fmt, fPct, normalizeClientData, REV_CATS, COST_CATS } from "./constants.js";
import { groupPnLSeries, nbvAtMonth, monthIdx } from "./calc.js";
import { exportWorkbook } from "./exportXlsx.js";

const normYear = (d) => Object.fromEntries(Object.entries(d || {}).map(([c, cd]) => [c, normalizeClientData(cd)]));
import { LangToggle } from "./ui.jsx";
import { useT, monthLabel } from "./i18n.jsx";

const grossAmt = r => Number(r.total) || ((Number(r.amt) || 0) + (Number(r.vat) || 0)) || Number(r.amt) || 0;
const isPaid = r => r.paid === "paid" || r.paid === true;

const mkDefaultBS = () => ({
  accounts: [
    { id: uid(), section: "asset", label: "Ταμείο & Τράπεζες" },
    { id: uid(), section: "asset", label: "Λοιπές απαιτήσεις / Προκαταβολές" },
    { id: uid(), section: "liability", label: "Τραπεζικός δανεισμός" },
    { id: uid(), section: "liability", label: "ΦΠΑ / Φόροι πληρωτέοι" },
    { id: uid(), section: "liability", label: "Δεδουλευμένα / Λοιπές υποχρεώσεις" },
    { id: uid(), section: "equity", label: "Μετοχικό κεφάλαιο" },
    { id: uid(), section: "equity", label: "Αποθεματικά / Κέρδη εις νέον (έναρξη)" },
  ],
  values: {},
});

const SECTIONS = [
  { k: "asset", el: "ΕΝΕΡΓΗΤΙΚΟ (Assets)", en: "ASSETS", short_el: "Ενεργητικού", short_en: "Assets" },
  { k: "liability", el: "ΥΠΟΧΡΕΩΣΕΙΣ (Liabilities)", en: "LIABILITIES", short_el: "Υποχρεώσεων", short_en: "Liabilities" },
  { k: "equity", el: "ΙΔΙΑ ΚΕΦΑΛΑΙΑ (Equity)", en: "EQUITY", short_el: "Ιδίων Κεφαλαίων", short_en: "Equity" },
];

export function GroupReports({ year, setYear, user, onBack, onLogout }) {
  const { t } = useT();
  const [allData, setAllData] = useState({});
  const [fin, setFin] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState("pnl");       // pnl | bs
  const [saveState, setSaveState] = useState("idle");
  const [na, setNa] = useState({ label: "", section: "asset" });
  const [drill, setDrill] = useState(null);    // { k, m } → per-client breakdown modal for a P&L cell
  const [cashTerms, setCashTerms] = useState(30); // payment-terms lag (days) for the cash-flow forecast
  const verRef = useRef(0);
  const dirtyRef = useRef(false);

  useEffect(() => {
    let cancelled = false; setLoaded(false);
    (async () => {
      const [cd, fr] = await Promise.all([
        api.getYearData(year).catch(() => ({})),
        api.getFinanceData(year).catch(() => null),
      ]);
      if (cancelled) return;
      setAllData(normYear(cd));
      verRef.current = (fr && fr.version) || 0;
      const d = (fr && fr.data) || {};
      if (!d.pnl) d.pnl = {};
      if (!d.pnl.interest) d.pnl.interest = {};
      if (!d.pnl.tax) d.pnl.tax = {};
      if (!d.bs || !Array.isArray(d.bs.accounts) || !d.bs.accounts.length) d.bs = mkDefaultBS();
      if (!d.bs.values) d.bs.values = {};
      if (!d.budgets || typeof d.budgets !== "object") d.budgets = {}; // { [client]: { rev, gmPct } } annual targets
      if (d.cashOpening == null) d.cashOpening = 0; // opening cash balance for the cash-flow forecast
      setFin(d); dirtyRef.current = false; setSaveState("idle"); setLoaded(true);
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line
  }, [year]);

  // Auto-save the whole finance blob (opex/capex preserved because we loaded it all).
  useEffect(() => {
    if (!loaded || !fin || !dirtyRef.current) return;
    setSaveState("saving");
    const t = setTimeout(async () => {
      try { const r = await api.saveFinanceData(year, fin, verRef.current); verRef.current = (r && r.version) || verRef.current + 1; dirtyRef.current = false; setSaveState("saved"); }
      catch (e) { setSaveState("error"); console.warn("group finance save failed", e); }
    }, 600);
    return () => clearTimeout(t);
  // eslint-disable-next-line
  }, [fin, loaded, year]);

  const mutate = (fn) => { dirtyRef.current = true; setFin(p => { const n = JSON.parse(JSON.stringify(p)); fn(n); return n; }); };

  const series = loaded ? groupPnLSeries(allData, fin, MONTHS) : MONTHS.map(m => ({ m, rev: 0, sub: 0, labour: 0, gm: 0, opex: 0, ebitda: 0, da: 0, ebit: 0, interest: 0, tax: 0, net: 0 }));
  const byMonth = Object.fromEntries(series.map(r => [r.m, r]));
  const ytd = k => series.reduce((s, r) => s + (r[k] || 0), 0);

  const setPnl = (kind, m, v) => mutate(n => { if (!n.pnl[kind]) n.pnl[kind] = {}; n.pnl[kind][m] = parseFloat(v) || 0; });

  // ── Budget vs Actual (annual targets per client, stored in the finance blob) ──
  const clientActual = (cd) => {
    const rev = (cd?.inv || []).reduce((s, i) => s + (Number(i.amt) || 0), 0);
    const cost = (cd?.sub || []).reduce((s, i) => s + (Number(i.amt) || 0), 0);
    let labour = 0; Object.values(cd?.lab || {}).forEach(mo => Object.values(mo || {}).forEach(v => labour += Number(v) || 0));
    return { rev, cost, labour, gm: rev - cost - labour };
  };
  const budgetOf = (client) => fin?.budgets?.[client] || {};
  const setBudget = (client, field, v) => mutate(n => { if (!n.budgets[client]) n.budgets[client] = {}; n.budgets[client][field] = parseFloat(v) || 0; });

  // ── Fee & COP (CBRE cost-plus core) ──
  // Management fee earned on subcontractor cost: prefer the stored cbre_fee, else amt × fee_pct (default 5%).
  const clientFee = (cd) => (cd?.sub || []).reduce((s, i) => {
    const amt = Number(i.amt) || 0;
    const fee = (i.cbre_fee != null && i.cbre_fee !== "") ? Number(i.cbre_fee) : (Number(i.fee_pct) || 5) * amt / 100;
    return s + (Number(fee) || 0);
  }, 0);
  // Company OPEX for the year (from the OPEX/CAPEX blob) — allocated to clients pro-rata by revenue to
  // derive Contract Operating Profit (COP = GM − allocated overhead), mirroring CBRE's COP definition.
  const totalOpex = (() => { const cats = fin?.opex?.cats || [], act = fin?.opex?.actual || {}; return cats.reduce((s, c) => s + MONTHS.reduce((s2, m) => s2 + (Number(act[c.id]?.[m]) || 0), 0), 0); })();
  // Per-client fee/COP rows + portfolio totals — shared by the Fee & COP tab and the Excel export.
  const feeCopData = () => {
    const base = Object.entries(allData || {}).map(([name, cd]) => {
      const a = clientActual(cd), fee = clientFee(cd);
      const effFee = a.cost > 0 ? (fee / a.cost) * 100 : null;
      const b = budgetOf(name);
      const conFee = (b.feePct === undefined || b.feePct === "") ? null : Number(b.feePct);
      return { name, ...a, fee, effFee, conFee };
    }).filter(r => r.rev !== 0 || r.cost !== 0 || r.fee !== 0 || r.conFee != null);
    const totRev = base.reduce((s, r) => s + r.rev, 0);
    const rows = base.map(r => {
      const alloc = totRev > 0 ? totalOpex * (r.rev / totRev) : 0;
      const cop = r.gm - alloc;
      return { ...r, alloc, cop, copPct: r.rev ? (cop / r.rev) * 100 : null, feeGap: (r.effFee != null && r.conFee != null) ? r.effFee - r.conFee : null };
    }).sort((x, y) => y.fee - x.fee);
    const T = { fee: rows.reduce((s, r) => s + r.fee, 0), cost: rows.reduce((s, r) => s + r.cost, 0), gm: rows.reduce((s, r) => s + r.gm, 0), cop: rows.reduce((s, r) => s + r.cop, 0), rev: totRev };
    return { rows, T };
  };

  // ── Direct monthly cash-flow forecast ──
  // Collections/payments are timed by their settlement month: paid invoices land in their paid_date
  // month; open invoices in (issue month + payment-terms lag). Payroll/OPEX/CAPEX/interest/tax are
  // cash-out in their booked month. Running balance = opening cash + cumulative net.
  const cashFlowSeries = () => {
    const termsM = Math.max(0, Math.round((Number(cashTerms) || 0) / 30));
    const shift = (m, n) => { const i = MONTHS.indexOf(m); return (i >= 0 && i + n < MONTHS.length) ? MONTHS[i + n] : null; };
    const paidMonthOf = (i) => { const pm = i.paid_date ? String(i.paid_date).slice(0, 7) : null; return (pm && MONTHS.includes(pm)) ? pm : null; };
    const z = () => { const o = {}; MONTHS.forEach(m => o[m] = 0); return o; };
    const collIn = z(), payOut = z(), lab = z(), opx = z(), cpx = z(), intr = z(), tax = z();
    Object.values(allData || {}).forEach(cd => {
      (cd?.inv || []).forEach(i => { if (!isActual(i)) return; const tm = isPaid(i) ? paidMonthOf(i) : shift(i.month, termsM); if (tm) collIn[tm] += grossAmt(i); });
      (cd?.sub || []).forEach(i => { if (!isActual(i)) return; const tm = isPaid(i) ? paidMonthOf(i) : shift(i.month, termsM); if (tm) payOut[tm] += grossAmt(i); });
      MONTHS.forEach(m => { if (cd?.lab?.[m]) lab[m] += Object.values(cd.lab[m]).reduce((s, v) => s + (Number(v) || 0), 0); });
    });
    const cats = fin?.opex?.cats || [], act = fin?.opex?.actual || {};
    MONTHS.forEach(m => { opx[m] = cats.reduce((s, c) => s + (Number(act[c.id]?.[m]) || 0), 0); });
    (fin?.capex || []).forEach(it => { if (onBooks(it) && it.month && MONTHS.includes(it.month)) cpx[it.month] += Number(it.amount) || 0; });
    MONTHS.forEach(m => { intr[m] = Number(fin?.pnl?.interest?.[m]) || 0; tax[m] = Number(fin?.pnl?.tax?.[m]) || 0; });
    let run = Number(fin?.cashOpening) || 0;
    return MONTHS.map(m => {
      const net = collIn[m] - payOut[m] - lab[m] - opx[m] - cpx[m] - intr[m] - tax[m];
      const open = run; run += net;
      return { m, open, collIn: collIn[m], payOut: payOut[m], lab: lab[m], opx: opx[m], cpx: cpx[m], intr: intr[m], tax: tax[m], net, close: run };
    });
  };

  // ── Balance-sheet derived lines (read-only) ──
  const nbvByMonth = {}, arByMonth = {}, apByMonth = {}, cumNet = {}, vatNetByMonth = {};
  const accrIncByMonth = {}, accrCostByMonth = {};
  let run = 0, accrIncRun = 0, accrCostRun = 0;
  // Only capitalised assets carry NBV/depreciation — Planned/Approved aren't on the books yet.
  const onBooks = it => it && it.status !== "Planned" && it.status !== "Approved";
  const isActual = i => (i.act_acc || "").toUpperCase() !== "ACCRUAL"; // accruals aren't trade AR/AP
  const vatOf = i => Number(i.vat) || (grossAmt(i) - (Number(i.amt) || 0)) || 0;
  // Open at the END of month `m`: issued on/before m, and not settled on/before m (uses paid_date).
  const openAt = (i, m) => {
    const mi = monthIdx(m), ii = monthIdx(i.month);
    if (ii == null || mi == null || ii > mi) return false;
    if (!isPaid(i)) return true;
    const pm = i.paid_date ? monthIdx(String(i.paid_date).slice(0, 7)) : null;
    // Paid WITH a date → settled from that month on. Paid but WITHOUT a date (legacy/imported/bulk-set
    // rows) → keep it OPEN rather than silently dropping it: its net still sits in equity via cumNet, so
    // removing the matching AR/AP asset would leave the balance sheet off by net+VAT with no visible cause.
    // It surfaces in the aging ledger as outstanding, prompting the user to stamp the real settlement date.
    return pm != null ? pm > mi : true;
  };
  // Issued on/before month `m` (regardless of payment). VAT liability accrues on ISSUANCE and stays
  // owed to the state until remitted — it must NOT vanish when the invoice is collected/paid.
  const issuedBy = (i, m) => { const mi = monthIdx(m), ii = monthIdx(i.month); return ii != null && mi != null && ii <= mi; };
  MONTHS.forEach(m => {
    let nbv = 0; (fin?.capex || []).forEach(it => { if (onBooks(it)) nbv += nbvAtMonth(it, m); }); nbvByMonth[m] = nbv;
    let ar = 0, ap = 0, vatAr = 0, vatAp = 0, accrInc = 0, accrCost = 0;
    Object.values(allData || {}).forEach(cd => {
      (cd?.inv || []).forEach(i => {
        if (isActual(i)) {
          if (openAt(i, m)) ar += grossAmt(i);            // AR asset: open (uncollected) only
          if (issuedBy(i, m)) vatAr += vatOf(i);          // output VAT: accrues on issuance, persists after payment
        } else if (i.month === m) accrInc += Number(i.amt) || 0;   // ACCRUAL revenue booked this month (net)
      });
      (cd?.sub || []).forEach(i => {
        if (isActual(i)) {
          if (openAt(i, m)) ap += grossAmt(i);            // AP liability: open (unpaid) only
          if (issuedBy(i, m)) vatAp += vatOf(i);          // input VAT: accrues on issuance
        } else if (i.month === m) accrCost += Number(i.amt) || 0;  // ACCRUAL cost booked this month (net)
      });
    });
    arByMonth[m] = ar; apByMonth[m] = ap;
    // Net VAT (output − input) accrued on ALL issued invoices up to month m, whether paid or not.
    // While an invoice is open, its gross AR/AP carries the VAT; once paid, the AR/AP swaps to cash but
    // the VAT stays here as a liability owed to the state — so the balance identity holds through payment.
    // Reduced by actual VAT remittances, which the user books on the manual "ΦΠΑ / Φόροι πληρωτέοι" line.
    vatNetByMonth[m] = vatAr - vatAp;
    // Accrued income (asset) / accrued expenses (liability): ACCRUAL invoices hit the P&L → equity
    // (cumNet) but are NOT trade AR/AP. Booking their cumulative net as matching asset/liability lines
    // (they reverse via negative accrual entries) keeps the balance identity closable. Net, no VAT.
    accrIncRun += accrInc; accrCostRun += accrCost;
    accrIncByMonth[m] = accrIncRun; accrCostByMonth[m] = accrCostRun;
    run += byMonth[m]?.net || 0; cumNet[m] = run;
  });
  const DERIVED = [
    { section: "asset", label: t("Πάγια — Αναπόσβεστη αξία (NBV)", "Fixed assets — Net book value (NBV)"), fn: m => nbvByMonth[m] },
    { section: "asset", label: t("Απαιτήσεις πελατών (AR, ανοιχτά)", "Trade receivables (AR, open)"), fn: m => arByMonth[m] },
    { section: "asset", label: t("Δουλευμένα έσοδα (accruals)", "Accrued income (accruals)"), fn: m => accrIncByMonth[m] },
    { section: "liability", label: t("Υποχρεώσεις προμηθευτών (AP, ανοιχτά)", "Trade payables (AP, open)"), fn: m => apByMonth[m] },
    { section: "liability", label: t("Δουλευμένα έξοδα (accruals)", "Accrued expenses (accruals)"), fn: m => accrCostByMonth[m] },
    { section: "liability", label: t("Καθαρό ΦΠΑ δουλευμένο (εκροών − εισροών)", "Net VAT accrued (output − input)"), fn: m => vatNetByMonth[m] },
    { section: "equity", label: t("Αποτέλεσμα περιόδου (σωρευτικά)", "Result for the period (cumulative)"), fn: m => cumNet[m] },
  ];

  const accts = fin?.bs?.accounts || [];
  const bsVal = (id, m) => fin?.bs?.values?.[id]?.[m] ?? "";
  const setBsVal = (id, m, v) => mutate(n => { if (!n.bs.values[id]) n.bs.values[id] = {}; n.bs.values[id][m] = parseFloat(v) || 0; });
  const renameAcct = (id, l) => mutate(n => { const a = n.bs.accounts.find(x => x.id === id); if (a) a.label = l; });
  const delAcct = (id) => { if (!confirm(t("Διαγραφή λογαριασμού και των τιμών του;", "Delete this account and its values?"))) return; mutate(n => { n.bs.accounts = n.bs.accounts.filter(a => a.id !== id); delete n.bs.values[id]; }); };
  const addAcct = () => { const l = na.label.trim(); if (!l) return; mutate(n => n.bs.accounts.push({ id: uid(), section: na.section, label: l })); setNa({ label: "", section: na.section }); };

  const manualIn = sec => accts.filter(a => a.section === sec);
  const derivedIn = sec => DERIVED.filter(d => d.section === sec);
  const sectionTotal = (sec, m) => manualIn(sec).reduce((s, a) => s + (Number(fin?.bs?.values?.[a.id]?.[m]) || 0), 0) + derivedIn(sec).reduce((s, d) => s + d.fn(m), 0);
  const totalAssets = m => sectionTotal("asset", m);
  const totalLE = m => sectionTotal("liability", m) + sectionTotal("equity", m);
  const check = m => totalAssets(m) - totalLE(m);
  const acctTotal = id => MONTHS.reduce((s, m) => s + (Number(fin?.bs?.values?.[id]?.[m]) || 0), 0);

  const thS = { padding: "6px 8px", textAlign: "center", fontSize: 10, fontWeight: 700, color: "#fff", background: P.em, whiteSpace: "nowrap" };
  const inpS = { width: "100%", padding: "4px 5px", border: "1px solid " + P.bd, borderRadius: 3, fontSize: 11, textAlign: "right", background: P.ip, outline: "none", boxSizing: "border-box" };
  const saveLbl = saveState === "saving" ? t("💾 Αποθήκευση…", "💾 Saving…") : saveState === "saved" ? t("✓ Αποθηκεύτηκε", "✓ Saved") : saveState === "error" ? t("⚠ Αποτυχία", "⚠ Save failed") : "";

  // ── P&L rows ──
  const R = [
    { k: "rev", l: t("Έσοδα (Revenue)", "Revenue") },
    { k: "sub", l: t("Κόστος υπεργολάβων", "Subcontractor cost"), cost: true },
    { k: "labour", l: t("Κόστος εργασίας (Labour)", "Labour cost"), cost: true },
    { k: "gm", l: t("Μικτό Κέρδος (Gross Margin)", "Gross Margin"), b: true, hl: P.ep },
    { pct: true, num: "gm", den: "rev", l: "GM %", muted: true },
    { k: "opex", l: t("Λειτουργικά έξοδα (OPEX)", "Operating expenses (OPEX)"), cost: true },
    { k: "ebitda", l: "EBITDA", b: true, hl: "#C8E6C9" },
    { pct: true, num: "ebitda", den: "rev", l: "EBITDA %", muted: true },
    { k: "da", l: t("Αποσβέσεις (D&A)", "Depreciation & Amortization (D&A)"), cost: true },
    { k: "ebit", l: t("EBIT (Λειτουργικό αποτέλεσμα)", "EBIT (Operating result)"), b: true, hl: P.ep },
    { k: "interest", l: t("Τόκοι / χρηματοοικονομικά", "Interest / financial"), cost: true, edit: true },
    { k: "tax", l: t("Φόροι", "Taxes"), cost: true, edit: true },
    { k: "net", l: t("Καθαρό Αποτέλεσμα (Net)", "Net result"), b: true, hl: "#C8E6C9" },
    { pct: true, num: "net", den: "rev", l: t("Καθαρό %", "Net %"), muted: true },
  ];
  const cellNum = (r, m) => {
    const row = byMonth[m] || {};
    if (r.pct) { const d = row[r.den]; return d ? row[r.num] / d : null; }
    return row[r.k] || 0;
  };
  const ytdNum = (r) => { if (r.pct) { const d = ytd(r.den); return d ? ytd(r.num) / d : null; } return ytd(r.k); };
  const showCell = (r, v) => r.pct ? fPct(v) : fmt(v);

  // Which P&L lines can be broken down per client (the rest are company-level: opex/D&A/interest/tax).
  const DRILLABLE = { rev: 1, sub: 1, labour: 1, gm: 1 };
  // Per-client contribution to a drillable line for one month, sorted by size.
  const drillRows = (k, m) => {
    const out = [];
    Object.entries(allData || {}).forEach(([name, cd]) => {
      let rev = 0, sub = 0, labour = 0;
      (cd?.inv || []).forEach(i => { if (i.month === m) rev += Number(i.amt) || 0; });
      (cd?.sub || []).forEach(i => { if (i.month === m) sub += Number(i.amt) || 0; });
      if (cd?.lab?.[m]) labour += Object.values(cd.lab[m]).reduce((s, v) => s + (Number(v) || 0), 0);
      const val = k === "rev" ? rev : k === "sub" ? sub : k === "labour" ? labour : rev - sub - labour;
      if (Math.abs(val) > 0.005) out.push({ name, val });
    });
    return out.sort((a, b) => b.val - a.val);
  };

  const exportGroup = () => {
    const pnlCell = (r, m) => { const v = cellNum(r, m); return v == null ? "" : (r.pct ? +(v * 100).toFixed(1) : v); };
    const pnlYtd = (r) => { const v = ytdNum(r); return v == null ? "" : (r.pct ? +(v * 100).toFixed(1) : v); };
    const pnlAoa = [["Line", ...MONTHS.map(m => ML[m] || m), "YTD"],
      ...R.map(r => [r.pct ? r.l + " (%)" : r.l, ...MONTHS.map(m => pnlCell(r, m)), pnlYtd(r)])];
    const last = MONTHS[MONTHS.length - 1];
    const bsAoa = [["Account", ...MONTHS.map(m => ML[m] || m), "Year-end"]];
    SECTIONS.forEach(sec => {
      bsAoa.push([t(sec.el, sec.en)]);
      derivedIn(sec.k).forEach(d => bsAoa.push([d.label + " (auto)", ...MONTHS.map(m => d.fn(m)), d.fn(last)]));
      manualIn(sec.k).forEach(a => bsAoa.push([a.label, ...MONTHS.map(m => Number(fin?.bs?.values?.[a.id]?.[m]) || 0), acctTotal(a.id)]));
      bsAoa.push([t("Σύνολο " + sec.short_el, "Total " + sec.short_en), ...MONTHS.map(m => sectionTotal(sec.k, m)), sectionTotal(sec.k, last)]);
    });
    bsAoa.push([t("Σ Ενεργητικό", "Σ Assets"), ...MONTHS.map(m => totalAssets(m)), totalAssets(last)]);
    bsAoa.push([t("Σ Υποχρ. + Ίδια Κεφ.", "Σ Liab. + Equity"), ...MONTHS.map(m => totalLE(m)), totalLE(last)]);
    bsAoa.push([t("Έλεγχος", "Check"), ...MONTHS.map(m => check(m)), ""]);
    // Fee & COP sheet
    const { rows: fcRows, T: fcT } = feeCopData();
    const feeAoa = [["Client", "Revenue", "Sub cost", "Mgmt Fee", "Effective %", "Contracted %", "Fee gap", "GM", "Alloc. OPEX", "COP", "COP %"],
      ...fcRows.map(r => [r.name, r.rev, r.cost, r.fee, r.effFee == null ? "" : +r.effFee.toFixed(1), r.conFee == null ? "" : r.conFee, r.feeGap == null ? "" : +r.feeGap.toFixed(1), r.gm, r.alloc, r.cop, r.copPct == null ? "" : +r.copPct.toFixed(1)]),
      ["TOTAL", fcT.rev, fcT.cost, fcT.fee, fcT.cost ? +(fcT.fee / fcT.cost * 100).toFixed(1) : "", "", "", fcT.gm, totalOpex, fcT.cop, fcT.rev ? +(fcT.cop / fcT.rev * 100).toFixed(1) : ""]];
    // Cash Flow sheet (rows = lines, columns = months)
    const cf = cashFlowSeries(), cfBy = Object.fromEntries(cf.map(r => [r.m, r]));
    const cfLine = (label, k, sign = 1) => [label, ...MONTHS.map(m => sign * cfBy[m][k]), cf.reduce((a, r) => a + sign * r[k], 0)];
    const cashAoa = [["Line", ...MONTHS.map(m => ML[m] || m), "Total"],
      [t("Ταμείο έναρξης", "Opening cash"), Number(fin?.cashOpening) || 0, ...MONTHS.slice(1).map(() => ""), ""],
      cfLine(t("Εισπράξεις πελατών (AR)", "Client collections (AR)"), "collIn"),
      cfLine(t("Πληρωμές προμηθευτών (AP)", "Supplier payments (AP)"), "payOut", -1),
      cfLine(t("Μισθοδοσία", "Payroll"), "lab", -1),
      cfLine("OPEX", "opx", -1), cfLine("CAPEX", "cpx", -1),
      cfLine(t("Τόκοι", "Interest"), "intr", -1), cfLine(t("Φόροι", "Taxes"), "tax", -1),
      cfLine(t("Καθαρή ταμειακή ροή", "Net cash flow"), "net"),
      [t("Ταμείο τέλους", "Closing cash"), ...MONTHS.map(m => cfBy[m].close), cf.length ? cf[cf.length - 1].close : 0]];
    exportWorkbook(`CBRE_Group_${year}.xlsx`, [{ name: "P&L", aoa: pnlAoa }, { name: "Balance Sheet", aoa: bsAoa }, { name: "Fee & COP", aoa: feeAoa }, { name: "Cash Flow", aoa: cashAoa }]);
  };

  // Data-quality guard: rows whose category isn't one of the canonical REV/COST buckets are counted in
  // the Group/Dashboard totals but DROPPED from the per-client P&L (which filters by category) — so
  // "Group = Σ per-client" silently breaks. Surface them so the user can fix the category.
  const miscat = [];
  Object.entries(allData || {}).forEach(([name, cd]) => {
    let n = 0;
    (cd?.inv || []).forEach(i => { if ((Number(i.amt) || 0) !== 0 && !REV_CATS.includes(i.cat)) n++; });
    (cd?.sub || []).forEach(i => { if ((Number(i.amt) || 0) !== 0 && !COST_CATS.includes(i.cat)) n++; });
    if (n) miscat.push({ name, n });
  });
  const miscatTotal = miscat.reduce((s, x) => s + x.n, 0);

  const kpi = (l, v, c, pct) => (
    <div style={{ background: P.wh, border: "1px solid " + P.bd, borderRadius: 10, padding: "12px 14px" }}>
      <div style={{ fontSize: 11, color: P.tm }}>{l}</div>
      <div style={{ fontSize: 20, fontWeight: 800, color: c, marginTop: 4 }}>{pct ? fPct(v) : "€" + fmt(v)}</div>
    </div>
  );

  return (
    <div style={{ minHeight: "100vh", background: P.of, fontFamily: "Segoe UI,Tahoma,sans-serif" }}>
      <div style={{ background: P.em, color: "#fff", padding: "14px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span style={{ fontWeight: 800, fontSize: 20, letterSpacing: 1 }}>CBRE</span>
          <button onClick={onBack} style={{ background: "rgba(255,255,255,.2)", border: "none", color: "#fff", padding: "4px 12px", borderRadius: 4, cursor: "pointer", fontSize: 12 }}>◀ {t("Πελάτες", "Clients")}</button>
          <span style={{ fontSize: 14, fontWeight: 600, borderLeft: "1px solid rgba(255,255,255,.3)", paddingLeft: 12 }}>🏢 {t("Όμιλος P&L / Ισολογισμός", "Group P&L / Balance Sheet")} — {year}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
          <span style={{ fontSize: 11, opacity: .9, minWidth: 78, textAlign: "right" }}>{saveLbl}</span>
          <LangToggle dark />
          <span style={{ opacity: .7 }}>{user.name}</span>
          <button onClick={onLogout} style={{ background: "rgba(255,255,255,.15)", border: "none", color: "#fff", padding: "5px 14px", borderRadius: 4, cursor: "pointer", fontSize: 12 }}>{t("Αποσύνδεση", "Logout")}</button>
        </div>
      </div>

      <div style={{ maxWidth: 1400, margin: "0 auto", padding: "18px 24px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 12 }}>
          <div style={{ display: "flex", gap: 8 }}>
            {YEARS.map(y => (<button key={y} onClick={() => setYear(y)} style={{ padding: "6px 16px", border: year === y ? "2px solid " + P.em : "1px solid " + P.bd, borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: year === y ? 700 : 400, background: year === y ? P.em : P.wh, color: year === y ? "#fff" : P.tx }}>{y}</button>))}
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            {loaded && <button onClick={exportGroup} style={{ padding: "6px 14px", border: "1px solid " + P.em, borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600, background: P.wh, color: P.em }}>⬇ {t("Εξαγωγή Excel", "Export Excel")}</button>}
            <div style={{ display: "flex", gap: 0, background: P.wh, borderRadius: 8, border: "1px solid " + P.bd, padding: 4 }}>
              {[{ v: "pnl", l: t("📈 P&L (Όμιλος)", "📈 P&L (Group)") }, { v: "bs", l: t("⚖️ Ισολογισμός", "⚖️ Balance Sheet") }, { v: "budget", l: t("🎯 Budget vs Actual", "🎯 Budget vs Actual") }, { v: "fee", l: t("💰 Fee & COP", "💰 Fee & COP") }, { v: "cash", l: t("💵 Ταμειακές Ροές", "💵 Cash Flow") }].map(o => (
                <button key={o.v} onClick={() => setTab(o.v)} style={{ background: tab === o.v ? P.em : "transparent", color: tab === o.v ? "#fff" : P.tx, border: "none", padding: "7px 20px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>{o.l}</button>
              ))}
            </div>
          </div>
        </div>

        {!loaded && <div style={{ padding: 40, textAlign: "center", color: P.tm }}>{t("Φόρτωση…", "Loading…")}</div>}

        {loaded && miscatTotal > 0 && (
          <div style={{ background: "#FFF8E1", border: "1px solid #F5D76E", borderRadius: 8, padding: "10px 16px", marginBottom: 14, fontSize: 12, color: "#7A5B00" }}>
            ⚠️ {t("Προσοχή στη συμφωνία", "Reconciliation notice")}: {miscatTotal} {t("γραμμές με μη-κανονική κατηγορία μετρούν στα σύνολα του Ομίλου αλλά ΟΧΙ στο P&L του κάθε πελάτη", "rows with a non-canonical category count in the Group totals but NOT in each client's P&L")} — {miscat.slice(0, 6).map(x => `${x.name} (${x.n})`).join(", ")}{miscat.length > 6 ? "…" : ""}. {t("Διόρθωσε την κατηγορία τους ώστε «Όμιλος = Σ πελατών».", "Fix their category so \"Group = Σ clients\".")}
          </div>
        )}

        {/* ── GROUP P&L ── */}
        {loaded && tab === "pnl" && (
          <div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(160px,1fr))", gap: 12, marginBottom: 16 }}>
              {kpi(t("Έσοδα (YTD)", "Revenue (YTD)"), ytd("rev"), P.gn)}
              {kpi(t("Μικτό Κέρδος (YTD)", "Gross Margin (YTD)"), ytd("gm"), ytd("gm") >= 0 ? P.gn : P.rd)}
              {kpi("EBITDA (YTD)", ytd("ebitda"), ytd("ebitda") >= 0 ? P.em : P.rd)}
              {kpi("EBITDA %", ytd("rev") ? ytd("ebitda") / ytd("rev") : null, P.em, true)}
              {kpi(t("Καθαρό (YTD)", "Net (YTD)"), ytd("net"), ytd("net") >= 0 ? P.gn : P.rd)}
            </div>
            <div style={{ background: P.wh, borderRadius: 8, border: "1px solid " + P.bd, overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed", minWidth: 1250 }}>
                <colgroup><col style={{ width: 230 }} />{MONTHS.map(m => <col key={m} style={{ width: 72 }} />)}<col style={{ width: 100 }} /></colgroup>
                <thead><tr>
                  <th style={{ ...thS, textAlign: "left", borderRight: "2px solid #00695C" }}>{t("Γραμμή", "Line")}</th>
                  {MONTHS.map(m => <th key={m} style={thS}>{monthLabel(m)}</th>)}
                  <th style={{ ...thS, background: "#00695C" }}>YTD</th>
                </tr></thead>
                <tbody>
                  {R.map((r, i) => {
                    const yv = ytdNum(r);
                    return (
                      <tr key={r.l + i} style={{ background: r.hl || (r.muted ? "#FAFBFA" : i % 2 === 0 ? P.wh : P.al) }}>
                        <td style={{ padding: "6px 10px", fontSize: r.muted ? 11 : 12, fontStyle: r.muted ? "italic" : "normal", fontWeight: r.b ? 700 : 400, color: r.muted ? P.tm : r.b ? P.em : P.tx, borderBottom: "1px solid " + P.bd, borderRight: "2px solid " + P.bd, whiteSpace: "nowrap" }}>{r.l}</td>
                        {MONTHS.map(m => {
                          if (r.edit) return (
                            <td key={m} style={{ padding: "3px 4px", borderBottom: "1px solid " + P.bd }}>
                              <input type="number" step="0.01" value={fin?.pnl?.[r.k]?.[m] ?? ""} onChange={e => setPnl(r.k, m, e.target.value)} style={inpS} />
                            </td>
                          );
                          const v = cellNum(r, m);
                          const neg = typeof v === "number" && v < 0;
                          const canDrill = DRILLABLE[r.k] && typeof v === "number" && Math.abs(v) > 0.005;
                          return <td key={m} onClick={canDrill ? () => setDrill({ k: r.k, m }) : undefined} title={canDrill ? t("Κλικ: ανάλυση ανά πελάτη", "Click: breakdown by client") : ""} style={{ padding: "6px 6px", textAlign: "right", fontSize: 11, fontWeight: r.b ? 700 : 400, color: r.muted ? P.tm : neg ? P.rd : r.b ? P.em : r.cost ? "#8a5a00" : P.tx, borderBottom: "1px solid " + P.bd, cursor: canDrill ? "pointer" : "default", textDecoration: canDrill ? "underline dotted rgba(0,0,0,.25)" : "none" }}>{v == null ? "-" : showCell(r, v)}</td>;
                        })}
                        <td style={{ padding: "6px 8px", textAlign: "right", fontSize: 12, fontWeight: 700, color: (typeof yv === "number" && yv < 0) ? P.rd : P.em, background: r.hl ? "#C8E6C9" : "#f5f5f5", borderLeft: "2px solid " + P.bd, borderBottom: "1px solid " + P.bd }}>{yv == null ? "-" : showCell(r, yv)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 11, color: P.tm, marginTop: 8, lineHeight: 1.6 }}>
              {t(`Ενοποιημένο για όλους τους πελάτες (${Object.keys(allData || {}).length}) + εταιρικά OPEX/CAPEX. Τα κόστη εμφανίζονται θετικά· τα υποσύνολα (GM, EBITDA, EBIT, Καθαρό) είναι τα καθαρά αποτελέσματα. EBITDA = Μικτό Κέρδος − OPEX. EBIT = EBITDA − Αποσβέσεις. Τόκοι & Φόροι καταχωρούνται χειροκίνητα (αποθηκεύονται αυτόματα).`,
                 `Consolidated across all clients (${Object.keys(allData || {}).length}) + company OPEX/CAPEX. Costs are shown positive; the subtotals (GM, EBITDA, EBIT, Net) are the net results. EBITDA = Gross Margin − OPEX. EBIT = EBITDA − Depreciation. Interest & Taxes are entered manually (saved automatically).`)}
            </div>
          </div>
        )}

        {/* ── BALANCE SHEET ── */}
        {loaded && tab === "bs" && (
          <div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginBottom: 10, alignItems: "center", flexWrap: "wrap" }}>
              <select value={na.section} onChange={e => setNa(x => ({ ...x, section: e.target.value }))} style={{ padding: "6px 10px", border: "1px solid " + P.bd, borderRadius: 6, fontSize: 12, outline: "none" }}>
                {SECTIONS.map(s => <option key={s.k} value={s.k}>{t(s.el, s.en)}</option>)}
              </select>
              <input value={na.label} onChange={e => setNa(x => ({ ...x, label: e.target.value }))} onKeyDown={e => e.key === "Enter" && addAcct()} placeholder={t("Νέος λογαριασμός…", "New account…")} style={{ padding: "6px 10px", border: "1px solid " + P.bd, borderRadius: 6, fontSize: 12, outline: "none", width: 220 }} />
              <button onClick={addAcct} style={{ background: P.em, color: "#fff", border: "none", padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600 }}>+ {t("Λογαριασμός", "Account")}</button>
            </div>
            <div style={{ background: P.wh, borderRadius: 8, border: "1px solid " + P.bd, overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed", minWidth: 1250 }}>
                <colgroup><col style={{ width: 230 }} />{MONTHS.map(m => <col key={m} style={{ width: 72 }} />)}<col style={{ width: 100 }} /><col style={{ width: 34 }} /></colgroup>
                <thead><tr>
                  <th style={{ ...thS, textAlign: "left", borderRight: "2px solid #00695C" }}>{t("Λογαριασμός", "Account")}</th>
                  {MONTHS.map(m => <th key={m} style={thS}>{monthLabel(m)}</th>)}
                  <th style={{ ...thS, background: "#00695C" }}>{t("Τέλος έτους", "Year-end")}</th><th style={thS}></th>
                </tr></thead>
                <tbody>
                  {SECTIONS.map(sec => (
                    <SectionBlock key={sec.k} sec={sec} secLabel={t(sec.el, sec.en)} secShort={t("Σύνολο " + sec.short_el, "Total " + sec.short_en)} autoTag={t("auto", "auto")} derived={derivedIn(sec.k)} manual={manualIn(sec.k)}
                      bsVal={bsVal} setBsVal={setBsVal} renameAcct={renameAcct} delAcct={delAcct} acctTotal={acctTotal}
                      sectionTotal={sectionTotal} inpS={inpS} />
                  ))}
                  {/* Balance check */}
                  <tr style={{ background: "#263238" }}>
                    <td style={{ padding: "8px 10px", fontSize: 12, fontWeight: 700, color: "#fff", borderRight: "2px solid #00695C" }}>{t("Σ Ενεργητικό", "Σ Assets")}</td>
                    {MONTHS.map(m => <td key={m} style={{ padding: "6px 6px", textAlign: "right", fontSize: 11, fontWeight: 700, color: "#A5D6A7" }}>{fmt(totalAssets(m))}</td>)}
                    <td style={{ padding: "6px 8px", textAlign: "right", fontSize: 12, fontWeight: 700, color: "#A5D6A7", borderLeft: "2px solid #00695C" }}>{fmt(totalAssets(MONTHS[MONTHS.length - 1]))}</td>
                    <td style={{ background: "#263238" }}></td>
                  </tr>
                  <tr style={{ background: "#37474F" }}>
                    <td style={{ padding: "8px 10px", fontSize: 12, fontWeight: 700, color: "#fff", borderRight: "2px solid #00695C" }}>{t("Σ Υποχρ. + Ίδια Κεφ.", "Σ Liab. + Equity")}</td>
                    {MONTHS.map(m => <td key={m} style={{ padding: "6px 6px", textAlign: "right", fontSize: 11, fontWeight: 700, color: "#90CAF9" }}>{fmt(totalLE(m))}</td>)}
                    <td style={{ padding: "6px 8px", textAlign: "right", fontSize: 12, fontWeight: 700, color: "#90CAF9", borderLeft: "2px solid #00695C" }}>{fmt(totalLE(MONTHS[MONTHS.length - 1]))}</td>
                    <td style={{ background: "#37474F" }}></td>
                  </tr>
                  <tr style={{ background: P.ep }}>
                    <td style={{ padding: "8px 10px", fontSize: 12, fontWeight: 700, color: P.em, borderRight: "2px solid #00695C" }}>{t("Έλεγχος (πρέπει = 0)", "Check (must = 0)")}</td>
                    {MONTHS.map(m => { const c = check(m); const ok = Math.abs(c) < 1; return <td key={m} style={{ padding: "6px 6px", textAlign: "right", fontSize: 11, fontWeight: 700, color: ok ? P.gn : P.rd }} title={ok ? t("Ισοσκελισμένο", "Balanced") : t("Διαφορά — συμπλήρωσε ταμείο/opening balances", "Difference — fill cash/opening balances")}>{ok ? "✓" : fmt(c)}</td>; })}
                    <td style={{ borderLeft: "2px solid #00695C", background: P.ep }}></td>
                    <td style={{ background: P.ep }}></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 11, color: P.tm, marginTop: 8, lineHeight: 1.6 }}>
              {t("Τιμές = υπόλοιπο τέλους κάθε μήνα. Οι auto γραμμές (Πάγια/AR/AP/ΦΠΑ/Αποτέλεσμα) υπολογίζονται από τα δεδομένα και είναι read-only. Το «Καθαρό ΦΠΑ δουλευμένο» μένει ως υποχρέωση ακόμα κι όταν εξοφληθεί το τιμολόγιο (οφειλή στο κράτος)· όταν αποδίδεις ΦΠΑ, καταχώρησέ το στη χειροκίνητη γραμμή «ΦΠΑ / Φόροι πληρωτέοι» (μειώνει την υποχρέωση) μαζί με τη μείωση του ταμείου. Ο «Έλεγχος» δείχνει τη διαφορά Ενεργητικού − (Υποχρεώσεις + Ίδια Κεφάλαια)· συμπλήρωσε ταμείο/opening balances ώσπου να μηδενίσει.",
                 "Values = closing balance for each month. The auto rows (Fixed assets/AR/AP/VAT/Result) are computed from the data and read-only. 'Net VAT accrued' stays as a liability even after an invoice is paid (owed to the state); when you remit VAT, record it on the manual 'ΦΠΑ / Φόροι πληρωτέοι' line (which reduces the liability) alongside the cash decrease. The 'Check' shows Assets − (Liabilities + Equity); fill cash/opening balances until it hits zero.")}
            </div>
          </div>
        )}

        {/* ── BUDGET vs ACTUAL (annual targets per client) ── */}
        {loaded && tab === "budget" && (() => {
          const rows = Object.entries(allData || {}).map(([name, cd]) => {
            const a = clientActual(cd), b = budgetOf(name);
            const gmPct = a.rev ? (a.gm / a.rev) * 100 : null;
            const revT = Number(b.rev) || 0, gmT = Number(b.gmPct);
            return { name, ...a, gmPct, revT, gmT: (b.gmPct === undefined || b.gmPct === "") ? null : gmT,
              revPct: revT > 0 ? (a.rev / revT) * 100 : null,
              gmDelta: (gmPct != null && b.gmPct !== undefined && b.gmPct !== "") ? gmPct - gmT : null };
          }).filter(r => r.rev !== 0 || r.cost !== 0 || r.revT || r.gmT != null)
            .sort((x, y) => (y.revT || y.rev) - (x.revT || x.rev));
          const totRevT = rows.reduce((s, r) => s + (r.revT || 0), 0);
          const totRevA = rows.reduce((s, r) => s + r.rev, 0);
          const tdS = { padding: "6px 10px", borderBottom: "1px solid " + P.bd, fontSize: 12 };
          const inp = { width: 96, padding: "3px 5px", border: "1px solid " + P.bd, borderRadius: 4, fontSize: 12, textAlign: "right", background: P.ip, outline: "none" };
          const pctColor = (p) => p == null ? P.tm : p >= 100 ? P.gn : p >= 85 ? "#F57F17" : P.rd;
          return (
            <div>
              <div style={{ background: P.wh, borderRadius: 8, border: "1px solid " + P.bd, overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 900 }}>
                  <thead><tr>{[t("Πελάτης", "Client"), t("Στόχος Εσόδων €", "Revenue Target €"), t("Πραγμ. Έσοδα €", "Actual Revenue €"), t("Επίτευξη", "Achieved"), t("Στόχος GM %", "Target GM %"), t("Πραγμ. GM %", "Actual GM %"), t("Διαφορά", "Variance")].map((h, i) => (
                    <th key={i} style={{ padding: "7px 10px", fontSize: 11, fontWeight: 700, color: "#fff", background: P.em, textAlign: i === 0 ? "left" : "right", whiteSpace: "nowrap" }}>{h}</th>
                  ))}</tr></thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={r.name} style={{ background: i % 2 === 0 ? P.wh : P.al }}>
                        <td style={{ ...tdS, fontWeight: 600, color: P.em }}>{r.name}</td>
                        <td style={{ ...tdS, textAlign: "right" }}><input type="number" step="0.01" value={budgetOf(r.name).rev ?? ""} onChange={e => setBudget(r.name, "rev", e.target.value)} style={inp} /></td>
                        <td style={{ ...tdS, textAlign: "right" }}>{fmt(r.rev)}</td>
                        <td style={{ ...tdS, textAlign: "right", fontWeight: 700, color: pctColor(r.revPct) }}>{r.revPct == null ? "—" : Math.round(r.revPct) + "%"}</td>
                        <td style={{ ...tdS, textAlign: "right" }}><input type="number" step="0.1" value={budgetOf(r.name).gmPct ?? ""} onChange={e => setBudget(r.name, "gmPct", e.target.value)} style={{ ...inp, width: 70 }} /></td>
                        <td style={{ ...tdS, textAlign: "right", color: r.gmPct != null && r.gmPct < 0 ? P.rd : P.tx }}>{r.gmPct == null ? "—" : r.gmPct.toFixed(1) + "%"}</td>
                        <td style={{ ...tdS, textAlign: "right", fontWeight: 700, color: r.gmDelta == null ? P.tm : r.gmDelta >= 0 ? P.gn : P.rd }}>{r.gmDelta == null ? "—" : (r.gmDelta >= 0 ? "+" : "") + r.gmDelta.toFixed(1) + t("μον", "pp")}</td>
                      </tr>
                    ))}
                    <tr style={{ background: P.ep, fontWeight: 700 }}>
                      <td style={{ ...tdS, color: P.em }}>{t("Σύνολο", "Total")}</td>
                      <td style={{ ...tdS, textAlign: "right", color: P.em }}>{fmt(totRevT)}</td>
                      <td style={{ ...tdS, textAlign: "right", color: P.em }}>{fmt(totRevA)}</td>
                      <td style={{ ...tdS, textAlign: "right", color: pctColor(totRevT > 0 ? totRevA / totRevT * 100 : null) }}>{totRevT > 0 ? Math.round(totRevA / totRevT * 100) + "%" : "—"}</td>
                      <td colSpan={3}></td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div style={{ fontSize: 11, color: P.tm, marginTop: 8, lineHeight: 1.6 }}>
                {t("Καταχώρησε ετήσιους στόχους εσόδων (€) και μικτού περιθωρίου (GM %) ανά πελάτη. Η «Επίτευξη» = πραγματικά έσοδα / στόχος. Η «Διαφορά» = πραγματικό GM% − στόχος (σε μονάδες). Αποθηκεύεται αυτόματα.",
                   "Enter annual revenue (€) and gross-margin (GM %) targets per client. 'Achieved' = actual revenue / target. 'Variance' = actual GM% − target (in points). Saved automatically.")}
              </div>
            </div>
          );
        })()}

        {/* ── FEE & COP (management fee realization + Contract Operating Profit) ── */}
        {loaded && tab === "fee" && (() => {
          const { rows, T } = feeCopData();
          const underFee = rows.filter(r => r.feeGap != null && r.feeGap < -0.05).length;
          const tdS = { padding: "6px 9px", borderBottom: "1px solid " + P.bd, fontSize: 12, textAlign: "right", whiteSpace: "nowrap" };
          const inp = { width: 62, padding: "3px 5px", border: "1px solid " + P.bd, borderRadius: 4, fontSize: 12, textAlign: "right", background: P.ip, outline: "none" };
          const H = ["Πελάτης|Client", "Έσοδα €|Revenue €", "Υπεργ. κόστος €|Sub cost €", "Mgmt Fee €|Mgmt Fee €", "Effective %|Effective %", "Συμβατικό %|Contracted %", "Δ|Δ", "GM €|GM €", "Κατ. OPEX €|Alloc. OPEX €", "COP €|COP €", "COP %|COP %"];
          return (
            <div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(160px,1fr))", gap: 12, marginBottom: 14 }}>
                {kpi(t("Σύνολο Mgmt Fee", "Total Mgmt Fee"), T.fee, P.em)}
                {kpi(t("Effective Fee %", "Effective Fee %"), T.cost ? T.fee / T.cost : null, P.em, true)}
                {kpi(t("Σύνολο COP", "Total COP"), T.cop, T.cop >= 0 ? P.gn : P.rd)}
                {kpi("COP %", T.rev ? T.cop / T.rev : null, P.em, true)}
              </div>
              {underFee > 0 && (
                <div style={{ background: "#FFF8E1", border: "1px solid #F5D76E", borderRadius: 8, padding: "9px 14px", marginBottom: 12, fontSize: 12, color: "#7A5B00" }}>
                  ⚠️ {underFee} {t("πελάτες με realized fee κάτω από το συμβατικό — έλεγξε fee leakage.", "clients realizing a fee below the contracted rate — check for fee leakage.")}
                </div>
              )}
              <div style={{ background: P.wh, borderRadius: 8, border: "1px solid " + P.bd, overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1050 }}>
                  <thead><tr>{H.map((h, i) => (<th key={i} style={{ padding: "7px 9px", fontSize: 10.5, fontWeight: 700, color: "#fff", background: P.em, textAlign: i === 0 ? "left" : "right", whiteSpace: "nowrap" }}>{t(h.split("|")[0], h.split("|")[1])}</th>))}</tr></thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={r.name} style={{ background: i % 2 === 0 ? P.wh : P.al }}>
                        <td style={{ ...tdS, textAlign: "left", fontWeight: 600, color: P.em }}>{r.name}</td>
                        <td style={tdS}>{fmt(r.rev)}</td>
                        <td style={tdS}>{fmt(r.cost)}</td>
                        <td style={{ ...tdS, fontWeight: 600, color: P.em }}>{fmt(r.fee)}</td>
                        <td style={tdS}>{r.effFee == null ? "—" : r.effFee.toFixed(1) + "%"}</td>
                        <td style={tdS}><input type="number" step="0.1" value={budgetOf(r.name).feePct ?? ""} onChange={e => setBudget(r.name, "feePct", e.target.value)} placeholder="5" style={inp} /></td>
                        <td style={{ ...tdS, fontWeight: 700, color: r.feeGap == null ? P.tm : r.feeGap >= 0 ? P.gn : P.rd }}>{r.feeGap == null ? "—" : (r.feeGap >= 0 ? "+" : "") + r.feeGap.toFixed(1)}</td>
                        <td style={{ ...tdS, color: r.gm < 0 ? P.rd : P.tx }}>{fmt(r.gm)}</td>
                        <td style={{ ...tdS, color: P.tm }}>{fmt(r.alloc)}</td>
                        <td style={{ ...tdS, fontWeight: 700, color: r.cop >= 0 ? P.em : P.rd }}>{fmt(r.cop)}</td>
                        <td style={{ ...tdS, color: r.copPct != null && r.copPct < 0 ? P.rd : P.tm }}>{r.copPct == null ? "—" : r.copPct.toFixed(1) + "%"}</td>
                      </tr>
                    ))}
                    <tr style={{ background: P.ep, fontWeight: 700 }}>
                      <td style={{ ...tdS, textAlign: "left", color: P.em }}>{t("Σύνολο", "Total")}</td>
                      <td style={{ ...tdS, color: P.em }}>{fmt(T.rev)}</td>
                      <td style={{ ...tdS, color: P.em }}>{fmt(T.cost)}</td>
                      <td style={{ ...tdS, color: P.em }}>{fmt(T.fee)}</td>
                      <td style={{ ...tdS, color: P.em }}>{T.cost ? (T.fee / T.cost * 100).toFixed(1) + "%" : "—"}</td>
                      <td colSpan={2}></td>
                      <td style={{ ...tdS, color: P.em }}>{fmt(T.gm)}</td>
                      <td style={{ ...tdS, color: P.em }}>{fmt(totalOpex)}</td>
                      <td style={{ ...tdS, color: T.cop >= 0 ? P.em : P.rd }}>{fmt(T.cop)}</td>
                      <td style={{ ...tdS, color: P.em }}>{T.rev ? (T.cop / T.rev * 100).toFixed(1) + "%" : "—"}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div style={{ fontSize: 11, color: P.tm, marginTop: 8, lineHeight: 1.6 }}>
                {t("Mgmt Fee = αμοιβή CBRE επί του κόστους υπεργολάβων (cbre_fee ή κόστος × fee %). Effective % = Fee / κόστος υπεργ. Συμπλήρωσε το «Συμβατικό %» ανά πελάτη (π.χ. 5% cost-plus) — το «Δ» δείχνει fee leakage. COP = GM − κατανεμημένο εταιρικό OPEX (pro-rata εσόδων). Αποθηκεύεται αυτόματα.",
                   "Mgmt Fee = CBRE fee on subcontractor cost (cbre_fee, or cost × fee %). Effective % = Fee / sub cost. Enter the 'Contracted %' per client (e.g. 5% cost-plus) — 'Δ' shows fee leakage. COP = GM − allocated company OPEX (pro-rata by revenue). Saved automatically.")}
              </div>
            </div>
          );
        })()}

        {/* ── CASH FLOW (direct monthly forecast + running balance) ── */}
        {loaded && tab === "cash" && (() => {
          const s = cashFlowSeries();
          const by = Object.fromEntries(s.map(r => [r.m, r]));
          const sum = k => s.reduce((a, r) => a + r[k], 0);
          const minClose = Math.min(...s.map(r => r.close));
          const endClose = s.length ? s[s.length - 1].close : 0;
          const R = [
            { k: "collIn", l: t("Εισπράξεις πελατών (AR)", "Client collections (AR)"), sign: 1 },
            { k: "payOut", l: t("Πληρωμές προμηθευτών (AP)", "Supplier payments (AP)"), sign: -1 },
            { k: "lab", l: t("Μισθοδοσία", "Payroll"), sign: -1 },
            { k: "opx", l: t("Λειτουργικά (OPEX)", "Operating (OPEX)"), sign: -1 },
            { k: "cpx", l: t("Επενδύσεις (CAPEX)", "Capex"), sign: -1 },
            { k: "intr", l: t("Τόκοι", "Interest"), sign: -1 },
            { k: "tax", l: t("Φόροι", "Taxes"), sign: -1 },
          ];
          const thC = { ...thS, textAlign: "right" };
          const cell = { padding: "6px 6px", textAlign: "right", fontSize: 11, borderBottom: "1px solid " + P.bd, whiteSpace: "nowrap" };
          return (
            <div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(170px,1fr))", gap: 12, marginBottom: 14 }}>
                <div style={{ background: P.wh, border: "1px solid " + P.bd, borderRadius: 10, padding: "12px 14px" }}>
                  <div style={{ fontSize: 11, color: P.tm }}>{t("Ταμείο έναρξης", "Opening cash")}</div>
                  <input type="number" step="0.01" value={fin?.cashOpening ?? 0} onChange={e => mutate(n => { n.cashOpening = parseFloat(e.target.value) || 0; })} style={{ width: "100%", marginTop: 5, padding: "6px 8px", border: "1px solid " + P.bd, borderRadius: 6, fontSize: 16, fontWeight: 800, color: P.em, background: P.ip, outline: "none", boxSizing: "border-box" }} />
                </div>
                {kpi(t("Ταμείο τέλους έτους", "Year-end cash"), endClose, endClose >= 0 ? P.gn : P.rd)}
                {kpi(t("Χαμηλότερο ταμείο", "Lowest cash point"), minClose, minClose >= 0 ? P.em : P.rd)}
                <div style={{ background: minClose < 0 ? "#FDECEA" : P.wh, border: "1px solid " + (minClose < 0 ? P.rd : P.bd), borderRadius: 10, padding: "12px 14px" }}>
                  <div style={{ fontSize: 11, color: P.tm }}>{t("Όροι πληρωμής (lag)", "Payment terms (lag)")}</div>
                  <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
                    {[{ v: 0, l: "0" }, { v: 30, l: "30" }, { v: 60, l: "60" }].map(o => (
                      <button key={o.v} onClick={() => setCashTerms(o.v)} style={{ flex: 1, padding: "5px 0", border: "1px solid " + P.bd, borderRadius: 5, cursor: "pointer", fontSize: 11, fontWeight: cashTerms === o.v ? 700 : 400, background: cashTerms === o.v ? P.em : P.wh, color: cashTerms === o.v ? "#fff" : P.tx }}>{o.l}</button>
                    ))}
                  </div>
                </div>
              </div>
              {minClose < 0 && (
                <div style={{ background: "#FDECEA", border: "1px solid " + P.rd, borderRadius: 8, padding: "9px 14px", marginBottom: 12, fontSize: 12, color: P.rd, fontWeight: 600 }}>
                  ⚠️ {t("Το ταμείο γίνεται αρνητικό σε κάποιον μήνα — κίνδυνος ρευστότητας. Δες τα κόκκινα «Ταμείο τέλους».", "Cash goes negative in some month — liquidity risk. See the red 'Closing cash' cells.")}
                </div>
              )}
              <div style={{ background: P.wh, borderRadius: 8, border: "1px solid " + P.bd, overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed", minWidth: 1250 }}>
                  <colgroup><col style={{ width: 220 }} />{MONTHS.map(m => <col key={m} style={{ width: 72 }} />)}<col style={{ width: 100 }} /></colgroup>
                  <thead><tr><th style={{ ...thS, textAlign: "left", borderRight: "2px solid #00695C" }}>{t("Γραμμή", "Line")}</th>{MONTHS.map(m => <th key={m} style={thC}>{monthLabel(m)}</th>)}<th style={{ ...thC, background: "#00695C" }}>{t("Σύνολο", "Total")}</th></tr></thead>
                  <tbody>
                    {R.map((r, i) => (
                      <tr key={r.k} style={{ background: i % 2 === 0 ? P.wh : P.al }}>
                        <td style={{ padding: "6px 10px", fontSize: 12, borderBottom: "1px solid " + P.bd, borderRight: "2px solid " + P.bd, whiteSpace: "nowrap", color: r.sign < 0 ? "#8a5a00" : P.tx }}>{r.l}</td>
                        {MONTHS.map(m => { const v = r.sign * by[m][r.k]; return <td key={m} style={{ ...cell, color: v < 0 ? P.rd : P.tx }}>{by[m][r.k] ? fmt(v) : "-"}</td>; })}
                        <td style={{ ...cell, fontWeight: 700, background: "#f5f5f5", borderLeft: "2px solid " + P.bd, color: r.sign < 0 ? "#8a5a00" : P.em }}>{fmt(r.sign * sum(r.k))}</td>
                      </tr>
                    ))}
                    <tr style={{ background: P.ep }}>
                      <td style={{ padding: "7px 10px", fontSize: 12, fontWeight: 700, color: P.em, borderRight: "2px solid #00695C" }}>{t("Καθαρή ταμειακή ροή", "Net cash flow")}</td>
                      {MONTHS.map(m => <td key={m} style={{ ...cell, fontWeight: 700, color: by[m].net < 0 ? P.rd : P.em }}>{fmt(by[m].net)}</td>)}
                      <td style={{ ...cell, fontWeight: 700, background: "#C8E6C9", borderLeft: "2px solid #00695C", color: sum("net") < 0 ? P.rd : P.em }}>{fmt(sum("net"))}</td>
                    </tr>
                    <tr style={{ background: "#263238" }}>
                      <td style={{ padding: "8px 10px", fontSize: 12, fontWeight: 700, color: "#fff", borderRight: "2px solid #00695C" }}>{t("Ταμείο τέλους μήνα", "Closing cash")}</td>
                      {MONTHS.map(m => <td key={m} style={{ ...cell, fontWeight: 700, color: by[m].close < 0 ? "#FF8A80" : "#A5D6A7" }}>{fmt(by[m].close)}</td>)}
                      <td style={{ ...cell, fontWeight: 700, borderLeft: "2px solid #00695C", color: endClose < 0 ? "#FF8A80" : "#A5D6A7" }}>{fmt(endClose)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div style={{ fontSize: 11, color: P.tm, marginTop: 8, lineHeight: 1.6 }}>
                {t("Άμεση μέθοδος. Οι εισπράξεις/πληρωμές χρονίζονται: πληρωμένα τιμολόγια στον μήνα του paid_date· ανοιχτά στον μήνα έκδοσης + καθυστέρηση όρων. Μισθοδοσία/OPEX/CAPEX/τόκοι/φόροι ταμειακά στον μήνα καταχώρησης. Ταμείο τέλους = ταμείο έναρξης + σωρευτική καθαρή ροή. Αποθηκεύεται αυτόματα.",
                   "Direct method. Collections/payments are timed: paid invoices in their paid_date month; open invoices in issue month + terms lag. Payroll/OPEX/CAPEX/interest/tax are cash in their booked month. Closing cash = opening + cumulative net. Saved automatically.")}
              </div>
            </div>
          );
        })()}
      </div>

      {/* Drill-down: per-client breakdown of a P&L cell (revenue / sub cost / labour / GM for one month) */}
      {drill && (() => {
        const rows = drillRows(drill.k, drill.m);
        const total = rows.reduce((s, r) => s + r.val, 0);
        const maxAbs = Math.max(1, ...rows.map(r => Math.abs(r.val)));
        const label = (R.find(r => r.k === drill.k) || {}).l || drill.k;
        return (
          <div onClick={() => setDrill(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", zIndex: 1400, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
            <div onClick={e => e.stopPropagation()} style={{ background: P.wh, borderRadius: 10, width: "min(560px,96vw)", maxHeight: "82vh", overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: "0 20px 60px rgba(0,0,0,.35)" }}>
              <div style={{ background: P.em, color: "#fff", padding: "12px 18px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{label} — {monthLabel(drill.m)}</div>
                <button onClick={() => setDrill(null)} style={{ background: "rgba(255,255,255,.2)", border: "none", color: "#fff", width: 26, height: 26, borderRadius: 6, cursor: "pointer", fontSize: 15 }}>×</button>
              </div>
              <div style={{ padding: "8px 18px 16px", overflowY: "auto" }}>
                {rows.length === 0 ? <div style={{ padding: 24, textAlign: "center", color: P.tm, fontSize: 13 }}>{t("Καμία κίνηση αυτόν τον μήνα", "No activity this month")}</div> : (
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                    <tbody>
                      {rows.map(r => { const neg = r.val < 0; return (
                        <tr key={r.name} style={{ borderBottom: "1px solid " + P.bd }}>
                          <td style={{ padding: "7px 6px", fontWeight: 600, color: P.em, whiteSpace: "nowrap" }}>{r.name}</td>
                          <td style={{ padding: "7px 6px", width: "45%" }}>
                            <div style={{ background: "#eef2ef", borderRadius: 3, height: 8, overflow: "hidden" }}>
                              <div style={{ width: (Math.abs(r.val) / maxAbs * 100) + "%", height: "100%", background: neg ? P.rd : P.em }} />
                            </div>
                          </td>
                          <td style={{ padding: "7px 6px", textAlign: "right", fontWeight: 600, color: neg ? P.rd : P.tx, whiteSpace: "nowrap" }}>{fmt(r.val)}</td>
                          <td style={{ padding: "7px 6px", textAlign: "right", color: P.tm, width: 52, whiteSpace: "nowrap" }}>{total ? Math.round(r.val / total * 100) + "%" : "-"}</td>
                        </tr>
                      ); })}
                    </tbody>
                    <tfoot>
                      <tr style={{ background: P.ep }}>
                        <td style={{ padding: "8px 6px", fontWeight: 700, color: P.em }}>{t("Σύνολο", "Total")}</td>
                        <td></td>
                        <td style={{ padding: "8px 6px", textAlign: "right", fontWeight: 700, color: total < 0 ? P.rd : P.em, whiteSpace: "nowrap" }}>{fmt(total)}</td>
                        <td></td>
                      </tr>
                    </tfoot>
                  </table>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// One balance-sheet section (Assets / Liabilities / Equity): heading, auto-derived rows,
// editable manual rows, then the section subtotal.
function SectionBlock({ sec, secLabel, secShort, autoTag, derived, manual, bsVal, setBsVal, renameAcct, delAcct, acctTotal, sectionTotal, inpS }) {
  return (
    <>
      <tr style={{ background: "#00695C" }}>
        <td colSpan={MONTHS.length + 3} style={{ padding: "6px 10px", fontSize: 12, fontWeight: 700, color: "#fff" }}>{secLabel}</td>
      </tr>
      {derived.map((d, i) => (
        <tr key={"d" + i} style={{ background: "#F1F5F3" }}>
          <td style={{ padding: "5px 10px", fontSize: 11.5, fontStyle: "italic", color: P.tm, borderBottom: "1px solid " + P.bd, borderRight: "2px solid " + P.bd, whiteSpace: "nowrap" }}>{d.label} <span style={{ fontSize: 9, background: P.ep, color: P.em, padding: "0 5px", borderRadius: 6, fontStyle: "normal", fontWeight: 700 }}>{autoTag}</span></td>
          {MONTHS.map(m => { const v = d.fn(m); return <td key={m} style={{ padding: "5px 6px", textAlign: "right", fontSize: 11, color: v ? P.tx : P.tm, borderBottom: "1px solid " + P.bd }}>{v ? fmt(v) : "-"}</td>; })}
          <td style={{ padding: "5px 8px", textAlign: "right", fontSize: 11, fontWeight: 600, color: P.em, background: "#f5f5f5", borderLeft: "2px solid " + P.bd, borderBottom: "1px solid " + P.bd }}>{fmt(d.fn(MONTHS[MONTHS.length - 1]))}</td>
          <td style={{ borderBottom: "1px solid " + P.bd }}></td>
        </tr>
      ))}
      {manual.map((a, i) => (
        <tr key={a.id} style={{ background: i % 2 === 0 ? P.wh : P.al }}>
          <td style={{ padding: "3px 6px", borderBottom: "1px solid " + P.bd, borderRight: "2px solid " + P.bd }}>
            <input value={a.label} onChange={e => renameAcct(a.id, e.target.value)} style={{ width: "100%", border: "none", background: "transparent", fontSize: 11.5, outline: "none" }} />
          </td>
          {MONTHS.map(m => (
            <td key={m} style={{ padding: "3px 4px", borderBottom: "1px solid " + P.bd }}>
              <input type="number" step="0.01" value={bsVal(a.id, m)} onChange={e => setBsVal(a.id, m, e.target.value)} style={inpS} />
            </td>
          ))}
          <td style={{ padding: "5px 8px", textAlign: "right", fontSize: 11, fontWeight: 600, color: P.em, background: "#f5f5f5", borderLeft: "2px solid " + P.bd, borderBottom: "1px solid " + P.bd }}>{fmt(acctTotal(a.id))}</td>
          <td style={{ textAlign: "center", borderBottom: "1px solid " + P.bd }}><button onClick={() => delAcct(a.id)} style={{ background: "none", border: "none", color: P.rd, cursor: "pointer", fontSize: 14 }}>×</button></td>
        </tr>
      ))}
      <tr style={{ background: P.ep }}>
        <td style={{ padding: "6px 10px", fontSize: 11.5, fontWeight: 700, color: P.em, borderRight: "2px solid #00695C" }}>{secShort}</td>
        {MONTHS.map(m => <td key={m} style={{ padding: "5px 6px", textAlign: "right", fontSize: 11, fontWeight: 700, color: P.em }}>{fmt(sectionTotal(sec.k, m))}</td>)}
        <td style={{ padding: "5px 8px", textAlign: "right", fontSize: 11, fontWeight: 700, color: P.em, background: "#C8E6C9", borderLeft: "2px solid #00695C" }}>{fmt(sectionTotal(sec.k, MONTHS[MONTHS.length - 1]))}</td>
        <td style={{ background: P.ep }}></td>
      </tr>
    </>
  );
}

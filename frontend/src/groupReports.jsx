// Company-wide (consolidated) monthly reports for finance/admin:
//   • Group P&L   — all clients' revenue/cost/labour + company OPEX/CAPEX → GM → EBITDA → EBIT → Net.
//   • Balance Sheet — monthly closing balances per account. Fixed assets (NBV), trade AR/AP and
//     retained earnings are auto-derived from the data; the rest are maintained by hand.
// P&L manual rows (interest/tax) and the balance-sheet accounts live in the finance_data blob
// (same store as OPEX/CAPEX) — we load the whole blob and save it back, preserving opex/capex.
import { useState, useEffect, useRef } from "react";
import { api } from "./api.js";
import { P, MONTHS, ML, YEARS, uid, fmt, fPct, normalizeClientData, remapMonth, REV_CATS, COST_CATS } from "./constants.js";
import { groupPnLSeries, nbvAtMonth, monthIdx } from "./calc.js";
import { exportWorkbook } from "./exportXlsx.js";

const normYear = (d) => Object.fromEntries(Object.entries(d || {}).map(([c, cd]) => [c, normalizeClientData(cd)]));
// Remap a finance blob's month-keyed fields (opex actual/budget, pnl interest/tax, capex start month)
// onto the ACTIVE fiscal year — lossless for YTD sums — so a prior-year blob lines up with MONTHS when
// computing the board's YoY comparatives. Mirrors normalizeClientData's month healing for client data.
const remapFinMonths = (d) => {
  if (!d || typeof d !== "object") return {};
  const remapCatMap = (obj) => {
    if (!obj || typeof obj !== "object") return obj;
    const out = {};
    for (const [cat, byM] of Object.entries(obj)) {
      if (byM && typeof byM === "object") { out[cat] = {}; for (const [m, v] of Object.entries(byM)) { const tk = remapMonth(m); out[cat][tk] = (out[cat][tk] || 0) + (Number(v) || 0); } }
      else out[cat] = byM;
    }
    return out;
  };
  const remapFlat = (obj) => {
    if (!obj || typeof obj !== "object") return obj;
    const out = {}; for (const [m, v] of Object.entries(obj)) { const tk = remapMonth(m); out[tk] = (out[tk] || 0) + (Number(v) || 0); } return out;
  };
  const out = { ...d };
  if (out.opex) out.opex = { ...out.opex, actual: remapCatMap(out.opex.actual), budget: remapCatMap(out.opex.budget) };
  if (out.pnl) out.pnl = { ...out.pnl, interest: remapFlat(out.pnl.interest), tax: remapFlat(out.pnl.tax) };
  if (Array.isArray(out.capex)) out.capex = out.capex.map(it => (it && typeof it === "object" ? { ...it, month: remapMonth(it.month) } : it));
  return out;
};
import { Skeleton, AppHeader } from "./ui.jsx";
import { useT, monthLabel } from "./i18n.jsx";

const grossAmt = r => Number(r.total) || ((Number(r.amt) || 0) + (Number(r.vat) || 0)) || Number(r.amt) || 0;
const isPaid = r => r.paid === "paid" || r.paid === true;
// Recorded partial payments (gross, dated) on an AR/AP row; legacy rows have none.
const rowPayments = r => Array.isArray(r.payments) ? r.payments : [];

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
  const [tab, setTab] = useState(() => { try { return localStorage.getItem("mf_group_tab") || "pnl"; } catch { return "pnl"; } }); // pnl | bs | budget | fee | cash | mec — persisted
  const [saveState, setSaveState] = useState("idle");
  const [na, setNa] = useState({ label: "", section: "asset" });
  const [drill, setDrill] = useState(null);    // { k, m } → per-client breakdown modal for a P&L cell
  const [cashTerms, setCashTerms] = useState(30); // payment-terms lag (days) for the cash-flow forecast
  const [closeMonth, setCloseMonth] = useState(null); // MEC: which month is being closed (null → default last active)
  const [compact, setCompact] = useState(false);       // number format: false = full (2dp), true = whole units
  const [pnlView, setPnlView] = useState("months");    // months | board (board = YTD Actual/Budget/Prior comparatives)
  const [prev, setPrev] = useState(null);              // prior-FY { series } for YoY comparatives
  const verRef = useRef(0);
  const dirtyRef = useRef(false);

  // Normalize a getFinanceData response into state + record the server version (shared by load + 409 reload).
  const hydrateFin = (fr) => {
    verRef.current = (fr && fr.version) || 0;
    const d = (fr && fr.data) || {};
    if (!d.pnl) d.pnl = {};
    if (!d.pnl.interest) d.pnl.interest = {};
    if (!d.pnl.tax) d.pnl.tax = {};
    if (!d.bs || !Array.isArray(d.bs.accounts) || !d.bs.accounts.length) d.bs = mkDefaultBS();
    if (!d.bs.values) d.bs.values = {};
    if (!d.budgets || typeof d.budgets !== "object") d.budgets = {}; // { [client]: { rev, gmPct } } annual targets
    if (d.cashOpening == null) d.cashOpening = 0; // opening cash balance for the cash-flow forecast
    if (!d.close || typeof d.close !== "object") d.close = {}; // MEC: { [client]: { [month]: {status,reconciled,reviewed,by,at} } }
    setFin(d); dirtyRef.current = false;
  };

  useEffect(() => {
    let cancelled = false; setLoaded(false); setPrev(null);
    (async () => {
      const [cd, fr] = await Promise.all([
        api.getYearData(year).catch(() => ({})),
        api.getFinanceData(year).catch(() => null),
      ]);
      if (cancelled) return;
      setAllData(normYear(cd));
      hydrateFin(fr); setSaveState("idle"); setLoaded(true);
    })();
    // Prior fiscal year (for the board summary's YoY column) — best-effort, doesn't block the screen.
    const pn = parseInt(String(year).replace(/\D/g, ""), 10) - 1; const py = `FY${pn}`;
    if (YEARS.includes(py)) {
      (async () => {
        const [pcd, pfr] = await Promise.all([api.getYearData(py).catch(() => ({})), api.getFinanceData(py).catch(() => null)]);
        if (cancelled) return;
        // groupPnLSeries filters by the ACTIVE FY's month keys, so prior-year data must be remapped onto
        // those keys first (lossless for the YTD totals the board uses) — otherwise every Prior line is 0.
        setPrev({ series: groupPnLSeries(normYear(pcd || {}), remapFinMonths((pfr && pfr.data) || {}), MONTHS) });
      })();
    }
    return () => { cancelled = true; };
  // eslint-disable-next-line
  }, [year]);

  // Auto-save the whole finance blob (opex/capex preserved because we loaded it all).
  useEffect(() => {
    if (!loaded || !fin || !dirtyRef.current) return;
    setSaveState("saving");
    const t = setTimeout(async () => {
      try { const r = await api.saveFinanceData(year, fin, verRef.current); verRef.current = (r && r.version) || verRef.current + 1; dirtyRef.current = false; setSaveState("saved"); }
      catch (e) {
        // 409 = another finance/admin user saved this year first (routine at month-end close). Never
        // silently diverge: reload the latest server copy so the user re-applies onto current data.
        if (e && e.status === 409) {
          dirtyRef.current = false; setSaveState("error");
          alert(t("⚠️ Τα δεδομένα του Ομίλου ενημερώθηκαν από άλλον χρήστη.\n\nΘα φορτωθεί η τελευταία έκδοση — οι πολύ πρόσφατες αλλαγές σου ΔΕΝ αποθηκεύτηκαν, ξαναπέρασέ τες.", "⚠️ The Group data was updated by another user.\n\nThe latest version will load — your most recent edits were NOT saved, please re-apply them."));
          const fr = await api.getFinanceData(year).catch(() => null);
          hydrateFin(fr); setSaveState("idle");
        } else { setSaveState("error"); console.warn("group finance save failed", e); }
      }
    }, 600);
    return () => clearTimeout(t);
  // eslint-disable-next-line
  }, [fin, loaded, year]);

  const mutate = (fn) => { dirtyRef.current = true; setFin(p => { const n = JSON.parse(JSON.stringify(p)); fn(n); return n; }); };
  const F = (n) => fmt(n, compact);   // money formatter honoring the compact (whole-units) toggle
  useEffect(() => { try { localStorage.setItem("mf_group_tab", tab); } catch { /* ignore */ } }, [tab]);

  const series = loaded ? groupPnLSeries(allData, fin, MONTHS) : MONTHS.map(m => ({ m, rev: 0, sub: 0, labour: 0, gm: 0, opex: 0, ebitda: 0, da: 0, ebit: 0, interest: 0, tax: 0, net: 0 }));
  const byMonth = Object.fromEntries(series.map(r => [r.m, r]));
  const ytd = k => series.reduce((s, r) => s + (r[k] || 0), 0);

  // Board summary: YTD Actual vs Budget vs Prior-Year per P&L line (for the month-end / board pack).
  const boardData = () => {
    const A = k => ytd(k);
    const Pr = k => prev ? prev.series.reduce((s, r) => s + (r[k] || 0), 0) : null;
    const budgets = fin?.budgets || {};
    const revB = Object.values(budgets).reduce((s, b) => s + (Number(b.rev) || 0), 0);
    const gmB = Object.values(budgets).reduce((s, b) => s + ((Number(b.rev) || 0) * (Number(b.gmPct) || 0) / 100), 0);
    const cats = fin?.opex?.cats || [], bud = fin?.opex?.budget || {};
    const opexB = cats.reduce((s, c) => s + MONTHS.reduce((s2, m) => s2 + (Number(bud[c.id]?.[m]) || 0), 0), 0);
    const hasB = revB > 0;
    const pr = (k) => prev ? Pr(k) : null;
    return [
      { l: t("Έσοδα", "Revenue"), actual: A("rev"), budget: hasB ? revB : null, prior: pr("rev") },
      { l: t("Κόστος (υπεργ. + εργ.)", "Cost (sub + labour)"), actual: A("sub") + A("labour"), budget: hasB ? revB - gmB : null, prior: prev ? Pr("sub") + Pr("labour") : null, cost: true },
      { l: t("Μικτό Κέρδος", "Gross Margin"), actual: A("gm"), budget: hasB ? gmB : null, prior: pr("gm"), b: true },
      { l: "GM %", actual: A("rev") ? A("gm") / A("rev") : null, budget: hasB ? gmB / revB : null, prior: (prev && Pr("rev")) ? Pr("gm") / Pr("rev") : null, pct: true },
      { l: "OPEX", actual: A("opex"), budget: opexB || null, prior: pr("opex"), cost: true },
      { l: "EBITDA", actual: A("ebitda"), budget: hasB ? gmB - opexB : null, prior: pr("ebitda"), b: true },
      { l: "EBITDA %", actual: A("rev") ? A("ebitda") / A("rev") : null, budget: (hasB) ? (gmB - opexB) / revB : null, prior: (prev && Pr("rev")) ? Pr("ebitda") / Pr("rev") : null, pct: true },
      { l: t("Αποσβέσεις", "D&A"), actual: A("da"), budget: null, prior: pr("da"), cost: true },
      { l: "EBIT", actual: A("ebit"), budget: null, prior: pr("ebit"), b: true },
      { l: t("Τόκοι", "Interest"), actual: A("interest"), budget: null, prior: pr("interest"), cost: true },
      { l: t("Φόροι", "Taxes"), actual: A("tax"), budget: null, prior: pr("tax"), cost: true },
      { l: t("Καθαρό Αποτέλεσμα", "Net result"), actual: A("net"), budget: null, prior: pr("net"), b: true },
    ];
  };

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
    // Honour an explicit 0% fee (pure pass-through) — only default to 5% when fee_pct is truly absent.
    const fp = (i.fee_pct === undefined || i.fee_pct === null || i.fee_pct === "") ? 5 : Number(i.fee_pct);
    const fee = (i.cbre_fee != null && i.cbre_fee !== "") ? Number(i.cbre_fee) : fp * amt / 100;
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
    // Expected settlement month, clamped INTO the fiscal year: an invoice whose due month falls past
    // December lands its cash in the last month rather than silently vanishing from the forecast.
    const shift = (m, n) => { const i = MONTHS.indexOf(m); return i < 0 ? null : MONTHS[Math.min(i + n, MONTHS.length - 1)]; };
    const paidMonthOf = (i) => { const pm = i.paid_date ? String(i.paid_date).slice(0, 7) : null; return (pm && MONTHS.includes(pm)) ? pm : null; };
    // Split an invoice's gross into dated cash movements: each recorded partial payment lands in ITS OWN
    // month; whatever is still outstanding settles at the closure month (paid) or the terms-based expected
    // month (open). Out-of-year payments still reduce the residual but produce no in-year movement.
    const cashEvents = (i) => {
      const gross = grossAmt(i), events = [];
      let allocated = 0;
      rowPayments(i).forEach(p => {
        const amt = Number(p.amount) || 0; if (amt <= 0) return;
        allocated += amt;
        const pm = p.date ? String(p.date).slice(0, 7) : null;
        if (pm && MONTHS.includes(pm)) events.push([pm, amt]);
      });
      const residual = gross - allocated;
      if (Math.abs(residual) > 0.005) {
        const rm = isPaid(i) ? (paidMonthOf(i) || shift(i.month, termsM)) : shift(i.month, termsM);
        if (rm) events.push([rm, residual]);
      }
      return events;
    };
    const z = () => { const o = {}; MONTHS.forEach(m => o[m] = 0); return o; };
    const collIn = z(), payOut = z(), lab = z(), opx = z(), cpx = z(), intr = z(), tax = z();
    Object.values(allData || {}).forEach(cd => {
      (cd?.inv || []).forEach(i => { if (!isActual(i)) return; cashEvents(i).forEach(([m, a]) => { collIn[m] += a; }); });
      (cd?.sub || []).forEach(i => { if (!isActual(i)) return; cashEvents(i).forEach(([m, a]) => { payOut[m] += a; }); });
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

  // ── Month-end close (MEC) ──
  const CLOSE_STATES = { draft: { el: "Draft", en: "Draft", c: "#78909C", bg: "#ECEFF1" }, reconciled: { el: "Συμφωνημένο", en: "Reconciled", c: "#F57F17", bg: "#FFF8E1" }, closed: { el: "Κλεισμένο", en: "Closed", c: "#2E7D32", bg: "#E8F5E9" } };
  const closeOf = (client, m) => fin?.close?.[client]?.[m] || {};
  const setClose = (client, m, patch) => mutate(n => {
    if (!n.close[client]) n.close[client] = {};
    const cur = n.close[client][m] || { status: "draft" };
    const next = { ...cur, ...patch };
    if (patch.status === "closed" && cur.status !== "closed") { next.by = user?.name || user?.user || ""; next.at = new Date().toISOString().slice(0, 10); }
    if (patch.status && patch.status !== "closed") { next.by = ""; next.at = ""; }
    n.close[client][m] = next;
  });
  // Auto data-presence signals for a client in a month (helps the reviewer verify completeness).
  const closeSignals = (cd, m) => ({
    ar: (cd?.inv || []).some(i => i.month === m),
    ap: (cd?.sub || []).some(i => i.month === m),
    lab: cd?.lab?.[m] && Object.values(cd.lab[m]).some(v => Number(v)),
  });

  // ── Balance-sheet derived lines (read-only) ──
  const nbvByMonth = {}, arByMonth = {}, apByMonth = {}, cumNet = {}, vatNetByMonth = {};
  const accrIncByMonth = {}, accrCostByMonth = {};
  let run = 0, accrIncRun = 0, accrCostRun = 0;
  // Only capitalised assets carry NBV/depreciation — Planned/Approved aren't on the books yet.
  const onBooks = it => it && it.status !== "Planned" && it.status !== "Approved";
  const isActual = i => (i.act_acc || "").toUpperCase() !== "ACCRUAL"; // accruals aren't trade AR/AP
  // Derive VAT from the SAME gross used for AR/AP (gross − net) so the balance identity
  // AR(gross) = equity(net) + VAT holds even when a stored row has total ≠ amt + vat.
  const vatOf = i => grossAmt(i) - (Number(i.amt) || 0);
  // Outstanding gross balance at the END of month `m`: issued on/before m, less any settlement up to m.
  // Recorded partial payments dated on/before m reduce it; a full `paid` flag with a date on/before m
  // closes it entirely. Paid but WITHOUT a usable date (legacy/imported/bulk-set rows) → kept fully OPEN
  // rather than silently dropped: its net still sits in equity via cumNet, so removing the matching AR/AP
  // asset would leave the balance sheet off by net+VAT with no visible cause. It surfaces in the aging
  // ledger as outstanding, prompting the user to stamp the real settlement date.
  const openBalanceAt = (i, m) => {
    const mi = monthIdx(m), ii = monthIdx(i.month);
    if (ii == null || mi == null || ii > mi) return 0;   // not issued yet
    const gross = grossAmt(i);
    if (isPaid(i)) {
      const pm = i.paid_date ? monthIdx(String(i.paid_date).slice(0, 7)) : null;
      if (pm != null && pm <= mi) return 0;              // fully settled by m
    }
    let paidByM = 0;
    rowPayments(i).forEach(p => { const pmi = p.date ? monthIdx(String(p.date).slice(0, 7)) : null; if (pmi != null && pmi <= mi) paidByM += Number(p.amount) || 0; });
    return Math.max(0, gross - paidByM);
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
          ar += openBalanceAt(i, m);                      // AR asset: outstanding (uncollected) balance
          if (issuedBy(i, m)) vatAr += vatOf(i);          // output VAT: accrues on issuance, persists after payment
        } else if (i.month === m) accrInc += Number(i.amt) || 0;   // ACCRUAL revenue booked this month (net)
      });
      (cd?.sub || []).forEach(i => {
        if (isActual(i)) {
          ap += openBalanceAt(i, m);                      // AP liability: outstanding (unpaid) balance
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

  const thS = { padding: "6px 8px", textAlign: "center", fontSize: 10, fontWeight: 700, color: "#fff", background: P.em, whiteSpace: "nowrap", position: "sticky", top: 0, zIndex: 2 };
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
  const showCell = (r, v) => r.pct ? fPct(v) : F(v);

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
      ["TOTAL", fcT.rev, fcT.cost, fcT.fee, fcT.cost ? +(fcT.fee / fcT.cost * 100).toFixed(1) : "", "", "", fcT.gm, fcRows.reduce((s, r) => s + r.alloc, 0), fcT.cop, fcT.rev ? +(fcT.cop / fcT.rev * 100).toFixed(1) : ""]];
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

  // Branded PDF of the board summary (print-to-PDF window) — the board-ready month-end one-pager.
  const exportBoardPdf = () => {
    const rows = boardData();
    const escp = s => String(s == null ? "" : s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    const num = (r, v) => v == null ? "—" : r.pct ? fPct(v) : fmt(v);
    const varE = r => (r.actual != null && r.budget != null) ? r.actual - r.budget : null;
    const varP = r => (varE(r) != null && r.budget) ? varE(r) / Math.abs(r.budget) : null;
    const yoy = r => (r.actual != null && r.prior) ? (r.actual - r.prior) / Math.abs(r.prior) : null;
    const th = "padding:7px 10px;font-size:11px;font-weight:700;color:#fff;background:#003F2D;white-space:nowrap;text-align:right";
    const head = `<tr><th style="${th};text-align:left">${escp(t("Γραμμή", "Line"))}</th><th style="${th}">${escp(t("Πραγμ. YTD", "Actual YTD"))}</th><th style="${th}">Budget</th><th style="${th}">${escp(t("Διαφ.", "Var"))}</th><th style="${th}">Var %</th><th style="${th}">${escp(t("Πέρσι", "Prior"))}</th><th style="${th}">YoY %</th></tr>`;
    const body = rows.map(r => {
      const td = `padding:6px 10px;font-size:11px;border-bottom:1px solid #D5DDD8;text-align:right;white-space:nowrap${r.b ? ";font-weight:700;background:#E8F5E9" : ""}`;
      const ve = varE(r), vp = varP(r), yy = yoy(r);
      return `<tr><td style="${td};text-align:left">${escp(r.l)}</td><td style="${td}">${escp(num(r, r.actual))}</td><td style="${td}">${escp(num(r, r.budget))}</td><td style="${td}">${ve == null ? "—" : escp(r.pct ? fPct(ve) : fmt(ve))}</td><td style="${td}">${vp == null ? "—" : escp(fPct(vp))}</td><td style="${td}">${escp(num(r, r.prior))}</td><td style="${td}">${yy == null ? "—" : escp(fPct(yy))}</td></tr>`;
    }).join("");
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>CBRE Group P&L — ${escp(year)}</title></head>
      <body style="font-family:Segoe UI,Arial,sans-serif;color:#1A2E23;padding:26px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
          <div style="font-size:22px;font-weight:800;color:#003F2D">CBRE — Group P&amp;L (${escp(t("Σύνοψη ΔΣ", "Board Summary"))})</div>
          <div style="font-size:13px;color:#5F7567">${escp(t("Έτος", "FY"))} ${escp(year)} · YTD</div>
        </div>
        <table style="width:100%;border-collapse:collapse">${head}${body}</table>
        <p style="font-size:11px;color:#5F7567;margin-top:16px">${escp(t("Budget: παράγεται από τους στόχους πελατών + OPEX budget. Πέρσι: ενοποιημένο προηγούμενης χρήσης. Δημιουργήθηκε από την πλατφόρμα CBRE Hellas.", "Budget: derived from client targets + OPEX budget. Prior: prior-year consolidated. Generated by the CBRE Hellas platform."))}</p>
      </body></html>`;
    const w = window.open("", "_blank");
    if (!w) { alert(t("Επίτρεψε τα pop-ups για PDF", "Allow pop-ups for the PDF")); return; }
    w.document.write(html); w.document.close(); w.focus();
    setTimeout(() => { try { w.print(); } catch { /* ignore */ } }, 350);
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
      <div style={{ fontSize: 20, fontWeight: 800, color: c, marginTop: 4 }}>{pct ? fPct(v) : "€" + F(v)}</div>
    </div>
  );

  return (
    <div style={{ minHeight: "100vh", background: P.of, fontFamily: "Segoe UI,Tahoma,sans-serif" }}>
      <AppHeader user={user} onLogout={onLogout} onBack={onBack} title={`🏢 ${t("Όμιλος P&L / Ισολογισμός", "Group P&L / Balance Sheet")} — ${year}`}
        right={<span style={{ fontSize: 11, color: P.tm, minWidth: 78, textAlign: "right" }}>{saveLbl}</span>} />

      <div style={{ maxWidth: 1400, margin: "0 auto", padding: "18px 24px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 12 }}>
          <div style={{ display: "flex", gap: 8 }}>
            {YEARS.map(y => (<button key={y} onClick={() => setYear(y)} style={{ padding: "6px 16px", border: year === y ? "2px solid " + P.em : "1px solid " + P.bd, borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: year === y ? 700 : 400, background: year === y ? P.em : P.wh, color: year === y ? "#fff" : P.tx }}>{y}</button>))}
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            {loaded && <button onClick={() => setCompact(c => !c)} title={t("Εναλλαγή δεκαδικών / ακεραίων", "Toggle decimals / whole units")} style={{ padding: "6px 12px", border: "1px solid " + P.bd, borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600, background: compact ? P.em : P.wh, color: compact ? "#fff" : P.tx }}>{compact ? "€0" : "€.00"}</button>}
            {loaded && <button onClick={exportGroup} style={{ padding: "6px 14px", border: "1px solid " + P.em, borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600, background: P.wh, color: P.em }}>⬇ {t("Εξαγωγή Excel", "Export Excel")}</button>}
            <div style={{ display: "flex", gap: 0, background: P.wh, borderRadius: 8, border: "1px solid " + P.bd, padding: 4, overflowX: "auto", maxWidth: "100%" }}>
              {[{ v: "pnl", l: t("📈 P&L", "📈 P&L") }, { v: "bs", l: t("⚖️ Ισολογισμός", "⚖️ Balance Sheet") }, { v: "budget", l: t("🎯 Budget", "🎯 Budget") }, { v: "fee", l: t("💰 Fee & COP", "💰 Fee & COP") }, { v: "cash", l: t("💵 Ταμειακές", "💵 Cash Flow") }, { v: "mec", l: t("✅ Κλείσιμο", "✅ Close (MEC)") }].map(o => (
                <button key={o.v} onClick={() => setTab(o.v)} style={{ background: tab === o.v ? P.em : "transparent", color: tab === o.v ? "#fff" : P.tx, border: "none", padding: "7px 15px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0 }}>{o.l}</button>
              ))}
            </div>
          </div>
        </div>

        {!loaded && <Skeleton kpis={5} rows={8} />}

        {loaded && miscatTotal > 0 && (
          <div style={{ background: "#FFF8E1", border: "1px solid #F5D76E", borderRadius: 8, padding: "10px 16px", marginBottom: 14, fontSize: 12, color: "#7A5B00" }}>
            ⚠️ {t("Προσοχή στη συμφωνία", "Reconciliation notice")}: {miscatTotal} {t("γραμμές με μη-κανονική κατηγορία μετρούν στα σύνολα του Ομίλου αλλά ΟΧΙ στο P&L του κάθε πελάτη", "rows with a non-canonical category count in the Group totals but NOT in each client's P&L")} — {miscat.slice(0, 6).map(x => `${x.name} (${x.n})`).join(", ")}{miscat.length > 6 ? "…" : ""}. {t("Διόρθωσε την κατηγορία τους ώστε «Όμιλος = Σ πελατών».", "Fix their category so \"Group = Σ clients\".")}
          </div>
        )}

        {/* ── GROUP P&L ── */}
        {loaded && tab === "pnl" && (
          <div>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 16 }}>
              <div style={{ flex: "1 1 250px", minWidth: 250, background: "linear-gradient(150deg,#014A34 0%,#003F2D 55%,#012A2D 100%)", color: "#EAF6EF", borderRadius: 16, padding: "20px 22px", position: "relative", overflow: "hidden", boxShadow: P.sh }}>
                <div style={{ fontFamily: "'Space Mono',ui-monospace,monospace", fontSize: 9.5, letterSpacing: ".12em", textTransform: "uppercase", color: "#9FD9C4" }}>{t("Ενοποιημένα Έσοδα · FY", "Consolidated Revenue · FY")} {year}</div>
                <div style={{ fontSize: 32, fontWeight: 700, margin: "12px 0 3px", letterSpacing: "-.02em", lineHeight: 1 }}>€{F(ytd("rev"))}</div>
                <div style={{ fontSize: 12, color: "#AEE9CF" }}>EBITDA €{F(ytd("ebitda"))} · {t("περιθώριο", "margin")} {fPct(ytd("rev") ? ytd("ebitda") / ytd("rev") : null)}</div>
                <svg viewBox="0 0 300 40" preserveAspectRatio="none" style={{ position: "absolute", left: 0, right: 0, bottom: 0, width: "100%", height: 38, opacity: .55 }}><path d="M0 28 Q40 8 80 22 T160 18 T240 24 T300 12 V40 H0 Z" fill="rgba(23,232,143,.18)" /><path d="M0 28 Q40 8 80 22 T160 18 T240 24 T300 12" fill="none" stroke="rgba(23,232,143,.55)" strokeWidth="1.5" /></svg>
              </div>
              <div style={{ flex: "3 1 440px", display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(150px,1fr))", gap: 12 }}>
                {kpi(t("Έσοδα (YTD)", "Revenue (YTD)"), ytd("rev"), P.gn)}
                {kpi(t("Μικτό Κέρδος (YTD)", "Gross Margin (YTD)"), ytd("gm"), ytd("gm") >= 0 ? P.gn : P.rd)}
                {kpi("EBITDA (YTD)", ytd("ebitda"), ytd("ebitda") >= 0 ? P.em : P.rd)}
                {kpi("EBITDA %", ytd("rev") ? ytd("ebitda") / ytd("rev") : null, P.em, true)}
                {kpi(t("Καθαρό (YTD)", "Net (YTD)"), ytd("net"), ytd("net") >= 0 ? P.gn : P.rd)}
              </div>
            </div>

            {/* Monthly consolidated — revenue bars + EBITDA trend line */}
            <div style={{ background: P.wh, borderRadius: 8, border: "1px solid " + P.bd, boxShadow: P.sh, padding: 16, marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: P.em, marginBottom: 6 }}>{t("Μηνιαία ενοποιημένα — Έσοδα / EBITDA", "Monthly consolidated — Revenue / EBITDA")}</div>
              {(() => {
                const W = 720, H = 232, base = 190, top = 14, plot = base - top, x0 = 16, slot = (W - 2 * x0) / 12, barW = Math.min(34, slot - 14);
                const mrev = Math.max(1, ...series.map(s => s.rev));
                const peak = series.reduce((mi, s, i, a) => s.rev > a[mi].rev ? i : mi, 0);
                const cx = i => x0 + i * slot + slot / 2;
                const eMax = Math.max(1, ...series.map(s => Math.abs(s.ebitda)));
                const eY = v => base - (v / eMax) * plot * 0.9;
                const pts = series.map((s, i) => `${cx(i)},${Math.max(top - 6, Math.min(base, eY(s.ebitda)))}`).join(" ");
                return (
                  <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
                    <text x={x0} y={top - 2} style={{ fontSize: 11, fill: P.tm }}>€{F(mrev)}</text>
                    {[0.25, 0.5, 0.75, 1].map(f => <line key={f} x1={x0} y1={base - f * plot} x2={W - x0} y2={base - f * plot} stroke={P.bd} strokeWidth="1" />)}
                    <line x1={x0} y1={base} x2={W - x0} y2={base} stroke={P.tm} strokeWidth="1" />
                    {series.map((s, i) => { const h = (s.rev / mrev) * plot; return (
                      <g key={s.m}>
                        <rect x={cx(i) - barW / 2} y={base - h} width={barW} height={h} rx="6" fill={i === peak ? P.em : "#80BBAD"}>
                          <title>{`${monthLabel(s.m)} · ${t("Έσοδα", "Revenue")} €${fmt(s.rev)} · EBITDA €${fmt(s.ebitda)}`}</title>
                        </rect>
                        <text x={cx(i)} y={base + 16} textAnchor="middle" style={{ fontSize: 11, fill: i === peak ? P.em : P.tm, fontWeight: i === peak ? 700 : 400 }}>{monthLabel(s.m)}</text>
                      </g>
                    ); })}
                    <polyline points={pts} fill="none" stroke={P.tx} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.75" />
                    {series.map((s, i) => <circle key={s.m} cx={cx(i)} cy={Math.max(top - 6, Math.min(base, eY(s.ebitda)))} r="2.6" fill={P.tx} />)}
                  </svg>
                );
              })()}
              <div style={{ display: "flex", gap: 16, marginTop: 6, fontSize: 10, color: P.tm }}>
                <span><span style={{ display: "inline-block", width: 10, height: 10, background: "#80BBAD", borderRadius: 2, verticalAlign: "middle", marginRight: 4 }} />{t("Έσοδα", "Revenue")}</span>
                <span><span style={{ display: "inline-block", width: 10, height: 10, background: P.em, borderRadius: 2, verticalAlign: "middle", marginRight: 4 }} />{t("Κορυφή", "Peak")}</span>
                <span><span style={{ display: "inline-block", width: 14, height: 2, background: P.tx, verticalAlign: "middle", marginRight: 4 }} />{t("Γραμμή EBITDA", "EBITDA line")}</span>
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
              {[["months", t("📅 Μηνιαία", "📅 Monthly")], ["board", t("📋 Σύνοψη ΔΣ", "📋 Board Summary")]].map(([v, l]) => (
                <button key={v} onClick={() => setPnlView(v)} style={{ padding: "6px 14px", border: "1px solid " + P.bd, borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: pnlView === v ? 700 : 400, background: pnlView === v ? P.em : P.wh, color: pnlView === v ? "#fff" : P.tx }}>{l}</button>
              ))}
              {pnlView === "board" && <button onClick={exportBoardPdf} style={{ marginLeft: "auto", padding: "6px 14px", border: "1px solid " + P.em, borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600, background: P.wh, color: P.em }}>⬇ PDF</button>}
            </div>
            {pnlView === "months" && (<>
            <div style={{ background: P.wh, borderRadius: 8, border: "1px solid " + P.bd, overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed", minWidth: 1250 }}>
                <colgroup><col style={{ width: 230 }} />{MONTHS.map(m => <col key={m} style={{ width: 72 }} />)}<col style={{ width: 100 }} /></colgroup>
                <thead><tr>
                  <th style={{ ...thS, textAlign: "left", borderRight: "2px solid #003F2D" }}>{t("Γραμμή", "Line")}</th>
                  {MONTHS.map(m => <th key={m} style={thS}>{monthLabel(m)}</th>)}
                  <th style={{ ...thS, background: "#003F2D" }}>YTD</th>
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
            </>)}

            {pnlView === "board" && (() => {
              const rows = boardData();
              const varE = r => (r.actual != null && r.budget != null) ? r.actual - r.budget : null;
              const varP = r => { const v = varE(r); return (v != null && r.budget) ? v / Math.abs(r.budget) : null; };
              const yoy = r => (r.actual != null && r.prior) ? (r.actual - r.prior) / Math.abs(r.prior) : null;
              // Favourability: for cost rows an over-run (actual > budget) is bad; for revenue/margin it's good.
              const favColor = (r, delta) => delta == null ? P.tx : ((r.cost ? -delta : delta) >= 0 ? P.gn : P.rd);
              const cell = (r, v) => v == null ? "—" : r.pct ? fPct(v) : F(v);
              const cols = [
                [t("Πραγμ. YTD", "Actual YTD"), "actual"],
                ["Budget", "budget"],
                [t("Πέρσι", "Prior"), "prior"],
              ];
              return (
                <div style={{ background: P.wh, borderRadius: 8, border: "1px solid " + P.bd, overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 760 }}>
                    <colgroup><col style={{ width: 210 }} /><col /><col /><col /><col /><col /></colgroup>
                    <thead><tr>
                      <th style={{ ...thS, textAlign: "left", borderRight: "2px solid #003F2D" }}>{t("Γραμμή", "Line")}</th>
                      <th style={thS}>{t("Πραγμ. YTD", "Actual YTD")}</th>
                      <th style={thS}>Budget</th>
                      <th style={thS}>{t("Διαφ.", "Var")}</th>
                      <th style={thS}>Var %</th>
                      <th style={thS}>{t("Πέρσι", "Prior")}</th>
                      <th style={{ ...thS, background: "#003F2D" }}>YoY %</th>
                    </tr></thead>
                    <tbody>
                      {rows.map((r, i) => {
                        const ve = varE(r), vp = varP(r), yy = yoy(r);
                        const base = { padding: "7px 10px", textAlign: "right", fontSize: 12, borderBottom: "1px solid " + P.bd, fontWeight: r.b ? 700 : 400 };
                        return (
                          <tr key={r.l + i} style={{ background: r.b ? "#EAF5EF" : i % 2 === 0 ? P.wh : P.al }}>
                            <td style={{ padding: "7px 10px", fontSize: 12, fontWeight: r.b ? 700 : 400, color: r.b ? P.em : P.tx, borderBottom: "1px solid " + P.bd, borderRight: "2px solid " + P.bd, whiteSpace: "nowrap" }}>{r.l}</td>
                            {cols.map(([, k]) => <td key={k} style={{ ...base, color: r.b ? P.em : P.tx }}>{cell(r, r[k])}</td>)}
                            <td style={{ ...base, color: r.pct ? P.tx : favColor(r, ve) }}>{ve == null ? "—" : (r.pct ? fPct(ve) : F(ve))}</td>
                            <td style={{ ...base, color: favColor(r, vp) }}>{vp == null ? "—" : fPct(vp)}</td>
                            <td style={{ ...base, color: favColor(r, yy) }}>{yy == null ? "—" : fPct(yy)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <div style={{ fontSize: 11, color: P.tm, padding: "8px 10px", lineHeight: 1.6 }}>
                    {prev
                      ? t("Budget: στόχοι πελατών + OPEX budget. Πέρσι: ενοποιημένο προηγούμενης χρήσης. Πράσινο = ευνοϊκή απόκλιση.", "Budget: client targets + OPEX budget. Prior: prior-year consolidated. Green = favourable variance.")
                      : t("Δεν βρέθηκαν δεδομένα προηγούμενης χρήσης — οι στήλες «Πέρσι/YoY» είναι κενές.", "No prior-year data found — the Prior/YoY columns are blank.")}
                  </div>
                </div>
              );
            })()}
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
                  <th style={{ ...thS, textAlign: "left", borderRight: "2px solid #003F2D" }}>{t("Λογαριασμός", "Account")}</th>
                  {MONTHS.map(m => <th key={m} style={thS}>{monthLabel(m)}</th>)}
                  <th style={{ ...thS, background: "#003F2D" }}>{t("Τέλος έτους", "Year-end")}</th><th style={thS}></th>
                </tr></thead>
                <tbody>
                  {SECTIONS.map(sec => (
                    <SectionBlock key={sec.k} sec={sec} secLabel={t(sec.el, sec.en)} secShort={t("Σύνολο " + sec.short_el, "Total " + sec.short_en)} autoTag={t("auto", "auto")} derived={derivedIn(sec.k)} manual={manualIn(sec.k)}
                      bsVal={bsVal} setBsVal={setBsVal} renameAcct={renameAcct} delAcct={delAcct} acctTotal={acctTotal}
                      sectionTotal={sectionTotal} inpS={inpS} F={F} />
                  ))}
                  {/* Balance check */}
                  <tr style={{ background: "#263238" }}>
                    <td style={{ padding: "8px 10px", fontSize: 12, fontWeight: 700, color: "#fff", borderRight: "2px solid #003F2D" }}>{t("Σ Ενεργητικό", "Σ Assets")}</td>
                    {MONTHS.map(m => <td key={m} style={{ padding: "6px 6px", textAlign: "right", fontSize: 11, fontWeight: 700, color: "#A5D6A7" }}>{F(totalAssets(m))}</td>)}
                    <td style={{ padding: "6px 8px", textAlign: "right", fontSize: 12, fontWeight: 700, color: "#A5D6A7", borderLeft: "2px solid #003F2D" }}>{F(totalAssets(MONTHS[MONTHS.length - 1]))}</td>
                    <td style={{ background: "#263238" }}></td>
                  </tr>
                  <tr style={{ background: "#37474F" }}>
                    <td style={{ padding: "8px 10px", fontSize: 12, fontWeight: 700, color: "#fff", borderRight: "2px solid #003F2D" }}>{t("Σ Υποχρ. + Ίδια Κεφ.", "Σ Liab. + Equity")}</td>
                    {MONTHS.map(m => <td key={m} style={{ padding: "6px 6px", textAlign: "right", fontSize: 11, fontWeight: 700, color: "#90CAF9" }}>{F(totalLE(m))}</td>)}
                    <td style={{ padding: "6px 8px", textAlign: "right", fontSize: 12, fontWeight: 700, color: "#90CAF9", borderLeft: "2px solid #003F2D" }}>{F(totalLE(MONTHS[MONTHS.length - 1]))}</td>
                    <td style={{ background: "#37474F" }}></td>
                  </tr>
                  <tr style={{ background: P.ep }}>
                    <td style={{ padding: "8px 10px", fontSize: 12, fontWeight: 700, color: P.em, borderRight: "2px solid #003F2D" }}>{t("Έλεγχος (πρέπει = 0)", "Check (must = 0)")}</td>
                    {MONTHS.map(m => { const c = check(m); const ok = Math.abs(c) < 1; return <td key={m} style={{ padding: "6px 6px", textAlign: "right", fontSize: 11, fontWeight: 700, color: ok ? P.gn : P.rd }} title={ok ? t("Ισοσκελισμένο", "Balanced") : t("Διαφορά — συμπλήρωσε ταμείο/opening balances", "Difference — fill cash/opening balances")}>{ok ? "✓" : F(c)}</td>; })}
                    <td style={{ borderLeft: "2px solid #003F2D", background: P.ep }}></td>
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
          if (!rows.length) return <div style={{ padding: 40, textAlign: "center", color: P.tm, background: P.wh, borderRadius: 8, border: "1px solid " + P.bd }}>{t("Δεν υπάρχουν ακόμη δεδομένα ή στόχοι πελατών.", "No client data or targets yet.")}</div>;
          const totRevT = rows.reduce((s, r) => s + (r.revT || 0), 0);
          const totRevA = rows.reduce((s, r) => s + r.rev, 0);
          const tdS = { padding: "6px 10px", borderBottom: "1px solid " + P.bd, fontSize: 12 };
          const inp = { width: 96, padding: "3px 5px", border: "1px solid " + P.bd, borderRadius: 4, fontSize: 12, textAlign: "right", background: P.ip, outline: "none" };
          const pctColor = (p) => p == null ? P.tm : p >= 100 ? P.gn : p >= 85 ? "#F57F17" : P.rd;
          return (
            <div>
              <div style={{ background: P.wh, borderRadius: 8, border: "1px solid " + P.bd, overflow: "auto", maxHeight: 560 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 900 }}>
                  <thead><tr>{[t("Πελάτης", "Client"), t("Στόχος Εσόδων €", "Revenue Target €"), t("Πραγμ. Έσοδα €", "Actual Revenue €"), t("Επίτευξη", "Achieved"), t("Στόχος GM %", "Target GM %"), t("Πραγμ. GM %", "Actual GM %"), t("Διαφορά", "Variance")].map((h, i) => (
                    <th key={i} style={{ padding: "7px 10px", fontSize: 11, fontWeight: 700, color: "#fff", background: P.em, textAlign: i === 0 ? "left" : "right", whiteSpace: "nowrap", position: "sticky", top: 0, zIndex: i === 0 ? 3 : 2, ...(i === 0 ? { left: 0 } : {}) }}>{h}</th>
                  ))}</tr></thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={r.name} style={{ background: i % 2 === 0 ? P.wh : P.al }}>
                        <td style={{ ...tdS, fontWeight: 600, color: P.em, position: "sticky", left: 0, background: i % 2 === 0 ? P.wh : P.al, zIndex: 1 }}>{r.name}</td>
                        <td style={{ ...tdS, textAlign: "right" }}><input type="number" step="0.01" value={budgetOf(r.name).rev ?? ""} onChange={e => setBudget(r.name, "rev", e.target.value)} style={inp} /></td>
                        <td style={{ ...tdS, textAlign: "right" }}>{F(r.rev)}</td>
                        <td style={{ ...tdS, textAlign: "right", fontWeight: 700, color: pctColor(r.revPct) }}>{r.revPct == null ? "—" : Math.round(r.revPct) + "%"}</td>
                        <td style={{ ...tdS, textAlign: "right" }}><input type="number" step="0.1" value={budgetOf(r.name).gmPct ?? ""} onChange={e => setBudget(r.name, "gmPct", e.target.value)} style={{ ...inp, width: 70 }} /></td>
                        <td style={{ ...tdS, textAlign: "right", color: r.gmPct != null && r.gmPct < 0 ? P.rd : P.tx }}>{r.gmPct == null ? "—" : r.gmPct.toFixed(1) + "%"}</td>
                        <td style={{ ...tdS, textAlign: "right", fontWeight: 700, color: r.gmDelta == null ? P.tm : r.gmDelta >= 0 ? P.gn : P.rd }}>{r.gmDelta == null ? "—" : (r.gmDelta >= 0 ? "+" : "") + r.gmDelta.toFixed(1) + t("μον", "pp")}</td>
                      </tr>
                    ))}
                    <tr style={{ background: P.ep, fontWeight: 700 }}>
                      <td style={{ ...tdS, color: P.em, position: "sticky", left: 0, background: P.ep, zIndex: 1 }}>{t("Σύνολο", "Total")}</td>
                      <td style={{ ...tdS, textAlign: "right", color: P.em }}>{F(totRevT)}</td>
                      <td style={{ ...tdS, textAlign: "right", color: P.em }}>{F(totRevA)}</td>
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
          if (!rows.length) return <div style={{ padding: 40, textAlign: "center", color: P.tm, background: P.wh, borderRadius: 8, border: "1px solid " + P.bd }}>{t("Δεν υπάρχουν ακόμη δεδομένα πελατών για fee/COP.", "No client data yet for fee/COP.")}</div>;
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
              <div style={{ background: P.wh, borderRadius: 8, border: "1px solid " + P.bd, overflow: "auto", maxHeight: 560 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1050 }}>
                  <thead><tr>{H.map((h, i) => (<th key={i} style={{ padding: "7px 9px", fontSize: 10.5, fontWeight: 700, color: "#fff", background: P.em, textAlign: i === 0 ? "left" : "right", whiteSpace: "nowrap", position: "sticky", top: 0, zIndex: i === 0 ? 3 : 2, ...(i === 0 ? { left: 0 } : {}) }}>{t(h.split("|")[0], h.split("|")[1])}</th>))}</tr></thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={r.name} style={{ background: i % 2 === 0 ? P.wh : P.al }}>
                        <td style={{ ...tdS, textAlign: "left", fontWeight: 600, color: P.em, position: "sticky", left: 0, background: i % 2 === 0 ? P.wh : P.al, zIndex: 1 }}>{r.name}</td>
                        <td style={tdS}>{F(r.rev)}</td>
                        <td style={tdS}>{F(r.cost)}</td>
                        <td style={{ ...tdS, fontWeight: 600, color: P.em }}>{F(r.fee)}</td>
                        <td style={tdS}>{r.effFee == null ? "—" : r.effFee.toFixed(1) + "%"}</td>
                        <td style={tdS}><input type="number" step="0.1" value={budgetOf(r.name).feePct ?? ""} onChange={e => setBudget(r.name, "feePct", e.target.value)} placeholder="5" style={inp} /></td>
                        <td style={{ ...tdS, fontWeight: 700, color: r.feeGap == null ? P.tm : r.feeGap >= 0 ? P.gn : P.rd }}>{r.feeGap == null ? "—" : (r.feeGap >= 0 ? "+" : "") + r.feeGap.toFixed(1)}</td>
                        <td style={{ ...tdS, color: r.gm < 0 ? P.rd : P.tx }}>{F(r.gm)}</td>
                        <td style={{ ...tdS, color: P.tm }}>{F(r.alloc)}</td>
                        <td style={{ ...tdS, fontWeight: 700, color: r.cop >= 0 ? P.em : P.rd }}>{F(r.cop)}</td>
                        <td style={{ ...tdS, color: r.copPct != null && r.copPct < 0 ? P.rd : P.tm }}>{r.copPct == null ? "—" : r.copPct.toFixed(1) + "%"}</td>
                      </tr>
                    ))}
                    <tr style={{ background: P.ep, fontWeight: 700 }}>
                      <td style={{ ...tdS, textAlign: "left", color: P.em, position: "sticky", left: 0, background: P.ep, zIndex: 1 }}>{t("Σύνολο", "Total")}</td>
                      <td style={{ ...tdS, color: P.em }}>{F(T.rev)}</td>
                      <td style={{ ...tdS, color: P.em }}>{F(T.cost)}</td>
                      <td style={{ ...tdS, color: P.em }}>{F(T.fee)}</td>
                      <td style={{ ...tdS, color: P.em }}>{T.cost ? (T.fee / T.cost * 100).toFixed(1) + "%" : "—"}</td>
                      <td colSpan={2}></td>
                      <td style={{ ...tdS, color: P.em }}>{F(T.gm)}</td>
                      <td style={{ ...tdS, color: P.em }}>{F(rows.reduce((s, r) => s + r.alloc, 0))}</td>
                      <td style={{ ...tdS, color: T.cop >= 0 ? P.em : P.rd }}>{F(T.cop)}</td>
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
                  <thead><tr><th style={{ ...thS, textAlign: "left", borderRight: "2px solid #003F2D" }}>{t("Γραμμή", "Line")}</th>{MONTHS.map(m => <th key={m} style={thC}>{monthLabel(m)}</th>)}<th style={{ ...thC, background: "#003F2D" }}>{t("Σύνολο", "Total")}</th></tr></thead>
                  <tbody>
                    {R.map((r, i) => (
                      <tr key={r.k} style={{ background: i % 2 === 0 ? P.wh : P.al }}>
                        <td style={{ padding: "6px 10px", fontSize: 12, borderBottom: "1px solid " + P.bd, borderRight: "2px solid " + P.bd, whiteSpace: "nowrap", color: r.sign < 0 ? "#8a5a00" : P.tx }}>{r.l}</td>
                        {MONTHS.map(m => { const v = r.sign * by[m][r.k]; return <td key={m} style={{ ...cell, color: v < 0 ? P.rd : P.tx }}>{by[m][r.k] ? F(v) : "-"}</td>; })}
                        <td style={{ ...cell, fontWeight: 700, background: "#f5f5f5", borderLeft: "2px solid " + P.bd, color: r.sign < 0 ? "#8a5a00" : P.em }}>{F(r.sign * sum(r.k))}</td>
                      </tr>
                    ))}
                    <tr style={{ background: P.ep }}>
                      <td style={{ padding: "7px 10px", fontSize: 12, fontWeight: 700, color: P.em, borderRight: "2px solid #003F2D" }}>{t("Καθαρή ταμειακή ροή", "Net cash flow")}</td>
                      {MONTHS.map(m => <td key={m} style={{ ...cell, fontWeight: 700, color: by[m].net < 0 ? P.rd : P.em }}>{F(by[m].net)}</td>)}
                      <td style={{ ...cell, fontWeight: 700, background: "#C8E6C9", borderLeft: "2px solid #003F2D", color: sum("net") < 0 ? P.rd : P.em }}>{F(sum("net"))}</td>
                    </tr>
                    <tr style={{ background: "#263238" }}>
                      <td style={{ padding: "8px 10px", fontSize: 12, fontWeight: 700, color: "#fff", borderRight: "2px solid #003F2D" }}>{t("Ταμείο τέλους μήνα", "Closing cash")}</td>
                      {MONTHS.map(m => <td key={m} style={{ ...cell, fontWeight: 700, color: by[m].close < 0 ? "#FF8A80" : "#A5D6A7" }}>{F(by[m].close)}</td>)}
                      <td style={{ ...cell, fontWeight: 700, borderLeft: "2px solid #003F2D", color: endClose < 0 ? "#FF8A80" : "#A5D6A7" }}>{F(endClose)}</td>
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

        {/* ── MONTH-END CLOSE (MEC) ── */}
        {loaded && tab === "mec" && (() => {
          const clients = Object.keys(allData || {}).filter(c => { const cd = allData[c]; return (cd?.inv || []).length || (cd?.sub || []).length || Object.values(cd?.lab || {}).some(mo => Object.values(mo || {}).some(v => Number(v))); }).sort();
          // Default the working month to the last month that has any activity across the portfolio.
          const activeMonths = MONTHS.filter(m => clients.some(c => { const s = closeSignals(allData[c], m); return s.ar || s.ap || s.lab; }));
          const selM = closeMonth && MONTHS.includes(closeMonth) ? closeMonth : (activeMonths[activeMonths.length - 1] || MONTHS[0]);
          const statusOf = c => closeOf(c, selM).status || "draft";
          const counts = { draft: 0, reconciled: 0, closed: 0 };
          clients.forEach(c => { counts[statusOf(c)] = (counts[statusOf(c)] || 0) + 1; });
          const total = clients.length || 1;
          const pct = Math.round(counts.closed / total * 100);
          const dot = (on) => <span style={{ display: "inline-block", width: 9, height: 9, borderRadius: "50%", background: on ? P.gn : "#E0E0E0" }} title={on ? t("υπάρχουν δεδομένα", "has data") : t("κανένα δεδομένο", "no data")} />;
          const sBtn = (c, val) => { const cs = CLOSE_STATES[val]; const active = statusOf(c) === val; return (
            <button key={val} onClick={() => setClose(c, selM, { status: val })} style={{ padding: "3px 8px", border: "1px solid " + (active ? cs.c : P.bd), borderRadius: 5, cursor: "pointer", fontSize: 10.5, fontWeight: active ? 700 : 400, background: active ? cs.bg : P.wh, color: active ? cs.c : P.tm }}>{t(cs.el, cs.en)}</button>
          ); };
          const tdS = { padding: "6px 9px", borderBottom: "1px solid " + P.bd, fontSize: 12 };
          return (
            <div>
              {/* Month selector */}
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14, alignItems: "center" }}>
                <span style={{ fontSize: 12, color: P.tm, marginRight: 4 }}>{t("Μήνας κλεισίματος:", "Closing month:")}</span>
                {MONTHS.map(m => { const isA = activeMonths.includes(m); return (
                  <button key={m} onClick={() => setCloseMonth(m)} style={{ padding: "5px 10px", border: (m === selM ? "2px solid " + P.em : "1px solid " + P.bd), borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: m === selM ? 700 : 400, background: m === selM ? P.em : P.wh, color: m === selM ? "#fff" : (isA ? P.tx : "#B0BEC5") }}>{monthLabel(m)}</button>
                ); })}
              </div>
              {/* Progress */}
              <div style={{ background: P.wh, border: "1px solid " + P.bd, borderRadius: 10, padding: "14px 16px", marginBottom: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: P.em }}>{monthLabel(selM)} — {t("Πρόοδος κλεισίματος", "Close progress")}: {counts.closed}/{total} <span style={{ color: pct === 100 ? P.gn : P.tm }}>({pct}%)</span></div>
                  <div style={{ fontSize: 12, color: P.tm }}>
                    <span style={{ color: CLOSE_STATES.closed.c, fontWeight: 700 }}>● {counts.closed} {t("κλεισμένα", "closed")}</span> · <span style={{ color: CLOSE_STATES.reconciled.c, fontWeight: 700 }}>● {counts.reconciled} {t("συμφ.", "recon.")}</span> · <span style={{ color: CLOSE_STATES.draft.c, fontWeight: 700 }}>● {counts.draft} draft</span>
                  </div>
                </div>
                <div style={{ height: 10, background: "#eef2ef", borderRadius: 5, overflow: "hidden" }}><div style={{ width: pct + "%", height: "100%", background: pct === 100 ? P.gn : P.em }} /></div>
              </div>
              {/* Per-client table */}
              <div style={{ background: P.wh, borderRadius: 8, border: "1px solid " + P.bd, overflow: "auto", maxHeight: 560 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 900 }}>
                  <thead><tr>{[t("Πελάτης", "Client"), "AR", "AP", t("Εργ.", "Lab"), t("Συμφων.", "Recon."), t("Έλεγχος", "Reviewed"), t("Κατάσταση", "Status"), t("Από", "By")].map((h, i) => (
                    <th key={i} style={{ padding: "7px 9px", fontSize: 10.5, fontWeight: 700, color: "#fff", background: P.em, textAlign: i === 0 || i >= 6 ? "left" : "center", whiteSpace: "nowrap", position: "sticky", top: 0, zIndex: i === 0 ? 3 : 2, ...(i === 0 ? { left: 0 } : {}) }}>{h}</th>
                  ))}</tr></thead>
                  <tbody>
                    {clients.map((c, i) => { const sig = closeSignals(allData[c], selM); const cl = closeOf(c, selM); const st = cl.status || "draft"; const locked = st === "closed"; const rowBg = locked ? "#F1F8E9" : i % 2 === 0 ? P.wh : P.al; return (
                      <tr key={c} style={{ background: rowBg }}>
                        <td style={{ ...tdS, fontWeight: 600, color: P.em, whiteSpace: "nowrap", position: "sticky", left: 0, background: rowBg, zIndex: 1 }}>{c}</td>
                        <td style={{ ...tdS, textAlign: "center" }}>{dot(sig.ar)}</td>
                        <td style={{ ...tdS, textAlign: "center" }}>{dot(sig.ap)}</td>
                        <td style={{ ...tdS, textAlign: "center" }}>{dot(sig.lab)}</td>
                        <td style={{ ...tdS, textAlign: "center" }}><input type="checkbox" checked={!!cl.reconciled} onChange={e => setClose(c, selM, { reconciled: e.target.checked })} style={{ cursor: "pointer" }} /></td>
                        <td style={{ ...tdS, textAlign: "center" }}><input type="checkbox" checked={!!cl.reviewed} onChange={e => setClose(c, selM, { reviewed: e.target.checked })} style={{ cursor: "pointer" }} /></td>
                        <td style={{ ...tdS }}><div style={{ display: "flex", gap: 4 }}>{["draft", "reconciled", "closed"].map(v => sBtn(c, v))}</div></td>
                        <td style={{ ...tdS, fontSize: 11, color: P.tm, whiteSpace: "nowrap" }}>{locked && cl.by ? `${cl.by}${cl.at ? " · " + cl.at : ""}` : "—"}</td>
                      </tr>
                    ); })}
                    {!clients.length && <tr><td colSpan={8} style={{ padding: 26, textAlign: "center", color: P.tm, fontStyle: "italic" }}>{t("Κανένας πελάτης με δεδομένα ακόμη.", "No clients with data yet.")}</td></tr>}
                  </tbody>
                </table>
              </div>
              {/* Year matrix overview */}
              <div style={{ background: P.wh, borderRadius: 8, border: "1px solid " + P.bd, overflowX: "auto", marginTop: 16 }}>
                <div style={{ padding: "10px 14px", borderBottom: "1px solid " + P.bd, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: P.em }}>{t("Επισκόπηση έτους (κατάσταση ανά μήνα)", "Year overview (status per month)")}</span>
                  <span style={{ display: "flex", gap: 12, fontSize: 10.5, color: P.tm, alignItems: "center" }}>
                    {[["draft", t("Draft", "Draft")], ["reconciled", t("Συμφων.", "Recon.")], ["closed", t("Κλεισμένο", "Closed")]].map(([k, l]) => (
                      <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><span style={{ width: 12, height: 12, borderRadius: 3, background: k === "draft" ? "#ECEFF1" : CLOSE_STATES[k].bg, border: "1px solid " + (k === "draft" ? "#CFD8DC" : CLOSE_STATES[k].c) }} />{l}</span>
                    ))}
                  </span>
                </div>
                <table style={{ borderCollapse: "collapse", fontSize: 11 }}>
                  <thead><tr><th style={{ padding: "5px 9px", textAlign: "left", position: "sticky", left: 0, background: P.wh }}></th>{MONTHS.map(m => <th key={m} style={{ padding: "5px 6px", color: P.tm, fontWeight: 600 }}>{monthLabel(m).slice(0, 3)}</th>)}</tr></thead>
                  <tbody>{clients.map(c => (
                    <tr key={c}>
                      <td style={{ padding: "3px 9px", fontWeight: 600, color: P.em, whiteSpace: "nowrap", position: "sticky", left: 0, background: P.wh, borderRight: "1px solid " + P.bd }}>{c}</td>
                      {MONTHS.map(m => { const st = closeOf(c, m).status || "draft"; const has = (() => { const s = closeSignals(allData[c], m); return s.ar || s.ap || s.lab; })(); const cs = CLOSE_STATES[st]; const isLk = !!(allData[c]?.locked && allData[c].locked[m]); return (
                        <td key={m} style={{ padding: 3, textAlign: "center", cursor: "pointer" }} onClick={() => setCloseMonth(m)} title={`${c} ${monthLabel(m)}: ${t(cs.el, cs.en)}${isLk ? " · " + t("κλειδωμένο 🔒", "locked 🔒") : ""}`}>
                          <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 14, height: 14, borderRadius: 3, fontSize: 9, background: st === "draft" ? (has ? "#ECEFF1" : "#F7F9F8") : cs.bg, border: "1px solid " + (isLk ? "#B71C1C" : st === "draft" ? (has ? "#CFD8DC" : "#ECEFF1") : cs.c) }}>{isLk ? "🔒" : ""}</span>
                        </td>
                      ); })}
                    </tr>
                  ))}</tbody>
                </table>
              </div>
              <div style={{ fontSize: 11, color: P.tm, marginTop: 8, lineHeight: 1.6 }}>
                {t("Οι κουκκίδες AR/AP/Εργ. δείχνουν αν υπάρχουν δεδομένα για τον μήνα (βοήθεια πληρότητας). Πάτησε Draft→Συμφωνημένο→Κλεισμένο ανά πελάτη· το «Κλεισμένο» καταγράφει ποιος & πότε. Το πλέγμα κάτω δείχνει όλο το έτος — κλικ σε μήνα για μετάβαση. Αποθηκεύεται αυτόματα.",
                   "The AR/AP/Lab dots show whether data exists for the month (completeness aid). Click Draft→Reconciled→Closed per client; 'Closed' records who & when. The grid below shows the whole year — click a month to jump. Saved automatically.")}
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
                          <td style={{ padding: "7px 6px", textAlign: "right", fontWeight: 600, color: neg ? P.rd : P.tx, whiteSpace: "nowrap" }}>{F(r.val)}</td>
                          <td style={{ padding: "7px 6px", textAlign: "right", color: P.tm, width: 52, whiteSpace: "nowrap" }}>{total ? Math.round(r.val / total * 100) + "%" : "-"}</td>
                        </tr>
                      ); })}
                    </tbody>
                    <tfoot>
                      <tr style={{ background: P.ep }}>
                        <td style={{ padding: "8px 6px", fontWeight: 700, color: P.em }}>{t("Σύνολο", "Total")}</td>
                        <td></td>
                        <td style={{ padding: "8px 6px", textAlign: "right", fontWeight: 700, color: total < 0 ? P.rd : P.em, whiteSpace: "nowrap" }}>{F(total)}</td>
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
function SectionBlock({ sec, secLabel, secShort, autoTag, derived, manual, bsVal, setBsVal, renameAcct, delAcct, acctTotal, sectionTotal, inpS, F }) {
  return (
    <>
      <tr style={{ background: "#003F2D" }}>
        <td colSpan={MONTHS.length + 3} style={{ padding: "6px 10px", fontSize: 12, fontWeight: 700, color: "#fff" }}>{secLabel}</td>
      </tr>
      {derived.map((d, i) => (
        <tr key={"d" + i} style={{ background: "#F1F5F3" }}>
          <td style={{ padding: "5px 10px", fontSize: 11.5, fontStyle: "italic", color: P.tm, borderBottom: "1px solid " + P.bd, borderRight: "2px solid " + P.bd, whiteSpace: "nowrap" }}>{d.label} <span style={{ fontSize: 9, background: P.ep, color: P.em, padding: "0 5px", borderRadius: 6, fontStyle: "normal", fontWeight: 700 }}>{autoTag}</span></td>
          {MONTHS.map(m => { const v = d.fn(m); return <td key={m} style={{ padding: "5px 6px", textAlign: "right", fontSize: 11, color: v ? P.tx : P.tm, borderBottom: "1px solid " + P.bd }}>{v ? F(v) : "-"}</td>; })}
          <td style={{ padding: "5px 8px", textAlign: "right", fontSize: 11, fontWeight: 600, color: P.em, background: "#f5f5f5", borderLeft: "2px solid " + P.bd, borderBottom: "1px solid " + P.bd }}>{F(d.fn(MONTHS[MONTHS.length - 1]))}</td>
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
          <td style={{ padding: "5px 8px", textAlign: "right", fontSize: 11, fontWeight: 600, color: P.em, background: "#f5f5f5", borderLeft: "2px solid " + P.bd, borderBottom: "1px solid " + P.bd }}>{F(acctTotal(a.id))}</td>
          <td style={{ textAlign: "center", borderBottom: "1px solid " + P.bd }}><button onClick={() => delAcct(a.id)} style={{ background: "none", border: "none", color: P.rd, cursor: "pointer", fontSize: 14 }}>×</button></td>
        </tr>
      ))}
      <tr style={{ background: P.ep }}>
        <td style={{ padding: "6px 10px", fontSize: 11.5, fontWeight: 700, color: P.em, borderRight: "2px solid #003F2D" }}>{secShort}</td>
        {MONTHS.map(m => <td key={m} style={{ padding: "5px 6px", textAlign: "right", fontSize: 11, fontWeight: 700, color: P.em }}>{F(sectionTotal(sec.k, m))}</td>)}
        <td style={{ padding: "5px 8px", textAlign: "right", fontSize: 11, fontWeight: 700, color: P.em, background: "#C8E6C9", borderLeft: "2px solid #003F2D" }}>{F(sectionTotal(sec.k, MONTHS[MONTHS.length - 1]))}</td>
        <td style={{ background: P.ep }}></td>
      </tr>
    </>
  );
}

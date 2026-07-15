// Pure calculation helpers, extracted so they can be unit-tested (see calc.test.js).
// No React / DOM / global state here — keep it that way.

// Absolute month index (year*12 + month-1) from a "YYYY-MM" key, for depreciation math.
export const monthIdx = (ym) => {
  const m = /^(\d{4})-(\d{2})/.exec(String(ym || ""));
  return m ? (+m[1]) * 12 + (+m[2] - 1) : null;
};

// Straight-line depreciation of a capex item as of the end of the given fiscal-year months.
export const depreciation = (item, fyMonths) => {
  const amt = Number(item.amount) || 0, life = Number(item.life) || 0;
  const acq = monthIdx(item.month);
  const monthly = life > 0 ? amt / life : 0;
  const perMonth = {}; fyMonths.forEach(m => { perMonth[m] = 0; });
  let elapsedToYearEnd = 0;
  const lastIdx = fyMonths.length ? monthIdx(fyMonths[fyMonths.length - 1]) : null;
  if (acq != null && life > 0) {
    fyMonths.forEach(m => { const gi = monthIdx(m); const k = gi - acq; if (k >= 0 && k < life) perMonth[m] = monthly; });
    if (lastIdx != null) elapsedToYearEnd = Math.min(life, Math.max(0, lastIdx - acq + 1));
  }
  const accumulated = Math.min(amt, elapsedToYearEnd * monthly);
  return { monthly, perMonth, accumulated, nbv: Math.max(0, amt - accumulated) };
};

// Net book value of a capex item at the END of month `ym` ("YYYY-MM"), across FY boundaries.
// 0 before it is acquired; straight-line, capped at cost. Used by the group balance sheet.
export const nbvAtMonth = (item, ym) => {
  const amt = Number(item.amount) || 0, life = Number(item.life) || 0;
  const acq = monthIdx(item.month), at = monthIdx(ym);
  if (acq == null || at == null || at < acq) return 0;      // not on the books yet
  if (life <= 0) return amt;                                 // non-depreciating
  const monthly = amt / life;
  const elapsed = Math.min(life, at - acq + 1);
  return Math.max(0, amt - Math.min(amt, elapsed * monthly));
};

// Consolidated (company-wide) monthly P&L across ALL clients + company OPEX/CAPEX.
//   allData : { clientName: { inv:[], sub:[], lab:{} } }   (from api.getYearData)
//   finance : { opex:{cats,actual}, capex:[], pnl:{interest,tax} }  (from api.getFinanceData)
// Returns one row per month: revenue → GM → EBITDA → EBIT → net income.
export const groupPnLSeries = (allData, finance, months) => {
  const cats = finance?.opex?.cats || [];
  const actual = finance?.opex?.actual || {};
  const capex = Array.isArray(finance?.capex) ? finance.capex : [];
  const pnl = finance?.pnl || {};
  // Pre-compute per-item straight-line depreciation within these FY months.
  const depr = capex.map(it => depreciation(it, months));
  return months.map(m => {
    let rev = 0, sub = 0, labour = 0;
    Object.values(allData || {}).forEach(cd => {
      (cd?.inv || []).forEach(i => { if (i.month === m) rev += Number(i.amt) || 0; });
      (cd?.sub || []).forEach(i => { if (i.month === m) sub += Number(i.amt) || 0; });
      if (cd?.lab?.[m]) labour += Object.values(cd.lab[m]).reduce((s, v) => s + (Number(v) || 0), 0);
    });
    const gm = rev - sub - labour;
    const opex = cats.reduce((s, c) => s + (Number(actual?.[c.id]?.[m]) || 0), 0);
    const da = depr.reduce((s, d) => s + (d.perMonth[m] || 0), 0);
    const interest = Number(pnl?.interest?.[m]) || 0;
    const tax = Number(pnl?.tax?.[m]) || 0;
    const ebitda = gm - opex;
    const ebit = ebitda - da;
    const net = ebit - interest - tax;
    return { m, rev, sub, labour, gm, opex, ebitda, da, ebit, interest, tax, net };
  });
};

// Read a month's labour allocation as normalized fractions that ALWAYS sum to 1 (proportional
// to the weights) so the split can never change the total labour cost. Empty/zero → 100% Core.
export const allocFractions = (labAlloc, m) => {
  const a = labAlloc && labAlloc[m];
  const core = a ? Number(a.core) || 0 : 100, ew = a ? Number(a.ew) || 0 : 0, pjm = a ? Number(a.pjm) || 0 : 0;
  const s = core + ew + pjm;
  return s > 0 ? { core: core / s, ew: ew / s, pjm: pjm / s } : { core: 1, ew: 0, pjm: 0 };
};

// Parse free-text contract dates (DD/MM/YYYY, YYYY-MM-DD, etc.) into a Date, for expiry alerts.
export const parseDate = (s) => {
  if (!s) return null;
  if (s instanceof Date) return isNaN(s) ? null : s;
  const str = String(s).trim(); let m;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(str))) return new Date(+m[1], +m[2] - 1, +m[3]);
  if ((m = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/.exec(str))) { const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; return new Date(y, +m[2] - 1, +m[1]); }
  const d = new Date(str); return isNaN(d) ? null : d;
};
// Whole days from now until the date (negative = past). `now` injectable for tests.
export const daysUntil = (s, now = new Date()) => { const d = parseDate(s); if (!d) return null; return Math.ceil((d - now) / 86400000); };

// AP/AR aging bucket for an invoice, given payment terms in days (0 = age from invoice date).
// Buckets are by days past the due date. `now` injectable for tests.
export const agingBucket = (invoiceDate, termsDays, now = new Date()) => {
  const d = parseDate(invoiceDate); if (!d) return "unknown";
  const due = new Date(d.getTime()); due.setDate(due.getDate() + (Number(termsDays) || 0));
  const overdue = Math.floor((now - due) / 86400000);
  if (overdue <= 0) return "current";
  if (overdue <= 30) return "1-30";
  if (overdue <= 60) return "31-60";
  if (overdue <= 90) return "61-90";
  return "90+";
};
export const AGING_BUCKETS = ["current", "1-30", "31-60", "61-90", "90+"];

// ── Analytics / forecasting (deterministic — the AI narrative sits on top of these) ──

// Per-month revenue / cost / labour / GM series for a client's data blob.
export const clientSeries = (cd, months) => {
  const inv = cd?.inv || [], sub = cd?.sub || [], lab = cd?.lab || {};
  return months.map(m => {
    const rev = inv.filter(i => i.month === m).reduce((s, i) => s + (Number(i.amt) || 0), 0);
    const cost = sub.filter(i => i.month === m).reduce((s, i) => s + (Number(i.amt) || 0), 0);
    const labour = lab[m] ? Object.values(lab[m]).reduce((s, v) => s + (Number(v) || 0), 0) : 0;
    return { m, rev, cost, labour, gm: rev - cost - labour };
  });
};

// Linear-regression slope over an array of numbers (x = index). >0 rising, <0 falling.
export const linregSlope = (ys) => {
  const n = ys.length; if (n < 2) return 0;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  ys.forEach((y, x) => { sx += x; sy += y; sxx += x * x; sxy += x * y; });
  const d = n * sxx - sx * sx; if (!d) return 0;
  return (n * sxy - sx * sy) / d;
};

// Run-rate full-year projection from actuals-to-date (annualize the average of active months).
export const runRateFY = (series, totalMonths = 12) => {
  const active = series.filter(s => s.rev !== 0 || s.cost !== 0 || s.labour !== 0);
  const nA = active.length;
  const sum = k => series.reduce((s, x) => s + x[k], 0);
  const proj = k => nA > 0 ? (sum(k) / nA) * totalMonths : 0;
  return {
    monthsActive: nA,
    actual: { rev: sum("rev"), cost: sum("cost"), labour: sum("labour"), gm: sum("gm") },
    projected: { rev: proj("rev"), cost: proj("cost"), labour: proj("labour"), gm: proj("gm") },
  };
};

// Deterministic risk flags for a client. `now` injectable for tests. Levels: high | med | low.
export const clientRisks = (cd, months, now = new Date()) => {
  const risks = [];
  const s = clientSeries(cd, months);
  const active = s.filter(x => x.rev || x.cost || x.labour);
  const rr = runRateFY(s);
  const totRev = rr.actual.rev, totGM = rr.actual.gm;
  if (totRev > 0) {
    const m = totGM / totRev;
    if (m < 0) risks.push({ level: "high", label: `Αρνητικό GM (${(m * 100).toFixed(1)}%)` });
    else if (m < 0.05) risks.push({ level: "med", label: `Χαμηλό GM (${(m * 100).toFixed(1)}%)` });
  }
  const gmVals = active.map(x => x.gm);
  if (gmVals.length >= 3 && linregSlope(gmVals.slice(-3)) < 0 && linregSlope(gmVals) < 0)
    risks.push({ level: "med", label: "Φθίνον GM τους τελευταίους μήνες" });
  const costs = active.map(x => x.cost).filter(c => c > 0);
  if (costs.length >= 3) {
    const avg = costs.reduce((a, b) => a + b, 0) / costs.length, mx = Math.max(...costs);
    if (mx > avg * 1.8) risks.push({ level: "low", label: "Απότομη αύξηση κόστους σε κάποιον μήνα" });
  }
  const contracts = cd?.contracts || [], inv = cd?.inv || [];
  contracts.forEach(c => {
    if (c.status === "Terminated" || c.status === "Expired") return;
    const dd = daysUntil(c.expiry, now);
    if (dd != null && dd < 0) risks.push({ level: "med", label: `Έληξε: ${c.type} ${c.ref || ""}`.trim() });
    else if (dd != null && dd <= 60) risks.push({ level: "med", label: `Λήγει σε ${dd}μ: ${c.type} ${c.ref || ""}`.trim() });
  });
  contracts.filter(c => c.type === "PO" && c.po).forEach(c => {
    const spent = inv.filter(i => i.po_no === c.po && (i.act_acc || "").toUpperCase() === "ACTUAL").reduce((s, i) => s + (Number(i.amt) || 0), 0);
    const budget = Number(c.po_value) || 0;
    if (budget > 0) {
      const p = spent / budget;
      if (p > 1) risks.push({ level: "high", label: `PO ${c.po} ξεπέρασε το budget (${(p * 100).toFixed(0)}%)` });
      else if (p > 0.9) risks.push({ level: "med", label: `PO ${c.po} κοντά σε εξάντληση (${(p * 100).toFixed(0)}%)` });
    }
  });
  return risks;
};

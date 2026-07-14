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
